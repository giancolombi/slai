import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { installJobQueues, PGBOSS_SCHEMA } from "./jobs.js";

/** SLAI_MIGRATIONS_DIR overrides the location (the bundled migrate image ships the SQL next to the bundle). */
export const MIGRATIONS_DIR =
  process.env.SLAI_MIGRATIONS_DIR ?? fileURLToPath(new URL("../migrations", import.meta.url));

const RUNTIME_ROLE = /^slai_(app|worker|auth)$/;

/**
 * Sets each runtime role's password from its connection URL (e.g.
 * DATABASE_APP_URL), so the URLs in the secrets manager are the single source
 * of truth and the development passwords from the migrations never survive a
 * deploy. Run as the owner (needs CREATEROLE). Returns the roles it set.
 */
export async function syncRolePasswords(ownerUrl: string, runtimeUrls: string[]): Promise<string[]> {
  const client = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  const done: string[] = [];
  try {
    for (const url of runtimeUrls) {
      const u = new URL(url);
      const role = decodeURIComponent(u.username);
      const password = decodeURIComponent(u.password);
      if (!RUNTIME_ROLE.test(role) || !password) continue;
      // ALTER ROLE takes no bind parameters; quote the literal (role names are checked above).
      await client.unsafe(`alter role ${role} with login password '${password.replaceAll("'", "''")}'`);
      done.push(role);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
  return done;
}

/**
 * Applies schema migrations (as the owner role), installs the pg-boss schema
 * and queues, and grants the runtime roles what they need on the queue.
 */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const client = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    // One migration runner at a time (e.g. overlapping deploys' pre-deploy commands); released when the session ends.
    await client`select pg_advisory_lock(hashtext('slai_migrate'))`;
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    await installJobQueues(ownerUrl);
    const s = client(PGBOSS_SCHEMA);
    // Job payloads are ids only; both runtime roles produce and the worker consumes.
    await client`grant usage on schema ${s} to slai_app, slai_worker`;
    await client`grant select, insert, update, delete on all tables in schema ${s} to slai_app, slai_worker`;
    await client`grant usage, select on all sequences in schema ${s} to slai_app, slai_worker`;
    await client`grant execute on all functions in schema ${s} to slai_app, slai_worker`;
    await client`alter default privileges in schema ${s} grant select, insert, update, delete on tables to slai_app, slai_worker`;
  } finally {
    await client.end({ timeout: 5 });
  }
}
