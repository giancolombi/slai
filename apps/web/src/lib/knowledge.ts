import type { KnowledgeArticle, KnowledgeRef, KnowledgeSourceKind } from "@slai/shared";

export const SOURCE_KIND_LABEL: Record<KnowledgeSourceKind, string> = {
  helpdesk_articles: "Help-center articles",
  saved_replies: "Help-desk saved replies",
  manual: "Saved replies (slai)",
};

/** The host of an article URL for compact display, or null for a missing or unparseable URL. */
export function urlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Only http(s) links are rendered as links; anything else is shown as plain text. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Case-insensitive match on every word of `q` against title and body (the mock API's stand-in for full-text search). */
export function matchesArticle(a: Pick<KnowledgeArticle, "title" | "bodyText">, q: string | null | undefined) {
  const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${a.title}\n${a.bodyText}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Drops duplicate refs (same id, or same title+url when deleted) while keeping the draft's order. */
export function uniqueRefs(refs: KnowledgeRef[] | null | undefined): KnowledgeRef[] {
  const seen = new Set<string>();
  const out: KnowledgeRef[] = [];
  for (const r of refs ?? []) {
    const key = r.id ?? `${r.title}\u0000${r.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
