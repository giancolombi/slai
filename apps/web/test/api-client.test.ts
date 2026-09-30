import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, CSRF_HEADER, errorMessage, isApiError, request } from "../src/lib/api";

type FetchArgs = [input: string, init: RequestInit];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;

beforeEach(() => {
  fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const headersOf = (call: number) => (fetchMock.mock.calls[call]![1].headers ?? {}) as Record<string, string>;

describe("api client: requests", () => {
  it("prefixes /api/v1, includes credentials and omits the CSRF header on GET", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    await api.tickets.list({ risk: "at_risk", q: "", status: undefined, cursor: null });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/tickets?risk=at_risk");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect(headersOf(0)[CSRF_HEADER]).toBeUndefined();
  });

  it.each([
    ["POST", () => api.actions.approve("act_1", { body: "Hi" })],
    ["PATCH", () => api.org.update({ name: "Acme" })],
    [
      "PUT",
      () =>
        api.autonomy.update("r1", {
          customerAccountId: null,
          priority: null,
          level: "assist",
          triggerAt: "at_risk",
          minConfidence: 0.8,
        }),
    ],
    ["DELETE", () => api.members.remove("u_1")],
  ] as const)("sends X-Requested-With: slai on %s", async (method, call) => {
    fetchMock.mockResolvedValueOnce(method === "DELETE" ? new Response(null, { status: 204 }) : jsonResponse({}));
    await call();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe(method);
    expect(headersOf(0)[CSRF_HEADER]).toBe("slai");
    expect(init.credentials).toBe("include");
  });

  it("serializes JSON bodies with a content type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "act_1" }));
    await api.actions.reject("act_1", { reason: "Off tone" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/actions/act_1/reject");
    expect(headersOf(0)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "Off tone" });
  });

  it("encodes path segments", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await api.tickets.get("a/b c");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/tickets/a%2Fb%20c");
  });

  it("returns undefined for 204", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.auth.logout()).resolves.toBeUndefined();
  });
});

describe("api client: errors", () => {
  it("throws a typed ApiError from the error envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "policy_not_draft", message: "Only drafts can be edited.", details: { id: "p1" } } },
        409,
      ),
    );
    const err = await api.policies.update("p1", { name: "x" }).catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: "policy_not_draft",
      message: "Only drafts can be edited.",
      details: { id: "p1" },
    });
  });

  it("distinguishes the MFA gate (403) from an expired session (401)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "mfa_enrollment_required", message: "Set up two-factor." } }, 403),
    );
    const gate = (await api.dashboard.get().catch((e: unknown) => e)) as ApiError;
    expect(gate.isEnrollmentRequired).toBe(true);
    expect(gate.isUnauthorized).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "mfa_required", message: "Verify." } }, 403));
    const verify = (await api.dashboard.get().catch((e: unknown) => e)) as ApiError;
    expect(verify.isMfaRequired).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "unauthorized", message: "Please sign in." } }, 401));
    const expired = (await api.auth.me().catch((e: unknown) => e)) as ApiError;
    expect(expired.isUnauthorized).toBe(true);
  });

  it("falls back to a readable message when the body isn't JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 502 }));
    const err = (await request("GET", "/dashboard").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.code).toBe("http_502");
    expect(err.message).toMatch(/something went wrong/i);
  });

  it("classifies validation, forbidden and not-found errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "validation_failed", message: "Bad" } }, 400));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "forbidden", message: "No" } }, 403));
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    const a = (await api.org.update({}).catch((e: unknown) => e)) as ApiError;
    const b = (await api.audit.list().catch((e: unknown) => e)) as ApiError;
    const c = (await api.tickets.get("nope").catch((e: unknown) => e)) as ApiError;
    expect([a.isValidation, b.isForbidden, c.isNotFound]).toEqual([true, true, true]);
    expect(c.message).toBe("Not found.");
  });

  it("wraps network failures as status 0 network_error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const err = (await api.dashboard.get().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.isNetwork).toBe(true);
    expect(err.code).toBe("network_error");
    expect(errorMessage(err)).toMatch(/can't reach slai/i);
  });

  it("lets aborts propagate untouched", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    fetchMock.mockRejectedValueOnce(abort);
    await expect(api.dashboard.get()).rejects.toBe(abort);
  });
});
