import { describe, expect, it } from "vitest";
import { isDatabaseSaturated } from "../src/db-errors.js";

describe("isDatabaseSaturated", () => {
  it("recognizes connection exhaustion by SQLSTATE and by message", () => {
    expect(isDatabaseSaturated({ code: "53300", message: "x" })).toBe(true);
    expect(isDatabaseSaturated({ code: "57P03", message: "the database system is starting up" })).toBe(true);
    expect(isDatabaseSaturated({ code: "CONNECT_TIMEOUT" })).toBe(true);
    expect(
      isDatabaseSaturated(new Error("remaining connection slots are reserved for roles with the SUPERUSER attribute")),
    ).toBe(true);
  });

  it("does not treat ordinary errors as saturation", () => {
    expect(isDatabaseSaturated({ code: "23505", message: "duplicate key value" })).toBe(false);
    expect(isDatabaseSaturated(new Error("boom"))).toBe(false);
    expect(isDatabaseSaturated(null)).toBe(false);
  });
});
