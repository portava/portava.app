/**
 * §22 L243–L250 — the airport maturity model, and what it is allowed to gate.
 *
 * The census scores L243 and L250 BUILT-BUT-WRONG and L244–L249 NOT-BUILT. The
 * two W verdicts share one sentence between them: the ladder's rungs exist as
 * DATA (a static dataset, an `airport_profiles` row, a `verified` flag) and
 * gate NOTHING — "a session on a generic fallback profile still receives
 * landside recommendations", and "a curated airport and a generic-fallback one
 * present identical confidence".
 *
 * ── WHAT THIS FILE PROVES, AND WHAT IT CANNOT ────────────────────────────────
 * It proves the CLASSIFIER is real: a set of signals maps to one of the spec's
 * six rungs, different signals give different rungs, and the feature table
 * refuses at L0 what it permits at L1.
 *
 * It does NOT prove the product gates anything, because nothing calls this
 * module — `LayoverRecommendationService.ts` is where the gate would go and
 * this work does not own it. The last case in this file asserts that
 * divergence directly rather than leaving it as a claim: the engine's answer at
 * a generic airport is compared to the maturity policy's, and they disagree.
 * That is the L243 defect, expressed as a failing product expectation that is
 * PASSING as a recorded divergence — so the day someone wires the gate, the
 * case goes red and has to be updated deliberately.
 *
 * ── POSITIVE CONTROLS ────────────────────────────────────────────────────────
 * A maturity ladder is trivially fakeable: return L0 always and every "L0
 * refuses landside" assertion passes forever. So:
 *   - every level DECLARED REACHABLE must be produced by some signal set built
 *     in this file, walked from the level list rather than asserted one by one;
 *   - every level DECLARED UNREACHABLE must be produced by NONE of them, and
 *     must name the artifact whose absence blocks it;
 *   - the feature table must both permit and refuse something, or it is not a
 *     gate.
 *
 * Run: node --import tsx/esm --test src/test/layoverMaturityModel.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AIRPORT_MATURITY_LEVELS,
  MATURITY_FEATURES,
  MATURITY_LEVEL_REACHABILITY,
  airportMaturity,
  featureAllowedAt,
  maturityDisclosure,
  type MaturitySignals,
} from "../services/airport/layoverMaturity.js";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-13T02:00:00.000Z");

const NONE: MaturitySignals = {
  hasAirportRow: false,
  verified: false,
  hasTerminalTopology: false,
  hasKnownTransportModel: false,
  hasExternalLiveFeed: false,
  portavaObservationCount: 0,
  hasCalibration: false,
};

/** One signal set per rung the ladder claims to reach. */
const SIGNAL_SETS: Record<string, MaturitySignals> = {
  L0_GENERIC: NONE,
  L1_MAPPED: { ...NONE, hasAirportRow: true, verified: true, hasTerminalTopology: true, hasKnownTransportModel: true },
  L2_EXTERNAL_LIVE: {
    ...NONE, hasAirportRow: true, verified: true, hasTerminalTopology: true,
    hasKnownTransportModel: true, hasExternalLiveFeed: true,
  },
  L3_PORTAVA_OBSERVED: {
    ...NONE, hasAirportRow: true, verified: true, hasTerminalTopology: true,
    hasKnownTransportModel: true, hasExternalLiveFeed: true, portavaObservationCount: 40,
  },
  L4_CALIBRATED: {
    ...NONE, hasAirportRow: true, verified: true, hasTerminalTopology: true,
    hasKnownTransportModel: true, hasExternalLiveFeed: true, portavaObservationCount: 40,
    hasCalibration: true,
  },
  L5_DENSE_LIVE: {
    ...NONE, hasAirportRow: true, verified: true, hasTerminalTopology: true,
    hasKnownTransportModel: true, hasExternalLiveFeed: true, portavaObservationCount: 500,
    hasCalibration: true,
  },
};

// ── the ladder ───────────────────────────────────────────────────────────────

