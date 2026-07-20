/**
 * App-level security hardening tests
 *
 * 1. CORS — requests from non-allowlisted origins are rejected.
 * 2. Global error handler — unhandled throws return { error: { code, message } }.
 * 3. Auth rate limits — POST /auth/signup returns 429 after the per-IP cap is exceeded.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run:
 *   node --import tsx/esm --test src/test/appHardening.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetAuthRateLimits } from "../routes/auth.js";

// ── Shared HTTP helper ────────────────────────────────────────────────────────

function rawRequest(opts: {
  server: http.Server;
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = opts.server.address() as { port: number };
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const hdrs: Record<string, string> = { "content-type": "application/json", ...opts.headers };
    if (payload) hdrs["content-length"] = Buffer.byteLength(payload).toString();

    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path: opts.path, method: opts.method, headers: hdrs },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let body: any;
          try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startServer(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function stopServer(srv: http.Server): Promise<void> {
  return new Promise((r) => srv.close(() => r()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — CORS allowlist
// ─────────────────────────────────────────────────────────────────────────────

describe("CORS allowlist", () => {
  let server: http.Server;

  before(async () => {
    const ALLOWED = ["https://app.travel-buddy.io"];
    const app = express();

    app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin) return callback(null, true);          // mobile / curl
          if (ALLOWED.includes(origin)) return callback(null, true);
          callback(new Error(`Origin '${origin}' is not allowed by CORS policy`));
        },
        credentials: true,
      }),
    );

    // Minimal error handler matching app.ts
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: any, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: { code: err?.code ?? "INTERNAL_ERROR", message: err?.message ?? "" } });
    });

    app.get("/ping", (_req, res) => res.json({ ok: true }));
    server = await startServer(app);
  });

  after(() => stopServer(server));

  it("allows requests with no Origin header (mobile / curl)", async () => {
    const r = await rawRequest({ server, method: "GET", path: "/ping" });
    assert.equal(r.status, 200);
  });

  it("allows requests from an allowlisted origin", async () => {
    const r = await rawRequest({
      server, method: "GET", path: "/ping",
      headers: { origin: "https://app.travel-buddy.io" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], "https://app.travel-buddy.io");
  });

  it("does not echo back a non-allowlisted origin in Access-Control-Allow-Origin", async () => {
    const r = await rawRequest({
      server, method: "GET", path: "/ping",
      headers: { origin: "https://evil.example.com" },
    });
    assert.notEqual(
      r.headers["access-control-allow-origin"],
      "https://evil.example.com",
      "CORS header must not echo back a disallowed origin",
    );
  });

  it("does not allow a wildcard ACAO when a non-allowlisted origin is sent", async () => {
    const r = await rawRequest({
      server, method: "GET", path: "/ping",
      headers: { origin: "https://evil.example.com" },
    });
    assert.notEqual(
      r.headers["access-control-allow-origin"],
      "*",
      "CORS header must not be wildcard for a disallowed origin",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — Global error handler
// ─────────────────────────────────────────────────────────────────────────────

describe("global error handler", () => {
  let server: http.Server;

  before(async () => {
    const app = express();
    app.use(express.json());

    // Route that calls next(err) — simulates an unhandled async throw
    app.get("/throw", (_req, _res, next) => {
      next(new Error("deliberate test error"));
    });

    // Route that carries a custom status code on the error
    app.get("/custom-status", (_req, _res, next) => {
      const err: any = new Error("resource not found");
      err.status = 404;
      err.code = "NOT_FOUND";
      next(err);
    });

    // Global error handler — verbatim copy of the app.ts handler
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: any, _req: Request, res: Response, _next: NextFunction): void => {
      const status: number =
        typeof err?.status     === "number" ? err.status :
        typeof err?.statusCode === "number" ? err.statusCode :
        500;
      res.status(status).json({
        error: {
          code:    err?.code    ?? "INTERNAL_ERROR",
          message: err?.message ?? "An unexpected error occurred.",
        },
      });
    });

    server = await startServer(app);
  });

  after(() => stopServer(server));

  it("returns 500 with { error: { code, message } } for an unhandled error", async () => {
    const r = await rawRequest({ server, method: "GET", path: "/throw" });
    assert.equal(r.status, 500, `expected 500, got ${r.status}`);
    assert.ok(r.body?.error, "response must have an 'error' key");
    assert.equal(r.body.error.code, "INTERNAL_ERROR");
    assert.ok(typeof r.body.error.message === "string" && r.body.error.message.length > 0,
      "message must be a non-empty string");
  });

  it("does not include a stack trace in the response body", async () => {
    const r = await rawRequest({ server, method: "GET", path: "/throw" });
    const serialised = JSON.stringify(r.body);
    assert.ok(!serialised.includes("    at "), "stack trace must not appear in the response");
  });

  it("preserves a custom status code carried on the error object", async () => {
    const r = await rawRequest({ server, method: "GET", path: "/custom-status" });
    assert.equal(r.status, 404, `expected 404, got ${r.status}`);
    assert.equal(r.body.error.code, "NOT_FOUND");
    assert.ok(r.body.error.message.includes("not found"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — Auth rate limits — POST /auth/signup
// ─────────────────────────────────────────────────────────────────────────────

describe("auth rate limits — POST /auth/signup", () => {
  let server: http.Server;

  // Helper — POST /api/auth/signup with a plausible-looking body.
  // The service client is null, so the handler returns 503; what matters is
  // whether the rate-limit middleware intercepts the request first (429) or
  // lets it through (any non-429 status).
  async function postSignup(n: number) {
    return rawRequest({
      server,
      method: "POST",
      path: "/api/auth/signup",
      body: { email: `user${n}@example.com`, password: "password123" },
    });
  }

  before(async () => {
    const { default: authRouter } = await import("../routes/auth.js");

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
      next();
    });
    app.use("/api", authRouter);

    // Service client null → handler returns 503 before touching DB.
    // All requests (200, 400, 503) count toward the rate-limit window.
    _setTestServiceClient(null as any);

    server = await startServer(app);
  });

  after(async () => {
    _setTestServiceClient(null as any);
    _resetAuthRateLimits();
    await stopServer(server);
  });

  // Each test gets a clean rate-limit counter
  beforeEach(() => { _resetAuthRateLimits(); });

  it("allows requests under the per-IP limit", async () => {
    const r = await postSignup(1);
    assert.notEqual(r.status, 429, `first request must not be rate-limited, got ${r.status}`);
  });

  it("returns 429 after exceeding 5 requests per hour", async () => {
    // Drain the window (5 allowed)
    for (let i = 0; i < 5; i++) {
      const r = await postSignup(i);
      assert.notEqual(r.status, 429, `request ${i + 1} should not be rate-limited yet`);
    }
    // 6th request must be rejected
    const over = await postSignup(5);
    assert.equal(over.status, 429, `expected 429 on request 6, got ${over.status}: ${JSON.stringify(over.body)}`);
  });

  it("429 body uses the standard { error: { code, message } } envelope", async () => {
    for (let i = 0; i < 5; i++) await postSignup(i);
    const over = await postSignup(5);
    assert.equal(over.status, 429);
    assert.ok(over.body?.error, "response must have an 'error' key");
    assert.equal(over.body.error.code, "RATE_LIMITED");
    assert.ok(typeof over.body.error.message === "string" && over.body.error.message.length > 0,
      "message must be a non-empty string");
  });

  it("429 includes a rate-limit or Retry-After header (draft-7 standard headers)", async () => {
    for (let i = 0; i < 5; i++) await postSignup(i);
    const over = await postSignup(5);
    assert.equal(over.status, 429);
    const hasHeader =
      "ratelimit-limit"     in over.headers ||
      "ratelimit-remaining" in over.headers ||
      "retry-after"         in over.headers;
    assert.ok(hasHeader, `response must include a rate-limit or retry-after header; got: ${JSON.stringify(over.headers)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4 — Auth rate limits — POST /auth/lookup-username
// ─────────────────────────────────────────────────────────────────────────────

describe("auth rate limits — POST /auth/lookup-username", () => {
  let server: http.Server;

  // Helper — POST /api/auth/lookup-username with an invalid email (no "@") so
  // the handler returns 400 immediately, before the intentional 800 ms delay.
  // The rate-limit middleware still counts the request against the per-IP window
  // because 400 / 503 responses are treated the same as 200 — what matters is
  // whether the middleware fires a 429 before the handler runs at all.
  async function postLookup(n: number) {
    return rawRequest({
      server,
      method: "POST",
      path: "/api/auth/lookup-username",
      body: { email: `no-at-sign-${n}` },
    });
  }

  before(async () => {
    const { default: authRouter } = await import("../routes/auth.js");

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
      next();
    });
    app.use("/api", authRouter);

    // Service client null — handler would return 503 if it ever got past
    // validation, but the missing "@" short-circuits to 400 first anyway.
    _setTestServiceClient(null as any);

    server = await startServer(app);
  });

  after(async () => {
    _setTestServiceClient(null as any);
    _resetAuthRateLimits();
    await stopServer(server);
  });

  // Each test gets a clean rate-limit counter
  beforeEach(() => { _resetAuthRateLimits(); });

  it("allows requests under the per-IP limit", async () => {
    const r = await postLookup(1);
    assert.notEqual(r.status, 429, `first request must not be rate-limited, got ${r.status}`);
  });

  it("returns 429 after exceeding 10 requests per 15 minutes", async () => {
    // Drain the window (10 allowed)
    for (let i = 0; i < 10; i++) {
      const r = await postLookup(i);
      assert.notEqual(r.status, 429, `request ${i + 1} should not be rate-limited yet`);
    }
    // 11th request must be rejected
    const over = await postLookup(10);
    assert.equal(over.status, 429, `expected 429 on request 11, got ${over.status}: ${JSON.stringify(over.body)}`);
  });

  it("429 body uses the standard { error: { code, message } } envelope", async () => {
    for (let i = 0; i < 10; i++) await postLookup(i);
    const over = await postLookup(10);
    assert.equal(over.status, 429);
    assert.ok(over.body?.error, "response must have an 'error' key");
    assert.equal(over.body.error.code, "RATE_LIMITED");
    assert.ok(typeof over.body.error.message === "string" && over.body.error.message.length > 0,
      "message must be a non-empty string");
  });

  it("429 includes a rate-limit or Retry-After header (draft-7 standard headers)", async () => {
    for (let i = 0; i < 10; i++) await postLookup(i);
    const over = await postLookup(10);
    assert.equal(over.status, 429);
    const hasHeader =
      "ratelimit-limit"     in over.headers ||
      "ratelimit-remaining" in over.headers ||
      "retry-after"         in over.headers;
    assert.ok(hasHeader, `response must include a rate-limit or retry-after header; got: ${JSON.stringify(over.headers)}`);
  });
});
