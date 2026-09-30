/**
 * Demo help desk: a simulated, deterministic B2B SaaS support queue so slai runs
 * end to end without a vendor account (local dev and the product demo).
 *
 * - Deterministic from `config.seed`; `config.ticketsPerDay` sets volume.
 * - 120 days of history relative to "now", plus live tickets that appear and
 *   progress as time passes (see generate.ts).
 * - Writes mutate an in-memory store keyed by connection (`config.connectionId`,
 *   else the seed). It resets on process restart, which is fine for a demo.
 * - No webhooks: the worker polls.
 * - Still a pure adapter: no env, no persistence, no network. Time is
 *   injectable via `config.now` (Date | ISO string | epoch ms | () => Date).
 */
import type { Priority, TicketStatus } from "@slai/sla-engine";
import { z } from "zod";
import { finalizeEvents } from "../../lib/events.js";
import { decodeCursor, encodeCursor } from "../../lib/paginate.js";
import { plainText } from "../../lib/text.js";
import {
  type CanonicalComment,
  type CanonicalEvent,
  type CanonicalTicket,
  type ConnectorClient,
  type ConnectorContext,
  type ConnectorDefinition,
  ConnectorError,
  type FieldMapping,
  type TicketWithHistory,
} from "../../types.js";
import { AGENTS } from "./content.js";
import {
  DAY_MS,
  type GeneratedTicket,
  generateDay,
  parseTicketId,
  type TimelineItem,
  ticketCountForDay,
} from "./generate.js";

export const DEMO_HISTORY_DAYS = 120;
const PAGE_SIZE = 100;

export const demoConfigSchema = z.object({
  seed: z.string().min(1).default("acme"),
  ticketsPerDay: z.number().int().min(0).max(999).default(40),
  historyDays: z.number().int().min(1).max(365).default(DEMO_HISTORY_DAYS),
  connectionId: z.string().optional(),
});

const credentialsSchema = z.object({}).strict();
type DemoCredentials = z.infer<typeof credentialsSchema>;

const defaultMapping: FieldMapping = {
  status: { new: "new", open: "open", pending: "pending", on_hold: "on_hold", solved: "solved", closed: "closed" },
  priority: { urgent: "urgent", high: "high", normal: "normal", low: "low" },
};

interface Keyed {
  item: TimelineItem;
  /** Stable idempotency key: scripted items by timeline index, written items by write id. */
  key: string;
}

interface ConnectionStore {
  items: Map<string, Keyed[]>;
  seq: number;
}

/** In-memory write store, keyed by connection. Process-local by design. */
const STORES = new Map<string, ConnectionStore>();

export function resetDemoStore(key?: string): void {
  if (key === undefined) STORES.clear();
  else STORES.delete(key);
}

function storeFor(key: string): ConnectionStore {
  let s = STORES.get(key);
  if (!s) {
    s = { items: new Map(), seq: 0 };
    STORES.set(key, s);
  }
  return s;
}

function clockFrom(v: unknown): () => number {
  if (typeof v === "function") return () => (v as () => Date | number)().valueOf();
  if (v instanceof Date) return () => v.getTime();
  if (typeof v === "number") return () => v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new ConnectorError(`demo: bad config.now ${v}`, "invalid");
    return () => t;
  }
  return () => Date.now();
}

interface Replayed {
  status: TicketStatus;
  priority: Priority | null;
  assignee: string | null;
  tags: string[];
  updatedAt: number;
}

function replay(items: TimelineItem[]): Replayed {
  const r: Replayed = { status: "new", priority: null, assignee: null, tags: [], updatedAt: 0 };
  for (const it of items) {
    r.updatedAt = Math.max(r.updatedAt, it.at);
    if (it.kind === "created") {
      r.status = it.status;
      r.priority = it.priority;
    } else if (it.kind === "status") r.status = it.status;
    else if (it.kind === "priority") r.priority = it.priority;
    else if (it.kind === "assign") r.assignee = it.agentId;
    else if (it.kind === "tags") r.tags = it.tags;
  }
  return r;
}

