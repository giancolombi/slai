/**
 * Credentials waiting for a TOTP code, kept in memory only (never in the URL or storage).
 * A reload drops them, which sends the person back to /login.
 */
let pending: { email: string; password: string } | null = null;

export function setPendingLogin(value: { email: string; password: string } | null) {
  pending = value;
}

export function getPendingLogin() {
  return pending;
}
