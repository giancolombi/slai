import type { Tx } from "@slai/db";
import { eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { badRequest } from "./errors.js";

/**
 * Foreign-key checks are not subject to RLS, so an id supplied by a client must
 * be proven visible in the caller's org before it is stored as a reference.
 */
export async function assertInOrg(
  tx: Tx,
  table: PgTable & { id: PgColumn },
  id: string | null | undefined,
  what: string,
) {
  if (id === null || id === undefined) return;
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.id, id));
  if (!row) throw badRequest(`${what} not found.`);
}

/** The current billing period: the calendar month (UTC) containing `now`. */
export function currentPeriod(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}
