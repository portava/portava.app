/**
 * CompassSearchDecayService — silent-failure lane (audit M2, code half).
 *
 * The whole compass_search_signal_log migration is unapplied in CI + prod, so
 * the RPC (42883) and the table (42P01) are absent.
 * supabase-js RESOLVES rather than throws on those, so the service's three DB
 * touch points used to discard the error and silently fall back — the boost the
 * feature is supposed to decay never decays, invisibly. These assert the error
 * is now LOGGED (observability) while the graceful fallback is preserved.
 *
 * Run: node --import tsx/esm --test src/test/compassSearchDecayLogging.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  logSearchNudge,
  getDecayConfig,
  getDecayedWeights,
} from "../compass/CompassSearchDecayService.js";
import { logger } from "../lib/logger.js";

// ── logger.warn spy ─────────────────────────────────────────────────────────
let warnCalls: any[][] = [];
const realWarn = logger.warn.bind(logger);
beforeEach(() => { warnCalls = []; (logger as any).warn = (...a: any[]) => { warnCalls.push(a); }; });
afterEach(() => { (logger as any).warn = realWarn; });

// ── Table-aware fake client ─────────────────────────────────────────────────
function fakeDb(opts: { rpcError?: any; selectErrorTable?: string; selectError?: any } = {}) {
  return {
    rpc: async () => ({ data: null, error: opts.rpcError ?? null }),
    from: (table: string) => {
      const err = opts.selectErrorTable === table ? opts.selectError : null;
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: null, error: err }),
        then: (res: any, rej: any) => Promise.resolve({ data: null, error: err }).then(res, rej),
      };
      return b;
    },
  } as any;
}

describe("CompassSearchDecayService — errors are logged, not swallowed", () => {
  it("logSearchNudge logs when the upsert RPC returns a 42P01 (missing table)", async () => {
    const db = fakeDb({ rpcError: { code: "42P01", message: "relation compass_search_signal_log does not exist" } });
    await logSearchNudge(db, "user-1", "food", 3);
    assert.equal(warnCalls.length, 1, "the RPC error must be logged");
    assert.match(JSON.stringify(warnCalls[0]), /logSearchNudge/);
  });

  it("logSearchNudge does NOT log when the RPC succeeds (positive control)", async () => {
    const db = fakeDb({}); // rpc resolves { error: null }
    await logSearchNudge(db, "user-1", "food", 3);
    assert.equal(warnCalls.length, 0, "a successful nudge must not warn");
  });

  it("getDecayConfig logs on a feature_flags read error and still returns the default", async () => {
    const db = fakeDb({ selectErrorTable: "feature_flags", selectError: { code: "42P01", message: "relation feature_flags does not exist" } });
    const cfg = await getDecayConfig(db);
    assert.equal(warnCalls.length, 1, "the feature_flags error must be logged");
    assert.deepEqual(cfg, { enabled: true, halfLifeDays: 7 }, "still falls back to the default config");
  });

  it("getDecayedWeights logs on a signal-log read error and returns undecayed weights", async () => {
    const db = fakeDb({ selectErrorTable: "compass_search_signal_log", selectError: { code: "42P01", message: "relation does not exist" } });
    const weights = { food: 5, nightlife: 2 };
    const out = await getDecayedWeights(db, "user-1", weights);
    assert.ok(warnCalls.some((c) => /getDecayedWeights/.test(JSON.stringify(c))), "the signal-log error must be logged");
    assert.deepEqual(out, weights, "the original weights are returned unchanged on error");
  });
});
