/** WebAuthn ceremonies in the browser, against better-auth's passkey endpoints (via our API client). */

import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { SignInResult } from "@slai/shared";
import { api } from "./api";

export const passkeysSupported = () => typeof window !== "undefined" && browserSupportsWebAuthn();

export async function signInWithPasskey(): Promise<SignInResult> {
  const optionsJSON = (await api.passkeys.authenticateOptions()) as Parameters<
    typeof startAuthentication
  >[0]["optionsJSON"];
  const response = await startAuthentication({ optionsJSON });
  return api.passkeys.authenticate(response);
}

/** Proves a passkey in the current session (step-up before a sensitive action). */
export async function stepUpWithPasskey() {
  const optionsJSON = (await api.stepUp.passkeyOptions()) as Parameters<typeof startAuthentication>[0]["optionsJSON"];
  const response = await startAuthentication({ optionsJSON });
  return api.stepUp.passkey(response);
}

export async function registerPasskey(name?: string) {
  const optionsJSON = (await api.passkeys.registerOptions()) as Parameters<typeof startRegistration>[0]["optionsJSON"];
  const response = await startRegistration({ optionsJSON });
  return api.passkeys.register(response, name);
}

/** A readable message for a cancelled or failed WebAuthn prompt. */
export function passkeyError(e: unknown): string {
  const name = (e as Error)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return "The passkey prompt was cancelled or timed out.";
  if (name === "InvalidStateError") return "This passkey is already registered.";
  return (e as Error)?.message || "The passkey could not be used.";
}
