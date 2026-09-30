import { auditEvents, sessions, users } from "@slai/db";
import type { Me, MfaSetup } from "@slai/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hashToken } from "../src/sessions.js";
import { totp } from "../src/totp.js";
import { Client, PASSWORD, setupApp, signup } from "./harness.js";

const ctx = setupApp();

describe("signup, login, logout", () => {
  it("signs up an owner of a new org and sets a hardened session cookie", async () => {
    const client = new Client(ctx);
    const email = `new-${Date.now()}@example.com`;
    const res = await client.post<Me>("/auth/signup", {
      email,
      password: PASSWORD,
      name: "New",
      organizationName: "New Co",
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("owner");
    expect(res.body.organization.name).toBe("New Co");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/slai_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=604800/);
    // Only the sha256 of the token is stored.
    const token = /slai_session=([^;]+)/.exec(cookie)![1]!;
    const rows = await ctx.owner.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)));
    expect(rows).toHaveLength(1);
    const [u] = await ctx.owner.db.select().from(users).where(eq(users.email, email));
    expect(u!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("rejects a weak password and a duplicate email", async () => {
    const { email } = await signup(ctx);
    const c = new Client(ctx);
    expect(
      (await c.post("/auth/signup", { email: "x@example.com", password: "short", name: "x", organizationName: "x" }))
        .status,
    ).toBe(400);
    const dup = await c.post("/auth/signup", { email, password: PASSWORD, name: "x", organizationName: "x" });
    expect(dup.status).toBe(409);
  });

  it("logs in, returns Me, and logs out (session deleted server-side)", async () => {
    const { email } = await signup(ctx);
    const c = new Client(ctx);
    expect((await c.get("/auth/me")).status).toBe(401);
    const login = await c.post<Me>("/auth/login", { email: email.toUpperCase(), password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(email);
    const stolen = c.cookie;
    expect((await c.get<Me>("/auth/me")).status).toBe(200);
    expect((await c.post("/auth/logout")).status).toBe(204);
    // The old cookie no longer works, even if replayed.
    const replay = new Client(ctx);
    replay.cookie = stolen;
    expect((await replay.get("/auth/me")).status).toBe(401);
  });

  it("uses one generic error for unknown email and wrong password, and audits both", async () => {
    const { email, orgId } = await signup(ctx);
    const c = new Client(ctx);
    const wrong = await c.post("/auth/login", { email, password: "wrong password!!" });
    const unknown = await c.post("/auth/login", {
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
    expect(failures[0]!.metadata).toEqual({ reason: "bad_password" });
    const logins = await ctx.owner.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "auth.signup")));
    expect(logins).toHaveLength(1);
  });

  it("rate-limits repeated attempts on one email", async () => {
    const { email } = await signup(ctx);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const c = new Client(ctx); // different IPs: the per-email bucket still applies
      statuses.push((await c.post("/auth/login", { email, password: "wrong password!!" })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it("expires sessions after 12h idle", async () => {
    const { client } = await signup(ctx);
    ctx.clock.now = new Date(Date.now() + 13 * 60 * 60 * 1000);
    try {
      expect((await client.get("/auth/me")).status).toBe(401);
    } finally {
      ctx.clock.now = null;
    }
  });
});

describe("MFA", () => {
  it("sets up TOTP, verifies it, then requires it at login (no code replay)", async () => {
    const { client, email } = await signup(ctx);
    const setup = await client.post<MfaSetup>("/auth/mfa/setup");
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/slai%3A.+\?secret=[A-Z2-7]+&issuer=slai/);
    const [u] = await ctx.owner.db.select().from(users).where(eq(users.email, email));
    expect(u!.mfaSecret).toMatch(/^v1\.k1\./); // encrypted at rest
    expect(u!.mfaSecret).not.toContain(setup.body.secret);

    expect((await client.post("/auth/mfa/verify", { totp: "000000" })).status).toBe(401);
    const code = totp(setup.body.secret);
    const verified = await client.post<Me>("/auth/mfa/verify", { totp: code });
    expect(verified.status).toBe(200);
    expect(verified.body.user.mfaEnabled).toBe(true);

    const c = new Client(ctx);
    const noCode = await c.post("/auth/login", { email, password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe("mfa_required");
    // The code just used cannot be replayed.
    const replayed = await c.post("/auth/login", { email, password: PASSWORD, totp: code });
    expect(replayed.status).toBe(401);
    const next = totp(setup.body.secret, new Date(Date.now() + 30_000));
    expect((await c.post("/auth/login", { email, password: PASSWORD, totp: next })).status).toBe(200);
    expect((await client.post("/auth/mfa/setup")).status).toBe(409);
  });

  it("enforces the org's require_mfa: only MFA setup is allowed until verified", async () => {
    const { client } = await signup(ctx);
    expect((await client.patch("/org", { requireMfa: true })).status).toBe(200);
    const blocked = await client.get("/org");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("mfa_setup_required");
    expect((await client.get("/auth/me")).status).toBe(200);
    const setup = await client.post<MfaSetup>("/auth/mfa/setup");
    expect((await client.post("/auth/mfa/verify", { totp: totp(setup.body.secret) })).status).toBe(200);
    expect((await client.get("/org")).status).toBe(200);
  });
});

describe("CSRF", () => {
  it("rejects state-changing requests without X-Requested-With", async () => {
    const { client } = await signup(ctx);
    const res = await client.req("PATCH", "/org", { json: { name: "x" }, csrf: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("csrf");
  });

  it("rejects a foreign Origin even with the header", async () => {
    const { client } = await signup(ctx);
    const res = await client.req("PATCH", "/org", { json: { name: "x" }, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("csrf");
  });

  it("applies to login too", async () => {
    const c = new Client(ctx);
    const res = await c.req("POST", "/auth/login", { json: { email: "a@b.co", password: "x" }, csrf: false });
    expect(res.status).toBe(403);
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

  it("never returns password hashes or secrets in Me", async () => {
    const { client } = await signup(ctx);
    const me = await client.get("/auth/me");
    expect(JSON.stringify(me.body)).not.toMatch(/argon2|password|secret/i);
  });
});
