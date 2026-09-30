/**
 * Admin reset of a member's second factors (T-19, TR-23b).
 *
 * Guard rails, in order:
 * 1. step-up: the admin proved TOTP or a passkey in this session within 5 minutes;
 * 2. not yourself (use Settings → Security);
 * 3. never the last active owner of any of the member's organizations (break-glass only);
 * 4. only an owner resets an owner;
 * 5. factors are per user, not per org: every organization the member belongs to
 *    must be one where the admin is an admin or owner (and an owner where the
 *    member is an owner). Otherwise an admin of org A could take over an account
 *    that org B relies on.
 *
 * It then removes the member's TOTP, backup codes and passkeys, revokes all their
 * sessions (enrollment is forced at the next sign-in), audits `member.mfa_reset`
 * with the reason, and queues the security email. The identity tables are
 * `slai_auth`'s, so the reset and its audit run on authDb.
 */
import { audit, memberships, resetSecondFactors, type Tx } from "@slai/db";
import { type MfaResetResult, resetMemberMfaBody } from "@slai/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireStepUp } from "../auth/step-up.js";
import { type AppDeps, type AppEnv, auditBase, auth, ROLE_RANK } from "../context.js";
import { ApiError, conflict, forbidden, notFound } from "../errors.js";
import { requireRole } from "../middleware/auth.js";
import { body, idParam } from "../validate.js";

async function activeOwners(tx: Tx, orgId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner"), isNull(memberships.disabledAt)));
  return r?.n ?? 0;
}

export function mfaResetRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.post("/members/:userId/reset-mfa", requireRole("admin"), async (c) => {
    const a = auth(c);
    const userId = idParam(c, "userId", "Member");
    const input = await body(c, resetMemberMfaBody);
    requireStepUp(a, deps.now());
    if (userId === a.user.id) {
      throw conflict("You can't reset your own two-factor here. Use Settings → Security.", "self_reset");
    }

    const result = await deps.authDb.db.transaction(async (tx) => {
      const theirs = await tx
        .select({ orgId: memberships.orgId, role: memberships.role })
        .from(memberships)
        .where(eq(memberships.userId, userId));
      const here = theirs.find((m) => m.orgId === a.orgId);
      if (!here) throw notFound("Member");
      for (const m of theirs) {
        if (m.role === "owner" && (await activeOwners(tx, m.orgId)) <= 1) {
          throw conflict(
            "This is the organization's only owner. Their two-factor can only be reset through the break-glass procedure (contact slai support).",
            "last_owner",
          );
        }
      }
      if (here.role === "owner" && a.role !== "owner") {
        throw forbidden("Only an owner can reset an owner's two-factor.", "cannot_reset_owner");
      }
      const mine = new Map(
        (
          await tx
            .select({ orgId: memberships.orgId, role: memberships.role })
            .from(memberships)
            .where(and(eq(memberships.userId, a.user.id), isNull(memberships.disabledAt)))
        ).map((m) => [m.orgId, m.role]),
      );
      const outside = theirs.filter((m) => {
        const role = mine.get(m.orgId);
        if (!role || ROLE_RANK[role] < ROLE_RANK.admin) return true;
        return m.role === "owner" && role !== "owner";
      });
      if (outside.length > 0) {
        throw new ApiError(
          403,
          "cross_org_member",
          "This person also belongs to another organization where you are not an admin. An admin of every organization they belong to must do this, or slai support through break-glass.",
        );
      }

      const removed = await resetSecondFactors(tx, userId);
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "member.mfa_reset",
        target: { type: "user", id: userId },
        metadata: {
          reason: input.reason,
          removed,
          role: here.role,
          otherOrgIds: theirs.filter((m) => m.orgId !== a.orgId).map((m) => m.orgId),
        },
      });
      return removed;
    });

    try {
      await deps.orgDb.withOrg(a.orgId, (tx) =>
        deps.jobs.send(tx, "send-security-email", {
          orgId: a.orgId,
          userId,
          kind: "mfa_reset",
          actorUserId: a.user.id,
        }),
      );
    } catch (e) {
      deps.logger.warn({ userId, err: (e as Error).message }, "could not queue the mfa reset email");
    }
    const out: MfaResetResult = {
      userId,
      removed: { totp: result.totp, passkeys: result.passkeys },
      sessionsRevoked: result.sessions,
    };
    return c.json(out);
  });

  return app;
}
