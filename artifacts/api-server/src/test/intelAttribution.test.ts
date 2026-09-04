/**
 * I4a — attribution (Table 22) + the §15 scope key + the trust formula, pure;
 * and the attribution JOB against a fake client.
 *
 * Proves:
 *   * the Table-22 weights are exact, the counterfactual answer discounts to the
 *     pre-committed band, and multi-touch weights normalize to Σ ≤ 1.0;
 *   * a contradiction (worse / could_not_enter) is recorded as a row flag — the
 *     claim is never touched;
 *   * the scope key is geography × claim_family × time_band × traveler_mode ×
 *     season, with local time from longitude and season from hemisphere;
 *   * trust_next = clamp(prev + lr*(score − expected)*weight, 0, 100) exactly;
 *   * the job is flag-gated, joins an outcome to the served claim's admissible,
 *     in-window input observations, writes once per outcome (anti-join + 23505
 *     replay), and reports unattributable/contradiction counts honestly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TOUCH_WEIGHT, PRE_COMMITTED_WEIGHT_MAX, OUTCOME_SCORE, CONTRADICTING_OUTCOMES,
  touchWeight, normalizeAttribution, isContradiction, expectedAccuracyOf, deriveAttributions,
  ATTRIBUTION_ALGORITHM_VERSION,
} from "../lib/intelAttribution.js";
import {
  claimFamilyOf, geographyOf, localHourOf, timeBandOf, seasonOf, buildScopeKey, parseScopeKey, scopeFor,
  updateScopedTrust, DEFAULT_LEARNING_RATE, DEFAULT_SCOPED_TRUST, signalForAttribution, deriveScopedBadges,
  TRUST_SIGNALS, TRUST_SIGNAL_EFFECT, CONFIDENT_CLAIM_THRESHOLD, BADGE_MIN_OUTCOMES,
} from "../lib/intelScopedTrust.js";
import { runIntelAttributionPass, setTrustApplier, ATTRIBUTION_FLAG } from "../lib/intelAttributionScheduler.js";
import { INTEL_OUTCOMES } from "../lib/intelOutcomes.js";

const REPORTER = "11111111-1111-4111-8111-111111111111";
const CONTRIB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CONTRIB_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const SUBJECT = "22222222-2222-4222-8222-222222222222";
const SNAP = "33333333-3333-4333-8333-333333333333";
const CLAIM = "44444444-4444-4444-8444-444444444444";
const OBS_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const OBS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const OBS_OLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
const OBS_BLOCKED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
const OBS_OTHER_TYPE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";

const NOW = new Date("2026-09-04T16:00:00.000Z");       // 23:00 in Da Nang (UTC+7)
const SERVED = "2026-09-04T15:30:00.000Z";               // 22:30 local
const OBSERVED_A = "2026-09-04T15:10:00.000Z";           // 20 min before served
const OBSERVED_B = "2026-09-04T14:00:00.000Z";           // 90 min before (inside 120-min hard expiry)
const OBSERVED_OLD = "2026-09-04T12:00:00.000Z";         // 3.5 h before (outside)

const outcomeEvent = (over: Record<string, unknown> = {}, payloadOver: Record<string, unknown> = {}) => ({
  id: "ev-1", actor_id: REPORTER, occurred_at: NOW.toISOString(), confidence: 0.8,
  payload: {
    intel: { snapshot_id: SNAP, claim_id: CLAIM, subject_id: SUBJECT, outcome: "same", served_at: SERVED },
    touch: "go_tap",
    ...payloadOver,
  },
  verb: "completion",
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Table 22 — touch weights and normalization", () => {
  it("the five weights are exact", () => {
    assert.deepEqual(TOUCH_WEIGHT, { direct_paid_answer: 1.0, go_tap: 0.7, compass_explanation: 0.3, impression: 0.0, pre_committed: 0.05 });
    assert.equal(PRE_COMMITTED_WEIGHT_MAX, 0.10, "Action already committed before exposure: 0.00–0.10");
  });
  it("the counterfactual 'same choice anyway' discounts to the pre-committed band, never raises", () => {
    assert.equal(touchWeight("go_tap", true), 0.10);
    assert.equal(touchWeight("direct_paid_answer", true), 0.10);
    assert.equal(touchWeight("impression", true), 0.0);
    assert.equal(touchWeight("pre_committed", true), 0.05);
    assert.equal(touchWeight("go_tap", false), 0.7);
    assert.equal(touchWeight("go_tap"), 0.7);
  });
  it("multi-touch weights normalize so Σ ≤ 1.0 per outcome (equal split; explicit shares)", () => {
    const eq = normalizeAttribution(0.7, [{ observationId: "a", actorId: "x" }, { observationId: "b", actorId: "y" }]);
    assert.equal(eq.get("a"), 0.35); assert.equal(eq.get("b"), 0.35);
    const shares = normalizeAttribution(1.0, [{ observationId: "a", actorId: "x", share: 3 }, { observationId: "b", actorId: "y", share: 1 }]);
    assert.equal(shares.get("a"), 0.75); assert.equal(shares.get("b"), 0.25);
    const over = normalizeAttribution(5, [{ observationId: "a", actorId: "x" }]);
    assert.equal(over.get("a"), 1, "a weight above 1 is capped at 1");
    assert.equal(normalizeAttribution(0.7, []).size, 0);
    const sum = [...normalizeAttribution(1, Array.from({ length: 7 }, (_, i) => ({ observationId: `o${i}`, actorId: "x" }))).values()].reduce((a, b) => a + b, 0);
    assert.ok(sum <= 1.0001, `Σ=${sum}`);
  });
});

describe("outcome grading and contradictions", () => {
  it("every Appendix-A outcome has a grade; did_not_go carries none", () => {
    for (const o of INTEL_OUTCOMES) assert.ok(o in OUTCOME_SCORE, o);
    assert.equal(OUTCOME_SCORE.same, 1);
    assert.equal(OUTCOME_SCORE.did_not_go, null);
    assert.ok(OUTCOME_SCORE.worse! < OUTCOME_SCORE.better!);
  });
  it("worse and could_not_enter contradict the served state; nothing else does", () => {
    assert.deepEqual([...CONTRADICTING_OUTCOMES], ["worse", "could_not_enter"]);
    for (const o of INTEL_OUTCOMES) assert.equal(isContradiction(o), o === "worse" || o === "could_not_enter", o);
  });
  it("expected accuracy is the served confidence clamped to 0..1, null when absent", () => {
    assert.equal(expectedAccuracyOf(0.8), 0.8);
    assert.equal(expectedAccuracyOf(1.7), 1);
    assert.equal(expectedAccuracyOf(null), null);
    assert.equal(expectedAccuracyOf("0.8"), null);
  });
  it("deriveAttributions writes one row per contributing observation with the contradiction flag", () => {
    const rows = deriveAttributions({
      outcomeEventId: "ev-1",
      outcome: { snapshot_id: SNAP, claim_id: CLAIM, subject_id: SUBJECT, outcome: "worse", served_at: SERVED },
      touch: "go_tap", counterfactualSameChoice: false, servedConfidence: 0.9,
      contributions: [{ observationId: OBS_A, actorId: CONTRIB_A }, { observationId: OBS_B, actorId: CONTRIB_B }],
      scopeKey: "geo=vn:da_nang|fam=crowd|band=evening|mode=solo|season=summer", computedAt: NOW,
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      outcome_event_id: "ev-1", claim_id: CLAIM, observation_id: OBS_A, actor_id: CONTRIB_A,
      touch: "go_tap", weight: 0.35, outcome: "worse", outcome_score: 0.1, expected_accuracy: 0.9,
      counterfactual: false, contradiction: true,
      scope_key: "geo=vn:da_nang|fam=crowd|band=evening|mode=solo|season=summer",
      algorithm_version: ATTRIBUTION_ALGORITHM_VERSION, computed_at: NOW.toISOString(),
    });
    assert.equal(deriveAttributions({
      outcomeEventId: "ev-2", outcome: { snapshot_id: SNAP, claim_id: CLAIM, subject_id: SUBJECT, outcome: "same", served_at: SERVED },
      touch: "go_tap", servedConfidence: 0.5, contributions: [], scopeKey: "k", computedAt: NOW,
    }).length, 0, "nothing to attribute ⇒ no placeholder row");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("§15 scope key — geography × claim_family × time_band × traveler_mode × season", () => {
  it("claim family is the taxonomy prefix", () => {
    assert.equal(claimFamilyOf("crowd.level"), "crowd");
    assert.equal(claimFamilyOf("access.walk_in"), "access");
    assert.equal(claimFamilyOf("vibe"), "vibe");
    assert.equal(claimFamilyOf(""), "unknown");
  });
  it("geography is a city label, never a coordinate", () => {
    assert.equal(geographyOf({ country_code: "VN", city: "Da Nang" }), "vn:da_nang");
    assert.equal(geographyOf({ country_code: null, city: null }), "unknown");
    assert.equal(geographyOf(null), "unknown");
  });
  it("time band uses local time from longitude (Da Nang 108°E ⇒ UTC+7)", () => {
    assert.equal(localHourOf(SERVED, 108.2), 22);
    assert.equal(timeBandOf(SERVED, 108.2), "evening");
    assert.equal(timeBandOf("2026-09-04T19:30:00.000Z", 108.2), "late_night", "02:30 local");
    assert.equal(timeBandOf(SERVED, null), "afternoon", "no longitude ⇒ UTC (15:30)");
    assert.equal(timeBandOf("garbage", 0), null);
  });
  it("season flips with the hemisphere", () => {
    assert.equal(seasonOf("2026-09-04T00:00:00Z", 16.0), "autumn");
    assert.equal(seasonOf("2026-09-04T00:00:00Z", -33.8), "spring");
    assert.equal(seasonOf("2026-01-10T00:00:00Z", null), "winter", "unknown latitude ⇒ northern");
  });
  it("build/parse round-trips and fails closed on drift", () => {
    const s = scopeFor({ place: { country_code: "VN", city: "Da Nang", latitude: 16.05, longitude: 108.2 }, claimType: "crowd.level", servedAt: SERVED, travelerMode: "group" });
    const key = buildScopeKey(s);
    assert.equal(key, "geo=vn:da_nang|fam=crowd|band=evening|mode=group|season=autumn");
    assert.deepEqual(parseScopeKey(key), s);
    assert.equal(parseScopeKey("geo=x|fam=y"), null);
    assert.equal(parseScopeKey("geo=x|fam=y|band=noon|mode=solo|season=summer"), null);
  });
  it("every dimension has a stated default (a scope is a bucket, not a gate)", () => {
    const s = scopeFor({ place: null, claimType: "queue.wait", servedAt: "not-a-date" });
    assert.deepEqual(s, { geography: "unknown", claimFamily: "queue", timeBand: "evening", travelerMode: "unknown", season: "summer" });
  });
});

describe("§15 trust update — the formula, exactly", () => {
  it("trust_next = clamp(trust_prev + lr*(score − expected)*weight, 0, 100)", () => {
    assert.equal(updateScopedTrust(50, { outcomeScore: 1.0, expectedAccuracy: 0.8, evidenceWeight: 0.7 }), 50 + DEFAULT_LEARNING_RATE * 0.2 * 0.7);
    assert.equal(updateScopedTrust(50, { outcomeScore: 0.1, expectedAccuracy: 0.9, evidenceWeight: 1, learningRate: 10 }), 42);
    assert.equal(updateScopedTrust(50, { outcomeScore: 0.8, expectedAccuracy: 0.8, evidenceWeight: 1 }), 50, "accurate-as-claimed moves nothing");
  });
  it("clamps to [0, 100]", () => {
    assert.equal(updateScopedTrust(99, { outcomeScore: 1, expectedAccuracy: 0, evidenceWeight: 1, learningRate: 50 }), 100);
    assert.equal(updateScopedTrust(1, { outcomeScore: 0, expectedAccuracy: 1, evidenceWeight: 1, learningRate: 50 }), 0);
  });
  it("fails closed: a non-finite input leaves trust unchanged; an unknown prev starts neutral", () => {
    assert.equal(updateScopedTrust(60, { outcomeScore: Number.NaN, expectedAccuracy: 0.5, evidenceWeight: 1 }), 60);
    assert.equal(updateScopedTrust(Number.NaN, { outcomeScore: Number.NaN, expectedAccuracy: 0.5, evidenceWeight: 1 }), DEFAULT_SCOPED_TRUST);
  });
});

describe("Table 23 — signals and read-only badges", () => {
  it("all seven Table-23 signals are described, and only fabrication invalidates lineage", () => {
    assert.equal(TRUST_SIGNALS.length, 7);
    for (const s of TRUST_SIGNALS) assert.ok(s in TRUST_SIGNAL_EFFECT, s);
    assert.equal(TRUST_SIGNAL_EFFECT.fabrication_or_manipulation.invalidatesLineage, true);
    assert.equal(TRUST_SIGNALS.filter((s) => TRUST_SIGNAL_EFFECT[s].invalidatesLineage).length, 1);
    assert.equal(TRUST_SIGNAL_EFFECT.materially_incorrect_confident.accuracy, "negative");
    assert.equal(TRUST_SIGNAL_EFFECT.materially_incorrect_confident.calibration, "negative");
    assert.equal(TRUST_SIGNAL_EFFECT.honest_correction_before_harm.conduct, "positive");
    assert.equal(TRUST_SIGNAL_EFFECT.undisclosed_relationship.bridgeSeverity, "serious");
  });
  it("an attribution carries outcome_success / materially_incorrect_confident / calibrated_uncertainty / none", () => {
    assert.equal(signalForAttribution({ outcome: "same", contradiction: false, expectedAccuracy: 0.9 }), "outcome_success");
    assert.equal(signalForAttribution({ outcome: "worse", contradiction: true, expectedAccuracy: CONFIDENT_CLAIM_THRESHOLD }), "materially_incorrect_confident");
    assert.equal(signalForAttribution({ outcome: "worse", contradiction: true, expectedAccuracy: 0.4 }), "calibrated_uncertainty");
    assert.equal(signalForAttribution({ outcome: "did_not_go", contradiction: false, expectedAccuracy: 0.9 }), null);
  });
  it("badges are derived read-only and never from fewer than the minimum outcomes", () => {
    assert.deepEqual(deriveScopedBadges({ trust: 95, outcomes: BADGE_MIN_OUTCOMES - 1, calibration_error: 0.05 }), []);
    assert.deepEqual(deriveScopedBadges({ trust: 72, outcomes: 10, calibration_error: 0.1 }), ["scoped_reliable", "scoped_calibrated"]);
    assert.deepEqual(deriveScopedBadges({ trust: 90, outcomes: 30, calibration_error: 0.5 }), ["scoped_reliable", "scoped_specialist"]);
    assert.deepEqual(deriveScopedBadges({ trust: 40, outcomes: 30, calibration_error: null }), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The job
// ═══════════════════════════════════════════════════════════════════════════
interface Seed {
  flags?: Record<string, boolean>;
  events?: any[];
  claims?: any[];
  observations?: any[];
  places?: any[];
  attributions?: any[];
  errorTable?: string;
}

function makeDb(seed: Seed) {
  const tables: Record<string, any[]> = {
    feature_flags: Object.entries(seed.flags ?? {}).map(([flag, enabled]) => ({ flag, enabled })),
    canonical_events: [...(seed.events ?? [])],
    intel_claims: [...(seed.claims ?? [])],
    intel_observations: [...(seed.observations ?? [])],
    places: [...(seed.places ?? [])],
    intel_attributions: [...(seed.attributions ?? [])],
  };
  let seq = 0;
  function from(table: string) {
    let op: "select" | "insert" = "select";
    let payload: any = null;
    let lim = Infinity;
    const filters: Array<{ col: string; val: any; kind: "eq" | "in" }> = [];
    const match = (r: any) => filters.every((f) => (f.kind === "in" ? (f.val as any[]).includes(r[f.col]) : r[f.col] === f.val));
    function run() {
      if (seed.errorTable === table) return { data: null, error: { message: "boom" } };
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        if (table === "intel_attributions") {
          const dup = rows.some((r) => store.some((s) => s.outcome_event_id === r.outcome_event_id && s.observation_id === r.observation_id && s.algorithm_version === r.algorithm_version));
          if (dup) return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        for (const r of rows) store.push({ id: `row-${++seq}`, ...r });
        return { data: null, error: null };
      }
      return { data: store.filter(match).slice(0, lim), error: null };
    }
    const b: any = {
      select() { return b; },
      insert(rows: any) { op = "insert"; payload = rows; return b; },
      eq(c: string, v: any) { filters.push({ col: c, val: v, kind: "eq" }); return b; },
      in(c: string, v: any[]) { filters.push({ col: c, val: v, kind: "in" }); return b; },
      order() { return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }
  return { from, _tables: tables };
}

const world = (over: Seed = {}): Seed => ({
  flags: { [ATTRIBUTION_FLAG]: true },
  events: [outcomeEvent()],
  claims: [{ id: CLAIM, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level" }],
  observations: [
    { id: OBS_A, actor_id: CONTRIB_A, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", observed_at: OBSERVED_A, moderation_state: "allowed" },
    { id: OBS_B, actor_id: CONTRIB_B, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", observed_at: OBSERVED_B, moderation_state: "pending" },
    { id: OBS_OLD, actor_id: CONTRIB_B, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", observed_at: OBSERVED_OLD, moderation_state: "allowed" },
    { id: OBS_BLOCKED, actor_id: CONTRIB_A, subject_id: SUBJECT, zone_id: null, claim_type: "crowd.level", observed_at: OBSERVED_A, moderation_state: "blocked" },
    { id: OBS_OTHER_TYPE, actor_id: CONTRIB_A, subject_id: SUBJECT, zone_id: null, claim_type: "queue.wait", observed_at: OBSERVED_A, moderation_state: "allowed" },
  ],
  places: [{ id: SUBJECT, city: "Da Nang", country_code: "VN", latitude: 16.05, longitude: 108.2 }],
  ...over,
});

describe("attribution job — flag-gated, joins outcomes to the served claim's inputs, writes once", () => {
  it("flag off ⇒ inert (no scan, no writes)", async () => {
    const db = makeDb(world({ flags: { [ATTRIBUTION_FLAG]: false } }));
    const r = await runIntelAttributionPass({ client: db, now: NOW });
    assert.equal(r.reason, "disabled");
    assert.equal(db._tables.intel_attributions.length, 0);
    assert.equal((await runIntelAttributionPass({ client: null })).reason, "no_client");
  });

  it("attributes ONE outcome to exactly the admissible, in-window input observations, weights Σ = touch weight", async () => {
    const db = makeDb(world());
    const r = await runIntelAttributionPass({ client: db, now: NOW });
    assert.equal(r.reason, null);
    assert.equal(r.events, 1);
    assert.equal(r.attributed, 1);
    assert.equal(r.rows, 2, "OBS_A + OBS_B; OLD (outside 120-min hard expiry), BLOCKED and OTHER_TYPE excluded");
    const rows = db._tables.intel_attributions;
    assert.deepEqual(rows.map((x) => x.observation_id).sort(), [OBS_A, OBS_B].sort());
    for (const x of rows) {
      assert.equal(x.outcome_event_id, "ev-1");
      assert.equal(x.claim_id, CLAIM);
      assert.equal(x.touch, "go_tap");
      assert.equal(x.weight, 0.35);
      assert.equal(x.outcome, "same");
      assert.equal(x.outcome_score, 1);
      assert.equal(x.expected_accuracy, 0.8, "from the event envelope's confidence");
      assert.equal(x.counterfactual, false);
      assert.equal(x.contradiction, false);
      assert.equal(x.scope_key, "geo=vn:da_nang|fam=crowd|band=evening|mode=unknown|season=autumn");
      assert.equal(x.algorithm_version, ATTRIBUTION_ALGORITHM_VERSION);
    }
    assert.equal(rows.find((x) => x.observation_id === OBS_A).actor_id, CONTRIB_A, "credited to the CONTRIBUTOR, never the reporter");
    assert.equal(r.contradictions, 0);
    assert.equal(r.unattributable, 0);
  });

  it("re-running writes nothing (anti-join) and reports the replay", async () => {
    const db = makeDb(world());
    await runIntelAttributionPass({ client: db, now: NOW });
    const second = await runIntelAttributionPass({ client: db, now: NOW });
    assert.equal(second.attributed, 0);
    assert.equal(second.replayed, 1);
    assert.equal(db._tables.intel_attributions.length, 2);
  });

  it("a lost race (rows appear between anti-join and insert ⇒ 23505) is a replay, not an error", async () => {
    const db = makeDb(world());
    // Pre-seed a row for OBS_A under the same version but bypass the anti-join by
    // giving it a different outcome_event_id lookup: emulate by inserting AFTER the
    // anti-join read — simplest faithful emulation is a second concurrent pass.
    const [a, b] = await Promise.all([
      runIntelAttributionPass({ client: db, now: NOW }),
      runIntelAttributionPass({ client: db, now: NOW }),
    ]);
    assert.equal(a.reason, null); assert.equal(b.reason, null);
    assert.equal(a.attributed + b.attributed, 1, "exactly one pass wins");
    assert.equal(a.replayed + b.replayed, 1, "the other sees the replay");
    assert.equal(db._tables.intel_attributions.length, 2);
  });

  it("the counterfactual answer discounts the weight; traveler_mode enters the scope", async () => {
    const db = makeDb(world({ events: [outcomeEvent({}, { counterfactual_same_choice: true, traveler_mode: "solo" })] }));
    await runIntelAttributionPass({ client: db, now: NOW });
    const rows = db._tables.intel_attributions;
    assert.equal(rows.length, 2);
    for (const x of rows) {
      assert.equal(x.weight, 0.05, "0.10 pre-committed cap split across two contributors");
      assert.equal(x.counterfactual, true);
      assert.ok(x.scope_key.includes("mode=solo"));
    }
  });

  it("a contradicting outcome is RECORDED (row flag + count) — the claim row is untouched", async () => {
    const db = makeDb(world({ events: [outcomeEvent({ id: "ev-w", confidence: 0.9 }, { intel: { snapshot_id: SNAP, claim_id: CLAIM, subject_id: SUBJECT, outcome: "could_not_enter", served_at: SERVED } })] }));
    const before = JSON.stringify(db._tables.intel_claims);
    const r = await runIntelAttributionPass({ client: db, now: NOW });
    assert.equal(r.contradictions, 1);
    for (const x of db._tables.intel_attributions) {
      assert.equal(x.contradiction, true);
      assert.equal(x.outcome_score, 0);
      assert.equal(x.expected_accuracy, 0.9);
    }
    assert.equal(JSON.stringify(db._tables.intel_claims), before, "no claim mutation");
  });

  it("an unknown touch is weight 0 (fail-closed), still a finalized row", async () => {
    const db = makeDb(world({ events: [outcomeEvent({}, { touch: "billboard" })] }));
    await runIntelAttributionPass({ client: db, now: NOW });
    for (const x of db._tables.intel_attributions) { assert.equal(x.touch, "impression"); assert.equal(x.weight, 0); }
  });

  it("no contributing observation / unknown claim ⇒ unattributable, no placeholder row", async () => {
    const none = makeDb(world({ observations: [] }));
    const r1 = await runIntelAttributionPass({ client: none, now: NOW });
    assert.equal(r1.unattributable, 1); assert.equal(none._tables.intel_attributions.length, 0);
    const noClaim = makeDb(world({ claims: [] }));
    const r2 = await runIntelAttributionPass({ client: noClaim, now: NOW });
    assert.equal(r2.unattributable, 1); assert.equal(noClaim._tables.intel_attributions.length, 0);
  });

  it("an event without the shared envelope is not an outcome; did_not_go is attributed with a null score", async () => {
    const db = makeDb(world({ events: [
      { id: "ev-plain", actor_id: REPORTER, occurred_at: NOW.toISOString(), confidence: null, payload: { surface: "discovery" }, verb: "completion" },
      outcomeEvent({ id: "ev-dng" }, { intel: { snapshot_id: SNAP, claim_id: CLAIM, subject_id: SUBJECT, outcome: "did_not_go", served_at: SERVED } }),
    ] }));
    const r = await runIntelAttributionPass({ client: db, now: NOW });
    assert.equal(r.events, 1);
    assert.equal(r.attributed, 1);
    for (const x of db._tables.intel_attributions) { assert.equal(x.outcome, "did_not_go"); assert.equal(x.outcome_score, null); assert.equal(x.contradiction, false); }
  });

  it("a read error is reported as error, never a silent success", async () => {
    const r = await runIntelAttributionPass({ client: makeDb(world({ errorTable: "canonical_events" })), now: NOW });
    assert.equal(r.reason, "error");
    assert.equal(r.skipped, true);
  });

  it("hands the rows it wrote to the registered scoped-trust applier", async () => {
    const seen: any[] = [];
    setTrustApplier(async (_db, rows) => { seen.push(...rows); return rows.length; });
    try {
      const db = makeDb(world());
      const r = await runIntelAttributionPass({ client: db, now: NOW });
      assert.equal(r.trustApplied, 2);
      assert.equal(seen.length, 2);
    } finally { setTrustApplier(null); }
  });
});
