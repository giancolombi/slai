/**
 * Knowledge sources (T-47): syncing a help desk's articles into
 * `knowledge_articles`, and retrieving the few that fit a ticket so drafts
 * have facts to rely on (TicketContext.knowledge).
 */
import { ConnectorError } from "@slai/connectors";
import { knowledgeArticles, knowledgeSources, type Tx } from "@slai/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { clientFor, loadConnection, markConnectionError } from "./connection.js";
import type { ResourceLoader, WorkerDeps } from "./deps.js";
import { errorMessage } from "./logger.js";

const MAX_PAGES = 200;
/** Longest article body we store; connectors already bound bodies, this is a backstop. */
const STORED_BODY_CHARS = 20_000;
/** Articles passed to a draft, and the most of each body it sees. */
export const KNOWLEDGE_LIMIT = 4;
export const KNOWLEDGE_BODY_CHARS = 2500;
/** The query uses at most this many distinct terms from the subject and the customer's last message. */
const MAX_TERMS = 40;

type SourceRow = typeof knowledgeSources.$inferSelect;

async function setSource(deps: WorkerDeps, orgId: string, id: string, patch: Partial<SourceRow>) {
  await deps.orgDb.withOrg(orgId, (tx) => tx.update(knowledgeSources).set(patch).where(eq(knowledgeSources.id, id)));
}

/**
 * The `sync-knowledge` job: pages through a source's articles on its help
 * desk and upserts them (keeping each article's enabled flag), then removes
 * the ones the help desk no longer publishes. Manual sources have nothing to
 * fetch. A rate limit is retried by the job runner; other failures are
 * recorded on the source and retried at the next scheduled sync.
 */
export async function syncKnowledge(deps: WorkerDeps, p: { orgId: string; sourceId: string }): Promise<void> {
  const { orgId, sourceId } = p;
  const loaded = await deps.orgDb.withOrg(orgId, async (tx) => {
    const [source] = await tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId));
    if (!source) return null;
    const conn = source.connectionId ? await loadConnection(tx, source.connectionId) : null;
    return { source, conn };
  });
  if (!loaded || loaded.source.kind === "manual") return;
  const { source, conn } = loaded;
  const now = deps.clock.now();
  if (!conn) {
    await setSource(deps, orgId, sourceId, { status: "error", lastError: "The connection no longer exists." });
    return;
  }
  if (conn.status === "paused") return;
  const client = clientFor(deps, conn);
  const def = deps.connectors.get(conn.provider);
  // Help-center articles and saved replies sync the same way; only the call differs.
  const list =
    source.kind === "saved_replies"
      ? def?.supportsSavedReplies && client.listSavedReplies?.bind(client)
      : def?.supportsKnowledge && client.listKnowledgeArticles?.bind(client);
  if (!list) {
    await setSource(deps, orgId, sourceId, {
      status: "error",
      lastError: `${def?.displayName ?? conn.provider} does not provide ${source.kind === "saved_replies" ? "saved replies" : "help-center articles"} to slai yet.`,
    });
    return;
  }

  await setSource(deps, orgId, sourceId, { status: "syncing" });
  const seen: string[] = [];
  try {
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new ConnectorError(`more than ${MAX_PAGES} pages of articles`, "upstream");
      const res = await list(cursor);
      const rows = res.items.map((a) => ({
        orgId,
        sourceId,
        externalId: a.sourceId,
        title: a.title.slice(0, 500),
        url: a.url,
        bodyText: a.bodyText.slice(0, STORED_BODY_CHARS),
        locale: a.locale,
        updatedAtSource: a.updatedAt,
      }));
      if (rows.length) {
        await deps.orgDb.withOrg(orgId, (tx) =>
          tx
            .insert(knowledgeArticles)
            .values(rows)
            .onConflictDoUpdate({
              target: [knowledgeArticles.sourceId, knowledgeArticles.externalId],
              set: {
                title: sql`excluded.title`,
                url: sql`excluded.url`,
                bodyText: sql`excluded.body_text`,
                locale: sql`excluded.locale`,
                updatedAtSource: sql`excluded.updated_at_source`,
                updatedAt: now,
              },
            }),
        );
        seen.push(...rows.map((r) => r.externalId));
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
  } catch (e) {
    if (e instanceof ConnectorError && e.kind === "rate_limited") throw e;
    const message = errorMessage(e).slice(0, 1000);
    deps.logger.warn({ orgId, sourceId, err: message }, "knowledge sync failed");
    if (e instanceof ConnectorError && e.kind === "auth") await markConnectionError(deps, orgId, conn.id, e);
    await setSource(deps, orgId, sourceId, { status: "error", lastError: message });
    return;
  }
  const removed = await deps.orgDb.withOrg(orgId, async (tx) => {
    const gone = await tx
      .delete(knowledgeArticles)
      .where(
        and(
          eq(knowledgeArticles.sourceId, sourceId),
          sql`${knowledgeArticles.externalId} <> all(${sql.param(seen)}::text[])`,
        ),
      )
      .returning({ id: knowledgeArticles.id });
    await tx
      .update(knowledgeSources)
      .set({ status: "idle", lastSyncAt: now, lastError: null })
      .where(eq(knowledgeSources.id, sourceId));
    return gone.length;
  });
  deps.logger.info({ orgId, sourceId, articles: seen.length, removed }, "knowledge sync done");
}

