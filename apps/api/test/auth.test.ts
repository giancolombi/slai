import { createHash } from "node:crypto";
import { accounts, auditEvents, sessions, twoFactors, users } from "@slai/db";
import type { Me, SignInResult } from "@slai/shared";
import { and, eq, or } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { Client, enrollTotp, nextCode, PASSWORD, setupApp, signup, signupPending } from "./harness.js";

const ctx = setupApp();

const actions = async (userId: string, email?: string) =>
  (
    await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(
        email ? or(eq(auditEvents.actorId, userId), eq(auditEvents.actorName, email)) : eq(auditEvents.actorId, userId),
      )
  ).map((e) => e.action);

describe("signup and sessions", () => {
  it("signs up an owner of a new org with a hardened cookie holding a token stored only as sha256", async () => {
    const client = new Client(ctx);
    const email = `new-${Date.now()}@example.com`;
    const res = await client.post<SignInResult>("/auth/signup", {
      email,
      password: PASSWORD,
      name: "New",
      organizationName: "New Co",
    });
    expect(res.status).toBe(201);
    if (res.body.status !== "mfa_enrollment_required") throw new Error("expected enrollment");
    expect(res.body.me.role).toBe("owner");
    expect(res.body.me.organization.name).toBe("New Co");
    expect(res.body.me.security).toMatchObject({ mfa: "enrollment_required", totp: false, passkeys: 0 });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("slai_session="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=43200/); // 12h idle, refreshed on use
    const token = decodeURIComponent(/slai_session=([^;]+)/.exec(cookie)![1]!).split(".")[0]!;
    const rows = await ctx.owner.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, createHash("sha256").update(token).digest("hex")));
    expect(rows).toHaveLength(1);
    const [u] = await ctx.owner.db.select().from(users).where(eq(users.email, email));
    const [acct] = await ctx.owner.db.select().from(accounts).where(eq(accounts.userId, u!.id));
    expect(acct!.password).toMatch(/^\$argon2id\$/);
  });

  it("rejects a weak password and a duplicate email", async () => {
    const { email } = await signupPending(ctx);
    const c = new Client(ctx);
    expect(
      (await c.post("/auth/signup", { email: "x@example.com", password: "short", name: "x", organizationName: "x" }))
        .status,
    ).toBe(400);
    const dup = await c.post("/auth/signup", { email, password: PASSWORD, name: "x", organizationName: "x" });
    expect(dup.status).toBe(409);
  });

  it("signs out server-side: a replayed cookie no longer works", async () => {
    const { client } = await signup(ctx);
    const stolen = client.cookie;
    expect((await client.get<Me>("/auth/me")).status).toBe(200);
    expect((await client.post("/auth/logout")).status).toBe(204);
    const replay = new Client(ctx);
    replay.cookie = stolen;
    expect((await replay.get("/auth/me")).status).toBe(401);
  });

  it("expires sessions after 12h idle and after 7 days absolute", async () => {
    const idle = await signup(ctx);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000);
      expect((await idle.client.get("/auth/me")).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
    const old = await signup(ctx);
    ctx.clock.now = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    try {
      expect((await old.client.get("/auth/me")).status).toBe(401);
    } finally {
      ctx.clock.now = null;
    }
  });

  it("never returns password hashes, secrets or session tokens", async () => {
    const { client, email, totpSecret } = await signup(ctx);
    const me = await client.get("/auth/me");
    expect(JSON.stringify(me.body)).not.toMatch(/argon2|"password":|secret|token/i);
    const c = new Client(ctx);
    await c.post("/auth/sign-in/email", { email, password: PASSWORD });
    const done = await c.post("/auth/two-factor/verify-totp", { code: nextCode(totpSecret) });
    expect(done.status).toBe(200);
    expect(JSON.stringify(done.body)).not.toMatch(/token|secret/i);
  });
});

