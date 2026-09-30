import {
  audit,
  contracts,
  customerAccounts,
  slaPolicies,
  type Tx,
  ticketEvents,
  tickets,
  toEngineEvents,
} from "@slai/db";
import { createPolicyBody, type PolicyPreview, policyPreviewBody, updatePolicyBody } from "@slai/shared";
import {
  computeAttainment,
  computeCredits,
  evaluateTicket,
  parsePolicy,
  type SlaPolicy,
  type TicketEvaluation,
} from "@slai/sla-engine";
import { and, asc, desc, eq, gte, inArray, lt, max, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AppDeps, type AppEnv, auditBase, auth } from "../context.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { toPolicy } from "../mappers.js";
import { requireRole } from "../middleware/auth.js";
import { assertInOrg } from "../org-refs.js";
import { decodeCursor, idCursor, page, pageQuery } from "../pagination.js";
import { nameOf, userNames } from "../people.js";
import { body, idParam, query } from "../validate.js";

const PREVIEW_MAX_TICKETS = 2000;

/** Validates an untrusted definition with the engine; the server owns `id` and `name`. */
export function validDefinition(definition: unknown, id: string, name: string): SlaPolicy {
  const input = typeof definition === "object" && definition !== null ? definition : {};
  try {
    return parsePolicy({ ...input, id, name });
  } catch (e) {
    const issues =
      e instanceof z.ZodError
        ? e.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
        : [{ path: "", message: (e as Error).message }];
    throw new ApiError(
      422,
      "invalid_policy",
      "This policy has errors. Fix the highlighted fields and save again.",
      issues,
    );
  }
}

/** The DTO with the approver's display name. */
async function policyDto(tx: Tx, p: typeof slaPolicies.$inferSelect) {
  return toPolicy(p, nameOf(await userNames(tx, [p.approvedBy]), p.approvedBy));
}

async function loadPolicy(tx: Tx, id: string, lock = false) {
  const q = tx.select().from(slaPolicies).where(eq(slaPolicies.id, id));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("Policy");
  return row;
}

