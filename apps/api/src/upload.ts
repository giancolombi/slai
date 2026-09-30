/**
 * Contract file type detection from content (magic bytes), cross-checked with
 * the extension. The declared Content-Type is ignored.
 */
export type ContractMediaType =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "text/plain"
  | "text/markdown";

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // PK\3\4

function containsAscii(b: Uint8Array, needle: string): boolean {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).includes(needle, 0, "latin1");
}

function isUtf8Text(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename);
  return m ? m[1]!.toLowerCase() : "";
}

/** Returns the media type when content and extension agree on an allowed type; otherwise null. */
export function sniffContract(bytes: Uint8Array, filename: string): ContractMediaType | null {
  const ext = extensionOf(filename);
  if (startsWith(bytes, PDF)) return ext === "pdf" ? "application/pdf" : null;
  if (startsWith(bytes, ZIP)) {
    const isDocx = containsAscii(bytes, "[Content_Types].xml") && containsAscii(bytes, "word/");
    return isDocx && ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : null;
  }
  if (!isUtf8Text(bytes)) return null;
  if (ext === "txt") return "text/plain";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  return null;
}

/** A display-safe file name (no path, no control characters). */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return (clean || "contract").slice(0, 200);
}
