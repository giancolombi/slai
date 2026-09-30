/**
 * Comment bodies → bounded plain text. Help-desk bodies are untrusted HTML; we
 * never keep markup, only readable text capped at a fixed length so a huge
 * email thread can't bloat storage or an agent prompt.
 */

export const MAX_BODY_CHARS = 20_000;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  bull: "•",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}

export function truncate(s: string, max = MAX_BODY_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Normalizes whitespace: collapses runs of spaces, keeps at most one blank line. */
export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string | null | undefined, max = MAX_BODY_CHARS): string {
  if (!html) return "";
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|blockquote|pre|section|article)\s*>/gi, "\n")
    .replace(/<(p|div|h[1-6]|tr|table|blockquote|pre|section|article)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  return truncate(normalizeWhitespace(s), max);
}

/** Plain text (already text) → bounded, normalized text. */
export function plainText(text: string | null | undefined, max = MAX_BODY_CHARS): string {
  return truncate(normalizeWhitespace(text ?? ""), max);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text → minimal safe HTML (paragraphs and line breaks) for write-back. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Template placeholders in saved replies, which the help desk fills in when an
 * agent uses the reply: Liquid `{{ticket.requester.first_name}}` and
 * `{% if … %}` (Zendesk, Freshdesk, Gorgias, Front), Intercom
 * `{{first_name | fallback: "there"}}`, Help Scout
 * `{%customer.firstName,fallback=there%}`, Zammad `#{ticket.customer.firstname}`.
 * Bounded so a stray brace can't swallow the rest of the text.
 */
const PLACEHOLDER = /\{\{[^{}]{0,300}\}\}|\{%[^%]{0,300}%\}|#\{[^{}\n]{0,200}\}/g;
const LIQUID_COMMENT = /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/gi;
/** `fallback: "x"`, `default: 'x'`, `fallback=x`, or Front's bare `| 'x'`. */
const FALLBACK = /(?:\b(?:fallback|default)\s*[:=]\s*|\|\s*(?=["']))(?:"([^"]*)"|'([^']*)'|([^,|%}"']+))/i;
/** Marks where a placeholder was removed, so only the punctuation around it is tidied. */
const GAP = "\u0000";

/**
 * Saved-reply text with its placeholders resolved safely: a placeholder
 * becomes its fallback when it declares one (`fallback: "there"`), and is
 * dropped otherwise, taking the space before a following comma or full stop
 * with it ("Hi {{ticket.requester.first_name}}," → "Hi,"). We never fill in a
 * value: the reply is knowledge for many tickets, not a message to one person.
 */
export function stripPlaceholders(text: string): string {
  const s = text.replace(LIQUID_COMMENT, "").replace(PLACEHOLDER, (m) => {
    const f = FALLBACK.exec(m);
    const value = (f?.[1] ?? f?.[2] ?? f?.[3] ?? "").trim();
    return value || GAP;
  });
  return s
    .replace(/^[ \t]*\u0000(?:[ \t]*\u0000)*[ \t]*[,;:]?[ \t]*/gm, "")
    .replace(/[ \t]*\u0000(?:[ \t]*\u0000)*[ \t]*(?=[,.!?;:)]|$)/gm, "")
    .replace(/[ \t]*\u0000(?:[ \t]*\u0000)*[ \t]*/g, (m) => (/[ \t]/.test(m) ? " " : ""))
    .replace(/\u0000/g, "");
}

/** A saved reply's body (HTML or plain text) → bounded plain text without placeholders. */
export function savedReplyText(body: string | null | undefined, format: "html" | "text"): string {
  if (!body) return "";
  const text = format === "html" ? htmlToText(body, Number.POSITIVE_INFINITY) : body;
  return plainText(stripPlaceholders(text));
}
