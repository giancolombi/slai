import { audit, connections, replays } from "@slai/db";
import { createReplayBody } from "@slai/shared";
import { desc, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, auditBase, auth } from "../context.js";
import { notFound } from "../errors.js";
import { toReplay } from "../mappers.js";
import { assertInOrg } from "../org-refs.js";
import { decodeCursor, idCursor, page, pageQuery } from "../pagination.js";
import { body, idParam, query } from "../validate.js";

export function replayRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const q = query(c, pageQuery);
    const cur = decodeCursor(q.cursor, idCursor);
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      tx
        .select()
        .from(replays)
        .where(cur ? lt(replays.id, cur.id) : undefined)
        .orderBy(desc(replays.id))
        .limit(q.limit + 1),
    );
    return c.json(page(rows, q.limit, toReplay, (r) => ({ id: r.id })));
  });

  app.post("/", async (c) => {
    const a = auth(c);
    const input = await body(c, createReplayBody);
    const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      await assertInOrg(tx, connections, input.connectionId, "Connection");
      const [r] = await tx
        .insert(replays)
        .values({ orgId: a.orgId, connectionId: input.connectionId, days: input.days, requestedBy: a.user.id })
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "replay.requested",
        target: { type: "replay", id: r!.id },
        metadata: { connectionId: input.connectionId, days: input.days },
      });
      await deps.jobs.send(tx, "run-replay", { orgId: a.orgId, replayId: r!.id });
      return r!;
    });
    return c.json(toReplay(row), 202);
  });

  app.get("/:id", async (c) => {
    const id = idParam(c, "id", "Replay");
    const [row] = await deps.orgDb.withOrg(auth(c).orgId, (tx) => tx.select().from(replays).where(eq(replays.id, id)));
    if (!row) throw notFound("Replay");
    return c.json(toReplay(row));
  });

  return app;
}
