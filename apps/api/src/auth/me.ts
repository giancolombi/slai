import { createHash } from "node:crypto";
import { type Executor, memberships, organizations, sessions } from "@slai/db";
import type { Me, Role } from "@slai/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { AuthContext } from "../context.js";
import { notFound } from "../errors.js";
import { stepUpUntil } from "./step-up.js";

export async function buildMe(db: Executor, a: AuthContext, now: Date = new Date()): Promise<Me> {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      plan: organizations.plan,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, a.user.id), isNull(memberships.disabledAt)))
    .orderBy(asc(memberships.createdAt));
  const active = rows.find((r) => r.id === a.orgId);
  if (!active) throw notFound("Organization");
  return {
    user: a.user,
    organization: { id: active.id, name: active.name, slug: active.slug, plan: active.plan },
    role: a.role,
    organizations: rows.map((r) => ({ id: r.id, name: r.name, role: r.role as Role })),
    security: {
      authMethod: a.authMethod,
      mfa: a.mfa,
      totp: a.factors.totp,
      passkeys: a.factors.passkeys,
      hasPassword: a.factors.hasPassword,
      stepUpUntil: stepUpUntil(a, now)?.toISOString() ?? null,
    },
  };
}

/** The raw token inside a signed better-auth session cookie value (`token.signature`). */
export function tokenOfCookieValue(value: string): string | null {
  const v = decodeURIComponent(value);
  const dot = v.lastIndexOf(".");
  return dot > 0 ? v.slice(0, dot) : null;
}

/** Deletes the session a cookie value refers to (sessions hold only the token's sha256). */
export async function revokeByCookieValue(db: Executor, value: string): Promise<void> {
  const token = tokenOfCookieValue(value);
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, createHash("sha256").update(token).digest("hex")));
}
