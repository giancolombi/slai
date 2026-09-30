import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
/**
 * Test-database helpers shared by the db and api test suites. Each suite gets
 * its own freshly migrated database (e.g. `slai_test_db`, `slai_test_api`) in
 * the local cluster, so suites can run in parallel without truncating.
 */
import postgres from "postgres";
import { runMigrations } from "./migrate.js";

const DEFAULT_OWNER_URL = "postgres://slai:slai@localhost:5433/slai";

export interface TestDbUrls {
  owner: string;
  app: string;
  system: string;
  auth: string;
}

function withDb(base: string, dbName: string, user?: { name: string; password: string }): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

/**
 * Test databases are per checkout: two worktrees (or a worktree and the main
 * checkout) running tests against one Postgres must not drop each other's
 * databases mid-run. The suffix is a short hash of this package's location,
 * overridable with SLAI_TEST_DB_SUFFIX.
 */
export const TEST_DB_SUFFIX =
  process.env.SLAI_TEST_DB_SUFFIX ??
  createHash("sha256")
    .update(fileURLToPath(import.meta.url))
    .digest("hex")
    .slice(0, 8);

export function testDbName(base: string): string {
  return base.endsWith(`_${TEST_DB_SUFFIX}`) ? base : `${base}_${TEST_DB_SUFFIX}`;
}

export function testDbUrls(baseName: string, ownerBase = process.env.DATABASE_URL ?? DEFAULT_OWNER_URL): TestDbUrls {
  const dbName = testDbName(baseName);
  return {
    owner: withDb(ownerBase, dbName),
    app: withDb(ownerBase, dbName, { name: "slai_app", password: "slai_app" }),
    system: withDb(ownerBase, dbName, { name: "slai_worker", password: "slai_worker" }),
    auth: withDb(ownerBase, dbName, { name: "slai_auth", password: "slai_auth" }),
  };
}

/** Drops and recreates `dbName`, then migrates it. Call from a vitest globalSetup. */
export async function createTestDatabase(baseName: string): Promise<TestDbUrls> {
  const dbName = testDbName(baseName);
  if (!/^slai_test_[a-z0-9_]+$/.test(dbName)) throw new Error("test database names must start with slai_test_");
  const urls = testDbUrls(dbName);
  const admin = postgres(withDb(urls.owner, "postgres"), { max: 1, onnotice: () => {} });
  try {
    // Suites set up in parallel; migrations touch cluster-wide roles (ALTER ROLE), so run them one at a time.
    await admin`select pg_advisory_lock(hashtext('slai_test_migrations'))`;
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.unsafe(`create database ${dbName}`);
    await runMigrations(urls.owner);
  } finally {
    await admin.end({ timeout: 5 });
  }
  return urls;
}
