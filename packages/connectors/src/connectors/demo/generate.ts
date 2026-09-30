/**
 * Deterministic ticket generator for the demo help desk.
 *
 * Tickets live on an absolute UTC timeline: the tickets of UTC day D are a pure
 * function of (seed, D). Each ticket's full scripted history is generated up
 * front, and the client reveals only the events at or before "now". So the
 * same seed always yields the same tickets, tickets created today keep
 * progressing (replies, pending, solves) as the clock moves, and new tickets
 * appear through the day, all without any stored state.
 */
import type { AuthorRole, Priority, TicketStatus } from "@slai/sla-engine";
import {
  AGENTS,
  BOT,
  BOT_ACK,
  CATEGORIES,
  type Category,
  FIRST_NAMES,
  FIRST_REPLIES,
  LAST_NAMES,
  ORGS,
  PERIODIC_UPDATES,
  PRIORITY_ORDER,
  REOPEN_MESSAGES,
  THANKS,
} from "./content.js";

export const DAY_MS = 86_400_000;
const MIN = 60_000;

export type TimelineItem =
  | { at: number; kind: "created"; status: TicketStatus; priority: Priority | null }
  | { at: number; kind: "status"; status: TicketStatus }
  | { at: number; kind: "priority"; priority: Priority | null }
  | { at: number; kind: "assign"; agentId: string | null }
  | { at: number; kind: "tags"; tags: string[] }
  | {
      at: number;
      kind: "comment";
      id: string;
      role: AuthorRole;
      public: boolean;
      authorId: string;
      authorName: string;
      body: string;
    };

export interface GeneratedTicket {
  sourceId: string;
  subject: string;
  category: string;
  org: { id: string; name: string; domain: string };
  requester: { id: string; name: string; email: string };
  channel: string;
  tags: string[];
  createdAt: number;
  timeline: TimelineItem[];
}

/** FNV-1a 32-bit. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for demo data. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const chance = (p: number) => next() < p;
  const weighted = (ws: readonly number[]) => {
    const total = ws.reduce((a, b) => a + b, 0);
    let r = next() * total;
    for (let i = 0; i < ws.length; i++) {
      r -= ws[i] ?? 0;
      if (r < 0) return i;
    }
    return ws.length - 1;
  };
  return { next, int, pick, chance, weighted };
}

export type Rng = ReturnType<typeof rng>;

export const MAX_PER_DAY = 999;

export function ticketCountForDay(seed: string, day: number, ticketsPerDay: number): number {
  const r = rng(hash(`${seed}:count:${day}`));
  const weekday = new Date(day * DAY_MS).getUTCDay();
  const factor = weekday === 0 || weekday === 6 ? 0.35 : 1;
  return Math.min(MAX_PER_DAY, Math.max(0, Math.round(ticketsPerDay * factor * (0.8 + 0.4 * r.next()))));
}

export function ticketId(day: number, n: number): string {
  return String(day * 1000 + n);
}

export function parseTicketId(id: string): { day: number; n: number } | null {
  if (!/^\d{4,}$/.test(id)) return null;
  const v = Number(id);
  return { day: Math.floor(v / 1000), n: v % 1000 };
}

/** First-response delays in minutes: most land inside common targets, the slow ones well past them. */
const FR_GOOD: Record<string, [number, number]> = {
  urgent: [3, 25],
  high: [10, 55],
  normal: [20, 200],
  low: [30, 420],
  none: [20, 200],
};
const FR_SLOW: Record<string, [number, number]> = {
  urgent: [75, 300],
  high: [150, 720],
  normal: [540, 2400],
  low: [1500, 4000],
  none: [540, 2400],
};

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

function ascii(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .toLowerCase();
}

/** Business-weighted creation time within the day (most tickets in US/EU hours). */
function creationOffset(r: Rng): number {
  if (r.chance(0.75)) return r.int(8 * 60, 22 * 60) * MIN + r.int(0, 59_999);
  return r.int(0, 24 * 60 - 1) * MIN + r.int(0, 59_999);
}

