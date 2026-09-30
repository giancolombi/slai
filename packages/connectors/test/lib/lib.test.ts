import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dropNoopChanges, finalizeEvents, firstPublicAgentReply, toEngineEvents } from "../../src/lib/events.js";
import { safeEqual, verifyHmac, verifyHs256Jwt } from "../../src/lib/hmac.js";
import { forbiddenAsUnsupported, HttpClient, parseRetryAfter } from "../../src/lib/http.js";
import { mapPriority, mappingIssues, mapStatus } from "../../src/lib/mapping.js";
import { collectPages, decodeCursor, encodeCursor, nextLink } from "../../src/lib/paginate.js";
import { htmlToText, savedReplyText, stripPlaceholders, truncate } from "../../src/lib/text.js";
import { type CanonicalEvent, ConnectorError, type FieldMapping } from "../../src/types.js";
import { fakeFetch, rejection } from "../helpers/fake-fetch.js";

describe("http", () => {
  it("sends auth headers and parses JSON", async () => {
    const f = fakeFetch([
      {
        method: "GET",
        url: "https://x.test/api/a?b=1",
        headers: { authorization: "Bearer t", accept: "application/json" },
        json: { ok: 1 },
      },
    ]);
    const http = new HttpClient({
      baseUrl: "https://x.test/api/",
      fetch: f.fetch,
      headers: { Authorization: "Bearer t" },
    });
    expect(await http.get("/a", { query: { b: 1, c: undefined } })).toEqual({ ok: 1 });
  });

  it("turns a 403 on a knowledge read into unsupported, leaving 401s and other errors alone", async () => {
    const f = fakeFetch([
      { method: "GET", url: "https://x.test/macros", status: 403, repeat: true },
      { method: "GET", url: "https://x.test/me", status: 401, repeat: true },
    ]);
    const http = new HttpClient({ baseUrl: "https://x.test", fetch: f.fetch });
    const forbidden = await rejection(forbiddenAsUnsupported("Macros", () => http.get("/macros")));
    expect(forbidden).toMatchObject({ kind: "unsupported", message: expect.stringMatching(/^Macros: .*403/) });
    expect(await rejection(forbiddenAsUnsupported("Macros", () => http.get("/me")))).toMatchObject({ kind: "auth" });
    expect(await forbiddenAsUnsupported("Macros", async () => 1)).toBe(1);
  });

  it("maps 429 to rate_limited with Retry-After seconds", async () => {
    const f = fakeFetch([
      { method: "GET", url: "https://x.test/a", status: 429, responseHeaders: { "Retry-After": "7" } },
    ]);
    const http = new HttpClient({ baseUrl: "https://x.test", fetch: f.fetch });
    const err = await rejection(http.get("/a"));
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(7000);
  });

  it("maps 503 with an HTTP-date Retry-After", async () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    const f = fakeFetch([
      {
        method: "GET",
        url: "https://x.test/a",
        status: 503,
        responseHeaders: { "Retry-After": "Tue, 29 Sep 2026 12:00:30 GMT" },
      },
    ]);
    const http = new HttpClient({ baseUrl: "https://x.test", fetch: f.fetch, now: () => now });
    const err = await rejection(http.get("/a"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("maps 401/404/422/500", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [422, "invalid"],
      [500, "upstream"],
    ] as const) {
      const f = fakeFetch([{ method: "GET", url: "https://x.test/a", status }]);
      const err = await rejection(new HttpClient({ baseUrl: "https://x.test", fetch: f.fetch }).get("/a"));
      expect(err.kind).toBe(kind);
    }
  });

  it("times out through AbortSignal", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const err = await rejection(new HttpClient({ baseUrl: "https://x.test", fetch: hang, timeoutMs: 20 }).get("/a"));
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.message).toMatch(/timed out/);
  });

  it("parses Retry-After forms", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("mapping", () => {
  const m: FieldMapping = { status: { open: "open", Hold: "on_hold" }, priority: { P1: "urgent" } };
  it("maps known values case-insensitively", () => {
    expect(mapStatus(m, "hold")).toEqual({ value: "on_hold", known: true });
    expect(mapPriority(m, "p1")).toEqual({ value: "urgent", known: true });
  });
  it("defaults and flags unknown values", () => {
    expect(mapStatus(m, "Triage")).toEqual({ value: "open", known: false });
    expect(mapPriority(m, "P9")).toEqual({ value: null, known: false });
    expect(mapPriority(m, null)).toEqual({ value: null, known: true });
    expect(mappingIssues(m, "Triage", "P9").issues).toEqual([
      { field: "status", raw: "Triage" },
      { field: "priority", raw: "P9" },
    ]);
  });
});

describe("hmac", () => {
  it("verifies hex with prefix and base64", () => {
    const sig = createHmac("sha256", "s").update("body").digest("hex");
    expect(
      verifyHmac({
        algo: "sha256",
        secret: "s",
        payload: "body",
        signature: `sha256=${sig}`,
        encoding: "hex",
        prefix: "sha256=",
      }),
    ).toBe(true);
    expect(
      verifyHmac({
        algo: "sha256",
        secret: "x",
        payload: "body",
        signature: `sha256=${sig}`,
        encoding: "hex",
        prefix: "sha256=",
      }),
    ).toBe(false);
    const b64 = createHmac("sha1", "s").update("body").digest("base64");
    expect(verifyHmac({ algo: "sha1", secret: "s", payload: "body", signature: b64, encoding: "base64" })).toBe(true);
    expect(verifyHmac({ algo: "sha1", secret: "s", payload: "body", signature: undefined, encoding: "base64" })).toBe(
      false,
    );
    expect(safeEqual("a", "ab")).toBe(false);
  });
  it("verifies HS256 JWTs and rejects expired ones", () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const h = enc({ alg: "HS256", typ: "JWT" });
    const p = enc({ iss: "atl", exp: 2000 });
    const s = createHmac("sha256", "sec").update(`${h}.${p}`).digest("base64url");
    expect(verifyHs256Jwt(`${h}.${p}.${s}`, "sec", 1_000_000)).toMatchObject({ iss: "atl" });
    expect(verifyHs256Jwt(`${h}.${p}.${s}`, "bad", 1_000_000)).toBeNull();
    expect(verifyHs256Jwt(`${h}.${p}.${s}`, "sec", 3_000_000)).toBeNull();
  });
});

