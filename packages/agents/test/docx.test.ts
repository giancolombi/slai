import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadDocument } from "../src/documents.js";
import { createAgentRuntime } from "../src/index.js";

/** Builds a minimal .docx (an uncompressed zip) with one paragraph per line. */
function docx(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines
        .map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`)
        .join("")}</w:body></w:document>`,
    ],
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const LINES = [
  "Support Hours: Monday through Friday, 9:00 a.m. to 5:00 p.m. Central Time.",
  "Urgent: first response within 1 hour, 24x7.",
  "High: first response within 4 business hours.",
];
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

describe("DOCX contracts", () => {
  it("converts DOCX to text with mammoth", async () => {
    const d = await loadDocument({
      filename: "msa.docx",
      mediaType: DOCX_TYPE,
      base64: docx(LINES).toString("base64"),
    });
    expect(d.text).toContain("Urgent: first response within 1 hour, 24x7.");
    expect(d.pages).toBeNull();
  });

  it("extracts a policy with citations from a DOCX end to end (mock provider)", async () => {
    const r = await createAgentRuntime({ runtime: "local", provider: "mock" }).extractContract([
      { filename: "msa.docx", mediaType: DOCX_TYPE, base64: docx(LINES).toString("base64") },
    ]);
    if (!r.ok) throw new Error(r.message);
    const [p] = r.output.policies;
    expect(p!.calendar.timezone).toBe("America/Chicago");
    expect(p!.targets).toEqual([
      { metric: "first_response", priority: "urgent", minutes: 60, clock: "calendar" },
      { metric: "first_response", priority: "high", minutes: 240, clock: "business" },
    ]);
    expect(r.output.citations).toHaveLength(3);
    expect(r.output.citations.every((c) => c.document === "msa.docx")).toBe(true);
  });
});
