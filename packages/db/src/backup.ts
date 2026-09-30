/**
 * Logical backups (T-63, TR-33): `pnpm db:backup` / `pnpm db:restore` wrap
 * pg_dump / pg_restore in the custom format. They complement, never replace,
 * the managed database's point-in-time recovery (see TR-33 for retention).
 *
 * pg_dump must be at least the server's major version. The local binary is used
 * when it is new enough; otherwise the tools run from the `postgres:<major>`
 * image (PG_TOOLS=local|docker forces one).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, resolve } from "node:path";
import postgres from "postgres";

export interface PgTools {
  mode: "local" | "docker";
  run(tool: "pg_dump" | "pg_restore", args: string[], url: string, mountDir: string): Promise<void>;
}

function exec(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      out += d;
    });
    p.on("error", fail);
    p.on("close", (code) => ok({ code: code ?? 1, out }));
  });
}

async function serverMajor(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [r] = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
    return Math.floor(Number(r!.v) / 10000);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function localMajor(): Promise<number | null> {
  try {
    const { code, out } = await exec("pg_dump", ["--version"]);
    const m = /(\d+)(?:\.\d+)?/.exec(out);
    return code === 0 && m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Splits a URL into libpq env vars, so the password never appears in a process list. */
function libpqEnv(url: string, hostOverride?: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  const ssl = u.searchParams.get("sslmode");
  return {
    PGHOST: hostOverride ?? u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1),
    ...(ssl && { PGSSLMODE: ssl }),
  };
}

export async function pgTools(url: string, force = process.env.PG_TOOLS): Promise<PgTools> {
  const major = await serverMajor(url);
  const local = await localMajor();
  const mode = force === "local" || force === "docker" ? force : local !== null && local >= major ? "local" : "docker";
  if (mode === "local") {
    return {
      mode,
      async run(tool, args, u) {
        const r = await exec(tool, args, libpqEnv(u));
        if (r.code !== 0) throw new Error(`${tool} failed:\n${r.out.trim()}`);
      },
    };
  }
  return {
    mode,
    async run(tool, args, u, mountDir) {
      // Linux shares the host network; Docker Desktop reaches the host as host.docker.internal.
      const linux = process.platform === "linux";
      const host = new URL(u).hostname;
      const local = host === "localhost" || host === "127.0.0.1";
      const env = libpqEnv(u, local && !linux ? "host.docker.internal" : undefined);
      const envArgs = Object.keys(env).flatMap((k) => ["-e", k]);
      const r = await exec(
        "docker",
        [
          "run",
          "--rm",
          ...(linux ? ["--network", "host"] : []),
          ...envArgs,
          "-v",
          `${mountDir}:/backup`,
          `postgres:${major}`,
          tool,
          ...args.map((a) => a.replaceAll(mountDir, "/backup")),
        ],
        env,
      );
      if (r.code !== 0) throw new Error(`${tool} (docker postgres:${major}) failed:\n${r.out.trim()}`);
    },
  };
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/**
 * Dumps the whole database (schema, data, grants, RLS policies, triggers, the
 * pg-boss schema) in pg_dump's custom format. Roles are cluster objects and are
 * not in the dump; restore recreates them.
 */
export async function backupDatabase(
  url: string,
  file: string,
  tools?: PgTools,
): Promise<{ file: string; sha256: string }> {
  const out = resolve(file);
  const t = tools ?? (await pgTools(url));
  await t.run("pg_dump", ["--format=custom", "--compress=9", "--no-owner", `--file=${out}`], url, dirname(out));
  return { file: out, sha256: await sha256File(out) };
}

/** Runtime roles the dump's grants refer to. Created NOLOGIN if missing; set real passwords afterwards. */
export const RUNTIME_ROLES = ["slai_app", "slai_worker", "slai_auth"] as const;

/**
 * Restores a dump into `url`'s database. The database must be empty unless
 * `clean` (drop and recreate the dumped objects). Ownership goes to the
 * connecting role; grants and RLS come back as dumped.
 */
export async function restoreDatabase(
  url: string,
  file: string,
  opts: { clean?: boolean; tools?: PgTools } = {},
): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [r] = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
    if ((r?.n ?? 0) > 0 && !opts.clean) {
      throw new Error("the target database is not empty; pass --clean to replace its contents");
    }
    for (const role of RUNTIME_ROLES) {
      await sql.unsafe(
        `do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} nologin; end if; end $$`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  const path = resolve(file);
  const t = opts.tools ?? (await pgTools(url));
  await t.run(
    "pg_restore",
    [
      "--no-owner",
      "--exit-on-error",
      "--single-transaction",
      ...(opts.clean ? ["--clean", "--if-exists"] : []),
      `--dbname=${new URL(url).pathname.slice(1)}`,
      path,
    ],
    url,
    dirname(path),
  );
}

export const backupFileName = (now = new Date()) => `slai-${now.toISOString().replace(/[:.]/g, "-")}.dump`;
