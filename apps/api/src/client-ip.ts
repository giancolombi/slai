/**
 * Client IP behind reverse proxies (T-63). X-Forwarded-For is a list each proxy
 * appends to, so only its right end is trustworthy: the client is the first
 * address, counted from the right, that is not one of our proxies. The left end
 * is whatever the client sent and must never be believed.
 *
 * TRUST_PROXY:
 *   false        ignore X-Forwarded-For; use the socket address (default)
 *   true | 1..n  that many proxies in front of the API (true = 1)
 *   CIDR list    trust hops whose address is in these ranges, e.g. 10.0.0.0/8,fd00::/8
 */
import { BlockList, isIP } from "node:net";

export type TrustProxy = boolean | number | string[];

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = (raw ?? "").trim();
  if (v === "" || v === "false" || v === "0") return false;
  if (v === "true") return 1;
  if (/^\d+$/.test(v)) return Number(v);
  const ranges = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const r of ranges) {
    const [addr, bits] = r.split("/");
    if (!addr || !isIP(addr) || (bits !== undefined && !/^\d{1,3}$/.test(bits))) {
      throw new Error(`TRUST_PROXY: "${r}" is not an IP address or CIDR range`);
    }
  }
  return ranges;
}

function blockList(ranges: string[]): BlockList {
  const list = new BlockList();
  for (const r of ranges) {
    const [addr, bits] = r.split("/") as [string, string | undefined];
    const type = isIP(addr) === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(bits), type);
  }
  return list;
}

const lists = new WeakMap<string[], BlockList>();

const clean = (s: string) => s.trim().replace(/^::ffff:/, "");

/** The client address, given the socket peer and the X-Forwarded-For header. */
export function clientIp(xff: string | undefined, remote: string | null, trust: TrustProxy): string | null {
  if (trust === false || trust === 0 || !xff) return remote;
  const chain = [
    ...xff
      .split(",")
      .map(clean)
      .filter((s) => isIP(s) !== 0),
    remote === null ? null : clean(remote),
  ];
  if (typeof trust === "number" || trust === true) {
    const hops = trust === true ? 1 : trust;
    return chain[Math.max(0, chain.length - 1 - hops)] ?? remote;
  }
  let list = lists.get(trust);
  if (!list) {
    list = blockList(trust);
    lists.set(trust, list);
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const a = chain[i];
    if (a === null || a === undefined) continue;
    if (!list.check(a, isIP(a) === 6 ? "ipv6" : "ipv4")) return a;
  }
  return chain[0] ?? remote;
}
