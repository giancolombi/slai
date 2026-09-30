import { auditEvents } from "@slai/db";
import type { AuditEvent } from "@slai/shared";
import { desc, lt } from "drizzle-orm";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, auth } from "../context.js";
import { requireRole } from "../middleware/auth.js";
import { decodeCursor, idCursor, page, pageQuery } from "../pagination.js";
import { query } from "../validate.js";

export function auditRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get("/", requireRole("admin"), async (c) => {
    const q = query(c, pageQuery);
    const cur = decodeCursor(q.cursor, idCursor);
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(cur ? lt(auditEvents.id, cur.id) : undefined)
        .orderBy(desc(auditEvents.id))
        .limit(q.limit + 1),
    );
    const toDto = (r: (typeof rows)[number]): AuditEvent => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: { type: r.actorType, id: r.actorId, name: r.actorName },
      action: r.action,
      target: { type: r.targetType, id: r.targetId },
      metadata: r.metadata,
      ip: r.ip,
    });
    return c.json(page(rows, q.limit, toDto, (r) => ({ id: r.id })));
  });

  return app;
}
