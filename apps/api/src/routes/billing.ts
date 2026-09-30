/**
 * Billing (T-65): the org's plan, status and period usage; Stripe Checkout,
 * the Customer Portal and credit packs; the Stripe webhook; and manual mode
 * for local development (no Stripe keys). Monitoring is never affected by
 * anything here: billing state only caps agents (see @slai/shared plans.ts).
 */
import {
  audit,
  billingEvents,
  creditGrants,
  loadOrgBilling,
  type OrgBilling,
  organizations,
  periodUsage,
  type Tx,
} from "@slai/db";
import {
  type BillingInvoice,
  type BillingRedirect,
  type BillingStatus,
  type BillingSummary,
  billingCheckoutBody,
  billingPeriod,
  CREDIT_PACKS,
  creditPackCheckoutBody,
  isPlanId,
  manualBillingBody,
  mapStripeStatus,
  PLANS,
  type PlanId,
} from "@slai/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import type { BillingGateway } from "../billing/stripe.js";
import { type AppDeps, type AppEnv, auditBase, auth, type Ctx } from "../context.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors.js";
import { requireRole } from "../middleware/auth.js";
import { body } from "../validate.js";

const manualMode = () =>
  conflict(
    "Online payment isn't available for this organization. Contact slai support to change your plan.",
    "billing_manual",
  );

async function summary(deps: AppDeps, tx: Tx, o: OrgBilling, now: Date): Promise<Omit<BillingSummary, "invoices">> {
  const u = await periodUsage(tx, o, now, billingPeriod(now));
  const e = u.entitlements;
  return {
    mode: deps.billing ? "stripe" : "manual",
    plan: e.plan.id,
    status: o.status,
    state: e.state,
    ceiling: e.ceiling,
    trialEndsAt: o.status === "trialing" ? (o.trialEndsAt?.toISOString() ?? null) : null,
    trialDaysLeft: e.trialDaysLeft,
    pastDueSince: o.pastDueSince?.toISOString() ?? null,
    graceEndsAt: e.graceEndsAt?.toISOString() ?? null,
    hasSubscription: o.stripeSubscriptionId !== null && o.status !== "canceled",
    hasCustomer: o.stripeCustomerId !== null,
    period: { start: u.period.start.toISOString(), end: u.period.end.toISOString() },
    trackedTickets: {
      used: u.tracked,
      limit: u.trackedLimit,
      overage: u.ticketOverage,
      overageCents: u.ticketOverageCents,
    },
    credits: {
      used: u.used,
      included: e.includedCredits,
      purchasedAvailable: u.purchasedAvailable,
      fromIncluded: u.balance.fromIncluded,
      fromPurchased: u.balance.fromPurchased,
      overage: u.balance.overage,
      overageCents: u.creditOverageCents,
      cap: u.balance.cap,
      capOverrideCents: o.capOverrideCents,
      remaining: u.balance.remaining,
    },
    overageBilled: e.overageBilled,
  };
}

function nextMonthStart(now: Date): Date {
  return billingPeriod(now).end;
}

