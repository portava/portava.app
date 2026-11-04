/**
 * The app-level per-IP limiter (lib/publicRateLimit.ts) and the client address
 * it counts (lib/clientIp.ts) — sec/public-surface, 2026-11-04.
 *
 * Proves, against a real HTTP server:
 *   - it counts per client address, and a second address has its own budget;
 *   - a refusal is 429 `rate_limited` in the flat envelope, with Retry-After;
 *   - health checks are never counted;
 *   - the address is the one the TRUSTED proxy appended: a forged entry to its
 *     left buys nothing, and X-Forwarded-For from an untrusted hop is ignored;
 *   - bearer and unauthenticated-write traffic draw on their own budgets, 0
 *     switches a tier off, IPv6 is counted per /56, a non-public address is
 *     not counted, and expired buckets are swept;
 *   - in the REAL app.ts: `trust proxy` is the default list, the limiter covers
 *     the share/association surface, and the provider webhooks and /api/healthz
 *     are never limited.
 *
 * Run: node --import tsx/esm --test src/test/publicRateLimit.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _resetRateLimit, checkRateLimit, sweepRateLimitBuckets } from "../lib/rateLimit.js";
import {
  DEFAULT_TRUSTED_PROXIES,
  clientAddressKey,
  isPublicAddress,
  resolveTrustProxy,
  trustProxyFromEnv,
} from "../lib/clientIp.js";
import {
  DEFAULT_PUBLIC_RATE_LIMIT_BUDGETS,
  PUBLIC_RATE_LIMIT_IDS,
  PUBLIC_RATE_LIMIT_WINDOW_MS,
  _resetPublicRateLimitState,
  isRateLimitExemptPath,
  publicRateLimit,
  publicRateLimitBudgets,
  type PublicRateLimitBudgets,
} from "../lib/publicRateLimit.js";

// ── HTTP helper: node:http, so X-Forwarded-For is sent exactly as written ─────

interface Reply { status: number; body: any; headers: http.IncomingHttpHeaders }

function request(server: http.Server, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as { port: number };
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let body: any = raw;
        try { body = JSON.parse(raw); } catch { /* keep text */ }
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const from = (xff: string, extra: Record<string, string> = {}) => ({ "x-forwarded-for": xff, ...extra });

function listen(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

/** A minimal app shaped like app.ts: trust proxy, the limiter, then routes. */
function miniApp(budgets: Partial<PublicRateLimitBudgets>, trust: unknown = [...DEFAULT_TRUSTED_PROXIES]): express.Express {
  const app = express();
  app.set("trust proxy", trust);
  app.use(publicRateLimit({ ...DEFAULT_PUBLIC_RATE_LIMIT_BUDGETS, ...budgets }));
  app.get("/api/healthz", (_req, res) => { res.json({ status: "ok" }); });
  app.get("/api/healthz/schedulers", (_req, res) => { res.json({ ok: true }); });
  app.get("/healthz/deep", (_req, res) => { res.json({ ok: true }); });
  app.get("/u/:username", (req, res) => { res.json({ ip: req.ip }); });
  app.post("/api/auth/lookup-username", (req, res) => { res.json({ ip: req.ip }); });
  return app;
}

beforeEach(() => {
  _resetRateLimit();
  _resetPublicRateLimitState();
});

// ── The address ───────────────────────────────────────────────────────────────

describe("lib/clientIp.ts — which address is the client's", () => {
  it("TRUST_PROXY: unset → the default list; a count, false, a list as written; true refused", () => {
    assert.deepEqual(resolveTrustProxy(undefined).value, [...DEFAULT_TRUSTED_PROXIES]);
    assert.deepEqual(resolveTrustProxy("  ").value, [...DEFAULT_TRUSTED_PROXIES]);
    assert.equal(resolveTrustProxy("2").value, 2);
    assert.equal(resolveTrustProxy("false").value, false);
    assert.equal(resolveTrustProxy("0").value, false);
    assert.deepEqual(resolveTrustProxy("loopback, 34.1.2.3").value, ["loopback", "34.1.2.3"]);
    const t = resolveTrustProxy("true");
    assert.deepEqual(t.value, [...DEFAULT_TRUSTED_PROXIES], "trusting every hop lets the caller pick its address");
    assert.match(String(t.warning), /refused/);
    const warned: string[] = [];
    assert.deepEqual(trustProxyFromEnv({ TRUST_PROXY: "TRUE" }, { warn: (_o, m) => warned.push(m) }), [...DEFAULT_TRUSTED_PROXIES]);
    assert.equal(warned.length, 1);
  });

  it("isPublicAddress: loopback, private, link-local, CGNAT and garbage are not; internet addresses are", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.2.3.4", "172.20.0.1", "192.168.1.1", "169.254.169.126",
      "100.64.0.1", "fd00::1", "fe80::1", "0.0.0.0", "::", "not-an-ip", "", undefined]) {
      assert.equal(isPublicAddress(ip as string), false, String(ip));
    }
    for (const ip of ["203.0.113.7", "::ffff:203.0.113.7", "8.8.8.8", "35.191.0.1", "2001:db8::1", "2a00:1450:4001::1"]) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
  });

  it("clientAddressKey: IPv4 as is (mapped form unwrapped), IPv6 by /56", () => {
    assert.equal(clientAddressKey("203.0.113.7"), "203.0.113.7");
    assert.equal(clientAddressKey("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(clientAddressKey("2001:db8:1:2ff::1"), clientAddressKey("2001:db8:1:200:abcd::9"));
    assert.notEqual(clientAddressKey("2001:db8:1:200::1"), clientAddressKey("2001:db8:1:300::1"));
    assert.equal(clientAddressKey("2001:db8::1"), "2001:0db8:0000:0000::/56");
  });
});

