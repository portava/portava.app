/**
 * §22.1 snapshot contract and §22.2 deterministic replay (census-trips TR89).
 *
 * WHAT PROVES §22.2 AND WHAT DOES NOT
 * ===================================
 * §22.2 says "Engineering can replay a Trip from a snapshot plus ordered events
 * and compare resulting canonical/projection state." That is a PROPERTY of a
 * fold — fold(seed, 1..n) = fold(snapshot_at_k, k+1..n) — and the only way to
 * establish it is to compute both and compare. `trip_snapshot_verify_replay`
 * does exactly that, and db/harness/probe_snapshot_replay.sql runs it at EVERY
 * cut point of a real seven-event trip, not one convenient version.
 *
 * This file cannot do that: it reads SQL as text. What it pins is the set of
 * properties that make the harness's result meaningful — one fold rather than
 * two, IMMUTABLE rather than table-reading, an explicit order rather than the
 * planner's, and an unknown event counted rather than dropped. A fold that lost
 * any of those could still pass the harness on a lucky day.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TRIP_EVENT_TYPES } from "../lib/tripKernel.js";

const sql = readFileSync(
  new URL("../migrations/2773_trip_snapshot_fold_and_replay.sql", import.meta.url),
  "utf8",
);

describe("§22.2 — the fold is the kind of thing a replay proof can be about", () => {
  it("there is exactly ONE fold, and both replay paths go through it", () => {
    // Two folds would make the property vacuous: it would compare one
    // implementation with itself under two names, or two implementations that
    // could drift.
    const defs = sql.match(/CREATE OR REPLACE FUNCTION public\.trip_snapshot_fold\(/g) ?? [];
    assert.equal(defs.length, 1, "more than one fold definition");
    assert.match(sql, /public\.trip_snapshot_fold_all\(\s*\n?\s*p_from,\s*\n?\s*array_agg/,
      "the range replay does not go through the fold");
    assert.match(sql, /s := public\.trip_snapshot_fold\(s, e\);/,
      "fold_all does not call the single fold");
  });

  it("the fold reads events, never a table", () => {
    // A snapshot built from current tables agrees with them by construction and
    // says nothing about the event log it is supposed to be a projection of.
    const fold = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.trip_snapshot_fold(p_state jsonb, p_event jsonb)"),
      sql.indexOf("COMMENT ON FUNCTION public.trip_snapshot_fold(jsonb, jsonb)"),
    );
    for (const table of ["trip_stages", "trip_plan_items", "trip_commitments",
                         "trip_members", "trip_risks", "trip_plan_participants", "trips"]) {
      assert.ok(!fold.includes(`public.${table}`),
        `the fold reads public.${table}; it must read only the event it is given`);
    }
  });

  it("the fold is IMMUTABLE, and the migration refuses if it stops being", () => {
    assert.match(sql, /LANGUAGE plpgsql\nIMMUTABLE/, "the fold is not declared IMMUTABLE");
    assert.match(sql, /expected 3 IMMUTABLE fold functions, found/,
      "nothing checks the volatility after apply, so a later ALTER could relax it silently");
  });

  it("contains no clock, no randomness and no nullable-ordered scan", () => {
    const fold = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.trip_snapshot_fold(p_state jsonb, p_event jsonb)"),
      sql.indexOf("COMMENT ON FUNCTION public.trip_snapshot_fold(jsonb, jsonb)"),
    );
    assert.ok(!/\bnow\(\)/.test(fold), "the fold calls now()");
    assert.ok(!/random\(\)|gen_random_uuid\(\)|clock_timestamp\(\)/.test(fold),
      "the fold is nondeterministic");
    // Every ORDER BY inside the fold must break ties on a total order, or two
    // rows with equal sort keys could come back either way round.
    for (const m of fold.matchAll(/ORDER BY ([^\n]+)\n/g)) {
      assert.match(m[1], /e\.key/,
        `ORDER BY ${m[1].trim()} has no total-order tiebreak, so it can return either row`);
    }
  });

  it("takes an ordered ARRAY rather than aggregating an unordered set", () => {
    assert.match(sql, /array_agg\(jsonb_build_object\('type', e\.type,[\s\S]*?ORDER BY e\.sequence\)/,
      "the replay's ORDER BY is not inside the aggregate, so the order is the planner's choice");
  });
});

describe("§22.1 — the contract says what it does not know", () => {
  it("free_window_summary is present and declares itself unavailable", () => {
    // Absent reads as "no free windows". Empty reads as "computed, found none".
    // Both are false, and both are indistinguishable from the truth, which is
    // that §7's engine does not exist (census-trips TR128/TR134).
    assert.match(sql, /'free_window_summary', jsonb_build_object\('available', false, 'reason', 'SECTION_7_ENGINE_ABSENT'\)/);
    assert.match(sql, /free_window_summary does not declare itself unavailable/,
      "no postcondition holds it to that");
  });

  it("source_refs likewise", () => {
    assert.match(sql, /'source_refs',\s*jsonb_build_object\('available', false, 'reason', 'NOT_CARRIED_BY_EVENTS'\)/);
  });

  it("an unknown event type is COUNTED, not dropped", () => {
    // A fold that ignores what it does not understand produces a state that is
    // incomplete and indistinguishable from complete.
    assert.match(sql, /'unfolded'/);
    assert.match(sql, /an unknown event type is not counted under unfolded/,
      "no postcondition proves the counting works");
  });
});

describe("§22.2 — the verifier is usable when it fails", () => {
  it("names the differing keys rather than returning a bare false", () => {
    assert.match(sql, /'differing_keys'/);
    // Matched on the CONSTRUCT, not on prose a reflow can break in half: the
    // diff must actually compare the two states key by key.
    assert.match(sql, /full_state->k IS DISTINCT FROM tail->k/,
      "differing_keys is present but does not compare the two states per key");
  });

  it("distinguishes 'no snapshot' from 'no events' from 'not equal'", () => {
    for (const reason of ["TRIP_SNAPSHOT_NOT_FOUND", "TRIP_SNAPSHOT_NO_EVENTS"]) {
      assert.ok(sql.includes(reason), `${reason} is not a distinct outcome`);
    }
  });

  it("neither the writer nor the verifier is reachable by a client role", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.trip_snapshot_write\(uuid, bigint\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.trip_snapshot_verify_replay\(uuid, bigint\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /a client role can EXECUTE trip_snapshot_write/,
      "no postcondition checks the revoke took");
  });

  it("is idempotent per (trip, version), so an overlapping scheduler writes one", () => {
    assert.match(sql, /ON CONFLICT \(trip_id, aggregate_version\) DO NOTHING/);
  });
});

describe("the fold covers the event vocabulary that exists", () => {
  it("every TRIP_EVENT_TYPE is either folded or explicitly a no-op", () => {
    // The point is that nothing falls through to `unfolded` by accident. A type
    // the snapshot genuinely does not care about must be named in the CASE as a
    // NULL branch, so the decision is visible.
    // Named in the CASE — including as an explicit NULL branch, which is how
    // "the snapshot does not carry this" gets said out loud. trip.presence_* is
    // the live example: §10.2 forbids replaying a stale observation as current.
    const missing = (TRIP_EVENT_TYPES as readonly string[]).filter((t) => !sql.includes(`'${t}'`));
    assert.deepEqual(missing, [],
      `these event types are not named in the fold and would land in 'unfolded': ${missing.join(", ")}`);
  });
});
