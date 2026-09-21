/**
 * census-discovery DV-01 / DV-07 — a READ failure in lib/rankLog.ts must be
 * VISIBLE, and must not be laundered into a confident answer.
 *
 * WHAT THIS IS WRITTEN AGAINST
 * ----------------------------
 * `rankLogInsertErrors.test.ts` already pins the WRITE half: both
 * `rank_events` inserts bind the returned `error` and `logger.warn` it. The
 * READ half was still dark in one place, and it is the place that decides
 * whether anything is written at all:
 *
 *     const { data } = await sc
 *       .from("feature_flags").select("enabled")
 *       .eq("flag", "CREATOR_FATIGUE_ENABLED").maybeSingle();
 *     _fatigueFlagEnabled  = Boolean((data as any)?.enabled);
 *     _fatigueFlagCachedAt = Date.now();
 *
 * supabase-js RESOLVES a failed read — it does not throw — so `error` was
 * dropped, `data` came back null, and an OUTAGE became byte-identical to
 * "the flag row does not exist". Worse than invisible: the fabricated `false`
 * was then CACHED for the 60 s TTL, so a transient read failure silently
 * flipped a live `true` flag off for a minute with no log line anywhere. The
 * `catch` above it says "fail-open: keep previous value" — a contract that was
 * defeated for the only failure mode that actually occurs, because that mode
 * never reaches a catch.
 *
 * The contract pinned here, in three parts:
 *   1. the failed read is REPORTED (logger.warn, naming the flag);
 *   2. it does NOT overwrite the last known flag value with a fabrication;
 *   3. it does NOT poison the TTL cache — the next call re-reads instead of
 *      serving a made-up answer for a minute.
 *
 * Part 4 is the fire-and-forget fatigue RPC, which discarded its result
 * entirely (`.then(() => {}, () => {})`) — the same blindness one call lower.
 *
 * Offline: the service client is stubbed, and logger.warn is captured.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/rankLogReadFailureVisibility.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logImpression } from "../lib/rankLog.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";

const USER   = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";
const AUTHOR = "bbbbbbbb-bbbb-bbbb-bbbb-000000000002";

const scored = [{
  candidate: { id: "db/place-1", kind: "place" as const, authorId: AUTHOR },
  score: 1,
  features: { distance: 0.5 },
}] as any;

interface Counts { flagReads: number; rpcs: number }

/**
 * Minimal service client.
 *
 * `rank_events.insert` deliberately RESOLVES with an error so the impression
 * path stops before `recordImpressionDistributionStats` — this file is about
 * the flag read that runs after it, and the insert branch is already pinned by
 * rankLogInsertErrors.test.ts.
 */
function makeClient(opts: {
  flagResult: { data: any; error: any };
  rpcResult?: { data: any; error: any };
  counts: Counts;
}) {
  return {
    from(_table: string) {
      return {
        insert: () =>
          Promise.resolve({ data: null, error: { message: "insert disabled in this fixture" } }),
        select: (_cols: string) => ({
          eq: (_col: string, _val: string) => ({
            maybeSingle: () => {
              opts.counts.flagReads += 1;
              return Promise.resolve(opts.flagResult);
            },
          }),
        }),
      };
    },
    rpc: (_name: string, _params: unknown) => {
      opts.counts.rpcs += 1;
      return Promise.resolve(opts.rpcResult ?? { data: null, error: null });
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

const FLAG_READ_FAILED = /CREATOR_FATIGUE_ENABLED/;

describe("DV-01 — the CREATOR_FATIGUE_ENABLED read failure is not swallowed", () => {
  it("R1. REPORTS a PostgREST read rejection, which resolves rather than throwing", async () => {
    const counts: Counts = { flagReads: 0, rpcs: 0 };
    _setTestServiceClient(makeClient({
      counts,
      flagResult: {
        data:  null,
        error: { code: "57014", message: "canceling statement due to statement timeout" },
      },
    }));

    await logImpression(scored, USER, "discovery");

    assert.equal(counts.flagReads, 1, "the flag read must actually have been attempted");
    const hit = warnings.find((w) => FLAG_READ_FAILED.test(w.msg) || FLAG_READ_FAILED.test(JSON.stringify(w.ctx ?? {})));
    assert.ok(
      hit,
      "an unreadable CREATOR_FATIGUE_ENABLED read must produce a log line naming the flag — " +
      "without one an outage is byte-identical to 'the flag row does not exist'. " +
      `warnings seen: ${JSON.stringify(warnings.map((w) => w.msg))}`,
    );
    assert.ok(
      hit && hit.ctx && (hit.ctx as any).err,
      "the log line must carry the PostgREST error object, not just a message",
    );
  });

  it("R2. does NOT poison the 60 s TTL cache with a fabricated 'disabled' — the next call re-reads", async () => {
    const counts: Counts = { flagReads: 0, rpcs: 0 };
    _setTestServiceClient(makeClient({
      counts,
      flagResult: {
        data:  null,
        error: { code: "57014", message: "canceling statement due to statement timeout" },
      },
    }));

    await logImpression(scored, USER, "discovery");
    await logImpression(scored, USER, "discovery");

    assert.equal(
      counts.flagReads, 2,
      "a FAILED read must not be cached as an answer: caching it pins the flag to a value " +
      "nobody read for the whole TTL, which is how a live 'true' flag silently goes dark for " +
      "a minute. The second call must re-read.",
    );
    assert.equal(
      counts.rpcs, 0,
      "fail closed: an unreadable gate must not be treated as an open gate",
    );
  });

  it("R3. the fire-and-forget fatigue RPC reports its rejection instead of discarding it", async () => {
    const counts: Counts = { flagReads: 0, rpcs: 0 };
    _setTestServiceClient(makeClient({
      counts,
      flagResult: { data: { enabled: true }, error: null },
      rpcResult:  { data: null, error: { code: "42883", message: "function increment_creator_fatigue_batch does not exist" } },
    }));

    await logImpression(scored, USER, "discovery");
    // The RPC is voided, not awaited — let the microtask queue drain.
    await new Promise((r) => setImmediate(r));

    assert.equal(counts.rpcs, 1, "the fatigue RPC must have been attempted");
    const hit = warnings.find((w) => /fatigue/i.test(w.msg));
    assert.ok(
      hit,
      "a rejected increment_creator_fatigue_batch must be reported — `.then(() => {}, () => {})` " +
      `discards both halves of the result. warnings seen: ${JSON.stringify(warnings.map((w) => w.msg))}`,
    );
  });
});

// ── The census criterion itself ───────────────────────────────────────────────
//
// census-discovery DV-01's "swallow criterion" is graded on the PROSE of this
// module, quoted at `lib/rankLog.ts:81` and `:255`: "All errors are swallowed
// silently." That sentence stopped being true when the insert-error branches
// landed, and a comment that describes a defect the code no longer has is read
// by the next census exactly as the defect. Pinned here so it cannot come back.

describe("DV-01 — lib/rankLog.ts does not claim to swallow errors it reports", () => {
  it("R4. no 'swallowed silently' claim survives anywhere in the module", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src  = readFileSync(path.resolve(here, "../lib/rankLog.ts"), "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter((l) => /swallow(ed|s)?\s+silently/i.test(l.line));

    assert.deepEqual(
      offenders.map((o) => o.n), [],
      "lib/rankLog.ts binds and logger.warn()s every rank_events insert error and every " +
      "feature-flag read error; a doc comment still claiming 'All errors are swallowed " +
      "silently' is a false statement about this file's own contract, and it is the literal " +
      `evidence census DV-01 cites. Offending lines: ${JSON.stringify(offenders)}`,
    );
  });
});
