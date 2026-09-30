import { createHash } from "node:crypto";
import { auditEvents } from "@slai/db";
import type { Contract } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addMember, setupApp, signup } from "./harness.js";

const ctx = setupApp();

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("1 0 obj << /Type /Catalog >> endobj\n%%EOF\n")]);
const DOCX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("....[Content_Types].xml....word/document.xml...."),
]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100, 0x90)]);

function form(bytes: Uint8Array<ArrayBuffer>, filename: string, extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("file", new File([bytes], filename, { type: "application/pdf" }));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

describe("contract upload", () => {
  it("accepts a PDF by magic bytes, stores it, audits it, and enqueues extraction", async () => {
    const { client, orgId } = await signup(ctx);
    const res = await client.req<Contract>("POST", "/contracts", { body: form(PDF, "msa.pdf") });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ filename: "msa.pdf", status: "uploaded", extraction: null });

    const file = await client.get(`/contracts/${res.body.id}/file`);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toMatch(/^attachment;/);

    const [job] = await ctx.owner.client`select name, data from pgboss.job where data->>'contractId' = ${res.body.id}`;
    expect(job).toEqual({ name: "extract-contract", data: { orgId, contractId: res.body.id } });
    const audited = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "contract.uploaded")));
    expect(audited[0]!.metadata).toMatchObject({ sha256: createHash("sha256").update(PDF).digest("hex") });
  });

  it("accepts docx, txt and md", async () => {
    const { client } = await signup(ctx);
    expect((await client.req("POST", "/contracts", { body: form(DOCX, "sla.docx") })).status).toBe(201);
    expect(
      (await client.req("POST", "/contracts", { body: form(Buffer.from("Response within 1 hour."), "sla.txt") }))
        .status,
    ).toBe(201);
    expect(
      (await client.req("POST", "/contracts", { body: form(Buffer.from("# SLA\n\n- P1: 1h"), "sla.md") })).status,
    ).toBe(201);
  });

  it("rejects files whose content does not match an allowed type, whatever the extension", async () => {
    const { client } = await signup(ctx);
    const cases: [Uint8Array<ArrayBuffer>, string][] = [
      [EXE, "contract.pdf"], // executable renamed
      [PDF, "contract.txt"], // pdf content, text extension
      [Buffer.from([0x00, 0x01, 0x02, 0xff]), "notes.txt"], // binary as text
      [Buffer.from("plain text"), "contract.html"], // disallowed extension
      [DOCX.subarray(0, 4), "sla.docx"], // zip that is not a docx
    ];
    for (const [bytes, name] of cases) {
      const res = await client.req("POST", "/contracts", { body: form(bytes, name) });
      expect(res.status, name).toBe(415);
      expect(res.body.error.code).toBe("unsupported_media_type");
    }
  });

  it("rejects missing, empty and oversized files", async () => {
    const { client } = await signup(ctx);
    const empty = new FormData();
    expect((await client.req("POST", "/contracts", { body: empty })).status).toBe(400);
    expect((await client.req("POST", "/contracts", { body: form(new Uint8Array(0), "a.pdf") })).status).toBe(400);
    const big = Buffer.concat([PDF, Buffer.alloc(20 * 1024 * 1024 + 1, 0x20)]);
    const res = await client.req("POST", "/contracts", { body: form(big, "big.pdf") });
    expect(res.status).toBe(413);
  });

  it("rejects another org's customer id and viewer uploads", async () => {
    const a = await signup(ctx);
    const b = await signup(ctx);
    const cust = await a.client.post("/customers", { name: "A cust" });
    const res = await b.client.req("POST", "/contracts", {
      body: form(PDF, "x.pdf", { customerAccountId: cust.body.id }),
    });
    expect(res.status).toBe(400);
    const viewer = await addMember(ctx, a.orgId, "viewer");
    expect((await viewer.client.req("POST", "/contracts", { body: form(PDF, "x.pdf") })).status).toBe(403);
  });
});
