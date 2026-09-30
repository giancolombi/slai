import { auditEvents, customerAccounts } from "@slai/db";
import type { Policy, PolicyPreview } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { policyInput, seedTicket } from "./fixtures.js";
import { addMember, setupApp, signup } from "./harness.js";

const ctx = setupApp();

describe("policies", () => {
  it("rejects definitions the engine rejects, with field-level details", async () => {
    const { client } = await signup(ctx);
    const bad = policyInput();
    bad.calendar = { timezone: "Mars/Olympus", weekly: {}, holidays: [] };
    const res = await client.post("/policies", { name: "Bad", definition: bad });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("invalid_policy");
    expect(res.body.error.details.some((d: { path: string }) => d.path === "calendar")).toBe(true);

    const dup = policyInput();
    dup.targets = [...dup.targets, dup.targets[0]!];
    expect((await client.post("/policies", { name: "Dup", definition: dup })).status).toBe(422);
    expect((await client.post("/policies", { name: "Junk", definition: "not an object" })).status).toBe(422);
  });

  it("stores the engine-normalized definition with server-owned id and name", async () => {
    const { client } = await signup(ctx);
    const res = await client.post<Policy>("/policies", {
      name: "Gold",
      definition: { ...policyInput(), id: "evil", name: "x" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "draft", version: 1, name: "Gold", approvedAt: null });
    expect(res.body.definition).toMatchObject({ id: res.body.id, name: "Gold", botRepliesCount: false });
  });

  it("approval needs admin; approving v2 supersedes v1, carries the default, and repoints customers", async () => {
    const owner = await signup(ctx);
    const member = await addMember(ctx, owner.orgId, "member");
    const v1 = (
      await owner.client.post<Policy>("/policies", { name: "Std", definition: policyInput(), isDefault: true })
    ).body;
    expect((await member.client.post(`/policies/${v1.id}/approve`)).status).toBe(403);
    const a1 = await owner.client.post<Policy>(`/policies/${v1.id}/approve`);
    expect(a1.status).toBe(200);
    expect(a1.body).toMatchObject({
      status: "active",
      isDefault: true,
      approvedBy: owner.userId,
      approvedByName: "Ada",
    });
    expect(v1).toMatchObject({ approvedBy: null, approvedByName: null });
    const listed = await owner.client.get<{ items: Policy[] }>("/policies");
    expect(listed.body.items.find((p) => p.id === v1.id)).toMatchObject({ approvedByName: "Ada" });
    expect((await member.client.get<Policy>(`/policies/${v1.id}`)).body).toMatchObject({ approvedByName: "Ada" });
    expect((await owner.client.post(`/policies/${v1.id}/approve`)).status).toBe(409);
    expect((await owner.client.patch(`/policies/${v1.id}`, { name: "edit active" })).status).toBe(409);

    const cust = (await owner.client.post("/customers", { name: "Globex", policyId: v1.id })).body;

    const edited = policyInput();
    edited.targets[0]!.minutes = 30;
    const v2 = (await owner.client.post<Policy>("/policies", { name: "Std", definition: edited, basedOn: v1.id })).body;
    expect(v2).toMatchObject({ version: 2, status: "draft", isDefault: false });
    expect((await owner.client.patch<Policy>(`/policies/${v2.id}`, { name: "Std v2" })).status).toBe(200);
    const a2 = await owner.client.post<Policy>(`/policies/${v2.id}/approve`);
    expect(a2.body).toMatchObject({ status: "active", isDefault: true, version: 2 });
    expect((await owner.client.get<Policy>(`/policies/${v1.id}`)).body).toMatchObject({
      status: "superseded",
      isDefault: false,
    });

    const [c] = await ctx.owner.db.select().from(customerAccounts).where(eq(customerAccounts.id, cust.id));
    expect(c!.policyId).toBe(v2.id);
    const audits = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, owner.orgId), eq(auditEvents.action, "policy.approved")));
    expect(audits.map((x) => x.metadata)).toContainEqual(
      expect.objectContaining({ version: 2, supersededPolicyId: v1.id }),
    );

    const archived = await owner.client.post<Policy>(`/policies/${v2.id}/archive`);
    expect(archived.body.status).toBe("archived");
  });

  it("previews a draft against recent tickets with the engine", async () => {
    const { client, orgId } = await signup(ctx);
    const pol = (await client.post<Policy>("/policies", { name: "Tight", definition: policyInput() })).body;
    // Urgent first response target is 60 calendar minutes; this ticket has waited 3h with no reply.
    await seedTicket(ctx, orgId, { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });
    await seedTicket(ctx, orgId, { createdAt: new Date(Date.now() - 10 * 60 * 1000) });
    const res = await client.post<PolicyPreview>(`/policies/${pol.id}/preview`, { days: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 7, tickets: 2 });
    expect(res.body.breaches).toBeGreaterThanOrEqual(1);
  });
});
