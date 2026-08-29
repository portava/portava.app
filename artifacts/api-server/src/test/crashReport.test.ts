/**
 * POST /crash-report — rate-limiter tests
 *
 * Verifies that a per-IP sliding-window limiter (10 req/min) blocks further
 * crash reports once the limit is reached, returning HTTP 429.
 *
 * No Supabase client needed — the endpoint does not touch the database.
 *
 * Run: node --import tsx/esm --test src/test/crashReport.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import crashReportRouter, { _resetRateLimiter } from "../routes/crashReport.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_BODY = {
  errorMessage:   "ReferenceError: x is not defined",
  componentStack: "at App (App.tsx:10)\nat ErrorBoundary (ErrorBoundary.tsx:5)",
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = pino({ level: "silent" });
    next();
  });
  app.use(crashReportRouter);
  return app;
}

async function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer(buildApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /crash-report — rate limiter", () => {
  let server: Server;
  let port: number;

  before(async () => {
    ({ server, port } = await startServer());
  });

  after(() => stopServer(server));

  beforeEach(async () => {
    await _resetRateLimiter();
  });

  async function post(body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/crash-report`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  }

  it("accepts exactly MAX_REPORTS (10) requests with HTTP 200", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await post(VALID_BODY);
      assert.equal(res.status, 200, `request ${i + 1} should be accepted`);
      const body = await res.json() as { ok: boolean };
      assert.equal(body.ok, true);
    }
  });

  it("returns 429 on the request that exceeds the limit", async () => {
    for (let i = 0; i < 10; i++) {
      await post(VALID_BODY);
    }
    const res = await post(VALID_BODY);
    assert.equal(res.status, 429);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "rate_limited");
  });

  it("continues returning 429 for all subsequent over-limit requests", async () => {
    for (let i = 0; i < 10; i++) {
      await post(VALID_BODY);
    }
    for (let i = 0; i < 3; i++) {
      const res = await post(VALID_BODY);
      assert.equal(res.status, 429, `over-limit request ${i + 1} should be 429`);
    }
  });

  it("returns HTTP 400 for an invalid payload when under the rate limit", async () => {
    const res = await post({ errorMessage: "ok" }); // missing componentStack
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "invalid_payload");
  });

  it("resets the window after _resetRateLimiter() is called", async () => {
    for (let i = 0; i < 10; i++) {
      await post(VALID_BODY);
    }
    const over = await post(VALID_BODY);
    assert.equal(over.status, 429);

    await _resetRateLimiter();

    const fresh = await post(VALID_BODY);
    assert.equal(fresh.status, 200);
    const body = await fresh.json() as { ok: boolean };
    assert.equal(body.ok, true);
  });
});
