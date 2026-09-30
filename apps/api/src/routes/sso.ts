/**
 * Org SSO settings and providers (admins and owners). Providers are stored in
 * better-auth's `sso_providers` model so its sign-in/callback endpoints can use
 * them, but written here, not through better-auth's register endpoint: this is
 * where RBAC, validation, secret sealing, domain verification and audit live.
 * Reads go through `withOrg` (RLS); writes use the auth role, always scoped to
 * the caller's org.
 */
import { randomBytes } from "node:crypto";
import { discoverOIDCConfig } from "@better-auth/sso";
import { audit, organizations, ssoProviders } from "@slai/db";
import {
  createSsoProviderBody,
  type OrgSsoSettings,
  type SsoProvider,
  updateOrgSsoBody,
  updateSsoProviderBody,
} from "@slai/shared";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { AUTH_BASE } from "../auth/better-auth.js";
import { domainsOf, domainVerificationRecord } from "../auth/domains.js";
import { sealProviderConfig } from "../auth/sealing-adapter.js";
import { type AppDeps, type AppEnv, auditBase, auth, type Ctx } from "../context.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import { requireRole } from "../middleware/auth.js";
import { body, idParam } from "../validate.js";

type Row = typeof ssoProviders.$inferSelect;
const MAX_METADATA_BYTES = 100_000;

const isPrivateHost = (host: string) =>
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(host) ||
  host.endsWith(".internal") ||
  host.endsWith(".local");