describe("§22 L243–L248 — the six rungs, named as the spec names them", () => {
  it("has exactly the spec's six levels in order", () => {
    assert.deepEqual([...AIRPORT_MATURITY_LEVELS], [
      "L0_GENERIC", "L1_MAPPED", "L2_EXTERNAL_LIVE",
      "L3_PORTAVA_OBSERVED", "L4_CALIBRATED", "L5_DENSE_LIVE",
    ]);
  });

  it("POSITIVE CONTROL: every level the classifier can reach IS reached by some signal set", () => {
    const reached = new Set(Object.values(SIGNAL_SETS).map((s) => airportMaturity(s).level));
    for (const level of AIRPORT_MATURITY_LEVELS) {
      const decl = MATURITY_LEVEL_REACHABILITY[level];
      if (decl.reachable) {
        assert.ok(reached.has(level), `${level} is declared reachable but no signal set produces it`);
      }
    }
  });

  it("POSITIVE CONTROL: every level declared UNREACHABLE names what is missing, and no signal set reaches it", () => {
    const reached = new Set(Object.values(SIGNAL_SETS).map((s) => airportMaturity(s).level));
    const unreachable = AIRPORT_MATURITY_LEVELS.filter((l) => !MATURITY_LEVEL_REACHABILITY[l].reachable);
    assert.ok(unreachable.length > 0, "a ladder where every rung is reachable is not describing this tree");
    for (const level of unreachable) {
      const why = MATURITY_LEVEL_REACHABILITY[level].blockedBy;
      assert.ok(why && why.length > 20, `${level} is unreachable for reason "${why}"`);
      // A reason must point at something checkable: a table, a column, a
      // module symbol, or a named absent producer. "not implemented" is not a
      // reason, and this pattern is what refuses it.
      assert.match(
        why!,
        /airport_profiles|layover_[a-z_]+|[A-Z][A-Za-z]+\.[a-z][A-Za-z]+|no .*(feed|writer|ingest)/,
        `${level} is blocked by something unnameable: ${why}`,
      );
    }
    // The signal sets above are HYPOTHETICAL — they set flags no producer sets.
    // The classifier must still map them, or the ladder could not be tested at
    // all; what "unreachable" means is that no PRODUCER on this tree sets them.
    assert.ok(reached.size >= 2, "the classifier collapses every signal set to one rung");
  });

  it("a production-shaped airport is L0, and that is the measured reality", () => {
    // Measured 2026-09-07: 3,206 airport_profiles rows, 0 verified, 0 with a
    // non-default buffer, 0 with terminal_info.
    const productionShape: MaturitySignals = { ...NONE, hasAirportRow: true };
    const m = airportMaturity(productionShape);
    assert.equal(m.level, "L0_GENERIC");
    assert.ok(m.evidence.length > 0);
  });

  it("POSITIVE CONTROL: the ladder does not skip — a gap in a lower rung caps the level", () => {
    // Live feed present but nothing mapped: the airport cannot be L2, because
    // L2 means "reliable live signals ON TOP OF a modelled airport".
    const skipped: MaturitySignals = { ...NONE, hasAirportRow: true, hasExternalLiveFeed: true };
    assert.equal(airportMaturity(skipped).level, "L0_GENERIC");
  });
});

// ── L249 — features gated by maturity ────────────────────────────────────────

describe("§22 L249 — features are enabled per maturity", () => {
  it("the table both PERMITS and REFUSES, or it is not a gate", () => {
    const permitted = MATURITY_FEATURES.filter((f) => f.minimumLevel === "L0_GENERIC");
    const gated = MATURITY_FEATURES.filter((f) => f.minimumLevel !== "L0_GENERIC");
    assert.ok(permitted.length > 0, "nothing is available at L0 — the product would be empty");
    assert.ok(gated.length > 0, "nothing is withheld at any level — this is not a gate");
  });

  it("L243: at L0 the default is AIRPORT-SIDE GUIDANCE ONLY", () => {
    assert.equal(featureAllowedAt("airside_guidance", "L0_GENERIC"), true);
    assert.equal(featureAllowedAt("landside_recommendations", "L0_GENERIC"), false);
    assert.equal(featureAllowedAt("landside_recommendations", "L1_MAPPED"), true);
  });

  it("POSITIVE CONTROL: dynamic replanning is withheld until the rung that can support it", () => {
    assert.equal(featureAllowedAt("dynamic_replanning", "L1_MAPPED"), false);
    assert.equal(featureAllowedAt("dynamic_replanning", "L4_CALIBRATED"), false);
    assert.equal(featureAllowedAt("dynamic_replanning", "L5_DENSE_LIVE"), true);
  });

  it("every feature's minimum level is a real rung, so a typo cannot open a gate", () => {
    for (const f of MATURITY_FEATURES) {
      assert.ok(
        (AIRPORT_MATURITY_LEVELS as readonly string[]).includes(f.minimumLevel),
        `${f.feature} requires ${f.minimumLevel}, which is not a level`,
      );
    }
  });

  it("POSITIVE CONTROL: an unknown feature is REFUSED, not silently permitted", () => {
    assert.equal(featureAllowedAt("a_feature_nobody_declared", "L5_DENSE_LIVE"), false);
  });
});

