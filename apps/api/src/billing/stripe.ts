/**
 * The Stripe side of billing (T-65), behind a small interface so routes stay
 * plain and tests can inject a Stripe client with a fake HTTP layer. With no
 * STRIPE_SECRET_KEY the API has no gateway and billing runs in manual mode.
 */
import type { BillingInvoice, CheckoutPlanId, CreditPack } from "@slai/shared";
import Stripe from "stripe";

export interface StripeBillingConfig {
  secretKey: string;
  /** Required to accept webhooks; without it the webhook endpoint refuses everything. */
  webhookSecret: string | null;
  /** Recurring price per self-serve plan. */
  prices: Partial<Record<CheckoutPlanId, string>>;
  /** Metered prices (Billing Meters) added to every subscription for overage. */
  overagePrices: string[];
}

export interface BillingGateway {
  /** Verifies the Stripe-Signature over the raw body; throws on a bad or stale signature. */
  constructEvent(rawBody: string, signature: string): Stripe.Event;
  createCustomer(org: { id: string; name: string }, email: string): Promise<string>;
  checkoutSubscription(i: {
    customerId: string;
    orgId: string;
    plan: CheckoutPlanId;
    successUrl: string;
    cancelUrl: string;
    /** Bill on calendar months, matching slai's usage periods. */
    billingCycleAnchor: Date;
  }): Promise<string>;
  checkoutCreditPack(i: {
    customerId: string;
    orgId: string;
    pack: CreditPack;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  portal(i: { customerId: string; returnUrl: string; updateSubscriptionId?: string }): Promise<string>;
  listInvoices(customerId: string): Promise<BillingInvoice[]>;
  planForPrice(priceId: string): CheckoutPlanId | null;
  hasPrice(plan: CheckoutPlanId): boolean;
}

export function createStripeGateway(
  cfg: StripeBillingConfig,
  client: Stripe = new Stripe(cfg.secretKey),
): BillingGateway {
  const byPrice = new Map(Object.entries(cfg.prices).map(([plan, price]) => [price, plan as CheckoutPlanId]));
  const url = (u: string | null) => {
    if (!u) throw new Error("Stripe returned no URL");
    return u;
  };
  return {
    constructEvent(rawBody, signature) {
      if (!cfg.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
      return client.webhooks.constructEvent(rawBody, signature, cfg.webhookSecret);
    },
    async createCustomer(org, email) {
      const c = await client.customers.create(
        { name: org.name, email, metadata: { orgId: org.id } },
        // A retried request (or a double click) returns the same customer.
        { idempotencyKey: `slai-customer-${org.id}` },
      );
      return c.id;
    },
    async checkoutSubscription(i) {
      const price = cfg.prices[i.plan];
      if (!price) throw new Error(`no Stripe price for plan ${i.plan}`);
      const metadata = { orgId: i.orgId, plan: i.plan };
      const s = await client.checkout.sessions.create({
        mode: "subscription",
        customer: i.customerId,
        client_reference_id: i.orgId,
        line_items: [{ price, quantity: 1 }, ...cfg.overagePrices.map((p) => ({ price: p }))],
        subscription_data: { metadata, billing_cycle_anchor: Math.floor(i.billingCycleAnchor.getTime() / 1000) },
        metadata,
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      });
      return url(s.url);
    },
    async checkoutCreditPack(i) {
      const metadata = { orgId: i.orgId, kind: "credit_pack", pack: i.pack.id };
      const s = await client.checkout.sessions.create({
        mode: "payment",
        customer: i.customerId,
        client_reference_id: i.orgId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: i.pack.priceCents,
              product_data: { name: `slai AI credits (${i.pack.credits.toLocaleString("en-US")})` },
            },
          },
        ],
        metadata,
        payment_intent_data: { metadata },
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      });
      return url(s.url);
    },
    async portal(i) {
      const s = await client.billingPortal.sessions.create({
        customer: i.customerId,
        return_url: i.returnUrl,
        ...(i.updateSubscriptionId && {
          flow_data: {
            type: "subscription_update" as const,
            subscription_update: { subscription: i.updateSubscriptionId },
          },
        }),
      });
      return s.url;
    },
    async listInvoices(customerId) {
      const list = await client.invoices.list({ customer: customerId, limit: 12 });
      return list.data.map((inv) => ({
        id: inv.id ?? "",
        number: inv.number ?? null,
        status: inv.status ?? null,
        amountDueCents: inv.amount_due,
        amountPaidCents: inv.amount_paid,
        createdAt: new Date(inv.created * 1000).toISOString(),
        hostedUrl: inv.hosted_invoice_url ?? null,
        pdfUrl: inv.invoice_pdf ?? null,
      }));
    },
    planForPrice: (priceId) => byPrice.get(priceId) ?? null,
    hasPrice: (plan) => Boolean(cfg.prices[plan]),
  };
}
