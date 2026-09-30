/**
 * Pagination helpers. Our `Page.nextCursor` is opaque to the worker, so each
 * connector encodes whatever state it needs (vendor cursor, page number, a
 * re-anchored `since`) as base64url JSON.
 */
import { ConnectorError } from "../types.js";

export function encodeCursor(state: unknown): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function decodeCursor<T>(cursor: string | null, guard: (v: unknown) => v is T): T | null {
  if (cursor === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ConnectorError("malformed cursor", "invalid");
  }
  if (!guard(v)) throw new ConnectorError("malformed cursor", "invalid");
  return v;
}

/** Max pages a history fetch may follow before we stop (defends against loops). */
export const MAX_HISTORY_PAGES = 200;

/**
 * Drains a paginated sub-resource (audits, conversations, comments). `fetchPage`
 * returns the items and the next token, or null when exhausted.
 */
export async function collectPages<T, Tok>(
  first: Tok,
  fetchPage: (token: Tok) => Promise<{ items: T[]; next: Tok | null }>,
  maxPages = MAX_HISTORY_PAGES,
): Promise<T[]> {
  const out: T[] = [];
  let token: Tok | null = first;
  for (let i = 0; token !== null; i++) {
    if (i >= maxPages) throw new ConnectorError(`pagination exceeded ${maxPages} pages`, "upstream");
    const { items, next } = await fetchPage(token);
    out.push(...items);
    token = next;
  }
  return out;
}

/** Parses an RFC 8288 Link header and returns the rel="next" URL, if any. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m?.[1]) return m[1];
  }
  return null;
}
