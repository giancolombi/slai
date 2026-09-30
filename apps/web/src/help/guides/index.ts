import type { Guide, GuideId, HelpEntry } from "../types";
import { GUIDE_IDS } from "../types";
import { alerts } from "./alerts";
import { approvals } from "./approvals";
import { autonomy } from "./autonomy";
import { billing } from "./billing";
import { connections } from "./connections";
import { contractReview } from "./contract-review";
import { faq, faqEntries } from "./faq";
import { gettingStarted } from "./getting-started";
import { glossary, glossaryEntries } from "./glossary";
import { knowledge } from "./knowledge";
import { replay } from "./replay";
import { slaClock } from "./sla-clock";
import { teamSecurity } from "./team-security";

const ALL: Record<GuideId, Guide> = {
  "getting-started": gettingStarted,
  "sla-clock": slaClock,
  "contract-review": contractReview,
  autonomy,
  knowledge,
  approvals,
  alerts,
  replay,
  connections,
  "team-security": teamSecurity,
  billing,
  faq,
  glossary,
};

/** Every guide, in reading order. */
export const GUIDES: Guide[] = GUIDE_IDS.map((id) => ALL[id]);

export function getGuide(id: string): Guide | null {
  return (GUIDE_IDS as readonly string[]).includes(id) ? ALL[id as GuideId] : null;
}

/** How the help center groups guides. */
export const GUIDE_GROUPS: { title: string; ids: GuideId[] }[] = [
  { title: "Start here", ids: ["getting-started", "sla-clock"] },
  { title: "Set up", ids: ["contract-review", "connections", "autonomy", "knowledge", "alerts"] },
  { title: "Every day", ids: ["approvals", "replay"] },
  { title: "Your organization", ids: ["team-security", "billing"] },
  { title: "Reference", ids: ["faq", "glossary"] },
];

export interface SearchResult {
  guide: GuideId;
  /** A section, FAQ entry or glossary term inside the guide. */
  anchor?: string;
  title: string;
  /** Where it lives, e.g. the guide's title for a section hit. */
  context: string;
  snippet: string;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

interface Doc extends SearchResult {
  /** Weighted fields: title, keywords, body text. */
  fields: [string, number][];
}

function buildIndex(): Doc[] {
  const docs: Doc[] = [];
  for (const g of GUIDES) {
    docs.push({
      guide: g.id,
      title: g.title,
      context: "Guide",
      snippet: g.summary,
      fields: [
        [norm(g.title), 5],
        [norm(g.keywords.join(" ")), 3],
        [norm(g.summary), 2],
        [norm(g.sections.map((s) => s.title).join(" ")), 1],
      ],
    });
    if (g.id === "faq") continue;
    for (const s of g.sections) {
      docs.push({
        guide: g.id,
        anchor: s.id,
        title: s.title,
        context: g.title,
        snippet: g.summary,
        fields: [[norm(s.title), 4]],
      });
    }
  }
  const entries: HelpEntry[] = [...faqEntries, ...glossaryEntries];
  for (const e of entries) {
    docs.push({
      guide: e.guide,
      anchor: e.anchor,
      title: e.title,
      context: e.guide === "faq" ? "FAQ" : "Glossary",
      snippet: e.guide === "faq" ? "" : e.text,
      fields: [
        [norm(e.title), 5],
        [norm(e.text), 2],
      ],
    });
  }
  return docs;
}

let index: Doc[] | null = null;

/**
 * Client-side search over guides, their sections, FAQ questions and glossary terms.
 * Every word of the query must match (prefixes count); results are ranked by where they match.
 */
export function searchHelp(query: string, limit = 12): SearchResult[] {
  const words = norm(query).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  index ??= buildIndex();
  const scored: { doc: Doc; score: number }[] = [];
  for (const doc of index) {
    let score = 0;
    let all = true;
    for (const w of words) {
      let best = 0;
      for (const [text, weight] of doc.fields) {
        const padded = ` ${text} `;
        if (padded.includes(` ${w} `)) best = Math.max(best, weight * 2);
        else if (padded.includes(` ${w}`)) best = Math.max(best, weight * 1.5);
        else if (w.length >= 3 && text.includes(w)) best = Math.max(best, weight);
      }
      if (best === 0) {
        all = false;
        break;
      }
      score += best;
    }
    if (all) scored.push({ doc, score: score + (doc.anchor ? 0 : 0.5) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title))
    .slice(0, limit)
    .map(({ doc: { fields: _f, ...r } }) => r);
}
