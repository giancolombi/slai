/**
 * Deterministic, heuristic SLA extraction for MODEL_PROVIDER=mock. It reads
 * simple, line-oriented SLA text (headings, "Urgent: first response within 1
 * hour" bullets, business-hours sentences, credit clauses) and cites the line
 * each value came from. It is a demo aid, not a contract parser.
 */
import type { Metric, Priority } from "@slai/sla-engine";
import type { ExtractionDraft, PolicyDraft } from "../schemas.js";
import type { Ambiguity, Citation } from "../types.js";

interface Line {
  doc: string;
  text: string;
}

type Weekly = PolicyDraft["calendar"]["weekly"];
type Credit = PolicyDraft["credits"][number];
type Amount = { kind: "fixed_cents"; cents: number } | { kind: "percent_of_fee"; percent: number };

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAMES: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

const TIMEZONES: [RegExp, string][] = [
  [/\b(eastern|e[sd]?t|new york)\b/i, "America/New_York"],
  [/\b(central|c[sd]t|chicago)\b/i, "America/Chicago"],
  [/\b(mountain|m[sd]t|denver)\b/i, "America/Denver"],
  [/\b(pacific|p[sd]t|los angeles)\b/i, "America/Los_Angeles"],
  [/\b(uk time|london|gmt|bst|united kingdom)\b/i, "Europe/London"],
  [/\b(cet|cest|berlin|paris|central european)\b/i, "Europe/Berlin"],
  [/\b(sydney|aest|aedt)\b/i, "Australia/Sydney"],
  [/\butc\b/i, "UTC"],
];

const PRIORITY_LABELS: [Priority, RegExp][] = [
  ["urgent", /\b(urgent|critical|emergency|severity\s*1|sev\s*1|p1|priority\s*1)\b/i],
  ["high", /\b(high|major|severity\s*2|sev\s*2|p2|priority\s*2)\b/i],
  ["normal", /\b(normal|medium|moderate|severity\s*3|sev\s*3|p3|priority\s*3)\b/i],
  ["low", /\b(low|minor|severity\s*4|sev\s*4|p4|priority\s*4)\b/i],
];
const ALL_PRIORITIES = /\b(all (priorities|issues|tickets|requests|severities)|any priority)\b/i;

const TARGET_RE =
  /(first response|initial response|response|resolution|resolve[ds]?|restoration|workaround|status updates?|updates?)\D{0,40}?(\d+(?:\.\d+)?)\s*(business hours?|business days?|working hours?|working days?|hours?|hrs?|minutes?|mins?|calendar days?|days?)/gi;

