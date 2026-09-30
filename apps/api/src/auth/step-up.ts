/**
 * Step-up for sensitive actions (T-19): the user must have proven TOTP or a
 * passkey in this session within the last 5 minutes. Signing in with either
 * counts; a backup code or an IdP's MFA does not. `sessions.step_up_at` is set by
 * the session hook (better-auth.ts), by `/auth/two-factor/verify-totp` on an
 * existing session (handler.ts) and by `/auth/step-up/passkey` (routes/auth.ts).
 */
import type { SecondFactor } from "@slai/shared";
import type { AuthContext } from "../context.js";
import { ApiError } from "../errors.js";

export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

/** Until when the session's step-up is fresh, or null. */
export function stepUpUntil(a: Pick<AuthContext, "stepUpAt">, now: Date): Date | null {
  if (!a.stepUpAt) return null;
  const until = new Date(a.stepUpAt.getTime() + STEP_UP_WINDOW_MS);
  return until.getTime() > now.getTime() ? until : null;
}

/** 403 `step_up_required` (with the methods this user can step up with) unless the step-up is fresh. */
export function requireStepUp(a: AuthContext, now: Date): void {
  if (stepUpUntil(a, now)) return;
  const methods: SecondFactor[] = [];
  if (a.factors.totp) methods.push("totp");
  if (a.factors.passkeys > 0) methods.push("passkey");
  throw new ApiError(
    403,
    "step_up_required",
    methods.length > 0
      ? "Confirm it's you: enter a code from your authenticator app or use your passkey."
      : "Add an authenticator app or a passkey in Settings → Security to do this.",
    { methods },
  );
}