describe("text", () => {
  it("converts HTML to readable text", () => {
    const html = `<div>Hi&nbsp;there,<br>line two</div><script>alert(1)</script><ul><li>a</li><li>b &amp; c</li></ul><p>&#8217;x&#x2019;</p>`;
    expect(htmlToText(html)).toBe("Hi there,\nline two\n\n• a\n• b & c\n\n’x’");
  });
  it("bounds length", () => {
    expect(htmlToText("<p>abcdefghij</p>", 5)).toBe("abcd…");
    expect(truncate("abc", 5)).toBe("abc");
  });
  it("strips saved-reply placeholders, keeping declared fallbacks and tidy punctuation", () => {
    expect(stripPlaceholders("Hi {{ticket.requester.first_name}},\nThanks!")).toBe("Hi,\nThanks!");
    expect(stripPlaceholders("Hello {{ first_name }} and welcome")).toBe("Hello and welcome");
    expect(stripPlaceholders('Hi {{first_name | fallback: "there"}}, one sec.')).toBe("Hi there, one sec.");
    expect(stripPlaceholders("Hi {%customer.firstName,fallback=there%}!")).toBe("Hi there!");
    expect(stripPlaceholders("Hi {{recipient.first_name | 'there'}}, hello")).toBe("Hi there, hello");
    expect(stripPlaceholders("Total {{ticket.amount | money }} due")).toBe("Total due");
    expect(stripPlaceholders("Dear #{ticket.customer.firstname} #{ticket.customer.lastname}.")).toBe("Dear.");
    expect(stripPlaceholders("{{ticket.requester.name}}, your order shipped")).toBe("your order shipped");
    expect(
      stripPlaceholders(
        "A{% if ticket.priority == 'urgent' %} fast{% endif %} fix{% comment %}secret{% endcomment %}.",
      ),
    ).toBe("A fast fix.");
    expect(stripPlaceholders("Costs {not a tag} and #hashtag stay")).toBe("Costs {not a tag} and #hashtag stay");
    expect(savedReplyText("<p>Hi {{ticket.requester.first_name}},</p><p>Reset it &amp; retry.</p>", "html")).toBe(
      "Hi,\n\nReset it & retry.",
    );
    expect(savedReplyText(null, "text")).toBe("");
  });
});

