/**
 * census-layover L242 (spec §21 shadow mode) and L78 (spec §9.1 the candidate-
 * ranking objective) — B58 lane LAY-4.
 *
 *   A. THE MODE RESOLVER (lib/layoverRolloutMode.ts): every failure is legacy.
 *   B. THE OBJECTIVE (services/airport/layoverObjective.ts): each term is a real
 *      input with its provenance, or UNKNOWN — and an UNKNOWN term contributes
 *      0 and is named. Commercial price signals and presence remain excluded; L78 admits sourced traveller costs.
 *   C. THE ELIGIBILITY BOUNDARY, as a randomised property: the served set equals
 *      the legacy set; only the order WITHIN a safety rating changes.
 *   D. THE HOOK (services/airport/layoverRankingMode.ts): legacy serves the very
 *      list it was given and adds nothing; shadow publishes nothing; on serves
 *      the objective's order; a throw serves legacy and says so.
 *   E. THE REAL GENERATOR: flag OFF (and every other legacy-resolving state) is
 *      byte-identical; shadow's rows and cards are legacy's; on re-orders within
 *      a rating only — swept over random layovers.
 *   F. THE ADMIN DIVERGENCE REPORT (GET /api/admin/layover/metrics).
 *   G. THE REGISTRY and the 3784 seed, checked against the tree.
 *   H. H5 — `check:no-money-in-ranking` scans the new files and they are clean.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverRankingObjective.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { _setTestClient } from "../lib/http.js";
import adminLayoverMetricsRouter from "../routes/adminLayoverMetrics.js";
import {
  LAYOVER_RANKING_MODE_FLAG,
  LAYOVER_SHADOW_ARMS,
  LAYOVER_LIVE_FLAGS_WITHOUT_SHADOW,
  layoverModeFor,
  parseLayoverRolloutMode,
  resolveLayoverRolloutMode,
} from "../lib/layoverRolloutMode.js";
import {
  ALWAYS_UNKNOWN,
  LAYOVER_OBJECTIVE_VERSION,
  OBJECTIVE_TERMS,
  TERM_SIGN,
  cardObjective,
  isPermutationWithinRatings,
  objectiveTerms,
  orderWithinRatings,
  scoreTerms,
  type ObjectiveCard,
  type ObjectiveLiveReading,
  type ObjectiveTerm,
  type TermValue,
} from "../services/airport/layoverObjective.js";
import {
  applyLayoverRankingMode,
  layoverRankingCounters,
  layoverRankingWindow,
  _rankingModeLogger,
  _resetLayoverRankingCounters,
} from "../services/airport/layoverRankingMode.js";
import { generateRecommendations, recommendationKey } from "../services/airport/LayoverRecommendationService.js";
import { TRAVEL_TIME_SOURCES, type SafetyRating } from "../services/airport/LayoverSafetyEngine.js";
import { runCheck, failureCount, SCOPE, OPEN_DECISIONS, moneyIdentifiersIn } from "../scripts/checkNoMoneyInRanking.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const MIGRATIONS = join(SRC, "migrations");
const HOUR = 3_600_000;

/** mulberry32 — a seeded PRNG, so every randomised case is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <X>(r: () => number, xs: readonly X[]): X => xs[Math.floor(r() * xs.length)]!;

const modeRow = (enabled: boolean, metadata: unknown) => ({ flag: LAYOVER_RANKING_MODE_FLAG, enabled, metadata });
const flagsDb = (rows: unknown[], opts: Parameters<typeof makeLayoverDb>[1] = {}) => makeLayoverDb({ feature_flags: rows as any[] }, opts);

// ── A. the mode resolver ─────────────────────────────────────────────────────

describe("A. the rollout-mode resolver: every failure resolves to legacy", () => {
  it("no client, no row, a failed read, and the 3784 seed (enabled = false) are all legacy, each with its own reason", async () => {
    assert.deepEqual(
      [await resolveLayoverRolloutMode(null, "ranking_objective"), await resolveLayoverRolloutMode(undefined, "ranking_objective")].map((r) => [r.mode, r.reason]),
      [["legacy", "no_client"], ["legacy", "no_client"]],
    );
    assert.deepEqual(await resolveLayoverRolloutMode(flagsDb([]), "ranking_objective"), { mode: "legacy", reason: "flag_absent", cohort: { kind: "none" }, cohortReason: "absent" });
    const failing = flagsDb([modeRow(true, { mode: "on", cohort: { kind: "all" } })], { failures: { "feature_flags:select": { message: "relation unavailable" } } });
    assert.deepEqual((await resolveLayoverRolloutMode(failing, "ranking_objective")).mode, "legacy", "a read that RESOLVES with an error must not become `on`");
    for (const mode of ["legacy", "shadow", "on"]) {
      const r = await resolveLayoverRolloutMode(flagsDb([modeRow(false, { mode, cohort: { kind: "all" } })]), "ranking_objective");
      assert.deepEqual([r.mode, r.reason], ["legacy", "flag_disabled"], `enabled = false is the master, whatever mode=${mode} says`);
    }
  });

  it("enabled with no mode, or a mode it does not know, is legacy — including prototype keys and near-misses", async () => {
    for (const metadata of [null, {}, [], "shadow", 7, { cohort: { kind: "all" } }]) {
      const r = await resolveLayoverRolloutMode(flagsDb([modeRow(true, metadata)]), "ranking_objective");
      assert.deepEqual([r.mode, r.reason], ["legacy", "mode_missing"], JSON.stringify(metadata));
    }
    for (const mode of ["pde", "ON", "Shadow", " on", "objective", "constructor", "__proto__", "toString", 1, true, {}, ["on"]]) {
      const r = await resolveLayoverRolloutMode(flagsDb([modeRow(true, { mode, cohort: { kind: "all" } })]), "ranking_objective");
      assert.deepEqual([r.mode, r.reason], ["legacy", "mode_invalid"], JSON.stringify(mode));
    }
    for (const raw of ["constructor", "__proto__", "hasOwnProperty", "", null, undefined]) assert.equal(parseLayoverRolloutMode(raw), null);
  });

  it("a resolver that throws past getFlagRow is legacy (flag_unreadable), never a guess", async () => {
    const hostile = new Proxy({}, { get() { throw new Error("metadata is poisoned"); } });
    const r = await resolveLayoverRolloutMode(flagsDb([modeRow(true, hostile)]), "ranking_objective");
    assert.deepEqual([r.mode, r.reason], ["legacy", "flag_unreadable"]);
  });

  it("legacy | shadow | on resolve as configured; WHO is the cohort's, and an absent or unusable cohort is NOBODY", async () => {
    const legacy = await resolveLayoverRolloutMode(flagsDb([modeRow(true, { mode: "legacy", cohort: { kind: "all" } })]), "ranking_objective");
    assert.deepEqual(legacy, { mode: "legacy", reason: "resolved", cohort: { kind: "none" }, cohortReason: "absent" }, "legacy carries no cohort");

    const noCohort = await resolveLayoverRolloutMode(flagsDb([modeRow(true, { mode: "shadow" })]), "ranking_objective");
    assert.equal(noCohort.mode, "shadow");
    assert.equal(layoverModeFor(noCohort, "user-1").mode, "legacy", "shadow with no cohort affects nobody");
    for (const cohort of ["all", 5, { kind: "everyone" }, { kind: "percent", percent: 101 }, { kind: "users", userIds: "user-1" }]) {
      const r = await resolveLayoverRolloutMode(flagsDb([modeRow(true, { mode: "on", cohort })]), "ranking_objective");
      assert.equal(layoverModeFor(r, "user-1").mode, "legacy", `cohort ${JSON.stringify(cohort)} must include nobody`);
    }

    const listed = await resolveLayoverRolloutMode(flagsDb([modeRow(true, { mode: "on", cohort: { kind: "users", userIds: ["user-1"] } })]), "ranking_objective");
    assert.deepEqual([layoverModeFor(listed, "user-1").mode, layoverModeFor(listed, "user-2").mode, layoverModeFor(listed, null).mode], ["on", "legacy", "legacy"]);
    const all = await resolveLayoverRolloutMode(flagsDb([modeRow(true, { mode: "shadow", cohort: { kind: "all" } })]), "ranking_objective");
    assert.deepEqual([layoverModeFor(all, "anyone").mode, layoverModeFor(all, undefined).mode], ["shadow", "legacy"], "no user is no one to include");
    const none = await resolveLayoverRolloutMode(flagsDb([modeRow(true, { mode: "on", cohort: { kind: "percent", percent: 0 } })]), "ranking_objective");
    assert.equal(layoverModeFor(none, "user-1").mode, "legacy", "0 % is nobody");
  });
});

// ── B. the objective, pure ───────────────────────────────────────────────────

type Card = ObjectiveCard & { id: string };

function card(over: Partial<Card> & { rating?: SafetyRating; usable?: number; leg?: number | null; dwell?: number | null } = {}): Card {
  const inside = over.insideAirport ?? false;
  const leg = over.leg === undefined ? (inside ? 0 : null) : over.leg;
  return {
    id: over.id ?? "c",
    insideAirport: inside,
    verified: over.verified,
    travelTimeMin: leg,
    travelTimeSource: over.travelTimeSource ?? (inside ? "inside_airport" : "unmeasured"),
    assessment: {
      rating: over.rating ?? "not_recommended",
      statedTravelMin: leg,
      statedActivityMin: over.dwell === undefined ? null : over.dwell,
      usableMinutes: over.usable ?? 300,
    },
  };
}
const ctxOf = (live: Record<string, ObjectiveLiveReading> = {}) => ({ keyOf: (c: Card) => c.id, live: new Map(Object.entries(live)) });
const reading = (experienceValue: number | null, reachable: boolean | null): ObjectiveLiveReading => ({ evidence: "reading", experienceValue, interception: { reachable } });

describe("B. the objective: a real input with its provenance, or UNKNOWN — and UNKNOWN contributes 0 and is named", () => {
  it("every card carries all eleven terms; each is KNOWN with a provenance or UNKNOWN with a reason", () => {
    for (const c of [card({ insideAirport: true, verified: true, dwell: 30 }), card({ verified: false }), card({ leg: 20, dwell: 60, travelTimeSource: "measured", verified: true })]) {
      const terms = objectiveTerms(c, ctxOf());
      assert.deepEqual(Object.keys(terms).sort(), [...OBJECTIVE_TERMS].sort());
      for (const t of OBJECTIVE_TERMS) {
        const v = terms[t];
        if (v.state === "KNOWN") {
          assert.ok(v.provenance.length > 10, `${t} is KNOWN with no provenance`);
          assert.ok(v.value >= -1 && v.value <= 1, `${t} out of scale`);
        } else assert.ok(v.reason.length > 10, `${t} is UNKNOWN with no reason`);
      }
    }
  });

  it("an UNKNOWN term contributes 0 and is NAMED — the score is the signed sum of the KNOWN terms alone", () => {
    const c = card({ verified: false, dwell: null });
    const o = cardObjective(c, ctxOf({ c: reading(null, null) }));
    // preference_fit: a reading, but no intent; opportunity_scarcity: no leg to meet the horizon with.
    assert.equal(o.terms.preference_fit.state, "UNKNOWN");
    assert.equal(o.terms.opportunity_scarcity.state, "UNKNOWN");
    assert.equal(o.terms.return_risk.state, "UNKNOWN");
    for (const t of ["preference_fit", "opportunity_scarcity", "return_risk", ...Object.keys(ALWAYS_UNKNOWN)] as ObjectiveTerm[]) {
      assert.ok(o.unknownTerms.includes(t), `${t} contributed 0 without being named`);
    }
    const knownSum = OBJECTIVE_TERMS.reduce((s, t) => { const v = o.terms[t]; return v.state === "KNOWN" ? s + TERM_SIGN[t] * v.value : s; }, 0);
    assert.equal(o.score, Math.round(knownSum * 1e6) / 1e6);
    // An UNKNOWN term scores exactly as a KNOWN 0 would, for every term and either sign.
    for (const t of OBJECTIVE_TERMS) {
      const asUnknown = { ...o.terms, [t]: { state: "UNKNOWN", reason: "planted" } } as Record<ObjectiveTerm, TermValue>;
      const asZero = { ...o.terms, [t]: { state: "KNOWN", value: 0, provenance: "planted zero" } } as Record<ObjectiveTerm, TermValue>;
      assert.equal(scoreTerms(asUnknown).score, scoreTerms(asZero).score, t);
      assert.ok(scoreTerms(asUnknown).unknownTerms.includes(t), `${t} as UNKNOWN is not named`);
      assert.ok(!scoreTerms(asZero).unknownTerms.includes(t), `${t} as a KNOWN 0 is named as unknown`);
    }
  });

  it("the spec's signs: raising a + term raises the score, raising a − term lowers it", () => {
    const base = cardObjective(card(), ctxOf()).terms;
    for (const t of OBJECTIVE_TERMS) {
      const lo = scoreTerms({ ...base, [t]: { state: "KNOWN", value: -0.5, provenance: "p" } } as Record<ObjectiveTerm, TermValue>).score;
      const hi = scoreTerms({ ...base, [t]: { state: "KNOWN", value: 0.5, provenance: "p" } } as Record<ObjectiveTerm, TermValue>).score;
      assert.equal(Math.sign(hi - lo), TERM_SIGN[t], t);
    }
    assert.deepEqual(OBJECTIVE_TERMS.filter((t) => TERM_SIGN[t] === -1), ["monetary_cost", "energy_cost", "uncertainty", "stress", "return_risk"]);
  });

  it("raw price or presence properties on a card cannot impersonate sourced traveller-cost or social evidence", () => {
    const r = rng(6);
    for (let i = 0; i < 200; i += 1) {
      const c = Object.assign(card({ verified: r() < 0.5, leg: r() < 0.5 ? null : 10 + Math.floor(r() * 40), dwell: r() < 0.5 ? null : 30 }), {
        price: Math.floor(r() * 500), priceLevel: Math.floor(r() * 4), costRange: pick(r, ["free", "low", "medium", "high"]), cost_band: "high",
        presenceCount: Math.floor(r() * 50), crewSize: Math.floor(r() * 8), sponsored: r() < 0.5,
      });
      const bare = card({ verified: c.verified, leg: c.travelTimeMin, dwell: c.assessment.statedActivityMin });
      const withMoney = cardObjective(c, { keyOf: () => "c" });
      assert.equal(withMoney.terms.monetary_cost.state, "UNKNOWN");
      assert.equal(withMoney.terms.social_value.state, "UNKNOWN");
      assert.match((withMoney.terms.monetary_cost as { reason: string }).reason, /source|intent/);
      assert.match((withMoney.terms.social_value as { reason: string }).reason, /source|intent/);
      assert.deepEqual(withMoney.terms, cardObjective(bare, { keyOf: () => "c" }).terms, "a money or presence field changed a term");
    }
  });

  it("H4: no category default reaches a term — the card's type and title change nothing", () => {
    const r = rng(4);
    for (let i = 0; i < 100; i += 1) {
      const base = card({ verified: r() < 0.5, insideAirport: r() < 0.3, dwell: r() < 0.5 ? null : 45 });
      const a = cardObjective(Object.assign({}, base, { recType: "nightlife", title: "A bar" }), { keyOf: () => "k" });
      const b = cardObjective(Object.assign({}, base, { recType: pick(r, ["food", "rest", "activity", "quick_city_escape", "inside_airport"]), title: "Anything" }), { keyOf: () => "k" });
      assert.deepEqual(a.terms, b.terms);
    }
    assert.equal(cardObjective(card(), ctxOf()).terms.energy_cost.state, "UNKNOWN");
    assert.equal(cardObjective(card(), ctxOf()).terms.experience_density.state, "UNKNOWN");
  });

  it("return_risk: airside is the fact of no leg; landside needs BOTH stated terms and a certified window, else UNKNOWN", () => {
    assert.deepEqual(objectiveTerms(card({ insideAirport: true, dwell: 60 }), ctxOf()).return_risk, { state: "KNOWN", value: -1, provenance: "inside_airport: there is no landside leg to return on" });
    for (const c of [card({ leg: null, dwell: 60 }), card({ leg: 20, dwell: null }), card({ leg: null, dwell: null })]) {
      const v = objectiveTerms(c, ctxOf()).return_risk;
      assert.equal(v.state, "UNKNOWN");
      assert.match((v as { reason: string }).reason, /lower bound/, "an unstated term is named as the reason, not a missing window");
    }
    assert.equal(objectiveTerms(card({ leg: 20, dwell: 60, usable: 0 }), ctxOf()).return_risk.state, "UNKNOWN", "no certified minutes to measure against");
    const half = objectiveTerms(card({ leg: 20, dwell: 60, usable: 200 }), ctxOf()).return_risk;
    assert.deepEqual(half.state === "KNOWN" ? half.value : null, 0, "100 of 200 usable minutes is the midpoint");
    const over = objectiveTerms(card({ leg: 100, dwell: 100, usable: 200 }), ctxOf()).return_risk;
    assert.deepEqual(over.state === "KNOWN" ? over.value : null, 1, "capped at the whole window");
  });

  it("uncertainty reads the leg's provenance and `verified` — a routed leg and a verified place are the certain end", () => {
    const value = (c: Card) => { const v = objectiveTerms(c, ctxOf()).uncertainty; return v.state === "KNOWN" ? v.value : NaN; };
    assert.equal(value(card({ insideAirport: true, verified: true })), -1);
    assert.equal(value(card({ leg: 20, travelTimeSource: "measured", verified: true })), -1);
    assert.equal(value(card({ verified: true })), 0);
    assert.equal(value(card({ verified: false })), 1);
    assert.equal(value(card({ leg: 20, travelTimeSource: "measured", verified: false })), 0);
    assert.equal(value(card({ verified: undefined })), 1, "an unstated `verified` is not evidence; the leg alone decides");
    for (const src of TRAVEL_TIME_SOURCES.filter((s) => s !== "measured" && s !== "inside_airport")) {
      assert.equal(value(card({ leg: 20, travelTimeSource: src, verified: true })), 0, `${src} is not a measurement`);
    }
  });

  it("the live terms: KNOWN only with a reading — preference_fit needs a stated intent, scarcity a horizon met against a leg", () => {
    const t = (live?: ObjectiveLiveReading) => objectiveTerms(card({ id: "c" }), ctxOf(live ? { c: live } : {}));
    assert.deepEqual(t(reading(0.75, true)).preference_fit.state === "KNOWN" && (t(reading(0.75, true)).preference_fit as { value: number }).value, 0.5);
    assert.equal((t(reading(0.75, true)).opportunity_scarcity as { value: number }).value, 1);
    assert.equal((t(reading(0.75, false)).opportunity_scarcity as { value: number }).value, -1);
    assert.equal(t(reading(0.75, null)).opportunity_scarcity.state, "UNKNOWN");
    assert.equal(t(reading(null, true)).preference_fit.state, "UNKNOWN");
    for (const ev of ["none", "unreadable"] as const) {
      const v = t({ evidence: ev, experienceValue: 1, interception: { reachable: true } });
      assert.deepEqual([v.preference_fit.state, v.opportunity_scarcity.state], ["UNKNOWN", "UNKNOWN"], `${ev} is not a reading`);
    }
    assert.deepEqual([t().preference_fit.state, t().opportunity_scarcity.state], ["UNKNOWN", "UNKNOWN"]);
    for (const bad of [-0.1, 1.1, Number.NaN]) assert.equal(t(reading(bad, true)).preference_fit.state, "UNKNOWN", `experienceValue ${bad}`);
  });
});

// ── C. the eligibility boundary, randomised ──────────────────────────────────

const RATING_ORDER: SafetyRating[] = ["safe", "possible_but_risky", "not_recommended", "airport_only"];

function randomLegacy(r: () => number, n: number): { list: Card[]; live: Map<string, ObjectiveLiveReading> } {
  const list: Card[] = [];
  const live = new Map<string, ObjectiveLiveReading>();
  for (let i = 0; i < n; i += 1) {
    const inside = r() < 0.3;
    const leg = inside ? 0 : r() < 0.5 ? null : 5 + Math.floor(r() * 60);
    const c = card({
      id: `c${i}`, insideAirport: inside, leg,
      dwell: r() < 0.4 ? null : 10 + Math.floor(r() * 120),
      usable: Math.floor(r() * 500),
      verified: r() < 0.2 ? undefined : r() < 0.5,
      travelTimeSource: inside ? "inside_airport" : pick(r, TRAVEL_TIME_SOURCES.filter((s) => s !== "inside_airport")),
      rating: pick(r, RATING_ORDER),
    });
    list.push(c);
    if (r() < 0.4) live.set(c.id, { evidence: pick(r, ["reading", "reading", "none", "unreadable"] as const), experienceValue: r() < 0.3 ? null : r(), interception: { reachable: pick(r, [true, false, null]) } });
  }
  // rankActivities' shape: the rating is the primary key, the arrival order the tiebreak.
  list.sort((a, b) => RATING_ORDER.indexOf(a.assessment.rating) - RATING_ORDER.indexOf(b.assessment.rating));
  return { list, live };
}

describe("C. property: the served set equals the legacy set; only the order WITHIN a rating changes", () => {
  it("1,000 random ranked lists: a permutation of the same objects, the same rating at every position, the input untouched", () => {
    const r = rng(78_242);
    let movedSomewhere = 0;
    for (let trial = 0; trial < 1000; trial += 1) {
      const { list, live } = randomLegacy(r, Math.floor(r() * 14));
      const before = [...list];
      const frozen = JSON.stringify(list);
      const out = orderWithinRatings(list, { keyOf: (c) => c.id, live });
      // The input is not mutated, in content or in order.
      assert.deepEqual(list, before);
      assert.equal(JSON.stringify(list), frozen);
      // The served set IS the legacy set: the same objects, each exactly once.
      assert.equal(out.served.length, list.length);
      assert.deepEqual([...out.served].map((c) => c.id).sort(), list.map((c) => c.id).sort());
      assert.equal(new Set(out.served).size, out.served.length, "a card served twice");
      for (const c of out.served) assert.ok(list.includes(c), "a card that was not given");
      // Only the order within a rating changes: the rating sequence is legacy's, position by position.
      assert.deepEqual(out.served.map((c) => c.assessment.rating), list.map((c) => c.assessment.rating));
      assert.equal(out.refused, null);
      // Within each run: by score, highest first; ties keep the legacy order.
      const score = new Map(list.map((c) => [c, cardObjective(c, { keyOf: (x: Card) => x.id, live }).score] as const));
      for (let i = 1; i < out.served.length; i += 1) {
        const a = out.served[i - 1]!; const b = out.served[i]!;
        if (a.assessment.rating !== b.assessment.rating) continue;
        assert.ok(score.get(a)! > score.get(b)! || (score.get(a) === score.get(b) && list.indexOf(a) < list.indexOf(b)), `trial ${trial}: ${a.id} before ${b.id}`);
      }
      const moved = out.served.filter((c, i) => c !== list[i]).length;
      assert.equal(out.moved, moved);
      assert.equal(out.topChanged, list.length > 0 && out.served[0] !== list[0]);
      if (moved > 0) movedSomewhere += 1;
    }
    assert.ok(movedSomewhere > 100, `the sweep must exercise re-ordering, not only ties (moved in ${movedSomewhere} trials)`);
  });

  it("the boundary check itself refuses a dropped, added, duplicated or cross-rating card", () => {
    const a = card({ id: "a", rating: "safe" }); const b = card({ id: "b", rating: "safe" }); const c = card({ id: "c", rating: "not_recommended" });
    const legacy = [a, b, c];
    assert.equal(isPermutationWithinRatings(legacy, [b, a, c]), true);
    assert.equal(isPermutationWithinRatings(legacy, [a, b]), false, "dropped");
    assert.equal(isPermutationWithinRatings(legacy, [a, b, c, card({ id: "d" })]), false, "added");
    assert.equal(isPermutationWithinRatings(legacy, [a, a, c]), false, "duplicated");
    assert.equal(isPermutationWithinRatings(legacy, [a, c, b]), false, "a not_recommended card lifted above a safe one");
    assert.equal(isPermutationWithinRatings(legacy, [a, b, { ...c }]), false, "a copy is not the card");
  });
});

// ── D. the hook ──────────────────────────────────────────────────────────────

const SHADOW_ALL = modeRow(true, { mode: "shadow", cohort: { kind: "all" } });
const ON_ALL = modeRow(true, { mode: "on", cohort: { kind: "all" } });

/** Two not_recommended cards the objective swaps (verified after unverified), behind one safe card. */
function swapList(): Card[] {
  return [
    card({ id: "air", insideAirport: true, verified: true, dwell: 30, rating: "safe" }),
    card({ id: "unverified", verified: false }),
    card({ id: "verified", verified: true }),
  ];
}

