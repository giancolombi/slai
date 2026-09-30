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
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { withOrg } from "./client.js";
import { AAD, decrypt, encrypt, type Keyring, keyIdOf } from "./crypto.js";

export interface SecretColumn {
  table: string;
  column: string;
  /** The AAD the writer used, from the row id. */
  aad: (id: string) => string;
  orgScoped: boolean;
  /** Extra SQL filter (constant), e.g. only Slack channels hold ciphertext. */
  where?: string;
}

/**
 * Every column holding `crypto.ts` ciphertext. A column missing from the
 * database (e.g. after an auth migration) is skipped, so add new ones here
 * when they appear.
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
  { table: "users", column: "mfa_secret", aad: (id) => `user:${id}:mfa`, orgScoped: false },
];

export interface RotationReport {
  currentKeyId: string;
  dryRun: boolean;
  columns: { name: string; rotated: number; failed: number; skipped?: "missing" }[];
  /** Ciphertexts still under each non-current key id after the run. */
  remaining: Record<string, number>;
}

const BATCH = 500;

async function columnExists(db: Db, c: SecretColumn): Promise<boolean> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and table_name = ${c.table} and column_name = ${c.column}`);
  return (rows[0]?.n ?? 0) > 0;
}

/** Re-encrypts one column's stale ciphertexts, in the current transaction scope. */
async function rotateColumn(
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>,
  c: SecretColumn,
  ring: Keyring,
  dryRun: boolean,
  tally: { rotated: number; failed: number },
  remaining: Record<string, number>,
): Promise<void> {
  const table = sql.raw(`"${c.table}"`);
  const col = sql.raw(`"${c.column}"`);
  const extra = c.where ? sql.raw(`and (${c.where})`) : sql``;
  let afterId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const done = await run(async (tx) => {
      const rows = await tx.execute<{ id: string; v: string }>(sql`
        select id::text as id, ${col} as v from ${table}
        where ${col} like 'v1.%' and split_part(${col}, '.', 2) <> ${ring.currentId}
          and id > ${afterId}::uuid ${extra}
        order by id limit ${BATCH} for update`);
      for (const r of rows) {
        afterId = r.id;
        const oldId = keyIdOf(r.v) ?? "?";
        try {
          const plain = decrypt(r.v, { keyring: ring, aad: c.aad(r.id) });
          if (!dryRun) {
            const next = encrypt(plain, { keyring: ring, aad: c.aad(r.id) });
            await tx.execute(sql`update ${table} set ${col} = ${next} where id = ${r.id}::uuid`);
          } else {
            remaining[oldId] = (remaining[oldId] ?? 0) + 1;
          }
          tally.rotated++;
        } catch {
          // Unknown key id or a bad AAD: leave it, count it, never log the value.
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
    const tally = { rotated: 0, failed: 0 };
    if (c.orgScoped) {
      for (const orgId of orgIds) {
        await rotateColumn(
          (fn) => withOrg(opts.owner, orgId, (tx) => fn(tx as unknown as Db)),
          c,
          opts.keyring,
          dryRun,
          tally,
          report.remaining,
        );
      }
    } else {
      await rotateColumn(
        (fn) => opts.owner.transaction((tx) => fn(tx as unknown as Db)),
        c,
        opts.keyring,
        dryRun,
        tally,
        report.remaining,
      );
    }
    report.columns.push({ name, ...tally });
  }
  return report;
}
