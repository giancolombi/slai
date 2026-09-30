/**
 * Production configuration guard (T-63, TR-34). The API, the worker and the
 * migrate job refuse to start in production with settings that are only safe
 * locally: mock AI, the in-process agent runtime, local file storage, plaintext
 * connections, or the development role passwords from the migrations.
 *
 * "Production" is DEPLOY_ENV=production, or NODE_ENV=production when
 * DEPLOY_ENV is unset. A staging stack that deliberately runs mocks sets
 * DEPLOY_ENV=staging (docker-compose.prod.yml does).
 */

export type Service = "api" | "worker" | "migrate";

/** Passwords the migrations and docker-compose create for local development. */
const DEV_PASSWORDS = new Set(["slai", "slai_app", "slai_worker", "slai_auth", "postgres", "password", ""]);
const TLS_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);

export function isProductionDeploy(env: NodeJS.ProcessEnv): boolean {
  const deploy = env.DEPLOY_ENV?.trim();
  return deploy ? deploy === "production" : env.NODE_ENV === "production";
}

const DB_VARS: Record<Service, string[]> = {
  api: ["DATABASE_APP_URL", "DATABASE_SYSTEM_URL", "DATABASE_AUTH_URL"],
  worker: ["DATABASE_APP_URL", "DATABASE_SYSTEM_URL"],
  migrate: ["DATABASE_URL"],
};

function checkDatabaseUrl(name: string, value: string | undefined, problems: string[]): void {
  if (!value) return; // the service's own schema reports a missing URL
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    problems.push(`${name} is not a URL`);
    return;
  }
  const password = decodeURIComponent(u.password);
  if (DEV_PASSWORDS.has(password) || password === decodeURIComponent(u.username)) {
    problems.push(`${name} uses a default development password for role "${u.username}"; set a generated one`);
  }
  // A Unix socket (e.g. a cloud SQL proxy sidecar, ?host=/cloudsql/...) is local and needs no TLS.
  const socket = u.searchParams.get("host")?.startsWith("/");
  if (!socket && !TLS_SSLMODES.has(u.searchParams.get("sslmode") ?? "")) {
    problems.push(`${name} must use TLS: add ?sslmode=verify-full (or require)`);
  }
}

function https(name: string, value: string | undefined, problems: string[]): void {
  if (value && !value.startsWith("https://")) problems.push(`${name} must be an https:// URL`);
}

/** Every reason `service` must not start in production with `env`. Empty outside production. */
export function productionEnvProblems(env: NodeJS.ProcessEnv, service: Service): string[] {
  if (!isProductionDeploy(env)) return [];
  const problems: string[] = [];
  const v = (k: string) => (env[k] === "" ? undefined : env[k]);

  if (env.NODE_ENV !== "production") problems.push("NODE_ENV must be production");
  for (const name of DB_VARS[service]) checkDatabaseUrl(name, v(name), problems);

  if (service === "api" || service === "worker") {
    https("APP_URL", v("APP_URL"), problems);
    if ((v("STORAGE_DRIVER") ?? "local") !== "s3") {
      problems.push("STORAGE_DRIVER must be s3 (local disk is for development only)");
    } else {
      if (!v("S3_BUCKET")) problems.push("S3_BUCKET is required");
      if (!v("S3_SSE")) problems.push("S3_SSE must be set explicitly (AES256, aws:kms, or provider)");
      https("S3_ENDPOINT", v("S3_ENDPOINT"), problems);
    }
    if (v("ENCRYPTION_KEY") && v("ENCRYPTION_KEY") === v("SESSION_SECRET")) {
      problems.push("ENCRYPTION_KEY and SESSION_SECRET must be different keys");
    }
  }

  if (service === "api") {
    https("API_URL", v("API_URL"), problems);
  }

  if (service === "worker") {
    const provider = v("MODEL_PROVIDER") ?? "mock";
    if (provider === "mock") problems.push("MODEL_PROVIDER=mock is not allowed (use anthropic or openai)");
    if (provider === "ollama") {
      problems.push("MODEL_PROVIDER=ollama is for local prototypes only (use anthropic or openai)");
    }
    if (provider === "anthropic" && !v("ANTHROPIC_API_KEY")) problems.push("ANTHROPIC_API_KEY is required");
    if (provider === "openai" && !v("OPENAI_API_KEY")) problems.push("OPENAI_API_KEY is required");
    if ((v("AGENT_RUNTIME") ?? "local") !== "e2b") {
      problems.push("AGENT_RUNTIME must be e2b (the in-process runtime has no sandbox)");
    } else {
      if (!v("E2B_API_KEY")) problems.push("E2B_API_KEY is required");
      if (!/^[^:]+:.+$/.test(v("E2B_TEMPLATE") ?? "")) problems.push("E2B_TEMPLATE must be pinned (name:<buildId>)");
    }
    const smtp = v("SMTP_URL") ?? "";
    if (!smtp.startsWith("smtps://") && !/[?&]requireTLS=true\b/.test(smtp)) {
      problems.push("SMTP_URL must use TLS: smtps://…, or smtp://…?requireTLS=true for STARTTLS");
    }
  }
  return problems;
}

/** Throws with every problem listed (names only, never values). */
export function assertProductionEnv(env: NodeJS.ProcessEnv, service: Service): void {
  const problems = productionEnvProblems(env, service);
  if (problems.length) {
    throw new Error(`refusing to start ${service} in production:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}
