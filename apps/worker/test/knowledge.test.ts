/**
 * T-47: syncing a help desk's articles into knowledge_articles, scheduling the
 * daily sync, and retrieving the articles that fit a ticket.
 */
import { knowledgeArticles, knowledgeSources } from "@slai/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { KNOWLEDGE_BODY_CHARS, retrieveKnowledge, scheduleKnowledgeSyncs, searchTerms } from "../src/knowledge.js";
import { createConnection, createOrg, setupWorker } from "./harness.js";

const h = setupWorker();
const { owner } = h;
let orgId: string;
let connectionId: string;
let sourceId: string;

const addSource = async (org: string, values: Partial<typeof knowledgeSources.$inferInsert>) => {
  const [s] = await owner.db
    .insert(knowledgeSources)
    .values({ orgId: org, kind: "helpdesk_articles", name: "Help center", ...values })
    .returning();
  return s!;
};
const articles = () => owner.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.sourceId, sourceId));
const source = async (id = sourceId) =>
  (await owner.db.select().from(knowledgeSources).where(eq(knowledgeSources.id, id)))[0]!;

beforeAll(async () => {
  orgId = await createOrg(owner);
  connectionId = await createConnection(h, orgId, { config: { seed: "kb", ticketsPerDay: 1, historyDays: 1 } });
  sourceId = (await addSource(orgId, { connectionId })).id;
});

describe("sync-knowledge", () => {
  it("pages through the help desk's articles and upserts them", async () => {
    await h.queue.send("sync-knowledge", { orgId, sourceId });
    await h.drain();
    const rows = await articles();
    expect(rows.length).toBeGreaterThanOrEqual(25);
    expect(
      rows.every((r) => r.orgId === orgId && r.enabled && r.url?.startsWith("https://help.acme-cloud.example/")),
    ).toBe(true);
    expect(await source()).toMatchObject({ status: "idle", lastError: null, lastSyncAt: h.clock.now() });
  });

  it("keeps an admin's enable toggle across syncs and drops articles the help desk removed", async () => {
    const [first] = await articles();
    await owner.db
      .update(knowledgeArticles)
      .set({ enabled: false, title: "stale" })
      .where(eq(knowledgeArticles.id, first!.id));
    await owner.db
      .insert(knowledgeArticles)
      .values({ orgId, sourceId, externalId: "unpublished-since", title: "Old", bodyText: "Gone from the help desk." });
    await h.queue.send("sync-knowledge", { orgId, sourceId });
    await h.drain();
    const rows = await articles();
    const again = rows.find((r) => r.id === first!.id)!;
    expect(again.enabled).toBe(false);
    expect(again.title).toBe(first!.title);
    expect(rows.some((r) => r.externalId === "unpublished-since")).toBe(false);
    await owner.db.update(knowledgeArticles).set({ enabled: true }).where(eq(knowledgeArticles.id, first!.id));
  });

  it("records an error for a connector without knowledge, and ignores manual sources", async () => {
    const other = await createConnection(h, orgId, {
      provider: "zendesk",
      credentials: { subdomain: "acme", email: "a@acme.example", apiToken: "t" },
    });
    // Zendesk supports knowledge; a "saved replies" source on it does not exist upstream yet.
    const saved = await addSource(orgId, { connectionId: other, kind: "saved_replies" });
    const manual = await addSource(orgId, { kind: "manual", name: "Saved replies" });
    await h.queue.send("sync-knowledge", { orgId, sourceId: saved.id });
    await h.queue.send("sync-knowledge", { orgId, sourceId: manual.id });
    await h.drain();
    expect(await source(saved.id)).toMatchObject({
      status: "error",
      lastError: expect.stringMatching(/saved replies/),
    });
    expect(await source(manual.id)).toMatchObject({ status: "idle", lastSyncAt: null, lastError: null });
  });
});

