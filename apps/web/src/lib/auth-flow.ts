/**
 * The sign-in step machine (pure; the login and second-factor pages render it)
 * and the client half of the MFA gate. The server enforces both; this only
 * decides which screen to show.
 */
import type { InvitationPreview, Me, SecondFactor, SignInDiscovery, SignInResult } from "@slai/shared";

export type SignInStep =
  | { kind: "email" }
  | { kind: "password"; email: string; sso: { providerId: string } | null }
  /** The email's domain uses SSO: leave for the IdP. */
  | { kind: "sso"; email: string; providerId: string }
  | { kind: "second_factor"; email: string; methods: SecondFactor[] }
  | { kind: "enroll"; me: Me }
  | { kind: "done"; me: Me };

export type SignInEvent =
  | { type: "discovered"; email: string; discovery: SignInDiscovery }
  | { type: "use_password" }
  | { type: "use_sso" }
  | { type: "result"; result: SignInResult }
  /** 403 sso_required from the password endpoint (the domain enforces SSO). */
  | { type: "sso_required"; providerId: string | null }
  | { type: "back" };

export function signInStep(step: SignInStep, event: SignInEvent): SignInStep {
  switch (event.type) {
    case "discovered": {
      const d = event.discovery;
      if (d.method === "sso" && d.enforced) return { kind: "sso", email: event.email, providerId: d.providerId };
      return { kind: "password", email: event.email, sso: d.method === "sso" ? { providerId: d.providerId } : null };
    }
    case "use_password":
      return step.kind === "sso" ? { kind: "password", email: step.email, sso: { providerId: step.providerId } } : step;
    case "use_sso":
      return step.kind === "password" && step.sso
        ? { kind: "sso", email: step.email, providerId: step.sso.providerId }
        : step;
    case "sso_required":
      if (step.kind !== "password") return step;
      return event.providerId ? { kind: "sso", email: step.email, providerId: event.providerId } : { kind: "email" };
    case "result": {
      const r = event.result;
      const email = "email" in step ? step.email : "";
      if (r.status === "mfa_required") return { kind: "second_factor", email, methods: r.methods };
      if (r.status === "mfa_enrollment_required") return { kind: "enroll", me: r.me };
      return { kind: "done", me: r.me };
    }
    case "back":
      return { kind: "email" };
  }
}

/**
 * Where an authenticated visitor must go before the app: mandatory enrollment,
 * or verifying the second factor for this session. Null when MFA is satisfied.
 */
export function mfaRedirect(me: Me): "/mfa/setup" | "/mfa" | null {
  if (me.security.mfa === "enrollment_required") return "/mfa/setup";
  if (me.security.mfa === "verification_required") return "/mfa";
  return null;
}

/** Is this session's TOTP/passkey proof fresh enough for a sensitive action (the server decides; this picks the UI)? */
export function stepUpFresh(me: Me, now: Date = new Date()): boolean {
  const until = me.security.stepUpUntil;
  return until !== null && new Date(until).getTime() > now.getTime();
}

/**
 * Whether to offer "Reset two-factor" on a Team row. Mirrors the server's guard
 * rails that the client can see (admin or owner, not yourself, owners only by
 * owners, active members); the server also refuses the last owner and members
 * of organizations this admin does not administer.
 */
export function canResetMfa(me: Me, member: { userId: string; role: Me["role"]; active: boolean }): boolean {
  if (me.role !== "owner" && me.role !== "admin") return false;
  if (member.userId === me.user.id || !member.active) return false;
  return member.role !== "owner" || me.role === "owner";
}

/**
 * What the invitation page shows (T-59a). The server enforces every rule
 * (single use, expiry, same email, MFA, enforce-SSO); this only picks the screen.
 */
export type InviteStep =
  | { kind: "closed"; status: "accepted" | "expired" | "revoked" }
  /** Signed in as the invitee with MFA done: one click joins. */
  | { kind: "accept" }
  /** Signed in as the invitee, second factor still pending. */
  | { kind: "finish_mfa"; to: "/mfa/setup" | "/mfa" }
  /** Signed in as someone else. */
  | { kind: "wrong_account"; signedInAs: string }
  /** Not signed in: SSO (only SSO when enforced), sign in, or create the account here. */
  | { kind: "sign_in"; sso: { providerId: string } | null; passwordAllowed: boolean }
  | { kind: "sign_up"; sso: { providerId: string } | null; passwordAllowed: boolean };

export function inviteStep(preview: InvitationPreview, me: Me | null): InviteStep {
  if (preview.status !== "pending") return { kind: "closed", status: preview.status };
  if (me) {
    if (me.user.email.toLowerCase() !== preview.email.toLowerCase()) {
      return { kind: "wrong_account", signedInAs: me.user.email };
    }
    const to = mfaRedirect(me);
    return to ? { kind: "finish_mfa", to } : { kind: "accept" };
  }
  const sso = preview.sso ? { providerId: preview.sso.providerId } : null;
  const passwordAllowed = !preview.sso?.enforced;
  return preview.account === "exists"
    ? { kind: "sign_in", sso, passwordAllowed }
    : { kind: "sign_up", sso, passwordAllowed };
}

/** Second-factor methods available to a signed-in session that must verify (step-up). */
export function stepUpMethods(me: Me): SecondFactor[] {
  const m: SecondFactor[] = [];
  if (me.security.totp) m.push("totp", "backup_code");
  if (me.security.passkeys > 0) m.push("passkey");
  return m;
}
