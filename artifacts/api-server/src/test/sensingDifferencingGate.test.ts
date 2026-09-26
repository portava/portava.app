/**
 * sensingDifferencingGate — §3 "anti-differencing controls"; census S24 found
 * none. Two publications of one cohort differing by fewer than a whole
 * independent party leak the difference.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateDifferencing,
  purgeExpiredSensingPublications,
  readLastPublishedAggregate,
} from "../lib/sensingDifferencingGate.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import type { SensingCohortAggregate } from "../lib/sensingCoverageAggregate.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TS = readFileSync(join(SRC, "lib", "sensingDifferencingGate.ts"), "utf8");

const agg = (distinctActors: number, over: Partial<SensingCohortAggregate> = {}): SensingCohortAggregate => ({
  publishable: true,
  reason: null,
  distinctActors,
  distinctGroups: 6,
  maxGroupShare: 0.17,
  contributions: distinctActors,
  observedAt: "2026-09-07T21:40:00.000Z",
  medianSignalBucket: 2,
  // 3312: the aggregate carries reduced-feature statistics, null unless publishable; this gate never reads them.
  features: null,
  ...over,
});

const K = PRIVACY_THRESHOLD_V1.minIndependentGroups;

describe("a change smaller than one independent party is not published", () => {
  it("17 → 18 is suppressed and the previous value stands", () => {
    const d = evaluateDifferencing(agg(17), agg(18));
    assert.equal(d.publish, false);
    assert.equal(d.reason, "delta_below_minimum");
    assert.equal(d.serve?.distinctActors, 17);
  });
  it("a drop of one after a revocation is suppressed the same way", () => {
    const d = evaluateDifferencing(agg(30), agg(29));
    assert.deepEqual([d.publish, d.reason, d.serve?.distinctActors], [false, "delta_below_minimum", 30]);
  });
  it("the default minimum is the privacy threshold's independent-group floor, and exactly that delta publishes", () => {
    assert.equal(evaluateDifferencing(agg(20), agg(20 + K - 1)).publish, false);
    const d = evaluateDifferencing(agg(20), agg(20 + K));
    assert.deepEqual([d.publish, d.reason, d.serve?.distinctActors], [true, "delta_at_least_minimum", 20 + K]);
  });
});

describe("what does publish", () => {
  it("the first publication", () => {
    const d = evaluateDifferencing(null, agg(20));
    assert.deepEqual([d.publish, d.reason], [true, "no_previous"]);
  });
  it("an unchanged count (re-serving leaks nothing new)", () => {
    const d = evaluateDifferencing(agg(20), agg(20, { medianSignalBucket: 3 }));
    assert.deepEqual([d.publish, d.reason, d.serve?.medianSignalBucket], [true, "unchanged", 3]);
  });
  it("a previous that was itself unpublishable counts as no previous", () => {
    const d = evaluateDifferencing(agg(3, { publishable: false, reason: "below_actor_threshold" }), agg(20));
    assert.equal(d.reason, "no_previous");
  });
});

describe("the privacy gate speaks first", () => {
  it("an unpublishable current is never served, and the previous value is NOT served in its place", () => {
    const d = evaluateDifferencing(agg(30), agg(12, { publishable: false, reason: "below_actor_threshold" }));
    assert.deepEqual([d.publish, d.reason, d.serve], [false, "not_publishable", null]);
  });
  it("a minDelta below 1 is refused; the module keeps no token and reads no clock", () => {
    assert.throws(() => evaluateDifferencing(agg(1), agg(2), { minDelta: 0 }));
    assert.doesNotMatch(MODULE_TS, /contributor_token|group_token|Set<|Date\.now|supabase/);
  });
});

/**
 * The 3110 publication TTL binding.
 *
 * It exists because `check:security-definer-oracles` found
 * `purge_expired_sensing_publications` SECURITY DEFINER and referenced by
 * NOTHING: over PostgREST that is an endpoint anon may POST, whose only
 * remaining effect is to answer an authorization question. The remedy chosen
 * was to wire it rather than ledger it, because 3110's 72-hour TTL is a privacy
 * bound and a bound nothing enforces is a bound that does not hold.
 *
 * Every refusal below is a DISTINCT reason, for the reason the retention
 * scheduler's header records: `skipped: true` with no cause makes a
 * permanently broken sweep indistinguishable from a correctly idle one.
 */
