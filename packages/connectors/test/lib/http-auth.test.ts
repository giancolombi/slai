import { describe, expect, it, vi } from "vitest";
import { detectRateLimits, HttpClient, isUnauthorized, requestToken, retryOnceOnAuth } from "../../src/lib/http.js";
import { ConnectorError } from "../../src/types.js";
import { fakeFetch, rejection } from "../helpers/fake-fetch.js";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A fetch that records the request (form bodies included) and answers with `status`/`json`. */
function recorder(status: number, json: unknown, headers: Record<string, string> = {}) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      h[k] = v;
    });
    seen.push({ url: String(input), headers: h, body: init?.body ? String(init.body) : null });
    return new Response(json === undefined ? "" : JSON.stringify(json), { status, headers });
  }) as typeof fetch;
  return { f, seen };
}

describe("requestToken", () => {
  it("POSTs a form-encoded grant and returns the parsed JSON", async () => {
    const { f, seen } = recorder(200, { access_token: "at", expires_in: 60 });
    const data = await requestToken({
      fetch: f,
      url: "https://auth.test/oauth/token",
      params: { grant_type: "client_credentials", client_id: "id", client_secret: "s3cret" },
    });
    expect(data).toEqual({ access_token: "at", expires_in: 60 });
    expect(seen[0]).toEqual({
      url: "https://auth.test/oauth/token",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&client_id=id&client_secret=s3cret",
    });
  });

  it("can put the grant in the query string instead (Zoho)", async () => {
    const { f, seen } = recorder(200, { access_token: "at" });
    await requestToken({
      fetch: f,
      url: "https://accounts.zoho.test/oauth/v2/token",
      params: { grant_type: "refresh_token", refresh_token: "r" },
      paramsIn: "query",
    });
    expect(seen[0]?.url).toBe("https://accounts.zoho.test/oauth/v2/token?grant_type=refresh_token&refresh_token=r");
    expect(seen[0]?.body).toBeNull();
    expect(seen[0]?.headers["content-type"]).toBeUndefined();
  });

  it("maps a rejected grant to auth, echoing only the OAuth error code", async () => {
    for (const status of [400, 401, 403]) {
      const { f } = recorder(status, { error: "invalid_grant", error_description: "client_secret=s3cret bad" });
      const err = await rejection(
        requestToken({ fetch: f, url: "https://auth.test/token?x=1", params: { client_secret: "s3cret" } }),
      );
      expect(err.kind).toBe("auth");
      expect(err.message).toBe(`POST https://auth.test/token → ${status}: invalid_grant`);
      expect(err.message).not.toContain("s3cret");
    }
    const { f } = recorder(401, {});
    const custom = await rejection(
      requestToken({ fetch: f, url: "https://auth.test/token", params: {}, authMessage: "bad app" }),
    );
    expect(custom.message).toBe("bad app");
  });

  it("maps 429/503 to rate_limited with Retry-After, 5xx to upstream, and non-JSON to upstream", async () => {
    const limited = await rejection(
      requestToken({ fetch: recorder(429, {}, { "Retry-After": "7" }).f, url: "https://a.test/t", params: {} }),
    );
    expect([limited.kind, limited.retryAfterMs]).toEqual(["rate_limited", 7000]);
    const down = await rejection(requestToken({ fetch: recorder(500, {}).f, url: "https://a.test/t", params: {} }));
    expect(down.kind).toBe("upstream");
    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const bad = await rejection(
      requestToken({ fetch: html, url: "https://a.test/t", params: {}, label: "Acme token" }),
    );
    expect([bad.kind, bad.message]).toEqual(["upstream", "Acme token returned non-JSON"]);
  });

  it("maps network failures to upstream", async () => {
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const err = await rejection(requestToken({ fetch: down, url: "https://a.test/t", params: {} }));
    expect([err.kind, err.message]).toEqual(["upstream", "POST https://a.test/t failed: ECONNRESET"]);
  });
});

