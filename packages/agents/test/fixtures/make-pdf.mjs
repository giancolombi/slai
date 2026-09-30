// Regenerates globex-exhibit.pdf from globex-exhibit.txt: a minimal two-page
// PDF (Helvetica, one text line per row). Run: node test/fixtures/make-pdf.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(here, "globex-exhibit.txt"), "utf8").trimEnd().split("\n");
// Page 1: header, hours and targets. Page 2: credits and the injection line.
const split = lines.findIndex((l) => l.startsWith("For each Critical"));
const pages = [lines.slice(0, split), lines.slice(split)];

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const content = (ls) => `BT /F1 10 Tf 12 TL 40 800 Td ${ls.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;

const objects = [];
const add = (body) => {
  objects.push(body);
  return objects.length;
};
const catalog = add("");
const pagesObj = add("");
const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
const pageIds = pages.map((ls) => {
  const stream = content(ls);
  const c = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  return add(
    `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 842] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
  );
});
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
objects[pagesObj - 1] =
  `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

let pdf = "%PDF-1.4\n";
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(here, "globex-exhibit.pdf"), pdf);
