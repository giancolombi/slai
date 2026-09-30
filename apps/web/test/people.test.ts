import { describe, expect, it } from "vitest";
import { resolvePerson } from "../src/lib/people";

const members = [{ userId: "01a0efeb-7858-78ed-8cd9-149c4686d54c", name: "Demo Admin" }];

describe("resolvePerson", () => {
  it("maps a member id to their name", () => {
    expect(resolvePerson("01a0efeb-7858-78ed-8cd9-149c4686d54c", members)).toBe("Demo Admin");
  });
  it("keeps display names as they are", () => {
    expect(resolvePerson("Maya Okafor", members)).toBe("Maya Okafor");
  });
  it("never shows a raw unknown id", () => {
    expect(resolvePerson("11111111-2222-4333-8444-555555555555", members)).toBe("A former member");
  });
  it("handles autopilot and empty values", () => {
    expect(resolvePerson("autopilot")).toBe("Autopilot");
    expect(resolvePerson(null)).toBeNull();
  });
});
