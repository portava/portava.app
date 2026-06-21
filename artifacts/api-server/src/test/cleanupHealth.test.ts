/**
 * HTTP-level tests for GET /api/healthz/cleanup
 *
 * Covers:
 *   H1: responds 200 with all required fields in the response shape
 *   H2: cleanupStatus = "ok" when job ran recently
 *   H3: cleanupStatus = "overdue" when job ran 30 h ago
 *   H4: cleanupStatus = "critical" when job ran 55 h ago
 *   H5: cleanupStatus = "critical" when job has never run (no row)
 *   H6: cleanupStatus = "critical" when job_health query fails
 *   H7: returns HTTP 200 even when cleanupStatus is "critical" (critical state is not a server error)
 *   H8: returns HTTP 200 even when cleanupStatus is "overdue"
 *   H9: response shape matches the documented contract exactly — no extra or missing fields
 *
 * Runtime: node:test + fetch() on a real in-process Express server.
 * Fake job_health client injected via _setTestJobHealthClient so no live
 * Supabase connection is required.
 *
 * Run: node --import tsx/esm --test src/test/cleanupHealth.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestJobHealthClient } from "../lib/dailyBriefCleanup.js";
import healthRouter from "../routes/health.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a fake job_health Supabase client that returns a controlled row.
 * minsAgo = null  → no row exists (first-run scenario)
 * minsAgo = N     → row with last_run_at = N minutes before now
 */
function makeJobHealthClient(minsAgo: number | null) {
  return {
    from(_table: string) {
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        maybeSingle() {
          if (minsAgo === null) return Promise.resolve({ data: null, error: null });
          return Promise.resolve({
            data: { last_run_at: new Date(Date.now() - minsAgo * 60_000).toISOString() },
            error: null,
          });
        },
      };
      return builder;
    },
  };
}

function makeErrorClient() {
  return {
    from(_table: string) {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({ data: null, error: { message: "connection refused" } });
        },
      };
    },
  };
}

// ── Server setup ──────────────────────────────────────────────────────────────

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // Suppress pino output during tests — attach a no-op req.log just in case
  // any middleware reaches for it (the health route uses the module logger,
  // not req.log, so this is a belt-and-suspenders precaution only).
  app.use((_req, _res, next) => { (_req as any).log = { error: () => {}, warn: () => {}, info: () => {} }; next(); });
  app.use("/api", healthRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => {
  server.close();
});

afterEach(() => {
  _setTestJobHealthClient(null);
});

// ══════════════════════════════════════════════════════════════════════════════
// H1–H9: GET /api/healthz/cleanup
// ══════════════════════════════════════════════════════════════════════════════

describe("H — GET /api/healthz/cleanup", () => {
  it("H1: responds 200 with all required fields", async () => {
    _setTestJobHealthClient(makeJobHealthClient(60)); // 1h ago → ok
    const res = await fetch(`${base}/healthz/cleanup`);
    assert.equal(res.status, 200);

    const body = await res.json() as Record<string, unknown>;
    assert.ok("cleanupStatus" in body,        "missing cleanupStatus");
    assert.ok("lastRunAt" in body,             "missing lastRunAt");
    assert.ok("lastOutcome" in body,           "missing lastOutcome");
    assert.ok("lastDeletedCount" in body,      "missing lastDeletedCount");
    assert.ok("consecutiveFailures" in body,   "missing consecutiveFailures");
  });

  it("H2: cleanupStatus = 'ok' when job ran 1 h ago", async () => {
    _setTestJobHealthClient(makeJobHealthClient(60));
    const res = await fetch(`${base}/healthz/cleanup`);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.cleanupStatus, "ok");
    assert.ok(typeof body.lastRunAt === "string", "lastRunAt should be a string");
  });

  it("H3: cleanupStatus = 'overdue' when job ran 30 h ago", async () => {
    _setTestJobHealthClient(makeJobHealthClient(30 * 60));
    const res = await fetch(`${base}/healthz/cleanup`);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.cleanupStatus, "overdue");
  });

  it("H4: cleanupStatus = 'critical' when job ran 55 h ago", async () => {
    _setTestJobHealthClient(makeJobHealthClient(55 * 60));
    const res = await fetch(`${base}/healthz/cleanup`);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.cleanupStatus, "critical");
  });

  it("H5: cleanupStatus = 'critical' when no job_health row exists (never ran)", async () => {
    _setTestJobHealthClient(makeJobHealthClient(null));
    const res = await fetch(`${base}/healthz/cleanup`);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.cleanupStatus, "critical");
    assert.equal(body.lastRunAt, null);
  });

  it("H6: cleanupStatus = 'critical' when job_health query returns an error", async () => {
    _setTestJobHealthClient(makeErrorClient());
    const res = await fetch(`${base}/healthz/cleanup`);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.cleanupStatus, "critical");
  });

  it("H7: HTTP 200 even when cleanupStatus is 'critical' — health endpoints must always respond", async () => {
    // No row = critical; endpoint must still return 200, not 5xx or 4xx.
    _setTestJobHealthClient(makeJobHealthClient(null));
    const res = await fetch(`${base}/healthz/cleanup`);
    assert.equal(res.status, 200, "expected 200 even for critical cleanup status");
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.cleanupStatus, "critical");
  });

  it("H8: HTTP 200 even when cleanupStatus is 'overdue'", async () => {
    _setTestJobHealthClient(makeJobHealthClient(30 * 60));
    const res = await fetch(`${base}/healthz/cleanup`);
    assert.equal(res.status, 200, "expected 200 even for overdue cleanup status");
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.cleanupStatus, "overdue");
  });

  it("H9: response contains exactly the five documented fields — no extras, no missing", async () => {
    _setTestJobHealthClient(makeJobHealthClient(60)); // ok
    const res = await fetch(`${base}/healthz/cleanup`);
    assert.equal(res.status, 200);

    const body = await res.json() as Record<string, unknown>;
    const EXPECTED_KEYS = new Set([
      "cleanupStatus",
      "lastRunAt",
      "lastOutcome",
      "lastDeletedCount",
      "consecutiveFailures",
    ]);

    const actualKeys = new Set(Object.keys(body));

    // All required keys must be present.
    for (const key of EXPECTED_KEYS) {
      assert.ok(actualKeys.has(key), `missing required field: ${key}`);
    }

    // No extra keys beyond the documented contract.
    for (const key of actualKeys) {
      assert.ok(EXPECTED_KEYS.has(key), `unexpected extra field in response: ${key}`);
    }

    // Type guards for the fields that have fixed types.
    assert.ok(
      ["ok", "overdue", "critical"].includes(body.cleanupStatus as string),
      "cleanupStatus must be 'ok' | 'overdue' | 'critical'",
    );
    assert.ok(
      typeof body.consecutiveFailures === "number",
      "consecutiveFailures must be a number",
    );
  });
});
