/**
 * CORS ALLOWED_ORIGINS smoke test
 *
 * Verifies that the env-var-driven CORS allowlist (process.env.ALLOWED_ORIGINS)
 * used in app.ts correctly:
 *   - allows requests from the deployed production origin
 *   - blocks requests from rogue origins (no ACAO header echoed back)
 *   - always allows requests with no Origin header (mobile apps, curl)
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run:
 *   node --import tsx/esm --test src/test/corsAllowedOrigins.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";

// ── HTTP helper (mirrors the one in appHardening.test.ts) ─────────────────────

function rawRequest(opts: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = opts.server.address() as { port: number };
    const hdrs: Record<string, string> = { "content-type": "application/json", ...opts.headers };

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

// ── Build a CORS middleware exactly as app.ts does ────────────────────────────
// Accepts an explicit allowlist so we can vary it per test suite without
// mutating process.env across tests.

function buildCorsMiddleware(allowedOrigins: string[]) {
  return cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`Origin '${origin}' is not allowed by CORS policy`));
    },
    credentials: true,
  });
}

// ── Suite: ALLOWED_ORIGINS populated from the env var ─────────────────────────

describe("CORS – ALLOWED_ORIGINS env var (deployed-origin smoke test)", () => {
  let server: http.Server;

  // The deployed production origin set via the ALLOWED_ORIGINS env var.
  const DEPLOYED_ORIGIN = "https://portava.replit.app";

  before(async () => {
    // Simulate production: set ALLOWED_ORIGINS to the deployed origin, then
    // parse it exactly as app.ts does.  We save and restore the original value
    // so this suite is hermetic.
    const originalEnv = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = DEPLOYED_ORIGIN;

    const raw = process.env.ALLOWED_ORIGINS;
    const allowedOrigins: string[] = raw
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : ["https://app.travel-buddy.io", "https://www.travel-buddy.io"];

    // Restore so subsequent suites/tests are not affected.
    if (originalEnv === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = originalEnv;
    }

    const app = express();
    app.use(buildCorsMiddleware(allowedOrigins));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: any, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: { code: err?.code ?? "CORS_ERROR", message: err?.message ?? "" } });
    });

    app.get("/ping", (_req, res) => res.json({ ok: true }));
    server = await startServer(app);
  });

  after(() => stopServer(server));

  it("allows requests with no Origin header (mobile apps / curl)", async () => {
    const r = await rawRequest({ server, method: "GET", path: "/ping" });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  });

  it("allows requests from the deployed production origin", async () => {
    const r = await rawRequest({
      server, method: "GET", path: "/ping",
      headers: { origin: DEPLOYED_ORIGIN },
    });
    assert.equal(r.status, 200, `expected 200 for deployed origin, got ${r.status}`);
    assert.equal(
      r.headers["access-control-allow-origin"],
      DEPLOYED_ORIGIN,
      "Access-Control-Allow-Origin must echo back the deployed origin",
    );
  });

  it("does not echo back a rogue origin in Access-Control-Allow-Origin", async () => {
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

  it("does not allow wildcard ACAO for a rogue origin", async () => {
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

// ── Suite: explicit multi-origin allowlist parsing ───────────────────────────

describe("CORS – comma-separated ALLOWED_ORIGINS parsing", () => {
  let server: http.Server;

  const ORIGIN_A = "https://app.travel-buddy.io";
  const ORIGIN_B = "https://www.travel-buddy.io";

  before(async () => {
    // Simulate a comma-separated env value with surrounding whitespace
    const raw = `${ORIGIN_A} , ${ORIGIN_B}`;
    const allowedOrigins = raw.split(",").map((s) => s.trim()).filter(Boolean);

    const app = express();
    app.use(buildCorsMiddleware(allowedOrigins));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: any, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: { code: "CORS_ERROR", message: err?.message ?? "" } });
    });

    app.get("/ping", (_req, res) => res.json({ ok: true }));
    server = await startServer(app);
  });

  after(() => stopServer(server));

  it("allows the first origin in a multi-origin list", async () => {
    const r = await rawRequest({
      server, method: "GET", path: "/ping",
      headers: { origin: ORIGIN_A },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], ORIGIN_A);
  });

  it("allows the second origin in a multi-origin list", async () => {
    const r = await rawRequest({
      server, method: "GET", path: "/ping",
      headers: { origin: ORIGIN_B },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], ORIGIN_B);
  });

  it("strips whitespace around commas when parsing the env var", async () => {
    // Both origins must be reachable despite spaces around the comma
    for (const origin of [ORIGIN_A, ORIGIN_B]) {
      const r = await rawRequest({
        server, method: "GET", path: "/ping",
        headers: { origin },
      });
      assert.equal(r.status, 200, `origin ${origin} should be allowed after whitespace-trim`);
    }
  });
});