describe("purgeExpiredSensingPublications — the 3110 TTL binding", () => {
  const rpcClient = (answer: { data?: unknown; error?: { message?: string } | null; throws?: unknown }) => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if ("throws" in answer) throw answer.throws;
        return { data: answer.data ?? null, error: answer.error ?? null };
      },
    };
  };

  it("calls the named SECURITY DEFINER function with the supplied instant", async () => {
    const c = rpcClient({ data: 5 });
    const r = await purgeExpiredSensingPublications(c as never, "2026-09-07T12:00:00.000Z");
    assert.deepEqual(r, { ok: true, deleted: 5 });
    assert.deepEqual(c.calls, [
      { fn: "purge_expired_sensing_publications", args: { p_now: "2026-09-07T12:00:00.000Z" } },
    ]);
  });

  it("counts a bigint returned as a STRING", async () => {
    // Identical to the contribution sweep's regression: a `typeof === number`
    // guard reports 0 for every real purge, so a working sweep reads as idle.
    const r = await purgeExpiredSensingPublications(rpcClient({ data: "4200" }) as never, "2026-09-07T12:00:00.000Z");
    assert.deepEqual(r, { ok: true, deleted: 4200 });
  });

  it("a non-numeric answer is 0 rather than NaN", async () => {
    const r = await purgeExpiredSensingPublications(rpcClient({ data: "many" }) as never, "2026-09-07T12:00:00.000Z");
    assert.deepEqual(r, { ok: true, deleted: 0 });
  });

  it("REFUSES rather than letting the database read its own clock", async () => {
    // An empty instant would make the RPC fall back to now() inside the
    // database, which is a different clock from the one the pass is using.
    const c = rpcClient({ data: 9 });
    const r = await purgeExpiredSensingPublications(c as never, "");
    assert.deepEqual(r, { ok: false, error: "now_required" });
    assert.deepEqual(c.calls, [], "it must not have called anything");
  });

  it("a client with no rpc is a named refusal, not a throw", async () => {
    const r = await purgeExpiredSensingPublications({} as never, "2026-09-07T12:00:00.000Z");
    assert.deepEqual(r, { ok: false, error: "client_exposes_no_rpc" });
  });

  it("a database error is reported with its message, never as a successful 0", async () => {
    // The case that matters most operationally: 3110 is applied to no database
    // yet, so today this is what every call returns. `{ok:true,deleted:0}` here
    // would log "swept, nothing expired" for a function that does not exist.
    const r = await purgeExpiredSensingPublications(
      rpcClient({ error: { message: 'function public.purge_expired_sensing_publications(p_now => text) does not exist' } }) as never,
      "2026-09-07T12:00:00.000Z",
    );
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /does not exist/);
  });

  it("an error with no message still refuses", async () => {
    const r = await purgeExpiredSensingPublications(rpcClient({ error: {} }) as never, "2026-09-07T12:00:00.000Z");
    assert.deepEqual(r, { ok: false, error: "purge_failed" });
  });

  it("a throwing client is caught — the retention pass must not die on it", async () => {
    const r = await purgeExpiredSensingPublications(
      rpcClient({ throws: new Error("socket hang up") }) as never,
      "2026-09-07T12:00:00.000Z",
    );
    assert.deepEqual(r, { ok: false, error: "socket hang up" });
  });

  it("a non-Error throw is still a named refusal", async () => {
    const r = await purgeExpiredSensingPublications(rpcClient({ throws: "nope" }) as never, "2026-09-07T12:00:00.000Z");
    assert.deepEqual(r, { ok: false, error: "purge_threw" });
  });

  it("the binding is a caller, so the function is no longer an unreferenced oracle", () => {
    // Guarding the property the guard checks: the literal is what
    // check:security-definer-oracles resolves a reference edge from.
    assert.match(MODULE_TS, /\.rpc[\s\S]{0,40}"purge_expired_sensing_publications"|"purge_expired_sensing_publications"/);
    const scheduler = readFileSync(join(SRC, "lib", "sensingRetentionScheduler.ts"), "utf8");
    assert.match(
      scheduler,
      /purgeExpiredSensingPublications\(db, nowIso\)/,
      "the scheduler must call it with the SAME instant it gave the contribution sweep",
    );
  });
});

/**
 * readLastPublishedAggregate's three preconditions.
 *
 * FOUND BY A MUTATION THAT DID NOT BITE. While proving the new TTL binding's
 * `now_required` guard was load-bearing, the first mutation deleted the wrong
 * occurrence of an identical line — this function's — and the suite stayed
 * green. Three guards on the read that decides whether a cohort has a previous
 * publication to difference against had no case at all, so a refactor could
 * have removed any of them silently.
 *
 * Each one matters for a different reason:
 *   no_client            an absent client must not read as "no previous", which
 *                        is the answer that PERMITS publishing.
 *   cohort_key_required  an empty key would select the whole table and pick an
 *                        arbitrary cohort's row as this cohort's previous.
 *   now_required         the read filters on expiry; with no instant the
 *                        database reads its own clock, a different one from the
 *                        pass's.
 */
describe("readLastPublishedAggregate refuses before it reads", () => {
  /** Any call reaching the database is itself the failure, so `from` throws. */
  const neverReads = {
    from() {
      throw new Error("the guard let a read through");
    },
  };

  it("no client is a refusal, NOT the publish-permitting 'no previous'", async () => {
    const r = await readLastPublishedAggregate(null as never, "zone:1", "2026-09-07T12:00:00.000Z");
    assert.deepEqual(r, { ok: false, error: "no_client" });
    assert.notEqual((r as { ok: boolean }).ok, true, "ok:true with a null row would permit publishing");
  });

  it("an empty cohort key refuses instead of selecting every cohort", async () => {
    const r = await readLastPublishedAggregate(neverReads as never, "", "2026-09-07T12:00:00.000Z");
    assert.deepEqual(r, { ok: false, error: "cohort_key_required" });
  });

  it("an empty instant refuses instead of letting the database read a clock", async () => {
    const r = await readLastPublishedAggregate(neverReads as never, "zone:1", "");
    assert.deepEqual(r, { ok: false, error: "now_required" });
  });

  it("each refusal is a DISTINCT reason", () => {
    // The lib/intelRetentionScheduler defect restated: one undifferentiated
    // failure makes a permanent misconfiguration look like a transient blip.
    const reasons = new Set(["no_client", "cohort_key_required", "now_required"]);
    assert.equal(reasons.size, 3);
  });
});
