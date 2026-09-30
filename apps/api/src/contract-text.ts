/**
 * Contract plain text for the review screen (T-58). Extracted on demand with the
 * same code the extraction agent reads the file with (`@slai/agents/documents`:
 * unpdf per PDF page, mammoth for DOCX), so page numbers and quotes line up with
 * the citations. Bounded in size, and cached per file content in this process.
 */
import { type ContractDocument, loadDocument } from "@slai/agents/documents";
import { CONTRACT_TEXT_MAX_CHARS, type ContractText } from "@slai/shared";

const MEDIA_TYPES = new Set<string>([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const CACHE_ENTRIES = 8;
const cache = new Map<string, Omit<ContractText, "contractId" | "filename">>();

export function isTextExtractable(mediaType: string): boolean {
  return MEDIA_TYPES.has(mediaType);
}

/** Cuts pages so their total length stays within `max` characters. */
export function boundPages(
  pages: { page: number | null; text: string }[],
  max = CONTRACT_TEXT_MAX_CHARS,
): Pick<ContractText, "pages" | "truncated"> {
  const out: ContractText["pages"] = [];
  let left = max;
  for (const p of pages) {
    if (left <= 0) return { pages: out, truncated: true };
    if (p.text.length > left) {
      out.push({ page: p.page, text: p.text.slice(0, left) });
      return { pages: out, truncated: true };
    }
    out.push(p);
    left -= p.text.length;
  }
  return { pages: out, truncated: false };
}

/** `sha256` identifies the file content (the cache key); the caller has already loaded the row through RLS. */
export async function contractText(
  row: { id: string; filename: string; mediaType: string; sha256: string },
  bytes: Uint8Array,
): Promise<ContractText> {
  const key = `${row.sha256}:${row.mediaType}`;
  let body = cache.get(key);
  if (!body) {
    const doc = await loadDocument({
      filename: row.filename,
      mediaType: row.mediaType as ContractDocument["mediaType"],
      base64: Buffer.from(bytes).toString("base64"),
    });
    body = boundPages(
      doc.pages ? doc.pages.map((text, i) => ({ page: i + 1, text })) : [{ page: null, text: doc.text }],
    );
    cache.set(key, body);
    if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  return { contractId: row.id, filename: row.filename, ...body };
}
