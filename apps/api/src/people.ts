import { type Tx, users } from "@slai/db";
import { inArray } from "drizzle-orm";

/**
 * Display names for user ids (`approvedBy`, `uploadedBy`, `decidedBy`), so the
 * web app doesn't look them up. Former members keep their name: the user row
 * outlives the membership. `slai_app` may read `users.name` (column grant).
 */
export async function userNames(tx: Tx, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export const nameOf = (names: Map<string, string>, id: string | null | undefined) =>
  id ? (names.get(id) ?? null) : null;