// ── L250 — disclosure differs by rung ────────────────────────────────────────

describe("§22 L250 — 'limited intelligence' is a valid, VISIBLE product state", () => {
  it("POSITIVE CONTROL: two rungs do not present identical confidence", () => {
    const low = maturityDisclosure("L0_GENERIC");
    const high = maturityDisclosure("L4_CALIBRATED");
    assert.notEqual(low.headline, high.headline);
    assert.notEqual(low.confidence, high.confidence);
    // This is the exact census sentence for L250: "a curated airport and a
    // generic-fallback one present identical confidence". If that becomes true
    // of this module, this case goes red.
  });

  it("the L0 disclosure says the numbers are not about this airport", () => {
    const d = maturityDisclosure("L0_GENERIC");
    assert.match(d.detail, /not.*specific|generic|any airport/i);
    assert.equal(d.reasonCode, "AIRPORT_MATURITY_LIMITED");
  });

  it("POSITIVE CONTROL: the top rung emits NO limitation reason code", () => {
    assert.equal(maturityDisclosure("L5_DENSE_LIVE").reasonCode, null);
  });

  it("every level has a distinct headline — no two rungs read the same", () => {
    const heads = AIRPORT_MATURITY_LEVELS.map((l) => maturityDisclosure(l).headline);
    assert.equal(new Set(heads).size, heads.length);
  });
});

// ── the divergence this module does NOT close ────────────────────────────────

describe("§22 L243 — the gate is NOT wired, recorded as a live divergence", () => {
  const airport = (over: Partial<FeasibilityAirport> = {}): FeasibilityAirport => ({
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    ...over,
  });
  const session = (): FeasibilitySession => ({
    id: "session-1",
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + 8 * HOUR).toISOString(),
    boardingTime: null, flightType: "international", immigrationRequired: true,
    checkedBags: false, wantsToLeave: true,
  });

  it("a GENERIC-fallback airport still gets a landside verdict from the engine", () => {
    // The fallback profile: no row, so L0 by this module's own classifier.
    const generic = certifySessionFeasibility(airport({ id: null, verified: false }), session(), {
      nowMs: NOW,
    });
    const level = airportMaturity({ ...NONE, hasAirportRow: false }).level;
    assert.equal(level, "L0_GENERIC");
    assert.equal(featureAllowedAt("landside_recommendations", level), false);

    // …and the engine says yes anyway. THE TWO DISAGREE, and that disagreement
    // is census L243. The day `LayoverRecommendationService` consults the gate,
    // this assertion goes red and must be rewritten as agreement — which is the
    // point of pinning it rather than describing it.
    // Captured BEFORE the assertion below, on purpose. `assert.equal` narrows
    // `generic.verdict` to the literal "yes", after which `verdict !== "no"` is
    // a comparison the COMPILER has already decided (TS2367) rather than one
    // this test makes — and the disagreement it is pinning would stop being
    // observable in the type. Reading it first keeps the comparison real.
    const engineAllowsLandside: boolean = generic.verdict !== "no";
    // Was `"yes"` until the entry gate landed. A call that supplies no entry
    // fact is a call that has not asked whether this traveller may enter, and
    // the engine now says so — `entry_unverified` — instead of saying yes. The
    // DIVERGENCE this test pins is untouched by that: the maturity gate forbids
    // landside recommendations at L0 and the engine still permits them, which
    // is L243. Only the word changed, not the disagreement.
    assert.equal(generic.verdict, "entry_unverified");
    assert.notEqual(
      featureAllowedAt("landside_recommendations", level),
      engineAllowsLandside,
      "the maturity gate and the engine now AGREE — L243 may be closable; re-score it",
    );
  });
});
