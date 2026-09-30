import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateSecret, hotp, totp, verifyTotp } from "../src/totp.js";

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 Appendix B, SHA1, 8 digits, secret "12345678901234567890".
  const key = Buffer.from("12345678901234567890");
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ])("matches the RFC vector at T=%i", (t, code) => {
    expect(hotp(key, Math.floor(t / 30), 8)).toBe(code);
  });

  it("base32 round-trips", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
  });

  it("accepts ±1 step and rejects replays and garbage", () => {
    const secret = generateSecret();
    const at = new Date("2026-09-29T12:00:00Z");
    const step = verifyTotp(secret, totp(secret, at), at, null);
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - 30_000)), at, null)).toBe(step! - 1);
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - 90_000)), at, null)).toBeNull();
    expect(verifyTotp(secret, totp(secret, at), at, step)).toBeNull();
    expect(verifyTotp(secret, "12345", at, null)).toBeNull();
  });
});
