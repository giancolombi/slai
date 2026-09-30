import { createHash, randomBytes } from "node:crypto";
import { audit, invitations, memberships, organizations, type Tx, users } from "@slai/db";
import {
  type Invitation,
  inviteBody,
  type Member,
  type OrgSettings,
  updateMemberBody,
  updateOrgBody,
} from "@slai/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, auditBase, auth, ROLE_RANK } from "../context.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { requireRole } from "../middleware/auth.js";
import { body, idParam } from "../validate.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function ownerCount(tx: Tx): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.role, "owner"), isNull(memberships.disabledAt)));
  return r?.n ?? 0;
}

export function orgRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  const settings = (o: typeof organizations.$inferSelect): OrgSettings => ({
    id: o.id,
    name: o.name,
    plan: o.plan,
    monthlySpendCapCents: o.monthlySpendCapCents,
  });

  app.get("/org", async (c) => {
    const [o] = await deps.orgDb.withOrg(auth(c).orgId, (tx) => tx.select().from(organizations));
    if (!o) throw notFound("Organization");
    return c.json(settings(o));
  });

  app.patch("/org", requireRole("admin"), async (c) => {
    const a = auth(c);
    const input = await body(c, updateOrgBody);
    const o = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [row] = await tx
        .update(organizations)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.monthlySpendCapCents !== undefined && { monthlySpendCapCents: input.monthlySpendCapCents }),
        })
        .where(eq(organizations.id, a.orgId))
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "org.updated",
        target: { type: "organization", id: a.orgId },
        metadata: input,
      });
      return row!;
    });
    return c.json(settings(o));
  });

  app.get("/members", async (c) => {
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      tx
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          role: memberships.role,
          mfaEnabled: users.mfaEnabled,
          lastLoginAt: users.lastLoginAt,
          disabledAt: memberships.disabledAt,
          scimManaged: memberships.scimManaged,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .orderBy(asc(memberships.createdAt)),
    );
    const items: Member[] = rows.map(({ disabledAt, ...r }) => ({
      ...r,
      lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
      active: disabledAt === null,
    }));
    return c.json({ items, nextCursor: null });
  });

  app.post("/members/invite", requireRole("admin"), async (c) => {
    const a = auth(c);
    const input = await body(c, inviteBody);
    if (input.role === "owner" && a.role !== "owner") throw forbidden("Only owners can invite owners.");
    const token = randomBytes(32).toString("base64url");
    const inv = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [row] = await tx
        .insert(invitations)
        .values({
          orgId: a.orgId,
          email: input.email,
          role: input.role,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          invitedBy: a.user.id,
          expiresAt: new Date(deps.now().getTime() + INVITE_TTL_MS),
        })
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "member.invited",
        target: { type: "invitation", id: row!.id },
        metadata: { email: input.email, role: input.role },
      });
      return row!;
    });
    // TODO(email): send `${APP_URL}/invite/${token}` via SMTP; the email and accept endpoint follow the auth merge (T-59).
    const dto: Invitation = { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt.toISOString() };
    return c.json(dto, 201);
  });

  app.patch("/members/:userId", requireRole("owner"), async (c) => {
    const a = auth(c);
    const userId = idParam(c, "userId", "Member");
    const input = await body(c, updateMemberBody);
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [m] = await tx.select().from(memberships).where(eq(memberships.userId, userId)).for("update");
      if (!m) throw notFound("Member");
      if (m.role === "owner" && input.role !== "owner" && (await ownerCount(tx)) <= 1) {
        throw conflict("An organization needs at least one owner.", "last_owner");
      }
      await tx.update(memberships).set({ role: input.role }).where(eq(memberships.id, m.id));
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "member.role_changed",
        target: { type: "user", id: userId },
        metadata: { from: m.role, to: input.role },
      });
    });
    return c.json({ userId, role: input.role });
  });

  app.delete("/members/:userId", requireRole("admin"), async (c) => {
    const a = auth(c);
    const userId = idParam(c, "userId", "Member");
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [m] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, userId)))
        .for("update");
      if (!m) throw notFound("Member");
      if (ROLE_RANK[m.role] > ROLE_RANK[a.role]) throw forbidden("You cannot remove someone with a higher role.");
      if (m.role === "owner" && (await ownerCount(tx)) <= 1) {
        throw conflict("An organization needs at least one owner.", "last_owner");
      }
      await tx.delete(memberships).where(eq(memberships.id, m.id));
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "member.removed",
        target: { type: "user", id: userId },
        metadata: { role: m.role },
      });
    });
    return c.body(null, 204);
  });

  return app;
}