describe("behind the proxy — the address the trusted hop appended is the key", () => {
  let server: http.Server;
  before(async () => { server = await listen(miniApp({ readPerMin: 2 })); });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it("req.ip is the rightmost untrusted entry: private and Google front-end hops are peeled", async () => {
    assert.equal((await request(server, "GET", "/u/a", from("198.51.100.4"))).body.ip, "198.51.100.4");
    assert.equal((await request(server, "GET", "/u/a", from("198.51.100.5, 10.1.2.3"))).body.ip, "198.51.100.5");
    assert.equal((await request(server, "GET", "/u/a", from("198.51.100.6, 35.191.10.10, 169.254.1.1"))).body.ip, "198.51.100.6");
  });

  it("a forged entry to the LEFT of the real client buys no budget", async () => {
    const forged = ["1.1.1.1", "9.9.9.9", "8.8.4.4"];
    const results = [];
    for (const f of forged) results.push(await request(server, "GET", "/u/a", from(`${f}, 203.0.113.50`)));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 429], "three requests from one client, whatever it wrote first");
    assert.ok(results.slice(0, 2).every((r) => r.body.ip === "203.0.113.50"));
  });
});

describe("X-Forwarded-For from a hop that is NOT trusted is ignored", () => {
  let server: http.Server;
  // Trust only 10/8: the test socket (127.0.0.1) is then an untrusted hop, so its header is not believed.
  before(async () => { server = await listen(miniApp({ readPerMin: 1 }, ["10.0.0.0/8"])); });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it("req.ip is the socket peer, not the header", async () => {
    const r = await request(server, "GET", "/u/a", from("203.0.113.9"));
    assert.equal(r.body.ip, "127.0.0.1");
  });
});

// ── Counting and the refusal ──────────────────────────────────────────────────

