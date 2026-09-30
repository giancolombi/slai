import type { CustomerAccount, Policy } from "@slai/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { policyInput, seedTicket } from "./fixtures.js";
import { setupApp, signup } from "./harness.js";

const ctx = setupApp();
let a: Awaited<ReturnType<typeof signup>>;
let b: Awaited<ReturnType<typeof signup>>;
let customerA: CustomerAccount;
let policyA: Policy;
let ticketA: string;

beforeAll(async () => {
  a = await signup(ctx, "Alice");
  b = await signup(ctx, "Bob");
  customerA = (await a.client.post("/customers", { name: "Secret Customer", monthlyFeeCents: 100_000 })).body;
  policyA = (await a.client.post("/policies", { name: "A policy", definition: policyInput() })).body;
  ({ ticketId: ticketA } = await seedTicket(ctx, a.orgId, { subject: "A's private ticket" }));
});

describe("cross-org isolation through the API", () => {
  it("lists never include another org's rows", async () => {
    for (const path of ["/customers", "/policies", "/tickets", "/contracts", "/connections", "/audit-events"]) {
      const res = await b.client.get(path);
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body), path).not.toMatch(/Secret Customer|A policy|A's private ticket/);
    }
    expect((await a.client.get("/tickets")).body.items.map((t: { id: string }) => t.id)).toContain(ticketA);
  });

  it("direct reads, updates and deletes by id are 404", async () => {
    expect((await b.client.get(`/tickets/${ticketA}`)).status).toBe(404);
    expect((await b.client.get(`/policies/${policyA.id}`)).status).toBe(404);
    expect((await b.client.patch(`/customers/${customerA.id}`, { name: "pwned" })).status).toBe(404);
    expect((await b.client.del(`/customers/${customerA.id}`)).status).toBe(404);
    expect((await b.client.post(`/policies/${policyA.id}/approve`)).status).toBe(404);
    expect((await b.client.post(`/tickets/${ticketA}/agents/triage`)).status).toBe(404);
    const still = await a.client.get("/customers");
    expect(still.body.items[0].name).toBe("Secret Customer");
  });

  it("cannot reference another org's rows by id (FKs bypass RLS, so the API checks)", async () => {
    const res = await b.client.post("/customers", { name: "Sneaky", policyId: policyA.id });
    expect(res.status).toBe(400);
    const rule = await b.client.post("/autonomy-rules", {
      customerAccountId: customerA.id,
      priority: null,
      level: "autopilot",
      triggerAt: "at_risk",
    });
    expect(rule.status).toBe(400);
  });

  it("cannot switch into an org it does not belong to", async () => {
    expect((await b.client.post("/auth/switch-org", { organizationId: a.orgId })).status).toBe(404);
  });
});
