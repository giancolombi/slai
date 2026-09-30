import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AAD, createKeyring, decrypt, decryptJson, encrypt, encryptJson, keyIdOf } from "../src/crypto.js";
import { rotateSecrets } from "../src/rotate-keys.js";
import { connections, notificationChannels, users } from "../src/schema.js";
import { openDbs, seedOrg } from "./helpers.js";

const { owner, system } = openDbs();
const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");
const oldRing = createKeyring({ key: k1, keyId: "rot1" });
const newRing = createKeyring({ key: k2, keyId: "rot2", previous: `rot1:${k1}` });
const newOnly = createKeyring({ key: k2, keyId: "rot2" });

const listOrgIds = async () =>
  (await system.db.execute<{ id: string }>(sql`select id::text as id from organizations`)).map((r) => r.id);

describe("keys:rotate", () => {
  it("re-encrypts every secret under the new key id, keeps the plaintext, and is idempotent", async () => {
    const { orgId, connectionId } = await seedOrg(owner, 0);
    const creds = { apiToken: "zd-secret-token", subdomain: "acme" };
    await owner.db
      .update(connections)
      .set({
        credentials: encryptJson(creds, { keyring: oldRing, aad: AAD.connectionCredentials(connectionId) }),
        webhookSecret: encrypt("whsec", { keyring: oldRing, aad: AAD.connectionWebhookSecret(connectionId) }),
      })
      .where(eq(connections.id, connectionId));
    const slackId = randomUUID();
    const hook = "https://hooks.slack.com/services/T/B/secret";
    await owner.db.insert(notificationChannels).values([
      {
        id: slackId,
        orgId,
        kind: "slack_webhook",
        target: encrypt(hook, { keyring: oldRing, aad: AAD.notificationTarget(slackId) }),
      },
      { orgId, kind: "email", target: "v1.looks.like.cipher.text@example.com" },
    ]);
    const userId = randomUUID();
    await owner.db.insert(users).values({
      id: userId,
      email: `${userId}@example.com`,
      name: "Rotator",
      passwordHash: "x",
      mfaSecret: encrypt("JBSWY3DPEHPK3PXP", { keyring: oldRing, aad: `user:${userId}:mfa` }),
    });

    const dry = await rotateSecrets({ owner: owner.db, listOrgIds, keyring: newRing, dryRun: true });
    expect(dry.remaining.rot1).toBeGreaterThanOrEqual(4);
    const [stillOld] = await owner.db.select().from(connections).where(eq(connections.id, connectionId));
    expect(keyIdOf(stillOld!.credentials)).toBe("rot1");

    const report = await rotateSecrets({ owner: owner.db, listOrgIds, keyring: newRing });
    const byName = Object.fromEntries(report.columns.map((c) => [c.name, c]));
    expect(byName["connections.credentials"]).toMatchObject({ rotated: 1, failed: 0 });
    expect(byName["connections.webhook_secret"]).toMatchObject({ rotated: 1, failed: 0 });
    expect(byName["notification_channels.target"]).toMatchObject({ rotated: 1, failed: 0 });
    expect(byName["users.mfa_secret"]!.rotated).toBeGreaterThanOrEqual(1);
    expect(report.remaining).toEqual({});

    // The old key can now be dropped: everything decrypts with the new key alone.
    const [conn] = await owner.db.select().from(connections).where(eq(connections.id, connectionId));
    expect(keyIdOf(conn!.credentials)).toBe("rot2");
    expect(decryptJson(conn!.credentials, { keyring: newOnly, aad: AAD.connectionCredentials(connectionId) })).toEqual(
      creds,
    );
    expect(decrypt(conn!.webhookSecret!, { keyring: newOnly, aad: AAD.connectionWebhookSecret(connectionId) })).toBe(
      "whsec",
    );
    const channels = await owner.db.select().from(notificationChannels).where(eq(notificationChannels.orgId, orgId));
    const slack = channels.find((c) => c.kind === "slack_webhook")!;
    expect(decrypt(slack.target, { keyring: newOnly, aad: AAD.notificationTarget(slackId) })).toBe(hook);
    // Plaintext email targets are untouched.
    expect(channels.find((c) => c.kind === "email")!.target).toBe("v1.looks.like.cipher.text@example.com");
    const [u] = await owner.db.select().from(users).where(eq(users.id, userId));
    expect(decrypt(u!.mfaSecret!, { keyring: newOnly, aad: `user:${userId}:mfa` })).toBe("JBSWY3DPEHPK3PXP");

    const again = await rotateSecrets({ owner: owner.db, listOrgIds, keyring: newRing });
    expect(again.columns.every((c) => c.rotated === 0)).toBe(true);
  });

  it("counts, and leaves alone, a ciphertext it cannot decrypt (unknown key id)", async () => {
    const { connectionId } = await seedOrg(owner, 0);
    const stranger = createKeyring({ key: randomBytes(32).toString("base64"), keyId: "lost" });
    await owner.db
      .update(connections)
      .set({ credentials: encryptJson({}, { keyring: stranger, aad: AAD.connectionCredentials(connectionId) }) })
      .where(eq(connections.id, connectionId));
    const report = await rotateSecrets({ owner: owner.db, listOrgIds, keyring: newRing });
    expect(report.remaining.lost).toBeGreaterThanOrEqual(1);
    const [conn] = await owner.db.select().from(connections).where(eq(connections.id, connectionId));
    expect(keyIdOf(conn!.credentials)).toBe("lost");
    // Tidy up so later runs in this database are clean.
    await owner.db.delete(connections).where(eq(connections.id, connectionId));
  });

  it("skips a secret column the schema no longer has", async () => {
    const report = await rotateSecrets({
      owner: owner.db,
      listOrgIds,
      keyring: newRing,
      columns: [{ table: "users", column: "no_such_column", aad: (id) => id, orgScoped: false }],
    });
    expect(report.columns[0]).toMatchObject({ skipped: "missing" });
  });
});
