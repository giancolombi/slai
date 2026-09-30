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
      ? "The ticket contains text that tries to instruct the assistant."
      : humanCategory
        ? `Category "${category}" always needs a human.`
        : "Mentions refunds, legal terms, cancellation, or an escalation.";
  const assignee = ctx.assignees.find((a) => a.skills.some((s) => s.toLowerCase() === category)) ?? null;
  return {
    summary: `${ctx.customerName ?? "The customer"} wrote about "${ctx.subject}" (${ctx.thread.length} message${ctx.thread.length === 1 ? "" : "s"}).`,
    category,
    suggestedPriority,
    priorityReason: `Keyword rules matched category "${category}".`,
    suggestedAssigneeSourceId: assignee?.sourceId ?? null,
    sentiment,
    needsHuman,
    needsHumanReason,
    confidence: category === "other" ? 0.5 : 0.85,
  };
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
}

export function mockDraft(ctx: TicketContext, triage: TriageResult | null): DraftReplyResult {
  const t = triage ?? mockTriage(ctx);
  const firstName = ctx.thread.find((m) => m.authorRole === "requester")?.authorName?.split(/\s+/)[0] ?? null;
  const subjectWords = words(`${ctx.subject} ${ctx.thread.at(-1)?.body ?? ""}`);
  const kIndex = ctx.knowledge.findIndex((k) => {
    const kw = words(`${k.title} ${k.body}`);
    let overlap = 0;
    for (const w of subjectWords) if (kw.has(w)) overlap++;
    return overlap >= 2;
  });
  const k = kIndex >= 0 ? ctx.knowledge[kIndex]! : null;
  const lines = [
    `Hi ${firstName ?? "there"},`,
    "",
    `Thank you for contacting us about "${ctx.subject}" (ticket ${ctx.ticketKey}).`,
  ];
  if (k) {
    const firstSentence = k.body.split(/(?<=[.!?])\s/)[0]!.trim();
    lines.push(
      "",
      `Here is what should help: ${firstSentence}${k.url ? ` More detail is in "${k.title}": ${k.url}` : ""}`,
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
      ? `Mock draft based on knowledge item ${kIndex} ("${k.title}").`
      : "Mock draft: no matching knowledge item; holding reply asking for details.",
    confidence: k && !anyFlag ? 0.9 : 0.4,
    usedKnowledge: k ? [kIndex] : [],
    flags,
  };
}
