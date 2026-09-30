import { agentActions, auditEvents, knowledgeArticles, knowledgeSources } from "@slai/db";
import type { AgentAction, Connection, KnowledgeArticle, KnowledgeSource, List, TicketDetail } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { fakeConnector, seedTicket } from "./fixtures.js";
import { addMember, fakeRegistry, setupApp, signup } from "./harness.js";

const withKnowledge = { ...fakeConnector(), supportsKnowledge: true };
const ctx = setupApp({ connectors: fakeRegistry([withKnowledge]) });
let owner: Awaited<ReturnType<typeof signup>>;
let conn: Connection;
let source: KnowledgeSource;

const jobsFor = (key: string, value: string) =>
  ctx.owner.client<{ name: string }[]>`select name from pgboss.job where data->>${key} = ${value}`;
const auditOf = async (orgId: string, action: string) =>
  ctx.owner.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, action)));

beforeAll(async () => {
  owner = await signup(ctx);
  const res = await owner.client.post<Connection>("/connections", {
    provider: "zendesk",
    name: "Support",
    credentials: { subdomain: "acme", token: "zd-super-secret-token" },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  conn = res.body;
  const list = await owner.client.get<List<KnowledgeSource>>("/knowledge-sources");
  source = list.body.items[0]!;
  await ctx.owner.db.insert(knowledgeArticles).values([
    {
      orgId: owner.orgId,
      sourceId: source.id,
      externalId: "1",
      title: "Fixing SAML assertion errors during SSO login",
      url: "https://help.acme.example/saml",
      bodyText: "Copy the Entity ID into the Audience URI field of your identity provider.",
    },
    {
      orgId: owner.orgId,
      sourceId: source.id,
      externalId: "2",
      title: "Webhook deliveries: retries and delays",
      url: "https://help.acme.example/webhooks",
      bodyText: "Deliveries are retried with backoff when your endpoint is slow (100%_ of the time).",
    },
  ]);
});

describe("knowledge sources", () => {
  it("a new connection whose help desk has a help center gets an article source, synced right away", async () => {
    expect(source).toMatchObject({
      connectionId: conn.id,
      kind: "helpdesk_articles",
      name: "Support help center",
      status: "idle",
      lastSyncAt: null,
    });
    expect((await jobsFor("sourceId", source.id)).map((j) => j.name)).toEqual(["sync-knowledge"]);
    expect((await auditOf(owner.orgId, "knowledge_source.created")).map((e) => e.targetId)).toContain(source.id);
    const connectors = await owner.client.get("/connectors");
    expect(connectors.body[0].supportsKnowledge).toBe(true);
  });

  it("lists sources with counts, and rejects a duplicate or unsupported article source", async () => {
    const list = await owner.client.get<List<KnowledgeSource>>("/knowledge-sources");
    expect(list.body.items).toEqual([expect.objectContaining({ id: source.id, articleCount: 2, enabledCount: 2 })]);
    const dup = await owner.client.post("/knowledge-sources", {
      kind: "helpdesk_articles",
      name: "Again",
      connectionId: conn.id,
    });
    expect(dup.status).toBe(409);
    expect((await owner.client.post("/knowledge-sources", { kind: "helpdesk_articles", name: "x" })).status).toBe(400);
    expect(
      (await owner.client.post("/knowledge-sources", { kind: "manual", name: "x", connectionId: conn.id })).status,
    ).toBe(400);
    expect((await owner.client.post("/knowledge-sources", { kind: "saved_replies", name: "x" })).status).toBe(400);
  });

  it("queues a sync on request (audited); manual sources have nothing to sync", async () => {
    const res = await owner.client.post(`/knowledge-sources/${source.id}/sync`);
    expect(res.status).toBe(202);
    expect((await jobsFor("sourceId", source.id)).length).toBe(2);
    expect(await auditOf(owner.orgId, "knowledge_source.sync_requested")).toHaveLength(1);
    const manual = await owner.client.post<KnowledgeSource>("/knowledge-sources", { kind: "manual", name: "Macros" });
    expect(manual.status).toBe(201);
    expect((await owner.client.post(`/knowledge-sources/${manual.body.id}/sync`)).status).toBe(400);
    expect((await owner.client.post("/knowledge-sources/not-a-uuid/sync")).status).toBe(404);
  });
});

describe("knowledge articles", () => {
  it("searches by full text and title, filters by source, and pages", async () => {
    const q = async (qs: string) => (await owner.client.get<List<KnowledgeArticle>>(`/knowledge-articles?${qs}`)).body;
    expect((await q("q=saml login")).items.map((a) => a.externalId)).toEqual(["1"]);
    expect((await q("q=Webho")).items.map((a) => a.externalId)).toEqual(["2"]);
    expect((await q("q=%25")).items).toEqual([]);
    const all = await q(`sourceId=${source.id}&limit=1`);
    expect(all.items).toHaveLength(1);
    expect(all.items[0]).toMatchObject({ sourceKind: "helpdesk_articles", sourceName: "Support help center" });
    const next = await q(`sourceId=${source.id}&limit=1&cursor=${all.nextCursor}`);
    expect(next.items[0]!.id).not.toBe(all.items[0]!.id);
    expect(next.nextCursor).toBeNull();
  });

  it("admins enable and disable an article (audited); members and viewers cannot", async () => {
    const [a] = (await owner.client.get<List<KnowledgeArticle>>("/knowledge-articles?q=webhook")).body.items;
    const member = await addMember(ctx, owner.orgId, "member");
    const viewer = await addMember(ctx, owner.orgId, "viewer");
    expect((await viewer.client.get("/knowledge-articles")).status).toBe(200);
    expect((await member.client.patch(`/knowledge-articles/${a!.id}`, { enabled: false })).status).toBe(403);
    expect((await member.client.post(`/knowledge-sources/${source.id}/sync`)).status).toBe(403);
    expect((await viewer.client.post("/saved-replies", { title: "x", bodyText: "y" })).status).toBe(403);
    const res = await owner.client.patch<KnowledgeArticle>(`/knowledge-articles/${a!.id}`, { enabled: false });
    expect(res.body.enabled).toBe(false);
    expect((await auditOf(owner.orgId, "knowledge_article.disabled"))[0]?.targetId).toBe(a!.id);
    expect((await owner.client.patch(`/knowledge-articles/${a!.id}`, { enabled: "no" })).status).toBe(400);
  });

  it("keeps other orgs' articles invisible", async () => {
    const other = await signup(ctx, "Eve");
    const [a] = (await owner.client.get<List<KnowledgeArticle>>("/knowledge-articles")).body.items;
    expect((await other.client.get<List<KnowledgeArticle>>("/knowledge-articles")).body.items).toEqual([]);
    expect((await other.client.patch(`/knowledge-articles/${a!.id}`, { enabled: false })).status).toBe(404);
    expect((await other.client.post(`/knowledge-sources/${source.id}/sync`)).status).toBe(404);
  });
});

describe("saved replies", () => {
  it("creates, edits and deletes manual saved replies in the org's saved-replies source (audited)", async () => {
    const created = await owner.client.post<KnowledgeArticle>("/saved-replies", {
      title: "Resetting 2FA",
      bodyText: "An admin can reset a member's second factor from Settings → Members.",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sourceKind: "manual", url: null, enabled: true, externalId: null });
    const edited = await owner.client.patch<KnowledgeArticle>(`/saved-replies/${created.body.id}`, {
      url: "https://help.acme.example/2fa",
      enabled: false,
    });
    expect(edited.body).toMatchObject({ title: "Resetting 2FA", url: "https://help.acme.example/2fa", enabled: false });
    expect((await owner.client.patch(`/saved-replies/${created.body.id}`, { url: "javascript:alert(1)" })).status).toBe(
      400,
    );
    // A synced article is not a saved reply.
    const [synced] = await ctx.owner.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.externalId, "1"));
    expect((await owner.client.patch(`/saved-replies/${synced!.id}`, { title: "x" })).status).toBe(404);
    expect((await owner.client.del(`/saved-replies/${synced!.id}`)).status).toBe(404);
    expect((await owner.client.del(`/saved-replies/${created.body.id}`)).status).toBe(204);
    const actions = ["saved_reply.created", "saved_reply.updated", "saved_reply.deleted"];
    for (const action of actions) expect(await auditOf(owner.orgId, action)).toHaveLength(1);
    const manual = await ctx.owner.db
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.orgId, owner.orgId), eq(knowledgeSources.kind, "manual")));
    expect(manual.length).toBeGreaterThanOrEqual(1);
  });
});

describe("drafts show the knowledge they used", () => {
  it("returns usedKnowledge on actions and ticket detail", async () => {
    const { ticketId } = await seedTicket(ctx, owner.orgId);
    const used = [
      { id: "0197a000-0000-7000-8000-000000000001", title: "Fixing SAML", url: "https://help.acme.example/saml" },
    ];
    await ctx.owner.db.insert(agentActions).values([
      {
        orgId: owner.orgId,
        ticketId,
        kind: "public_reply",
        body: "Hi",
        payload: { usedKnowledge: [0], usedArticles: used },
      },
      { orgId: owner.orgId, ticketId, kind: "public_reply", body: "Old", payload: { usedArticles: "nonsense" } },
    ]);
    const list = await owner.client.get<List<AgentAction>>("/actions?status=proposed");
    const mine = list.body.items.filter((a) => a.ticketId === ticketId);
    expect(mine.map((a) => a.usedKnowledge).sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))).toEqual([used, []]);
    const detail = await owner.client.get<TicketDetail>(`/tickets/${ticketId}`);
    expect(detail.body.actions.find((a) => a.body === "Hi")?.usedKnowledge).toEqual(used);
  });
});
