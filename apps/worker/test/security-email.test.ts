import { randomUUID } from "node:crypto";
import { auditEvents, memberships, users } from "@slai/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createOrg, setupWorker } from "./harness.js";

const h = setupWorker();

async function user(orgId: string, name: string, role: "owner" | "admin" | "member") {
  const [u] = await h.owner.db
    .insert(users)
    .values({ email: `${name.toLowerCase()}-${randomUUID()}@example.com`, name })
    .returning();
  await h.owner.db.insert(memberships).values({ orgId, userId: u!.id, role });
  return u!;
}

describe("security emails (T-19)", () => {
  it("tells the member who reset their factors, and audits the delivery", async () => {
    const orgId = await createOrg(h.owner);
    const admin = await user(orgId, "Ada", "admin");
    const member = await user(orgId, "Bob", "member");
    await h.queue.send("send-security-email", { orgId, userId: member.id, kind: "mfa_reset", actorUserId: admin.id });
    await h.drain(["send-security-email"]);
    const mail = h.outbox.mail.find((m) => m.to === member.email);
    expect(mail?.subject).toBe("Your slai two-factor authentication was reset");
    expect(mail?.text).toContain(`Ada (${admin.email})`);
    expect(mail?.text).not.toMatch(/secret|code:/i);
    const [ev] = await h.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "notification.sent")));
    expect(ev).toMatchObject({ targetType: "user", targetId: member.id });
    expect(ev!.metadata).toMatchObject({ kind: "security.mfa_reset", channelKind: "email" });
  });

  it("names slai support for a break-glass reset", async () => {
    const orgId = await createOrg(h.owner);
    const owner = await user(orgId, "Solo", "owner");
    await h.queue.send("send-security-email", { orgId, userId: owner.id, kind: "mfa_reset", actorUserId: null });
    await h.drain(["send-security-email"]);
    expect(h.outbox.mail.find((m) => m.to === owner.email)?.text).toContain("slai support");
  });
});
