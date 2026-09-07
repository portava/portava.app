/**
 * sensingPresenceState — §19's PresenceObservation for the anonymous path:
 * aggregate zone activity + coverage, with §5.1 truth metadata.
 *
 * The invariants: no coverage ≠ quiet (no `absent` value exists), one device ≠
 * a crowd (only a gate-cleared cohort is observed), no person identity (no
 * token, no count), inference ≠ observation (never `inferred`), stale ≠
 * current.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSensingPresenceState } from "../lib/sensingPresenceState.js";
import type { SensingCohortAggregate } from "../lib/sensingCoverageAggregate.js";
import { MIN_BAND_FOR_LIVE_STATE, PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import { sensingTimeBucket } from "../lib/sensingAnonStore.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TS = readFileSync(join(SRC, "lib", "sensingPresenceState.ts"), "utf8");
/** The module with block and line comments removed — prose may name what code may not. */
const CODE = MODULE_TS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const NOW = Date.UTC(2026, 8, 7, 22, 10, 0);
const BUCKET = sensingTimeBucket(NOW - 5 * 60_000); // the bucket in progress
const BUCKET_MS = PRIVACY_THRESHOLD_V1.timeBucketMinutes * 60_000;

function agg(over: Partial<SensingCohortAggregate> = {}): SensingCohortAggregate {
  return {
    publishable: true,
    reason: null,
    distinctActors: 20,
    distinctGroups: 6,
    maxGroupShare: 0.2,
    contributions: 20,
    observedAt: new Date(NOW - 12 * 60_000).toISOString(),
    medianSignalBucket: 3,
    ...over,
  };
}

const build = (a: SensingCohortAggregate, over: Record<string, unknown> = {}) =>
  buildSensingPresenceState({ zoneId: "zone-alpha", timeBucket: BUCKET, aggregate: a, nowMs: NOW, ...over });

describe("no coverage ≠ quiet", () => {
  it("a sub-k cohort is UNKNOWN on every axis — no ordinal, no coverage, no number", () => {
    const s = build(agg({ publishable: false, reason: "below_actor_threshold", distinctActors: 3, medianSignalBucket: null }));
    assert.equal(s.presence, "unknown");
    assert.equal(s.activityOrdinal, null);
    assert.equal(s.coverage, "unknown");
    assert.equal(s.truthClass, "unknown");
    assert.equal(s.confidence, "unverified");
    assert.equal(s.freshness, "unknown");
    assert.equal(s.provenance.withheld, "below_actor_threshold");
  });

  it("a failed read is the SAME unknown state at the surface; the reason travels only in provenance", () => {
    const failed = build(agg({ publishable: false, reason: "read_failed", distinctActors: 0, medianSignalBucket: null }));
    const subK = build(agg({ publishable: false, reason: "single_group_dominates", medianSignalBucket: null }));
    const strip = ({ provenance: _p, ...rest }: any) => rest;
    assert.deepEqual(strip(failed), strip(subK));
    assert.equal(failed.provenance.withheld, "read_failed");
  });

  it("the type has no absent / quiet value — the invariant is unrepresentable-if-violated", () => {
    assert.match(CODE, /presence: "observed" \| "unknown";/);
    assert.doesNotMatch(CODE, /"(absent|quiet|empty|nobody)"/);
  });

  it("a missing aggregate is unknown, not a throw and not observed", () => {
    const s = build(null as never);
    assert.equal(s.presence, "unknown");
    assert.equal(s.provenance.withheld, "read_failed");
  });
});

describe("a gate-cleared cohort", () => {
  it("is OBSERVED with the median ordinal, few coverage, the live floor band and live freshness", () => {
    const s = build(agg());
    assert.equal(s.presence, "observed");
    assert.equal(s.activityOrdinal, 3);
    assert.equal(s.coverage, "few"); // 20 < 25
    assert.equal(s.truthClass, "observed");
    assert.equal(s.confidence, MIN_BAND_FOR_LIVE_STATE);
    assert.equal(s.freshness, "recent"); // observed 12 min ago
    assert.equal(s.provenance.withheld, null);
    assert.equal(s.windowEnd, new Date(Date.parse(BUCKET) + BUCKET_MS).toISOString());
  });

  it("several / many independent contributors CORROBORATE", () => {
    assert.equal(build(agg({ distinctActors: 40 })).truthClass, "corroborated");
    assert.equal(build(agg({ distinctActors: 40 })).coverage, "several");
    assert.equal(build(agg({ distinctActors: 150 })).coverage, "many");
  });

  it("is never `inferred` — nothing here infers", () => {
    for (const n of [15, 30, 200]) assert.notEqual(build(agg({ distinctActors: n })).truthClass, "inferred");
  });

  it("carries an unlabelled ordinal, never a word for it", () => {
    assert.doesNotMatch(CODE, /"(busy|packed|dead|quiet|lively|crowded)"/);
    assert.equal(build(agg({ medianSignalBucket: null })).activityOrdinal, null);
  });
});

describe("stale ≠ current", () => {
  it("a window five hours old is STALE, and drops to provisional confidence", () => {
    const oldBucket = sensingTimeBucket(NOW - 5 * 3600_000);
    const s = build(agg({ observedAt: new Date(NOW - 5 * 3600_000 + 60_000).toISOString() }), { timeBucket: oldBucket });
    assert.equal(s.presence, "observed");
    assert.equal(s.truthClass, "stale");
    assert.equal(s.confidence, "provisional");
    assert.ok(s.freshness === "stale" || s.freshness === "historical");
  });

  it("freshness measures the observation, capped at the window's end — never the moment the state was built", () => {
    // An arrival timestamp after the window closed cannot make a closed window fresher than its close.
    const oldBucket = sensingTimeBucket(NOW - 3 * 3600_000);
    const s = build(agg({ observedAt: new Date(NOW - 60_000).toISOString() }), { timeBucket: oldBucket });
    assert.notEqual(s.freshness, "live");
  });
});

describe("no person identity", () => {
  it("the serialised state names no token, count or contributor, and the module reads no store", () => {
    const s = build(agg({ distinctActors: 37, distinctGroups: 9 }));
    const json = JSON.stringify(s);
    assert.doesNotMatch(json, /token|actor|contributor_|group_/);
    assert.doesNotMatch(json, /\b37\b|\b9\b/); // the exact counts do not leave the aggregate
    for (const k of Object.keys(s)) assert.doesNotMatch(k, /token|actor|count|contributor|group/i);
    assert.doesNotMatch(MODULE_TS, /supabase|getServiceClient|\.from\(|\.rpc\(|Date\.now\(/);
  });

  it("throws only on a malformed bucket instant (a programming error), never on data", () => {
    assert.throws(() => build(agg(), { timeBucket: "not-a-date" }));
    assert.throws(() => build(agg(), { zoneId: "" }));
  });
});