export function generateTicket(seed: string, day: number, n: number): GeneratedTicket {
  const r = rng(hash(`${seed}:ticket:${day}:${n}`));
  const id = ticketId(day, n);
  const category: Category = CATEGORIES[r.weighted(CATEGORIES.map((c) => c.weight))]!;
  const org = r.pick(ORGS);
  const first = r.pick(FIRST_NAMES);
  const last = r.pick(LAST_NAMES);
  const requester = {
    id: `user-${hash(`${org.id}:${first}:${last}`).toString(36)}`,
    name: `${first} ${last}`,
    email: `${ascii(first)}.${ascii(last)}@${org.domain}`,
  };
  const priority = PRIORITY_ORDER[r.weighted(category.priorities)] ?? null;
  const channel = ["email", "web", "chat", "api"][r.weighted([55, 30, 10, 5])]!;
  const tags = [category.key, org.plan];
  const created = day * DAY_MS + creationOffset(r);
  const agent = r.pick(AGENTS);
  const vars = { first, key: `#${id}` };

  const tl: TimelineItem[] = [];
  let seq = 0;
  const comment = (at: number, role: AuthorRole, pub: boolean, body: string) => {
    const author = role === "requester" ? requester : role === "bot" ? BOT : agent;
    tl.push({
      at,
      kind: "comment",
      id: `${id}-c${++seq}`,
      role,
      public: pub,
      authorId: author.id,
      authorName: author.name,
      body: fill(body, vars),
    });
  };
  const status = (at: number, s: TicketStatus) => tl.push({ at, kind: "status", status: s });
  const minutes = ([lo, hi]: [number, number]) => r.int(lo, hi) * MIN;

  tl.push({ at: created, kind: "created", status: "new", priority });
  tl.push({ at: created, kind: "tags", tags });
  comment(created, "requester", true, r.pick(category.bodies));
  if (channel === "email" && r.chance(0.7)) comment(created + MIN, "bot", true, BOT_ACK);

  const pkey = priority ?? "none";
  const slow = r.chance(0.18);
  const fr = created + minutes(slow ? FR_SLOW[pkey]! : FR_GOOD[pkey]!);
  tl.push({ at: created + Math.max(MIN, Math.floor((fr - created) * 0.4)), kind: "assign", agentId: agent.id });
  if (r.chance(0.12) && (priority === "normal" || priority === "low" || priority === null)) {
    tl.push({ at: created + Math.floor((fr - created) * 0.3), kind: "priority", priority: "high" });
  }
  if (r.chance(0.3)) comment(created + Math.floor((fr - created) * 0.7), "agent", false, r.pick(category.notes));

  let t = fr;
  const solve = (at: number) => {
    status(at, "solved");
    status(at + 4 * DAY_MS, "closed");
  };
  const scenario = r.next();
  if (scenario < 0.35) {
    // Answered and solved in one go.
    comment(t, "agent", true, r.pick(category.resolutions));
    status(t, "open");
    if (r.chance(0.5)) comment(t + minutes([20, 240]), "requester", true, r.pick(THANKS));
    solve(t + minutes([30, 600]));
  } else if (scenario < 0.65) {
    // Needs info from the customer: pending, customer replies, next response.
    comment(t, "agent", true, r.pick(category.asks));
    status(t, "pending");
    t += minutes([60, 2880]);
    comment(t, "requester", true, r.pick(category.followUps));
    status(t, "open");
    t += minutes(r.chance(0.15) ? [600, 3000] : [20, 420]);
    comment(t, "agent", true, r.pick(category.resolutions));
    if (r.chance(0.4)) comment(t + minutes([30, 600]), "requester", true, r.pick(THANKS));
    solve(t + minutes([60, 1440]));
  } else if (scenario < 0.77) {
    // Escalated to engineering: on hold with periodic updates.
    comment(t, "agent", true, fill(r.pick(FIRST_REPLIES), vars));
    status(t, "open");
    t += minutes([10, 60]);
    comment(t, "agent", false, r.pick(category.notes));
    status(t, "on_hold");
    const updates = r.int(1, 2);
    for (let i = 0; i < updates; i++) {
      t += minutes([600, 1600]);
      comment(t, "agent", true, r.pick(PERIODIC_UPDATES));
    }
    t += minutes([120, 2400]);
    status(t, "open");
    comment(t + minutes([5, 60]), "agent", true, r.pick(category.resolutions));
    solve(t + minutes([10, 120]));
  } else if (scenario < 0.87) {
    // Solved, then the customer reopens.
    comment(t, "agent", true, r.pick(category.resolutions));
    status(t, "open");
    t += minutes([30, 600]);
    status(t, "solved");
    t += minutes([1440, 4320]);
    comment(t, "requester", true, r.pick(REOPEN_MESSAGES));
    status(t, "open");
    t += minutes(r.chance(0.3) ? [600, 2400] : [30, 480]);
    comment(t, "agent", true, fill(r.pick(FIRST_REPLIES), vars));
    solve(t + minutes([60, 1440]));
  } else {
    // Long-running: slow back-and-forth; some never get solved.
    comment(t, "agent", true, fill(r.pick(FIRST_REPLIES), vars));
    status(t, "open");
    const rounds = r.int(2, 4);
    for (let i = 0; i < rounds; i++) {
      t += minutes([720, 4320]);
      comment(t, "requester", true, r.pick(category.followUps));
      t += minutes([240, 2880]);
      comment(t, "agent", true, r.pick(PERIODIC_UPDATES));
    }
    if (r.chance(0.7)) {
      t += minutes([1440, 7200]);
      comment(t, "agent", true, r.pick(category.resolutions));
      solve(t + minutes([60, 600]));
    }
  }

  tl.sort((a, b) => a.at - b.at);
  return {
    sourceId: id,
    subject: r.pick(category.subjects),
    category: category.key,
    org: { id: org.id, name: org.name, domain: org.domain },
    requester,
    channel,
    tags,
    createdAt: created,
    timeline: tl,
  };
}

export function generateDay(seed: string, day: number, ticketsPerDay: number): GeneratedTicket[] {
  const count = ticketCountForDay(seed, day, ticketsPerDay);
  const out: GeneratedTicket[] = [];
  for (let n = 0; n < count; n++) out.push(generateTicket(seed, day, n));
  return out;
}
