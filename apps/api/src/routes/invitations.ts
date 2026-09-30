/**
 * Invitations (T-59a, TR-23d).
 *
 * - Admins invite (org.ts), list, resend (a new token and 7-day expiry) and revoke.
 *   Each token is random, stored as sha256, and sealed (AES-256-GCM) only until
 *   the worker's `send-invite-email` job has emailed the link.
 * - The accept page reads `GET /auth/invitations/:token` (the token is the secret).
 *   A new user signs up there (`/signup`, then mandatory MFA enrollment as usual);
 *   an existing user signs in the normal way (SSO and enforce-SSO apply) and
 *   accepts (`/accept`, MFA done, same email; SSO-enforced domains only through SSO).
 * - Accepting is single use (an atomic claim) and joins the org with the invited
 *   role (an existing member is only ever promoted). Everything is audited.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AAD, audit, encrypt, invitations, memberships, organizations, sessions, type Tx, users } from "@slai/db";
import {
  acceptInvitationSignupBody,
  type Invitation,
  type InvitationPreview,
  type InvitationStatus,
  type Role,
  type SignInResult,
} from "@slai/shared";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Auth } from "../auth/better-auth.js";
import { CLIENT_IP_HEADER, SESSION_COOKIE } from "../auth/better-auth.js";
import { SSO_REQUIRED, ssoForEmail } from "../auth/handler.js";
import { buildMe } from "../auth/me.js";
import { resolveAuth } from "../auth/session.js";
import { type AppDeps, type AppEnv, auditBase, auth, type Ctx, ROLE_RANK } from "../context.js";
import { ApiError, conflict, forbidden, notFound } from "../errors.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { body, idParam } from "../validate.js";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const RATE_LIMITED = () => new ApiError(429, "rate_limited", "Too many attempts. Try again later.");

type Row = typeof invitations.$inferSelect;

export function invitationStatus(r: Pick<Row, "acceptedAt" | "revokedAt" | "expiresAt">, now: Date): InvitationStatus {
  if (r.acceptedAt) return "accepted";
  if (r.revokedAt) return "revoked";
  return r.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
}

const GONE: Record<Exclude<InvitationStatus, "pending">, () => ApiError> = {
  accepted: () => new ApiError(410, "invitation_used", "This invitation was already used."),
  revoked: () => new ApiError(410, "invitation_revoked", "This invitation was revoked. Ask for a new one."),
  expired: () => new ApiError(410, "invitation_expired", "This invitation has expired. Ask for a new one."),
};

/** A fresh token for an invitation row: its hash, its sealed copy for the email job, and the expiry. */
export function newInviteToken(deps: Pick<AppDeps, "keyring" | "now">, invitationId: string) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: sha256(token),
    tokenCiphertext: encrypt(token, { keyring: deps.keyring, aad: AAD.invitationToken(invitationId) }),
    expiresAt: new Date(deps.now().getTime() + INVITE_TTL_MS),
  };
}

/** Creates an invitation (inside withOrg) and queues its email in the same transaction. */
export async function createInvitation(
  deps: AppDeps,
  tx: Tx,
  input: { orgId: string; email: string; role: Role; invitedBy: string },
) {
  const id = randomUUID();
  const t = newInviteToken(deps, id);
  const [row] = await tx
    .insert(invitations)
    .values({
      id,
      orgId: input.orgId,
      email: input.email,
      role: input.role,
      tokenHash: t.tokenHash,
      tokenCiphertext: t.tokenCiphertext,
      invitedBy: input.invitedBy,
      expiresAt: t.expiresAt,
    })
    .returning();
  await deps.jobs.send(tx, "send-invite-email", { orgId: input.orgId, invitationId: id });
  return row!;
}

// ---------------------------------------------------------------- admin (Team)

