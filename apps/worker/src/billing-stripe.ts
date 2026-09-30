/**
 * Usage-based billing through Stripe Billing Meters (T-65): each closed
 * month's billable overage is sent as a meter event on the customer, which
 * Stripe prices through the metered prices on the subscription. (The legacy
 * usage-records API is gone since API version 2025-03-31.basil.)
 */
import Stripe from "stripe";
import type { UsageReporter } from "./billing.js";

export function stripeUsageReporter(secretKey: string, client: Stripe = new Stripe(secretKey)): UsageReporter {
  return {
    async reportMeterEvent(e) {
      await client.billing.meterEvents.create({
        event_name: e.eventName,
        payload: { stripe_customer_id: e.customerId, value: String(e.value) },
        identifier: e.identifier,
        timestamp: Math.floor(e.timestamp.getTime() / 1000),
      });
    },
  };
}