describe("D. the hook: legacy serves its input, shadow publishes nothing, on serves the objective's order", () => {
  beforeEach(() => _resetLayoverRankingCounters());

  it("legacy — the seed, an absent row, a cohort that excludes the traveller — serves THE SAME ARRAY and adds nothing to the event", async () => {
    for (const [rows, reason] of [
      [[modeRow(false, { mode: "legacy" })], "flag_disabled"],
      [[], "flag_absent"],
      [[modeRow(true, { mode: "on", cohort: { kind: "users", userIds: ["someone-else"] } })], "cohort_excluded"],
    ] as const) {
      const list = swapList();
      const out = await applyLayoverRankingMode(flagsDb([...rows]), { id: "s", userId: "user-1" }, list, { keyOf: (c) => c.id });
      assert.equal(out.served, list, "legacy must hand back the very list rankActivities returned");
      assert.deepEqual(out.event, {});
      assert.deepEqual([out.mode, out.reason], ["legacy", reason]);
    }
    assert.deepEqual(layoverRankingCounters().generations, { legacy: 3, shadow: 0, on: 0 });
  });

  it("shadow computes, counts and logs — and serves THE SAME ARRAY, in the legacy order", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const log = _rankingModeLogger as unknown as { info: (...a: unknown[]) => unknown };
    const original = log.info;
    log.info = (fields: unknown) => { lines.push(fields as Record<string, unknown>); };
    try {
      const list = swapList();
      const out = await applyLayoverRankingMode(flagsDb([SHADOW_ALL]), { id: "s", userId: "user-1" }, list, { keyOf: (c) => c.id });
      assert.equal(out.served, list);
      assert.deepEqual(out.served.map((c) => c.id), ["air", "unverified", "verified"], "shadow re-ordered nothing it served");
      assert.equal(out.mode, "shadow");
      assert.deepEqual(out.event.ranking, {
        objectiveVersion: LAYOVER_OBJECTIVE_VERSION, mode: "shadow", compared: 3, moved: 2, topChanged: false,
        knownByTerm: Object.fromEntries(OBJECTIVE_TERMS.map((t) => [t, t === "uncertainty" ? 3 : t === "return_risk" || t === "experience_density" ? 1 : 0])),
        refused: false,
      });
      // A comparison that agrees is counted and NOT logged.
      await applyLayoverRankingMode(flagsDb([SHADOW_ALL]), { id: "s2", userId: "user-1" }, [swapList()[0]!, swapList()[2]!, swapList()[1]!], { keyOf: (c) => c.id });
    } finally {
      log.info = original;
    }
    assert.equal(lines.length, 1, "one line for the divergent generation, none for the agreeing one");
    assert.deepEqual(
      Object.keys(lines[0]!).sort(),
      ["compared", "flag", "metric", "mode", "moved", "objectiveVersion", "sessionId", "topChanged"],
      "counts and the session id only — no card, title, key or order",
    );
    assert.equal(lines[0]!.metric, "layover_ranking_divergence");
    assert.deepEqual(layoverRankingCounters(), { generations: { legacy: 0, shadow: 2, on: 0 }, compared: 6, divergent: 1, moved: 2, failures: 0 });
  });

  it("on serves the objective's order: the same objects, re-ordered within the rating", async () => {
    const list = swapList();
    const out = await applyLayoverRankingMode(flagsDb([ON_ALL]), { id: "s", userId: "user-1" }, list, { keyOf: (c) => c.id });
    assert.notEqual(out.served, list);
    assert.deepEqual(out.served.map((c) => c.id), ["air", "verified", "unverified"]);
    assert.deepEqual(list.map((c) => c.id), ["air", "unverified", "verified"], "the legacy list itself is not mutated");
    assert.equal((out.event.ranking as { mode: string }).mode, "on");
  });

  it("a throw in the comparison serves legacy, writes a FAILED tally (never a clean one) and counts the failure", async () => {
    for (const row of [SHADOW_ALL, ON_ALL]) {
      const list = swapList();
      const out = await applyLayoverRankingMode(flagsDb([row]), { id: "s", userId: "user-1" }, list, { keyOf: () => { throw new Error("planted"); } });
      assert.equal(out.served, list);
      assert.deepEqual(out.event, { ranking: { objectiveVersion: LAYOVER_OBJECTIVE_VERSION, mode: (row.metadata as { mode: string }).mode, failed: true } });
    }
    assert.equal(layoverRankingCounters().failures, 2);
  });
});

