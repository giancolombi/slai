import type { Me } from "@slai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { mfaRedirect, type SignInStep, signInStep, stepUpMethods } from "../src/lib/auth-flow";
import { createQueryClient } from "../src/lib/queries";

const me = (security: Partial<Me["security"]> = {}): Me => ({
  user: { id: "u1", email: "ada@acme.example", name: "Ada", mfaEnabled: false },
  organization: { id: "o1", name: "Acme", slug: "acme", plan: "trial" },
  role: "owner",
  organizations: [{ id: "o1", name: "Acme", role: "owner" }],
  security: {
    authMethod: "password",
    mfa: "satisfied",
    totp: false,
    passkeys: 0,
    hasPassword: true,
    stepUpUntil: null,
    ...security,
  },
});

describe("sign-in step machine", () => {
  const email: SignInStep = { kind: "email" };

  it("routes a password domain to the password step", () => {
    const s = signInStep(email, { type: "discovered", email: "ada@acme.example", discovery: { method: "password" } });
    expect(s).toEqual({ kind: "password", email: "ada@acme.example", sso: null });
  });

  it("sends an enforced SSO domain straight to the IdP, and an optional one to password with an SSO option", () => {
    const enforced = signInStep(email, {
      type: "discovered",
      email: "ada@acme.example",
      discovery: { method: "sso", providerId: "okta", enforced: true },
    });
    expect(enforced).toEqual({ kind: "sso", email: "ada@acme.example", providerId: "okta" });
    const optional = signInStep(email, {
      type: "discovered",
      email: "ada@acme.example",
      discovery: { method: "sso", providerId: "okta", enforced: false },
    });
    expect(optional).toEqual({ kind: "password", email: "ada@acme.example", sso: { providerId: "okta" } });
    expect(signInStep(optional, { type: "use_sso" })).toEqual({
      kind: "sso",
      email: "ada@acme.example",
      providerId: "okta",
    });
  });

  it("switches to SSO when the password endpoint says the domain enforces it", () => {
    const pw: SignInStep = { kind: "password", email: "ada@acme.example", sso: null };
    expect(signInStep(pw, { type: "sso_required", providerId: null })).toEqual({ kind: "email" });
    expect(signInStep(pw, { type: "sso_required", providerId: "okta" })).toMatchObject({ kind: "sso" });
  });

  it("asks for the second factor, enrollment, or finishes, from the sign-in result", () => {
    const pw: SignInStep = { kind: "password", email: "ada@acme.example", sso: null };
    expect(
      signInStep(pw, { type: "result", result: { status: "mfa_required", methods: ["totp", "backup_code"] } }),
    ).toEqual({
      kind: "second_factor",
      email: "ada@acme.example",
      methods: ["totp", "backup_code"],
    });
    const m = me({ mfa: "enrollment_required" });
    expect(signInStep(pw, { type: "result", result: { status: "mfa_enrollment_required", me: m } })).toEqual({
      kind: "enroll",
      me: m,
    });
    const done = me();
    expect(signInStep(pw, { type: "result", result: { status: "signed_in", me: done } })).toEqual({
      kind: "done",
      me: done,
    });
  });

  it("goes back to the email step", () => {
    expect(signInStep({ kind: "password", email: "a@b.co", sso: null }, { type: "back" })).toEqual({ kind: "email" });
  });
});

describe("the enrollment gate (client half)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends a session without a factor to enrollment and an unverified one to verification", () => {
    expect(mfaRedirect(me({ mfa: "enrollment_required" }))).toBe("/mfa/setup");
    expect(mfaRedirect(me({ mfa: "verification_required", totp: true }))).toBe("/mfa");
    expect(mfaRedirect(me())).toBeNull();
    expect(stepUpMethods(me({ totp: true, passkeys: 2 }))).toEqual(["totp", "backup_code", "passkey"]);
  });

  it("routes the API's 403 mfa_enrollment_required / mfa_required from any query", async () => {
    const onMfaGate = vi.fn();
    const onUnauthorized = vi.fn();
    const qc = createQueryClient({ onMfaGate, onUnauthorized });
    const reply = (status: number, code: string) =>
      new Response(JSON.stringify({ error: { code, message: code } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(reply(403, "mfa_enrollment_required"));
    await qc.fetchQuery({ queryKey: ["dash"], queryFn: api.dashboard.get }).catch(() => {});
    fetchMock.mockResolvedValueOnce(reply(403, "mfa_required"));
    await qc.fetchQuery({ queryKey: ["tickets"], queryFn: () => api.tickets.list() }).catch(() => {});
    fetchMock.mockResolvedValueOnce(reply(403, "forbidden"));
    await qc.fetchQuery({ queryKey: ["org"], queryFn: api.org.get }).catch(() => {});
    expect(onMfaGate.mock.calls).toEqual([["/mfa/setup"], ["/mfa"]]);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
