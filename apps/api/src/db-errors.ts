/**
 * Postgres errors that mean "the database is saturated right now", not "this
 * request is wrong": connection slots exhausted (53300) or out of resources
 * (53xxx class), and a pool that could not get a connection in time. These map
 * to 503 + Retry-After so clients and load balancers back off instead of
 * treating them as a bug (500).
 */
export function isDatabaseSaturated(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "53300" || code === "53400" || code === "57P03") return true;
  if (code === "CONNECT_TIMEOUT") return true;
  const message = typeof e.message === "string" ? e.message : "";
  return /remaining connection slots are reserved|too many clients already|sorry, too many clients/i.test(message);
}
