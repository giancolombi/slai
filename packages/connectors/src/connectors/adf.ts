/**
 * Atlassian Document Format (ADF) → plain text, for Jira comment and
 * description bodies. Doc: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 */
import { plainText } from "../lib/text.js";

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

const BLOCKS = new Set(["paragraph", "heading", "blockquote", "codeBlock", "rule", "panel", "tableRow"]);

function walk(node: AdfNode, out: string[]): void {
  switch (node.type) {
    case "text":
      out.push(node.text ?? "");
      return;
    case "hardBreak":
      out.push("\n");
      return;
    case "mention":
      out.push(String(node.attrs?.text ?? ""));
      return;
    case "emoji":
      out.push(String(node.attrs?.text ?? node.attrs?.shortName ?? ""));
      return;
    case "inlineCard":
      out.push(String(node.attrs?.url ?? ""));
      return;
    case "listItem":
      // The item's own paragraph supplies the trailing newline.
      out.push("• ");
      break;
    case "tableCell":
    case "tableHeader":
      break;
    default:
      break;
  }
  for (const c of node.content ?? []) walk(c, out);
  if (node.type && BLOCKS.has(node.type)) out.push("\n");
  if (node.type === "tableCell" || node.type === "tableHeader") out.push("\t");
}

/** ADF document (or a plain string, as some endpoints return) → bounded text. */
export function adfToText(doc: unknown): string {
  if (doc === null || doc === undefined) return "";
  if (typeof doc === "string") return plainText(doc);
  if (typeof doc !== "object") return "";
  const out: string[] = [];
  walk(doc as AdfNode, out);
  return plainText(out.join(""));
}
