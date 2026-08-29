/**
 * rank_events insert failures must be VISIBLE.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST (2026-08-28)
 * ----------------------------------------------
 * `logImpression` and `logCompassImpression` did:
 *
 *     await sc.from("rank_events").insert(rows);
 *
 * inside a try whose catch was an empty swallow — and they never destructured
 * the returned `error`. A PostgREST-level rejection (a CHECK or FK violation)
 * does NOT throw; it comes back as `{ error }`. So a rejected insert was lost
 * twice over: it never reached the catch, and the catch said nothing anyway.
 *
 * The cost is not hypothetical. The Stage 0 baseline reads row counts to answer
 * "did this serve point run?", and "surface=discovery has only 13 rows" cannot
 * distinguish "the ranked path never executed" from "it executed and every
 * insert was rejected". `logDiscoveryServe` already inspected its error; these
 * two did not, so the surface was half blind.
 *
 * These tests pin BOTH halves of the contract, which are in tension:
 *   - a rejection must be reported, and
 *   - it must still never throw into the feed.
 *
 * Offline: the service client is stubbed, and logger.warn is captured.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logImpression, logCompassImpression } from "../lib/rankLog.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";

const scored = [{
  candidate: { id: "db/place-1", kind: "place" as const },
  score: 1,
  features: { distance: 0.5 },
}] as any;

/** Client whose insert RESOLVES with an error object — never throws. */
function rejectingClient(message: string) {
  return {
    from() {
      return { insert: () => Promise.resolve({ error: { message }, data: null }) };
    },
  } as any;
}

/** Client whose insert throws outright. */
function throwingClient() {
  return {
    from() {
      return { insert: () => { throw new Error("connection reset"); } };
    },
  } as any;
}

let warnings: Array<{ ctx: any; msg: string }>;
let originalWarn: typeof logger.warn;

beforeEach(() => {
  warnings = [];
  originalWarn = logger.warn.bind(logger);
  (logger as any).warn = (ctx: any, msg?: string) => {
    warnings.push({ ctx, msg: msg ?? String(ctx) });
  };
});

afterEach(() => {
  (logger as any).warn = originalWarn;
  _setTestServiceClient(null as any);
});

describe("logImpression — a rejected insert is reported, not swallowed", () => {
  it("REPORTS a PostgREST rejection, which does not throw", async () => {
    _setTestServiceClient(rejectingClient("new row violates check constraint"));
    await logImpression(scored, USER, "discovery");

    const hit = warnings.find((w) => /insert rejected/i.test(w.msg));
    assert.ok(hit, `expected a warning about the rejected insert, got: ${JSON.stringify(warnings)}`);
    assert.equal((hit!.ctx as any).surface, "discovery", "the surface must be in the log context");
  });

  it("still does NOT throw — fire-and-forget is preserved", async () => {
    _setTestServiceClient(rejectingClient("nope"));
    await assert.doesNotReject(() => logImpression(scored, USER, "discovery"));
  });

  it("reports a THROWN failure too, and still does not rethrow", async () => {
    _setTestServiceClient(throwingClient());
    await assert.doesNotReject(() => logImpression(scored, USER, "discovery"));
    assert.ok(
      warnings.some((w) => /threw/i.test(w.msg)),
      "a thrown insert must also be logged rather than silently dropped",
    );
  });
});

describe("logCompassImpression — same contract", () => {
  it("reports a rejection and does not throw", async () => {
    _setTestServiceClient(rejectingClient("violates foreign key"));
    await assert.doesNotReject(() =>
      logCompassImpression([{ id: "p1", type: "place" }], USER));
    assert.ok(
      warnings.some((w) => /insert rejected/i.test(w.msg)),
      `expected a rejection warning, got: ${JSON.stringify(warnings)}`,
    );
  });
});
