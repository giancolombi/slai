import { describe, expect, it } from "vitest";
import { mfaState, type SessionFacts } from "../src/auth/session.js";

const base: SessionFacts = {
  authMethod: "password",
  mfaVerified: false,
  ssoOrgId: null,
  activeOrgId: "org-a",
  factors: { totp: false, passkeys: 0 },
  ssoRequireMfa: false,
};

describe("mfaState (the gate's rule)", () => {
  it.each<[string, Partial<SessionFacts>, string]>([
    ["password, no factor", {}, "enrollment_required"],
    [
      "password, factor enrolled elsewhere, not verified here",
      { factors: { totp: true, passkeys: 0 } },
      "verification_required",
    ],
    ["password + second factor", { mfaVerified: true, factors: { totp: true, passkeys: 0 } }, "satisfied"],
    ["passkey sign-in", { authMethod: "passkey" }, "satisfied"],
    ["SSO in the IdP's org", { authMethod: "sso", ssoOrgId: "org-a" }, "satisfied"],
    [
      "SSO, org also requires slai MFA",
      { authMethod: "sso", ssoOrgId: "org-a", ssoRequireMfa: true },
      "enrollment_required",
    ],
    [
      "SSO, org requires slai MFA, verified",
      { authMethod: "sso", ssoOrgId: "org-a", ssoRequireMfa: true, mfaVerified: true },
      "satisfied",
    ],
    ["SSO session switched to another org", { authMethod: "sso", ssoOrgId: "org-b" }, "enrollment_required"],
    [
      "SSO session in another org, factor enrolled",
      { authMethod: "sso", ssoOrgId: "org-b", factors: { totp: false, passkeys: 1 } },
      "verification_required",
    ],
  ])("%s → %s", (_, facts, expected) => {
    expect(mfaState({ ...base, ...facts })).toBe(expected);
  });
});
