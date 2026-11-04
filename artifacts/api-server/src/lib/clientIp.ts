/**
 * Who is calling: the client address behind the deployment's proxy
 * (sec/public-surface, 2026-11-04).
 *
 * BEFORE THIS FILE Express's `trust proxy` was unset, so `req.ip` was the socket
 * peer. On the Replit Autoscale deployment that peer is the platform's own
 * front end, the same address for every caller, so every per-IP limiter in the
 * tree (routes/auth.ts sign-up and lookup-username, routes/crashReport.ts, the
 * Google autocomplete budget in routes/places.ts) was ONE bucket shared by every
 * user of an instance: five sign-ups an hour per instance, for everybody.
 *
 * THE RULE: trust a hop by WHERE IT CONNECTS FROM, never by how many there are.
 * X-Forwarded-For is a list the client is allowed to START. Whatever it sends
 * comes first, and each proxy appends the address its connection came from, so
 * only entries a trusted proxy appended are facts. Express (proxy-addr) walks
 * the chain from the right, the socket peer first and then X-Forwarded-For
 * right to left, and `req.ip` is the first address it does NOT trust. The
 * default list therefore names only addresses no internet client can connect
 * from: loopback; link-local (169.254.0.0/16, where Cloud Run's front end, which
 * Autoscale runs on, connects from); the private ranges (10/8, 172.16/12,
 * 192.168/16, fc00::/7); carrier-grade NAT space (100.64.0.0/10); and Google's
 * documented front-end source ranges (35.191.0.0/16, 130.211.0.0/22). A caller
 * cannot get its own address trusted: the first proxy appends the address the
 * TCP connection really came from, and a forged entry to the left of it is never
 * reached.
 *
 * A hop COUNT (`trust proxy = N`) was not used. Replit does not document how
 * many proxies sit in front of an Autoscale deployment, it was not measured
 * here, and a wrong count fails badly either way: one too few and every request
 * carries the proxy's address (one shared bucket), one too many and the client
 * picks its own address.
 *
 * NOT MEASURED: if the chain contains a proxy with a PUBLIC address that appends
 * itself (Google's external Application Load Balancer appends its own
 * forwarding-rule IP after the client's), the walk stops on that address and
 * every caller behind it shares one bucket. lib/publicRateLimit.ts logs the
 * SHAPE of the first chains each process sees (`client_ip_chain`: entry count
 * and classification, never an address) so an operator can tell; the remedy is
 * TRUST_PROXY with that address added.
 *
 * TRUST_PROXY overrides the default: a hop count, or a comma-separated list of
 * addresses, CIDRs and the names loopback / linklocal / uniquelocal (Express's
 * own syntax; a list REPLACES the default, so restate what you keep). "false"
 * or "0" trusts nothing (req.ip is the socket peer, the old behaviour). "true"
 * is REFUSED and the default used instead, with a warning: it trusts every hop,
 * so req.ip becomes whatever the caller wrote first.
 */
import { BlockList, isIP } from "node:net";
import { logger } from "./logger.js";

/** The default trusted-proxy list (see the header for why each range is safe to trust). */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = [
  "loopback",
  "linklocal",
  "uniquelocal",
  "100.64.0.0/10",
  "35.191.0.0/16",
  "130.211.0.0/22",
];

export interface TrustProxySetting {
  /** The value for `app.set("trust proxy", …)`. */
  value: number | boolean | string[];
  /** Set when TRUST_PROXY was given and could not be used as written. */
  warning?: string;
}

/** Turn TRUST_PROXY into Express's `trust proxy` value. Unset or blank → DEFAULT_TRUSTED_PROXIES. */
export function resolveTrustProxy(raw: string | undefined): TrustProxySetting {
  const v = (raw ?? "").trim();
  if (!v) return { value: [...DEFAULT_TRUSTED_PROXIES] };
  const lower = v.toLowerCase();
  if (lower === "false" || lower === "0") return { value: false };
  if (lower === "true") {
    return {
      value: [...DEFAULT_TRUSTED_PROXIES],
      warning:
        "TRUST_PROXY=true refused: it trusts every hop, so req.ip would be whatever the caller wrote first in " +
        "X-Forwarded-For. Using the default trusted-proxy list instead (lib/clientIp.ts).",
    };
  }
  if (/^\d+$/.test(v)) return { value: Number(v) };
  return { value: v.split(",").map((s) => s.trim()).filter(Boolean) };
}

