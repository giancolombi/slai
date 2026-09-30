/**
 * Org offboarding (T-64, owner only): export all org data as a downloadable
 * bundle, and schedule a hard delete after a grace period (cancellable). Every
 * step is audited. The worker builds exports and performs the delete.
 */
import { audit, organizations, orgExports, type Tx, users } from "@slai/db";
import { type Offboarding, ORG_DELETION_GRACE_DAYS, type OrgExport, scheduleDeletionBody } from "@slai/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, auditBase, auth } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { requireRole } from "../middleware/auth.js";
import { body, idParam } from "../validate.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Export bundles are deleted by the retention job after this. */
export const EXPORT_TTL_MS = 7 * DAY_MS;

export function offboardingRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("/org/offboarding", requireRole("owner"));
  app.use("/org/exports", requireRole("owner"));
  app.use("/org/exports/*", requireRole("owner"));
  app.use("/org/deletion", requireRole("owner"));

  const state = async (tx: Tx): Promise<Offboarding> => {
    const [org] = await tx
      .select({ o: organizations, by: users.email })
      .from(organizations)
      .leftJoin(users, eq(users.id, organizations.deletionRequestedBy));
    if (!org) throw notFound("Organization");
    const rows = await tx
      .select({ e: orgExports, by: users.email })
      .from(orgExports)
      .leftJoin(users, eq(users.id, orgExports.requestedBy))
      .orderBy(desc(orgExports.createdAt))
      .limit(10);
    const now = deps.now();
    return {
      graceDays: ORG_DELETION_GRACE_DAYS,
      deletion: org.o.deletionScheduledFor
        ? {
            scheduledFor: org.o.deletionScheduledFor.toISOString(),
            requestedAt: (org.o.deletionRequestedAt ?? org.o.deletionScheduledFor).toISOString(),
            requestedBy: org.by,
          }
        : null,
      exports: rows.filter((r) => r.e.expiresAt > now).map((r) => toExport(r.e, r.by)),
    };
  };

  app.get("/org/offboarding", async (c) => c.json(await deps.orgDb.withOrg(auth(c).orgId, state)));

  app.post("/org/exports", async (c) => {
    const a = auth(c);
    const dto = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [busy] = await tx
        .select({ id: orgExports.id })
        .from(orgExports)
        .where(inArray(orgExports.status, ["queued", "running"]));
      if (busy) throw conflict("An export is already being prepared.", "export_in_progress");
      const [row] = await tx
        .insert(orgExports)
        .values({ orgId: a.orgId, requestedBy: a.user.id, expiresAt: new Date(deps.now().getTime() + EXPORT_TTL_MS) })
        .returning();
      await deps.jobs.send(tx, "export-org", { orgId: a.orgId, exportId: row!.id });
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "org.export.requested",
        target: { type: "org_export", id: row!.id },
      });
      return toExport(row!, a.user.email);
    });
    return c.json(dto, 202);
  });

  app.get("/org/exports/:id/download", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Export");
    const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [r] = await tx.select().from(orgExports).where(eq(orgExports.id, id));
      if (!r || r.expiresAt <= deps.now()) throw notFound("Export");
      if (r.status !== "succeeded" || !r.storageKey) throw conflict("This export is not ready.", "export_not_ready");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "org.export.downloaded",
        target: { type: "org_export", id },
        metadata: { sizeBytes: r.sizeBytes, sha256: r.sha256 },
      });
      return r;
    });
    const bytes = await deps.storage.get(row.storageKey!);
    const day = row.createdAt.toISOString().slice(0, 10);
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="slai-export-${day}.tar.gz"`,
      "Content-Length": String(bytes.byteLength),
    });
  });

  app.post("/org/deletion", async (c) => {
    const a = auth(c);
    const input = await body(c, scheduleDeletionBody);
    const dto = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [org] = await tx.select().from(organizations).for("update");
      if (!org) throw notFound("Organization");
      if (input.confirmName.trim() !== org.name.trim()) {
        throw badRequest("Type the organization's name exactly to confirm.");
      }
      if (org.deletionScheduledFor) throw conflict("Deletion is already scheduled.", "deletion_scheduled");
      const now = deps.now();
      const scheduledFor = new Date(now.getTime() + ORG_DELETION_GRACE_DAYS * DAY_MS);
      await tx
        .update(organizations)
        .set({ deletionScheduledFor: scheduledFor, deletionRequestedAt: now, deletionRequestedBy: a.user.id })
        .where(eq(organizations.id, a.orgId));
      // The job re-checks the schedule when it runs, so a cancel makes it a no-op;
      // the hourly retention job also picks up anything this misses.
      await deps.jobs.send(tx, "delete-org", { orgId: a.orgId }, { startAfter: scheduledFor });
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "org.deletion.scheduled",
        target: { type: "organization", id: a.orgId },
        metadata: { scheduledFor: scheduledFor.toISOString(), graceDays: ORG_DELETION_GRACE_DAYS },
      });
      return state(tx);
    });
    return c.json(dto);
  });

  app.delete("/org/deletion", async (c) => {
    const a = auth(c);
    const dto = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [org] = await tx.select().from(organizations).for("update");
      if (!org) throw notFound("Organization");
      if (!org.deletionScheduledFor) throw conflict("No deletion is scheduled.", "deletion_not_scheduled");
      await tx
        .update(organizations)
        .set({ deletionScheduledFor: null, deletionRequestedAt: null, deletionRequestedBy: null })
        .where(and(eq(organizations.id, a.orgId)));
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "org.deletion.cancelled",
        target: { type: "organization", id: a.orgId },
        metadata: { wasScheduledFor: org.deletionScheduledFor.toISOString() },
      });
      return state(tx);
    });
    return c.json(dto);
  });

  return app;
}

function toExport(e: typeof orgExports.$inferSelect, requestedBy: string | null): OrgExport {
  return {
    id: e.id,
    status: e.status,
    sizeBytes: e.sizeBytes,
    sha256: e.sha256,
    error: e.error,
    requestedBy,
    createdAt: e.createdAt.toISOString(),
    finishedAt: e.finishedAt?.toISOString() ?? null,
    expiresAt: e.expiresAt.toISOString(),
  };
}
