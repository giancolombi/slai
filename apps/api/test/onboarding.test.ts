import { randomUUID } from "node:crypto";
import { contracts, onboardingState, replays } from "@slai/db";
import type { Connection, OnboardingState } from "@slai/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { fakeConnector, policyInput } from "./fixtures.js";
import { addMember, fakeRegistry, setupApp, signup } from "./harness.js";

const ctx = setupApp({ connectors: fakeRegistry([fakeConnector()]) });

const done = (s: OnboardingState) => Object.fromEntries(s.steps.map((x) => [x.id, x.done]));
const get = async (client: Awaited<ReturnType<typeof signup>>["client"]) => {
  const res = await client.get<OnboardingState>("/onboarding");
  expect(res.status).toBe(200);
  return res.body;
};

describe("GET /onboarding: the checklist is derived from org state", () => {
  it("a fresh org has nothing done, and each step turns done from real state", async () => {
    const owner = await signup(ctx, "Fresh");
    let s = await get(owner.client);
    expect(s).toMatchObject({
      requiredDone: 0,
      requiredTotal: 6,
      allDone: false,
      checklistDismissed: false,
      welcomeSeen: false,
    });
    expect(s.steps.map((x) => [x.id, x.optional])).toEqual([
      ["connect", false],
      ["contract", false],
      ["policy", false],
      ["assign", false],
      ["autonomy", false],
      ["alerts", false],
      ["invite", true],
      ["replay", true],
    ]);
    expect(Object.values(done(s)).every((d) => d === false)).toBe(true);

    // 1. connect
    const conn = await owner.client.post<Connection>("/connections", {
      provider: "zendesk",
      name: "Support",
      credentials: { subdomain: "acme", token: "zd-super-secret-token" },
    });
    expect(conn.status).toBe(201);
    // 2. a contract (not archived)
    const [contract] = await ctx.owner.db
      .insert(contracts)
      .values({
        orgId: owner.orgId,
        storageKey: `k/${randomUUID()}`,
        filename: "msa.pdf",
        sha256: "0".repeat(64),
        mediaType: "application/pdf",
        sizeBytes: 10,
        status: "needs_review",
      })
      .returning();
    s = await get(owner.client);
    expect(done(s)).toMatchObject({ connect: true, contract: true, policy: false, assign: false });

    // 3. a policy from that contract, approved; a draft alone does not count
    const draft = await owner.client.post("/policies", {
      name: "Acme MSA",
      definition: policyInput(),
      contractId: contract!.id,
    });
    expect(draft.status).toBe(201);
    expect(done(await get(owner.client)).policy).toBe(false);
    const approved = await owner.client.post(`/policies/${draft.body.id}/approve`);
    expect(approved.status).toBe(200);
    s = await get(owner.client);
    expect(done(s)).toMatchObject({ policy: true, assign: false });

    // 4. a customer with that policy
    const cust = await owner.client.post("/customers", { name: "Acme", policyId: draft.body.id });
    expect(cust.status).toBe(201);
    // 5. autonomy, 6. alerts
    expect(
      (
        await owner.client.post("/autonomy-rules", {
          customerAccountId: null,
          priority: null,
          level: "observe",
          triggerAt: "at_risk",
        })
      ).status,
    ).toBe(201);
    expect(
      (await owner.client.post("/notification-channels", { kind: "email", target: "ops@example.com" })).status,
    ).toBe(201);
    s = await get(owner.client);
    expect(s).toMatchObject({ requiredDone: 6, allDone: false });
    expect(done(s)).toMatchObject({ assign: true, autonomy: true, alerts: true, invite: false, replay: false });

    // 7. invite (a pending invitation counts), 8. replay (a failed one does not)
    expect(
      (await owner.client.post("/members/invite", { email: `t-${randomUUID()}@example.com`, role: "member" })).status,
    ).toBe(201);
    await ctx.owner.db
      .insert(replays)
      .values({ orgId: owner.orgId, connectionId: conn.body.id, days: 90, status: "failed" });
    expect(done(await get(owner.client))).toMatchObject({ invite: true, replay: false });
    await ctx.owner.db.insert(replays).values({ orgId: owner.orgId, connectionId: conn.body.id, days: 90 });
    s = await get(owner.client);
    expect(s.allDone).toBe(true);
  });

  it("an active default policy covers both 'approve a policy' and 'assign policies'", async () => {
    const owner = await signup(ctx, "Defaulted");
    const p = await owner.client.post("/policies", { name: "Default", definition: policyInput(), isDefault: true });
    expect(p.status).toBe(201);
    expect(done(await get(owner.client))).toMatchObject({ policy: false, assign: false });
    await owner.client.post(`/policies/${p.body.id}/approve`);
    expect(done(await get(owner.client))).toMatchObject({ policy: true, assign: true });
  });

  it("a teammate who joined counts as invited; a paused connection does not count as connected", async () => {
    const owner = await signup(ctx, "Team");
    await addMember(ctx, owner.orgId, "viewer");
    const conn = await owner.client.post<Connection>("/connections", {
      provider: "zendesk",
      name: "Support",
      credentials: { subdomain: "acme", token: "zd-super-secret-token" },
    });
    await ctx.owner.client`update connections set status = 'paused' where id = ${conn.body.id}`;
    expect(done(await get(owner.client))).toMatchObject({ invite: true, connect: false });
  });
});

