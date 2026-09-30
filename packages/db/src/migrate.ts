import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { installJobQueues, PGBOSS_SCHEMA } from "./jobs.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies schema migrations (as the owner role), installs the pg-boss schema
 * and queues, and grants the runtime roles what they need on the queue.
 */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const client = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
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
