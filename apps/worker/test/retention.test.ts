/**
 * Retention job (T-64, TR-30b): old content is purged while SLA outcomes and
 * the audit trail stay; archived contracts, expired invitations, sessions and
 * verification tokens are deleted.
 */
import { randomUUID } from "node:crypto";
import {
  agentActions,
  agentRuns,
  auditEvents,
  contracts,
  createLocalStorage,
  invitations,
  sessions,
  slaOutcomes,
  ticketComments,
  ticketEvents,
  tickets,
  users,
  verifications,
} from "@slai/db";
import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { runRetention } from "../src/retention.js";
import { createConnection, createOrg, setupWorker, tmpStorageDir } from "./harness.js";

const h = setupWorker();
const { owner } = h;
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(h.clock.now().getTime() - days * DAY);

let orgId: string;
let ticketId: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h.deps.storage = createLocalStorage(await tmpStorageDir());
  orgId = await createOrg(owner);
  const connectionId = await createConnection(h, orgId);
  const [t] = await owner.db
    .insert(tickets)
    .values({
      orgId,
      connectionId,
      externalId: `ret-${randomUUID()}`,
      displayKey: "#1",
      subject: "Old outage",
      status: "solved",
      createdAtSource: ago(500),
      updatedAtSource: ago(450),
    })
    .returning();
  ticketId = t!.id;
  const [oldC, newC] = await owner.db
    .insert(ticketComments)
    .values([
      { orgId, ticketId, sourceId: "c1", at: ago(500), authorRole: "requester", public: true, body: "my card 4111" },
      { orgId, ticketId, sourceId: "c2", at: ago(10), authorRole: "agent", public: true, body: "recent reply" },
    ])
    .returning();
  ids.oldComment = oldC!.id;
  ids.newComment = newC!.id;
  await owner.db.insert(ticketEvents).values({
    orgId,
    ticketId,
    idempotencyKey: "e1",
    type: "created",
    at: ago(500),
    payload: { status: "new", priority: "high" },
  });
  const [outcome] = await owner.db
    .insert(slaOutcomes)
    .values({
      orgId,
      ticketId,
      metric: "first_response",
      cycleIndex: 0,
      priority: "high",
      state: "breached",
      startedAt: ago(500),
      stoppedAt: ago(499),
      breachAt: ago(499.5),
      targetMs: 3_600_000,
      elapsedMs: 86_400_000,
    })
    .returning();
  ids.outcome = outcome!.id;
  const [run] = await owner.db
    .insert(agentRuns)
    .values({
      orgId,
      kind: "draft_reply",
      status: "succeeded",
      ticketId,
      output: { body: "draft" },
      createdAt: ago(450),
    })
    .returning();
  ids.run = run!.id;
  const [action] = await owner.db
    .insert(agentActions)
    .values({ orgId, ticketId, kind: "public_reply", status: "sent", body: "Hi, sorry", createdAt: ago(450) })
    .returning();
  ids.action = action!.id;

  // Contracts: one archived long ago (purged), one archived yesterday (kept).
  for (const [name, archivedDaysAgo] of [
    ["oldArchived", 45],
    ["newArchived", 1],
  ] as const) {
    const id = randomUUID();
    const storageKey = `${orgId}/contracts/${id}`;
    await h.deps.storage.put(storageKey, new TextEncoder().encode("%PDF"), {
      contentType: "application/pdf",
      sha256: "x",
    });
    await owner.db.insert(contracts).values({
      id,
      orgId,
      storageKey,
      filename: `${name}.pdf`,
      sha256: "x",
      mediaType: "application/pdf",
      sizeBytes: 4,
      status: "archived",
      archivedAt: ago(archivedDaysAgo),
    });
    ids[name] = id;
  }
  const [inv] = await owner.db
    .insert(invitations)
    .values({ orgId, email: "gone@example.com", role: "member", tokenHash: randomUUID(), expiresAt: ago(3) })
    .returning();
  ids.invitation = inv!.id;

  // Auth state (real time: the purge compares with the database clock).
  const [u] = await owner.db
    .insert(users)
    .values({ email: `ret-${randomUUID()}@example.com`, name: "Ret" })
    .returning();
  const past = new Date(Date.now() - DAY);
  const future = new Date(Date.now() + DAY);
  const [expired, live] = await owner.db
    .insert(sessions)
    .values([
      { tokenHash: randomUUID(), userId: u!.id, expiresAt: past },
      { tokenHash: randomUUID(), userId: u!.id, expiresAt: future },
    ])
    .returning();
  ids.expiredSession = expired!.id;
  ids.liveSession = live!.id;
  const [v] = await owner.db
    .insert(verifications)
    .values({ identifier: "2fa", value: "x", expiresAt: past })
    .returning();
  ids.verification = v!.id;

  await owner.db.insert(auditEvents).values({
    orgId,
    actorType: "user",
    action: "policy.approved",
    targetType: "policy",
    at: ago(500),
  });
});

