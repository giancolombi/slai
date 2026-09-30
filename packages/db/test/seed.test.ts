import { randomBytes } from "node:crypto";
import { parsePolicy } from "@slai/sla-engine";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createKeyring, decryptJson } from "../src/crypto.js";
import { verifyPassword } from "../src/passwords.js";
import { connections, customerAccounts, slaPolicies, users } from "../src/schema.js";
import { DEMO, seed } from "../src/seed.js";
import { openDbs, urls } from "./helpers.js";

const { app, owner } = openDbs();
const keyring = createKeyring({ key: randomBytes(32).toString("base64"), keyId: "k1" });

describe("seed", () => {
  it("creates the demo org and is idempotent", async () => {
    const first = await seed(urls.owner, { keyring });
    const second = await seed(urls.owner, { keyring });
    expect(second).toEqual(first);

    const counts = await app.withOrg(first.orgId, async (tx) => ({
      policies: await tx.select().from(slaPolicies),
      customers: await tx.select().from(customerAccounts),
      conns: await tx.select().from(connections),
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
    expect(decryptJson(counts.conns[0]!.credentials, { keyring, aad: `connection:${first.connectionId}` })).toEqual({});

    const active = counts.policies.filter((p) => p.status === "active");
    expect(active).toHaveLength(2);
    expect(active.filter((p) => p.isDefault).map((p) => p.name)).toEqual(["Enterprise Support SLA"]);
    for (const p of active) expect(() => parsePolicy(p.definition)).not.toThrow();

    const [u] = await owner.db.select().from(users).where(eq(users.email, DEMO.email));
    expect(await verifyPassword(u!.passwordHash, DEMO.password)).toBe(true);
  });
});
