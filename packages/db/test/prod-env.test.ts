import { describe, expect, it } from "vitest";
import { assertProductionEnv, isProductionDeploy, productionEnvProblems } from "../src/prod-env.js";

const key = Buffer.alloc(32, 1).toString("base64");
const secret = Buffer.alloc(32, 2).toString("base64");
const db = (role: string, pw: string) => `postgres://${role}:${pw}@db.internal:5432/slai?sslmode=verify-full`;

const goodApi: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  APP_URL: "https://app.slai.dev",
  API_URL: "https://app.slai.dev",
  DATABASE_APP_URL: db("slai_app", "Zq8-generated-app"),
  DATABASE_SYSTEM_URL: db("slai_worker", "Zq8-generated-worker"),
  DATABASE_AUTH_URL: db("slai_auth", "Zq8-generated-auth"),
  ENCRYPTION_KEY: key,
  SESSION_SECRET: secret,
  STORAGE_DRIVER: "s3",
  S3_BUCKET: "slai-prod-contracts",
  S3_SSE: "aws:kms",
};
const goodWorker: NodeJS.ProcessEnv = {
  ...goodApi,
  MODEL_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-ant-x",
  AGENT_RUNTIME: "e2b",
  E2B_API_KEY: "e2b_x",
  E2B_TEMPLATE: "slai-agent:abc123",
  SMTP_URL: "smtps://user:pass@smtp.example.com:465",
};

describe("production env validation", () => {
  it("accepts a hardened configuration", () => {
    expect(productionEnvProblems(goodApi, "api")).toEqual([]);
    expect(productionEnvProblems(goodWorker, "worker")).toEqual([]);
    expect(productionEnvProblems({ NODE_ENV: "production", DATABASE_URL: db("slai", "Zq8-owner") }, "migrate")).toEqual(
      [],
    );
  });

  it("does nothing outside production, and DEPLOY_ENV=staging opts a production build out", () => {
    expect(productionEnvProblems({ NODE_ENV: "development", MODEL_PROVIDER: "mock" }, "worker")).toEqual([]);
    expect(isProductionDeploy({ NODE_ENV: "production", DEPLOY_ENV: "staging" })).toBe(false);
    expect(isProductionDeploy({ NODE_ENV: "development", DEPLOY_ENV: "production" })).toBe(true);
  });

  it("refuses mock AI and the in-process agent runtime", () => {
    const p = productionEnvProblems({ ...goodWorker, MODEL_PROVIDER: "mock", AGENT_RUNTIME: "local" }, "worker");
    expect(p.join("\n")).toMatch(/MODEL_PROVIDER=mock is not allowed/);
    const local = productionEnvProblems({ ...goodWorker, MODEL_PROVIDER: "ollama" }, "worker");
    expect(local.join("\n")).toMatch(/MODEL_PROVIDER=ollama is for local prototypes only/);
    expect(p.join("\n")).toMatch(/AGENT_RUNTIME must be e2b/);
    expect(productionEnvProblems({ ...goodWorker, E2B_TEMPLATE: "slai-agent" }, "worker").join()).toMatch(/pinned/);
    expect(productionEnvProblems({ ...goodWorker, ANTHROPIC_API_KEY: "" }, "worker").join()).toMatch(
      /ANTHROPIC_API_KEY is required/,
    );
  });

  it("refuses local storage and s3 without explicit encryption", () => {
    expect(productionEnvProblems({ ...goodApi, STORAGE_DRIVER: "local" }, "api").join()).toMatch(/STORAGE_DRIVER/);
    expect(productionEnvProblems({ ...goodApi, S3_SSE: undefined }, "api").join()).toMatch(/S3_SSE/);
    expect(productionEnvProblems({ ...goodApi, S3_ENDPOINT: "http://minio:9000" }, "api").join()).toMatch(
      /S3_ENDPOINT must be an https/,
    );
  });

  it("refuses missing TLS: http URLs, databases without sslmode, plaintext SMTP", () => {
    const p = productionEnvProblems(
      {
        ...goodApi,
        APP_URL: "http://app.slai.dev",
        DATABASE_APP_URL: "postgres://slai_app:Zq8-generated@db.internal/slai",
      },
      "api",
    ).join("\n");
    expect(p).toMatch(/APP_URL must be an https/);
    expect(p).toMatch(/DATABASE_APP_URL must use TLS/);
    expect(productionEnvProblems({ ...goodWorker, SMTP_URL: "smtp://mailpit:1025" }, "worker").join()).toMatch(
      /SMTP_URL must use TLS/,
    );
    // A Unix socket (cloud SQL proxy) needs no sslmode; STARTTLS with requireTLS is accepted.
    expect(
      productionEnvProblems(
        {
          ...goodWorker,
          DATABASE_APP_URL: "postgres://slai_app:Zq8-x@localhost/slai?host=/cloudsql/p:r:i",
          SMTP_URL: "smtp://u:p@smtp.example.com:587?requireTLS=true",
        },
        "worker",
      ),
    ).toEqual([]);
  });

  it("refuses the default role passwords from the migrations", () => {
    for (const [name, url] of [
      ["DATABASE_APP_URL", db("slai_app", "slai_app")],
      ["DATABASE_SYSTEM_URL", db("slai_worker", "slai_worker")],
      ["DATABASE_AUTH_URL", db("slai_auth", "slai_auth")],
    ] as const) {
      expect(productionEnvProblems({ ...goodApi, [name]: url }, "api").join()).toMatch(
        new RegExp(`${name} uses a default development password`),
      );
    }
    expect(
      productionEnvProblems({ NODE_ENV: "production", DATABASE_URL: db("slai", "slai") }, "migrate").join(),
    ).toMatch(/DATABASE_URL uses a default development password/);
  });

  it("throws listing every problem by name, never a value", () => {
    const bad = { ...goodWorker, MODEL_PROVIDER: "mock", STORAGE_DRIVER: "local", ANTHROPIC_API_KEY: "sk-ant-secret" };
    expect(() => assertProductionEnv(bad, "worker")).toThrow(/refusing to start worker in production/);
    try {
      assertProductionEnv({ ...bad, DATABASE_APP_URL: db("slai_app", "slai_app") }, "worker");
    } catch (e) {
      expect((e as Error).message).not.toContain("sk-ant-secret");
      expect((e as Error).message).not.toContain("db.internal");
    }
  });
});