describe("lib/publicRateLimit.ts — counting", () => {
  let server: http.Server;
  before(async () => { server = await listen(miniApp({ readPerMin: 3, writePerMin: 1, bearerPerMin: 5 })); });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it("counts per address: the 4th GET from one address is refused, another address still passes", async () => {
    const a = [];
    for (let i = 0; i < 4; i++) a.push((await request(server, "GET", "/u/someone", from("203.0.113.1"))).status);
    assert.deepEqual(a, [200, 200, 200, 429]);
    assert.equal((await request(server, "GET", "/u/someone", from("203.0.113.2"))).status, 200);
  });

  it("the refusal: 429, Retry-After in whole seconds within the window, flat `rate_limited` envelope", async () => {
    for (let i = 0; i < 3; i++) await request(server, "GET", "/u/x", from("203.0.113.3"));
    const r = await request(server, "GET", "/u/x", from("203.0.113.3"));
    assert.equal(r.status, 429);
    const retry = Number(r.headers["retry-after"]);
    assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= PUBLIC_RATE_LIMIT_WINDOW_MS / 1000, String(r.headers["retry-after"]));
    assert.equal(r.body.error, "rate_limited");
    assert.equal(typeof r.body.message, "string");
  });

  it("health checks are never counted, even from an exhausted address", async () => {
    for (let i = 0; i < 4; i++) await request(server, "GET", "/u/x", from("203.0.113.4"));
    for (let i = 0; i < 20; i++) {
      for (const p of ["/api/healthz", "/api/healthz/schedulers", "/healthz/deep"]) {
        assert.equal((await request(server, "GET", p, from("203.0.113.4"))).status, 200, p);
      }
    }
    assert.equal(isRateLimitExemptPath("/api/healthz"), true);
    assert.equal(isRateLimitExemptPath("/healthz"), true);
    assert.equal(isRateLimitExemptPath("/api/healthzz"), false, "a prefix lookalike is counted");
    assert.equal(isRateLimitExemptPath("/api/feature-flags"), false);
  });

  it("unauthenticated writes have their own, tighter budget", async () => {
    const ip = "203.0.113.5";
    assert.equal((await request(server, "POST", "/api/auth/lookup-username", from(ip))).status, 200);
    assert.equal((await request(server, "POST", "/api/auth/lookup-username", from(ip))).status, 429);
    assert.equal((await request(server, "GET", "/u/x", from(ip))).status, 200, "reads are a separate budget");
  });

  it("bearer requests are counted too, under their own larger budget — a junk token does not escape", async () => {
    const ip = "203.0.113.6";
    const bearer = (n: number) => from(ip, { authorization: `Bearer junk-${n}` });
    const got = [];
    for (let i = 0; i < 6; i++) got.push((await request(server, "GET", "/u/x", bearer(i))).status);
    assert.deepEqual(got, [200, 200, 200, 200, 200, 429]);
    // `Authorization: Bearer ` with nothing after it is not a token: the anonymous budget applies.
    for (let i = 0; i < 3; i++) await request(server, "GET", "/u/x", from("203.0.113.7", { authorization: "Bearer " }));
    assert.equal((await request(server, "GET", "/u/x", from("203.0.113.7", { authorization: "Bearer " }))).status, 429);
  });

  it("IPv6 is counted per /56", async () => {
    for (let i = 0; i < 3; i++) await request(server, "GET", "/u/x", from(`2001:db8:5:${(0x200 + i).toString(16)}::1`));
    assert.equal((await request(server, "GET", "/u/x", from("2001:db8:5:2aa::7"))).status, 429, "same /56");
    assert.equal((await request(server, "GET", "/u/x", from("2001:db8:5:300::1"))).status, 200, "another /56");
  });

  it("a non-public client address is not counted (an internal caller; one shared bucket otherwise)", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await request(server, "GET", "/u/x")).status, 200, "loopback, no header");
    for (let i = 0; i < 10; i++) assert.equal((await request(server, "GET", "/u/x", from("10.9.8.7"))).status, 200);
  });
});

