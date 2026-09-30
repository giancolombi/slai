/**
 * SCIM 2.0 wire format (RFC 7643/7644), the subset slai serves (T-18): request
 * bodies (zod), `eq` filters, PatchOp operations as Okta and Entra ID send them,
 * list and error envelopes. Pure: no I/O.
 */
import { z } from "zod";

export const SCIM_CONTENT_TYPE = "application/scim+json";
export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export type ScimType =
  | "invalidFilter"
  | "invalidValue"
  | "invalidSyntax"
  | "invalidPath"
  | "mutability"
  | "uniqueness"
  | "noTarget";

export class ScimError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500,
    message: string,
    readonly scimType?: ScimType,
  ) {
    super(message);
  }
  body() {
    return {
      schemas: [ERROR_SCHEMA],
      status: String(this.status),
      ...(this.scimType && { scimType: this.scimType }),
      detail: this.message,
    };
  }
}

/** Entra sends booleans as "True"/"False" strings. */
const scimBool = z.union([
  z.boolean(),
  z.enum(["True", "False", "true", "false"]).transform((v) => v.toLowerCase() === "true"),
]);
const str = (max: number) => z.string().trim().max(max);

const nameSchema = z
  .object({
    formatted: str(200).optional(),
    givenName: str(100).optional(),
    familyName: str(100).optional(),
  })
  .partial();

export const scimUserBody = z.object({
  userName: str(320).min(3),
  externalId: str(200).optional(),
  displayName: str(200).optional(),
  name: nameSchema.optional(),
  emails: z.array(z.object({ value: str(320), primary: scimBool.optional(), type: z.string().optional() })).optional(),
  active: scimBool.optional(),
});
export type ScimUserBody = z.infer<typeof scimUserBody>;

const memberRef = z.object({ value: str(100).min(1), display: z.string().optional() });
export const scimGroupBody = z.object({
  displayName: str(200).min(1),
  externalId: str(200).optional(),
  members: z.array(memberRef).max(10_000).optional(),
});
export type ScimGroupBody = z.infer<typeof scimGroupBody>;

