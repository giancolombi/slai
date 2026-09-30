/**
 * Org offboarding in the worker (T-64): the export bundle's content, and the
 * grace-period hard delete (not before the grace period, not after a cancel,
 * files removed, audit trail and usage ledger kept).
 */
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  auditEvents,
  contracts,
  createLocalStorage,
  creditGrants,
  organizations,
  orgExports,
  ticketComments,
  tickets,
  usageLedger,
} from "@slai/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { deleteOrgIfDue, EXPORT_FORMAT, exportOrg } from "../src/offboarding.js";
import { untar } from "../src/tar.js";
import { createChannel, createConnection, createOrg, setupWorker, tmpStorageDir } from "./harness.js";

const h = setupWorker();
const { owner } = h;
const DAY = 24 * 60 * 60 * 1000;
const SLACK = "https://hooks.slack.com/services/T0/B0/very-secret";
const API_TOKEN = "zd-api-token-must-not-leak";

async function seedOrg() {
  const orgId = await createOrg(owner);
  const connectionId = await createConnection(h, orgId, { credentials: { apiToken: API_TOKEN } });
  await createChannel(h, orgId, { kind: "slack_webhook", target: SLACK });
  const [t] = await owner.db
    .insert(tickets)
    .values({
      orgId,
      connectionId,
      externalId: `off-${randomUUID()}`,
      displayKey: "#42",
      subject: "Printer on fire",
      status: "open",
      createdAtSource: h.clock.now(),
      updatedAtSource: h.clock.now(),
    })
    .returning();
  await owner.db.insert(ticketComments).values({
    orgId,
    ticketId: t!.id,
    sourceId: "c1",
    at: h.clock.now(),
    authorRole: "requester",
    public: true,
    body: "It is still on fire",
  });
  const contractId = randomUUID();
  const storageKey = `${orgId}/contracts/${contractId}`;
  const pdf = new TextEncoder().encode("%PDF-1.7 the signed MSA");
  await h.deps.storage.put(storageKey, pdf, { contentType: "application/pdf", sha256: "x" });
  await owner.db.insert(contracts).values({
    id: contractId,
    orgId,
    storageKey,
    filename: "Acme MSA (signed).pdf",
    sha256: "x",
    mediaType: "application/pdf",
    sizeBytes: pdf.length,
  });
  await owner.db
    .insert(usageLedger)
    .values({ orgId, kind: "model_call", quantity: 100, unit: "tokens", costMicros: 5, credits: 3 });
  await owner.db
    .insert(auditEvents)
    .values({ orgId, actorType: "user", action: "policy.approved", targetType: "policy" });
  // Append-only like the ledger (trigger-enforced): the org delete must not cascade into it.
  await owner.db.insert(creditGrants).values({ orgId, credits: 500, source: "manual" });
  return { orgId, connectionId, ticketId: t!.id, contractId, storageKey, pdf };
}

beforeAll(async () => {
  h.deps.storage = createLocalStorage(await tmpStorageDir());
});

describe("export-org", () => {
  it("bundles every org table and the contract files, without secrets, and audits it", async () => {
    const s = await seedOrg();
    const exportId = randomUUID();
    await owner.db
      .insert(orgExports)
      .values({ id: exportId, orgId: s.orgId, expiresAt: new Date(h.clock.now().getTime() + 7 * DAY) });
    await exportOrg(h.deps, { orgId: s.orgId, exportId });

    const [row] = await owner.db.select().from(orgExports).where(eq(orgExports.id, exportId));
    expect(row).toMatchObject({ status: "succeeded", storageKey: `${s.orgId}/exports/${exportId}.tar.gz` });
    const gz = Buffer.from(await h.deps.storage.get(row!.storageKey!));
    expect(gz.byteLength).toBe(row!.sizeBytes);
    const files = new Map(untar(gunzipSync(gz)).map((e) => [e.path, Buffer.from(e.data)]));

    const manifest = JSON.parse(files.get("manifest.json")!.toString());
    expect(manifest).toMatchObject({ format: EXPORT_FORMAT, orgId: s.orgId, exportId });
    expect(manifest.tables).toMatchObject({
      tickets: 1,
      ticket_comments: 1,
      contracts: 1,
      connections: 1,
      credit_grants: 1,
    });
    expect(manifest.tables.audit_events).toBeGreaterThanOrEqual(1);

    const ticketsJson = JSON.parse(files.get("data/tickets.json")!.toString());
    expect(ticketsJson[0]).toMatchObject({ id: s.ticketId, subject: "Printer on fire" });
    const comments = JSON.parse(files.get("data/ticket_comments.json")!.toString());
    expect(comments[0].body).toBe("It is still on fire");
    expect(JSON.parse(files.get("data/usage_ledger.json")!.toString())).toHaveLength(1);

    const pdfPath = manifest.files[0].path as string;
    expect(pdfPath).toBe(`contracts/${s.contractId}/Acme_MSA_signed_.pdf`);
    expect(files.get(pdfPath)!.toString()).toBe("%PDF-1.7 the signed MSA");

    // No secret, plaintext or ciphertext, anywhere in the bundle.
    const all = [...files.values()].map((b) => b.toString()).join("\n");
    expect(all).not.toContain(API_TOKEN);
    expect(all).not.toContain("very-secret");
    expect(all).not.toMatch(/"credentials"|"webhookSecret"|v1\.k1\./);

    const [done] = await owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, s.orgId), eq(auditEvents.action, "org.export.completed")));
    expect(done!.metadata).toMatchObject({ sha256: row!.sha256, files: 1 });
  });

  it("does nothing for an export that is not queued (a retried job)", async () => {
    const s = await seedOrg();
    const exportId = randomUUID();
    await owner.db.insert(orgExports).values({
      id: exportId,
      orgId: s.orgId,
      status: "succeeded",
      expiresAt: new Date(h.clock.now().getTime() + DAY),
    });
    await exportOrg(h.deps, { orgId: s.orgId, exportId });
    const [row] = await owner.db.select().from(orgExports).where(eq(orgExports.id, exportId));
    expect(row!.storageKey).toBeNull();
  });
});