describe("detectRateLimits", () => {
  it("rewrites a matching 403 to rate_limited using the vendor's headers (GitHub style)", async () => {
    const f = fakeFetch([
      { method: "GET", url: "https://x.test/a", status: 403, responseHeaders: { "retry-after": "9" } },
      { method: "GET", url: "https://x.test/b", status: 403, json: { message: "Resource not accessible" } },
    ]);
    const http = new HttpClient({
      baseUrl: "https://x.test",
      fetch: detectRateLimits(f.fetch, { statuses: [403], test: (res) => res.headers.has("retry-after") }),
    });
    const a = await rejection(http.get("/a"));
    expect([a.kind, a.retryAfterMs]).toEqual(["rate_limited", 9000]);
    const b = await rejection(http.get("/b"));
    expect(b.kind).toBe("auth");
    expect(b.message).toContain("Resource not accessible");
  });

  it("inspects the body and computes Retry-After when the vendor sends none (Linear style)", async () => {
    const f = fakeFetch([
      { method: "POST", url: "https://x.test/gql", status: 400, json: { errors: [{ code: "RATELIMITED" }] } },
      { method: "POST", url: "https://x.test/gql", status: 400, json: { errors: [{ code: "BAD_INPUT" }] } },
    ]);
    const http = new HttpClient({
      baseUrl: "https://x.test",
      fetch: detectRateLimits(f.fetch, {
        statuses: (s) => s === 400,
        readBody: true,
        test: (_res, body) => body.includes("RATELIMITED"),
        retryAfterMs: () => 2500,
      }),
    });
    const limited = await rejection(http.post("/gql", {}));
    expect([limited.kind, limited.retryAfterMs]).toEqual(["rate_limited", 3000]);
    const invalid = await rejection(http.post("/gql", {}));
    expect(invalid.kind).toBe("invalid");
    // The body read for the check is still there for the error detail.
    expect(invalid.message).toContain("BAD_INPUT");
  });

  it("leaves successful and uninspected responses untouched", async () => {
    const f = fakeFetch([
      { method: "GET", url: "https://x.test/ok", json: { ok: true } },
      { method: "GET", url: "https://x.test/gone", status: 404 },
    ]);
    const test = vi.fn(() => true);
    const http = new HttpClient({
      baseUrl: "https://x.test",
      fetch: detectRateLimits(f.fetch, { statuses: [403], test }),
    });
    expect(await http.get("/ok")).toEqual({ ok: true });
    expect((await rejection(http.get("/gone"))).kind).toBe("not_found");
    expect(test).not.toHaveBeenCalled();
  });
});

describe("retryOnceOnAuth", () => {
  const unauthorized = () => new ConnectorError("GET https://x.test/a → 401", "auth");

  it("refreshes and retries exactly once on a 401", async () => {
    const run = vi.fn().mockRejectedValueOnce(unauthorized()).mockResolvedValueOnce("ok");
    const onAuthFailure = vi.fn();
    expect(await retryOnceOnAuth(run, { onAuthFailure })).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);

    const always = vi.fn().mockRejectedValue(unauthorized());
    expect((await rejection(retryOnceOnAuth(always, { onAuthFailure: () => {} }))).kind).toBe("auth");
    expect(always).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 403, other errors, or when `when` says no", async () => {
    for (const err of [
      new ConnectorError("GET https://x.test/a → 403", "auth"),
      new ConnectorError("boom", "upstream"),
      new Error("plain"),
    ]) {
      const run = vi.fn().mockRejectedValue(err);
      await expect(retryOnceOnAuth(run, { onAuthFailure: () => {} })).rejects.toBe(err);
      expect(run).toHaveBeenCalledTimes(1);
    }
    const run = vi.fn().mockRejectedValue(unauthorized());
    await expect(retryOnceOnAuth(run, { onAuthFailure: () => {}, when: () => false })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("recognises HttpClient 401s only", () => {
    expect(isUnauthorized(unauthorized())).toBe(true);
    expect(isUnauthorized(new ConnectorError("x → 4010", "auth"))).toBe(false);
    expect(isUnauthorized(new ConnectorError("x → 401", "invalid"))).toBe(false);
  });
});
