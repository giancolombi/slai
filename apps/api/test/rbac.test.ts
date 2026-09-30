import { describe, expect, it } from "vitest";
import { addMember, setupApp, signup } from "./harness.js";

const ctx = setupApp();

describe("RBAC", () => {
  it("viewers can read but not write", async () => {
    const owner = await signup(ctx);
    const viewer = await addMember(ctx, owner.orgId, "viewer");
    expect((await viewer.client.get("/customers")).status).toBe(200);
    const res = await viewer.client.post("/customers", { name: "Nope" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("members cannot do admin things", async () => {
    const owner = await signup(ctx);
    const member = await addMember(ctx, owner.orgId, "member");
    expect((await member.client.post("/customers", { name: "Globex" })).status).toBe(201);
    expect((await member.client.patch("/org", { name: "x" })).status).toBe(403);
    expect((await member.client.post("/connections", { provider: "zendesk", name: "z", credentials: {} })).status).toBe(
      403,
    );
    expect((await member.client.get("/audit-events")).status).toBe(403);
    expect((await member.client.post("/members/invite", { email: "a@b.co", role: "viewer" })).status).toBe(403);
    expect(
      (
        await member.client.post("/autonomy-rules", {
          customerAccountId: null,
          priority: null,
          level: "autopilot",
          triggerAt: "at_risk",
        })
      ).status,
    ).toBe(403);
  });

  it("admins can administer but only owners change roles", async () => {
    const owner = await signup(ctx);
    const admin = await addMember(ctx, owner.orgId, "admin");
    const member = await addMember(ctx, owner.orgId, "member");
    expect((await admin.client.patch("/org", { monthlySpendCapCents: 10_000 })).status).toBe(200);
    expect((await admin.client.get("/audit-events")).status).toBe(200);
    expect((await admin.client.patch(`/members/${member.userId}`, { role: "admin" })).status).toBe(403);
    expect((await admin.client.post("/members/invite", { email: "o@b.co", role: "owner" })).status).toBe(403);
    expect((await admin.client.del(`/members/${owner.userId}`)).status).toBe(403);
    expect((await owner.client.patch(`/members/${member.userId}`, { role: "admin" })).status).toBe(200);
  });

  it("protects the last owner", async () => {
    const owner = await signup(ctx);
    const res = await owner.client.patch(`/members/${owner.userId}`, { role: "admin" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("last_owner");
  });

  it("revokes access immediately when a member is removed", async () => {
    const owner = await signup(ctx);
    const member = await addMember(ctx, owner.orgId, "member");
    expect((await member.client.get("/customers")).status).toBe(200);
    expect((await owner.client.del(`/members/${member.userId}`)).status).toBe(204);
    // The session falls back to the member's own org, never the one they left.
    const me = await member.client.get("/auth/me");
    expect(me.body.organization.id).not.toBe(owner.orgId);
    const audit = await owner.client.get("/audit-events");
    expect(audit.body.items.map((e: { action: string }) => e.action)).toContain("member.removed");
  });
});