export function billingRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const returnUrl = (q: string) => `${deps.env.APP_URL.replace(/\/$/, "")}/billing?${q}`;

  const load = async (orgId: string) => {
    const now = deps.now();
    return deps.orgDb.withOrg(orgId, async (tx) => {
      const o = await loadOrgBilling(tx);
      if (!o) throw notFound("Organization");
      return { o, s: await summary(deps, tx, o, now) };
    });
  };

  app.get("/billing", async (c) => {
    const { o, s } = await load(auth(c).orgId);
    let invoices: BillingInvoice[] = [];
    if (deps.billing && o.stripeCustomerId) {
      try {
        invoices = await deps.billing.listInvoices(o.stripeCustomerId);
      } catch (e) {
        deps.logger.warn({ requestId: c.get("requestId"), err: (e as Error).message }, "stripe invoices unavailable");
      }
    }
    return c.json({ ...s, invoices } satisfies BillingSummary);
  });

  /** The org's Stripe customer, created on first use (and audited). */
  const ensureCustomer = async (c: Ctx, gw: BillingGateway) => {
    const a = auth(c);
    const { o } = await load(a.orgId);
    if (o.stripeCustomerId) return { o, customerId: o.stripeCustomerId };
    const [org] = await deps.orgDb.withOrg(a.orgId, (tx) =>
      tx.select({ name: organizations.name }).from(organizations),
    );
    const customerId = await gw.createCustomer({ id: a.orgId, name: org?.name ?? "slai customer" }, a.user.email);
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      await tx.update(organizations).set({ stripeCustomerId: customerId }).where(eq(organizations.id, a.orgId));
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "billing.customer_created",
        target: { type: "organization", id: a.orgId },
        metadata: { stripeCustomerId: customerId },
      });
    });
    return { o, customerId };
  };

  app.post("/billing/checkout", requireRole("admin"), async (c) => {
    const gw = deps.billing;
    if (!gw) throw manualMode();
    const a = auth(c);
    const input = await body(c, billingCheckoutBody);
    if (!gw.hasPrice(input.plan))
      throw conflict(
        `The ${PLANS[input.plan]?.name ?? "selected"} plan can't be bought online. Contact slai sales.`,
        "plan_unavailable",
      );
    const { o, customerId } = await ensureCustomer(c, gw);
    let url: string;
    if (o.stripeSubscriptionId && o.status !== "canceled") {
      // Already subscribed: change plans in the Customer Portal (proration handled by Stripe).
      url = await gw.portal({
        customerId,
        returnUrl: returnUrl("portal=return"),
        updateSubscriptionId: o.stripeSubscriptionId,
      });
    } else {
      url = await gw.checkoutSubscription({
        customerId,
        orgId: a.orgId,
        plan: input.plan,
        successUrl: returnUrl("checkout=success"),
        cancelUrl: returnUrl("checkout=canceled"),
        billingCycleAnchor: nextMonthStart(deps.now()),
      });
    }
    await deps.orgDb.withOrg(a.orgId, (tx) =>
      audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "billing.checkout_started",
        target: { type: "organization", id: a.orgId },
        metadata: { plan: input.plan, upgrade: Boolean(o.stripeSubscriptionId && o.status !== "canceled") },
      }),
    );
    return c.json({ url } satisfies BillingRedirect);
  });

  app.post("/billing/portal", requireRole("admin"), async (c) => {
    const gw = deps.billing;
    if (!gw) throw manualMode();
    const { o } = await load(auth(c).orgId);
    if (!o.stripeCustomerId) throw conflict("There is no billing account yet. Choose a plan first.", "no_customer");
    const url = await gw.portal({ customerId: o.stripeCustomerId, returnUrl: returnUrl("portal=return") });
    return c.json({ url } satisfies BillingRedirect);
  });

  app.post("/billing/credit-packs/checkout", requireRole("admin"), async (c) => {
    const gw = deps.billing;
    if (!gw) throw manualMode();
    const a = auth(c);
    const input = await body(c, creditPackCheckoutBody);
    const pack = CREDIT_PACKS.find((p) => p.id === input.pack);
    if (!pack) throw badRequest("That credit pack isn't available. Refresh the page and choose another.");
    const { customerId } = await ensureCustomer(c, gw);
    const url = await gw.checkoutCreditPack({
      customerId,
      orgId: a.orgId,
      pack,
      successUrl: returnUrl("credits=success"),
      cancelUrl: returnUrl("credits=canceled"),
    });
    await deps.orgDb.withOrg(a.orgId, (tx) =>
      audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "billing.credit_pack_checkout_started",
        target: { type: "organization", id: a.orgId },
        metadata: { pack: pack.id, credits: pack.credits, priceCents: pack.priceCents },
      }),
    );
    return c.json({ url } satisfies BillingRedirect);
  });

  /** Manual mode only: set the plan and status directly, or grant credits (local development). */
  app.post("/billing/manual", requireRole("admin"), async (c) => {
    if (deps.billing) throw conflict("Plans are changed through checkout for this organization.", "billing_stripe");
    if (deps.env.NODE_ENV === "production") throw forbidden("Manual billing is not available in production.");
    const a = auth(c);
    const input = await body(c, manualBillingBody);
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const set: Partial<typeof organizations.$inferInsert> = {
        ...(input.plan !== undefined && { plan: input.plan }),
        ...(input.status !== undefined && { billingStatus: input.status }),
        ...(input.trialEndsAt !== undefined && { trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : null }),
        ...(input.pastDueSince !== undefined && {
          pastDueSince: input.pastDueSince ? new Date(input.pastDueSince) : null,
        }),
      };
      if (Object.keys(set).length) await tx.update(organizations).set(set).where(eq(organizations.id, a.orgId));
      if (input.grantCredits) {
        await tx.insert(creditGrants).values({
          orgId: a.orgId,
          credits: input.grantCredits,
          source: "manual",
          grantedBy: a.user.id,
          createdAt: deps.now(),
        });
      }
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "billing.manual_update",
        target: { type: "organization", id: a.orgId },
        metadata: input,
      });
    });
    const { s } = await load(a.orgId);
    return c.json({ ...s, invoices: [] } satisfies BillingSummary);
  });

  return app;
}