describe("mandatory MFA: the enrollment gate", () => {
  it("blocks every API route except /auth until a factor is enrolled", async () => {
    const { client } = await signupPending(ctx);
    for (const path of ["/org", "/members", "/tickets", "/dashboard", "/connections", "/audit-events", "/org/sso"]) {
      const res = await client.get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code, path).toBe("mfa_enrollment_required");
    }
    const write = await client.patch("/org", { name: "x" });
    expect(write.body.error.code).toBe("mfa_enrollment_required");
    // /auth still works: me, and the enrollment endpoints.
    const me = await client.get<Me>("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.security.mfa).toBe("enrollment_required");
    // Managing factors needs MFA done, not just a session.
    expect((await client.post("/auth/two-factor/generate-backup-codes", { password: PASSWORD })).status).toBe(403);
    expect((await client.get("/auth/passkey/list-user-passkeys")).status).toBe(403);

    const { backupCodes } = await enrollTotp(client);
    expect(backupCodes).toHaveLength(10);
    expect((await client.get("/org")).status).toBe(200);
    expect((await client.get<Me>("/auth/me")).body.security).toMatchObject({ mfa: "satisfied", totp: true });
  });

  it("forces existing users without a factor into enrollment on their next sign-in", async () => {
    const { email } = await signupPending(ctx);
    const c = new Client(ctx);
    const res = await c.post<SignInResult>("/auth/sign-in/email", { email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("mfa_enrollment_required");
    expect((await c.get("/tickets")).body.error.code).toBe("mfa_enrollment_required");
  });

  it("stores the TOTP secret and backup codes sealed, never plaintext", async () => {
    const { userId, totpSecret, backupCodes } = await signup(ctx);
    const [tf] = await ctx.owner.db.select().from(twoFactors).where(eq(twoFactors.userId, userId));
    expect(tf!.secret).toMatch(/^\$ba\$1\$/);
    expect(tf!.secret).not.toContain(totpSecret);
    expect(tf!.backupCodes).not.toContain(backupCodes[0]!);
  });

  it("requires the password to start enrollment", async () => {
    const { client } = await signupPending(ctx);
    const res = await client.post("/auth/two-factor/enable", { password: "wrong password!!" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_password");
  });
});

describe("sign-in requires the second factor", () => {
  it("asks for TOTP after the password, rejects a bad code, accepts a good one", async () => {
    const { email, totpSecret, userId } = await signup(ctx);
    const c = new Client(ctx);
    // (the failed code has no user yet: the 2FA challenge is anonymous until it passes)
    const step1 = await c.post<SignInResult>("/auth/sign-in/email", { email, password: PASSWORD });
    expect(step1.status).toBe(200);
    expect(step1.body).toEqual({ status: "mfa_required", methods: ["totp", "backup_code"] });
    // No session yet: the password alone opens nothing.
    expect(c.cookie).toBeNull();
    expect((await c.get("/auth/me")).status).toBe(401);

    const bad = await c.post("/auth/two-factor/verify-totp", { code: "000000" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("invalid_code");
    expect(c.cookie).toBeNull();

    const good = await c.post<SignInResult>("/auth/two-factor/verify-totp", { code: nextCode(totpSecret) });
    expect(good.status).toBe(200);
    expect(good.body.status).toBe("signed_in");
    expect((await c.get("/tickets")).status).toBe(200);
    expect(await actions(userId)).toEqual(
      expect.arrayContaining(["auth.mfa_enabled", "auth.password_verified", "auth.login"]),
    );
  });

  it("refuses a replayed TOTP code", async () => {
    const { email, totpSecret } = await signup(ctx);
    const code = nextCode(totpSecret);
    const a = new Client(ctx);
    await a.post("/auth/sign-in/email", { email, password: PASSWORD });
    expect((await a.post("/auth/two-factor/verify-totp", { code })).status).toBe(200);
    const b = new Client(ctx);
    await b.post("/auth/sign-in/email", { email, password: PASSWORD });
    const replay = await b.post("/auth/two-factor/verify-totp", { code });
    expect(replay.status).toBe(401);
    expect(b.cookie).toBeNull();
  });

  it("accepts a backup code exactly once, and audits its use", async () => {
    const { email, backupCodes, userId } = await signup(ctx);
    const code = backupCodes[3]!;
    const a = new Client(ctx);
    await a.post("/auth/sign-in/email", { email, password: PASSWORD });
    const first = await a.post<SignInResult>("/auth/two-factor/verify-backup-code", { code });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("signed_in");
    expect((await a.get("/org")).status).toBe(200);

    const b = new Client(ctx);
    await b.post("/auth/sign-in/email", { email, password: PASSWORD });
    const again = await b.post("/auth/two-factor/verify-backup-code", { code });
    expect(again.status).toBe(401);
    expect(b.cookie).toBeNull();
    expect(await actions(userId)).toContain("auth.backup_code_used");
  });

  it("regenerates backup codes (old ones stop working)", async () => {
    const { client, email, backupCodes } = await signup(ctx);
    const res = await client.post("/auth/two-factor/generate-backup-codes", { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.backupCodes).toHaveLength(10);
    const c = new Client(ctx);
    await c.post("/auth/sign-in/email", { email, password: PASSWORD });
    expect((await c.post("/auth/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBe(401);
    await c.post("/auth/sign-in/email", { email, password: PASSWORD });
    expect((await c.post("/auth/two-factor/verify-backup-code", { code: res.body.backupCodes[0] })).status).toBe(200);
  });

  it("does not allow trusted devices to skip the second factor", async () => {
    const { email, totpSecret } = await signup(ctx);
    const c = new Client(ctx);
    await c.post("/auth/sign-in/email", { email, password: PASSWORD });
    await c.req("POST", "/auth/two-factor/verify-totp", { json: { code: nextCode(totpSecret), trustDevice: true } });
    expect([...c.jar.keys()].some((k) => k.includes("trust"))).toBe(false);
    await c.post("/auth/logout");
    const again = await c.post<SignInResult>("/auth/sign-in/email", { email, password: PASSWORD });
    expect(again.body.status).toBe("mfa_required");
  });

  it("will not remove the last second factor", async () => {
    const { client } = await signup(ctx);
    const res = await client.post("/auth/two-factor/disable", { password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("last_factor");
  });
});

describe("generic errors and rate limits", () => {
  it("uses one error for unknown email and wrong password, and audits both", async () => {
    const { email } = await signup(ctx);
    const c = new Client(ctx);
    const wrong = await c.post("/auth/sign-in/email", { email, password: "wrong password!!" });
    const unknown = await c.post("/auth/sign-in/email", {
      email: `nobody-${Date.now()}@example.com`,
      password: "wrong password!!",
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe("invalid_credentials");
    const failures = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "auth.login_failed"), eq(auditEvents.actorName, email)));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.metadata).toMatchObject({ reason: "bad_credentials" });
  });

  it("rate-limits repeated attempts on one email", async () => {
    const { email } = await signup(ctx);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const c = new Client(ctx); // different IPs: the per-email bucket still applies
      statuses.push((await c.post("/auth/sign-in/email", { email, password: "wrong password!!" })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe("CSRF on auth endpoints (ours and better-auth's)", () => {
  it.each([
    "/auth/sign-in/email",
    "/auth/two-factor/verify-totp",
    "/auth/two-factor/enable",
    "/auth/sign-in/sso",
    "/auth/passkey/verify-authentication",
    "/auth/signup",
  ])("rejects %s without X-Requested-With", async (path) => {
    const res = await new Client(ctx).req("POST", path, { json: { email: "a@b.co", password: "x" }, csrf: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("csrf");
  });

  it("rejects a foreign Origin and a cross-site fetch on better-auth's sign-in", async () => {
    const { email } = await signup(ctx);
    const evil = await new Client(ctx).req("POST", "/auth/sign-in/email", {
      json: { email, password: PASSWORD },
      headers: { origin: "https://evil.example" },
    });
    expect(evil.body.error.code).toBe("csrf");
    const site = await new Client(ctx).req("POST", "/auth/sign-in/email", {
      json: { email, password: PASSWORD },
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(site.body.error.code).toBe("csrf");
  });

  it("rejects org mutations without the header", async () => {
    const { client } = await signup(ctx);
    const res = await client.req("PATCH", "/org", { json: { name: "x" }, csrf: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("csrf");
  });
});

describe("better-auth surface", () => {
  it("exposes only the allowlisted endpoints", async () => {
    const { client } = await signup(ctx);
    for (const [method, path] of [
      ["POST", "/auth/sign-up/email"],
      ["GET", "/auth/get-session"],
      ["GET", "/auth/list-sessions"],
      ["POST", "/auth/sso/register"],
      ["GET", "/auth/sso/providers"],
      ["POST", "/auth/two-factor/view-backup-codes"],
      ["POST", "/auth/change-password"],
    ] as const) {
      expect((await client.req(method, path, { json: method === "POST" ? {} : undefined })).status, path).toBe(404);
    }
  });
});

describe("hardening", () => {
  it("sets security headers and a request id; health checks are public", async () => {
    const res = await ctx.app.request("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age/);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect((await ctx.app.request("/api/v1/readyz")).status).toBe(200);
  });
});