describe("run-retention", () => {
  it("purges old content, keeps SLA outcomes and the audit trail, and deletes expired records", async () => {
    const auditBefore = await owner.db.select().from(auditEvents).where(eq(auditEvents.orgId, orgId));
    const run = await runRetention(h.deps);
    expect(run.failures).toBe(0);
    expect(run.purged[orgId]).toMatchObject({
      comments: 1,
      agentOutputs: 1,
      actionBodies: 1,
      invitations: 1,
      contracts: 1,
    });
    expect(run.auth.sessions).toBeGreaterThanOrEqual(1);
    expect(run.auth.verifications).toBeGreaterThanOrEqual(1);

    const comments = await owner.db.select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId));
    const oldC = comments.find((c) => c.id === ids.oldComment)!;
    expect(oldC.body).toBe("");
    expect(oldC.redactedAt).not.toBeNull();
    expect(comments.find((c) => c.id === ids.newComment)!.body).toBe("recent reply");

    // The SLA record is intact: the ticket, its events and its outcome.
    expect(await owner.db.select().from(tickets).where(eq(tickets.id, ticketId))).toHaveLength(1);
    expect(await owner.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId))).toHaveLength(1);
    const [outcome] = await owner.db.select().from(slaOutcomes).where(eq(slaOutcomes.id, ids.outcome!));
    expect(outcome).toMatchObject({ state: "breached", elapsedMs: 86_400_000 });

    const [run1] = await owner.db.select().from(agentRuns).where(eq(agentRuns.id, ids.run!));
    expect(run1!.output).toBeNull();
    const [a] = await owner.db.select().from(agentActions).where(eq(agentActions.id, ids.action!));
    expect(a!.body).toBeNull();
    expect(a!.status).toBe("sent");

    const left = await owner.db
      .select({ id: contracts.id, key: contracts.storageKey })
      .from(contracts)
      .where(inArray(contracts.id, [ids.oldArchived!, ids.newArchived!]));
    expect(left.map((c) => c.id)).toEqual([ids.newArchived]);
    await expect(h.deps.storage.get(`${orgId}/contracts/${ids.oldArchived}`)).rejects.toThrow();
    expect(await h.deps.storage.get(`${orgId}/contracts/${ids.newArchived}`)).toHaveLength(4);

    expect(await owner.db.select().from(invitations).where(eq(invitations.id, ids.invitation!))).toHaveLength(0);
    const s = await owner.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.id, [ids.expiredSession!, ids.liveSession!]));
    expect(s.map((r) => r.id)).toEqual([ids.liveSession]);
    expect(await owner.db.select().from(verifications).where(eq(verifications.id, ids.verification!))).toHaveLength(0);

    // Audit events are never deleted, even the 500-day-old one; the purge itself is audited.
    const auditAfter = await owner.db.select().from(auditEvents).where(eq(auditEvents.orgId, orgId));
    for (const e of auditBefore) expect(auditAfter.map((x) => x.id)).toContain(e.id);
    const actions = auditAfter.map((e) => e.action);
    expect(actions).toContain("retention.purged");
    expect(actions).toContain("contract.purged");
    const [purged] = await owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "retention.purged")));
    expect(purged!.actorType).toBe("system");
    expect(purged!.metadata).toMatchObject({ comments: 1, contentDays: 400 });
  });

  it("is idempotent: a second run finds nothing to do for the org", async () => {
    const run = await runRetention(h.deps);
    expect(run.purged[orgId]).toBeUndefined();
  });

  it("honours a shorter configured retention", async () => {
    h.deps.config = { ...h.deps.config, retention: { contentDays: 5, archivedContractDays: 30 } };
    try {
      const run = await runRetention(h.deps);
      expect(run.purged[orgId]).toMatchObject({ comments: 1 });
      const [c] = await owner.db.select().from(ticketComments).where(eq(ticketComments.id, ids.newComment!));
      expect(c!.body).toBe("");
    } finally {
      h.deps.config = { ...h.deps.config, retention: { contentDays: 400, archivedContractDays: 30 } };
    }
  });
});
