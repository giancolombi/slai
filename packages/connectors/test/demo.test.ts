import { evaluateTicket } from "@slai/sla-engine";
import { afterEach, describe, expect, it } from "vitest";
import { demo, resetDemoStore } from "../src/connectors/demo/index.js";
import { toEngineEvents } from "../src/lib/events.js";
import type { CanonicalTicket, ConnectorClient, KnowledgeArticle } from "../src/types.js";
import { rejection } from "./helpers/fake-fetch.js";
import { calendarPolicy, metric } from "./helpers/policy.js";

const NOW = new Date("2026-09-29T15:00:00Z");
const noFetch = (() => {
  throw new Error("demo must not fetch");
}) as unknown as typeof fetch;

function client(config: Record<string, unknown> = {}): ConnectorClient {
  return demo.create({
    credentials: {},
    config: { seed: "acme", ticketsPerDay: 20, now: NOW, ...config },
    mapping: demo.defaultMapping,
    fetch: noFetch,
  });
}

async function listAll(c: ConnectorClient, since: Date): Promise<CanonicalTicket[]> {
  const out: CanonicalTicket[] = [];
  let cursor: string | null = null;
  do {
    const page = await c.listUpdatedTickets(since, cursor);
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

afterEach(() => resetDemoStore());

describe("demo connector", () => {
  it("is deterministic: same seed → same tickets and histories", async () => {
    const since = new Date(NOW.getTime() - 3 * 86_400_000);
    const a = await listAll(client(), since);
    const b = await listAll(client(), since);
    expect(a.length).toBeGreaterThan(20);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const id = a[5]!.ref.sourceId;
    expect(JSON.stringify(await client().getTicketWithHistory(id))).toBe(
      JSON.stringify(await client().getTicketWithHistory(id)),
    );
    const other = await listAll(client({ seed: "globex" }), since);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(a));
  });

  it("covers 120 days with realistic B2B data and paginates", async () => {
    const all = await listAll(client(), new Date(0));
    const oldest = Math.min(...all.map((t) => t.createdAt.getTime()));
    expect((NOW.getTime() - oldest) / 86_400_000).toBeGreaterThan(119);
    expect(all.length).toBeGreaterThan(100 * 12); // well over one page
    const t = all[0]!;
    expect(t.requester.email?.endsWith(".example")).toBe(true);
    expect(t.requester.email?.split("@")[1]).toContain(
      t.requester
        .orgName!.split(" ")[0]!
        .toLowerCase()
        .replace(/[^a-z]/g, "")
        .slice(0, 5),
    );
    const cats = new Set(all.flatMap((x) => x.tags));
    for (const c of ["login_sso", "api_errors", "billing", "data_export", "outage"]) expect(cats.has(c)).toBe(true);
    const updated = all.map((x) => x.updatedAt.getTime());
    expect([...updated].sort((x, y) => x - y)).toEqual(updated);
  });

  it("produces breaching and healthy tickets under a typical policy", async () => {
    const c = client();
    const recent = (await listAll(c, new Date(NOW.getTime() - 20 * 86_400_000))).slice(0, 250);
    let breached = 0;
    let achieved = 0;
    let paused = 0;
    let reopened = 0;
    for (const t of recent) {
      const h = await c.getTicketWithHistory(t.ref.sourceId);
      const ev = evaluateTicket(calendarPolicy(), toEngineEvents(h.events), NOW);
      if (metric(ev, "first_response").state === "breached" || metric(ev, "resolution").state === "breached")
        breached++;
      if (metric(ev, "first_response").state === "achieved") achieved++;
      if (h.events.some((e) => e.type === "status_changed" && e.status === "pending")) paused++;
      const statuses = h.events
        .filter((e) => e.type === "status_changed")
        .map((e) => (e.type === "status_changed" ? e.status : ""));
      if (statuses.some((s, i) => s === "open" && statuses[i - 1] === "solved")) reopened++;
    }
    expect(breached).toBeGreaterThan(10);
    expect(achieved).toBeGreaterThan(breached);
    expect(paused).toBeGreaterThan(10);
    expect(reopened).toBeGreaterThan(0);
  });

  it("generates live tickets as time passes and reveals their history progressively", async () => {
    const earlier = client({ now: new Date(NOW.getTime() - 6 * 3_600_000) });
    const later = client();
    const since = new Date(NOW.getTime() - 6 * 3_600_000);
    const createdLater = (await listAll(later, since)).filter((t) => t.createdAt >= since);
    expect(createdLater.length).toBeGreaterThan(0);
    await expect(earlier.getTicketWithHistory(createdLater[0]!.ref.sourceId)).rejects.toMatchObject({
      kind: "not_found",
    });
    // A fresh ticket's scripted history keeps unfolding as the clock moves.
    const fresh = createdLater[0]!.ref.sourceId;
    const h1 = await later.getTicketWithHistory(fresh);
    const h2 = await client({ now: new Date(NOW.getTime() + 6 * 86_400_000) }).getTicketWithHistory(fresh);
    expect(h2.events.length).toBeGreaterThan(h1.events.length);
    expect(h2.events.slice(0, h1.events.length).map((e) => e.idempotencyKey)).toEqual(
      h1.events.map((e) => e.idempotencyKey),
    );
  });

  it("maps comments: requester, bot, agent, internal note; keys are stable", async () => {
    const c = client();
    const all = await listAll(c, new Date(NOW.getTime() - 10 * 86_400_000));
    const roles = new Set<string>();
    let internal = 0;
    for (const t of all.slice(0, 80)) {
      const h = await c.getTicketWithHistory(t.ref.sourceId);
      expect(h.events[0]?.type).toBe("created");
      for (const cm of h.comments) {
        roles.add(cm.authorRole);
        if (!cm.public) internal++;
      }
      expect(new Set(h.events.map((e) => e.idempotencyKey)).size).toBe(h.events.length);
    }
    expect([...roles].sort()).toEqual(["agent", "bot", "requester"]);
    expect(internal).toBeGreaterThan(0);
  });

  it("writes mutate the per-connection store (approve-and-send)", async () => {
    let now = NOW.getTime();
    const c = client({ now: () => new Date(now), connectionId: "conn-1" });
    const t = (await listAll(c, new Date(NOW.getTime() - 86_400_000)))[0]!;
    const before = await c.getTicketWithHistory(t.ref.sourceId);
    now += 60_000;
    const { commentSourceId } = await c.postPublicReply(t.ref.sourceId, "We shipped a fix.");
    await c.postInternalNote(t.ref.sourceId, "Drafted by slai");
    await c.updateTicket(t.ref.sourceId, { priority: "urgent", assigneeSourceId: "agent-yuki", addTags: ["vip"] });
    const after = await c.getTicketWithHistory(t.ref.sourceId);
    expect(after.comments.length).toBe(before.comments.length + 2);
    expect(after.comments.find((x) => x.sourceId === commentSourceId)).toMatchObject({
      public: true,
      bodyText: "We shipped a fix.",
    });
    expect(after.ticket.priority).toBe("urgent");
    expect(after.ticket.assignee?.sourceId).toBe("agent-yuki");
    expect(after.ticket.tags).toContain("vip");
    // Earlier events keep their keys.
    const keys = new Set(after.events.map((e) => e.idempotencyKey));
    for (const e of before.events) expect(keys.has(e.idempotencyKey)).toBe(true);
    // Another connection doesn't see the writes.
    const other = client({ connectionId: "conn-2" });
    expect((await other.getTicketWithHistory(t.ref.sourceId)).comments.length).toBe(before.comments.length);
  });

  it("does not support webhooks and rejects unknown tickets", async () => {
    const c = client();
    expect(await c.handleWebhook({ headers: {}, rawBody: "{}", url: "https://x" }, null)).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect((await rejection(c.getTicketWithHistory("nope"))).kind).toBe("not_found");
    expect(demo.supportsWebhooks).toBe(false);
  });
});

describe("demo help center (T-47)", () => {
  it("lists a deterministic, paginated set of articles for every ticket category", async () => {
    expect(demo.supportsKnowledge).toBe(true);
    const c = client();
    const all: KnowledgeArticle[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await c.listKnowledgeArticles!(cursor);
      all.push(...page.items);
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(all.length).toBeGreaterThanOrEqual(25);
    expect(new Set(all.map((a) => a.sourceId)).size).toBe(all.length);
    for (const a of all) {
      expect(a.url).toMatch(/^https:\/\/help\.acme-cloud\.example\/articles\/[a-z0-9-]+$/);
      expect(a.bodyText.length).toBeGreaterThan(80);
      expect(a.updatedAt.getTime()).toBeLessThan(NOW.getTime());
    }
    const titles = all.map((a) => a.title).join("\n");
    for (const topic of [/SAML/, /SCIM/, /2FA/, /rate limits/i, /Webhook/, /invoice/i, /CSV/, /S3/, /Salesforce/]) {
      expect(titles).toMatch(topic);
    }
    // The help center does not depend on the ticket seed.
    const other = await client({ seed: "other" }).listKnowledgeArticles!(null);
    expect(other.items).toEqual(all.slice(0, other.items.length));
    expect(await rejection(c.listKnowledgeArticles!("not-a-cursor"))).toMatchObject({ kind: "invalid" });
  });
});

describe("demo saved replies (T-47b)", () => {
  it("lists about ten macros, paginated, with placeholders stripped and no URL", async () => {
    expect(demo.supportsSavedReplies).toBe(true);
    const c = client();
    const all: KnowledgeArticle[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await c.listSavedReplies!(cursor);
      all.push(...page.items);
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(new Set(all.map((a) => a.sourceId)).size).toBe(all.length);
    for (const r of all) {
      expect(r.url).toBeNull();
      expect(r.bodyText).not.toMatch(/\{\{|\}\}|\{%/);
      expect(r.bodyText).toMatch(/^Hi,\n\n/);
      expect(r.updatedAt.getTime()).toBeLessThan(NOW.getTime());
    }
    expect(all.map((r) => r.title).join("\n")).toMatch(/SAML/);
    expect(await rejection(c.listSavedReplies!("not-a-cursor"))).toMatchObject({ kind: "invalid" });
  });
});
