/**
 * T-65 billing API: the summary, manual mode, Stripe Checkout / Portal /
 * credit packs (the real Stripe SDK over a fake HTTP layer, no network), and
 * the webhook: signature rejection, idempotency, and status transitions.
 */
import { auditEvents, creditGrants, organizations } from "@slai/db";
import type { BillingSummary } from "@slai/shared";
import { and, eq, like } from "drizzle-orm";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { createStripeGateway } from "../src/billing/stripe.js";
import { addMember, type Client, setupApp, signup, type TestCtx } from "./harness.js";

const DAY = 86_400_000;
const WEBHOOK_SECRET = "whsec_test_secret";

// ---------- manual mode ----------

describe("billing in manual mode (no Stripe keys)", () => {
  const ctx = setupApp();
  // Real time, so the app and Postgres (which sets the trial end) agree on "now".
  ctx.clock.now = null;

  it("a new org is on the 14-day Growth trial, with autopilot off", async () => {
    const { client } = await signup(ctx, "Trial");
    const res = await client.get<BillingSummary>("/billing");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "manual",
      plan: "growth",
      status: "trialing",
      state: "trialing",
      ceiling: "assist",
      trialDaysLeft: 14,
      hasSubscription: false,
      hasCustomer: false,
      overageBilled: false,
      invoices: [],
    });
    expect(res.body.credits).toMatchObject({ included: 5_000, used: 0, cap: 5_000 });
    expect(res.body.trackedTickets).toMatchObject({ used: 0, limit: 7_500, overage: 0 });
  });

  it("an admin sets the plan and grants credits; members cannot; Stripe routes say manual", async () => {
    const { client, orgId } = await signup(ctx, "Manual");
    const res = await client.post<BillingSummary>("/billing/manual", {
      plan: "scale",
      status: "active",
      trialEndsAt: null,
      grantCredits: 10_000,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: "scale", state: "active", ceiling: "autopilot" });
    expect(res.body.credits).toMatchObject({ included: 60_000, purchasedAvailable: 10_000, cap: 100_000 });
    const audited = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "billing.manual_update")));
    expect(audited).toHaveLength(1);

    const member = await addMember(ctx, orgId, "member");
    expect((await member.client.post("/billing/manual", { plan: "starter" })).status).toBe(403);
    expect((await member.client.get("/billing")).status).toBe(200);

    for (const path of ["/billing/checkout", "/billing/portal", "/billing/credit-packs/checkout"]) {
      const r = await client.post(path, { plan: "growth", pack: "credits_10k" });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("billing_manual");
    }
    // No webhook endpoint without Stripe.
    expect((await client.post("/billing/webhook", {}, { csrf: false })).status).toBe(404);
  });

  it("a trial past its end is observe-only; monitoring is not part of billing state", async () => {
    const { client } = await signup(ctx, "Expired");
    await client.post("/billing/manual", { trialEndsAt: new Date(Date.now() - DAY).toISOString() });
    const res = await client.get<BillingSummary>("/billing");
    expect(res.body).toMatchObject({ state: "trial_expired", ceiling: "observe", trialDaysLeft: 0 });
  });
});

// ---------- Stripe mode ----------

interface StripeCall {
  method: string;
  path: string;
  params: URLSearchParams;
  idempotencyKey: string | null;
}

/** A Stripe client whose HTTP layer answers from memory and records every call. */
function fakeStripe() {
  const calls: StripeCall[] = [];
  let n = 0;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const params = new URLSearchParams(init?.method === "GET" ? url.search : String(init?.body ?? ""));
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      params,
      idempotencyKey: headers.get("idempotency-key"),
    });
    n++;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    switch (url.pathname) {
      case "/v1/customers":
        return json({ id: `cus_test_${n}`, object: "customer" });
      case "/v1/checkout/sessions":
        return json({ id: `cs_test_${n}`, object: "checkout.session", url: `https://checkout.stripe.test/${n}` });
      case "/v1/billing_portal/sessions":
        return json({ id: `bps_${n}`, object: "billing_portal.session", url: `https://billing.stripe.test/${n}` });
      case "/v1/invoices":
        return json({
          object: "list",
          has_more: false,
          data: [
            {
              id: "in_1",
              object: "invoice",
              number: "SLAI-0001",
              status: "paid",
              amount_due: 99_900,
              amount_paid: 99_900,
              created: 1_790_000_000,
              hosted_invoice_url: "https://invoice.stripe.test/in_1",
              invoice_pdf: null,
            },
          ],
        });
      default:
        return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    }
  }) as typeof fetch;
  const client = new Stripe("sk_test_fake", {
    httpClient: Stripe.createFetchHttpClient(fakeFetch),
    maxNetworkRetries: 0,
  });
  const gateway = createStripeGateway(
    {
      secretKey: "sk_test_fake",
      webhookSecret: WEBHOOK_SECRET,
      prices: { starter: "price_starter", growth: "price_growth", scale: "price_scale" },
      overagePrices: ["price_ticket_overage", "price_credit_overage"],
    },
    client,
  );
  return { client, gateway, calls };
}

