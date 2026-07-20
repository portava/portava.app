/**
 * HTTP-level tests for POST /api/admin/cleanup/weather-cache
 *
 * Covers:
 *   W1: secret unset → 500, purge never called
 *   W2: secret set, wrong value supplied → 401, purge never called
 *   W3: secret set, correct value supplied → 200 with deleted count
 *
 * Runtime: node:test + fetch() on a real in-process Express server.
 * Fake purge implementation injected via _setTestPurgeImpl so no live
 * Supabase connection is required.
 *
 * Run: node --import tsx/esm --test src/test/weatherCacheCleanupRoute.test.ts
 */
import { describe, it, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestPurgeImpl } from "../lib/weatherCacheCleanup.js";
import healthRouter from "../routes/health.js";

// ── Server setup ──────────────────────────────────────────────────────────────

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    (_req as any).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
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
  // Clear any injected purge override and restore the original env value.
  _setTestPurgeImpl(null);
});

// ══════════════════════════════════════════════════════════════════════════════
// W1–W3: POST /api/admin/cleanup/weather-cache
// ══════════════════════════════════════════════════════════════════════════════

describe("W — POST /api/admin/cleanup/weather-cache", () => {
  // ── W1: secret unset → 500, purge is never called ─────────────────────────
  it("W1: returns 500 and does not call purge when CLEANUP_ADMIN_SECRET is not set", async () => {
    // Save and unset the env var.
    const saved = process.env.CLEANUP_ADMIN_SECRET;
    delete process.env.CLEANUP_ADMIN_SECRET;

    let purgeWasCalled = false;
    _setTestPurgeImpl(async () => {
      purgeWasCalled = true;
      return { deleted: 0, error: null };
    });

    try {
      const res = await fetch(`${base}/admin/cleanup/weather-cache`, {
        method: "POST",
      });
      assert.ok(res.status >= 500, `expected 5xx, got ${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      assert.ok("error" in body, "response should contain an error field");
      assert.equal(purgeWasCalled, false, "purge must not be called when secret is unset");
    } finally {
      // Restore original value regardless of assertion outcome.
      if (saved !== undefined) {
        process.env.CLEANUP_ADMIN_SECRET = saved;
      } else {
        delete process.env.CLEANUP_ADMIN_SECRET;
      }
    }
  });

  // ── W2: secret set, wrong value → 401, purge not called ───────────────────
  it("W2: returns 401 and does not call purge when wrong secret is supplied", async () => {
    const saved = process.env.CLEANUP_ADMIN_SECRET;
    process.env.CLEANUP_ADMIN_SECRET = "correct-secret";

    let purgeWasCalled = false;
    _setTestPurgeImpl(async () => {
      purgeWasCalled = true;
      return { deleted: 0, error: null };
    });

    try {
      const res = await fetch(`${base}/admin/cleanup/weather-cache`, {
        method: "POST",
        headers: { "x-cleanup-secret": "wrong-secret" },
      });
      assert.equal(res.status, 401);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.error, "unauthorized");
      assert.equal(purgeWasCalled, false, "purge must not be called when secret is wrong");
    } finally {
      if (saved !== undefined) {
        process.env.CLEANUP_ADMIN_SECRET = saved;
      } else {
        delete process.env.CLEANUP_ADMIN_SECRET;
      }
    }
  });

  // ── W3: secret set, correct value → 200 with deleted count ────────────────
  it("W3: returns 200 with deleted count when correct secret is supplied", async () => {
    const saved = process.env.CLEANUP_ADMIN_SECRET;
    process.env.CLEANUP_ADMIN_SECRET = "correct-secret";

    _setTestPurgeImpl(async () => ({ deleted: 7, error: null }));

    try {
      const res = await fetch(`${base}/admin/cleanup/weather-cache`, {
        method: "POST",
        headers: { "x-cleanup-secret": "correct-secret" },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.deleted, 7);
    } finally {
      if (saved !== undefined) {
        process.env.CLEANUP_ADMIN_SECRET = saved;
      } else {
        delete process.env.CLEANUP_ADMIN_SECRET;
      }
    }
  });
});
