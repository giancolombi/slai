import type { PolicyInput } from "@slai/sla-engine";
import type { LoadedDocument } from "./documents.js";
import type { Ambiguity, Citation } from "./types.js";

/** Case-, whitespace-, quote-style- and markdown-emphasis-insensitive form for quote matching. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[*_`]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Shortest quote we accept as evidence; shorter strings match almost anywhere. */
const MIN_QUOTE_CHARS = 8;

export interface CitationCheck {
  verified: Citation[];
  dropped: Citation[];
}

/**
 * Keeps only citations whose quote appears verbatim (after normalization) in
 * the named document, or in any document if the name doesn't match one. The
 * page is recomputed from the PDF text; the model's page number is not trusted.
 */
export function verifyCitations(citations: Citation[], docs: LoadedDocument[]): CitationCheck {
  const normDocs = docs.map((d) => ({
    doc: d,
    text: normalizeForMatch(d.text),
    pages: d.pages?.map(normalizeForMatch) ?? null,
  }));
  const verified: Citation[] = [];
  const dropped: Citation[] = [];
  for (const c of citations) {
    const q = normalizeForMatch(c.quote);
    if (q.length < MIN_QUOTE_CHARS) {
      dropped.push(c);
      continue;
    }
    const named = normDocs.filter((d) => d.doc.filename === c.document);
    const hit = (named.length ? named : normDocs).find((d) => d.text.includes(q));
    if (!hit) {
      dropped.push(c);
      continue;
    }
    const pageIdx = hit.pages ? hit.pages.findIndex((p) => p.includes(q)) : -1;
    verified.push({ ...c, document: hit.doc.filename, page: pageIdx >= 0 ? pageIdx + 1 : null });
  }
  return { verified, dropped };
}

/**
 * Every value a reviewer must be able to trace to the contract: each target,
 * each credit rule, and the business-hours calendar when a business clock is used.
 */
export function valuePaths(policies: PolicyInput[]): string[] {
  const paths: string[] = [];
  policies.forEach((p, i) => {
    if (p.targets.some((t) => t.clock === "business")) paths.push(`policies[${i}].calendar`);
    p.targets.forEach((_, j) => {
      paths.push(`policies[${i}].targets[${j}]`);
    });
    (p.credits ?? []).forEach((_, j) => {
      paths.push(`policies[${i}].credits[${j}]`);
    });
  });
  return paths;
}

function covers(citationPath: string, valuePath: string): boolean {
  return (
    citationPath === valuePath || citationPath.startsWith(`${valuePath}.`) || citationPath.startsWith(`${valuePath}[`)
  );
}

/** One ambiguity per policy value that has no verified citation. */
export function uncitedAmbiguities(policies: PolicyInput[], verified: Citation[]): Ambiguity[] {
  const out: Ambiguity[] = [];
  for (const path of valuePaths(policies)) {
    if (verified.some((c) => covers(c.path, path))) continue;
    out.push({
      path,
      question: "No verifiable quote from the contract supports this value. Is it correct?",
      assumption: "Value proposed by the extractor without a verified citation; confirm against the contract.",
      quote: null,
    });
  }
  return out;
}
