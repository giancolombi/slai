/**
 * The autopilot gate. Pure and deterministic: it decides whether a draft may
 * be sent without a human. Any doubt means "don't send"; the draft then goes
 * to a human as usual.
 */
import type { DraftReplyResult, TicketContext, TriageResult } from "./types.js";

export interface AutopilotOptions {
  /** 0..1. Drafts below this confidence are never auto-sent. */
  minConfidence: number;
  /** Triage for the same ticket. Missing triage means no auto-send. */
  triage: TriageResult | null;
  /** The ticket the draft answers; URLs and emails in the draft must come from it. */
  ctx: Pick<TicketContext, "thread" | "knowledge">;
  /** Longest body we auto-send. Default 4000 characters. */
  maxBodyChars?: number;
}

export interface AutopilotDecision {
  send: boolean;
  reason: string;
}

export const DEFAULT_MAX_BODY_CHARS = 4000;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"'`\][{}]+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "API key",
    /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|sk_live_[A-Za-z0-9]{16,})/,
  ],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["password", /\b(?:password|passwd|pwd|passcode)\s*(?:is|:|=)\s*\S+/i],
  ["bearer token", /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i],
  ["US SSN", /\b\d{3}-\d{2}-\d{4}\b/],
  ["IBAN", /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/],
];

const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function normalizeUrl(u: string): string {
  let s = u.replace(/[.,;:!?)\]}>'"]+$/, "").toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return s.replace(/\/+$/, "");
}

function sourceText(ctx: AutopilotOptions["ctx"]): string {
  return [...ctx.thread.map((m) => m.body), ...ctx.knowledge.flatMap((k) => [k.body, k.url ?? "", k.title])].join("\n");
}

function secretIn(body: string): string | null {
  for (const [name, re] of SECRET_PATTERNS) if (re.test(body)) return name;
  for (const m of body.matchAll(CARD_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "payment card number";
  }
  return null;
}

const refuse = (reason: string): AutopilotDecision => ({ send: false, reason });

/** Reasons are shown to support leads (approvals inbox, the internal note): plain words, no field names. */
const FLAG_LABEL: Record<keyof DraftReplyResult["flags"], string> = {
  promisesTimeline: "promises a timeline",
  mentionsPricingOrRefund: "mentions pricing or a refund",
  legalOrSecurity: "touches a legal or security topic",
  unsureOfFacts: "is unsure of the facts",
};
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function decideAutopilot(draft: DraftReplyResult, opts: AutopilotOptions): AutopilotDecision {
  const body = draft.body ?? "";
  const max = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  if (body.trim().length === 0) return refuse("the draft is empty");
  if (body.length > max)
    return refuse(`the draft is too long to send automatically (${body.length} characters; the limit is ${max})`);

  const raised = (Object.keys(draft.flags) as (keyof DraftReplyResult["flags"])[]).filter(
    (k) => draft.flags[k] !== false,
  );
  if (raised.length) return refuse(`draft flagged: ${raised.map((k) => FLAG_LABEL[k] ?? k).join(", ")}`);

  if (!Number.isFinite(draft.confidence) || !Number.isFinite(opts.minConfidence))
    return refuse("the agent's confidence is unknown");
  if (draft.confidence < opts.minConfidence) {
    return refuse(`confidence ${pct(draft.confidence)} is below the ${pct(opts.minConfidence)} minimum`);
  }

  if (!opts.triage) return refuse("the ticket hasn't been triaged yet");
  if (opts.triage.needsHuman)
    return refuse(`triage says a person should handle this: ${opts.triage.needsHumanReason ?? "no reason given"}`);

  const source = sourceText(opts.ctx);
  const knownUrls = new Set([...source.matchAll(URL_RE)].map((m) => normalizeUrl(m[0])));
  for (const k of opts.ctx.knowledge) if (k.url) knownUrls.add(normalizeUrl(k.url));
  const unknownUrl = [...body.matchAll(URL_RE)].map((m) => m[0]).find((u) => !knownUrls.has(normalizeUrl(u)));
  if (unknownUrl) return refuse(`the draft links to a URL that isn't in the ticket or your knowledge: ${unknownUrl}`);

  const knownEmails = new Set([...source.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()));
  const unknownEmail = [...body.matchAll(EMAIL_RE)].map((m) => m[0]).find((e) => !knownEmails.has(e.toLowerCase()));
  if (unknownEmail) return refuse("the draft includes an email address that isn't in the ticket or your knowledge");

  const secret = secretIn(body);
  if (secret) return refuse(`the draft contains what looks like a ${secret}`);

  return { send: true, reason: "all guardrails passed" };
}
