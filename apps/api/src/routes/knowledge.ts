/**
 * Knowledge sources, articles and saved replies (T-47). Everyone in the org
 * can read them; only admins change them, and every change is audited.
 */
import { audit, connections, knowledgeArticles, knowledgeSources, type Tx } from "@slai/db";
import {
  createKnowledgeSourceBody,
  type KnowledgeArticle,
  type KnowledgeSource,
  knowledgeArticleQuery,
  savedReplyBody,
  updateKnowledgeArticleBody,
  updateSavedReplyBody,
} from "@slai/shared";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AnyConnector, type AppDeps, type AppEnv, auditBase, auth, type Ctx } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { requireRole } from "../middleware/auth.js";
import { decodeCursor, encodeCursor } from "../pagination.js";
import { userFacingError } from "../user-errors.js";
import { body, idParam, query } from "../validate.js";

type SourceRow = typeof knowledgeSources.$inferSelect;
type ArticleRow = typeof knowledgeArticles.$inferSelect;

/** The name of the manual source that holds saved replies written in slai. */
export const SAVED_REPLIES_SOURCE = "Saved replies";

const toSource = (s: SourceRow, counts: { total: number; enabled: number }): KnowledgeSource => ({
  id: s.id,
  connectionId: s.connectionId,
  kind: s.kind,
  name: s.name,
  status: s.status,
  lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
  lastError: userFacingError("knowledge_source", s.lastError),
  articleCount: counts.total,
  enabledCount: counts.enabled,
  createdAt: s.createdAt.toISOString(),
});

const toArticle = (a: ArticleRow, s: Pick<SourceRow, "kind" | "name">): KnowledgeArticle => ({
  id: a.id,
  sourceId: a.sourceId,
  sourceKind: s.kind,
  sourceName: s.name,
  externalId: a.externalId,
  title: a.title,
  url: a.url,
  bodyText: a.bodyText,
  locale: a.locale,
  enabled: a.enabled,
  updatedAt: (a.updatedAtSource ?? a.updatedAt).toISOString(),
});

/** `%` and `_` are literal in a search box. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const offsetCursor = z.object({ o: z.number().int().min(0) });

/** What a help desk calls each synced kind, for messages and default source names. */
const SYNCED = {
  helpdesk_articles: { what: "help-center articles", suffix: "help center" },
  saved_replies: { what: "saved replies", suffix: "saved replies" },
} as const;
type SyncedKind = keyof typeof SYNCED;

/** Whether the help desk's connector can sync this kind of source. */
const supports = (def: AnyConnector | null, kind: SyncedKind) =>
  kind === "saved_replies" ? def?.supportsSavedReplies === true : def?.supportsKnowledge === true;

/**
 * A new connection gets a source for its help center and one for its saved
 * replies (when the help desk has them), synced right away (in the caller's
 * transaction, so both commit together).
 */
