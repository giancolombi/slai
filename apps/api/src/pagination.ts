import { z } from "zod";
import { badRequest } from "./errors.js";

export const pageQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(cursor: string | undefined, schema: z.ZodType<T>): T | null {
  if (!cursor) return null;
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw badRequest("This list is out of date. Refresh the page and try again.");
  }
}

/** Given `limit + 1` rows, returns the page and the next cursor. */
export function page<R, T>(rows: R[], limit: number, map: (r: R) => T, cursorOf: (r: R) => unknown) {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(map), nextCursor: more && last ? encodeCursor(cursorOf(last)) : null };
}

/** Cursor schema for id-ordered (uuidv7, i.e. time-ordered) lists. */
export const idCursor = z.object({ id: z.uuid() });
