import { describe, expect, it } from "vitest";
import { type AutopilotOptions, DEFAULT_MAX_BODY_CHARS, decideAutopilot } from "../src/guardrails.js";
import type { DraftReplyResult } from "../src/types.js";
import { okTriage, ticket } from "./helpers.js";

const ctx = ticket();
const good: DraftReplyResult = {
  body: "Hi Dana,\n\nCSV export fails above 50,000 rows. Apply a date filter and export in batches: https://help.brightline.example/articles/csv-export",
  internalNote: null,
  confidence: 0.9,
  usedKnowledge: [0],
  flags: { promisesTimeline: false, mentionsPricingOrRefund: false, legalOrSecurity: false, unsureOfFacts: false },
};
const opts: AutopilotOptions = { minConfidence: 0.8, triage: okTriage, ctx };
const decide = (d: Partial<DraftReplyResult>, o: Partial<AutopilotOptions> = {}) =>
  decideAutopilot({ ...good, ...d }, { ...opts, ...o });

describe("decideAutopilot", () => {
  it("sends a clean, confident, grounded draft", () => {
    expect(decide({})).toEqual({ send: true, reason: "all guardrails passed" });
  });

  describe("flags", () => {
    const labels = {
      promisesTimeline: "promises a timeline",
      mentionsPricingOrRefund: "mentions pricing or a refund",
      legalOrSecurity: "touches a legal or security topic",
      unsureOfFacts: "is unsure of the facts",
    } as const;
    for (const flag of Object.keys(labels) as (keyof typeof labels)[]) {
      it(`refuses when ${flag} is set, whatever the confidence, in plain words`, () => {
        const d = decide({ confidence: 1, flags: { ...good.flags, [flag]: true } });
        expect(d.send).toBe(false);
        expect(d.reason).toContain(labels[flag]);
        expect(d.reason).not.toContain(flag);
      });
    }
    it("lists every raised flag", () => {
      const d = decide({
        flags: { promisesTimeline: true, mentionsPricingOrRefund: true, legalOrSecurity: false, unsureOfFacts: true },
      });
      expect(d.reason).toBe("draft flagged: promises a timeline, mentions pricing or a refund, is unsure of the facts");
    });
    it("treats a missing (non-false) flag as raised", () => {
      const flags = { ...good.flags } as Record<string, boolean | undefined>;
      flags.legalOrSecurity = undefined;
      expect(decide({ flags: flags as DraftReplyResult["flags"] }).send).toBe(false);
    });
  });

  describe("confidence", () => {
    it("refuses below the minimum", () => {
      expect(decide({ confidence: 0.79 })).toEqual({ send: false, reason: "confidence 79% is below the 80% minimum" });
    });
    it("accepts exactly the minimum", () => {
      expect(decide({ confidence: 0.8 }).send).toBe(true);
    });
    it("refuses NaN confidence and a NaN threshold", () => {
      expect(decide({ confidence: Number.NaN }).send).toBe(false);
      expect(decide({}, { minConfidence: Number.NaN }).send).toBe(false);
    });
  });

  describe("triage", () => {
    it("refuses when triage says a human is needed", () => {
      const d = decide({}, { triage: { ...okTriage, needsHuman: true, needsHumanReason: "Refund request." } });
      expect(d).toEqual({ send: false, reason: "triage says a person should handle this: Refund request." });
    });
    it("refuses without triage", () => {
      expect(decide({}, { triage: null })).toEqual({ send: false, reason: "the ticket hasn't been triaged yet" });
    });
  });

  describe("body", () => {
    it("refuses an empty or whitespace-only body", () => {
      expect(decide({ body: "" })).toEqual({ send: false, reason: "the draft is empty" });
      expect(decide({ body: " \n\t " })).toEqual({ send: false, reason: "the draft is empty" });
    });
    it("refuses an overlong body, with a configurable limit", () => {
      expect(decide({ body: "a".repeat(DEFAULT_MAX_BODY_CHARS) }).send).toBe(true);
      expect(decide({ body: "a".repeat(DEFAULT_MAX_BODY_CHARS + 1) }).reason).toMatch(/too long to send automatically/);
      expect(decide({ body: "hello there" }, { maxBodyChars: 5 }).send).toBe(false);
    });
  });

  describe("URLs", () => {
    it("allows URLs from knowledge, ignoring scheme, www, case and trailing punctuation", () => {
      expect(decide({ body: "See HTTPS://www.help.brightline.example/articles/csv-export/." }).send).toBe(true);
    });
    it("allows URLs that appear in the thread", () => {
      const withLink = ticket({
        thread: [{ ...ctx.thread[0]!, body: "Screenshot at https://files.acme.example/s/123" }],
      });
      expect(decide({ body: "Thanks for https://files.acme.example/s/123" }, { ctx: withLink }).send).toBe(true);
    });
    it("refuses URLs that are not in the thread or knowledge", () => {
      for (const body of [
        "Reset it here: https://brightline-login.example/reset",
        "Go to www.evil.example now",
        "See https://help.brightline.example/articles/csv-export-v2",
        "Plain http://help.brightline.example.attacker.example/articles/csv-export",
      ]) {
        const d = decide({ body });
        expect(d.send, body).toBe(false);
        expect(d.reason).toMatch(/URL that isn't in the ticket or your knowledge/);
      }
    });
    it("refuses email addresses not in the thread or knowledge", () => {
      expect(decide({ body: "Write to billing-help@evil.example" }).send).toBe(false);
    });
  });

  describe("secrets and PII", () => {
    const cases: [string, string][] = [
      ["API key", "Use key sk-ant-api03-abcdefghijklmnopqrstuvwx"],
      ["API key", "Use key sk-proj-ABCDEFGHIJKLMNOPQRSTUV"],
      ["API key", "AWS key AKIAIOSFODNN7EXAMPLE"],
      ["API key", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["API key", "slack xoxb-1234567890-abcdefghij"],
      ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"],
      ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop"],
      ["password", "Your temporary password: Tr0ub4dor&3"],
      ["bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"],
      ["US SSN", "SSN on file 123-45-6789"],
      ["payment card number", "Card 4111 1111 1111 1111 was declined"],
      ["IBAN", "Pay to GB82 WEST 1234 5698 7654 32"],
    ];
    for (const [name, body] of cases) {
      it(`refuses a ${name}: ${body.slice(0, 24)}`, () => {
        const d = decide({ body });
        expect(d.send).toBe(false);
        expect(d.reason).toBe(`the draft contains what looks like a ${name}`);
      });
    }
    it("refuses a secret even when the customer pasted it into the thread", () => {
      const pasted = ticket({ thread: [{ ...ctx.thread[0]!, body: "my password: hunter2hunter2" }] });
      expect(decide({ body: "We saw your password: hunter2hunter2" }, { ctx: pasted }).send).toBe(false);
    });
    it("does not mistake ordinary numbers for card numbers", () => {
      expect(decide({ body: "Your order 1234 5678 9012 3456 shipped." }).send).toBe(true); // fails Luhn
      expect(decide({ body: "Exports over 50,000 rows fail." }).send).toBe(true);
    });
  });

  it("checks in a fixed order: body, flags, confidence, triage, URLs, secrets", () => {
    const everythingWrong = decide(
      { body: "", confidence: 0, flags: { ...good.flags, unsureOfFacts: true } },
      { triage: { ...okTriage, needsHuman: true } },
    );
    expect(everythingWrong.reason).toBe("the draft is empty");
    expect(decide({ confidence: 0, flags: { ...good.flags, unsureOfFacts: true } }).reason).toMatch(/^draft flagged/);
  });

  it("is pure: same input, same decision, inputs untouched", () => {
    const d = structuredClone(good);
    const a = decideAutopilot(d, opts);
    const b = decideAutopilot(d, opts);
    expect(a).toEqual(b);
    expect(d).toEqual(good);
  });
});
