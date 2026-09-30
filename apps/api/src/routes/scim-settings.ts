/**
 * SCIM settings for org admins (T-18): bearer tokens (shown once, stored as
 * sha256, revocable, never deleted) and IdP group → role mappings. Tokens need a
 * verified SSO provider (SCIM users sign in through it). Token rows are written by
 * `slai_auth` (the role that resolves them); everything else goes through withOrg.
 */
import { createHash, randomBytes } from "node:crypto";
import { audit, scimGroupRoles, scimTokens, ssoProviders } from "@slai/db";
import {
  createScimTokenBody,
  type ScimGroupRole,
  type ScimSettings,
  type ScimToken,
  type ScimTokenCreated,
  scimGroupRoleBody,
} from "@slai/shared";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { type AppDeps, type AppEnv, auditBase, auth, type Ctx } from "../context.js";
import { conflict, notFound } from "../errors.js";
import { requireRole } from "../middleware/auth.js";
import { recomputeRoles } from "../scim/roles.js";
import { body, idParam } from "../validate.js";

const TOKEN_PREFIX = "slai_scim_";

export function scimSettingsRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const authDb = deps.authDb.db;
  app.use("/org/scim/*", requireRole("admin"));
  app.use("/org/scim", requireRole("admin"));

  const tokenDto = (t: {
    id: string;
    name: string;
    tokenPrefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  }): ScimToken => ({
    id: t.id,
    name: t.name,
    prefix: t.tokenPrefix,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
  });
  const roleDto = (r: typeof scimGroupRoles.$inferSelect): ScimGroupRole => ({
    id: r.id,
    groupName: r.groupName,
    role: r.role as ScimGroupRole["role"],
  });

  const settings = (orgId: string): Promise<ScimSettings> =>
    deps.orgDb.withOrg(orgId, async (tx) => {
      const tokens = await tx
        .select({
          id: scimTokens.id,
          name: scimTokens.name,
          tokenPrefix: scimTokens.tokenPrefix,
          createdAt: scimTokens.createdAt,
          lastUsedAt: scimTokens.lastUsedAt,
          revokedAt: scimTokens.revokedAt,
        })
        .from(scimTokens)
        .orderBy(scimTokens.createdAt);
      const roles = await tx.select().from(scimGroupRoles).orderBy(scimGroupRoles.groupName);
      return { baseUrl: `${deps.env.API_URL}/scim/v2`, tokens: tokens.map(tokenDto), groupRoles: roles.map(roleDto) };
    });

  app.get("/org/scim", async (c) => c.json(await settings(auth(c).orgId)));

  app.post("/org/scim/tokens", async (c) => {
    const a = auth(c);
    const input = await body(c, createScimTokenBody);
    const [verified] = await authDb
      .select({ id: ssoProviders.id })
      .from(ssoProviders)
      .where(and(eq(ssoProviders.orgId, a.orgId), eq(ssoProviders.domainVerified, true)));
    if (!verified) throw conflict("Verify a domain for an SSO provider before turning on SCIM.", "sso_not_ready");
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const row = await authDb.transaction(async (tx) => {
      const [t] = await tx
        .insert(scimTokens)
        .values({
          orgId: a.orgId,
          name: input.name,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          tokenPrefix: token.slice(0, TOKEN_PREFIX.length + 4),
          createdBy: a.user.id,
        })
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "scim.token_created",
        target: { type: "scim_token", id: t!.id },
        metadata: { name: input.name, prefix: t!.tokenPrefix },
      });
      return t!;
    });
    const out: ScimTokenCreated = { ...tokenDto(row), token };
    return c.json(out, 201);
  });

  app.delete("/org/scim/tokens/:id", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "SCIM token");
    await authDb.transaction(async (tx) => {
      const [t] = await tx
        .update(scimTokens)
        .set({ revokedAt: deps.now() })
        .where(and(eq(scimTokens.id, id), eq(scimTokens.orgId, a.orgId), isNull(scimTokens.revokedAt)))
        .returning();
      if (!t) throw notFound("SCIM token");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "scim.token_revoked",
        target: { type: "scim_token", id },
        metadata: { name: t.name, prefix: t.tokenPrefix },
      });
    });
    return c.body(null, 204);
  });

  const remap = (c: Ctx, orgId: string, apply: Parameters<typeof deps.orgDb.withOrg>[1]) =>
    deps.orgDb.withOrg(orgId, async (tx) => {
      const out = await apply(tx);
      await recomputeRoles(tx, orgId, auditBase(c));
      return out;
    });

  app.post("/org/scim/group-roles", async (c) => {
    const a = auth(c);
    const input = await body(c, scimGroupRoleBody);
    const row = await remap(c, a.orgId, async (tx) => {
      const [r] = await tx
        .insert(scimGroupRoles)
        .values({ orgId: a.orgId, groupName: input.groupName, role: input.role })
        .onConflictDoUpdate({ target: [scimGroupRoles.orgId, scimGroupRoles.groupName], set: { role: input.role } })
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "scim.group_role_mapped",
        target: { type: "scim_group_role", id: r!.id },
        metadata: { groupName: input.groupName, role: input.role },
      });
      return r!;
    });
    return c.json(roleDto(row as typeof scimGroupRoles.$inferSelect), 201);
  });

  app.delete("/org/scim/group-roles/:id", async (c) => {
    const a = auth(c);
    const id = idParam(c, "id", "Group mapping");
    await remap(c, a.orgId, async (tx) => {
      const [r] = await tx.delete(scimGroupRoles).where(eq(scimGroupRoles.id, id)).returning();
      if (!r) throw notFound("Group mapping");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "scim.group_role_unmapped",
        target: { type: "scim_group_role", id },
        metadata: { groupName: r.groupName, role: r.role },
      });
    });
    return c.body(null, 204);
  });

  return app;
}
