/**
 * SCIM 2.0 provisioning (T-18, TR-23c) at `/scim/v2`: Users and Groups for an
 * org's IdP (Okta, Entra ID), authenticated by a per-org bearer token (stored as
 * sha256, resolved by `slai_auth`). A SCIM User is a membership of the token's
 * org: its id is the membership id, `userName` is the email.
 *
 * - Create: the email must be on one of the org's verified SSO domains; an
 *   existing slai user is linked, otherwise a password-less user is created (they
 *   sign in through SSO).
 * - `active: false` disables the membership and revokes the user's sessions in
 *   this org; DELETE removes the membership. The last active owner is protected.
 * - Groups carry members; mapped groups (SSO settings) set the members' roles
 *   (scim/roles.ts).
 * - Names are only updated for users who belong to no other organization, and
 *   `userName` is immutable.
 * Every write is audited with the token as the actor. Org data goes through
 * `withOrg`; users and sessions (identity tables) through authDb.
 */
import { createHash } from "node:crypto";
import {
  type AuditEntry,
  audit,
  memberships,
  scimGroupMembers,
  scimGroups,
  scimTokens,
  sessions,
  ssoProviders,
  type Tx,
  users,
} from "@slai/db";
import { and, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import { domainsOf, emailDomain } from "../auth/domains.js";
import type { AppDeps, AppEnv } from "../context.js";
import { ApiError } from "../errors.js";
import {
  displayNameOf,
  emailOf,
  GROUP_SCHEMA,
  groupPatch,
  listResponse,
  paging,
  parseEqFilter,
  patchBody,
  SCIM_CONTENT_TYPE,
  ScimError,
  scimGroupBody,
  scimUserBody,
  USER_SCHEMA,
  type UserChanges,
  userPatch,
} from "../scim/protocol.js";
import { recomputeRoles } from "../scim/roles.js";

type ScimEnv = { Variables: AppEnv["Variables"] & { scim: { orgId: string; tokenId: string; tokenName: string } } };
type C = Context<ScimEnv>;

const TOUCH_EVERY_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const uniqueViolation = (e: unknown) =>
  (e as { code?: string }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505";

export function scimRoutes(deps: AppDeps) {
  const app = new Hono<ScimEnv>();
  const authDb = deps.authDb.db;
  const base = `${deps.env.API_URL}/scim/v2`;

  const send = (c: C, payload: unknown, status = 200) =>
    c.body(JSON.stringify(payload), status as 200, { "content-type": SCIM_CONTENT_TYPE });

  app.onError((err, c) => {
    if (err instanceof ScimError) return send(c, err.body(), err.status);
    if (err instanceof ApiError && err.status === 413) return send(c, new ScimError(413, err.message).body(), 413);
    deps.logger.error({ requestId: c.get("requestId"), err: (err as Error).message }, "scim error");
    return send(c, new ScimError(500, "Internal error.").body(), 500);
  });

  // ------------------------------------------------------------------ bearer token → org
  app.use("*", async (c, next) => {
    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) throw new ScimError(401, "A bearer token is required.");
    const [t] = await authDb
      .select({ id: scimTokens.id, orgId: scimTokens.orgId, name: scimTokens.name, lastUsedAt: scimTokens.lastUsedAt })
      .from(scimTokens)
      .where(and(eq(scimTokens.tokenHash, sha256(token)), isNull(scimTokens.revokedAt)));
    if (!t) throw new ScimError(401, "The bearer token is not valid.");
    if (!deps.rateLimits.webhook.take(`scim:${t.id}`)) throw new ScimError(429, "Too many requests.");
    const now = deps.now();
    if (!t.lastUsedAt || now.getTime() - t.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      await authDb.update(scimTokens).set({ lastUsedAt: now }).where(eq(scimTokens.id, t.id));
    }
    c.set("scim", { orgId: t.orgId, tokenId: t.id, tokenName: t.name });
    await next();
  });

  const orgOf = (c: C) => c.get("scim").orgId;
  const actor = (c: C): Pick<AuditEntry, "actor" | "ip" | "userAgent" | "requestId"> => ({
    actor: { type: "system", id: c.get("scim").tokenId, name: `scim:${c.get("scim").tokenName}` },
    ip: c.get("ip"),
    userAgent: c.req.header("user-agent")?.slice(0, 500) ?? null,
    requestId: c.get("requestId"),
  });
  const log = (tx: Tx, c: C, action: string, target: AuditEntry["target"], metadata: Record<string, unknown>) =>
    audit(tx, { ...actor(c), orgId: orgOf(c), action, target, metadata });

  const read = async <S extends z.ZodType>(c: C, schema: S): Promise<z.output<S>> => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ScimError(400, "The body must be JSON.", "invalidSyntax");
    }
    const r = schema.safeParse(raw);
    if (!r.success) {
      const first = r.error.issues[0];
      throw new ScimError(400, `Invalid ${first?.path.join(".") || "body"}: ${first?.message}`, "invalidValue");
    }
    return r.data;
  };
  const idOf = (c: C, what: string) => {
    const id = c.req.param("id") ?? "";
    if (!UUID.test(id)) throw new ScimError(404, `${what} not found.`);
    return id;
  };

  // ------------------------------------------------------------------ Users

  type UserRow = {
    id: string;
    userId: string;
    email: string;
    name: string;
    role: string;
    externalId: string | null;
    disabledAt: Date | null;
    createdAt: Date;
  };
  const userCols = {
    id: memberships.id,
    userId: users.id,
    email: users.email,
    name: users.name,
    role: memberships.role,
    externalId: memberships.scimExternalId,
    disabledAt: memberships.disabledAt,
    createdAt: memberships.createdAt,
  };
  const selectUsers = (tx: Tx, where?: SQL) =>
    tx
      .select(userCols)
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(where)
      .orderBy(memberships.createdAt);

  const groupsOf = async (tx: Tx, membershipIds: string[]) =>
    membershipIds.length === 0
      ? []
      : tx
          .select({ membershipId: scimGroupMembers.membershipId, id: scimGroups.id, name: scimGroups.displayName })
          .from(scimGroupMembers)
          .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
          .where(inArray(scimGroupMembers.membershipId, membershipIds));

  const toUser = (r: UserRow, groups: { membershipId: string; id: string; name: string }[]) => {
    const [given, ...rest] = r.name.split(" ");
    return {
      schemas: [USER_SCHEMA],
      id: r.id,
      ...(r.externalId && { externalId: r.externalId }),
      userName: r.email,
      name: { formatted: r.name, givenName: given ?? "", familyName: rest.join(" ") },
      displayName: r.name,
      emails: [{ value: r.email, type: "work", primary: true }],
      active: r.disabledAt === null,
      groups: groups
        .filter((g) => g.membershipId === r.id)
        .map((g) => ({ value: g.id, display: g.name, $ref: `${base}/Groups/${g.id}` })),
      meta: { resourceType: "User", created: r.createdAt.toISOString(), location: `${base}/Users/${r.id}` },
    };
  };

  const userById = async (tx: Tx, id: string) => {
    const [row] = await selectUsers(tx, eq(memberships.id, id));
    if (!row) throw new ScimError(404, "User not found.");
    return row;
  };
  const renderUser = async (tx: Tx, id: string) => {
    const row = await userById(tx, id);
    return toUser(row, await groupsOf(tx, [row.id]));
  };

  /** The org's last active owner can be neither deactivated nor removed by the IdP. */
  const assertNotLastOwner = async (tx: Tx, row: UserRow) => {
    if (row.role !== "owner" || row.disabledAt) return;
    const [n] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.role, "owner"), isNull(memberships.disabledAt), ne(memberships.id, row.id)));
    if ((n?.n ?? 0) === 0) {
      throw new ScimError(400, "This is the organization's only owner; slai keeps them active.", "mutability");
    }
  };

  /** Revokes the user's sessions that act in this org (or came through its IdP). */
  const revokeSessions = async (orgId: string, userId: string) => {
    const gone = await authDb
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), or(eq(sessions.activeOrgId, orgId), eq(sessions.ssoOrgId, orgId))))
      .returning({ id: sessions.id });
    return gone.length;
  };

  /** Applies attribute changes to a SCIM User (PATCH and PUT). */
  const applyUser = async (c: C, id: string, ch: UserChanges) => {
    const orgId = orgOf(c);
    const row = await deps.orgDb.withOrg(orgId, (tx) => userById(tx, id));
    if (ch.userName !== undefined && ch.userName.toLowerCase() !== row.email.toLowerCase()) {
      throw new ScimError(400, "userName cannot be changed.", "mutability");
    }
    const deactivate = ch.active === false && row.disabledAt === null;
    const reactivate = ch.active === true && row.disabledAt !== null;
    if (deactivate) await deps.orgDb.withOrg(orgId, (tx) => assertNotLastOwner(tx, row));
    const revoked = deactivate ? await revokeSessions(orgId, row.userId) : 0;

    const name =
      ch.displayName ??
      (ch.givenName !== undefined || ch.familyName !== undefined
        ? [ch.givenName ?? row.name.split(" ")[0], ch.familyName ?? row.name.split(" ").slice(1).join(" ")]
            .filter(Boolean)
            .join(" ")
        : undefined);
    let renamed = false;
    if (name && name !== row.name) {
      // A user's name is global: only an IdP whose org is their only org may change it.
      const others = await authDb
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.userId, row.userId), ne(memberships.orgId, orgId)));
      if (others.length === 0) {
        await authDb.update(users).set({ name }).where(eq(users.id, row.userId));
        renamed = true;
      }
    }

    return deps.orgDb.withOrg(orgId, async (tx) => {
      await tx
        .update(memberships)
        .set({
          scimManaged: true,
          ...(ch.externalId !== undefined && { scimExternalId: ch.externalId }),
          ...(deactivate && { disabledAt: deps.now() }),
          ...(reactivate && { disabledAt: null }),
        })
        .where(eq(memberships.id, id));
      if (deactivate) {
        await log(tx, c, "scim.user_deactivated", { type: "user", id: row.userId }, { sessionsRevoked: revoked });
      } else if (reactivate) {
        await log(tx, c, "scim.user_reactivated", { type: "user", id: row.userId }, {});
      }
      if (renamed || ch.externalId !== undefined) {
        await log(tx, c, "scim.user_updated", { type: "user", id: row.userId }, { renamed, externalId: ch.externalId });
      }
      await recomputeRoles(tx, orgId, actor(c), [id]);
      return renderUser(tx, id);
    });
  };

  app.get("/ServiceProviderConfig", (c) =>
    send(c, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        { type: "oauthbearertoken", name: "Bearer token", description: "A per-organization SCIM token from slai." },
      ],
    }),
  );

  app.get("/Users", async (c) => {
    const f = parseEqFilter(c.req.query("filter"), ["userName", "externalId", "emails.value", "id"]);
    const { startIndex, count } = paging(c.req.query());
    const where =
      f === null
        ? undefined
        : f.attr === "externalId"
          ? eq(memberships.scimExternalId, f.value)
          : f.attr === "id"
            ? UUID.test(f.value)
              ? eq(memberships.id, f.value)
              : sql`false`
            : eq(users.email, f.value);
    const out = await deps.orgDb.withOrg(orgOf(c), async (tx) => {
      const rows = await selectUsers(tx, where);
      const page = rows.slice(startIndex - 1, startIndex - 1 + count);
      const groups = await groupsOf(
        tx,
        page.map((r) => r.id),
      );
      return { ...listResponse(rows, startIndex, count), Resources: page.map((r) => toUser(r, groups)) };
    });
    return send(c, out);
  });

  app.get("/Users/:id", async (c) => {
    const id = idOf(c, "User");
    return send(c, await deps.orgDb.withOrg(orgOf(c), (tx) => renderUser(tx, id)));
  });

  app.post("/Users", async (c) => {
    const orgId = orgOf(c);
    const input = await read(c, scimUserBody);
    const email = emailOf(input);
    if (!email) throw new ScimError(400, "userName (or the primary email) must be an email address.", "invalidValue");
    const domain = emailDomain(email);
    const verified = await authDb
      .select({ domain: ssoProviders.domain })
      .from(ssoProviders)
      .where(and(eq(ssoProviders.orgId, orgId), eq(ssoProviders.domainVerified, true)));
    if (!domain || !verified.some((p) => domainsOf(p.domain).includes(domain))) {
      throw new ScimError(400, "The email must be on one of the organization's verified SSO domains.", "invalidValue");
    }
    let [u] = await authDb.select({ id: users.id }).from(users).where(eq(users.email, email));
    const createdUser = !u;
    if (!u) {
      [u] = await authDb
        .insert(users)
        .values({ email, name: displayNameOf(input) })
        .returning({ id: users.id });
    }
    const userId = u!.id;
    try {
      const id = await deps.orgDb.withOrg(orgId, async (tx) => {
        const [existing] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(eq(memberships.userId, userId));
        if (existing) throw new ScimError(409, "A user with this userName already exists.", "uniqueness");
        const [m] = await tx
          .insert(memberships)
          .values({
            orgId,
            userId,
            role: "member",
            scimManaged: true,
            scimExternalId: input.externalId ?? null,
            disabledAt: input.active === false ? deps.now() : null,
          })
          .returning({ id: memberships.id });
        await log(
          tx,
          c,
          "scim.user_provisioned",
          { type: "user", id: userId },
          {
            email,
            createdUser,
            active: input.active !== false,
          },
        );
        await recomputeRoles(tx, orgId, actor(c), [m!.id]);
        return m!.id;
      });
      const resource = await deps.orgDb.withOrg(orgId, (tx) => renderUser(tx, id));
      c.header("location", resource.meta.location);
      return send(c, resource, 201);
    } catch (e) {
      if (createdUser) await authDb.delete(users).where(eq(users.id, userId)); // no orphan user without an org
      throw e;
    }
  });

  app.patch("/Users/:id", async (c) => {
    const id = idOf(c, "User");
    const input = await read(c, patchBody);
    return send(c, await applyUser(c, id, userPatch(input.Operations)));
  });

  app.put("/Users/:id", async (c) => {
    const id = idOf(c, "User");
    const input = await read(c, scimUserBody);
    const email = emailOf(input) ?? input.userName;
    return send(
      c,
      await applyUser(c, id, {
        userName: email,
        active: input.active ?? true,
        externalId: input.externalId ?? null,
        displayName: displayNameOf(input),
      }),
    );
  });

  app.delete("/Users/:id", async (c) => {
    const id = idOf(c, "User");
    const orgId = orgOf(c);
    const row = await deps.orgDb.withOrg(orgId, async (tx) => {
      const r = await userById(tx, id);
      await assertNotLastOwner(tx, r);
      return r;
    });
    const revoked = await revokeSessions(orgId, row.userId);
    await deps.orgDb.withOrg(orgId, async (tx) => {
      await tx.delete(memberships).where(eq(memberships.id, id));
      await log(
        tx,
        c,
        "scim.user_deleted",
        { type: "user", id: row.userId },
        {
          email: row.email,
          role: row.role,
          sessionsRevoked: revoked,
        },
      );
    });
    return c.body(null, 204);
  });

  // ------------------------------------------------------------------ Groups

  type GroupRow = typeof scimGroups.$inferSelect;
  const membersOf = (tx: Tx, groupIds: string[]) =>
    groupIds.length === 0
      ? Promise.resolve([] as { groupId: string; membershipId: string; email: string }[])
      : tx
          .select({
            groupId: scimGroupMembers.groupId,
            membershipId: scimGroupMembers.membershipId,
            email: users.email,
          })
          .from(scimGroupMembers)
          .innerJoin(memberships, eq(memberships.id, scimGroupMembers.membershipId))
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(inArray(scimGroupMembers.groupId, groupIds));

  const toGroup = (g: GroupRow, members: { groupId: string; membershipId: string; email: string }[] | null) => ({
    schemas: [GROUP_SCHEMA],
    id: g.id,
    displayName: g.displayName,
    ...(g.externalId && { externalId: g.externalId }),
    ...(members && {
      members: members
        .filter((m) => m.groupId === g.id)
        .map((m) => ({ value: m.membershipId, display: m.email, $ref: `${base}/Users/${m.membershipId}` })),
    }),
    meta: {
      resourceType: "Group",
      created: g.createdAt.toISOString(),
      lastModified: g.updatedAt.toISOString(),
      location: `${base}/Groups/${g.id}`,
    },
  });

  const groupById = async (tx: Tx, id: string) => {
    const [g] = await tx.select().from(scimGroups).where(eq(scimGroups.id, id));
    if (!g) throw new ScimError(404, "Group not found.");
    return g;
  };
  const renderGroup = async (tx: Tx, id: string) => toGroup(await groupById(tx, id), await membersOf(tx, [id]));

  /** Member ids must be SCIM Users (memberships) of this org. */
  const assertMembers = async (tx: Tx, ids: string[]) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return unique;
    if (unique.some((v) => !UUID.test(v))) throw new ScimError(400, "Unknown member.", "invalidValue");
    const found = await tx.select({ id: memberships.id }).from(memberships).where(inArray(memberships.id, unique));
    if (found.length !== unique.length) throw new ScimError(400, "Unknown member.", "invalidValue");
    return unique;
  };

  /** Sets a group's members; returns the memberships whose groups changed. */
  const setMembers = async (tx: Tx, orgId: string, groupId: string, next: string[]) => {
    const before = (
      await tx
        .select({ id: scimGroupMembers.membershipId })
        .from(scimGroupMembers)
        .where(eq(scimGroupMembers.groupId, groupId))
    ).map((r) => r.id);
    const add = next.filter((id) => !before.includes(id));
    const remove = before.filter((id) => !next.includes(id));
    if (remove.length > 0) {
      await tx
        .delete(scimGroupMembers)
        .where(and(eq(scimGroupMembers.groupId, groupId), inArray(scimGroupMembers.membershipId, remove)));
    }
    if (add.length > 0) {
      await tx.insert(scimGroupMembers).values(add.map((membershipId) => ({ orgId, groupId, membershipId })));
    }
    return { add, remove, before };
  };

  app.get("/Groups", async (c) => {
    const f = parseEqFilter(c.req.query("filter"), ["displayName", "externalId", "id"]);
    const { startIndex, count } = paging(c.req.query());
    const withMembers = !(c.req.query("excludedAttributes") ?? "").toLowerCase().includes("members");
    const where =
      f === null
        ? undefined
        : f.attr === "displayName"
          ? eq(scimGroups.displayName, f.value)
          : f.attr === "externalId"
            ? eq(scimGroups.externalId, f.value)
            : UUID.test(f.value)
              ? eq(scimGroups.id, f.value)
              : sql`false`;
    const out = await deps.orgDb.withOrg(orgOf(c), async (tx) => {
      const rows = await tx.select().from(scimGroups).where(where).orderBy(scimGroups.createdAt);
      const page = rows.slice(startIndex - 1, startIndex - 1 + count);
      const members = withMembers
        ? await membersOf(
            tx,
            page.map((g) => g.id),
          )
        : null;
      return { ...listResponse(rows, startIndex, count), Resources: page.map((g) => toGroup(g, members)) };
    });
    return send(c, out);
  });

  app.get("/Groups/:id", async (c) => {
    const id = idOf(c, "Group");
    return send(c, await deps.orgDb.withOrg(orgOf(c), (tx) => renderGroup(tx, id)));
  });

  app.post("/Groups", async (c) => {
    const orgId = orgOf(c);
    const input = await read(c, scimGroupBody);
    try {
      const out = await deps.orgDb.withOrg(orgId, async (tx) => {
        const ids = await assertMembers(
          tx,
          (input.members ?? []).map((m) => m.value),
        );
        const [g] = await tx
          .insert(scimGroups)
          .values({ orgId, displayName: input.displayName, externalId: input.externalId ?? null })
          .returning();
        await setMembers(tx, orgId, g!.id, ids);
        await log(
          tx,
          c,
          "scim.group_created",
          { type: "scim_group", id: g!.id },
          {
            displayName: input.displayName,
            members: ids.length,
          },
        );
        await recomputeRoles(tx, orgId, actor(c), ids);
        return renderGroup(tx, g!.id);
      });
      c.header("location", out.meta.location);
      return send(c, out, 201);
    } catch (e) {
      if (uniqueViolation(e)) throw new ScimError(409, "A group with this displayName already exists.", "uniqueness");
      throw e;
    }
  });

  const updateGroup = async (
    c: C,
    id: string,
    ch: { displayName?: string; externalId?: string | null; add?: string[]; remove?: string[]; replace?: string[] },
  ) => {
    const orgId = orgOf(c);
    try {
      return await deps.orgDb.withOrg(orgId, async (tx) => {
        const g = await groupById(tx, id);
        const renamed = ch.displayName !== undefined && ch.displayName !== g.displayName;
        if (renamed || ch.externalId !== undefined) {
          await tx
            .update(scimGroups)
            .set({
              ...(renamed && { displayName: ch.displayName }),
              ...(ch.externalId !== undefined && { externalId: ch.externalId }),
              updatedAt: deps.now(),
            })
            .where(eq(scimGroups.id, id));
        }
        const current = (
          await tx
            .select({ id: scimGroupMembers.membershipId })
            .from(scimGroupMembers)
            .where(eq(scimGroupMembers.groupId, id))
        ).map((r) => r.id);
        let next = ch.replace ? await assertMembers(tx, ch.replace) : current;
        next = [...new Set([...next, ...(await assertMembers(tx, ch.add ?? []))])];
        next = next.filter((m) => !(ch.remove ?? []).includes(m));
        const diff = await setMembers(tx, orgId, id, next);
        if (renamed || diff.add.length > 0 || diff.remove.length > 0 || ch.externalId !== undefined) {
          await log(
            tx,
            c,
            "scim.group_updated",
            { type: "scim_group", id },
            {
              displayName: ch.displayName ?? g.displayName,
              ...(renamed && { renamedFrom: g.displayName }),
              added: diff.add.length,
              removed: diff.remove.length,
            },
          );
        }
        // A rename can change which mapping applies to every member.
        const affected = renamed ? [...new Set([...diff.before, ...next])] : [...diff.add, ...diff.remove];
        await recomputeRoles(tx, orgId, actor(c), affected);
        return renderGroup(tx, id);
      });
    } catch (e) {
      if (uniqueViolation(e)) throw new ScimError(409, "A group with this displayName already exists.", "uniqueness");
      throw e;
    }
  };

  app.patch("/Groups/:id", async (c) => {
    const id = idOf(c, "Group");
    const input = await read(c, patchBody);
    return send(c, await updateGroup(c, id, groupPatch(input.Operations)));
  });

  app.put("/Groups/:id", async (c) => {
    const id = idOf(c, "Group");
    const input = await read(c, scimGroupBody);
    return send(
      c,
      await updateGroup(c, id, {
        displayName: input.displayName,
        externalId: input.externalId ?? null,
        replace: (input.members ?? []).map((m) => m.value),
      }),
    );
  });

  app.delete("/Groups/:id", async (c) => {
    const id = idOf(c, "Group");
    const orgId = orgOf(c);
    await deps.orgDb.withOrg(orgId, async (tx) => {
      const g = await groupById(tx, id);
      const before = (
        await tx
          .select({ id: scimGroupMembers.membershipId })
          .from(scimGroupMembers)
          .where(eq(scimGroupMembers.groupId, id))
      ).map((r) => r.id);
      await tx.delete(scimGroups).where(eq(scimGroups.id, id));
      await log(tx, c, "scim.group_deleted", { type: "scim_group", id }, { displayName: g.displayName });
      await recomputeRoles(tx, orgId, actor(c), before);
    });
    return c.body(null, 204);
  });

  // Unknown SCIM endpoints answer in SCIM's error format.
  app.all("*", () => {
    throw new ScimError(404, "Not found.");
  });

  return app;
}
