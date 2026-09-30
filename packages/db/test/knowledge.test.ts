import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { knowledgeArticles, knowledgeSources } from "../src/schema.js";
import { failure, openDbs, seedOrg } from "./helpers.js";

const { owner, app, system } = openDbs();
let a: Awaited<ReturnType<typeof seedOrg>>;
let b: Awaited<ReturnType<typeof seedOrg>>;
let sourceA: string;

beforeAll(async () => {
  a = await seedOrg(owner, 0);
  b = await seedOrg(owner, 0);
  for (const org of [a, b]) {
    const [s] = await owner.db
      .insert(knowledgeSources)
      .values({ orgId: org.orgId, connectionId: org.connectionId, kind: "helpdesk_articles", name: "Help center" })
      .returning();
    await owner.db.insert(knowledgeArticles).values([
      {
        orgId: org.orgId,
        sourceId: s!.id,
        externalId: "1",
        title: "Fixing SAML assertion errors",
        url: "https://help.example/saml",
        bodyText: "Copy the Entity ID into the audience field of your identity provider.",
      },
      {
        orgId: org.orgId,
        sourceId: s!.id,
        externalId: "2",
        title: "Webhook retries",
        bodyText: "Deliveries are retried with backoff when your endpoint is slow.",
      },
    ]);
    if (org === a) sourceA = s!.id;
  }
});

describe("knowledge tables (T-47)", () => {
  it("are confined to the org by RLS", async () => {
    const rows = await app.withOrg(a.orgId, (tx) => tx.select().from(knowledgeArticles));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.orgId === a.orgId)).toBe(true);
    const sources = await app.withOrg(b.orgId, (tx) =>
      tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceA)),
    );
    expect(sources).toEqual([]);
    expect(await app.db.select().from(knowledgeArticles)).toEqual([]);
  });

  it("keeps a generated, weighted full-text vector for ranked search", async () => {
    const hits = await app.withOrg(a.orgId, (tx) =>
      tx
        .select({ title: knowledgeArticles.title })
        .from(knowledgeArticles)
        .where(sql`${knowledgeArticles.search} @@ to_tsquery('english', 'saml | login')`),
    );
    expect(hits.map((h) => h.title)).toEqual(["Fixing SAML assertion errors"]);
    // Edits recompute it.
    await app.withOrg(a.orgId, (tx) =>
      tx
        .update(knowledgeArticles)
        .set({ bodyText: "Login problems after SSO changes." })
        .where(eq(knowledgeArticles.externalId, "2")),
    );
    const again = await app.withOrg(a.orgId, (tx) =>
      tx
        .select({ id: knowledgeArticles.externalId })
        .from(knowledgeArticles)
        .where(sql`${knowledgeArticles.search} @@ to_tsquery('english', 'login')`),
    );
    expect(again.map((r) => r.id)).toEqual(["2"]);
  });

  it("the system role sees only the scheduling columns of sources, and no articles", async () => {
    const due = await system.db.execute<{ id: string }>(
      sql`select id, org_id, kind, last_sync_at from knowledge_sources where id = ${sourceA}`,
    );
    expect(due).toHaveLength(1);
    expect(await failure(system.client`select name from knowledge_sources`)).toMatch(/permission denied/);
    expect(await failure(system.client`select body_text from knowledge_articles`)).toMatch(/permission denied/);
  });
});