export const demo: ConnectorDefinition<DemoCredentials> = {
  provider: "demo",
  displayName: "Demo help desk",
  authKind: "api_token",
  credentialsSchema,
  credentialFields: [],
  supportsWebhooks: false,
  write: { internalNote: true, publicReply: true, assign: true, priority: true, tags: true },
  defaultMapping,
  docsUrl: "https://github.com/slai/slai/tree/main/packages/connectors/src/connectors/demo",
  create(ctx: ConnectorContext<DemoCredentials>): ConnectorClient {
    const parsed = demoConfigSchema.safeParse(ctx.config ?? {});
    if (!parsed.success) throw new ConnectorError(`demo: invalid config: ${parsed.error.message}`, "invalid");
    const cfg = parsed.data;
    const now = clockFrom((ctx.config as { now?: unknown })?.now);
    const store = storeFor(cfg.connectionId ?? `seed:${cfg.seed}`);
    const dayCache = new Map<number, GeneratedTicket[]>();

    const day = (d: number) => {
      let ts = dayCache.get(d);
      if (!ts) {
        ts = generateDay(cfg.seed, d, cfg.ticketsPerDay);
        dayCache.set(d, ts);
      }
      return ts;
    };

    const windowStart = (asOf: number) => Math.floor(asOf / DAY_MS) - cfg.historyDays;

    const find = (sourceId: string, asOf: number): GeneratedTicket => {
      const p = parseTicketId(sourceId);
      if (
        !p ||
        p.day < windowStart(asOf) ||
        p.n >= ticketCountForDay(cfg.seed, p.day, cfg.ticketsPerDay) ||
        p.day > Math.floor(asOf / DAY_MS)
      ) {
        throw new ConnectorError(`demo ticket ${sourceId} not found`, "not_found");
      }
      const t = day(p.day)[p.n];
      if (!t || t.createdAt > asOf) throw new ConnectorError(`demo ticket ${sourceId} not found`, "not_found");
      return t;
    };

    /** The ticket's visible timeline at `asOf`: scripted events so far plus written ones. */
    const visible = (t: GeneratedTicket, asOf: number): Keyed[] => {
      const scripted = t.timeline.map((item, i) => ({ item, key: `demo:${cfg.seed}:${t.sourceId}:${i}` }));
      const extra = store.items.get(t.sourceId) ?? [];
      return [...scripted, ...extra].filter((k) => k.item.at <= asOf).sort((a, b) => a.item.at - b.item.at);
    };

    const snapshot = (t: GeneratedTicket, items: Keyed[]): CanonicalTicket => {
      const r = replay(items.map((k) => k.item));
      const agent = AGENTS.find((a) => a.id === r.assignee);
      return {
        ref: { sourceId: t.sourceId, displayKey: `#${t.sourceId}`, url: null },
        subject: t.subject,
        status: r.status,
        rawStatus: r.status,
        priority: r.priority,
        rawPriority: r.priority,
        requester: {
          sourceId: t.requester.id,
          email: t.requester.email,
          name: t.requester.name,
          orgSourceId: t.org.id,
          orgName: t.org.name,
        },
        assignee: r.assignee ? { sourceId: r.assignee, name: agent?.name ?? null } : null,
        groupSourceId: null,
        tags: r.tags,
        channel: t.channel,
        createdAt: new Date(t.createdAt),
        updatedAt: new Date(r.updatedAt),
        mappingIssues: [],
      };
    };

    const history = (t: GeneratedTicket, items: Keyed[]): TicketWithHistory => {
      const events: CanonicalEvent[] = [];
      const comments: CanonicalComment[] = [];
      for (const { item: it, key: k } of items) {
        const at = new Date(it.at);
        switch (it.kind) {
          case "created":
            events.push({ type: "created", at, priority: it.priority, status: it.status, idempotencyKey: k });
            break;
          case "status":
            events.push({ type: "status_changed", at, status: it.status, rawStatus: it.status, idempotencyKey: k });
            break;
          case "priority":
            events.push({
              type: "priority_changed",
              at,
              priority: it.priority,
              rawPriority: it.priority,
              idempotencyKey: k,
            });
            break;
          case "assign":
            events.push({ type: "assignee_changed", at, assigneeSourceId: it.agentId, idempotencyKey: k });
            break;
          case "tags":
            events.push({ type: "tags_changed", at, tags: it.tags, idempotencyKey: k });
            break;
          case "comment":
            events.push({
              type: "comment",
              at,
              author: it.role,
              public: it.public,
              commentSourceId: it.id,
              idempotencyKey: k,
            });
            comments.push({
              sourceId: it.id,
              at,
              authorRole: it.role,
              authorName: it.authorName,
              authorSourceId: it.authorId,
              public: it.public,
              bodyText: plainText(it.body),
            });
            break;
        }
      }
      return { ticket: snapshot(t, items), events: finalizeEvents(events), comments };
    };

    const write = (sourceId: string, make: (at: number, id: string) => TimelineItem[]): string => {
      const at = now();
      const t = find(sourceId, at);
      const id = `${t.sourceId}-w${++store.seq}`;
      const list = store.items.get(t.sourceId) ?? [];
      make(at, id).forEach((item, j) => {
        list.push({ item, key: `demo:${cfg.seed}:${id}:${j}` });
      });
      store.items.set(t.sourceId, list);
      return id;
    };

    const comment = (sourceId: string, body: string, pub: boolean) => {
      const agent = AGENTS[0]!;
      const id = write(sourceId, (at, cid) => [
        {
          at,
          kind: "comment",
          id: cid,
          role: "agent",
          public: pub,
          authorId: agent.id,
          authorName: "slai",
          body,
        },
      ]);
      return { commentSourceId: id };
    };

    return {
      async testConnection() {
        return { accountName: `Demo help desk (${cfg.seed})`, accountId: `demo:${cfg.seed}` };
      },

      async listUpdatedTickets(since, cursor) {
        const isState = (v: unknown): v is { asOf: number; offset: number } =>
          typeof (v as { asOf?: unknown })?.asOf === "number" &&
          typeof (v as { offset?: unknown })?.offset === "number";
        const state = decodeCursor(cursor, isState) ?? { asOf: now(), offset: 0 };
        const { asOf } = state;
        const first = windowStart(asOf);
        const last = Math.floor(asOf / DAY_MS);
        const matches: CanonicalTicket[] = [];
        for (let d = first; d <= last; d++) {
          for (const t of day(d)) {
            if (t.createdAt > asOf) continue;
            const snap = snapshot(t, visible(t, asOf));
            if (snap.updatedAt.getTime() >= since.getTime()) matches.push(snap);
          }
        }
        matches.sort(
          (a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.ref.sourceId.localeCompare(b.ref.sourceId),
        );
        const items = matches.slice(state.offset, state.offset + PAGE_SIZE);
        const nextOffset = state.offset + items.length;
        return {
          items,
          nextCursor: nextOffset < matches.length ? encodeCursor({ asOf, offset: nextOffset }) : null,
        };
      },

      async getTicketWithHistory(sourceId) {
        const asOf = now();
        const t = find(sourceId, asOf);
        return history(t, visible(t, asOf));
      },

      async handleWebhook() {
        return { ok: false, reason: "unsupported" };
      },

      async postInternalNote(sourceId, body) {
        return comment(sourceId, body, false);
      },

      async postPublicReply(sourceId, body) {
        return comment(sourceId, body, true);
      },

      async updateTicket(sourceId, patch) {
        const asOf = now();
        const t = find(sourceId, asOf);
        const current = snapshot(t, visible(t, asOf));
        write(sourceId, (at) => {
          const out: TimelineItem[] = [];
          if (patch.priority !== undefined) out.push({ at, kind: "priority", priority: patch.priority });
          if (patch.assigneeSourceId !== undefined) out.push({ at, kind: "assign", agentId: patch.assigneeSourceId });
          if (patch.addTags?.length) {
            out.push({ at, kind: "tags", tags: [...new Set([...current.tags, ...patch.addTags])] });
          }
          return out;
        });
      },
    };
  },
};