// ---------- the Stripe webhook ----------

const meta = z.record(z.string(), z.string()).nullish();
const idOf = z.union([z.string(), z.object({ id: z.string() })]).transform((v) => (typeof v === "string" ? v : v.id));
const checkoutSession = z.object({
  id: z.string(),
  mode: z.string(),
  customer: idOf.nullish(),
  subscription: idOf.nullish(),
  client_reference_id: z.string().nullish(),
  payment_status: z.string().nullish(),
  amount_total: z.number().int().nullish(),
  metadata: meta,
});
const subscription = z.object({
  id: z.string(),
  customer: idOf,
  status: z.string(),
  metadata: meta,
  items: z.object({ data: z.array(z.object({ price: z.object({ id: z.string() }) })) }).optional(),
});
const invoice = z.object({ id: z.string(), customer: idOf.nullish() });

const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

const UUID = z.uuid();

/** Which org an event belongs to: the stored Stripe customer first, else our own org id in its metadata. */
async function resolveOrg(deps: AppDeps, customerId: string | null, orgHint: string | null): Promise<string | null> {
  const sys = deps.systemDb.db;
  if (customerId) {
    const [o] = await sys
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.stripeCustomerId, customerId));
    if (o) return o.id;
  }
  if (orgHint && UUID.safeParse(orgHint).success) {
    const [o] = await sys.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgHint));
    if (o) return o.id;
  }
  return null;
}

type Change = Partial<typeof organizations.$inferInsert>;

