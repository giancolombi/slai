/** Deterministic keyword triage and templated drafts for MODEL_PROVIDER=mock. */
import type { Priority } from "@slai/sla-engine";
import type { DraftReplyResult, TicketContext, TriageResult } from "../types.js";

const CATEGORY_RULES: [string, RegExp][] = [
  ["security", /\b(security|vulnerab\w*|breach(ed)?|hacked|phishing|leak(ed)?|compromised|cve-\d+)\b/],
  ["outage", /\b(outage|is down|are down|site down|not loading|unavailable|5\d\d error|service disruption)\b/],
  ["data_request", /\b(gdpr|ccpa|delete (my|our|all) data|export (my|our|all) data|dsar|right to be forgotten)\b/],
  ["billing", /\b(invoice|charged?|refund|billing|payment|overcharged|receipt|pricing|subscription fee)\b/],
  ["account_access", /\b(password|log ?in|sign ?in|2fa|mfa|sso|locked out|reset link)\b/],
  ["bug", /\b(error|bug|broken|crash(es|ed)?|fails?|failing|not working|doesn't work|does not work)\b/],
  ["how_to", /\b(how (do|can) (i|we)|how to|is it possible|where (do|can) i)\b/],
  ["feature_request", /\b(feature request|would be (great|nice)|could you add|please add|wish)\b/],
];

const PRIORITY_BY_CATEGORY: Record<string, Priority> = {
  security: "urgent",
  outage: "urgent",
  data_request: "high",
  billing: "normal",
  account_access: "high",
  bug: "normal",
  how_to: "low",
  feature_request: "low",
  other: "normal",
};

const HUMAN_RE =
  /\b(refund|lawyer|attorney|legal|lawsuit|contract|cancel(lation)?|terminate|churn|ceo|vp|executive|chargeback|dispute)\b/;
const INJECTION_RE =
  /(ignore (?:all |any |the )?(?:previous |prior |above |earlier )?(?:instructions|rules)|system prompt|you are now|disregard .* instructions)/;
/(ignore (all|any|the|previous|prior|above) (instructions|rules)|system prompt|you are now|disregard .* instructions)/;
const BLOCKING_RE = /\b(production|all (of our )?users|entire team|blocked|cannot work|can't work|urgent|asap)\b/;

function customerText(ctx: TicketContext): string {
  return [ctx.subject, ...ctx.thread.filter((m) => m.authorRole === "requester").map((m) => m.body)]
    .join("\n")
    .toLowerCase();
}

export function mockTriage(ctx: TicketContext): TriageResult {
  const text = customerText(ctx);
  const category = CATEGORY_RULES.find(([, re]) => re.test(text))?.[0] ?? "other";
  let suggestedPriority = PRIORITY_BY_CATEGORY[category]!;
  if (category === "bug" && BLOCKING_RE.test(text)) suggestedPriority = "high";
  const sentiment: TriageResult["sentiment"] =
    /\b(unacceptable|ridiculous|furious|worst|terrible|disgusted)\b|!!!/.test(text)
      ? "angry"
      : /\b(frustrat\w*|still|again|asap|waiting|disappointed)\b/.test(text)
        ? "frustrated"
        : /\b(thanks|thank you|great|appreciate|love)\b/.test(text)
          ? "positive"
          : "neutral";
  const injection = INJECTION_RE.test(text);
  const humanCategory = ["security", "outage", "data_request"].includes(category);
  const needsHuman = humanCategory || HUMAN_RE.test(text) || injection;
  const needsHumanReason = !needsHuman
    ? null
    : injection
      ? "The ticket contains text that tries to give the AI agent instructions."
      : humanCategory
        ? `${category.replace(/_/g, " ")} tickets always need a person.`
        : "Mentions refunds, legal terms, cancellation, or an escalation.";
  const assignee = ctx.assignees.find((a) => a.skills.some((s) => s.toLowerCase() === category)) ?? null;
  return {
    summary: `${ctx.customerName ?? "The customer"} wrote about "${ctx.subject}" (${ctx.thread.length} message${ctx.thread.length === 1 ? "" : "s"}).`,
    category,
    suggestedPriority,
    priorityReason: `Based on the topic (${category.replace(/_/g, " ")}) and the wording of the ticket.`,
    suggestedAssigneeSourceId: assignee?.sourceId ?? null,
    sentiment,
    needsHuman,
    needsHumanReason,
    confidence: category === "other" ? 0.5 : 0.85,
  };
}

/** Words too common to say whether an article is about the ticket. */
const STOP = new Set(
  "about after again also been before being between both cannot could does doing down during each every from have having here into just like more most much only other over same should some still such than that their them then there these they this those through under until very want were what when where which while will with would your yours".split(
    " ",
  ),
);

function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
}

/**
 * The knowledge item the reply should rely on: the one sharing the most
 * content words with the subject and the customer's latest message. It must
 * share at least two, one of them in its title; otherwise nothing is relevant.
 */
export function relevantKnowledge(ctx: TicketContext): number {
  const lastAsk = ctx.thread.filter((m) => m.authorRole === "requester").at(-1)?.body ?? "";
  const query = words(`${ctx.subject} ${lastAsk}`);
  let best = -1;
  let bestScore = 0;
  ctx.knowledge.forEach((k, i) => {
    const title = words(k.title);
    const all = words(`${k.title} ${k.body}`);
    let overlap = 0;
    let inTitle = 0;
    for (const w of query) {
      if (all.has(w)) overlap++;
      if (title.has(w)) inTitle++;
    }
    const score = overlap + inTitle;
    if (overlap >= 2 && inTitle >= 1 && score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/** The article's opening, up to two sentences and ~400 characters, to quote in the reply. */
function opening(body: string): string {
  const sentences = body
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s/);
  let out = sentences[0] ?? "";
  if (sentences[1] && out.length + sentences[1].length < 400) out += ` ${sentences[1]}`;
  return out.length > 400 ? `${out.slice(0, 399).trimEnd()}…` : out;
}

export function mockDraft(ctx: TicketContext, triage: TriageResult | null): DraftReplyResult {
  const t = triage ?? mockTriage(ctx);
  const firstName = ctx.thread.find((m) => m.authorRole === "requester")?.authorName?.split(/\s+/)[0] ?? null;
  const kIndex = relevantKnowledge(ctx);
  const k = kIndex >= 0 ? ctx.knowledge[kIndex]! : null;
  const lines = [
    `Hi ${firstName ?? "there"},`,
    "",
    `Thank you for contacting us about "${ctx.subject}" (ticket ${ctx.ticketKey}).`,
  ];
  if (k) {
    lines.push(
      "",
      `Here is what should help, from our guide "${k.title}": ${opening(k.body)}`,
      ...(k.url ? ["", `The full steps are here: ${k.url}`] : []),
    );
    lines.push("", "If that doesn't resolve it, reply here with what you see and we'll dig in further.");
  } else {
    lines.push(
      "",
      "I'm looking into this and will follow up with what I find. In the meantime, could you share any error messages or screenshots, and the steps that lead to the problem?",
    );
  }
  const text = customerText(ctx);
  const flags = {
    promisesTimeline: false,
    mentionsPricingOrRefund:
      t.category === "billing" || /\b(refund|price|pricing|invoice|discount|credit)\b/.test(text),
    legalOrSecurity:
      ["security", "data_request"].includes(t.category) || /\b(legal|lawyer|attorney|contract|gdpr)\b/.test(text),
    unsureOfFacts: k === null,
  };
  const anyFlag = Object.values(flags).some(Boolean);
  return {
    body: lines.join("\n"),
    internalNote: k
      ? `Draft based on "${k.title}" from your knowledge.`
      : "No matching knowledge found, so this draft asks the customer for more details.",
    confidence: k && !anyFlag ? 0.9 : 0.4,
    usedKnowledge: k ? [kIndex] : [],
    flags,
  };
}
