import { auditEvents, passkeys } from "@slai/db";
import type { Me, Passkey, SignInResult } from "@slai/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { APP_URL, Client, enrollTotp, PASSWORD, setupApp, signupPending } from "./harness.js";
import { SoftAuthenticator } from "./webauthn.js";

const ctx = setupApp();

async function registerPasskey(client: Client, device: SoftAuthenticator, userVerified = true) {
  const options = await client.get<{
    challenge: string;
    rp: { id: string };
    authenticatorSelection: { userVerification: string };
  }>("/auth/passkey/generate-register-options");
  expect(options.status).toBe(200);
  return client.post<Passkey>("/auth/passkey/verify-registration", {
    response: device.register(options.body, { userVerified }),
    name: "Laptop",
  });
}

async function passkeySignIn(client: Client, device: SoftAuthenticator, userVerified = true) {
  const options = await client.get<{ challenge: string }>("/auth/passkey/generate-authenticate-options");
  expect(options.status).toBe(200);
  return client.post<SignInResult>("/auth/passkey/verify-authentication", {
    response: device.authenticate(options.body, { userVerified }),
  });
}

describe("passkeys", () => {
  it("issues registration options only to a signed-in session, for our RP, requiring user verification", async () => {
    expect((await new Client(ctx).get("/auth/passkey/generate-register-options")).status).toBe(401);
    const { client } = await signupPending(ctx);
    const options = await client.get("/auth/passkey/generate-register-options");
    expect(options.status).toBe(200);
    expect(options.body.rp.id).toBe(new URL(APP_URL).hostname);
    expect(options.body.authenticatorSelection.userVerification).toBe("required");
    expect(options.body.challenge).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it("enrolls with a passkey instead of TOTP, then signs in with it (password alone is not enough)", async () => {
    const { client, email, userId } = await signupPending(ctx);
    const device = new SoftAuthenticator(APP_URL);
    expect((await client.get("/tickets")).body.error.code).toBe("mfa_enrollment_required");
    const reg = await registerPasskey(client, device);
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ name: "Laptop" });
    expect(JSON.stringify(reg.body)).not.toMatch(/publicKey|credentialID/i);
    expect((await client.get("/tickets")).status).toBe(200);
    expect((await client.get<Me>("/auth/me")).body.security).toMatchObject({
      mfa: "satisfied",
      passkeys: 1,
      totp: false,
    });

    // Password sign-in for a passkey-only user yields no session: the passkey is required.
    const c = new Client(ctx);
    const pw = await c.post<SignInResult>("/auth/sign-in/email", { email, password: PASSWORD });
    expect(pw.body).toEqual({ status: "mfa_required", methods: ["passkey"] });
    expect(c.cookie).toBeNull();
    expect((await c.get("/auth/me")).status).toBe(401);

    const signedIn = await passkeySignIn(c, device);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.status).toBe("signed_in");
    expect(JSON.stringify(signedIn.body)).not.toMatch(/token/i);
    expect((await c.get<Me>("/auth/me")).body.security.authMethod).toBe("passkey");
    expect((await c.get("/tickets")).status).toBe(200);

    const events = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.actorId, userId));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["auth.passkey_added", "auth.login"]));
    expect(
      events.find((e) => e.action === "auth.login" && (e.metadata as { method?: string }).method === "passkey"),
    ).toBeTruthy();
  });

  it("rejects an assertion without user verification", async () => {
    const { client } = await signupPending(ctx);
    const device = new SoftAuthenticator(APP_URL);
    await registerPasskey(client, device);
    const res = await passkeySignIn(new Client(ctx), device, false);
    expect(res.status).toBe(401);
  });

  it("lists passkeys without key material and keeps the last factor", async () => {
    const { client, userId } = await signupPending(ctx);
    const device = new SoftAuthenticator(APP_URL);
    const reg = await registerPasskey(client, device);
    const list = await client.get<Passkey[]>("/auth/passkey/list-user-passkeys");
    expect(list.body.map((p) => p.id)).toEqual([reg.body.id]);
    expect(JSON.stringify(list.body)).not.toMatch(/publicKey|credentialID/i);
    const last = await client.post("/auth/passkey/delete-passkey", { id: reg.body.id });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe("last_factor");

    await enrollTotp(client);
    expect((await client.post("/auth/passkey/delete-passkey", { id: reg.body.id })).status).toBe(204);
    expect(await ctx.owner.db.select().from(passkeys).where(eq(passkeys.userId, userId))).toEqual([]);
    const events = await ctx.owner.db.select().from(auditEvents).where(eq(auditEvents.actorId, userId));
    expect(events.map((e) => e.action)).toContain("auth.passkey_removed");
  });
});