/** Applies one verified event to the org (inside its transaction). Returns what changed, for the audit record. */
async function applyEvent(
  tx: Tx,
  gw: BillingGateway,
  orgId: string,
  event: Stripe.Event,
  now: Date,
): Promise<Record<string, unknown>> {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for("update");
  if (!org) return { ignored: "organization not found" };
  const obj = event.data.object as unknown;
  const set: Change = {};
  const out: Record<string, unknown> = {};

  const subscriptionChange = (s: z.infer<typeof subscription>, deleted: boolean) => {
    const status: BillingStatus = deleted ? "canceled" : mapStripeStatus(s.status);
    const isCurrent = !org.stripeSubscriptionId || org.stripeSubscriptionId === s.id;
    // An old subscription ending must not cancel a newer one.
    if (status === "canceled" && !isCurrent) return { ignored: "not the current subscription" };
    const plan =
      s.items?.data.map((i) => gw.planForPrice(i.price.id)).find((p) => p !== null) ??
      (s.metadata?.plan && isPlanId(s.metadata.plan) ? (s.metadata.plan as PlanId) : null);
    set.billingStatus = status;
    set.stripeSubscriptionId = s.id;
    if (!org.stripeCustomerId) set.stripeCustomerId = s.customer;
    if (plan) set.plan = plan;
    if (status === "past_due") set.pastDueSince = org.pastDueSince ?? now;
    else set.pastDueSince = null;
    return {};
  };

  switch (event.type) {
    case "checkout.session.completed": {
      const s = checkoutSession.parse(obj);
      if (s.mode === "subscription") {
        const plan = s.metadata?.plan;
        if (plan && isPlanId(plan)) set.plan = plan;
        if (s.subscription) set.stripeSubscriptionId = s.subscription;
        if (s.customer && !org.stripeCustomerId) set.stripeCustomerId = s.customer;
        set.billingStatus = "active";
        set.pastDueSince = null;
      } else if (s.mode === "payment" && s.metadata?.kind === "credit_pack") {
        const pack = CREDIT_PACKS.find((p) => p.id === s.metadata?.pack);
        if (!pack) return { ignored: "unknown credit pack" };
        if (s.payment_status !== "paid") return { ignored: `payment ${s.payment_status ?? "unknown"}` };
        // One grant per Checkout Session, however many times (or events) it is delivered.
        const granted = await tx
          .insert(creditGrants)
          .values({
            orgId,
            credits: pack.credits,
            source: "credit_pack",
            amountCents: s.amount_total ?? pack.priceCents,
            stripeCheckoutSessionId: s.id,
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: creditGrants.id });
        Object.assign(out, { creditPack: pack.id, credits: pack.credits, granted: granted.length > 0 });
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      Object.assign(out, subscriptionChange(subscription.parse(obj), event.type === "customer.subscription.deleted"));
      break;
    case "invoice.paid":
      invoice.parse(obj);
      if (org.billingStatus === "past_due") {
        set.billingStatus = "active";
        set.pastDueSince = null;
      }
      break;
    case "invoice.payment_failed":
      invoice.parse(obj);
      if (org.billingStatus !== "canceled") {
        set.billingStatus = "past_due";
        set.pastDueSince = org.pastDueSince ?? now;
      }
      break;
  }
  if (Object.keys(set).length) await tx.update(organizations).set(set).where(eq(organizations.id, orgId));
  return {
    ...out,
    from: { plan: org.plan, status: org.billingStatus },
    to: { plan: set.plan ?? org.plan, status: set.billingStatus ?? org.billingStatus },
  };
}

function eventRefs(event: Stripe.Event): { customerId: string | null; orgHint: string | null } {
  const o = event.data.object as { customer?: unknown; metadata?: unknown; client_reference_id?: unknown };
  const customer = typeof o.customer === "string" ? o.customer : ((o.customer as { id?: string } | null)?.id ?? null);
  const metadata = (o.metadata ?? {}) as Record<string, unknown>;
  const hint =
    typeof o.client_reference_id === "string"
      ? o.client_reference_id
      : typeof metadata.orgId === "string"
        ? metadata.orgId
        : null;
  return { customerId: customer, orgHint: hint };
}

/** `POST /billing/webhook`: public, verified by the Stripe-Signature over the raw body, idempotent per event id. */
export function billingWebhookRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.post("/", async (c) => {
    const gw = deps.billing;
    if (!gw) throw notFound("Webhook");
    if (!deps.rateLimits.webhook.take(`stripe:${c.get("ip") ?? "unknown"}`)) {
      throw new ApiError(429, "rate_limited", "Too many requests.");
    }
    const signature = c.req.header("stripe-signature");
    const rawBody = await c.req.text();
    let event: Stripe.Event;
    try {
      if (!signature) throw new Error("missing Stripe-Signature");
      event = gw.constructEvent(rawBody, signature);
    } catch {
      deps.logger.warn({ requestId: c.get("requestId"), ip: c.get("ip") }, "stripe webhook signature rejected");
      throw new ApiError(400, "bad_signature", "Invalid webhook signature.");
    }
    if (!HANDLED.has(event.type)) return c.json({ received: true, ignored: true });

    const refs = eventRefs(event);
    const orgId = await resolveOrg(deps, refs.customerId, refs.orgHint);
    if (!orgId) {
      deps.logger.warn({ eventId: event.id, type: event.type }, "stripe event for an unknown organization");
      return c.json({ received: true, ignored: true });
    }
    const now = deps.now();
    const result = await deps.orgDb.withOrg(orgId, async (tx) => {
      const [claimed] = await tx
        .insert(billingEvents)
        .values({ orgId, stripeEventId: event.id, type: event.type, createdAt: now })
        .onConflictDoNothing()
        .returning({ id: billingEvents.id });
      if (!claimed) return "duplicate" as const;
      let changes: Record<string, unknown>;
      try {
        changes = await applyEvent(tx, gw, orgId, event, now);
      } catch (e) {
        if (e instanceof z.ZodError) throw badRequest("Unexpected Stripe event payload.");
        throw e;
      }
      await audit(tx, {
        orgId,
        actor: { type: "system", id: null, name: "stripe" },
        action: `billing.${event.type}`,
        target: { type: "organization", id: orgId },
        metadata: { eventId: event.id, ...changes },
        ip: c.get("ip"),
        requestId: c.get("requestId"),
      });
      return "applied" as const;
    });
    return c.json({ received: true, duplicate: result === "duplicate" });
  });
  return app;
}
