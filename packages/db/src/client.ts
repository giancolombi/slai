import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything you can run a query on: the pool or a transaction. */
export type Executor = Db | Tx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Database {
  db: Db;
  /** The underlying postgres.js client (LISTEN/NOTIFY, raw SQL). */
  client: postgres.Sql;
  close(): Promise<void>;
}

export function connect(url: string, opts: { max?: number; applicationName?: string } = {}): Database {
  const client = postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    connection: { application_name: opts.applicationName ?? "slai" },
  });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}

/**
 * The org-scoped database. Connect it with the `slai_app` role (DATABASE_APP_URL),
 * which is subject to RLS. All org data goes through `withOrg`.
 */
export interface OrgDatabase extends Database {
  withOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * Runs `fn` in a transaction with `app.org_id` set (transaction-local). RLS
 * then confines every read and write in `fn` to that organization.
 */
export async function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(orgId)) throw new Error("withOrg: orgId must be a uuid");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export function createOrgDb(url: string, opts: { max?: number; applicationName?: string } = {}): OrgDatabase {
  const base = connect(url, opts);
  return { ...base, withOrg: (orgId, fn) => withOrg(base.db, orgId, fn) };
}

/**
 * The unscoped system database. Connect it with the `slai_worker` role
 * (DATABASE_SYSTEM_URL). Use it ONLY for:
 *
 * - auth lookups in apps/api: users, sessions, memberships (login, session
 *   resolution, the org switcher, signup's user+org+membership creation) and
 *   pre-auth audit events (failed logins, which have no org);
 * - webhook routing in apps/api: resolving a connection id to its org;
 * - worker sweeps in apps/worker: selecting due `tickets.next_check_at` and
 *   connections due for sync, across orgs, then handing each id to a job that
 *   uses `withOrg`.
 *
 * The role's grants enforce this: it cannot read ticket content, contracts,
 * credentials or policies.
 */
export function createSystemDb(url: string, opts: { max?: number; applicationName?: string } = {}): Database {
  return connect(url, { max: opts.max ?? 5, applicationName: opts.applicationName ?? "slai-system" });
}