const stripe = fakeStripe();
const ctx = setupApp({ billing: stripe.gateway });

let seq = 0;
function event(type: string, object: Record<string, unknown>, id = `evt_${++seq}_${Date.now()}`) {
  return { id, object: "event", type, api_version: "2026-08-26.dahlia", created: 1_790_000_000, data: { object } };
}

/** Posts an event to the webhook, signed like Stripe does (unless a signature is given). */
async function deliver(c: TestCtx, evt: unknown, signature?: string) {
  const payload = JSON.stringify(evt);
  const header = signature ?? stripe.client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const res = await c.app.request("/api/v1/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header, "x-forwarded-for": "10.9.9.9" },
    body: payload,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function orgRow(orgId: string) {
  const [o] = await ctx.owner.db.select().from(organizations).where(eq(organizations.id, orgId));
  return o!;
}

async function subscribed(name: string) {
  const s = await signup(ctx, name);
  const res = await s.client.post("/billing/checkout", { plan: "growth" });
  expect(res.status).toBe(200);
  const customer = (await orgRow(s.orgId)).stripeCustomerId!;
  return { ...s, customer };
}

const billing = async (client: Client) => (await client.get<BillingSummary>("/billing")).body;

describe("Stripe checkout, portal and credit packs", () => {
  it("checkout creates the customer once and a subscription session with the overage meters", async () => {
    const { client, orgId } = await signup(ctx, "Checkout");
    const before = stripe.calls.length;
    const res = await client.post("/billing/checkout", { plan: "scale" });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const calls = stripe.calls.slice(before);
    expect(calls.map((c) => c.path)).toEqual(["/v1/customers", "/v1/checkout/sessions"]);
    expect(calls[0]!.params.get("metadata[orgId]")).toBe(orgId);
    expect(calls[0]!.idempotencyKey).toBe(`slai-customer-${orgId}`);
    const session = calls[1]!.params;
    expect(session.get("mode")).toBe("subscription");
    expect(session.get("client_reference_id")).toBe(orgId);
    expect(session.get("line_items[0][price]")).toBe("price_scale");
    expect(session.get("line_items[1][price]")).toBe("price_ticket_overage");
    expect(session.get("line_items[2][price]")).toBe("price_credit_overage");
    expect(session.get("subscription_data[metadata][plan]")).toBe("scale");
    expect(session.get("success_url")).toBe("http://localhost:5173/billing?checkout=success");
    expect(Number(session.get("subscription_data[billing_cycle_anchor]")) * 1000).toBeGreaterThan(Date.now());

    const o = await orgRow(orgId);
    expect(o.stripeCustomerId).toMatch(/^cus_test_/);
    // Checking out again reuses the customer.
    const again = stripe.calls.length;
    await client.post("/billing/checkout", { plan: "growth" });
    expect(stripe.calls.slice(again).map((c) => c.path)).toEqual(["/v1/checkout/sessions"]);
    const audited = await ctx.owner.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), like(auditEvents.action, "billing.%")));
    expect(audited.map((a) => a.action).sort()).toEqual([
      "billing.checkout_started",
      "billing.checkout_started",
      "billing.customer_created",
    ]);
  });

  it("the portal needs a customer; an existing subscription upgrades through the portal", async () => {
    const { client } = await signup(ctx, "Portal");
    const none = await client.post("/billing/portal");
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("no_customer");

    const s = await subscribed("Upgrade");
    await deliver(
      ctx,
      event("customer.subscription.created", {
        id: "sub_up",
        customer: s.customer,
        status: "active",
        metadata: {},
        items: { data: [{ price: { id: "price_growth" } }] },
      }),
    );
    expect((await s.client.post("/billing/portal")).body.url).toMatch(/^https:\/\/billing\.stripe\.test\//);
    const before = stripe.calls.length;
    const up = await s.client.post("/billing/checkout", { plan: "scale" });
    expect(up.status).toBe(200);
    const [call] = stripe.calls.slice(before);
    expect(call!.path).toBe("/v1/billing_portal/sessions");
    expect(call!.params.get("flow_data[type]")).toBe("subscription_update");
    expect(call!.params.get("flow_data[subscription_update][subscription]")).toBe("sub_up");
  });

  it("credit packs: known packs only, admins only", async () => {
    const { client, orgId } = await signup(ctx, "Packs");
    expect((await client.post("/billing/credit-packs/checkout", { pack: "credits_1m" })).status).toBe(400);
    const res = await client.post("/billing/credit-packs/checkout", { pack: "credits_10k" });
    expect(res.status).toBe(200);
    const params = stripe.calls.at(-1)!.params;
    expect(params.get("mode")).toBe("payment");
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("10000");
    expect(params.get("metadata[kind]")).toBe("credit_pack");
    const viewer = await addMember(ctx, orgId, "viewer");
    expect((await viewer.client.post("/billing/credit-packs/checkout", { pack: "credits_10k" })).status).toBe(403);
    expect((await viewer.client.post("/billing/checkout", { plan: "growth" })).status).toBe(403);
  });

  it("GET /billing lists the customer's invoices", async () => {
    const s = await subscribed("Invoices");
    const b = await billing(s.client);
    expect(b.mode).toBe("stripe");
    expect(b.invoices).toEqual([expect.objectContaining({ id: "in_1", number: "SLAI-0001", amountPaidCents: 99_900 })]);
  });
});

