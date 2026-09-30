import { agentActions, audit, autonomyRules, customerAccounts, type Tx, tickets } from "@slai/db";
import { type AutonomyRule, approveActionBody, autonomyRuleBody, rejectActionBody } from "@slai/shared";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AppDeps, type AppEnv, auditBase, auth, type Ctx } from "../context.js";
import { conflict, notFound } from "../errors.js";
import { toAgentAction } from "../mappers.js";
import { requireRole } from "../middleware/auth.js";
import { assertInOrg } from "../org-refs.js";
import { decodeCursor, idCursor, page, pageQuery } from "../pagination.js";
import { body, idParam, query } from "../validate.js";

const ACTION_STATUSES = ["proposed", "approved", "sending", "sent", "rejected", "failed", "blocked"] as const;

const toRule = (r: typeof autonomyRules.$inferSelect): AutonomyRule => ({
  id: r.id,
  customerAccountId: r.customerAccountId,
  priority: r.priority,
  level: r.level,
  triggerAt: r.triggerAt,
  minConfidence: r.minConfidence,
});

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code === "23505" || err.cause?.code === "23505";
}

export function actionRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  const selectActions = (tx: Tx) =>
    tx
      .select({ a: agentActions, displayKey: tickets.displayKey, subject: tickets.subject })
      .from(agentActions)
      .innerJoin(tickets, eq(tickets.id, agentActions.ticketId));

  app.get("/actions", async (c) => {
    const q = query(c, pageQuery.extend({ status: z.enum(ACTION_STATUSES).optional() }));
    const cur = decodeCursor(q.cursor, idCursor);
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      selectActions(tx)
        .where(
          and(q.status ? eq(agentActions.status, q.status) : undefined, cur ? lt(agentActions.id, cur.id) : undefined),
        )
        .orderBy(desc(agentActions.id))
        .limit(q.limit + 1),
    );
    return c.json(
      page(
        rows,
        q.limit,
        (r) => toAgentAction(r.a, r),
        (r) => ({ id: r.a.id }),
      ),
    );
  });

  const decide = async (c: Ctx, decision: "approved" | "rejected") => {
    const a = auth(c);
    const id = idParam(c, "id", "Action");
    const input = decision === "approved" ? await body(c, approveActionBody) : await body(c, rejectActionBody);
    return deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [row] = await selectActions(tx).where(eq(agentActions.id, id)).for("update", { of: agentActions });
      if (!row) throw notFound("Action");
      if (row.a.status !== "proposed" && row.a.status !== "blocked") {
        throw conflict(`This action is already ${row.a.status}.`, "already_decided");
      }
      const edited = "body" in input && input.body !== undefined && input.body !== row.a.body;
      const [updated] = await tx
        .update(agentActions)
        .set({
          status: decision,
          decidedBy: a.user.id,
          decidedAt: deps.now(),
          ...(edited && "body" in input ? { body: input.body } : {}),
        })
        .where(eq(agentActions.id, id))
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: decision === "approved" ? "action.approved" : "action.rejected",
        target: { type: "agent_action", id },
        metadata: {
          kind: row.a.kind,
          ticketId: row.a.ticketId,
          previousStatus: row.a.status,
          edited,
          ...("reason" in input && input.reason ? { reason: input.reason } : {}),
        },
      });
      // The worker performs (and audits) the help-desk write.
      if (decision === "approved") await deps.jobs.send(tx, "execute-action", { orgId: a.orgId, actionId: id });
      return toAgentAction(updated!, row);
    });
  };

  app.post("/actions/:id/approve", async (c) => c.json(await decide(c, "approved")));
  app.post("/actions/:id/reject", async (c) => c.json(await decide(c, "rejected")));

  // ---------- autonomy rules ----------

  app.get("/autonomy-rules", async (c) => {
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      tx.select().from(autonomyRules).orderBy(asc(autonomyRules.createdAt)),
    );
    return c.json(rows.map(toRule));
  });

  const saveRule = async (c: Ctx, id: string | null) => {
    const a = auth(c);
    const input = await body(c, autonomyRuleBody);
    try {
      return await deps.orgDb.withOrg(a.orgId, async (tx) => {
        await assertInOrg(tx, customerAccounts, input.customerAccountId, "Customer");
        let before: typeof autonomyRules.$inferSelect | undefined;
        let row: typeof autonomyRules.$inferSelect | undefined;
        if (id) {
          [before] = await tx.select().from(autonomyRules).where(eq(autonomyRules.id, id));
          if (!before) throw notFound("Autonomy rule");
          [row] = await tx.update(autonomyRules).set(input).where(eq(autonomyRules.id, id)).returning();
        } else {
          [row] = await tx
            .insert(autonomyRules)
            .values({ orgId: a.orgId, ...input })
            .returning();
        }
        await audit(tx, {
          ...auditBase(c),
          orgId: a.orgId,
          action: id ? "autonomy.updated" : "autonomy.created",
          target: { type: "autonomy_rule", id: row!.id },
          metadata: { before: before ? toRule(before) : null, after: toRule(row!) },
        });
        return toRule(row!);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("A rule for this customer and priority already exists.");
      throw e;
    }
  };

  app.post("/autonomy-rules", requireRole("admin"), async (c) => c.json(await saveRule(c, null), 201));
  app.put("/autonomy-rules/:id", requireRole("admin"), async (c) =>
    c.json(await saveRule(c, idParam(c, "id", "Autonomy rule"))),
  );
  app.delete("/autonomy-rules/:id", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Autonomy rule");
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [row] = await tx.delete(autonomyRules).where(eq(autonomyRules.id, id)).returning();
      if (!row) throw notFound("Autonomy rule");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "autonomy.deleted",
        target: { type: "autonomy_rule", id },
        metadata: { before: toRule(row) },
      });
    });
    return c.body(null, 204);
  });

  return app;
}
