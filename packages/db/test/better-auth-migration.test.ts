/**
 * Migration 0005 (better-auth) on a database holding pre-better-auth data:
 * argon2id hashes become credential accounts and keep verifying, every user is
 * forced back into MFA enrollment, and old sessions are revoked.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../src/migrate.js";
import { hashPassword, verifyPassword } from "../src/passwords.js";
import { testDbUrls } from "../src/testing.js";

const DB = "slai_test_db_ba_migration";
const urls = testDbUrls(DB);
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const apply = async (sql: postgres.Sql, file: string) => {
  for (const stmt of readFileSync(join(MIGRATIONS_DIR, file), "utf8").split("--> statement-breakpoint")) {
    if (stmt.trim()) await sql.unsafe(stmt);
  }
};

let sql: postgres.Sql;
const legacyPassword = "legacy password 123";

beforeAll(async () => {
  const admin = postgres(testDbUrls("postgres").owner, { max: 1, onnotice: () => {} });
  await admin`select pg_advisory_lock(hashtext('slai_test_migrations'))`;
  try {
    await admin.unsafe(`drop database if exists ${DB} with (force)`);
    await admin.unsafe(`create database ${DB}`);
    sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
    const before = files.filter((f) => f < "0005");
    for (const f of before) await apply(sql, f);
    const [org] =
      await sql`insert into organizations (name, slug, require_mfa) values ('Old', 'old', true) returning id`;
    const [user] = await sql`insert into users (email, name, password_hash, mfa_secret, mfa_enabled)
      values ('old@example.com', 'Old', ${await hashPassword(legacyPassword)}, 'v1.k1.a.b.c', true) returning id`;
    await sql`insert into memberships (org_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
    await sql`insert into sessions (token_hash, user_id, active_org_id, expires_at)
      values ('abc', ${user!.id}, ${org!.id}, now() + interval '1 day')`;
    for (const f of files.filter((f) => f.startsWith("0005"))) await apply(sql, f);
  } finally {
    await admin.end({ timeout: 5 });
  }
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe("migration 0005 (better-auth)", () => {
  it("moves argon2id hashes into credential accounts that still verify", async () => {
    const [a] =
      await sql`select a.* from accounts a join users u on u.id = a.user_id where u.email = 'old@example.com'`;
    expect(a).toMatchObject({ provider_id: "credential" });
    expect(a!.account_id).toBe(a!.user_id);
    expect(await verifyPassword(a!.password, legacyPassword)).toBe(true);
    const cols = await sql`select column_name from information_schema.columns where table_name = 'users'`;
    expect(cols.map((c) => c.column_name)).not.toContain("password_hash");
    expect(cols.map((c) => c.column_name)).not.toContain("mfa_secret");
  });

  it("forces everyone into enrollment, drops the org toggle, and revokes old sessions", async () => {
    const [u] = await sql`select mfa_enabled from users where email = 'old@example.com'`;
    expect(u!.mfa_enabled).toBe(false);
    expect(await sql`select * from sessions`).toHaveLength(0);
    const cols = await sql`select column_name from information_schema.columns where table_name = 'organizations'`;
    expect(cols.map((c) => c.column_name)).toEqual(expect.arrayContaining(["enforce_sso", "sso_require_mfa"]));
    expect(cols.map((c) => c.column_name)).not.toContain("require_mfa");
  });
});
