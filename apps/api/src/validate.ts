import type { Context } from "hono";
import { type ZodType, z } from "zod";
import { ApiError, notFound } from "./errors.js";

function issues(err: z.ZodError) {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Parses a JSON body with a shared zod schema. 400 `invalid_body` with field issues on failure. */
export async function body<T extends ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_body", "Request body must be JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new ApiError(
      400,
      "invalid_body",
      "Some details aren't valid. Check the highlighted fields and try again.",
      issues(r.error),
    );
  return r.data;
}

export function query<T extends ZodType>(c: Context, schema: T): z.output<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success)
    throw new ApiError(
      400,
      "invalid_query",
      "That filter isn't valid. Clear the filters and try again.",
      issues(r.error),
    );
  return r.data;
}

const uuid = z.uuid();
/** A uuid path parameter; anything else is a 404 (never a DB error). */
export function idParam(c: Context, name = "id", what = "Resource"): string {
  const v = c.req.param(name);
  if (!uuid.safeParse(v).success) throw notFound(what);
  return v as string;
}