export const patchBody = z.object({
  Operations: z
    .array(
      z.object({
        op: z.string().transform((o) => o.toLowerCase()),
        path: z.string().max(300).optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type PatchOp = z.infer<typeof patchBody>["Operations"][number];

/** The display name slai stores for a SCIM User. */
export function displayNameOf(u: Pick<ScimUserBody, "displayName" | "name" | "userName">): string {
  const parts = [u.name?.givenName, u.name?.familyName].filter(Boolean).join(" ");
  return (u.displayName || u.name?.formatted || parts || u.userName).slice(0, 200);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The user's email: `userName` when it is one (Okta, Entra UPNs), else the primary email. */
export function emailOf(u: Pick<ScimUserBody, "userName" | "emails">): string | null {
  if (EMAIL.test(u.userName)) return u.userName.toLowerCase();
  const primary = u.emails?.find((e) => e.primary) ?? u.emails?.[0];
  return primary && EMAIL.test(primary.value) ? primary.value.toLowerCase() : null;
}

/** `attr eq "value"` (the filters Okta and Entra ID use). Anything else is `invalidFilter`. */
export function parseEqFilter(
  filter: string | undefined,
  attrs: readonly string[],
): { attr: string; value: string } | null {
  if (filter === undefined || filter.trim() === "") return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const attr = m && attrs.find((a) => a.toLowerCase() === m[1]!.toLowerCase());
  if (!m || !attr)
    throw new ScimError(
      400,
      `Unsupported filter. Use ${attrs.map((a) => `${a} eq "..."`).join(" or ")}.`,
      "invalidFilter",
    );
  return { attr, value: m[2]!.replace(/\\(.)/g, "$1") };
}

export function listResponse<T>(all: T[], startIndex: number, count: number) {
  const page = all.slice(startIndex - 1, startIndex - 1 + count);
  return { schemas: [LIST_SCHEMA], totalResults: all.length, startIndex, itemsPerPage: page.length, Resources: page };
}

export function paging(q: Record<string, string | undefined>): { startIndex: number; count: number } {
  const startIndex = Math.max(1, Number.parseInt(q.startIndex ?? "1", 10) || 1);
  const count = Math.min(200, Math.max(0, Number.parseInt(q.count ?? "100", 10) || 0));
  return { startIndex, count: q.count === undefined ? 100 : count };
}

// ---------------------------------------------------------------- PATCH /Users

export interface UserChanges {
  active?: boolean;
  externalId?: string | null;
  displayName?: string;
  givenName?: string;
  familyName?: string;
  userName?: string;
}

const asBool = (v: unknown): boolean => {
  const r = scimBool.safeParse(v);
  if (!r.success) throw new ScimError(400, "active must be a boolean.", "invalidValue");
  return r.data;
};
const asStr = (v: unknown, path: string): string => {
  if (typeof v !== "string") throw new ScimError(400, `${path} must be a string.`, "invalidValue");
  return v.trim().slice(0, 200);
};

/**
 * Folds PatchOp operations into the attribute changes slai keeps (active, externalId,
 * names, userName). Other attributes (title, locale, phone numbers...) are ignored.
 */
export function userPatch(ops: PatchOp[]): UserChanges {
  const out: UserChanges = {};
  const set = (path: string, value: unknown) => {
    switch (path.toLowerCase()) {
      case "active":
        out.active = asBool(value);
        break;
      case "externalid":
        out.externalId = value === null ? null : asStr(value, path);
        break;
      case "displayname":
      case "name.formatted":
        out.displayName = asStr(value, path);
        break;
      case "name.givenname":
        out.givenName = asStr(value, path);
        break;
      case "name.familyname":
        out.familyName = asStr(value, path);
        break;
      case "username":
        out.userName = asStr(value, path);
        break;
      case "name":
        if (value && typeof value === "object") {
          for (const [k, v] of Object.entries(value)) set(`name.${k}`, v);
        }
        break;
    }
  };
  for (const op of ops) {
    if (op.op !== "add" && op.op !== "replace" && op.op !== "remove") {
      throw new ScimError(400, `Unsupported op "${op.op}".`, "invalidSyntax");
    }
    if (op.op === "remove") {
      if (op.path?.toLowerCase() === "externalid") out.externalId = null;
      continue;
    }
    if (op.path) set(op.path, op.value);
    else if (op.value && typeof op.value === "object") {
      for (const [k, v] of Object.entries(op.value)) set(k, v);
    } else throw new ScimError(400, "An operation without a path needs an object value.", "invalidSyntax");
  }
  return out;
}

// ---------------------------------------------------------------- PATCH /Groups

export interface GroupChanges {
  displayName?: string;
  externalId?: string | null;
  add: string[];
  remove: string[];
  /** Replace the member list (a `replace` on `members`, or `remove` of all members). */
  replace?: string[];
}

const memberIds = (v: unknown): string[] => {
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.map((m) => {
    const r = memberRef.safeParse(m);
    if (!r.success) throw new ScimError(400, "Members must look like { value: <user id> }.", "invalidValue");
    return r.data.value;
  });
};

/** Folds PatchOp operations on a Group (Okta and Entra ID shapes). */
export function groupPatch(ops: PatchOp[]): GroupChanges {
  const out: GroupChanges = { add: [], remove: [] };
  for (const op of ops) {
    const path = op.path?.trim();
    const filtered = path ? /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path) : null;
    if (op.op === "remove") {
      if (filtered) out.remove.push(filtered[1]!);
      else if (path?.toLowerCase() === "members") {
        if (op.value === undefined) out.replace = [];
        else out.remove.push(...memberIds(op.value));
      } else if (path?.toLowerCase() === "externalid") out.externalId = null;
      else throw new ScimError(400, `Cannot remove ${path ?? "the group"}.`, "invalidPath");
      continue;
    }
    if (op.op !== "add" && op.op !== "replace") throw new ScimError(400, `Unsupported op "${op.op}".`, "invalidSyntax");
    const apply = (key: string, value: unknown) => {
      switch (key.toLowerCase()) {
        case "displayname":
          out.displayName = asStr(value, "displayName");
          break;
        case "externalid":
          out.externalId = value === null ? null : asStr(value, "externalId");
          break;
        case "members":
          if (op.op === "replace") out.replace = memberIds(value);
          else out.add.push(...memberIds(value));
          break;
      }
    };
    if (path) apply(path, op.value);
    else if (op.value && typeof op.value === "object") {
      for (const [k, v] of Object.entries(op.value)) apply(k, v);
    } else throw new ScimError(400, "An operation without a path needs an object value.", "invalidSyntax");
  }
  return out;
}
