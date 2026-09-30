import type { ComponentType } from "react";

/** Every guide in the help center. Content lives in `help/guides/*.tsx` (never in .md files). */
export const GUIDE_IDS = [
  "getting-started",
  "sla-clock",
  "contract-review",
  "autonomy",
  "knowledge",
  "approvals",
  "alerts",
  "replay",
  "connections",
  "team-security",
  "billing",
  "faq",
  "glossary",
] as const;
export type GuideId = (typeof GUIDE_IDS)[number];

export interface GuideMeta {
  id: GuideId;
  title: string;
  /** One or two sentences, shown in lists and search results. */
  summary: string;
  /** Extra words people search for (synonyms, help-desk jargon). */
  keywords: string[];
  related: GuideId[];
  /** Section headings with anchor ids, for the table of contents and search. */
  sections: { id: string; title: string }[];
}

export interface Guide extends GuideMeta {
  Body: ComponentType;
}

/** A searchable question or term inside a guide (FAQ entries, glossary terms). */
export interface HelpEntry {
  guide: GuideId;
  anchor: string;
  title: string;
  text: string;
}