function clean(raw: string): string {
  return raw
    .replace(/^\s*(?:#+|[-*•]|\d+(?:\.\d+)*[.)]?|\([a-z0-9]+\))\s+/i, "")
    .replace(/\*\*/g, "")
    .trim();
}

function headingTier(raw: string): string | null {
  const isHeading = /^\s*#{1,6}\s/.test(raw) || /^\s*\d+(?:\.\d+)*\.?\s+[A-Z]/.test(raw);
  if (!isHeading) return null;
  const t = clean(clean(raw)).replace(/[:.]$/, "");
  const m = /^(.{2,40}?)\s+(?:support(?:\s+(?:tier|plan|level))?|tier|plan)$/i.exec(t);
  if (!m || /^(the|our|support)$/i.test(m[1]!.trim())) return null;
  return t;
}

function priorityOf(label: string): Priority | "all" | null {
  if (ALL_PRIORITIES.test(label)) return "all";
  for (const [p, re] of PRIORITY_LABELS) if (re.test(label)) return p;
  return null;
}

function metricOf(word: string): Metric {
  const w = word.toLowerCase();
  if (w.includes("update")) return "periodic_update";
  if (w.startsWith("resol") || w.startsWith("restor") || w.startsWith("workaround")) return "resolution";
  return "first_response";
}

function to24h(h: number, m: number, ampm: string | undefined): string {
  let hh = h;
  const ap = ampm?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && hh < 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  return `${String(hh).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseHours(text: string): { weekly: Weekly; dayMinutes: number } | null {
  const days =
    /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*(?:through|to|thru|-|–|—)\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.exec(
      text,
    );
  const times =
    /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:to|until|-|–|—)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(
      text,
    );
  if (!days || !times) return null;
  const from = DAY_NAMES[days[1]!.toLowerCase()]!;
  const to = DAY_NAMES[days[2]!.toLowerCase()]!;
  const start = to24h(Number(times[1]), Number(times[2] ?? 0), times[3]);
  const end = to24h(Number(times[4]), Number(times[5] ?? 0), times[6]);
  const weekly = Object.fromEntries(DAYS.map((d) => [d, []])) as unknown as Weekly;
  for (let i = from; i <= to; i++) weekly[DAYS[i]!] = [{ start, end }];
  const [sh, sm] = start.split(":").map(Number) as [number, number];
  const [eh, em] = end.split(":").map(Number) as [number, number];
  return { weekly, dayMinutes: eh * 60 + em - (sh * 60 + sm) };
}

function amountFrom(text: string): Amount | null {
  const pct =
    /(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:the\s+)?(?:monthly|applicable|recurring|subscription|fees?))/i.exec(text) ??
    /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (pct) return { kind: "percent_of_fee", percent: Number(pct[1]) };
  const usd = /\$\s?([\d,]+(?:\.\d{2})?)/.exec(text);
  if (usd) return { kind: "fixed_cents", cents: Math.round(Number(usd[1]!.replace(/,/g, "")) * 100) };
  return null;
}

function scopeOf(text: string): { metric: Metric | null; priority: Priority | null } {
  const t = text.toLowerCase();
  const metric: Metric | null = /first response|initial response|response time/.test(t)
    ? "first_response"
    : /resolution|resolve/.test(t)
      ? "resolution"
      : null;
  let priority: Priority | null = null;
  for (const [p, re] of PRIORITY_LABELS) {
    if (re.test(text)) {
      priority = p;
      break;
    }
  }
  return { metric, priority };
}

function capOf(text: string): number | null {
  const m =
    /(?:not\s+(?:to\s+)?exceed|capped\s+at|maximum(?:\s+of)?|up\s+to|no\s+more\s+than)\s+(\d+(?:\.\d+)?)\s*%/i.exec(
      text,
    );
  return m ? Number(m[1]) : null;
}

function creditFrom(text: string, id: string): { credit: Credit; ambiguity: string | null } | null {
  const t = text.toLowerCase();
  if (!/credit/.test(t) || /uptime|availability/.test(t)) return null;
  const { metric, priority } = scopeOf(text);
  const tiers = [...text.matchAll(/(?:less than|below|under)\s+(\d+(?:\.\d+)?)\s*%[^;]*?(\d+(?:\.\d+)?)\s*%/gi)].map(
    (m) => ({
      belowPercent: Number(m[1]),
      amount: { kind: "percent_of_fee" as const, percent: Number(m[2]) },
    }),
  );
  if (tiers.length) {
    tiers.sort((a, b) => b.belowPercent - a.belowPercent);
    return {
      credit: { id, basis: "attainment", metric, priority, tiers, capPercent: capOf(text), sourceClause: null },
      ambiguity: null,
    };
  }
  const amount = amountFrom(
    text.replace(
      /(?:not\s+(?:to\s+)?exceed|capped\s+at|maximum(?:\s+of)?|up\s+to|no\s+more\s+than)\s+\d+(?:\.\d+)?\s*%.*/i,
      "",
    ),
  );
  if (!amount || !/\b(each|per|every|any)\b/.test(t)) return null;
  return {
    credit: { id, basis: "per_breach", metric, priority, amount, capPercent: capOf(text), sourceClause: null },
    ambiguity: metric === null ? "The credit clause does not name a metric; it is applied to every metric." : null,
  };
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "policy"
  );
}

interface TierAcc {
  name: string;
  lines: Line[];
}

export function mockExtract(docs: { filename: string; text: string }[]): ExtractionDraft {
  const citations: Citation[] = [];
  const ambiguities: Ambiguity[] = [];
  const global: Line[] = [];
  const tiers: TierAcc[] = [];
  let title: string | null = null;
  for (const d of docs) {
    let current: TierAcc | null = null;
    for (const raw of d.text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      if (!title && /^\s*#\s/.test(raw)) title = clean(raw);
      const tier = headingTier(raw);
      if (tier) {
        current = { name: tier, lines: [] };
        tiers.push(current);
        continue;
      }
      // A new top-level (non-tier) heading ends the tier section.
      if (/^\s*#{1,2}\s/.test(raw)) current = null;
      (current ? current.lines : global).push({ doc: d.filename, text: raw });
    }
  }
  if (tiers.length === 0) tiers.push({ name: title ?? "Support SLA", lines: [] });

  const allText = docs.map((d) => d.text).join("\n");
  const cite = (path: string, line: Line) =>
    citations.push({ path, quote: clean(line.text), document: line.doc, page: null });

  const policies: PolicyDraft[] = tiers.map((tier, pi) => {
    const lines = [...global, ...tier.lines];
    const base = `policies[${pi}]`;

    // Calendar: tier-specific hours win over global ones.
    let hours: { weekly: Weekly; dayMinutes: number } | null = null;
    let hoursLine: Line | null = null;
    for (const l of [...tier.lines, ...global]) {
      const h = parseHours(l.text);
      if (h) {
        hours = h;
        hoursLine = l;
        break;
      }
    }
    let timezone = "UTC";
    let tzFound = false;
    for (const [re, zone] of TIMEZONES) {
      if (re.test(hoursLine?.text ?? "") || (!hoursLine && re.test(allText))) {
        timezone = zone;
        tzFound = true;
        break;
      }
    }
    if (!hours) {
      hours = parseHours("Monday to Friday 09:00 to 17:00")!;
      ambiguities.push({
        path: `${base}.calendar`,
        question: "The contract does not state support hours in a form we could read. What are they?",
        assumption: "Monday to Friday, 09:00-17:00.",
        quote: null,
      });
    } else if (hoursLine) {
      cite(`${base}.calendar`, hoursLine);
      if (/holiday/i.test(hoursLine.text)) {
        ambiguities.push({
          path: `${base}.calendar.holidays`,
          question: "The contract excludes holidays but does not list the dates. Which dates apply?",
          assumption: "No holidays configured; add the dates before approving.",
          quote: clean(hoursLine.text),
        });
      }
    }
    if (!tzFound) {
      ambiguities.push({
        path: `${base}.calendar.timezone`,
        question: "Which time zone do the support hours use?",
        assumption: "UTC.",
        quote: null,
      });
    }

    // Targets.
    const targets: PolicyDraft["targets"] = [];
    for (const l of lines) {
      const text = clean(l.text);
      const sep = text.search(/[:–—]|\s-\s/);
      if (sep <= 0) continue;
      const label = text.slice(0, sep);
      const p = priorityOf(label);
      if (!p) continue;
      const body = text.slice(sep + 1);
      const segments = body.split(
        /;|,\s*(?=(?:and\s+)?(?:first|initial|resolution|response|status|updates?|restoration)\b)/i,
      );
      for (const segment of segments) {
        TARGET_RE.lastIndex = 0;
        const m = TARGET_RE.exec(segment);
        if (!m) continue;
        const metric = metricOf(m[1]!);
        const n = Number(m[2]);
        const unit = m[3]!.toLowerCase();
        const seg = segment.toLowerCase();
        const business = /business|working/.test(seg)
          ? true
          : /24\s*[x/×]\s*7|calendar|around the clock/.test(seg)
            ? false
            : /business hours/i.test(body);
        const clockStated =
          /business|working|24\s*[x/×]\s*7|calendar|around the clock/.test(seg) || /business hours/i.test(body);
        let minutes: number;
        if (/min/.test(unit)) minutes = n;
        else if (/(business|working) day/.test(unit)) minutes = n * hours.dayMinutes;
        else if (/day/.test(unit)) minutes = n * 1440;
        else minutes = n * 60;
        minutes = Math.round(minutes);
        const priorities: Priority[] = p === "all" ? ["urgent", "high", "normal", "low"] : [p];
        for (const pr of priorities) {
          if (targets.some((t) => t.metric === metric && t.priority === pr)) continue;
          targets.push({ metric, priority: pr, minutes, clock: business ? "business" : "calendar" });
          const path = `${base}.targets[${targets.length - 1}]`;
          cite(path, l);
          if (/(business|working) day/.test(unit)) {
            ambiguities.push({
              path,
              question: `"${m[0]}" is measured in business days. Is a business day the full ${hours.dayMinutes / 60}-hour support day?`,
              assumption: `1 business day = ${hours.dayMinutes} business minutes.`,
              quote: clean(l.text),
            });
          }
          if (!clockStated) {
            ambiguities.push({
              path: `${path}.clock`,
              question: `Does "${m[0].trim()}" count calendar time (24x7) or only business hours?`,
              assumption: "Calendar time (24x7).",
              quote: clean(l.text),
            });
          }
          if (p === "all") {
            ambiguities.push({
              path,
              question: "The target applies to all priorities. Should any priority have a different target?",
              assumption: "Same target for every priority.",
              quote: clean(l.text),
            });
          }
        }
      }
    }

    // Pause statuses.
    const pauseStatuses: PolicyDraft["pauseStatuses"] = [];
    for (const l of lines) {
      const t = l.text.toLowerCase();
      if (!/(pause|suspend|stop)/.test(t)) continue;
      const statuses: ("pending" | "on_hold")[] = [];
      if (/customer|requester|client/.test(t)) statuses.push("pending");
      if (/third[- ]party|vendor/.test(t)) statuses.push("on_hold");
      if (statuses.length && !pauseStatuses.some((p) => p.metric === "resolution")) {
        pauseStatuses.push({ metric: "resolution", statuses });
      }
    }

    // Credits.
    const credits: Credit[] = [];
    for (const l of lines) {
      const c = creditFrom(clean(l.text), `${slug(tier.name)}-credit-${credits.length + 1}`);
      if (!c) continue;
      credits.push(c.credit);
      const path = `${base}.credits[${credits.length - 1}]`;
      cite(path, l);
      if (c.ambiguity)
        ambiguities.push({ path, question: c.ambiguity, assumption: "Applies to all metrics.", quote: clean(l.text) });
    }

    return {
      id: slug(tier.name),
      name: tier.name,
      calendar: { timezone, weekly: hours.weekly, holidays: [] },
      targets,
      defaultPriority: null,
      pauseStatuses,
      botRepliesCount: false,
      credits,
    };
  });

  const customer =
    /(?:\bbetween\s+|\band\s+|^)([A-Z][\w&.,' -]{1,60}?)\s*\((?:the\s+)?["“]?Customer["”]?\)/m.exec(allText)?.[1] ??
    /^\s*\**Customer\**\s*:\s*\**(.+?)\**\s*$/im.exec(allText)?.[1] ??
    null;
  const fee =
    /(?:monthly\s+(?:subscription\s+)?fees?\s+(?:of|is|are|:)\s*)\$\s?([\d,]+(?:\.\d{2})?)/i.exec(allText) ??
    /\$\s?([\d,]+(?:\.\d{2})?)\s*(?:per|\/|a)\s*month/i.exec(allText);
  const eff = /effective\s+date[\s*:=]*(\d{4}-\d{2}-\d{2})/i.exec(allText);

  const targetCount = policies.reduce((n, p) => n + p.targets.length, 0);
  const creditCount = policies.reduce((n, p) => n + p.credits.length, 0);
  return {
    policies,
    citations,
    ambiguities,
    parties: {
      customerName: customer?.trim() ?? null,
      monthlyFeeCents: fee ? Math.round(Number(fee[1]!.replace(/,/g, "")) * 100) : null,
      effectiveDate: eff?.[1] ?? null,
    },
    summary: `Found ${policies.length} SLA polic${policies.length === 1 ? "y" : "ies"} (${policies
      .map((p) => p.name)
      .join(
        ", ",
      )}) with ${targetCount} response and resolution targets and ${creditCount} service-credit rule${creditCount === 1 ? "" : "s"}. Check every value against its quote before approving.`,
  };
}
