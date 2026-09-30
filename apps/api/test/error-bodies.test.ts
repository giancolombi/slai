import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { setupApp, signup } from "./harness.js";

const ctx = setupApp();

/** What a 5xx body must never carry: driver, stack, network or SQL detail. */
const LEAKS = [
  /relation "/i,
  /does not exist/i,
  /\bat Object\.<anonymous>/,
  /\/src\//,
  /ECONNREFUSED/,
  /127\.0\.0\.1/,
  /5432/,
  /postgres/i,
  /\bSQL\b|SQLSTATE|42P01/i,
  /stack/i,
  /remaining connection slots/i,
];

/** Makes every org-scoped query throw `err` for the duration of `fn`. */
async function withFailingDb<T>(err: unknown, fn: () => Promise<T>): Promise<T> {
  const db = ctx.deps.orgDb;
  const original = db.withOrg;
  db.withOrg = (async () => {
    throw err;
  }) as typeof db.withOrg;
  try {
    return await fn();
  } finally {
    db.withOrg = original;
  }
}

function expectClean(body: unknown) {
  const text = JSON.stringify(body);
  for (const re of LEAKS) expect(text).not.toMatch(re);
}

describe("5xx error bodies", () => {
  it("an unexpected driver error becomes a plain sentence plus a reference id", async () => {
    const { client } = await signup(ctx);
    const driverError = Object.assign(
      new Error(
        'relation "customer_accounts" does not exist\n    at Object.<anonymous> (/app/src/routes/customers.ts:42:7)\n    connect ECONNREFUSED 127.0.0.1:5432',
      ),
      { code: "42P01", severity: "ERROR", routine: "parserOpenTable" },
    );
    const res = await withFailingDb(driverError, () => client.get("/customers"));
    expect(res.status).toBe(500);
    expectClean(res.body);
    expect(res.body.error.code).toBe("internal");
    expect(res.body.error.message).toMatch(/^Something went wrong on our side\. Try again/);
    expect(res.body.error.requestId).toMatch(/^[\w-]{8,}$/);
    // The reference is a field, not glued into the sentence.
    expect(res.body.error.message).not.toContain(res.body.error.requestId);
    expect(res.headers.get("x-request-id")).toBe(res.body.error.requestId);
  });

  it("a saturated database is a 503 that asks the user to retry, with no driver text", async () => {
    const { client } = await signup(ctx);
    const saturated = Object.assign(
      new Error("sorry, too many clients already; remaining connection slots are reserved for postgres"),
      { code: "53300" },
    );
    const res = await withFailingDb(saturated, () => client.get("/customers"));
    expect(res.status).toBe(503);
    expectClean(res.body);
    expect(res.body.error.message).toMatch(/Try again in a moment/);
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.headers.get("retry-after")).toBe("2");
  });

  it("5xx messages we author keep their sentence and gain the reference", async () => {
    const { client } = await signup(ctx);
    const res = await withFailingDb(new ApiError(500, "internal", "Account created, but signing in failed."), () =>
      client.get("/customers"),
    );
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("Account created, but signing in failed.");
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("4xx bodies carry no reference id (nothing for support to chase)", async () => {
    const { client } = await signup(ctx);
    const res = await client.get("/customers/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.error.requestId).toBeUndefined();
  });
});