describe("paginate", () => {
  it("round-trips cursors and rejects garbage", () => {
    const c = encodeCursor({ page: 2 });
    const isPage = (v: unknown): v is { page: number } => typeof (v as { page?: unknown })?.page === "number";
    expect(decodeCursor(c, isPage)).toEqual({ page: 2 });
    expect(decodeCursor(null, isPage)).toBeNull();
    expect(() => decodeCursor("!!!", isPage)).toThrow(ConnectorError);
  });
  it("collects pages and parses Link headers", async () => {
    const items = await collectPages(1, async (p: number) => ({ items: [p], next: p < 3 ? p + 1 : null }));
    expect(items).toEqual([1, 2, 3]);
    expect(nextLink('<https://a/x?page=2>; rel="next", <https://a/x?page=9>; rel="last"')).toBe("https://a/x?page=2");
    expect(nextLink(null)).toBeNull();
    expect(nextLink('<https://a/t?include=requester,stats&page=3>; rel="next"')).toBe(
      "https://a/t?include=requester,stats&page=3",
    );
    expect(nextLink('<https://a/t?page=1>; rel="prev"')).toBeNull();
  });
});

describe("events", () => {
  const at = (s: string) => new Date(s);
  it("sorts, dedupes, drops no-ops, strips to engine events", () => {
    const evs: CanonicalEvent[] = [
      {
        type: "status_changed",
        status: "open",
        rawStatus: "open",
        at: at("2026-01-01T00:00:00Z"),
        idempotencyKey: "s1",
      },
      { type: "created", status: "open", priority: "high", at: at("2026-01-01T00:00:00Z"), idempotencyKey: "c" },
      {
        type: "comment",
        author: "agent",
        public: true,
        commentSourceId: "1",
        at: at("2026-01-01T01:00:00Z"),
        idempotencyKey: "m",
      },
      {
        type: "comment",
        author: "agent",
        public: true,
        commentSourceId: "1",
        at: at("2026-01-01T01:00:00Z"),
        idempotencyKey: "m",
      },
      { type: "tags_changed", tags: ["x"], at: at("2026-01-01T02:00:00Z"), idempotencyKey: "t" },
    ];
    const done = dropNoopChanges(finalizeEvents(evs));
    expect(done.map((e) => e.idempotencyKey)).toEqual(["c", "m", "t"]);
    expect(toEngineEvents(done)).toHaveLength(2);
  });
  it("derives the first public agent reply", () => {
    const c = (id: string, t: string, role: "agent" | "bot" | "requester", pub = true) => ({
      sourceId: id,
      at: at(t),
      authorRole: role,
      authorName: null,
      authorSourceId: null,
      public: pub,
      bodyText: "",
    });
    const comments = [
      c("1", "2026-01-01T03:00:00Z", "agent"),
      c("2", "2026-01-01T01:00:00Z", "bot"),
      c("3", "2026-01-01T02:00:00Z", "agent", false),
    ];
    expect(firstPublicAgentReply(comments)?.sourceId).toBe("1");
    expect(firstPublicAgentReply(comments, { botsCount: true })?.sourceId).toBe("2");
  });
});