export async function addKnowledgeSource(
  tx: Tx,
  c: Ctx,
  deps: Pick<AppDeps, "jobs">,
  conn: { connectionId: string; name: string; kind: SyncedKind },
): Promise<void> {
  const a = auth(c);
  const [row] = await tx
    .insert(knowledgeSources)
    .values({
      orgId: a.orgId,
      connectionId: conn.connectionId,
      kind: conn.kind,
      name: `${conn.name} ${SYNCED[conn.kind].suffix}`.slice(0, 120),
      createdBy: a.user.id,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return;
  await audit(tx, {
    ...auditBase(c),
    orgId: a.orgId,
    action: "knowledge_source.created",
    target: { type: "knowledge_source", id: row.id },
    metadata: { kind: row.kind, name: row.name, connectionId: conn.connectionId },
  });
  await deps.jobs.send(tx, "sync-knowledge", { orgId: a.orgId, sourceId: row.id });
}

export function knowledgeRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  const counted = (tx: Tx) =>
    tx
      .select({
        s: knowledgeSources,
        // Qualified by hand: drizzle leaves single-table column names unqualified, and "id" would bind to ka.
        total: sql<number>`(select count(*)::int from knowledge_articles ka where ka.source_id = knowledge_sources.id)`,
        enabled: sql<number>`(select count(*)::int from knowledge_articles ka where ka.source_id = knowledge_sources.id and ka.enabled)`,
      })
      .from(knowledgeSources);

  const loadSource = async (tx: Tx, id: string) => {
    const [row] = await counted(tx).where(eq(knowledgeSources.id, id));
    if (!row) throw notFound("Knowledge source");
    return row;
  };

  const loadArticle = async (tx: Tx, id: string) => {
    const [row] = await tx
      .select({ a: knowledgeArticles, s: knowledgeSources })
      .from(knowledgeArticles)
      .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeArticles.sourceId))
      .where(eq(knowledgeArticles.id, id));
    if (!row) throw notFound("Article");
    return row;
  };

  const loadSavedReply = async (tx: Tx, id: string) => {
    const row = await loadArticle(tx, id);
    if (row.s.kind !== "manual") throw notFound("Saved reply");
    return row;
  };

  app.get("/knowledge-sources", async (c) => {
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      counted(tx).orderBy(asc(knowledgeSources.kind), asc(knowledgeSources.name), asc(knowledgeSources.id)),
    );
    return c.json({ items: rows.map((r) => toSource(r.s, r)), nextCursor: null });
  });

  app.post("/knowledge-sources", requireRole("admin"), async (c) => {
    const a = auth(c);
    const input = await body(c, createKnowledgeSourceBody);
    const dto = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      let provider: string | null = null;
      if (input.kind !== "manual") {
        const { what } = SYNCED[input.kind];
        if (!input.connectionId) throw badRequest(`Choose the help desk connection to take ${what} from.`);
        const [conn] = await tx
          .select({ id: connections.id, provider: connections.provider })
          .from(connections)
          .where(eq(connections.id, input.connectionId));
        if (!conn) throw badRequest("Connection not found.");
        const def = deps.connectors.get(conn.provider);
        if (!supports(def, input.kind))
          throw badRequest(`${def?.displayName ?? conn.provider} does not provide ${what} to slai yet.`);
        provider = conn.provider;
      } else if (input.connectionId) {
        throw badRequest("Saved replies written in slai have no connection.");
      }
      const [row] = await tx
        .insert(knowledgeSources)
        .values({
          orgId: a.orgId,
          connectionId: input.connectionId,
          kind: input.kind,
          name: input.name,
          createdBy: a.user.id,
        })
        .onConflictDoNothing()
        .returning();
      if (!row)
        throw conflict(
          input.kind === "saved_replies"
            ? "This connection already has a saved-replies source."
            : "This connection already has an article source.",
        );
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "knowledge_source.created",
        target: { type: "knowledge_source", id: row.id },
        metadata: { kind: row.kind, name: row.name, connectionId: row.connectionId, provider },
      });
      if (row.kind !== "manual") await deps.jobs.send(tx, "sync-knowledge", { orgId: a.orgId, sourceId: row.id });
      return toSource(row, { total: 0, enabled: 0 });
    });
    return c.json(dto, 201);
  });

  app.post("/knowledge-sources/:id/sync", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Knowledge source");
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const { s } = await loadSource(tx, id);
      if (s.kind === "manual") throw badRequest("Saved replies written in slai have nothing to sync.");
      await deps.jobs.send(tx, "sync-knowledge", { orgId: a.orgId, sourceId: id });
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "knowledge_source.sync_requested",
        target: { type: "knowledge_source", id },
      });
    });
    return c.json({ queued: true }, 202);
  });

  app.get("/knowledge-articles", async (c) => {
    const p = query(c, knowledgeArticleQuery);
    const offset = decodeCursor(p.cursor, offsetCursor)?.o ?? 0;
    const q = p.q ? p.q : null;
    const tsq = q ? sql`websearch_to_tsquery('english'::regconfig, ${q})` : null;
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      tx
        .select({ a: knowledgeArticles, kind: knowledgeSources.kind, name: knowledgeSources.name })
        .from(knowledgeArticles)
        .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeArticles.sourceId))
        .where(
          and(
            p.sourceId ? eq(knowledgeArticles.sourceId, p.sourceId) : undefined,
            q && tsq
              ? or(sql`${knowledgeArticles.search} @@ ${tsq}`, ilike(knowledgeArticles.title, likePattern(q)))
              : undefined,
          ),
        )
        .orderBy(
          ...(tsq ? [sql`ts_rank(${knowledgeArticles.search}, ${tsq}, 1) desc`] : []),
          asc(knowledgeArticles.title),
          asc(knowledgeArticles.id),
        )
        .limit(p.limit + 1)
        .offset(offset),
    );
    const more = rows.length > p.limit;
    return c.json({
      items: rows.slice(0, p.limit).map((r) => toArticle(r.a, r)),
      nextCursor: more ? encodeCursor({ o: offset + p.limit }) : null,
    });
  });

  app.patch("/knowledge-articles/:id", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Article");
    const input = await body(c, updateKnowledgeArticleBody);
    const dto = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const { s } = await loadArticle(tx, id);
      const [row] = await tx
        .update(knowledgeArticles)
        .set({ enabled: input.enabled })
        .where(eq(knowledgeArticles.id, id))
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: input.enabled ? "knowledge_article.enabled" : "knowledge_article.disabled",
        target: { type: "knowledge_article", id },
        metadata: { sourceId: s.id, title: row!.title },
      });
      return toArticle(row!, s);
    });
    return c.json(dto);
  });

  app.post("/saved-replies", requireRole("admin"), async (c) => {
    const a = auth(c);
    const input = await body(c, savedReplyBody);
    const dto = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      let [source] = await tx
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.kind, "manual"))
        .orderBy(asc(knowledgeSources.id))
        .limit(1);
      if (!source) {
        [source] = await tx
          .insert(knowledgeSources)
          .values({ orgId: a.orgId, kind: "manual", name: SAVED_REPLIES_SOURCE, createdBy: a.user.id })
          .returning();
        await audit(tx, {
          ...auditBase(c),
          orgId: a.orgId,
          action: "knowledge_source.created",
          target: { type: "knowledge_source", id: source!.id },
          metadata: { kind: "manual", name: SAVED_REPLIES_SOURCE },
        });
      }
      const [row] = await tx
        .insert(knowledgeArticles)
        .values({ orgId: a.orgId, sourceId: source!.id, title: input.title, bodyText: input.bodyText, url: input.url })
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "saved_reply.created",
        target: { type: "knowledge_article", id: row!.id },
        metadata: { sourceId: source!.id, title: row!.title },
      });
      return toArticle(row!, source!);
    });
    return c.json(dto, 201);
  });

  app.patch("/saved-replies/:id", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Saved reply");
    const input = await body(c, updateSavedReplyBody);
    const dto = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const { s } = await loadSavedReply(tx, id);
      const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      const [row] = Object.keys(patch).length
        ? await tx.update(knowledgeArticles).set(patch).where(eq(knowledgeArticles.id, id)).returning()
        : await tx.select().from(knowledgeArticles).where(eq(knowledgeArticles.id, id));
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "saved_reply.updated",
        target: { type: "knowledge_article", id },
        metadata: { fields: Object.keys(patch), title: row!.title },
      });
      return toArticle(row!, s);
    });
    return c.json(dto);
  });

  app.delete("/saved-replies/:id", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Saved reply");
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const { a: article, s } = await loadSavedReply(tx, id);
      await tx.delete(knowledgeArticles).where(eq(knowledgeArticles.id, id));
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "saved_reply.deleted",
        target: { type: "knowledge_article", id },
        metadata: { sourceId: s.id, title: article.title },
      });
    });
    return c.body(null, 204);
  });

  return app;
}