describe("the daily schedule", () => {
  it("enqueues never-synced and stale help-desk sources, not fresh or manual ones", async () => {
    const org = await createOrg(owner);
    const conn = await createConnection(h, org, { config: { seed: "kb2", ticketsPerDay: 1, historyDays: 1 } });
    const now = h.clock.now().getTime();
    const never = await addSource(org, { connectionId: conn });
    const stale = await addSource(org, {
      kind: "saved_replies",
      connectionId: conn,
      lastSyncAt: new Date(now - 25 * 3_600_000),
    });
    const conn2 = await createConnection(h, org, { config: { seed: "kb3" } });
    const fresh = await addSource(org, { connectionId: conn2, lastSyncAt: new Date(now - 3_600_000) });
    const manual = await addSource(org, { kind: "manual" });
    h.queue.jobs = [];
    await scheduleKnowledgeSyncs(h.deps);
    const queued = h.queue.jobs
      .filter((j) => j.name === "sync-knowledge" && (j.payload as { orgId: string }).orgId === org)
      .map((j) => (j.payload as { sourceId: string }).sourceId);
    expect(queued.sort()).toEqual([never.id, stale.id].sort());
    expect(queued).not.toContain(fresh.id);
    expect(queued).not.toContain(manual.id);
    h.queue.jobs = [];
  });
});

describe("retrieval", () => {
  const retrieve = (subject: string, lastRequesterMessage: string | null = null) =>
    h.deps.orgDb.withOrg(orgId, (tx) => retrieveKnowledge(tx, { subject, lastRequesterMessage }));

  it("ranks the article that fits the ticket first and returns at most four, bounded", async () => {
    const found = await retrieve(
      "SSO login failing with SAML assertion error",
      'About a dozen of our users get "Invalid SAML assertion: audience mismatch" when signing in through Okta.',
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(4);
    expect(found[0]!.title).toMatch(/SAML/);
    expect(found[0]!.url).toBe("https://help.acme-cloud.example/articles/saml-assertion-errors");
    expect(found.every((a) => a.body.length <= KNOWLEDGE_BODY_CHARS)).toBe(true);
  });

  it("leaves out disabled articles and includes saved replies", async () => {
    const [saml] = await owner.db
      .select()
      .from(knowledgeArticles)
      .where(and(eq(knowledgeArticles.sourceId, sourceId), eq(knowledgeArticles.externalId, "saml-assertion-errors")));
    await owner.db.update(knowledgeArticles).set({ enabled: false }).where(eq(knowledgeArticles.id, saml!.id));
    const manual = await addSource(orgId, { kind: "manual", name: "Saved replies 2" });
    await owner.db.insert(knowledgeArticles).values({
      orgId,
      sourceId: manual.id,
      title: "SAML audience mismatch after certificate rotation",
      bodyText: "We restore the previous audience value for the workspace; ask the user to sign in again.",
    });
    const found = await retrieve("SAML assertion audience mismatch");
    expect(found.some((a) => a.id === saml!.id)).toBe(false);
    expect(found[0]!.title).toBe("SAML audience mismatch after certificate rotation");
    expect(found[0]!.url).toBeNull();
    await owner.db.update(knowledgeArticles).set({ enabled: true }).where(eq(knowledgeArticles.id, saml!.id));
  });

  it("finds nothing for an unrelated or empty query, and never trusts query syntax", async () => {
    expect(await retrieve("zzzqqq xxyyzz")).toEqual([]);
    expect(await retrieve("")).toEqual([]);
    expect(await retrieve("webhooks' & !(| :* <-> ) --")).not.toHaveLength(0);
    expect(searchTerms("Webhooks' & !(| :* SAML-trace")).toEqual(["webhooks", "saml", "trace"]);
  });

  it("stays inside the org (RLS)", async () => {
    const other = await createOrg(owner);
    const found = await h.deps.orgDb.withOrg(other, (tx) =>
      retrieveKnowledge(tx, { subject: "SAML assertion error", lastRequesterMessage: null }),
    );
    expect(found).toEqual([]);
  });
});
