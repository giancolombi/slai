import { describe, expect, it } from "vitest";
import { clientIp, parseTrustProxy } from "../src/client-ip.js";

describe("trusted proxy client IP", () => {
  it("ignores X-Forwarded-For unless a proxy is trusted", () => {
    expect(clientIp("6.6.6.6", "10.0.0.5", false)).toBe("10.0.0.5");
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("counts hops from the right, so a spoofed left entry is not believed", () => {
    // Client 203.0.113.9 sends a forged header; our one load balancer appends the real peer.
    expect(clientIp("6.6.6.6, 203.0.113.9", "10.0.0.5", 1)).toBe("203.0.113.9");
    expect(clientIp("6.6.6.6, 203.0.113.9, 10.1.1.1", "10.0.0.5", 2)).toBe("203.0.113.9");
    expect(clientIp("203.0.113.9", "10.0.0.5", true)).toBe("203.0.113.9");
    expect(parseTrustProxy("true")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
    // More hops than entries: the leftmost entry is the best we have.
    expect(clientIp("203.0.113.9", "10.0.0.5", 5)).toBe("203.0.113.9");
  });

  it("with CIDR ranges, returns the first untrusted address from the right", () => {
    const trust = parseTrustProxy("10.0.0.0/8, fd00::/8");
    expect(clientIp("6.6.6.6, 203.0.113.9, 10.2.3.4", "10.0.0.5", trust)).toBe("203.0.113.9");
    expect(clientIp("2001:db8::1, fd00::1", "fd00::2", trust)).toBe("2001:db8::1");
    // Peer not in the trusted ranges: the header is not believed at all.
    expect(clientIp("6.6.6.6", "198.51.100.7", trust)).toBe("198.51.100.7");
    expect(clientIp("203.0.113.9", "::ffff:10.0.0.5", trust)).toBe("203.0.113.9");
  });

  it("drops garbage entries and rejects a malformed setting", () => {
    expect(clientIp("not-an-ip, 203.0.113.9", "10.0.0.5", 1)).toBe("203.0.113.9");
    expect(() => parseTrustProxy("10.0.0.0/8,banana")).toThrow(/TRUST_PROXY/);
  });
});
