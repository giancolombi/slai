import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { auditEvents } from "@slai/db";
import type { Contract, ContractText } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { boundPages } from "../src/contract-text.js";
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
    const { client, orgId, userId } = await signup(ctx);
    const res = await client.req<Contract>("POST", "/contracts", { body: form(PDF, "msa.pdf") });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ filename: "msa.pdf", status: "uploaded", extraction: null });
    // `uploadedBy` is the user id; the display name comes alongside.
    expect(res.body).toMatchObject({ uploadedBy: userId, uploadedByName: "Ada" });
    expect((await client.get<Contract>(`/contracts/${res.body.id}`)).body).toMatchObject({
      uploadedBy: userId,
      uploadedByName: "Ada",
    });

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

  it("returns the extracted text with PDF page boundaries, audited, and only to its own org", async () => {
    const a = await signup(ctx);
    const b = await signup(ctx);
    const pdf = readFileSync(new URL("../../../packages/agents/test/fixtures/globex-exhibit.pdf", import.meta.url));
    const up = await a.client.req<Contract>("POST", "/contracts", {
      body: form(new Uint8Array(pdf), "globex-exhibit.pdf"),
    });
    expect(up.status).toBe(201);
    const res = await a.client.get<ContractText>(`/contracts/${up.body.id}/text`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contractId: up.body.id, filename: "globex-exhibit.pdf", truncated: false });
    expect(res.body.pages.length).toBeGreaterThan(0);
    expect(res.body.pages[0]!.page).toBe(1);
    expect(res.body.pages.map((p) => p.text).join(" ")).toMatch(/first response within 1 hour/i);
    const audited = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, a.orgId), eq(auditEvents.action, "contract.text_viewed")));
    expect(audited).toHaveLength(1);
    // RLS: another org can't read it, even by id.
    expect((await b.client.get(`/contracts/${up.body.id}/text`)).status).toBe(404);

    const txt = await a.client.req<Contract>("POST", "/contracts", {
      body: form(Buffer.from("Critical: respond within 1 hour.\nNormal: within 1 day."), "sla.txt"),
    });
    const plain = await a.client.get<ContractText>(`/contracts/${txt.body.id}/text`);
    expect(plain.body.pages).toEqual([{ page: null, text: "Critical: respond within 1 hour.\nNormal: within 1 day." }]);
  });

  it("bounds the text it returns", () => {
    const pages = [
      { page: 1, text: "a".repeat(6) },
      { page: 2, text: "b".repeat(6) },
      { page: 3, text: "c" },
    ];
    expect(boundPages(pages, 20)).toEqual({ pages, truncated: false });
    expect(boundPages(pages, 9)).toEqual({
      pages: [
        { page: 1, text: "aaaaaa" },
        { page: 2, text: "bbb" },
      ],
      truncated: true,
    });
    expect(boundPages(pages, 6)).toEqual({ pages: [{ page: 1, text: "aaaaaa" }], truncated: true });
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