describe("delete-org", () => {
  const schedule = (orgId: string, at: Date | null) =>
    owner.db.update(organizations).set({ deletionScheduledFor: at }).where(eq(organizations.id, orgId));
  const orgExists = async (orgId: string) =>
    (await owner.db.select().from(organizations).where(eq(organizations.id, orgId))).length === 1;

  it("waits for the grace period, then deletes the org, its data and files, and keeps audit and usage", async () => {
    const s = await seedOrg();
    // Not scheduled: nothing happens.
    expect(await deleteOrgIfDue(h.deps, s.orgId)).toBe(false);
    // Scheduled 7 days out: still inside the grace period.
    await schedule(s.orgId, new Date(Date.now() + 7 * DAY));
    expect(await deleteOrgIfDue(h.deps, s.orgId)).toBe(false);
    expect(await orgExists(s.orgId)).toBe(true);

    // The grace period has passed.
    await schedule(s.orgId, new Date(Date.now() - 60_000));
    h.clock.set(new Date(Math.max(h.clock.now().getTime(), Date.now())));
    expect(await deleteOrgIfDue(h.deps, s.orgId)).toBe(true);

    expect(await orgExists(s.orgId)).toBe(false);
    expect(await owner.db.select().from(tickets).where(eq(tickets.orgId, s.orgId))).toHaveLength(0);
    expect(await owner.db.select().from(contracts).where(eq(contracts.orgId, s.orgId))).toHaveLength(0);
    await expect(h.deps.storage.get(s.storageKey)).rejects.toThrow();

    const trail = await owner.db.select().from(auditEvents).where(eq(auditEvents.orgId, s.orgId));
    expect(trail.map((e) => e.action)).toEqual(expect.arrayContaining(["policy.approved", "org.deleted"]));
    const deleted = trail.find((e) => e.action === "org.deleted")!;
    expect(deleted.actorType).toBe("system");
    expect(deleted.metadata).toMatchObject({ filesDeleted: 1 });
    expect(await owner.db.select().from(usageLedger).where(eq(usageLedger.orgId, s.orgId))).toHaveLength(1);
    expect(await owner.db.select().from(creditGrants).where(eq(creditGrants.orgId, s.orgId))).toHaveLength(1);
  });

  it("never deletes a cancelled deletion, even when the job fires", async () => {
    const s = await seedOrg();
    await schedule(s.orgId, new Date(Date.now() - 60_000));
    await schedule(s.orgId, null); // the owner cancelled
    expect(await deleteOrgIfDue(h.deps, s.orgId)).toBe(false);
    expect(await orgExists(s.orgId)).toBe(true);
    expect(await h.deps.storage.get(s.storageKey)).toHaveLength(s.pdf.length);
  });

  it("the database refuses an early delete even if the worker's clock is wrong", async () => {
    const s = await seedOrg();
    await schedule(s.orgId, new Date(Date.now() + DAY));
    h.clock.set(new Date(Date.now() + 2 * DAY)); // a worker whose clock runs ahead
    expect(await deleteOrgIfDue(h.deps, s.orgId)).toBe(false);
    expect(await orgExists(s.orgId)).toBe(true);
    // ...and no file was removed either.
    expect(await h.deps.storage.get(s.storageKey)).toHaveLength(s.pdf.length);
  });

  it("slai_worker can run slai_delete_org but holds no DELETE on org data", async () => {
    const s = await seedOrg();
    const err = await h.deps.systemDb.db
      .delete(tickets)
      .where(eq(tickets.orgId, s.orgId))
      .then(
        () => null,
        (e: Error & { cause?: Error }) => `${e.message} ${e.cause?.message ?? ""}`,
      );
    expect(err).toMatch(/permission denied/);
  });
});
