import { randomBytes } from "node:crypto";
import { parsePolicy } from "@slai/sla-engine";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authSecrets, openForAuth } from "../src/auth-secrets.js";
import { createKeyring, decryptJson } from "../src/crypto.js";
import { verifyPassword } from "../src/passwords.js";
import {
  accounts,
  connections,
  customerAccounts,
  knowledgeSources,
  slaPolicies,
  twoFactors,
  users,
} from "../src/schema.js";
import { DEMO, DEMO_OTPAUTH_URL, DEMO_TOTP_BASE32, seed } from "../src/seed.js";
import { base32Decode } from "../src/totp.js";
import { openDbs, urls } from "./helpers.js";

const { app, owner } = openDbs();
const keyring = createKeyring({ key: randomBytes(32).toString("base64"), keyId: "k1" });
const secrets = authSecrets(randomBytes(32).toString("base64"));

describe("seed", () => {
  it("creates the demo org and is idempotent", async () => {
    const first = await seed(urls.owner, { keyring, authSecrets: secrets });
    const second = await seed(urls.owner, { keyring, authSecrets: secrets });
    expect(second).toEqual(first);

    const counts = await app.withOrg(first.orgId, async (tx) => ({
      policies: await tx.select().from(slaPolicies),
      customers: await tx.select().from(customerAccounts),
      conns: await tx.select().from(connections),
      knowledge: await tx.select().from(knowledgeSources),
    }));
    expect(counts.customers.map((c) => c.name).sort()).toEqual([
      "Bluepeak Logistics",
      "Cobalt Insurance",
      "Lumen Retail Group",
      "Meridian Payments",
      "Northwind Analytics",
      "Quillon Health",
    ]);
    // Customers must match the demo help desk's requester orgs, or demo tickets never reach them.
    expect(counts.customers.every((c) => c.externalOrgIds.length === 1 && c.domains[0]!.endsWith(".example"))).toBe(
      true,
    );
    expect(counts.conns).toHaveLength(1);
    expect(counts.conns[0]!.provider).toBe("demo");
    // A fresh install syncs the demo help center: one never-synced article source on the demo connection.
    expect(counts.knowledge).toHaveLength(1);
    expect(counts.knowledge[0]).toMatchObject({
      id: first.knowledgeSourceId,
      connectionId: first.connectionId,
      kind: "helpdesk_articles",
      lastSyncAt: null,
    });
    expect(decryptJson(counts.conns[0]!.credentials, { keyring, aad: `connection:${first.connectionId}` })).toEqual({});

    const active = counts.policies.filter((p) => p.status === "active");
    expect(active).toHaveLength(2);
    expect(active.filter((p) => p.isDefault).map((p) => p.name)).toEqual(["Enterprise Support SLA"]);
    for (const p of active) expect(() => parsePolicy(p.definition)).not.toThrow();

    const [u] = await owner.db.select().from(users).where(eq(users.email, DEMO.email));
    const [account] = await owner.db.select().from(accounts).where(eq(accounts.userId, u!.id));
    expect(account!.providerId).toBe("credential");
    expect(await verifyPassword(account!.password!, DEMO.password)).toBe(true);
  });

  it("pre-enrolls the demo user in TOTP with the fixed dev secret, sealed at rest", async () => {
    await seed(urls.owner, { keyring, authSecrets: secrets });
    const [u] = await owner.db.select().from(users).where(eq(users.email, DEMO.email));
    expect(u!.mfaEnabled).toBe(true);
    const [tf] = await owner.db.select().from(twoFactors).where(eq(twoFactors.userId, u!.id));
    expect(tf!.secret).toMatch(/^\$ba\$1\$/);
    expect(tf!.secret).not.toContain(DEMO.totpSecret);
    expect(await openForAuth(tf!.secret, secrets)).toBe(DEMO.totpSecret);
    expect(JSON.parse(await openForAuth(tf!.backupCodes, secrets))).toEqual(DEMO.backupCodes);
    // The base32 form (authenticator apps, `pnpm demo:otp`) is the same key.
    expect(base32Decode(DEMO_TOTP_BASE32).toString("utf8")).toBe(DEMO.totpSecret);
    expect(DEMO_OTPAUTH_URL).toContain(`secret=${DEMO_TOTP_BASE32}`);
  });
});