// ── E. the real generator ────────────────────────────────────────────────────

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

/** 19:00 in Taipei: an evening-to-morning window that covers no daytime hour. */
const NIGHT = Date.parse("2026-10-14T11:00:00.000Z");

function sessionAt(nowMs: number, hours: number, over: Partial<LayoverSession> = {}): LayoverSession {
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(nowMs + 5 * 60_000).toISOString(),
    departureTime: new Date(nowMs + hours * HOUR).toISOString(),
    boardingTime: null, layoverMinutes: Math.round(hours * 60) - 5,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString(),
    ...over,
  } as LayoverSession;
}

const MUSEUM = { id: "place-museum", name: "City Museum", place_type: "museum", category: "culture", neighborhood: null, blurb: null, verified: true, city: "Taoyuan", status: "active", lat: null, lng: null };
const BAR = { id: "place-bar", name: "Night Bar", place_type: "bar", category: "nightlife", neighborhood: null, blurb: null, verified: false, city: "Taoyuan", status: "active", lat: null, lng: null };

function genTables(flagRows: unknown[], places: unknown[] = [BAR, MUSEUM]): Record<string, any[]> {
  return {
    feature_flags: flagRows as any[],
    discovery_places: places as any[],
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
  };
}

const strip = (o: object): Record<string, unknown> => { const { id: _i, created_at: _c, ...rest } = o as Record<string, unknown>; return rest; };