/** app.ts's `trust proxy` value, from TRUST_PROXY; a refused value is logged and the default used. */
export function trustProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: { warn: (obj: object, msg: string) => void } = logger,
): TrustProxySetting["value"] {
  const setting = resolveTrustProxy(env["TRUST_PROXY"]);
  if (setting.warning) log.warn({ event: "trust_proxy_refused" }, setting.warning);
  return setting.value;
}

// ── Is this an address an internet client could have? ────────────────────────

const NON_PUBLIC = new BlockList();
NON_PUBLIC.addSubnet("0.0.0.0", 8, "ipv4");
NON_PUBLIC.addSubnet("10.0.0.0", 8, "ipv4");
NON_PUBLIC.addSubnet("100.64.0.0", 10, "ipv4");
NON_PUBLIC.addSubnet("127.0.0.0", 8, "ipv4");
NON_PUBLIC.addSubnet("169.254.0.0", 16, "ipv4");
NON_PUBLIC.addSubnet("172.16.0.0", 12, "ipv4");
NON_PUBLIC.addSubnet("192.168.0.0", 16, "ipv4");
NON_PUBLIC.addAddress("::", "ipv6");
NON_PUBLIC.addAddress("::1", "ipv6");
NON_PUBLIC.addSubnet("fc00::", 7, "ipv6");
NON_PUBLIC.addSubnet("fe80::", 10, "ipv6");

/** "::ffff:203.0.113.5" → "203.0.113.5"; anything else unchanged. */
function unmapIpv4(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1] : ip;
}

/**
 * True when `ip` could be an internet client's address. Loopback, private,
 * link-local, CGNAT and unspecified addresses are not; neither is anything that
 * does not parse as an address.
 */
export function isPublicAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const addr = unmapIpv4(ip.trim());
  const family = isIP(addr);
  if (family === 0) return false;
  return !NON_PUBLIC.check(addr, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The rate-limit key for a client address: IPv4 as is (mapped form unwrapped),
 * IPv6 reduced to its /56 prefix. One IPv6 customer is usually handed a whole
 * /56 or /48, so keying on the full address would let a caller rotate through
 * addresses it legitimately owns; /56 is express-rate-limit's own default
 * (`ipv6Subnet`), which the auth limiters already use.
 */
export function clientAddressKey(ip: string): string {
  const addr = unmapIpv4(ip.trim());
  if (isIP(addr) !== 6) return addr;
  const groups = expandIpv6(addr);
  // 56 bits = the first three groups and the high byte of the fourth.
  return `${groups.slice(0, 3).join(":")}:${groups[3].slice(0, 2)}00::/56`;
}

/** Eight 4-digit lowercase hex groups. Assumes `addr` already passed isIP() === 6. */
function expandIpv6(addr: string): string[] {
  let a = addr.toLowerCase().split("%")[0];
  // An embedded IPv4 tail ("::ffff:1.2.3.4", "64:ff9b::1.2.3.4") becomes two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [b1, b2, b3, b4] = v4.slice(1).map(Number);
    a = a.slice(0, v4.index) + `${((b1 << 8) | b2).toString(16)}:${((b3 << 8) | b4).toString(16)}`;
  }
  const [head, tail] = a.includes("::") ? a.split("::") : [a, undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((g) => g.padStart(4, "0"));
}

/**
 * The SHAPE of a request's address chain, for the operator log: how many
 * X-Forwarded-For entries there were and which kind each is (public or not),
 * plus where req.ip landed. No address is ever returned.
 */
export function describeAddressChain(xff: string | undefined, socketAddress: string | undefined, derived: string | undefined): {
  xffEntries: number;
  kinds: Array<"public" | "non_public" | "invalid">;
  socketPublic: boolean;
  derivedFrom: "socket" | "xff" | "unknown";
  /** X-Forwarded-For entries LEFT of the one req.ip came from: client-written, or a proxy not yet trusted. */
  entriesLeftOfClient: number;
} {
  const entries = (xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const kinds = entries.map((e) => (isIP(unmapIpv4(e)) === 0 ? "invalid" : isPublicAddress(e) ? "public" : "non_public")) as Array<
    "public" | "non_public" | "invalid"
  >;
  const d = derived ? unmapIpv4(derived) : undefined;
  let idx = -1;
  if (d) for (let i = entries.length - 1; i >= 0; i--) if (unmapIpv4(entries[i]) === d) { idx = i; break; }
  const socket = socketAddress ? unmapIpv4(socketAddress) : undefined;
  return {
    xffEntries: entries.length,
    kinds,
    socketPublic: isPublicAddress(socketAddress),
    derivedFrom: idx >= 0 ? "xff" : d !== undefined && d === socket ? "socket" : "unknown",
    entriesLeftOfClient: idx >= 0 ? idx : 0,
  };
}
