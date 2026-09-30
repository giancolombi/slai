/**
 * Wraps better-auth's database adapter to keep two guarantees better-auth does
 * not give on its own (TR-23, TR-27):
 *
 * 1. Session tokens are stored only as sha256. better-auth stores and looks up
 *    `session.token` in plain text; here every write of `token` stores its hash,
 *    every `where token = x` / `token in (...)` matches on the hash, and rows read
 *    back by token carry the caller's raw token again, so better-auth can still
 *    set cookies. Rows read any other way (e.g. by user id) carry only the hash.
 *
 * 2. SSO secrets are sealed with our AES-256-GCM keyring. `ssoProvider.oidcConfig`
 *    (and `samlConfig`) are JSON strings; the OIDC `clientSecret` and a SAML SP
 *    `privateKey` are encrypted on write (AAD bound to the provider id) and
 *    decrypted on read, so only better-auth's in-memory copy is plaintext.
 */
import { createHash } from "node:crypto";
import { AAD, decrypt, encrypt, type Keyring } from "@slai/db";
import type { DBAdapter, Where } from "better-auth";

type Row = Record<string, unknown>;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const SEALED = /^v1\.[A-Za-z0-9_-]{1,32}\./;

/** Replaces token values in a where clause by their hashes; returns hash -> raw. */
function hashWhere(where: Where[] | undefined): { where: Where[] | undefined; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  if (!where) return { where, raw };
  const out = where.map((w) => {
    if (w.field !== "token") return w;
    if (Array.isArray(w.value)) {
      return {
        ...w,
        value: (w.value as string[]).map((v) => {
          raw.set(hash(v), v);
          return hash(v);
        }),
      };
    }
    if (typeof w.value !== "string") return w;
    raw.set(hash(w.value), w.value);
    return { ...w, value: hash(w.value) };
  });
  return { where: out as Where[], raw };
}

function restoreToken<T>(row: T, raw: Map<string, string>): T {
  if (!row || typeof row !== "object") return row;
  const r = row as Row;
  if (typeof r.token === "string" && raw.has(r.token)) return { ...r, token: raw.get(r.token) } as T;
  return row;
}

function sealJson(json: unknown, providerId: string, keyring: Keyring, kind: "oidc" | "saml"): unknown {
  if (typeof json !== "string") return json;
  const cfg = JSON.parse(json) as Row;
  const field = kind === "oidc" ? "clientSecret" : "privateKey";
  const aad = kind === "oidc" ? AAD.ssoClientSecret(providerId) : AAD.ssoSamlPrivateKey(providerId);
  const v = cfg[field];
  if (typeof v === "string" && v && !SEALED.test(v)) cfg[field] = encrypt(v, { keyring, aad });
  return JSON.stringify(cfg);
}

function openJson(json: unknown, providerId: string, keyring: Keyring, kind: "oidc" | "saml"): unknown {
  if (typeof json !== "string") return json;
  const cfg = JSON.parse(json) as Row;
  const field = kind === "oidc" ? "clientSecret" : "privateKey";
  const aad = kind === "oidc" ? AAD.ssoClientSecret(providerId) : AAD.ssoSamlPrivateKey(providerId);
  const v = cfg[field];
  if (typeof v === "string" && SEALED.test(v)) cfg[field] = decrypt(v, { keyring, aad });
  return JSON.stringify(cfg);
}

function sealProvider(data: Row, keyring: Keyring, providerId?: string): Row {
  const id = (data.providerId as string | undefined) ?? providerId;
  if (!id) return data;
  const out = { ...data };
  if ("oidcConfig" in out) out.oidcConfig = sealJson(out.oidcConfig, id, keyring, "oidc");
  if ("samlConfig" in out) out.samlConfig = sealJson(out.samlConfig, id, keyring, "saml");
  return out;
}

/** Seals a provider's configs before our /org/sso routes write them. */
export function sealProviderConfig(data: Row & { providerId: string }, keyring: Keyring): Row {
  return sealProvider(data, keyring);
}