async function generate(flagRows: unknown[], session: LayoverSession, nowMs: number, opts: { stableIds?: boolean; places?: unknown[]; failures?: Record<string, { message: string }> } = {}) {
  const t = genTables(flagRows, opts.places);
  const out = await generateRecommendations(makeLayoverDb(t, { failures: opts.failures }) as never, AIRPORT, session, nowMs, { stableIds: opts.stableIds ?? false });
  if (!out.ok) assert.fail(out.message);
  const evts = t.layover_events.filter((e) => e.event_type === "recommendation_generated");
  assert.equal(evts.length, 1, "one generation, one audit event");
  const rows = [...t.layover_recommendations].sort((a, b) => a.sort_order - b.sort_order).map((r) => strip(r));
  const cards = out.recommendations.map((c) => strip(c));
  return { rows, cards, event: evts[0].metadata as Record<string, unknown> };
}

const identity = (r: Record<string, unknown>) => `${r.rec_type ?? r.recType}|${r.title}|${r.place_id ?? r.placeId ?? ""}`;
const withoutRanking = (e: Record<string, unknown>) => { const { ranking: _r, ...rest } = e; return rest; };

describe("E. the real generator", () => {
  beforeEach(() => _resetLayoverRankingCounters());

  for (const stableIds of [false, true]) {
    it(`stableIds=${stableIds}: flag OFF — and every state that resolves to legacy — is byte-identical, with no ranking key`, async () => {
      const s = sessionAt(NIGHT, 11);
      const baseline = await generate([], s, NIGHT, { stableIds });
      assert.ok(baseline.rows.length >= 5 && baseline.rows.some((r) => r.inside_airport === false), "airside and landside cards both written");
      assert.ok(!("ranking" in baseline.event), "no row: the event carries no ranking key");
      for (const [label, rows, failures] of [
        ["the 3784 seed (enabled = false, mode legacy)", [modeRow(false, { mode: "legacy", rollout: "b58-lay-4" })], undefined],
        ["enabled, mode legacy", [modeRow(true, { mode: "legacy", cohort: { kind: "all" } })], undefined],
        ["enabled, mode shadow, no cohort (nobody)", [modeRow(true, { mode: "shadow" })], undefined],
        ["enabled, mode on, a cohort without this traveller", [modeRow(true, { mode: "on", cohort: { kind: "users", userIds: ["user-2"] } })], undefined],
        ["enabled, mode invalid", [modeRow(true, { mode: "objective", cohort: { kind: "all" } })], undefined],
      ] as const) {
        const got = await generate([...rows], s, NIGHT, { stableIds, failures: failures as never });
        assert.deepEqual(got, baseline, label);
      }
    });
  }
  it("a global flag-store outage also makes required route-monitoring state unknown and refuses publication", async () => {
    const db = makeLayoverDb(genTables([ON_ALL]), { failures: { "feature_flags:select": { message: "flags down" } } });
    const result = await generateRecommendations(db as never, AIRPORT, sessionAt(NIGHT, 11), NIGHT, {});
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /route monitoring/);
  });

  it("shadow publishes nothing: the rows and the cards are legacy's; the event differs ONLY by its counts-only ranking tally", async () => {
    const s = sessionAt(NIGHT, 11, { vibeChips: [] }); // isolate uncertainty from the now-wired stated-category preference term
    const legacy = await generate([], s, NIGHT);
    const shadow = await generate([SHADOW_ALL], s, NIGHT);
    assert.deepEqual(shadow.rows, legacy.rows);
    assert.deepEqual(shadow.cards, legacy.cards);
    assert.deepEqual(withoutRanking(shadow.event), legacy.event);
    const tally = shadow.event.ranking as Record<string, unknown>;
    assert.equal(tally.compared, legacy.rows.length);
    assert.equal(tally.moved, 2, "the scenario diverges: the objective would put the verified museum above the unverified bar");
    assert.ok(!JSON.stringify(tally).includes("Museum") && !JSON.stringify(tally).includes("place-"), "no card content in the tally");
  });

  it("on (the non-vacuous case): the same cards and ratings; only the order within not_recommended changes", async () => {
    const s = sessionAt(NIGHT, 11, { vibeChips: [] });
    const legacy = await generate([], s, NIGHT);
    const on = await generate([ON_ALL], s, NIGHT);
    const landside = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.inside_airport === false).map((r) => r.title);
    assert.deepEqual(landside(legacy.rows), ["Night Bar", "City Museum", "Quick City Tour — Taoyuan"], "legacy: the evening nudge puts the unverified bar first");
    assert.deepEqual(landside(on.rows), ["City Museum", "Night Bar", "Quick City Tour — Taoyuan"], "on: the verified place is less uncertain");
    assert.deepEqual(on.rows.map((r) => r.safety_rating), legacy.rows.map((r) => r.safety_rating));
    assert.equal((on.event.ranking as Record<string, unknown>).moved, 2);
  });

  it("live ON: the traveller's stated intent reaches the objective through the live pass (preference_fit KNOWN on the bridged cards)", async () => {
    const DAY = Date.parse("2026-10-14T02:00:00.000Z"); // 10:00 in Taipei
    const subjectA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const subjectB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    const snap = (subject: string, level: string) => ({
      id: `snap-${subject.slice(0, 4)}`, subject_id: subject, zone_id: null, claim_type: "crowd.level",
      value: { level }, confidence: 0.9, source_count: 30,
      observed_at: new Date(DAY - 3 * 60_000).toISOString(), expires_at: new Date(DAY + 120 * 60_000).toISOString(),
      privacy_eligible: true, conflict_state: "none", source_class: "firsthand_unverified",
      computed_at: new Date(DAY - 3 * 60_000).toISOString(),
    });
    // A verified place that is PACKED, and an unverified one that is QUIET, for a traveller who asked for quiet.
    const places = [
      { id: "place-garden", name: "Calm Garden", place_type: "park", category: "nature", neighborhood: null, blurb: null, verified: true, city: "Taoyuan", status: "active", lat: null, lng: null, canonical_location_id: subjectA },
      { id: "place-cafe", name: "Quiet Cafe", place_type: "cafe", category: "food", neighborhood: null, blurb: null, verified: false, city: "Taoyuan", status: "active", lat: null, lng: null, canonical_location_id: subjectB },
    ];
    const liveFlags = [
      { flag: "intel_live_label_crowd", enabled: true }, { flag: "intel_claim_projection_crowd", enabled: true },
      { flag: "intel_capture_quick_signal", enabled: true }, { flag: "intel_limited_live", enabled: true },
      { flag: "layover_live_intersection_enabled", enabled: true },
    ];
    const run = async (rows: unknown[]) => {
      const t: ReturnType<typeof genTables> = { ...genTables([...liveFlags, ...rows], places), intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }], intel_state_snapshots: [snap(subjectA, "packed"), snap(subjectB, "quiet")] };
      const out = await generateRecommendations(makeLayoverDb(t) as never, AIRPORT, sessionAt(DAY, 9, { vibeChips: ["quiet"] }), DAY, {});
      assert.equal(out.ok, true);
      const event = t.layover_events.find((e) => e.event_type === "recommendation_generated")!.metadata;
      return { titles: [...t.layover_recommendations].sort((a, b) => a.sort_order - b.sort_order).filter((r) => !r.inside_airport).map((r) => r.title), event };
    };
    const legacy = await run([]);
    assert.deepEqual(legacy.titles.slice(0, 2), ["Quiet Cafe", "Calm Garden"], "precondition: legacy's live pass already leads with the quiet place");
    const on = await run([ON_ALL]);
    // Without the live terms the objective would prefer the VERIFIED garden (less uncertain) and invert this.
    assert.deepEqual(on.titles, legacy.titles, "with the live terms the objective agrees with the reading");
    const tally = on.event.ranking as { moved: number; knownByTerm: Record<string, number> };
    assert.equal(tally.knownByTerm.preference_fit, 2, "both bridged cards carry the stated-intent term");
    assert.equal(tally.knownByTerm.opportunity_scarcity, 0, "an unmeasured leg cannot meet a horizon");
    assert.equal(tally.moved, 0);
  });

  it("a daytime window where the two orders agree: on serves legacy's order exactly (ties keep it)", async () => {
    const DAY = Date.parse("2026-10-14T02:00:00.000Z"); // 10:00 in Taipei
    const s = sessionAt(DAY, 9, { vibeChips: [] });
    const legacy = await generate([], s, DAY);
    const on = await generate([ON_ALL], s, DAY);
    assert.deepEqual(on.rows, legacy.rows);
    assert.deepEqual(on.cards, legacy.cards);
    assert.equal((on.event.ranking as Record<string, unknown>).moved, 0);
  });

  it("property, over 80 random layovers through the real generator: shadow is legacy; on is the same set, same ratings, re-ordered within a rating only", async () => {
    const r = rng(2026_10_14);
    const PLACE_TYPES = ["restaurant", "cafe", "bar", "pub", "museum", "park", "shopping", "hotel", "spa", "attraction", "zoo"];
    let reordered = 0;
    for (let trial = 0; trial < 80; trial += 1) {
      // Half the layovers start in the Taipei evening (10:00-15:00 UTC) and end before 09:00 local, the window in
      // which legacy's time-of-day nudge and the objective disagree; the other half start at any hour.
      const evening = r() < 0.5;
      const startHourUtc = evening ? 10 + Math.floor(r() * 5) : Math.floor(r() * 24);
      const nowMs = Date.parse("2026-10-14T00:00:00.000Z") + startHourUtc * HOUR + Math.floor(r() * 60) * 60_000;
      const hours = evening ? 2 + r() * (24 - (startHourUtc + 8 - 9) - 2.5) : 1.5 + r() * 12;
      const places = Array.from({ length: Math.floor(r() * 8) }, (_, i) => ({
        id: `p${trial}-${i}`, name: `Place ${i}`, place_type: pick(r, PLACE_TYPES), category: "x", neighborhood: r() < 0.5 ? "Zhongli" : null, blurb: null,
        verified: r() < 0.5, city: "Taoyuan", status: "active",
        ...(r() < 0.3 ? { lat: 24.96, lng: 121.22 } : r() < 0.2 ? { lat: 43.06, lng: 141.35 } : { lat: null, lng: null }),
      }));
      const s = sessionAt(nowMs, hours, {
        wantsToLeave: r() < 0.8, immigrationRequired: r() < 0.3, checkedBags: r() < 0.3,
        vibeChips: [...new Set(Array.from({ length: Math.floor(r() * 4) }, () => pick(r, ["food", "shopping", "culture", "nightlife", "nature"])))],
      });
      const legacy = await generate([], s, nowMs, { places });
      const shadow = await generate([SHADOW_ALL], s, nowMs, { places });
      const on = await generate([ON_ALL], s, nowMs, { places });
      const tag = `trial ${trial}`;
      // Shadow publishes nothing.
      assert.deepEqual(shadow.rows, legacy.rows, tag);
      assert.deepEqual(shadow.cards, legacy.cards, tag);
      assert.deepEqual(withoutRanking(shadow.event), legacy.event, tag);
      // On: the served set IS the legacy set …
      assert.deepEqual(on.rows.map(identity).sort(), legacy.rows.map(identity).sort(), `${tag}: the set changed`);
      assert.deepEqual(on.cards.map(identity).sort(), legacy.cards.map(identity).sort(), `${tag}: the served set changed`);
      // … every rating at every position is legacy's …
      assert.deepEqual(on.rows.map((x) => x.safety_rating), legacy.rows.map((x) => x.safety_rating), `${tag}: a card crossed a rating`);
      // … and each card is legacy's card, field for field, but for its position.
      const legacyById = new Map(legacy.rows.map((x) => [identity(x), x]));
      for (const x of on.rows) {
        const { sort_order: _a, ...rest } = x;
        const { sort_order: _b, ...want } = legacyById.get(identity(x))!;
        assert.deepEqual(rest, want, `${tag}: ${identity(x)} changed beyond its position`);
      }
      assert.deepEqual(withoutRanking(on.event), legacy.event, `${tag}: the audit record changed`);
      assert.equal((on.event.ranking as Record<string, unknown>).compared, legacy.rows.length, tag);
      if (on.rows.some((x, i) => identity(x) !== identity(legacy.rows[i]!))) reordered += 1;
    }
    assert.ok(reordered >= 5, `the sweep must include re-ordered layovers (reordered ${reordered})`);
  });
});