export function policyRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const q = query(c, pageQuery.extend({ status: z.enum(["draft", "active", "superseded", "archived"]).optional() }));
    const cur = decodeCursor(q.cursor, idCursor);
    const res = await deps.orgDb.withOrg(auth(c).orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(slaPolicies)
        .where(
          and(q.status ? eq(slaPolicies.status, q.status) : undefined, cur ? lt(slaPolicies.id, cur.id) : undefined),
        )
        .orderBy(desc(slaPolicies.id))
        .limit(q.limit + 1);
      const names = await userNames(
        tx,
        rows.map((r) => r.approvedBy),
      );
      return page(
        rows,
        q.limit,
        (r) => toPolicy(r, nameOf(names, r.approvedBy)),
        (r) => ({ id: r.id }),
      );
    });
    return c.json(res);
  });

  app.post("/", async (c) => {
    const a = auth(c);
    const input = await body(c, createPolicyBody);
    const id = crypto.randomUUID();
    const definition = validDefinition(input.definition, id, input.name);
    const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      await assertInOrg(tx, contracts, input.contractId, "Contract");
      let lineageId: string = id;
      let version = 1;
      if (input.basedOn) {
        const base = await loadPolicy(tx, input.basedOn);
        lineageId = base.lineageId;
        const [m] = await tx
          .select({ v: max(slaPolicies.version) })
          .from(slaPolicies)
          .where(eq(slaPolicies.lineageId, lineageId));
        version = (m?.v ?? 0) + 1;
      }
      const [r] = await tx
        .insert(slaPolicies)
        .values({
          id,
          orgId: a.orgId,
          lineageId,
          name: input.name,
          version,
          status: "draft",
          definition,
          isDefault: input.isDefault,
          contractId: input.contractId,
          createdBy: a.user.id,
        })
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "policy.created",
        target: { type: "policy", id },
        metadata: { name: input.name, version, lineageId },
      });
      return r!;
    });
    return c.json(toPolicy(row), 201);
  });

  app.get("/:id", async (c) => {
    const id = idParam(c, "id", "Policy");
    return c.json(await deps.orgDb.withOrg(auth(c).orgId, async (tx) => policyDto(tx, await loadPolicy(tx, id))));
  });

  app.patch("/:id", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Policy");
    const input = await body(c, updatePolicyBody);
    const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const p = await loadPolicy(tx, id, true);
      if (p.status !== "draft")
        throw conflict("Only draft policies can be edited. Create a new version instead.", "not_draft");
      const name = input.name ?? p.name;
      const definition =
        input.definition !== undefined || input.name !== undefined
          ? validDefinition(input.definition ?? p.definition, id, name)
          : undefined;
      const [r] = await tx
        .update(slaPolicies)
        .set({
          name,
          ...(definition && { definition }),
          ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
        })
        .where(eq(slaPolicies.id, id))
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "policy.updated",
        target: { type: "policy", id },
        metadata: { fields: Object.keys(input) },
      });
      return r!;
    });
    return c.json(toPolicy(row));
  });

  app.post("/:id/approve", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Policy");
    const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const p = await loadPolicy(tx, id, true);
      if (p.status !== "draft") throw conflict("Only draft policies can be approved.", "not_draft");
      validDefinition(p.definition, p.id, p.name); // never activate anything the engine rejects
      const [prior] = await tx
        .select()
        .from(slaPolicies)
        .where(and(eq(slaPolicies.lineageId, p.lineageId), eq(slaPolicies.status, "active")))
        .for("update");
      const isDefault = p.isDefault || (prior?.isDefault ?? false);
      if (prior)
        await tx
          .update(slaPolicies)
          .set({ status: "superseded", isDefault: false })
          .where(eq(slaPolicies.id, prior.id));
      if (isDefault) {
        await tx
          .update(slaPolicies)
          .set({ isDefault: false })
          .where(and(eq(slaPolicies.status, "active"), eq(slaPolicies.isDefault, true), ne(slaPolicies.id, id)));
      }
      const [r] = await tx
        .update(slaPolicies)
        .set({ status: "active", isDefault, approvedBy: a.user.id, approvedAt: deps.now() })
        .where(eq(slaPolicies.id, id))
        .returning();
      if (prior) await tx.update(customerAccounts).set({ policyId: id }).where(eq(customerAccounts.policyId, prior.id));
      if (p.contractId) {
        await tx
          .update(contracts)
          .set({ status: "approved" })
          .where(and(eq(contracts.id, p.contractId), eq(contracts.status, "needs_review")));
      }
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "policy.approved",
        target: { type: "policy", id },
        metadata: {
          name: p.name,
          version: p.version,
          lineageId: p.lineageId,
          supersededPolicyId: prior?.id ?? null,
          isDefault,
        },
      });
      return r!;
    });
    return c.json(toPolicy(row, a.user.name));
  });

  app.post("/:id/archive", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Policy");
    const row = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const p = await loadPolicy(tx, id, true);
      if (p.status === "archived") return policyDto(tx, p);
      const [r] = await tx
        .update(slaPolicies)
        .set({ status: "archived", isDefault: false })
        .where(eq(slaPolicies.id, id))
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "policy.archived",
        target: { type: "policy", id },
        metadata: { from: p.status, version: p.version },
      });
      return policyDto(tx, r!);
    });
    return c.json(row);
  });

  app.post("/:id/preview", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Policy");
    const input = await body(c, policyPreviewBody);
    const now = deps.now();
    const result = await deps.orgDb.withOrg(a.orgId, async (tx): Promise<PolicyPreview> => {
      const p = await loadPolicy(tx, id);
      const policy = validDefinition(p.definition, p.id, p.name);
      const since = new Date(now.getTime() - input.days * 86_400_000);
      const ts = await tx
        .select({ id: tickets.id, customerAccountId: tickets.customerAccountId })
        .from(tickets)
        .where(
          and(
            gte(tickets.createdAtSource, since),
            input.connectionId ? eq(tickets.connectionId, input.connectionId) : undefined,
          ),
        )
        .orderBy(desc(tickets.createdAtSource))
        .limit(PREVIEW_MAX_TICKETS);
      const events = ts.length
        ? await tx
            .select({
              ticketId: ticketEvents.ticketId,
              type: ticketEvents.type,
              at: ticketEvents.at,
              payload: ticketEvents.payload,
            })
            .from(ticketEvents)
            .where(
              inArray(
                ticketEvents.ticketId,
                ts.map((t) => t.id),
              ),
            )
            .orderBy(asc(ticketEvents.at), asc(ticketEvents.id))
        : [];
      const fees = new Map(
        (
          await tx.select({ id: customerAccounts.id, fee: customerAccounts.monthlyFeeCents }).from(customerAccounts)
        ).map((r) => [r.id, r.fee ?? 0]),
      );
      const eventsByTicket = new Map<string, typeof events>();
      for (const e of events) {
        const list = eventsByTicket.get(e.ticketId);
        if (list) list.push(e);
        else eventsByTicket.set(e.ticketId, [e]);
      }
      const byCustomer = new Map<string | null, TicketEvaluation[]>();
      const all: TicketEvaluation[] = [];
      for (const t of ts) {
        try {
          const ev = evaluateTicket(policy, toEngineEvents(eventsByTicket.get(t.id) ?? []), now);
          all.push(ev);
          const list = byCustomer.get(t.customerAccountId) ?? [];
          list.push(ev);
          byCustomer.set(t.customerAccountId, list);
        } catch {
          // Tickets without a usable history are skipped, as in replay.
        }
      }
      let exposureCents = 0;
      for (const [customerId, evals] of byCustomer) {
        exposureCents += computeCredits(policy.credits, evals, customerId ? (fees.get(customerId) ?? 0) : 0).totalCents;
      }
      const att = computeAttainment(all);
      return {
        days: input.days,
        tickets: all.length,
        breaches: att.breached,
        attainmentPercent: att.percent,
        exposureCents,
      };
    });
    return c.json(result);
  });

  return app;
}
