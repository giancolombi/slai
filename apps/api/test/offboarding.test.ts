/**
 * Org offboarding API (T-64): owner-only export and a scheduled, cancellable,
 * audited hard delete. The worker side (bundle content, the delete itself) is
 * tested in apps/worker/test/offboarding.test.ts.
 */
import { randomUUID } from "node:crypto";
import { auditEvents, contracts, exportStorageKey, organizations, orgExports } from "@slai/db";
import type { Offboarding, OrgExport } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addMember, setupApp, signup } from "./harness.js";

const ctx = setupApp();
const DAY = 24 * 60 * 60 * 1000;

const auditActions = async (orgId: string) =>
  (await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.orgId, orgId))).map((e) => e.action);

describe("org deletion", () => {
  it("schedules a hard delete after the grace period, enqueues it, and audits it; cancelling stops it", async () => {
    const owner = await signup(ctx, "Olga");
    const now = new Date("2026-10-01T12:00:00Z");
    ctx.clock.now = now;
    try {
      const name = owner.me.organization.name;
      const wrong = await owner.client.post("/org/deletion", { confirmName: "not the name" });
      expect(wrong.status).toBe(400);

      const res = await owner.client.post<Offboarding>("/org/deletion", { confirmName: name });
      expect(res.status).toBe(200);
      expect(res.body.graceDays).toBe(7);
      expect(res.body.deletion).toMatchObject({
        scheduledFor: new Date(now.getTime() + 7 * DAY).toISOString(),
        requestedAt: now.toISOString(),
        requestedBy: owner.email,
      });
      const [org] = await ctx.owner.db.select().from(organizations).where(eq(organizations.id, owner.orgId));
      expect(org!.deletionScheduledFor?.toISOString()).toBe(new Date(now.getTime() + 7 * DAY).toISOString());
      const [job] = await ctx.owner.client`
        select name, start_after from pgboss.job where name = 'delete-org' and data->>'orgId' = ${owner.orgId}`;
      expect(new Date(job!.start_after).toISOString()).toBe(new Date(now.getTime() + 7 * DAY).toISOString());

      expect((await owner.client.post("/org/deletion", { confirmName: name })).status).toBe(409);
      const [scheduled] = await ctx.owner.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, owner.orgId), eq(auditEvents.action, "org.deletion.scheduled")));
      expect(scheduled).toMatchObject({ actorType: "user", actorId: owner.userId });
      expect(scheduled!.metadata).toMatchObject({ graceDays: 7 });

      const cancel = await owner.client.del<Offboarding>("/org/deletion");
      expect(cancel.status).toBe(200);
      expect(cancel.body.deletion).toBeNull();
      const [after] = await ctx.owner.db.select().from(organizations).where(eq(organizations.id, owner.orgId));
      expect(after!.deletionScheduledFor).toBeNull();
      expect((await owner.client.del("/org/deletion")).status).toBe(409);
      expect(await auditActions(owner.orgId)).toEqual(
        expect.arrayContaining(["org.deletion.scheduled", "org.deletion.cancelled"]),
      );
    } finally {
      ctx.clock.now = null;
    }
  });

  it("is owner-only", async () => {
    const owner = await signup(ctx, "Otto");
    const admin = await addMember(ctx, owner.orgId, "admin");
    const name = owner.me.organization.name;
    expect((await admin.client.post("/org/deletion", { confirmName: name })).status).toBe(403);
    expect((await admin.client.get("/org/offboarding")).status).toBe(403);
    expect((await admin.client.post("/org/exports")).status).toBe(403);
    const [org] = await ctx.owner.db.select().from(organizations).where(eq(organizations.id, owner.orgId));
    expect(org!.deletionScheduledFor).toBeNull();
  });
});

describe("org export", () => {
  it("queues one export at a time, audits the request, and serves the finished bundle to the owner", async () => {
    const owner = await signup(ctx, "Esme");
    const res = await owner.client.post<OrgExport>("/org/exports");
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "queued", requestedBy: owner.email });
    const [job] = await ctx.owner.client`
      select data from pgboss.job where name = 'export-org' and data->>'exportId' = ${res.body.id}`;
    expect(job!.data).toEqual({ orgId: owner.orgId, exportId: res.body.id });
    expect((await owner.client.post("/org/exports")).status).toBe(409);

    // Not ready yet.
    expect((await owner.client.get(`/org/exports/${res.body.id}/download`)).status).toBe(409);

    // Simulate the worker finishing the bundle.
    const key = exportStorageKey(owner.orgId, res.body.id);
    const bundle = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]);
    await ctx.deps.storage.put(key, bundle, { contentType: "application/gzip", sha256: "x" });
    await ctx.owner.db
      .update(orgExports)
      .set({ status: "succeeded", storageKey: key, sizeBytes: bundle.length, sha256: "x", finishedAt: new Date() })
      .where(eq(orgExports.id, res.body.id));

    const state = await owner.client.get<Offboarding>("/org/offboarding");
    expect(state.body.exports[0]).toMatchObject({ id: res.body.id, status: "succeeded", sizeBytes: 7 });
    const dl = await owner.client.get(`/org/exports/${res.body.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/gzip");
    expect(dl.headers.get("content-disposition")).toMatch(
      /attachment; filename="slai-export-\d{4}-\d{2}-\d{2}\.tar\.gz"/,
    );
    expect(await auditActions(owner.orgId)).toEqual(
      expect.arrayContaining(["org.export.requested", "org.export.downloaded"]),
    );

    // Another org cannot fetch it (RLS), and an unknown id is a 404.
    const other = await signup(ctx, "Mallory");
    expect((await other.client.get(`/org/exports/${res.body.id}/download`)).status).toBe(404);
    expect((await owner.client.get(`/org/exports/${randomUUID()}/download`)).status).toBe(404);
  });
});

describe("contract archive", () => {
  it("archives (admin), stamps archived_at for the retention job, and audits", async () => {
    const owner = await signup(ctx, "Arch");
    const id = randomUUID();
    await ctx.owner.db.insert(contracts).values({
      id,
      orgId: owner.orgId,
      storageKey: `${owner.orgId}/contracts/${id}`,
      filename: "old.pdf",
      sha256: "x",
      mediaType: "application/pdf",
      sizeBytes: 1,
      status: "approved",
    });
    const member = await addMember(ctx, owner.orgId, "member");
    expect((await member.client.post(`/contracts/${id}/archive`)).status).toBe(403);
    const res = await owner.client.post(`/contracts/${id}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("archived");
    const [row] = await ctx.owner.db.select().from(contracts).where(eq(contracts.id, id));
    expect(row!.archivedAt).not.toBeNull();
    expect(await auditActions(owner.orgId)).toContain("contract.archived");
  });
});