// ── F. the admin divergence report ───────────────────────────────────────────

let server: http.Server;
let base: string;
const ADMIN = "admin-token";

function get(path: string, token: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    http.get({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c));
      res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
    }).on("error", reject);
  });
}

const P = "/api/admin/layover/metrics";
const recent = () => new Date(Date.now() - 2 * HOUR).toISOString();
const genEvent = (metadata: Record<string, unknown>) => ({ session_id: "s1", user_id: "user-1", event_type: "recommendation_generated", created_at: recent(), metadata });
const tally = (mode: "shadow" | "on", compared: number, moved: number, over: Record<string, unknown> = {}) => ({
  ranking: { objectiveVersion: LAYOVER_OBJECTIVE_VERSION, mode, compared, moved, topChanged: false, knownByTerm: { uncertainty: compared, return_risk: 1 }, refused: false, ...over },
});

function adminTables(flagRows: unknown[], events: unknown[]) {
  return {
    feature_flags: flagRows as any[],
    profiles: [{ id: "admin-1", role: "admin" }, { id: "user-1", role: "user" }],
    layover_events: events as any[],
    layover_certified_computations: [] as any[],
  };
}

describe("F. GET /api/admin/layover/metrics — the rollout mode and the objective's divergence, counts only", () => {
  before(() => {
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
    app.use("/api", adminLayoverMetricsRouter);
    return new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
    });
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("the seed: mode legacy (flag_absent), no cohort, legacy generations counted, the registry named", async () => {
    _setTestClient(makeLayoverDb(adminTables([], [genEvent({ count: 3 }), genEvent({ count: 4 })]), { users: { [ADMIN]: "admin-1" } }), true);
    const r = await get(P, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ro = r.body.layoverRollout;
    assert.deepEqual([ro.ranking.flag, ro.ranking.mode, ro.ranking.reason, ro.ranking.cohort], [LAYOVER_RANKING_MODE_FLAG, "legacy", "flag_absent", null]);
    assert.equal(ro.ranking.window.generations, 2);
    assert.equal(ro.ranking.window.legacy, 2);
    assert.deepEqual([ro.ranking.window.shadow, ro.ranking.window.on, ro.ranking.window.divergent], [0, 0, 0]);
    assert.deepEqual(ro.shadowArms.map((a: any) => a.capability).sort(), ["lifecycle_machine", "ranking_objective"]);
    assert.deepEqual(ro.liveWithoutShadow, [...LAYOVER_LIVE_FLAGS_WITHOUT_SHADOW]);
  });

  it("shadow and on tallies fold: divergence, moves, KNOWN-term coverage; a failed or malformed tally is MALFORMED, never skipped", async () => {
    const events = [
      genEvent(tally("shadow", 6, 2, { topChanged: true })),
      genEvent(tally("shadow", 5, 0)),
      genEvent(tally("on", 4, 2)),
      genEvent({ ranking: { ...tally("shadow", 3, 0).ranking, failed: true } }), // a failed comparison that still carries counts is not a comparison
      genEvent(tally("shadow", 2, 3)), // moved > compared
      genEvent(tally("legacy" as never, 2, 0)),
      genEvent(tally("on", 2, 0, { knownByTerm: { price_fit: 1 } })),
      genEvent({ count: 1 }),
    ];
    _setTestClient(makeLayoverDb(adminTables([modeRow(true, { mode: "shadow", cohort: { kind: "users", userIds: ["user-1", "user-9"] } })], events), { users: { [ADMIN]: "admin-1" } }), true);
    const r = await get(P, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ro = r.body.layoverRollout.ranking;
    assert.deepEqual([ro.mode, ro.reason, ro.cohort], ["shadow", "resolved", "2 listed user(s) (D6=A)"]);
    const w = ro.window;
    assert.deepEqual(
      [w.generations, w.legacy, w.shadow, w.on, w.malformed, w.compared, w.divergent, w.moved, w.topChanged],
      [8, 1, 2, 1, 4, 15, 2, 4, 1],
    );
    assert.equal(w.knownByTerm.uncertainty, 15);
    assert.equal(w.knownByTerm.return_risk, 3);
    assert.ok(!JSON.stringify(r.body).includes("user-1") && !JSON.stringify(r.body).includes("user-9"), "the cohort is described, its user ids are not served");
  });

  it("END TO END: the real generator under shadow writes the tally the route reports", async () => {
    const t: ReturnType<typeof genTables> = { ...genTables([SHADOW_ALL]), profiles: [{ id: "admin-1", role: "admin" }] };
    const db = makeLayoverDb(t, { users: { [ADMIN]: "admin-1" } });
    await generateRecommendations(db as never, AIRPORT, sessionAt(NIGHT, 11, { vibeChips: [] }), NIGHT, {});
    // The double stamps the event at write time; age it a second so the route's half-open window
    // [now - 7d, now) cannot exclude it by landing in the same millisecond (§72.8's flake).
    for (const e of t.layover_events) e.created_at = new Date(Date.now() - 1_000).toISOString();
    _setTestClient(db, true);
    const r = await get(P, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = r.body.layoverRollout.ranking.window;
    assert.deepEqual([w.generations, w.shadow, w.divergent, w.moved, w.malformed], [1, 1, 1, 2, 0]);
    assert.equal(w.compared, t.layover_recommendations.length);
    assert.ok(!JSON.stringify(r.body.layoverRollout).includes("session-1"), "no session id leaves the route");
  });
});

describe("F'. the window fold, pure", () => {
  it("counts only well-formed shadow/on tallies; legacy is the absence of the key", () => {
    const w = layoverRankingWindow([{}, null, "x", { ranking: null }, { ranking: [] }, tally("on", 3, 1), { ranking: { ...tally("shadow", 3, 1).ranking, topChanged: "no" } }], true);
    assert.deepEqual([w.generations, w.legacy, w.on, w.shadow, w.malformed, w.truncated], [7, 3, 1, 0, 3, true]);
  });
});

// ── G. the registry and the seed, against the tree ──────────────────────────

const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("G. the registry says what the tree does; 3784 seeds legacy; the five live flags are untouched (OQ-7)", () => {
  it("every shadow arm's file writes its shadow log line and reads its flag", () => {
    for (const [cap, arm] of Object.entries(LAYOVER_SHADOW_ARMS)) {
      const src = read(arm.file);
      assert.ok(src.includes(`"${arm.shadowLog}`), `${cap}: ${arm.file} writes no "${arm.shadowLog}" line`);
      const reader = arm.mechanism === "mode_row" ? read("lib/layoverRolloutMode.ts") : src;
      assert.ok(reader.includes(`"${arm.flag}"`), `${cap}: "${arm.flag}" is not read where the registry says`);
    }
    assert.ok(read("services/airport/LayoverRecommendationService.ts").includes("applyLayoverRankingMode(db, session, ranked"), "the ranking arm is not wired into the generator");
  });

  it("each shadow arm's flag is seeded FALSE; the five live flags are exactly 0127's TRUE seeds and nothing in 3784 touches them", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    for (const arm of Object.values(LAYOVER_SHADOW_ARMS)) {
      const seeds = files.filter((f) => new RegExp(`\\(\\s*'${arm.flag}'\\s*,\\s*(false|FALSE)\\b`).test(readFileSync(join(MIGRATIONS, f), "utf8")));
      assert.ok(seeds.length >= 1, `${arm.flag} is not seeded FALSE by any migration`);
    }
    const m0127 = readFileSync(join(MIGRATIONS, files.find((f) => f.startsWith("0127_"))!), "utf8");
    const trueSeeds = [...m0127.matchAll(/\('([a-z_]+)',\s*TRUE,/g)].map((x) => x[1]);
    assert.deepEqual([...LAYOVER_LIVE_FLAGS_WITHOUT_SHADOW].sort(), trueSeeds.sort());
    const m3784 = readFileSync(join(MIGRATIONS, "3784_layover_ranking_mode_flag.sql"), "utf8");
    for (const f of LAYOVER_LIVE_FLAGS_WITHOUT_SHADOW) assert.ok(!m3784.includes(f), `3784 names live flag ${f}`);
  });

  it("the 3784 row, as written, resolves to legacy — flag_disabled as seeded, and legacy still if only `enabled` is flipped", async () => {
    const sql = readFileSync(join(MIGRATIONS, "3784_layover_ranking_mode_flag.sql"), "utf8").replace(/^\s*--.*$/gm, "");
    const m = /'layover_ranking_mode',\s*(false|true),\s*'(?:[^']|'')*',\s*'(\{[^']*\})'::jsonb/i.exec(sql);
    assert.ok(m, "3784's INSERT could not be read");
    assert.equal(m[1].toLowerCase(), "false");
    const metadata = JSON.parse(m[2]);
    assert.equal(metadata.mode, "legacy");
    assert.ok(/ON CONFLICT \(flag\) DO NOTHING/.test(sql), "an operator's later setting must never be overwritten");
    const seeded = await resolveLayoverRolloutMode(flagsDb([modeRow(false, metadata)]), "ranking_objective");
    assert.deepEqual([seeded.mode, seeded.reason], ["legacy", "flag_disabled"]);
    const flipped = await resolveLayoverRolloutMode(flagsDb([modeRow(true, metadata)]), "ranking_objective");
    assert.deepEqual([flipped.mode, flipped.reason], ["legacy", "resolved"], "inert twice over: enabled alone does not leave legacy");
  });
});

// ── H. H5: the money guard scans the new files, and they are clean ───────────

describe("H. H5 — check:no-money-in-ranking scans objective and hook; only explicit traveller-cost allowances", () => {
  const NEW_FILES = ["services/airport/layoverObjective.ts", "services/airport/layoverRankingMode.ts"];

  it("both files are in the guard's scope, scanned and clean, and no owner question is open", () => {
    const real = runCheck(SRC);
    for (const f of NEW_FILES) assert.ok(real.scanned.has(f), `${f} is not scanned by check:no-money-in-ranking`);
    assert.equal(failureCount(real), 0);
    assert.deepEqual(real.findings.filter((f) => NEW_FILES.includes(f.file) || f.file === "services/airport/LayoverRecommendationService.ts"), []);
    assert.equal(OPEN_DECISIONS.length, 0, "OPEN_DECISIONS must stay empty (H5)");
    for (const f of [...NEW_FILES, "lib/layoverRolloutMode.ts"]) {
      const hits = moneyIdentifiersIn(read(f));
      // L78 restored explicit traveller cost; only its registered currency disclosure is admitted here.
      assert.deepEqual(hits.filter(hit => f !== "services/airport/layoverObjective.ts" || hit.identifier !== "currency"), [], f);
      for (const hit of hits) assert.ok(real.allowed.some(a => a.file === f && a.identifier === hit.identifier));
    }
  });

  it("an unsourced price read planted in the objective remains a finding at its line", () => {
    const root = mkdtempSync(join(tmpdir(), "lay4-money-"));
    try {
      const file = "services/airport/layoverObjective.ts";
      mkdirSync(join(root, "services/airport"), { recursive: true });
      writeFileSync(join(root, file), "export const uncertainty = (c: any) => c.verified;\nexport const monetaryTerm = (c: any) => c.price_level;\n");
      const scope = SCOPE.filter((e) => e.path === "services/airport");
      const r = runCheck(root, { scope, allowlist: [], outOfScope: [], openDecisions: [] });
      assert.ok(r.findings.some((f) => f.file === file && f.identifier === "price_level" && f.line === 2), JSON.stringify(r.findings));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the objective reads no category default and no cost band: it imports neither the primitive nor the Trips compiler", () => {
    for (const f of NEW_FILES) {
      const src = read(f);
      assert.ok(!/layoverExperiencePrimitive|TripExperienceCompiler|PRIMITIVE_DEFAULTS/.test(src.replace(/^\s*(\/\/|\*).*$/gm, "")), `${f} reaches the ExperiencePrimitive`);
      assert.ok(!/\.(costRange|costBand|cost_band|priceLevel|price)\b/.test(src), `${f} reads a cost or price field`);
    }
  });
});