function openProvider<T>(row: T, keyring: Keyring): T {
  if (!row || typeof row !== "object") return row;
  const r = row as Row;
  const id = r.providerId as string | undefined;
  if (!id) return row;
  return {
    ...r,
    ...("oidcConfig" in r && { oidcConfig: openJson(r.oidcConfig, id, keyring, "oidc") }),
    ...("samlConfig" in r && { samlConfig: openJson(r.samlConfig, id, keyring, "saml") }),
  } as T;
}

/** Provider id for an update: from the data, or from a `providerId` where clause. */
function providerIdOf(where: Where[]): string | undefined {
  const w = where.find((x) => x.field === "providerId" && typeof x.value === "string");
  return w?.value as string | undefined;
}

export function sealAdapter(inner: DBAdapter, keyring: Keyring): DBAdapter {
  const readRow = <T>(model: string, row: T, raw: Map<string, string>): T => {
    if (model === "session") return restoreToken(row, raw);
    if (model === "ssoProvider") return openProvider(row, keyring);
    return row;
  };
  const writeData = (model: string, data: Row, where: Where[] = []): { data: Row; raw: Map<string, string> } => {
    const raw = new Map<string, string>();
    if (model === "session" && typeof data.token === "string") {
      raw.set(hash(data.token), data.token);
      return { data: { ...data, token: hash(data.token) }, raw };
    }
    if (model === "ssoProvider") return { data: sealProvider(data, keyring, providerIdOf(where)), raw };
    return { data, raw };
  };

  const wrapped: DBAdapter = {
    ...inner,
    create: (async (args: Parameters<DBAdapter["create"]>[0]) => {
      const { data, raw } = writeData(args.model, args.data as Row);
      const row = await inner.create({ ...args, data: data as typeof args.data });
      return readRow(args.model, row, raw);
    }) as DBAdapter["create"],
    findOne: (async (args: Parameters<DBAdapter["findOne"]>[0]) => {
      const { where, raw } = hashWhere(args.where);
      return readRow(args.model, await inner.findOne({ ...args, where: where! }), raw);
    }) as DBAdapter["findOne"],
    findMany: (async (args: Parameters<DBAdapter["findMany"]>[0]) => {
      const { where, raw } = hashWhere(args.where);
      const rows = await inner.findMany({ ...args, where });
      return rows.map((r) => readRow(args.model, r, raw));
    }) as DBAdapter["findMany"],
    count: async (args) => inner.count({ ...args, where: hashWhere(args.where).where }),
    update: (async (args: Parameters<DBAdapter["update"]>[0]) => {
      const { where, raw } = hashWhere(args.where);
      const w = writeData(args.model, args.update, args.where);
      for (const [k, v] of w.raw) raw.set(k, v);
      return readRow(args.model, await inner.update({ ...args, where: where!, update: w.data }), raw);
    }) as DBAdapter["update"],
    updateMany: async (args) => {
      const { where } = hashWhere(args.where);
      return inner.updateMany({ ...args, where: where!, update: writeData(args.model, args.update, args.where).data });
    },
    delete: async (args) => inner.delete({ ...args, where: hashWhere(args.where).where! }),
    deleteMany: async (args) => inner.deleteMany({ ...args, where: hashWhere(args.where).where! }),
    consumeOne: (async (args: Parameters<DBAdapter["consumeOne"]>[0]) => {
      const { where, raw } = hashWhere(args.where);
      return readRow(args.model, await inner.consumeOne({ ...args, where: where! }), raw);
    }) as DBAdapter["consumeOne"],
    incrementOne: (async (args: Parameters<DBAdapter["incrementOne"]>[0]) => {
      const { where, raw } = hashWhere(args.where);
      return readRow(args.model, await inner.incrementOne({ ...args, where: where! }), raw);
    }) as DBAdapter["incrementOne"],
    transaction: (cb) => inner.transaction((trx) => cb(sealAdapter(trx as DBAdapter, keyring) as never)),
  };
  return wrapped;
}
