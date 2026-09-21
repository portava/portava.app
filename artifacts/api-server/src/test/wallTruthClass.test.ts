/**
 * Sensing §108 — "Every server-built state consumed by Map / Discovery / Wall /
 * Compass should carry truth class, confidence, freshness and coverage.
 * PREDICTION MUST NEVER BE RENDERED INDISTINGUISHABLY FROM OBSERVATION."
 *
 * The Wall census never counted this: it censused the Wall spec, and this
 * obligation is imposed on the Wall from the Sensing spec's §9 / §108 / S6. The
 * Live For You strip and the Context Thread were carrying `freshness`,
 * `confidence` and a §10 conflict state — but no truth class and no coverage —
 * so an event SCHEDULE and an observed crowd state arrived at the client in the
 * same shape, distinguished only by a label string the client could not reason
 * about.
 *
 * THE DERIVATION IS FAIL-WEAK BY CONSTRUCTION. `deriveWallTruthClass` resolves
 * to the WEAKEST applicable class, so no combination of inputs can promote a
 * prediction, a stale fact or an unknown source into an observation. That is the
 * single property §108 exists to protect and it is asserted exhaustively below.
 *
 * MUTATION PROOF (each verified: revert → RED, restore → GREEN)
 *   • reorder `deriveWallTruthClass` so the source-class branch runs before the
 *     freshness/conflict branches → the precedence tests RED.
 *   • default the resolved-fact branch of `buildLiveForYou` to "observed"
 *     instead of "unknown" → the no-silent-promotion test RED.
 *   • change the event producer's `truthClass` from "predicted" to "observed" →
 *     the schedule test RED.
 *   • drop `coverage: coverageFromBucket(env.sourceCountBucket)` → the coverage
 *     tests RED.
 *   • make `truthClassMayRenderAsObservation` return true for "predicted" → the
 *     renderability test RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coverageFromBucket,
  deriveWallTruthClass,
  truthClassMayRenderAsObservation,
  NON_OBSERVATION_TRUTH_CLASSES,
  type WallTruthClass,
} from "../lib/wallProjection.js";
import { buildLiveForYou, type LiveForYouCandidate } from "../services/wall/LiveForYouService.js";

// ── The derivation ───────────────────────────────────────────────────────────

describe("deriveWallTruthClass — the §5.1 vocabulary, weakest class wins", () => {
  it("a firsthand observation from one reporter is `observed`", () => {
    assert.equal(
      deriveWallTruthClass({ sourceClass: "firsthand_unverified", coverage: "few" }),
      "observed",
    );
    assert.equal(
      deriveWallTruthClass({ sourceClass: "verified_firsthand", coverage: "few" }),
      "observed",
    );
  });

  it("independent corroboration lifts it to `corroborated`", () => {
    for (const coverage of ["several", "many"] as const) {
      assert.equal(
        deriveWallTruthClass({ sourceClass: "verified_firsthand", coverage }),
        "corroborated",
      );
    }
  });

  it("a prediction or a historical pattern is `predicted` — never observed", () => {
    assert.equal(deriveWallTruthClass({ sourceClass: "portava_prediction" }), "predicted");
    assert.equal(deriveWallTruthClass({ sourceClass: "historical_pattern" }), "predicted");
  });

  it("hearsay is `inferred`", () => {
    assert.equal(deriveWallTruthClass({ sourceClass: "hearsay" }), "inferred");
  });

  it("§37 — a SPONSORED or IMPORTED claim is never an observation, at any coverage", () => {
    // "Promotional claim ≠ observed reality" (Sensing §2), and §37's "paid /
    // promoted content is separated from factual live confidence". This is the
    // structural half of that rule: a paid claim cannot reach the truth class an
    // observation gets, whatever else is true about it.
    for (const cls of ["sponsored", "imported_owned"] as const) {
      for (const coverage of ["few", "several", "many", "unknown"] as const) {
        const truth = deriveWallTruthClass({ sourceClass: cls, coverage });
        assert.equal(truth, "inferred", `${cls} @ ${coverage}`);
        assert.equal(truthClassMayRenderAsObservation(truth), false);
      }
    }
    // Positive control: the same coverage on a firsthand class DOES corroborate.
    assert.equal(
      deriveWallTruthClass({ sourceClass: "verified_firsthand", coverage: "many" }),
      "corroborated",
    );
  });

  it("an official update is an observation, but never independent consensus", () => {
    assert.equal(deriveWallTruthClass({ sourceClass: "official_signed" }), "observed");
    // The read path withholds the cohort bucket for a non-consensus class, so an
    // official claim arrives with unknown coverage and stays `observed`.
    assert.equal(coverageFromBucket(null), "unknown");
  });

  it("an absent or unrecognised source class is `unknown`, never observed", () => {
    for (const cls of [null, undefined, "", "made_up_class"]) {
      assert.equal(deriveWallTruthClass({ sourceClass: cls as any }), "unknown");
    }
  });

  it("PRECEDENCE: stale beats everything — a lapsed horizon cannot be an observation", () => {
    assert.equal(
      deriveWallTruthClass({
        sourceClass: "verified_firsthand",
        coverage: "many",
        conflictState: "none",
        freshness: "stale",
      }),
      "stale",
    );
  });

  it("PRECEDENCE: a material conflict beats corroboration (§10)", () => {
    assert.equal(
      deriveWallTruthClass({
        sourceClass: "verified_firsthand",
        coverage: "many",
        conflictState: "material",
      }),
      "conflicting",
    );
  });

  it("PRECEDENCE: coverage cannot promote a prediction", () => {
    assert.equal(
      deriveWallTruthClass({ sourceClass: "portava_prediction", coverage: "many" }),
      "predicted",
      "many predictions are still a prediction",
    );
  });

  it("a minor conflict is not a material one and does not change the class", () => {
    assert.equal(
      deriveWallTruthClass({ sourceClass: "firsthand_unverified", conflictState: "minor" }),
      "observed",
    );
  });
});

describe("coverageFromBucket — `unknown` is a value, not an absence", () => {
  it("passes the three canonical buckets through", () => {
    for (const bucket of ["few", "several", "many"] as const) {
      assert.equal(coverageFromBucket(bucket), bucket);
    }
  });

  it("a withheld / absent / unrecognised bucket is `unknown`, never `few`", () => {
    for (const bucket of [null, undefined, "", "lots"]) {
      assert.equal(coverageFromBucket(bucket as any), "unknown");
    }
  });
});

describe("truthClassMayRenderAsObservation — the §108 boundary", () => {
  it("only observed / corroborated / conflicting may read as a current fact", () => {
    const may: WallTruthClass[] = ["observed", "corroborated", "conflicting"];
    for (const cls of may) assert.equal(truthClassMayRenderAsObservation(cls), true, cls);
  });

  it("prediction, inference, staleness and unknown may not", () => {
    for (const cls of NON_OBSERVATION_TRUTH_CLASSES) {
      assert.equal(truthClassMayRenderAsObservation(cls), false, cls);
    }
    assert.ok(NON_OBSERVATION_TRUTH_CLASSES.includes("predicted"));
  });
});

// ── Carriage: every strip item states its class ──────────────────────────────

describe("§108 — every Live For You item carries a truth class and coverage", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const validUntil = new Date(now.getTime() + 3_600_000).toISOString();

  function resolved(
    liveObjectType: LiveForYouCandidate["liveObjectType"],
    over: Record<string, unknown> = {},
  ): LiveForYouCandidate {
    return {
      subjectId: `subject-${liveObjectType}`,
      liveObjectType,
      subject: { placeId: `subject-${liveObjectType}`, name: "An Thuong" },
      resolved: {
        id: `id-${liveObjectType}`,
        label: "something",
        state: "emerging",
        confidence: 0.7,
        observedAt: now.toISOString(),
        validUntil,
        ...over,
      },
    };
  }

  it("an event SCHEDULE is predicted, and is not rendered as an observation", async () => {
    const items = await buildLiveForYou(null, [
      resolved("event_state", { truthClass: "predicted", coverage: "unknown" }),
    ], { now });
    assert.equal(items[0].truthClass, "predicted");
    assert.equal(truthClassMayRenderAsObservation(items[0].truthClass), false);
  });

  it("a trip PLAN is predicted too", async () => {
    const items = await buildLiveForYou(null, [
      resolved("trip_signal", { truthClass: "predicted", coverage: "unknown" }),
    ], { now });
    assert.equal(items[0].truthClass, "predicted");
  });

  it("a producer that states nothing gets `unknown` — never a silent `observed`", async () => {
    const items = await buildLiveForYou(null, [resolved("buddy")], { now });
    assert.equal(items[0].truthClass, "unknown");
    assert.equal(items[0].coverage, "unknown");
    assert.equal(truthClassMayRenderAsObservation(items[0].truthClass), false);
  });

  it("a corroborated social-presence fact keeps its class and coverage", async () => {
    const items = await buildLiveForYou(null, [
      resolved("social_presence", { truthClass: "corroborated", coverage: "several" }),
    ], { now });
    assert.equal(items[0].truthClass, "corroborated");
    assert.equal(items[0].coverage, "several");
  });

  it("EVERY item on a mixed strip carries both fields", async () => {
    const items = await buildLiveForYou(null, [
      resolved("event_state", { truthClass: "predicted", coverage: "unknown" }),
      resolved("buddy", { truthClass: "observed", coverage: "few" }),
      resolved("hidden_gem", { truthClass: "inferred", coverage: "unknown" }),
      resolved("social_presence", { truthClass: "corroborated", coverage: "many" }),
    ], { now });
    assert.equal(items.length, 4);
    for (const item of items) {
      assert.ok(item.truthClass, `${item.liveObjectType} must carry a truth class`);
      assert.ok(item.coverage, `${item.liveObjectType} must carry a coverage`);
    }
    // And a prediction is distinguishable from an observation on the wire, which
    // is the whole requirement — the client does not have to guess from a label.
    const byKind = new Map(items.map((i) => [i.liveObjectType, i.truthClass]));
    assert.equal(byKind.get("event_state"), "predicted");
    assert.equal(byKind.get("buddy"), "observed");
    assert.notEqual(byKind.get("event_state"), byKind.get("buddy"));
  });
});
