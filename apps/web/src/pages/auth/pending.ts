import type { SecondFactor } from "@slai/shared";

/**
 * A sign-in waiting for its second factor. The server holds the challenge in an
 * httpOnly cookie; the page only needs the email (for display) and the methods
 * offered. Memory only: a reload sends the person back to /login.
 */
let pending: { email: string; methods: SecondFactor[] } | null = null;

export function setPendingLogin(value: { email: string; methods: SecondFactor[] } | null) {
  pending = value;
}

export function getPendingLogin() {
  return pending;
}
