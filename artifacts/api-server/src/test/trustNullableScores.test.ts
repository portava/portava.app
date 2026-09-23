/**
 * Q1 — NULLABLE TRUST SCORES. Owner decision, 2026-09-22.
 *
 * "Make the nine category columns and overall_score nullable, with NULL meaning
 *  not scored. Remove fabricated neutral defaults and update calculations and
 *  consumers accordingly. Unmeasured categories must not contribute an invented
 *  50. Preserve legitimate measured values [...] Rehearse the migration and
 *  verify partially measured, entirely unmeasured, and negative-evidence cases
 *  before enabling the engine."
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 *
 * `computeCategoryScore` returned a literal 50 for a category with no events,
 * and `recalculateTrustScore` weighted all nine with weights summing to exactly
 * 1.000. Two consequences, both of them statements about real people made out of
 * nothing:
 *
 *   * a user with ZERO trust events scored exactly 50.00 and was promoted to
 *     `reliable_traveler` (level_reliable = 50); and
 *   * a user with ONE negative event was dragged back toward 50 by the eight
 *     fabricated neutrals surrounding it.
 *
 * ── THE THREE CASES THE DECISION NAMES, AND A FOURTH THE TYPE SYSTEM CANNOT SEE
 *
 * The decision names three cases; each is a `describe` below. The fourth group
 * exists because the dangerous failure here is INVISIBLE to `tsc`:
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so every consumer that
 * coerced before testing would silently turn "not scored" into a hard ZERO —
 * the worst available measurement, published as a fact. Those assertions call
 * the shipped consumers with a null-bearing profile rather than re-implementing
 * their rules.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT ASSERT ──────────────────────────────
 *
 * Nothing here says a pre-existing 50 should become NULL. Migration 2999
 * changes the column TYPE and drops the DEFAULT and touches no row's data,
 * because a genuinely measured 50 and a substituted 50 are byte-identical in
 * the old schema and no per-row evidence of origin exists. The untouched-rows
 * property is proved against a real PostgreSQL by the migration rehearsal (see
 * scripts/local-db), not here — a fake client cannot establish it.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/trustNullableScores.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recalculateTrustScore,
  aggregateOverall,
  ALL_CATEGORIES,
} from "../services/trust/TrustScoreService.js";
import { getSafeTrustSummary } from "../services/trust/TrustPrivacyGuard.js";
import { getRecoveryStatus } from "../services/trust/TrustRecoveryService.js";
import { buildDomainTrust } from "../services/passport/PassportProjectionService.js";

const USER = "user-q1-nullable";
const HALF_LIFE = 90;

// ── Fake client ───────────────────────────────────────────────────────────────
//
// Rows are real and filters are really applied, so "no events in this category"
// and "events in this category" are genuinely different inputs rather than two
// spellings of the same stub. Modelled on the client in
// trustAsymmetryAndMaintenance.test.ts.

type Store = Record<string, any[]>;

function makeClient(tables: Store) {
  let seq = 1;
  function from(table: string) {
    const store = (tables[table] ??= []);
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;

    const builder: any = {
      select() { return builder; },
      insert(row: any) {
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r); pendingInsert = r; return builder;
      },
      upsert(row: any, opts?: any) {
        const key = opts?.onConflict ?? "id";
        const i = store.findIndex((r) => r[key] === row[key]);
        if (i >= 0) { store[i] = { ...store[i], ...row }; pendingInsert = store[i]; }
        else { const r = { id: `fake-${seq++}`, ...row }; store.push(r); pendingInsert = r; }
        return builder;
      },
      update(patch: any) { pendingUpdate = patch; return builder; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      gt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] > val); return builder; },
      lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
      or() { return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return one(); },
      single() { return one(); },
      then(onF: any, onR: any) { return list().then(onF, onR); },
    };

    function matched() { return store.filter((r) => filters.every((f) => f(r))); }
    async function one() {
      if (pendingInsert && !pendingUpdate) return { data: pendingInsert, error: null };
      const rows = matched();
      if (pendingUpdate) rows.forEach((r) => Object.assign(r, pendingUpdate));
      return { data: rows[0] ?? null, error: null };
    }
    async function list() {
      if (pendingInsert && !pendingUpdate) return { data: [pendingInsert], error: null, count: 1 };
      const rows = matched();
      if (pendingUpdate) rows.forEach((r) => Object.assign(r, pendingUpdate));
      return { data: rows, error: null, count: rows.length };
    }
    return builder;
  }
  return { from } as any;
}

const SETTINGS_ROW = {
  id: 1,
  weight_plan_attendance: 0.18, weight_host_quality: 0.12,
  weight_communication: 0.10, weight_respect_safety: 0.15,
  weight_location_honesty: 0.13, weight_content_quality: 0.08,
  weight_community_value: 0.08, weight_guide_accuracy: 0.08,
  weight_passport_auth: 0.08,
  decay_half_life_days: HALF_LIFE,
  level_building_trust: 35, level_reliable: 50,
  level_trusted: 65, level_highly_trusted: 78, level_city_trusted: 90,
};

function baseTables(): Store {
  return {
    feature_flags: [{ flag: "trust_engine_enabled", enabled: true }],
    trust_settings: [{ ...SETTINGS_ROW }],
    trust_events: [],
    trust_caps: [],
    trust_profiles: [],
    trust_reviews: [],
    trust_restrictions: [],
  };
}

function seedEvents(tables: Store, userId: string, category: string, delta: number, n: number) {
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    tables["trust_events"].push({
      id: `ev-${category}-${delta}-${i}`, user_id: userId, category,
      delta, severity: "minor", status: "applied", created_at: now,
    });
  }
}

// ── 1. ENTIRELY UNMEASURED ───────────────────────────────────────────────────

describe("Q1 — entirely unmeasured: no events means NO SCORE, not a neutral 50", () => {
  it("every category is null and the overall score is null", async () => {
    const tables = baseTables();
    const r = await recalculateTrustScore(makeClient(tables), USER);

    for (const cat of ALL_CATEGORIES) {
      assert.equal(
        r.categories[cat], null,
        `${cat} must be null (not scored) with no events — a 50 here is a fabricated measurement`,
      );
    }
    assert.equal(
      r.overall_score, null,
      "with nothing measured there is no overall score to report",
    );
  });

  it("is NOT promoted — this is the defect the decision names", async () => {
    const tables = baseTables();
    const r = await recalculateTrustScore(makeClient(tables), USER);

    // The pre-Q1 engine produced exactly 50.00 here, and level_reliable is 50,
    // so a user with zero events was published as a `reliable_traveler`.
    assert.notEqual(
      r.public_level, "reliable_traveler",
      "a user with zero events must not be promoted on the strength of nine fabricated neutrals",
    );
    assert.equal(
      r.public_level, "new_traveler",
      "no measurement means no standing to show — not a measured low one",
    );
  });

  it("persists nulls rather than 50s, so the row cannot lie later", async () => {
    // FIXTURE CHANGED AT THE MERGE OF PR #449, and the change is the point.
    //
    // This used to seed NOTHING and assert that the written row held nulls.
    // #449 made that population unreachable: a user with no events, no existing
    // profile and no cap history is no longer PERSISTED at all — row absence is
    // now the canonical "no earned trust" representation. So the old fixture
    // asserted the contents of a row that correctly no longer exists.
    //
    // The guarantee this test exists for is unchanged and still needs a pin:
    // WHEN a row is written, an unmeasured column is `null` and never a
    // fabricated 50. So the fixture now produces a row the honest way — one
    // measured category — and the other eight are checked for nulls. That is a
    // stronger test than the original: it proves nulls and 50s can coexist in
    // one row, which is the case a `NOT NULL DEFAULT 50` column could not
    // represent and is exactly what 2999 changed.
    const tables = baseTables();
    tables["trust_events"].push({
      id: "ev-measured", user_id: USER, category: "host_quality",
      delta: 6, severity: "minor", status: "confirmed",
      created_at: new Date().toISOString(),
    });
    await recalculateTrustScore(makeClient(tables), USER);

    const row = tables["trust_profiles"].find((r) => r.user_id === USER);
    assert.ok(row, "a measured user IS persisted — #449 only withholds the row for zero evidence");
    assert.notEqual(row.host_quality, null, "the measured category carries its measurement");
    assert.notEqual(row.overall_score, null, "and the overall is a real number");
    for (const cat of ALL_CATEGORIES) {
      if (cat === "host_quality") continue;
      assert.equal(row[cat], null, `the unmeasured ${cat} is persisted as null, never as 50`);
    }
  });
});

// ── 2. PARTIALLY MEASURED ────────────────────────────────────────────────────

describe("Q1 — partially measured: scored on the categories actually present", () => {
  it("measured categories keep values; unmeasured ones stay null", async () => {
    const tables = baseTables();
    seedEvents(tables, USER, "host_quality", +6, 12);
    seedEvents(tables, USER, "communication", +6, 12);
    const r = await recalculateTrustScore(makeClient(tables), USER);

    assert.ok(typeof r.categories.host_quality === "number", "host_quality was measured");
    assert.ok(typeof r.categories.communication === "number", "communication was measured");
    for (const cat of ALL_CATEGORIES) {
      if (cat === "host_quality" || cat === "communication") continue;
      assert.equal(r.categories[cat], null, `${cat} had no events and must stay null`);
    }
  });

  it("the overall is the renormalised mean of the present two, NOT diluted by seven absent ones", async () => {
    const tables = baseTables();
    seedEvents(tables, USER, "host_quality", +6, 12);
    seedEvents(tables, USER, "communication", +6, 12);
    const r = await recalculateTrustScore(makeClient(tables), USER);

    const hq = r.categories.host_quality as number;
    const cm = r.categories.communication as number;
    // Renormalised over the present weights only: 0.12 and 0.10.
    const expected = Math.round(((hq * 0.12 + cm * 0.10) / (0.12 + 0.10)) * 100) / 100;
    assert.equal(r.overall_score, expected, "renormalised over the categories actually present");

    // And the property that matters, stated without restating the arithmetic:
    // the overall sits WITH the two measurements rather than being pulled to 50
    // by the seven that do not exist.
    assert.ok(
      (r.overall_score as number) >= Math.min(hq, cm) - 0.01 &&
      (r.overall_score as number) <= Math.max(hq, cm) + 0.01,
      "the overall lies between the two measured categories; seven absent ones contribute nothing",
    );
  });

  it("a single measured category IS the overall score", async () => {
    const tables = baseTables();
    seedEvents(tables, USER, "respect_safety", +6, 12);
    const r = await recalculateTrustScore(makeClient(tables), USER);
    assert.equal(
      r.overall_score, r.categories.respect_safety,
      "one measured category, renormalised, is itself — not itself blended with eight inventions",
    );
  });
});

// ── 3. NEGATIVE EVIDENCE ─────────────────────────────────────────────────────

describe("Q1 — negative evidence is not dragged back toward 50", () => {
  it("one negative event stands at its own value, undiluted", async () => {
    const tables = baseTables();
    seedEvents(tables, USER, "respect_safety", -6, 1);
    const r = await recalculateTrustScore(makeClient(tables), USER);

    const rs = r.categories.respect_safety as number;
    assert.ok(typeof rs === "number", "respect_safety was measured");
    assert.ok(rs < 50, "a negative event moves the category below neutral");

    // THE DEFECT: pre-Q1 this user's overall was
    //   50*0.85 + rs*0.15  ≈ 47      — barely moved, still `building_trust`.
    // The eight fabricated neutrals absorbed the finding. Now the single real
    // measurement is the whole score.
    assert.equal(r.overall_score, rs, "the one real measurement IS the overall score");
    assert.ok(
      (r.overall_score as number) < 45,
      "a confirmed negative must not be pulled back up toward neutral by categories nobody measured",
    );
  });

  it("negative evidence in one category is not offset by eight absent ones", async () => {
    const tables = baseTables();
    seedEvents(tables, USER, "respect_safety", -6, 3);
    const r = await recalculateTrustScore(makeClient(tables), USER);

    // Relational rather than arithmetical: whatever the category lands on, the
    // overall must not be closer to 50 than the category is. That is exactly
    // the dilution this decision removes, and it holds for any weighting.
    const rs = r.categories.respect_safety as number;
    assert.ok(
      Math.abs((r.overall_score as number) - 50) >= Math.abs(rs - 50) - 0.01,
      "the overall must not be closer to neutral than the measurement it is built from",
    );
  });

  it("a genuine measured 50 is preserved and is NOT treated as absent", () => {
    // The distinction the whole decision rests on, at the aggregation seam: a
    // measured 50 contributes; an unmeasured category does not. If these two
    // produced the same answer, nulling would have been pointless.
    const weights = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 1]));
    const measuredFifty = Object.fromEntries(
      ALL_CATEGORIES.map((c) => [c, c === "host_quality" ? 90 : 50]),
    ) as Record<string, number | null>;
    const onlyHostQuality = Object.fromEntries(
      ALL_CATEGORIES.map((c) => [c, c === "host_quality" ? 90 : null]),
    ) as Record<string, number | null>;

    assert.equal(aggregateOverall(measuredFifty, weights), 54.44,
      "eight measured 50s and a 90 average to 54.44 — measured values count");
    assert.equal(aggregateOverall(onlyHostQuality, weights), 90,
      "one measured 90 and eight NOT SCORED is 90 — absences count for nothing");
  });
});

// ── 4. THE COERCION HAZARD tsc CANNOT SEE ────────────────────────────────────

describe("Q1 — null must never be coerced into a measurement", () => {
  it("aggregateOverall ignores nulls instead of folding them in as zero", () => {
    const weights = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 1]));
    const allNull = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, null]));
    assert.equal(aggregateOverall(allNull, weights), null, "nothing measured is null, never 0");

    const oneMeasured = Object.fromEntries(
      ALL_CATEGORIES.map((c) => [c, c === "communication" ? 70 : null]),
    ) as Record<string, number | null>;
    // Number(null) is 0: folding the eight nulls in as zeros would give 70/9 = 7.78.
    assert.equal(aggregateOverall(oneMeasured, weights), 70,
      "the eight unscored categories must not act as zeros");
  });

  it("buildDomainTrust words a null category 'Not yet rated', never a rating", () => {
    const categories: Record<string, number | null> = Object.fromEntries(
      ALL_CATEGORIES.map((c) => [c, null]),
    );
    const domains = buildDomainTrust(50, categories, false, "ok", false);

    for (const d of domains) {
      if (!d.applicable) continue; // Buddy, not offered — its own state
      assert.equal(d.basis, "substituted",
        `${d.key}: a null category is NOT a measurement and must not report basis 'measured'`);
      assert.equal(d.presentation, "Not yet rated",
        `${d.key}: must reuse Q3's vocabulary rather than word a coerced zero as "New"`);
    }
  });

  it("buildDomainTrust still reports a real measurement as measured", () => {
    const categories: Record<string, number | null> = Object.fromEntries(
      ALL_CATEGORIES.map((c) => [c, 82]),
    );
    const domains = buildDomainTrust(82, categories, false, "ok", true);
    const overall = domains.find((d) => d.key === "overall");
    assert.equal(overall?.basis, "measured", "Q1 must not blank out real measurements");
    assert.equal(overall?.presentation, "Excellent", "a measured 82 keeps its word");
  });

  it("an unscored category is not published as a strength", async () => {
    const tables = baseTables();
    tables["trust_profiles"].push({
      user_id: USER,
      overall_score: 88, public_level: "highly_trusted",
      plan_attendance: 88, host_quality: null, communication: null,
      respect_safety: null, location_honesty: null, content_quality: null,
      community_value: null, guide_accuracy: null, passport_authenticity: null,
      on_probation: false,
    });
    const summary = await getSafeTrustSummary(makeClient(tables), USER);
    assert.deepEqual(summary.strengths, ["Plan Attendance"],
      "only the measured category is a strength; nulls must not sort in as very weak scores");
  });

  it("an unscored category is not published as the user's weakest area", async () => {
    const tables = baseTables();
    tables["trust_profiles"].push({
      user_id: USER,
      overall_score: 72, public_level: "trusted_traveler",
      plan_attendance: 72, host_quality: null, communication: null,
      respect_safety: null, location_honesty: null, content_quality: null,
      community_value: null, guide_accuracy: null, passport_authenticity: null,
      on_probation: false,
    });
    const status = await getRecoveryStatus(makeClient(tables), USER);
    // Number(null) is 0, which would beat every real score in the `lowest` reduce.
    assert.equal(status.lowestCategory, "plan_attendance",
      "the lowest category must come from a measurement, not from a coerced null");
    assert.equal(status.lowestScore, 72);
  });

  it("an entirely unscored profile reports no progress rather than zero progress", async () => {
    const tables = baseTables();
    tables["trust_profiles"].push({
      user_id: USER,
      overall_score: null, public_level: "new_traveler",
      ...Object.fromEntries(ALL_CATEGORIES.map((c) => [c, null])),
      on_probation: false,
    });
    const status = await getRecoveryStatus(makeClient(tables), USER);
    assert.equal(status.overallProgress, null,
      "no measurement means no progress to report — 0 would be a claim, not an absence");
    assert.equal(status.lowestCategory, null, "there is no lowest category among none");
    assert.deepEqual(status.suggestedSteps, [],
      "a person cannot recover from measurements that were never taken");
  });
});