export function ssoRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const authDb = deps.authDb.db;
  const trusted = new Set(deps.env.SSO_TRUSTED_IDP_ORIGINS.map((o) => new URL(o).origin));
  const callbackBase = `${deps.env.API_URL}${AUTH_BASE}/sso`;

  /** IdP URLs must be https on a public host, unless the operator allowlisted the origin. */
  const idpUrlAllowed = (raw: string) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (trusted.has(u.origin)) return true;
    return u.protocol === "https:" && !isPrivateHost(u.hostname);
  };

  const toDto = (r: Row): SsoProvider => {
    const oidc = r.oidcConfig ? (JSON.parse(r.oidcConfig) as { clientId?: string }) : null;
    const saml = r.samlConfig ? (JSON.parse(r.samlConfig) as { slaiMetadataUrl?: string }) : null;
    return {
      id: r.id,
      providerId: r.providerId,
      name: r.name,
      protocol: saml ? "saml" : "oidc",
      issuer: r.issuer,
      domains: domainsOf(r.domain),
      domainVerified: r.domainVerified,
      domainVerification:
        r.domainVerified || !r.domainVerificationToken ? null : domainVerificationRecord(r.domainVerificationToken),
      clientId: oidc?.clientId ?? null,
      metadataUrl: saml?.slaiMetadataUrl ?? null,
      callbackUrl: saml ? `${callbackBase}/saml2/sp/acs/${r.providerId}` : `${callbackBase}/callback/${r.providerId}`,
      createdAt: r.createdAt.toISOString(),
    };
  };

  const settings = async (orgId: string): Promise<OrgSsoSettings> =>
    deps.orgDb.withOrg(orgId, async (tx) => {
      const [o] = await tx.select().from(organizations);
      const rows = await tx.select().from(ssoProviders).orderBy(ssoProviders.createdAt);
      return {
        enforceSso: o?.enforceSso ?? false,
        requireMfaForSso: o?.ssoRequireMfa ?? false,
        requireIdpMfa: o?.ssoRequireIdpMfa ?? false,
        providers: rows.map(toDto),
      };
    });

  const loadOwn = async (c: Ctx) => {
    const id = idParam(c, "id", "SSO provider");
    const [row] = await deps.orgDb.withOrg(auth(c).orgId, (tx) =>
      tx.select().from(ssoProviders).where(eq(ssoProviders.id, id)),
    );
    if (!row) throw notFound("SSO provider");
    return row;
  };

  /** A domain verified by another provider (any org) cannot be claimed again. */
  const assertDomainsFree = async (domains: string[], exceptId?: string) => {
    const verified = await authDb
      .select({ id: ssoProviders.id, domain: ssoProviders.domain })
      .from(ssoProviders)
      .where(
        exceptId
          ? and(eq(ssoProviders.domainVerified, true), ne(ssoProviders.id, exceptId))
          : eq(ssoProviders.domainVerified, true),
      );
    const taken = new Set(verified.flatMap((v) => domainsOf(v.domain)));
    const clash = domains.find((d) => taken.has(d));
    if (clash) throw conflict(`${clash} is already verified for single sign-on elsewhere.`, "domain_taken");
  };

  const oidcConfig = async (issuer: string, clientId: string, clientSecret: string) => {
    if (!idpUrlAllowed(issuer)) throw badRequest("The issuer must be an https URL on a public host.");
    let found: Awaited<ReturnType<typeof discoverOIDCConfig>>;
    try {
      found = await discoverOIDCConfig({ issuer, isTrustedOrigin: idpUrlAllowed });
    } catch (e) {
      deps.logger.warn({ issuer, err: (e as Error).message }, "OIDC discovery failed");
      throw new ApiError(
        422,
        "oidc_discovery_failed",
        "slai couldn't read your identity provider's configuration at that issuer URL. Check the URL and try again.",
      );
    }
    return {
      issuer: found.issuer,
      clientId,
      clientSecret,
      authorizationEndpoint: found.authorizationEndpoint,
      tokenEndpoint: found.tokenEndpoint,
      tokenEndpointAuthentication: found.tokenEndpointAuthentication ?? "client_secret_basic",
      jwksEndpoint: found.jwksEndpoint,
      userInfoEndpoint: found.userInfoEndpoint,
      discoveryEndpoint: found.discoveryEndpoint,
      pkce: true,
      scopes: ["openid", "email", "profile"],
      overrideUserInfo: false,
    };
  };

  const samlConfig = async (providerId: string, metadataUrl?: string, metadataXml?: string) => {
    let xml = metadataXml;
    if (metadataUrl) {
      if (!idpUrlAllowed(metadataUrl)) throw badRequest("The metadata URL must be https on a public host.");
      const res = await deps
        .fetch(metadataUrl, { redirect: "error", signal: AbortSignal.timeout(10_000) })
        .catch(() => null);
      if (!res?.ok)
        throw new ApiError(
          422,
          "saml_metadata_unreachable",
          "slai couldn't download the SAML metadata from that URL. Check the URL, or paste the metadata XML instead.",
        );
      xml = await res.text();
    }
    if (!xml || xml.length > MAX_METADATA_BYTES) throw badRequest("The SAML metadata is missing or too large.");
    const entityId = /entityID="([^"]+)"/.exec(xml)?.[1];
    const sso =
      /<(?:\w+:)?SingleSignOnService[^>]*Binding="[^"]*HTTP-Redirect"[^>]*Location="([^"]+)"/.exec(xml)?.[1] ??
      /<(?:\w+:)?SingleSignOnService[^>]*Location="([^"]+)"/.exec(xml)?.[1];
    const cert = /<(?:\w+:)?X509Certificate>([^<]+)</.exec(xml)?.[1]?.replace(/\s+/g, "");
    if (!entityId || !sso || !cert) {
      throw new ApiError(
        422,
        "saml_metadata_invalid",
        "The metadata needs an entityID, a SingleSignOnService and a signing certificate.",
      );
    }
    return {
      entityId,
      config: {
        issuer: `${callbackBase}/saml2/sp/metadata?providerId=${providerId}`,
        entryPoint: sso,
        cert,
        callbackUrl: `${callbackBase}/saml2/sp/acs/${providerId}`,
        idpMetadata: { metadata: xml, entityID: entityId },
        spMetadata: {},
        wantAssertionsSigned: true,
        identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        slaiMetadataUrl: metadataUrl ?? null,
      },
    };
  };

  app.get("/org/sso", requireRole("admin"), async (c) => c.json(await settings(auth(c).orgId)));

  app.patch("/org/sso", requireRole("admin"), async (c) => {
    const a = auth(c);
    const input = await body(c, updateOrgSsoBody);
    await deps.orgDb.withOrg(a.orgId, async (tx) => {
      const [o] = await tx.select().from(organizations).for("update");
      if (input.enforceSso) {
        const verified = await tx
          .select({ id: ssoProviders.id })
          .from(ssoProviders)
          .where(eq(ssoProviders.domainVerified, true));
        if (verified.length === 0) {
          throw conflict("Verify a domain for an SSO provider before enforcing SSO.", "sso_not_ready");
        }
      }
      await tx
        .update(organizations)
        .set({
          ...(input.enforceSso !== undefined && { enforceSso: input.enforceSso }),
          ...(input.requireMfaForSso !== undefined && { ssoRequireMfa: input.requireMfaForSso }),
          ...(input.requireIdpMfa !== undefined && { ssoRequireIdpMfa: input.requireIdpMfa }),
        })
        .where(eq(organizations.id, a.orgId));
      if (input.enforceSso !== undefined && input.enforceSso !== o?.enforceSso) {
        await audit(tx, {
          ...auditBase(c),
          orgId: a.orgId,
          action: input.enforceSso ? "sso.enforcement_enabled" : "sso.enforcement_disabled",
          target: { type: "organization", id: a.orgId },
        });
      }
      if (input.requireMfaForSso !== undefined && input.requireMfaForSso !== o?.ssoRequireMfa) {
        await audit(tx, {
          ...auditBase(c),
          orgId: a.orgId,
          action: "sso.mfa_policy_changed",
          target: { type: "organization", id: a.orgId },
          metadata: { requireMfaForSso: input.requireMfaForSso },
        });
      }
      if (input.requireIdpMfa !== undefined && input.requireIdpMfa !== o?.ssoRequireIdpMfa) {
        await audit(tx, {
          ...auditBase(c),
          orgId: a.orgId,
          action: "sso.idp_mfa_policy_changed",
          target: { type: "organization", id: a.orgId },
          metadata: { requireIdpMfa: input.requireIdpMfa },
        });
      }
    });
    return c.json(await settings(a.orgId));
  });

  app.post("/org/sso/providers", requireRole("admin"), async (c) => {
    const a = auth(c);
    const input = await body(c, createSsoProviderBody);
    const domains = [...new Set(input.domains)];
    await assertDomainsFree(domains);
    const slug =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30) || "sso";
    const providerId = `${slug}-${randomBytes(4).toString("hex")}`;
    let issuer: string;
    let oidc: string | null = null;
    let saml: string | null = null;
    if (input.protocol === "oidc") {
      const cfg = await oidcConfig(input.issuer, input.clientId, input.clientSecret);
      issuer = cfg.issuer;
      oidc = JSON.stringify(cfg);
    } else {
      const s = await samlConfig(providerId, input.metadataUrl, input.metadataXml);
      issuer = s.entityId;
      saml = JSON.stringify(s.config);
    }
    const sealed = sealProviderConfig({ providerId, oidcConfig: oidc, samlConfig: saml }, deps.keyring);
    const row = await authDb.transaction(async (tx) => {
      const [r] = await tx
        .insert(ssoProviders)
        .values({
          orgId: a.orgId,
          providerId,
          name: input.name,
          issuer,
          domain: domains.join(","),
          domainVerificationToken: randomBytes(18).toString("base64url"),
          oidcConfig: sealed.oidcConfig as string | null,
          samlConfig: sealed.samlConfig as string | null,
          userId: a.user.id,
        })
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "sso.provider_created",
        target: { type: "sso_provider", id: r!.id },
        metadata: { providerId, protocol: input.protocol, domains, issuer },
      });
      return r!;
    });
    return c.json(toDto(row), 201);
  });

  app.patch("/org/sso/providers/:id", requireRole("admin"), async (c) => {
    const a = auth(c);
    const current = await loadOwn(c);
    const input = await body(c, updateSsoProviderBody);
    const domains = input.domains ? [...new Set(input.domains)] : domainsOf(current.domain);
    const domainsChanged = domains.join(",") !== current.domain;
    if (domainsChanged) await assertDomainsFree(domains, current.id);
    const patch: Partial<typeof ssoProviders.$inferInsert> = {};
    if (input.name) patch.name = input.name;
    if (domainsChanged) {
      patch.domain = domains.join(",");
      patch.domainVerified = false;
      patch.domainVerificationToken = randomBytes(18).toString("base64url");
    }
    if (current.oidcConfig && (input.clientId || input.clientSecret)) {
      // The stored config holds the sealed secret; keep it unless a new one is given.
      const cfg = JSON.parse(current.oidcConfig) as Record<string, unknown>;
      if (input.clientId) cfg.clientId = input.clientId;
      if (input.clientSecret) cfg.clientSecret = input.clientSecret;
      patch.oidcConfig = sealProviderConfig(
        { providerId: current.providerId, oidcConfig: JSON.stringify(cfg) },
        deps.keyring,
      ).oidcConfig as string;
    }
    if (current.samlConfig && (input.metadataUrl || input.metadataXml)) {
      const s = await samlConfig(current.providerId, input.metadataUrl, input.metadataXml);
      patch.issuer = s.entityId;
      patch.samlConfig = JSON.stringify(s.config);
    }
    const row = await authDb.transaction(async (tx) => {
      const [r] = await tx
        .update(ssoProviders)
        .set(patch)
        .where(and(eq(ssoProviders.id, current.id), eq(ssoProviders.orgId, a.orgId)))
        .returning();
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "sso.provider_updated",
        target: { type: "sso_provider", id: current.id },
        metadata: {
          fields: Object.keys(input).filter((k) => k !== "clientSecret" || input.clientSecret),
          domainsReset: domainsChanged,
        },
      });
      return r!;
    });
    return c.json(toDto(row));
  });

  app.delete("/org/sso/providers/:id", requireRole("admin"), async (c) => {
    const a = auth(c);
    const current = await loadOwn(c);
    await authDb.transaction(async (tx) => {
      await tx.delete(ssoProviders).where(and(eq(ssoProviders.id, current.id), eq(ssoProviders.orgId, a.orgId)));
      // Enforcement without any verified provider would lock everyone out.
      const left = await tx
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(and(eq(ssoProviders.orgId, a.orgId), eq(ssoProviders.domainVerified, true)));
      if (left.length === 0) {
        const [o] = await tx
          .select({ enforceSso: organizations.enforceSso })
          .from(organizations)
          .where(eq(organizations.id, a.orgId));
        if (o?.enforceSso) {
          await deps.orgDb.withOrg(a.orgId, (otx) =>
            otx.update(organizations).set({ enforceSso: false }).where(eq(organizations.id, a.orgId)),
          );
          await audit(tx, {
            ...auditBase(c),
            orgId: a.orgId,
            action: "sso.enforcement_disabled",
            target: { type: "organization", id: a.orgId },
            metadata: { reason: "last_verified_provider_deleted" },
          });
        }
      }
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "sso.provider_deleted",
        target: { type: "sso_provider", id: current.id },
        metadata: { providerId: current.providerId, domains: domainsOf(current.domain) },
      });
    });
    return c.body(null, 204);
  });

  app.post("/org/sso/providers/:id/verify-domain", requireRole("admin"), async (c) => {
    const a = auth(c);
    const current = await loadOwn(c);
    if (current.domainVerified) return c.json(toDto(current));
    const domains = domainsOf(current.domain);
    await assertDomainsFree(domains, current.id);
    const record = domainVerificationRecord(current.domainVerificationToken ?? "");
    const missing: string[] = [];
    for (const d of domains) {
      const txt = await deps.resolveTxt(`${record.recordName}.${d}`).catch(() => [] as string[][]);
      if (!txt.some((parts) => parts.join("").trim() === record.recordValue)) missing.push(d);
    }
    if (missing.length > 0) {
      await audit(authDb, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "sso.domain_verification_failed",
        target: { type: "sso_provider", id: current.id },
        metadata: { missing },
      });
      throw new ApiError(
        422,
        "domain_not_verified",
        `slai couldn't find the TXT record for ${missing.join(", ")} yet. DNS changes can take a while; try again later.`,
        {
          missing,
        },
      );
    }
    const row = await authDb.transaction(async (tx) => {
      const [r] = await tx
        .update(ssoProviders)
        .set({ domainVerified: true })
        .where(
          and(
            eq(ssoProviders.id, current.id),
            eq(ssoProviders.orgId, a.orgId),
            eq(ssoProviders.domain, current.domain),
          ),
        )
        .returning();
      if (!r) throw conflict("The provider changed while verifying. Try again.", "sso_provider_changed");
      await audit(tx, {
        ...auditBase(c),
        orgId: a.orgId,
        action: "sso.domain_verified",
        target: { type: "sso_provider", id: current.id },
        metadata: { domains },
      });
      return r;
    });
    return c.json(toDto(row));
  });

  return app;
}
