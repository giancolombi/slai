import type { InvitationPreview, Me } from "@slai/shared";
import { describe, expect, it } from "vitest";
import { inviteStep } from "../src/lib/auth-flow";

const preview = (over: Partial<InvitationPreview> = {}): InvitationPreview => ({
  organization: { name: "Acme" },
  email: "bo@acme.example",
  role: "member",
  invitedBy: "Ada",
  expiresAt: "2026-10-07T00:00:00Z",
  status: "pending",
  account: "new",
  sso: null,
  ...over,
});

const me = (email: string, mfa: Me["security"]["mfa"] = "satisfied"): Me => ({
  user: { id: "u1", email, name: "Bo", mfaEnabled: true },
  organization: { id: "o1", name: "Bo Inc", slug: "bo", plan: "trial" },
  role: "owner",
  organizations: [{ id: "o1", name: "Bo Inc", role: "owner" }],
  security: { authMethod: "password", mfa, totp: true, passkeys: 0, hasPassword: true, stepUpUntil: null },
});

describe("invitation page steps (T-59a)", () => {
  it("closes used, expired and revoked invitations", () => {
    for (const status of ["accepted", "expired", "revoked"] as const) {
      expect(inviteStep(preview({ status }), null)).toEqual({ kind: "closed", status });
    }
  });

  it("signs up new people and sends existing ones to sign in", () => {
    expect(inviteStep(preview(), null)).toEqual({ kind: "sign_up", sso: null, passwordAllowed: true });
    expect(inviteStep(preview({ account: "exists" }), null)).toEqual({
      kind: "sign_in",
      sso: null,
      passwordAllowed: true,
    });
  });

  it("offers only SSO on an enforce-SSO domain", () => {
    const sso = { providerId: "okta-1", enforced: true };
    expect(inviteStep(preview({ sso }), null)).toEqual({
      kind: "sign_up",
      sso: { providerId: "okta-1" },
      passwordAllowed: false,
    });
    expect(inviteStep(preview({ sso: { ...sso, enforced: false }, account: "exists" }), null)).toEqual({
      kind: "sign_in",
      sso: { providerId: "okta-1" },
      passwordAllowed: true,
    });
  });

  it("accepts for the invited account once MFA is done, and not for anyone else", () => {
    expect(inviteStep(preview(), me("BO@acme.example"))).toEqual({ kind: "accept" });
    expect(inviteStep(preview(), me("bo@acme.example", "enrollment_required"))).toEqual({
      kind: "finish_mfa",
      to: "/mfa/setup",
    });
    expect(inviteStep(preview(), me("eve@evil.example"))).toEqual({
      kind: "wrong_account",
      signedInAs: "eve@evil.example",
    });
  });
});
