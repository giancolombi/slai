import { describe, expect, it } from "vitest";
import { deciderLabel, personLabel } from "../src/lib/people";

describe("personLabel", () => {
  it("shows the name the API sent", () => {
    expect(personLabel("01a0efeb-7858-78ed-8cd9-149c4686d54c", "Demo Admin")).toBe("Demo Admin");
  });
  it("names a deleted user generically, and nobody as null", () => {
    expect(personLabel("11111111-2222-4333-8444-555555555555", null)).toBe("A former member");
    expect(personLabel(null, null)).toBeNull();
  });
});

describe("deciderLabel", () => {
  const base = { decidedBy: null, decidedByName: null, decidedAt: null, kind: "public_reply" as const };
  it("prefers the person", () => {
    expect(deciderLabel({ ...base, decidedBy: "u1", decidedByName: "Maya", decidedAt: "2026-01-01T00:00:00Z" })).toBe(
      "Maya",
    );
  });
  it("credits slai when nobody decided", () => {
    expect(deciderLabel({ ...base, decidedAt: "2026-01-01T00:00:00Z" })).toBe("Autopilot");
    expect(deciderLabel({ ...base, kind: "internal_note", decidedAt: "2026-01-01T00:00:00Z" })).toBe("slai");
    expect(deciderLabel(base)).toBeNull();
  });
});