/** Distinct search terms (letters and digits) from the ticket, safe to join into a tsquery. */
export function searchTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    if (terms.size >= MAX_TERMS) break;
    terms.add(w);
  }
  return [...terms];
}

export interface RetrievedArticle {
  id: string;
  title: string;
  url: string | null;
  body: string;
}

/**
 * The enabled articles and saved replies that best match the ticket's subject
 * and the customer's last message (Postgres full-text search, any term, ranked
 * by ts_rank), each body cut to a bounded length. Runs under the caller's RLS.
 */
export async function retrieveKnowledge(
  tx: Tx,
  query: { subject: string; lastRequesterMessage: string | null },
  opts: { limit?: number; bodyChars?: number } = {},
): Promise<RetrievedArticle[]> {
  const terms = searchTerms(`${query.subject} ${query.lastRequesterMessage ?? ""}`);
  if (!terms.length) return [];
  const limit = opts.limit ?? KNOWLEDGE_LIMIT;
  const max = opts.bodyChars ?? KNOWLEDGE_BODY_CHARS;
  const q = sql`to_tsquery('english'::regconfig, ${terms.join(" | ")})`;
  const rank = sql`ts_rank(${knowledgeArticles.search}, ${q}, 1)`;
  const rows = await tx
    .select({
      id: knowledgeArticles.id,
      title: knowledgeArticles.title,
      url: knowledgeArticles.url,
      body: sql<string>`left(${knowledgeArticles.bodyText}, ${max + 1})`,
    })
    .from(knowledgeArticles)
    .where(and(eq(knowledgeArticles.enabled, true), sql`${knowledgeArticles.search} @@ ${q}`))
    .orderBy(sql`${rank} desc`, asc(knowledgeArticles.id))
    .limit(limit);
  return rows.map((r) => ({ ...r, body: r.body.length > max ? `${r.body.slice(0, max - 1).trimEnd()}…` : r.body }));
}

/** The production resource loader: retrieved knowledge (with article ids); no assignee directory yet. */
export function knowledgeResources(deps: Pick<WorkerDeps, "orgDb">): ResourceLoader {
  return async (orgId, ticket) => {
    const found = await deps.orgDb.withOrg(orgId, (tx) =>
      retrieveKnowledge(tx, { subject: ticket.subject, lastRequesterMessage: ticket.lastRequesterMessage ?? null }),
    );
    return {
      knowledge: found.map((a) => ({ title: a.title, url: a.url, body: a.body })),
      knowledgeIds: found.map((a) => a.id),
      assignees: [],
    };
  };
}

/**
 * Enqueues the daily sync for every help-desk knowledge source that is due
 * (never synced, or last synced more than `knowledgeSyncIntervalMs` ago).
 * Cross-org on systemDb, which sees only the scheduling columns.
 */
export async function scheduleKnowledgeSyncs(deps: WorkerDeps): Promise<number> {
  const now = deps.clock.now();
  const due = new Date(now.getTime() - deps.config.knowledgeSyncIntervalMs);
  const rows = await deps.systemDb.db.execute<{ id: string; org_id: string }>(sql`
    select id, org_id from knowledge_sources
    where kind <> 'manual' and (last_sync_at is null or last_sync_at <= ${due.toISOString()}::timestamptz)`);
  for (const r of rows) {
    await deps.queue.send(
      "sync-knowledge",
      { orgId: r.org_id, sourceId: r.id },
      // At most one enqueue per source per hour, even while a failing source stays due.
      { singletonKey: `knowledge:${r.id}`, singletonSeconds: 3600 },
    );
  }
  return rows.length;
}
