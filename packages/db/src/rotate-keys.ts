/**
 * ENCRYPTION_KEY rotation (T-64, TR-27a): re-encrypts every secret written
 * under a key id other than the current one. Run with the new key as
 * ENCRYPTION_KEY/ENCRYPTION_KEY_ID and the old one(s) in
 * ENCRYPTION_KEYS_PREVIOUS; when the report shows nothing left on an old id,
 * remove it from ENCRYPTION_KEYS_PREVIOUS.
 *
 * Runs as the owner role (DATABASE_URL). Org-scoped tables are handled one org
 * at a time with `app.org_id` set, so it also works where FORCE RLS applies to
 * the owner (managed Postgres); the org list comes from the system role.
 *
 * better-auth's own sealed values (TOTP secrets, backup codes, OAuth tokens)
 * use SESSION_SECRET, not this keyring; they rotate with SESSION_SECRET_VERSION.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { withOrg } from "./client.js";
import { AAD, decrypt, encrypt, type Keyring, keyIdOf } from "./crypto.js";

export interface SecretColumn {
  table: string;
  column: string;
  /** The AAD the writer used, from the row's `aadColumn` (default `id`). */
  aad: (key: string) => string;
  aadColumn?: string;
  /** The column is a JSON string and only this field in it is ciphertext. */
  jsonField?: string;
  orgScoped: boolean;
  /** Extra SQL filter (constant), e.g. only Slack channels hold ciphertext. */
  where?: string;
}

/**
 * Every column holding `crypto.ts` ciphertext. A column missing from the
 * database is skipped, so add new ones here when they appear.
 */
export const SECRET_COLUMNS: SecretColumn[] = [
  { table: "connections", column: "credentials", aad: AAD.connectionCredentials, orgScoped: true },
  { table: "connections", column: "webhook_secret", aad: AAD.connectionWebhookSecret, orgScoped: true },
  {
    table: "notification_channels",
    column: "target",
    aad: AAD.notificationTarget,
    orgScoped: true,
    where: "kind = 'slack_webhook'",
  },
  {
    table: "sso_providers",
    column: "oidc_config",
    jsonField: "clientSecret",
    aad: AAD.ssoClientSecret,
    aadColumn: "provider_id",
    orgScoped: true,
  },
  {
    table: "sso_providers",
    column: "saml_config",
    jsonField: "privateKey",
    aad: AAD.ssoSamlPrivateKey,
    aadColumn: "provider_id",
    orgScoped: true,
  },
];

export interface RotationReport {
  currentKeyId: string;
  dryRun: boolean;
  columns: { name: string; rotated: number; failed: number; skipped?: "missing" }[];
  /** Ciphertexts still under each non-current key id after the run (or, for a dry run, before it). */
  remaining: Record<string, number>;
}

const BATCH = 500;

async function columnExists(db: Db, c: SecretColumn): Promise<boolean> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and table_name = ${c.table} and column_name = ${c.column}`);
  return (rows[0]?.n ?? 0) > 0;
}

type Tally = { rotated: number; failed: number };

/** Re-encrypts one column's stale ciphertexts, in batches, each batch in one transaction. */
async function rotateColumn(
  owner: Db,
  orgId: string | null,
  c: SecretColumn,
  ring: Keyring,
  dryRun: boolean,
  tally: Tally,
  remaining: Record<string, number>,
): Promise<void> {
  const table = sql.raw(`"${c.table}"`);
  const col = sql.raw(`"${c.column}"`);
  const aadCol = sql.raw(`"${c.aadColumn ?? "id"}"`);
  const extra = c.where ? sql.raw(`and (${c.where})`) : sql``;
  // withOrg sets app.org_id for RLS; the explicit filter also scopes a superuser owner, which bypasses RLS.
  const inOrg = orgId ? sql`and org_id = ${orgId}::uuid` : sql``;
  const run = <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
    orgId ? withOrg(owner, orgId, (tx) => fn(tx as unknown as Db)) : owner.transaction((tx) => fn(tx as unknown as Db));
  // Plain columns are filtered in SQL; a JSON column holds the ciphertext in one field, checked below.
  const stale = c.jsonField
    ? sql`${col} is not null`
    : sql`${col} like 'v1.%' and split_part(${col}, '.', 2) <> ${ring.currentId}`;
  let afterId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const done = await run(async (tx) => {
      const rows = await tx.execute<{ id: string; k: string; v: string }>(sql`
        select id::text as id, ${aadCol}::text as k, ${col} as v from ${table}
        where ${stale} and id > ${afterId}::uuid ${inOrg} ${extra}
        order by id limit ${BATCH} for update`);
      for (const r of rows) {
        afterId = r.id;
        const cfg = c.jsonField ? (JSON.parse(r.v) as Record<string, unknown>) : null;
        const cipher = cfg ? cfg[c.jsonField!] : r.v;
        if (typeof cipher !== "string") continue;
        const oldId = keyIdOf(cipher);
        if (!oldId || oldId === ring.currentId) continue;
        try {
          const aad = c.aad(r.k);
          const plain = decrypt(cipher, { keyring: ring, aad });
          if (dryRun) {
            remaining[oldId] = (remaining[oldId] ?? 0) + 1;
          } else {
            const next = encrypt(plain, { keyring: ring, aad });
            const value = cfg ? JSON.stringify({ ...cfg, [c.jsonField!]: next }) : next;
            await tx.execute(sql`update ${table} set ${col} = ${value} where id = ${r.id}::uuid`);
          }
          tally.rotated++;
        } catch {
          // Unknown key id or a bad AAD: leave it and count it. Never log the value.
          tally.failed++;
          remaining[oldId] = (remaining[oldId] ?? 0) + 1;
        }
      }
      return rows.length < BATCH;
    });
    if (done) return;
  }
}

export async function rotateSecrets(opts: {
  /** Owner connection. */
  owner: Db;
  /** Lists org ids (slai_worker or owner). */
  listOrgIds: () => Promise<string[]>;
  keyring: Keyring;
  dryRun?: boolean;
  columns?: SecretColumn[];
}): Promise<RotationReport> {
  const dryRun = opts.dryRun ?? false;
  const report: RotationReport = { currentKeyId: opts.keyring.currentId, dryRun, columns: [], remaining: {} };
  const orgIds = await opts.listOrgIds();
  for (const c of opts.columns ?? SECRET_COLUMNS) {
    const name = `${c.table}.${c.column}`;
    if (!(await columnExists(opts.owner, c))) {
      report.columns.push({ name, rotated: 0, failed: 0, skipped: "missing" });
      continue;
    }
    const tally: Tally = { rotated: 0, failed: 0 };
    for (const orgId of c.orgScoped ? orgIds : [null]) {
      await rotateColumn(opts.owner, orgId, c, opts.keyring, dryRun, tally, report.remaining);
    }
    report.columns.push({ name, ...tally });
  }
  return report;
}
