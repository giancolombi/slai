import { audit, customerAccounts, slaOutcomes, slaPolicies, type Tx, tickets } from "@slai/db";
import { upsertCustomerBody } from "@slai/shared";
import { and, asc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, auditBase, auth } from "../context.js";
import { conflict, notFound } from "../errors.js";
import { toCustomer } from "../mappers.js";
import { assertInOrg, currentPeriod } from "../org-refs.js";
import { body, idParam } from "../validate.js";

const CLOSED = ["solved", "closed"] as const;

async function stats(tx: Tx, now: Date, ids: string[]) {
  const out = new Map<string, { openTickets: number; atRiskTickets: number; breachesThisPeriod: number }>();
  for (const id of ids) out.set(id, { openTickets: 0, atRiskTickets: 0, breachesThisPeriod: 0 });
  if (ids.length === 0) return out;
  const open = await tx
    .select({
      id: tickets.customerAccountId,
      open: sql<number>`count(*)::int`,
      atRisk: sql<number>`count(*) filter (where ${tickets.risk} in ('at_risk', 'breached'))::int`,
    })
    .from(tickets)
    .where(and(inArray(tickets.customerAccountId, ids), notInArray(tickets.status, [...CLOSED])))
    .groupBy(tickets.customerAccountId);
  const { start, end } = currentPeriod(now);
  const breaches = await tx
    .select({ id: tickets.customerAccountId, n: sql<number>`count(*)::int` })
    .from(slaOutcomes)
    .innerJoin(tickets, eq(tickets.id, slaOutcomes.ticketId))
    .where(
      and(
        inArray(tickets.customerAccountId, ids),
        eq(slaOutcomes.state, "breached"),
        gte(slaOutcomes.breachAt, start),
        lt(slaOutcomes.breachAt, end),
      ),
    )
    .groupBy(tickets.customerAccountId);
  for (const r of open) if (r.id) Object.assign(out.get(r.id)!, { openTickets: r.open, atRiskTickets: r.atRisk });
  for (const r of breaches) if (r.id) out.get(r.id)!.breachesThisPeriod = r.n;
  return out;
}

export function customerRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const items = await deps.orgDb.withOrg(auth(c).orgId, async (tx) => {
      const rows = await tx.select().from(customerAccounts).orderBy(asc(customerAccounts.name));
      const s = await stats(
        tx,
        deps.now(),
        rows.map((r) => r.id),
      );
      return rows.map((r) => toCustomer(r, s.get(r.id)!));
    });
    return c.json({ items, nextCursor: null });
  });

  app.post("/", async (c) => {
    const a = auth(c);
    const input = await body(c, upsertCustomerBody);
    const dto = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      await assertInOrg(tx, slaPolicies, input.policyId, "Policy");
      const [row] = await tx
        .insert(customerAccounts)
        .values({ orgId: a.orgId, ...input })
        .onConflictDoNothing()
        .returning();
      if (!row) throw conflict("A customer with this name already exists.");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "customer.created",
        target: { type: "customer_account", id: row.id },
      });
      return toCustomer(row, { openTickets: 0, atRiskTickets: 0, breachesThisPeriod: 0 });
    });
    return c.json(dto, 201);
  });

  app.patch("/:id", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Customer");
    const input = await body(c, upsertCustomerBody.partial());
    const dto = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      await assertInOrg(tx, slaPolicies, input.policyId, "Policy");
      const [row] = await tx.update(customerAccounts).set(input).where(eq(customerAccounts.id, id)).returning();
      if (!row) throw notFound("Customer");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "customer.updated",
        target: { type: "customer_account", id },
        metadata: { fields: Object.keys(input) },
      });
      return toCustomer(row, (await stats(tx, deps.now(), [id])).get(id)!);
    });
    return c.json(dto);
  });

  app.delete("/:id", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Customer");
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [row] = await tx
        .delete(customerAccounts)
        .where(eq(customerAccounts.id, id))
        .returning({ name: customerAccounts.name });
      if (!row) throw notFound("Customer");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "customer.deleted",
        target: { type: "customer_account", id },
        metadata: row,
      });
    });
    return c.body(null, 204);
  });

  return app;
}