export function invitationAdminRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  const toDto = (r: Row, inviter: string | null): Invitation => ({
    id: r.id,
    email: r.email,
    role: r.role as Role,
    expiresAt: r.expiresAt.toISOString(),
    status: invitationStatus(r, deps.now()),
    createdAt: r.createdAt.toISOString(),
    invitedBy: inviter,
  });

  app.get("/members/invitations", requireRole("admin"), async (c) => {
    const rows = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      tx
        .select({ inv: invitations, inviter: users.name })
        .from(invitations)
        .leftJoin(users, eq(users.id, invitations.invitedBy))
        .orderBy(desc(invitations.createdAt))
        .limit(200),
    );
    return c.json({ items: rows.map((r) => toDto(r.inv, r.inviter)), nextCursor: null });
  });

  app.post("/members/invitations/:id/resend", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Invitation");
    const out = await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [inv] = await tx.select().from(invitations).where(eq(invitations.id, id)).for("update");
      if (!inv) throw notFound("Invitation");
      if (inv.acceptedAt || inv.revokedAt)
        throw conflict("This invitation was already used or revoked.", "invitation_closed");
      if (inv.role === "owner" && a.role !== "owner") throw forbidden("Only owners can invite owners.");
      const t = newInviteToken(deps, id);
      const [row] = await tx
        .update(invitations)
        .set({ tokenHash: t.tokenHash, tokenCiphertext: t.tokenCiphertext, expiresAt: t.expiresAt })
        .where(eq(invitations.id, id))
        .returning();
      await deps.jobs.send(tx, "send-invite-email", { orgId: a.orgId, invitationId: id });
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "member.invitation_resent",
        target: { type: "invitation", id },
        metadata: { email: inv.email, role: inv.role },
      });
      return toDto(row!, a.user.name);
    });
    return c.json(out);
  });

  app.delete("/members/invitations/:id", requireRole("admin"), async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Invitation");
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [inv] = await tx
        .update(invitations)
        .set({ revokedAt: deps.now(), tokenCiphertext: null })
        .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .returning();
      if (!inv) throw notFound("Invitation");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "member.invitation_revoked",
        target: { type: "invitation", id },
        metadata: { email: inv.email, role: inv.role },
      });
    });
    return c.body(null, 204);
  });

  return app;
}

// ---------------------------------------------------------------- the invitee (public /auth routes)