describe("the Stripe webhook", () => {
  it("rejects a missing, forged or stale signature, and changes nothing", async () => {
    const s = await subscribed("Forged");
    const evt = event("customer.subscription.updated", {
      id: "sub_x",
      customer: s.customer,
      status: "active",
      metadata: {},
      items: { data: [{ price: { id: "price_scale" } }] },
    });
    const payload = JSON.stringify(evt);
    const wrongSecret = stripe.client.webhooks.generateTestHeaderString({ payload, secret: "whsec_wrong" });
    const stale = stripe.client.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 3_600,
    });
    for (const sig of [wrongSecret, stale, "t=1,v1=deadbeef"]) {
      const r = await deliver(ctx, evt, sig);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: { code: "bad_signature" } });
    }
    const unsigned = await ctx.app.request("/api/v1/billing/webhook", { method: "POST", body: payload });
    expect(unsigned.status).toBe(400);
    // A validly signed body that was tampered with after signing.
    const good = stripe.client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const tampered = await ctx.app.request("/api/v1/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": good },
      body: payload.replace("price_scale", "price_starter"),
    });
    expect(tampered.status).toBe(400);
    expect(await orgRow(s.orgId)).toMatchObject({ plan: "growth", billingStatus: "trialing" });
  });

  it("applies each event once, however often Stripe delivers it", async () => {
    const s = await subscribed("Idem");
    const evt = event("checkout.session.completed", {
      id: "cs_idem",
      mode: "subscription",
      customer: s.customer,
      subscription: "sub_idem",
      client_reference_id: s.orgId,
      payment_status: "paid",
      metadata: { orgId: s.orgId, plan: "scale" },
    });
    const first = await deliver(ctx, evt);
    const second = await deliver(ctx, evt);
    expect(first).toMatchObject({ status: 200, body: { received: true, duplicate: false } });
    expect(second).toMatchObject({ status: 200, body: { received: true, duplicate: true } });
    expect(await orgRow(s.orgId)).toMatchObject({
      plan: "scale",
      billingStatus: "active",
      stripeSubscriptionId: "sub_idem",
    });
    const audited = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, s.orgId), eq(auditEvents.action, "billing.checkout.session.completed")));
    expect(audited).toHaveLength(1);
    expect(audited[0]!.metadata).toMatchObject({
      from: { status: "trialing" },
      to: { plan: "scale", status: "active" },
    });
  });

  it("a paid credit pack grants its credits once, even across distinct events for the same session", async () => {
    const s = await subscribed("PackPaid");
    const session = {
      id: `cs_pack_${s.orgId}`,
      mode: "payment",
      customer: s.customer,
      client_reference_id: s.orgId,
      payment_status: "paid",
      amount_total: 10_000,
      // Credits come from the pack definition, never from metadata we did not set.
      metadata: { orgId: s.orgId, kind: "credit_pack", pack: "credits_10k", credits: "999999" },
    };
    await deliver(ctx, event("checkout.session.completed", session));
    await deliver(ctx, event("checkout.session.completed", session));
    const grants = await ctx.owner.db.select().from(creditGrants).where(eq(creditGrants.orgId, s.orgId));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ credits: 10_000, source: "credit_pack", amountCents: 10_000 });
    expect((await billing(s.client)).credits.purchasedAvailable).toBe(10_000);

    // An unpaid session grants nothing.
    await deliver(
      ctx,
      event("checkout.session.completed", { ...session, id: `cs_unpaid_${s.orgId}`, payment_status: "unpaid" }),
    );
    expect(await ctx.owner.db.select().from(creditGrants).where(eq(creditGrants.orgId, s.orgId))).toHaveLength(1);
  });

  it("walks the subscription through active → past due → degraded → active → canceled", async () => {
    const s = await subscribed("Lifecycle");
    const sub = (status: string, price = "price_growth") => ({
      id: "sub_life",
      customer: s.customer,
      status,
      metadata: { orgId: s.orgId },
      items: { data: [{ price: { id: price } }] },
    });
    await deliver(ctx, event("customer.subscription.created", sub("active")));
    expect(await billing(s.client)).toMatchObject({
      plan: "growth",
      status: "active",
      state: "active",
      ceiling: "assist",
    });

    // An upgrade in the portal arrives as an update with the new price.
    await deliver(ctx, event("customer.subscription.updated", sub("active", "price_scale")));
    expect(await billing(s.client)).toMatchObject({ plan: "scale", ceiling: "autopilot", hasSubscription: true });

    await deliver(ctx, event("invoice.payment_failed", { id: "in_f1", customer: s.customer }));
    const failed = await orgRow(s.orgId);
    expect(failed.billingStatus).toBe("past_due");
    expect(failed.pastDueSince).not.toBeNull();
    expect(await billing(s.client)).toMatchObject({ state: "past_due", ceiling: "autopilot" });
    // A second failure keeps the original start of the grace period.
    await deliver(ctx, event("invoice.payment_failed", { id: "in_f2", customer: s.customer }));
    expect((await orgRow(s.orgId)).pastDueSince).toEqual(failed.pastDueSince);

    // Past the 7-day grace period, agents degrade to observe.
    await ctx.owner.db
      .update(organizations)
      .set({ pastDueSince: new Date(Date.now() - 8 * DAY) })
      .where(eq(organizations.id, s.orgId));
    expect(await billing(s.client)).toMatchObject({ state: "degraded", ceiling: "observe" });

    await deliver(ctx, event("invoice.paid", { id: "in_p1", customer: s.customer }));
    expect(await orgRow(s.orgId)).toMatchObject({ billingStatus: "active", pastDueSince: null });

    // Deleting an older subscription does not cancel the current one.
    await deliver(ctx, event("customer.subscription.deleted", { ...sub("canceled"), id: "sub_old" }));
    expect((await orgRow(s.orgId)).billingStatus).toBe("active");

    await deliver(ctx, event("customer.subscription.deleted", sub("canceled")));
    expect(await billing(s.client)).toMatchObject({ status: "canceled", state: "canceled", ceiling: "observe" });
  });

  it("ignores events it does not handle and events for unknown customers", async () => {
    expect(await deliver(ctx, event("customer.created", { id: "cus_zzz" }))).toMatchObject({
      status: 200,
      body: { received: true, ignored: true },
    });
    expect(await deliver(ctx, event("invoice.paid", { id: "in_zzz", customer: "cus_unknown" }))).toMatchObject({
      status: 200,
      body: { received: true, ignored: true },
    });
  });
});
