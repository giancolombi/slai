/**
 * Finds a citation's quote in the contract text the way the extractor verified it
 * (`normalizeForMatch` in packages/agents): case-, whitespace-, quote-style- and
 * markdown-emphasis-insensitive. Returns offsets in the original text, so the
 * passage can be highlighted exactly as it appears in the document.
 */

const SINGLE = /[‘’‚‛′]/;
const DOUBLE = /[“”„‟″]/;
const DASH = /[‐-―−]/;
const EMPHASIS = /[*_`]/;
const SPACE = /\s/;

export interface Normalized {
  text: string;
  /** For each char of `text`, [start, end) of the original chars it came from. */
  spans: [number, number][];
}

export function normalizeWithMap(original: string): Normalized {
  let text = "";
  const spans: [number, number][] = [];
  let i = 0;
  for (const ch of original) {
    const start = i;
    i += ch.length;
    if (SPACE.test(ch)) {
      if (text.length > 0 && !text.endsWith(" ")) {
        text += " ";
        spans.push([start, i]);
      }
      continue;
    }
    for (let c of ch.normalize("NFKC")) {
      if (SINGLE.test(c)) c = "'";
      else if (DOUBLE.test(c)) c = '"';
      else if (DASH.test(c)) c = "-";
      if (EMPHASIS.test(c)) continue;
      for (const lower of c.toLowerCase()) {
        if (SPACE.test(lower)) {
          if (text.length > 0 && !text.endsWith(" ")) {
            text += " ";
            spans.push([start, i]);
          }
          continue;
        }
        text += lower;
        spans.push([start, i]);
      }
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    spans.pop();
  }
  return { text, spans };
}

export const normalizeQuote = (quote: string) => normalizeWithMap(quote).text;

export interface QuoteMatch {
  /** Index into the pages array. */
  pageIndex: number;
  start: number;
  end: number;
}

/** Shortest quote we try to place; shorter strings match almost anywhere (the extractor uses the same floor). */
const MIN_QUOTE_CHARS = 8;

/**
 * Locates `quote` in the pages, trying the cited page first. Null when the quote
 * is too short or isn't in the text (e.g. it spans a page break, or the text was truncated).
 */
export function findQuote(
  pages: { page: number | null; norm: Normalized }[],
  quote: string,
  citedPage: number | null,
): QuoteMatch | null {
  const q = normalizeQuote(quote);
  if (q.length < MIN_QUOTE_CHARS) return null;
  const preferred = citedPage === null ? -1 : pages.findIndex((p) => p.page === citedPage);
  const all = pages.map((_, i) => i);
  const order = preferred >= 0 ? [preferred, ...all.filter((i) => i !== preferred)] : all;
  for (const pageIndex of order) {
    const { text, spans } = pages[pageIndex]!.norm;
    const at = text.indexOf(q);
    if (at < 0) continue;
    return { pageIndex, start: spans[at]![0], end: spans[at + q.length - 1]![1] };
  }
  return null;
}

export interface Segment {
  start: number;
  end: number;
  /** Citation paths whose quote covers this stretch. */
  paths: string[];
}

/** Splits `length` chars into runs covered by the same set of highlighted ranges (ranges may overlap). */
export function segment(length: number, ranges: { path: string; start: number; end: number }[]): Segment[] {
  const cuts = new Set([0, length]);
  for (const r of ranges) {
    cuts.add(Math.max(0, Math.min(length, r.start)));
    cuts.add(Math.max(0, Math.min(length, r.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const start = points[k]!;
    const end = points[k + 1]!;
    if (end <= start) continue;
    const paths = ranges.filter((r) => r.start <= start && r.end >= end).map((r) => r.path);
    const prev = out.at(-1);
    if (prev && prev.paths.join("\n") === paths.join("\n")) prev.end = end;
    else out.push({ start, end, paths });
  }
  return out;
}
