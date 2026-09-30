import { describe, expect, it } from "vitest";
import { helpDeskErrorByKind, userFacingError } from "../src/user-errors.js";

/** Nothing a support lead can't act on: HTTP lines, provider bodies, field names, enum codes. */
const JARGON =
  /→|https?:\/\/|\{|"error"|\bECONN|ENOTFOUND|zod|sandbox|e2b|provider_error|invalid_output|bound_exceeded|sandbox_error|model|token count|at_risk|first_response/i;

describe("userFacingError", () => {
  it("keeps null as null", () => {
    expect(userFacingError("agent_run", null)).toBeNull();
    expect(userFacingError("connection", "")).toBeNull();
  });

  it.each([
    [
      'GET https://acme.zendesk.com/api/v2/users/me.json → 401: {"error":"Couldn\'t authenticate you"}',
      /rejected slai's credentials/,
    ],
    ["Zammad: not authenticated", /rejected slai's credentials/],
    ["GET https://acme.freshdesk.com/api/v2/tickets → 429: rate limited", /limiting requests/],
    ["GET https://acme.example/api → 404", /couldn't find/],
    ["GET https://acme.example/api failed: getaddrinfo ENOTFOUND acme.example", /couldn't reach the help desk/],
    ["GET https://acme.example/api → 502: <html>Bad gateway</html>", /problem on its side/],
    ["something nobody anticipated at /src/x.ts:1", /Test the connection/],
  ])("maps a connection failure %#", (raw, expected) => {
    const msg = userFacingError("connection", raw);
    expect(msg).toMatch(expected);
    expect(msg).not.toMatch(JARGON);
  });

  it.each([
    ["autonomy is observe", /set to Observe/],
    ["spend cap reached: observe only", /spend cap/],
    ["plan allows observe only", /plan allows alerts only/],
    ["plan allows triage only", /triage only/],
    ["plan allows up to assist", /up to Assist/],
    ["provider_error: 529 overloaded_error from claude-haiku-4-5", /AI service didn't respond/],
    ['invalid_output: ZodError: [{"path":["summary"]}]', /didn't pass slai's checks/],
    ["bound_exceeded: wall time 120000ms exceeded", /time or credit limit/],
    ["sandbox_error: E2B sandbox sbx_123 failed to start", /couldn't start/],
    ["TypeError: Cannot read properties of undefined", /couldn't finish this run/],
  ])("maps an agent run failure %#", (raw, expected) => {
    const msg = userFacingError("agent_run", raw);
    expect(msg).toMatch(expected);
    expect(msg).not.toMatch(JARGON);
    expect(msg).not.toContain("claude");
  });

  it.each([
    ["unsupported file type application/zip", /Upload a PDF, DOCX, TXT or Markdown/],
    [
      "extracted policy is invalid: policies[0].targets[1].targetMs: expected number",
      /couldn't turn it into a valid policy/,
    ],
    ["invalid_output: missing citations", /couldn't read reliable SLA terms/],
    ["extraction failed: connect ECONNREFUSED 127.0.0.1:443", /couldn't read this contract/],
  ])("maps a contract failure %#", (raw, expected) => {
    const msg = userFacingError("contract", raw);
    expect(msg).toMatch(expected);
    expect(msg).not.toMatch(JARGON);
    expect(msg).not.toMatch(/policies\[/);
  });

  it("passes slai's own sentences through unchanged", () => {
    expect(userFacingError("knowledge_source", "The connection no longer exists.")).toBe(
      "The connection no longer exists.",
    );
    expect(userFacingError("knowledge_source", "Zendesk does not provide saved replies to slai yet.")).toBe(
      "Zendesk does not provide saved replies to slai yet.",
    );
    const sentence = helpDeskErrorByKind("auth");
    expect(userFacingError("connection", sentence)).toBe(sentence);
  });

  it("names every connector error kind in plain words", () => {
    for (const k of ["auth", "rate_limited", "not_found", "invalid", "upstream", "unsupported", "whatever"]) {
      expect(helpDeskErrorByKind(k)).not.toMatch(JARGON);
    }
  });
});