describe("budgets", () => {
  it("from the environment: blank → default, whole number → itself, 0 → off, garbage → default", () => {
    assert.deepEqual(publicRateLimitBudgets({}), DEFAULT_PUBLIC_RATE_LIMIT_BUDGETS);
    assert.deepEqual(
      publicRateLimitBudgets({ PUBLIC_RATE_LIMIT_READ_PER_MIN: "1200", PUBLIC_RATE_LIMIT_WRITE_PER_MIN: "0", PUBLIC_RATE_LIMIT_BEARER_PER_MIN: "lots" }),
      { readPerMin: 1200, writePerMin: 0, bearerPerMin: DEFAULT_PUBLIC_RATE_LIMIT_BUDGETS.bearerPerMin },
    );
  });

  it("the defaults are generous: hundreds of reads a minute, a tighter write budget, a larger bearer ceiling", () => {
    const d = DEFAULT_PUBLIC_RATE_LIMIT_BUDGETS;
    assert.ok(d.readPerMin >= 300, "a busy share page or the landing page must never reach it");
    assert.ok(d.writePerMin < d.readPerMin);
    assert.ok(d.bearerPerMin > d.readPerMin);
  });

  it("0 switches a tier off", async () => {
    const server = await listen(miniApp({ readPerMin: 0, writePerMin: 1 }));
    try {
      for (let i = 0; i < 10; i++) assert.equal((await request(server, "GET", "/u/x", from("203.0.113.8"))).status, 200);
      await request(server, "POST", "/api/auth/lookup-username", from("203.0.113.8"));
      assert.equal((await request(server, "POST", "/api/auth/lookup-username", from("203.0.113.8"))).status, 429, "the other tiers still count");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("expired per-address buckets are swept (an internet caller can mint addresses without limit)", () => {
    const t0 = Date.now();
    checkRateLimit(PUBLIC_RATE_LIMIT_IDS.read, "203.0.113.90", 10, PUBLIC_RATE_LIMIT_WINDOW_MS);
    checkRateLimit("report", "some-user", 10, 60 * 60 * 1000);
    assert.equal(sweepRateLimitBuckets(PUBLIC_RATE_LIMIT_IDS.read, PUBLIC_RATE_LIMIT_WINDOW_MS, t0 + 1_000), 0, "inside its window: kept");
    assert.equal(sweepRateLimitBuckets(PUBLIC_RATE_LIMIT_IDS.read, PUBLIC_RATE_LIMIT_WINDOW_MS, t0 + PUBLIC_RATE_LIMIT_WINDOW_MS + 1), 1);
    assert.equal(sweepRateLimitBuckets("report", 60 * 60 * 1000, t0 + PUBLIC_RATE_LIMIT_WINDOW_MS + 1), 0, "another limiter's buckets are untouched");
  });
});

// ── The real app.ts ───────────────────────────────────────────────────────────

describe("app.ts wiring", () => {
  let server: http.Server;
  let app: express.Express;
  before(async () => {
    process.env.PUBLIC_RATE_LIMIT_READ_PER_MIN = "3";
    process.env.PUBLIC_RATE_LIMIT_WRITE_PER_MIN = "2";
    delete process.env.TRUST_PROXY;
    app = (await import("../app.js")).default as unknown as express.Express;
    server = await listen(app);
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it("`trust proxy` is the default trusted-proxy list", () => {
    assert.deepEqual(app.get("trust proxy"), [...DEFAULT_TRUSTED_PROXIES]);
  });

  it("the association files and share pages are limited per client address", async () => {
    const ip = "203.0.113.100";
    const got = [];
    for (let i = 0; i < 4; i++) got.push((await request(server, "GET", "/.well-known/apple-app-site-association", from(ip))).status);
    assert.notEqual(got[0], 429);
    assert.equal(got[3], 429, JSON.stringify(got));
    assert.notEqual((await request(server, "GET", "/.well-known/assetlinks.json", from("203.0.113.101"))).status, 429);
  });

  it("/api/healthz is never limited, even from an exhausted address", async () => {
    const ip = "203.0.113.102";
    for (let i = 0; i < 4; i++) await request(server, "GET", "/.well-known/assetlinks.json", from(ip));
    for (let i = 0; i < 10; i++) assert.equal((await request(server, "GET", "/api/healthz", from(ip))).status, 200);
  });

  it("provider webhooks are registered BEFORE the limiter, so they are never limited", async () => {
    const ip = "203.0.113.103";
    for (let i = 0; i < 3; i++) await request(server, "POST", "/api/feature-flags", from(ip)); // exhaust the write budget
    assert.equal((await request(server, "POST", "/api/feature-flags", from(ip))).status, 429, "the address IS exhausted");
    for (const p of ["/api/calls/webhook", "/api/verification/webhook", "/api/payments/webhooks/platform"]) {
      const r = await request(server, "POST", p, from(ip, { "content-type": "application/json" }));
      assert.notEqual(r.status, 429, `${p} answered ${r.status}`);
    }
  });
});
