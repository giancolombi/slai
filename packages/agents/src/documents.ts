import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import type { ContractDocument } from "./types.js";

export type { ContractDocument };

export interface LoadedDocument {
  filename: string;
  mediaType: ContractDocument["mediaType"];
  base64: string;
  /** Full plain text (PDF pages joined with form feeds). Used for prompts, the mock and citation checks. */
  text: string;
  /** Per-page text for PDFs, so verified citations can carry a page number. */
  pages: string[] | null;
}

export async function loadDocument(doc: ContractDocument): Promise<LoadedDocument> {
  const buf = Buffer.from(doc.base64, "base64");
  switch (doc.mediaType) {
    case "text/plain":
    case "text/markdown":
      return { ...doc, text: buf.toString("utf8"), pages: null };
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return { ...doc, text: value, pages: null };
    }
    case "application/pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: false });
      const pages = Array.isArray(text) ? text : [text];
      return { ...doc, text: pages.join("\n\f\n"), pages };
    }
  }
}
