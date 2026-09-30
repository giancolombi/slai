/**
 * db:backup / db:restore round trip: dump the test database, restore it into a
 * fresh one, and check data, RLS and the append-only trigger survived. Needs
 * pg_dump >= the server version or Docker; skipped when neither is available.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { backupDatabase, pgTools, restoreDatabase } from "../src/backup.js";
import { connect, createOrgDb } from "../src/client.js";
import { tickets } from "../src/schema.js";
import { testDbUrls } from "../src/testing.js";
import { failure, openDbs, seedOrg, urls } from "./helpers.js";

const RESTORE_DB = "slai_test_restore";
const restored = testDbUrls(RESTORE_DB);

const dockerOk = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const tools = await pgTools(urls.owner).catch(() => null);
const available = tools !== null && (tools.mode === "local" || dockerOk);

describe.skipIf(!available)("db:backup and db:restore", () => {
  const { owner } = openDbs();
  const admin = postgres(new URL("/postgres", urls.owner).toString(), { max: 1, onnotice: () => {} });
  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${RESTORE_DB} with (force)`);
    await admin.end({ timeout: 5 });
  });

  it("round-trips data, RLS policies, grants and the append-only trigger", { timeout: 180_000 }, async () => {
    const { orgId, ticketIds } = await seedOrg(owner, 3);
    const dir = await mkdtemp(join(tmpdir(), "slai-backup-"));
    const { file, sha256 } = await backupDatabase(urls.owner, join(dir, "test.dump"), tools!);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);

    await admin.unsafe(`drop database if exists ${RESTORE_DB} with (force)`);
    await admin.unsafe(`create database ${RESTORE_DB}`);
    await restoreDatabase(restored.owner, file, { tools: tools! });
    // A non-empty target is refused without --clean.
    await expect(restoreDatabase(restored.owner, file, { tools: tools! })).rejects.toThrow("not empty");

    const back = connect(restored.owner, { max: 1 });
    const app = createOrgDb(restored.app, { max: 1 });
    try {
      const rows = await back.db.select().from(tickets).where(eq(tickets.orgId, orgId));
      expect(rows.map((r) => r.id).sort()).toEqual([...ticketIds].sort());
      // RLS and grants came back: the app role sees this org only inside withOrg.
      expect(await app.db.select().from(tickets)).toHaveLength(0);
      expect(await app.withOrg(orgId, (tx) => tx.select().from(tickets))).toHaveLength(3);
      // The append-only trigger came back too.
      expect(await failure(back.db.execute(sql`truncate audit_events`))).toContain("append-only");
    } finally {
      await Promise.all([back.close(), app.close()]);
    }
  });
});
