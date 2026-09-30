import { createHash, randomUUID } from "node:crypto";
import { audit, contractStorageKey, contracts, customerAccounts, slaPolicies, type Tx, users } from "@slai/db";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AppDeps, type AppEnv, auditBase, auth } from "../context.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import { toContract } from "../mappers.js";
import { assertInOrg } from "../org-refs.js";
import { decodeCursor, idCursor, page, pageQuery } from "../pagination.js";
import { safeFilename, sniffContract } from "../upload.js";
import { idParam, query } from "../validate.js";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

async function withPolicies(tx: Tx, rows: { c: typeof contracts.$inferSelect; uploader: string | null }[]) {
  const ids = rows.map((r) => r.c.id);
  const pols = ids.length
    ? await tx
        .select({ id: slaPolicies.id, contractId: slaPolicies.contractId })
        .from(slaPolicies)
        .where(inArray(slaPolicies.contractId, ids))
    : [];
  return rows.map((r) =>
    toContract(
      r.c,
      r.uploader,
      pols.filter((p) => p.contractId === r.c.id).map((p) => p.id),
    ),
  );
}

export function contractRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  const selectRows = (tx: Tx) =>
    tx
      .select({ c: contracts, uploader: users.email })
      .from(contracts)
      .leftJoin(users, eq(users.id, contracts.uploadedBy));

  app.get("/", async (c) => {
    const q = query(c, pageQuery);
    const cur = decodeCursor(q.cursor, idCursor);
    const res = await deps.orgDb.withOrg(auth(c).orgId, async (tx) => {
      const rows = await selectRows(tx)
        .where(cur ? lt(contracts.id, cur.id) : undefined)
        .orderBy(desc(contracts.id))
        .limit(q.limit + 1);
      const dtos = await withPolicies(tx, rows.slice(0, q.limit));
      return page(
        rows,
        q.limit,
        (r) => dtos.find((d) => d.id === r.c.id)!,
        (r) => ({ id: r.c.id }),
      );
    });
    return c.json(res);
  });

  app.post("/", async (c) => {
    const a = auth(c);
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      throw badRequest("Expected a multipart/form-data upload.");
    }
    const file = form.file;
    if (!(file instanceof File)) throw badRequest('Attach the contract as the "file" field.');
    if (file.size === 0) throw badRequest("The file is empty.");
    if (file.size > MAX_UPLOAD_BYTES)
      throw new ApiError(413, "payload_too_large", "Contracts must be 20 MB or smaller.");
    const rawCustomer = form.customerAccountId;
    const customerAccountId =
      typeof rawCustomer === "string" && rawCustomer !== "" ? (z.uuid().safeParse(rawCustomer).data ?? null) : null;
    if (typeof rawCustomer === "string" && rawCustomer !== "" && !customerAccountId)
      throw badRequest("Invalid customerAccountId.");

    const filename = safeFilename(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mediaType = sniffContract(bytes, filename);
    if (!mediaType) {
      throw new ApiError(
        415,
        "unsupported_media_type",
        "Upload a PDF, DOCX, TXT or Markdown file (checked by content).",
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = randomUUID();
    const storageKey = contractStorageKey(a.orgId, id);
    await deps.storage.put(storageKey, bytes, { contentType: mediaType, sha256 });
    try {
      const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
        await assertInOrg(tx, customerAccounts, customerAccountId, "Customer");
        const [r] = await tx
          .insert(contracts)
          .values({
            id,
            orgId: a.orgId,
            customerAccountId,
            storageKey,
            filename,
            sha256,
            mediaType,
            sizeBytes: bytes.byteLength,
            uploadedBy: a.user.id,
          })
          .returning();
        await audit(tx, {
          ...auditBase(c),
          orgId: a.orgId,
          action: "contract.uploaded",
          target: { type: "contract", id },
          metadata: { filename, sha256, mediaType, sizeBytes: bytes.byteLength },
        });
        await deps.jobs.send(tx, "extract-contract", { orgId: a.orgId, contractId: id });
        return r!;
      });
      return c.json(toContract(row, a.user.email, []), 201);
    } catch (e) {
      await deps.storage.delete(storageKey).catch(() => {});
      throw e;
    }
  });

  const loadOne = async (tx: Tx, id: string) => {
    const rows = await selectRows(tx).where(eq(contracts.id, id));
    if (!rows[0]) throw notFound("Contract");
    return rows[0];
  };

  app.get("/:id", async (c) => {
    const id = idParam(c, "id", "Contract");
    const dto = await deps.orgDb.withOrg(
      auth(c).orgId,
      async (tx) => (await withPolicies(tx, [await loadOne(tx, id)]))[0]!,
    );
    return c.json(dto);
  });

  app.post("/:id/extract", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Contract");
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const { c: row } = await loadOne(tx, id);
      if (row.status === "extracting") throw conflict("Extraction is already running.");
      if (row.status === "archived") throw conflict("This contract is archived.");
      await tx
        .update(contracts)
        .set({ status: "uploaded", error: null })
        .where(and(eq(contracts.id, id)));
      await deps.jobs.send(tx, "extract-contract", { orgId: a.orgId, contractId: id });
    });
    return c.json({ queued: true }, 202);
  });

  app.get("/:id/file", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Contract");
    const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const { c: r } = await loadOne(tx, id);
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "contract.downloaded",
        target: { type: "contract", id },
      });
      return r;
    });
    const bytes = await deps.storage.get(row.storageKey);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": row.mediaType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      "Content-Length": String(bytes.byteLength),
    });
  });

  return app;
}