export function invitationAuthRoutes(deps: AppDeps, betterAuth: Auth) {
  const app = new Hono<AppEnv>();
  const authDb = deps.authDb.db;
  const cookieName = deps.env.NODE_ENV === "production" ? `__Secure-${SESSION_COOKIE}` : SESSION_COOKIE;

  const limit = (c: Ctx, what: string) => {
    if (!deps.rateLimits.loginByIp.take(`${what}:${c.get("ip") ?? "unknown"}`)) throw RATE_LIMITED();
  };

  /** The invitation for a token (slai_auth: before any org is known). */
  const byToken = async (c: Ctx) => {
    const token = c.req.param("token") ?? "";
    if (!TOKEN.test(token)) throw notFound("Invitation");
    const [row] = await authDb
      .select({
        id: invitations.id,
        orgId: invitations.orgId,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
        invitedBy: invitations.invitedBy,
        orgName: organizations.name,
      })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.orgId))
      .where(eq(invitations.tokenHash, sha256(token)));
    if (!row) throw notFound("Invitation");
    return row;
  };
  type Found = Awaited<ReturnType<typeof byToken>>;

  /**
   * Claims the invitation (single use, still pending) and joins the org, in one
   * withOrg transaction. An existing active member is only ever promoted; a member
   * deactivated by the IdP (SCIM) is not let back in by an invitation.
   */
  const join = (c: Ctx, inv: Found, userId: string, via: "signup" | "signin") =>
    deps.orgDb.withOrg(inv.orgId, async (tx) => {
      const [existing] = await tx.select().from(memberships).where(eq(memberships.userId, userId)).for("update");
      if (existing?.disabledAt) {
        throw forbidden(
          "Your access to this organization was turned off by its identity provider.",
          "membership_deactivated",
        );
      }
      const now = deps.now();
      const [claimed] = await tx
        .update(invitations)
        .set({ acceptedAt: now, acceptedBy: userId, tokenCiphertext: null })
        .where(
          and(
            eq(invitations.id, inv.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, now),
          ),
        )
        .returning({ id: invitations.id });
      if (!claimed) {
        const s = invitationStatus(inv, now);
        throw GONE[s === "pending" ? "accepted" : s]();
      }
      const role = inv.role as Role;
      let from: Role | null = null;
      if (!existing) {
        await tx.insert(memberships).values({ orgId: inv.orgId, userId, role });
      } else if (ROLE_RANK[role] > ROLE_RANK[existing.role as Role]) {
        from = existing.role as Role;
        await tx.update(memberships).set({ role }).where(eq(memberships.id, existing.id));
      }
      await audit(tx, {
        ...auditBase(c),
        actor: { type: "user", id: userId, name: inv.email },
        orgId: inv.orgId,
        action: "member.invitation_accepted",
        target: { type: "invitation", id: inv.id },
        metadata: { role, via, ...(existing && { alreadyMember: true, from: from ?? existing.role }) },
      });
    });

  app.get("/invitations/:token", async (c) => {
    limit(c, "invite");
    const inv = await byToken(c);
    const [account] = await authDb.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
    const [inviter] = inv.invitedBy
      ? await authDb.select({ name: users.name }).from(users).where(eq(users.id, inv.invitedBy))
      : [];
    const sso = await ssoForEmail(deps, inv.email);
    const out: InvitationPreview = {
      organization: { name: inv.orgName },
      email: inv.email,
      role: inv.role as Role,
      invitedBy: inviter?.name ?? null,
      expiresAt: inv.expiresAt.toISOString(),
      status: invitationStatus(inv, deps.now()),
      account: account ? "exists" : "new",
      sso: sso ? { providerId: sso.providerId, enforced: sso.enforced } : null,
    };
    return c.json(out);
  });

  app.post("/invitations/:token/signup", async (c) => {
    limit(c, "signup");
    const inv = await byToken(c);
    const input = await body(c, acceptInvitationSignupBody);
    const status = invitationStatus(inv, deps.now());
    if (status !== "pending") throw GONE[status]();
    if ((await ssoForEmail(deps, inv.email))?.enforced) throw SSO_REQUIRED();
    const [exists] = await authDb.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
    if (exists) throw conflict("You already have an account. Sign in to accept the invitation.", "account_exists");

    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    const ip = c.get("ip");
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    let created: { headers: Headers; response: { user: { id: string } } };
    try {
      created = (await betterAuth.api.signUpEmail({
        body: { email: inv.email, password: input.password, name: input.name },
        headers,
        returnHeaders: true,
      })) as typeof created;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode ?? 500;
      if (code >= 500) throw e;
      throw conflict("Unable to create an account with this email.", "signup_failed");
    }
    const userId = created.response.user.id;
    try {
      await join(c, inv, userId, "signup");
      await authDb.update(sessions).set({ activeOrgId: inv.orgId }).where(eq(sessions.userId, userId));
    } catch (e) {
      await authDb.delete(users).where(eq(users.id, userId)); // no orphan account
      throw e;
    }
    const setCookies = created.headers.getSetCookie();
    const value = setCookies.map((v) => new RegExp(`^${cookieName}=([^;]+)`).exec(v)?.[1]).find(Boolean);
    const { ctx } = await resolveAuth(deps, betterAuth, new Headers({ cookie: `${cookieName}=${value ?? ""}` }));
    if (!ctx) throw new ApiError(500, "internal", "Account created, but signing in failed. Sign in again.");
    const result: SignInResult = { status: "mfa_enrollment_required", me: await buildMe(authDb, ctx, deps.now()) };
    const out = c.json(result, 201);
    for (const v of setCookies) out.headers.append("set-cookie", v);
    return out;
  });

  app.post("/invitations/:token/accept", requireAuth(), async (c) => {
    limit(c, "invite");
    const a = auth(c);
    const inv = await byToken(c);
    const status = invitationStatus(inv, deps.now());
    if (status !== "pending") throw GONE[status]();
    if (a.user.email.toLowerCase() !== inv.email.toLowerCase()) {
      throw forbidden(
        `This invitation is for ${inv.email}. Sign in with that account to accept it.`,
        "invitation_email_mismatch",
      );
    }
    // Enforce-SSO covers accepting: a password or passkey session cannot join through an invite.
    if (a.authMethod !== "sso" && (await ssoForEmail(deps, inv.email))?.enforced) throw SSO_REQUIRED();
    await join(c, inv, a.user.id, "signin");
    await authDb.update(sessions).set({ activeOrgId: inv.orgId }).where(eq(sessions.id, a.sessionId));
    const { ctx } = await resolveAuth(deps, betterAuth, c.req.raw.headers);
    if (!ctx) throw notFound("Organization");
    return c.json(await buildMe(authDb, ctx, deps.now()));
  });

  return app;
}
