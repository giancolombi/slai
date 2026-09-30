import { describe, expect, it } from "vitest";
import { findQuote, normalizeWithMap, segment } from "../src/pages/contracts/quote-match";

const page = (page: number | null, text: string) => ({ page, text, norm: normalizeWithMap(text) });

describe("normalizeWithMap", () => {
  it("matches the extractor's normalization (case, whitespace, quote style, dashes, emphasis)", () => {
    const n = normalizeWithMap("  “Critical”  Issues –\n**within**   1 Hour ");
    expect(n.text).toBe('"critical" issues - within 1 hour');
    expect(n.spans).toHaveLength(n.text.length);
  });
});

describe("findQuote", () => {
  const text = "EXHIBIT B\nCritical:  first response within\n1 hour during business hours.\nHigh: within 4 hours.";

  it("returns original offsets for a quote that differs only in spacing and case", () => {
    const pages = [page(1, text)];
    const m = findQuote(pages, "critical: first response within 1 hour", 1)!;
    expect(m.pageIndex).toBe(0);
    expect(text.slice(m.start, m.end)).toBe("Critical:  first response within\n1 hour");
  });

  it("prefers the cited page but finds the quote elsewhere", () => {
    const pages = [page(1, "High: within 4 hours."), page(2, "Something else"), page(3, "High: within 4 hours.")];
    expect(findQuote(pages, "High: within 4 hours", 3)?.pageIndex).toBe(2);
    expect(findQuote(pages, "High: within 4 hours", 2)?.pageIndex).toBe(0);
    expect(findQuote(pages, "High: within 4 hours", null)?.pageIndex).toBe(0);
  });

  it("maps through curly quotes and markdown emphasis in the document", () => {
    const md = 'The **"Response Time"** is 30 minutes.';
    const m = findQuote([page(null, md)], '"response time" is 30 minutes', null)!;
    expect(md.slice(m.start, m.end)).toBe('"Response Time"** is 30 minutes');
  });

  it("gives up on quotes that are missing or too short to place", () => {
    expect(findQuote([page(1, text)], "within 8 hours for low", 1)).toBeNull();
    expect(findQuote([page(1, text)], "1 hour", 1)).toBeNull();
  });
});

describe("segment", () => {
  it("splits text into runs by the overlapping ranges that cover them", () => {
    const s = segment(20, [
      { path: "a", start: 2, end: 10 },
      { path: "b", start: 5, end: 15 },
    ]);
    expect(s).toEqual([
      { start: 0, end: 2, paths: [] },
      { start: 2, end: 5, paths: ["a"] },
      { start: 5, end: 10, paths: ["a", "b"] },
      { start: 10, end: 15, paths: ["b"] },
      { start: 15, end: 20, paths: [] },
    ]);
    expect(segment(5, [])).toEqual([{ start: 0, end: 5, paths: [] }]);
  });
});