describe("PATCH /onboarding: preferences per user per org", () => {
  it("dismissal and the welcome are the user's own, and restoring works", async () => {
    const owner = await signup(ctx, "Prefs");
    const admin = await addMember(ctx, owner.orgId, "admin");

    const dismissed = await owner.client.patch<OnboardingState>("/onboarding", { checklistDismissed: true });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.checklistDismissed).toBe(true);
    // Another user in the same org is unaffected.
    expect((await get(admin.client)).checklistDismissed).toBe(false);

    const welcomed = await owner.client.patch<OnboardingState>("/onboarding", { welcomeSeen: true });
    expect(welcomed.body).toMatchObject({ welcomeSeen: true, checklistDismissed: true });
    expect((await get(admin.client)).welcomeSeen).toBe(false);

    const restored = await owner.client.patch<OnboardingState>("/onboarding", { checklistDismissed: false });
    expect(restored.body).toMatchObject({ checklistDismissed: false, welcomeSeen: true });
  });

  it("is per organization: the same user in another org starts fresh", async () => {
    const a = await signup(ctx, "Multi");
    const other = await signup(ctx, "OtherOrg");
    // `a` joins other's org as a member (addMember signs up a new user, so link a directly).
    await ctx.owner
      .client`insert into memberships (org_id, user_id, role) values (${other.orgId}, ${a.userId}, 'member')`;
    await a.client.patch("/onboarding", { checklistDismissed: true, welcomeSeen: true });
    const switched = await a.client.post("/auth/switch-org", { organizationId: other.orgId });
    expect(switched.status).toBe(200);
    expect(await get(a.client)).toMatchObject({ checklistDismissed: false, welcomeSeen: false });
    const rows = await ctx.owner.db.select().from(onboardingState).where(eq(onboardingState.userId, a.userId));
    expect(rows.map((r) => r.orgId)).toEqual([a.orgId]);
  });

  it("viewers may update their own preferences (and nothing else)", async () => {
    const owner = await signup(ctx, "ViewerOrg");
    const viewer = await addMember(ctx, owner.orgId, "viewer");
    const res = await viewer.client.patch<OnboardingState>("/onboarding", { welcomeSeen: true });
    expect(res.status).toBe(200);
    expect(res.body.welcomeSeen).toBe(true);
    expect((await viewer.client.post("/customers", { name: "Nope" })).status).toBe(403);
  });

  it("rejects an empty or invalid body", async () => {
    const owner = await signup(ctx, "Invalid");
    expect((await owner.client.patch("/onboarding", {})).status).toBe(400);
    expect((await owner.client.patch("/onboarding", { welcomeSeen: false })).status).toBe(400);
    expect((await owner.client.patch("/onboarding", { checklistDismissed: "yes" })).status).toBe(400);
  });

  it("needs a signed-in, MFA-complete session", async () => {
    const { Client } = await import("./harness.js");
    expect((await new Client(ctx).get("/onboarding")).status).toBe(401);
  });
});
