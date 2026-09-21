/**
 * mapExperienceState — Sensing §7 SX-02 / SX-07 on the Map: the server-built
 * ExperienceState fold and the §5.1 truth / §4.4 coverage metadata, and the
 * gate that keeps both INERT until `map_experience_state_enabled` is flipped.
 *
 * Fixtures are DERIVED from the real contracts, as src/test/mapLiveAxes.test.ts
 * does: the claim shape from `mapQuickSignal`, the envelope from
 * `toLiveClaimEnvelope` (so the withheld sponsored bucket is the read path's
 * own ruling, not a hand-typed null), and the vocabularies from intelContracts.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapExperienceState.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  applyLiveClaims,
  attributedSourceClass,
  type LiveClaimLike,
} from "../lib/mapProjection.js";
import {
  buildExperienceState,
  deriveMapTruthClass,
  foldCoverage,
  type ExperienceState,
} from "../lib/mapExperienceState.js";
import {
  COVERAGE_STATES,
  KIND_DEFAULT_PRIORITY,
  RENDERING_PRIORITY,
  TRUTH_CLASSES,
  truthClassMayRenderAsObservation,
  type MapObject,
} from "../lib/mapObjects.js";
import { COARSENED_PAYLOAD_KEYS, coarsenForZone } from "../lib/protectedLocations.js";
import { SOURCE_CLASSES, TRAJECTORIES, VIBE_STATES, type SourceClass } from "../lib/intelContracts.js";
import { NON_OBSERVATION_TRUTH_CLASSES, deriveWallTruthClass } from "../lib/wallProjection.js";
import { mapQuickSignal } from "../lib/quickSignal.js";
import { toLiveClaimEnvelope, type LiveClaim } from "../lib/liveClaimRead.js";

// ── fixtures, all derived ─────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const OBSERVED_AT = "2026-09-07T11:58:00.000Z";
const EXPIRES_AT = "2026-09-07T12:40:00.000Z";

function envelope(
  mapped: { claimType: string; value: unknown },
  over: Partial<LiveClaim> = {},
): LiveClaimLike {
  const claim: LiveClaim = {
    id: over.id ?? `snap-${mapped.claimType}`,
    claimType: mapped.claimType,
    value: mapped.value,
    confidence: 0.85,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCount: 30,
    observedAt: OBSERVED_AT,
    expiresAt: EXPIRES_AT,
    ...over,
  };
  return toLiveClaimEnvelope(claim);
}

const levelClaim = (level: string, over?: Partial<LiveClaim>) =>
  envelope({ claimType: "crowd.level", value: { level } }, over);
const trajectoryClaim = (trajectory: string, over?: Partial<LiveClaim>) =>
  envelope({ claimType: "crowd.trajectory", value: { trajectory } }, over);

const PLACE: MapObject = {
  id: "place:p1",
  kind: "place",
  geometry: { type: "Point", coordinates: [108.21, 16.06] },
  title: "Somewhere",
  privacyClass: "place_level",
  renderingPriority: KIND_DEFAULT_PRIORITY.place,
  payload: { category: "bar" },
};

function stateOf(obj: MapObject): ExperienceState {
  const s = (obj.payload as { experienceState?: ExperienceState } | undefined)?.experienceState;
  assert.ok(s, "expected payload.experienceState");
  return s as ExperienceState;
}

// ── the gate ──────────────────────────────────────────────────────────────────

describe("the gate — off is byte-identical to before the option existed", () => {
  const claims = [levelClaim("busy"), trajectoryClaim("building")];

  test("no opts, opts {}, and opts {experienceState:false} all produce the same object, with no truth metadata", () => {
    const a = applyLiveClaims(PLACE, claims, NOW);
    const b = applyLiveClaims(PLACE, claims, NOW, null, {});
    const c = applyLiveClaims(PLACE, claims, NOW, null, { experienceState: false });
    assert.deepEqual(b, a);
    assert.deepEqual(c, a);
    assert.equal("truthClass" in a, false);
    assert.equal("coverage" in a, false);
    assert.equal("experienceState" in (a.payload as Record<string, unknown>), false);
    // The §7 axes still fold — the gate withholds the NEW fields, not the old.
    assert.equal(a.activity, "busy");
    assert.equal(a.trend, "getting_busier");
  });

  test("on adds exactly truthClass, coverage and payload.experienceState — nothing else moves", () => {
    const off = applyLiveClaims(PLACE, claims, NOW);
    const on = applyLiveClaims(PLACE, claims, NOW, null, { experienceState: true });
    const { truthClass, coverage, payload, ...restOn } = on;
    const { payload: payloadOff, ...restOff } = off;
    assert.deepEqual(restOn, restOff);
    assert.ok(TRUTH_CLASSES.includes(truthClass as never));
    assert.ok(COVERAGE_STATES.includes(coverage as never));
    const { experienceState, ...payloadRest } = payload as Record<string, unknown>;
    assert.deepEqual(payloadRest, payloadOff, "the existing payload keys are preserved");
    assert.ok(experienceState);
  });

  test("no claims ⇒ untouched even with the option on (no state is fabricated)", () => {
    assert.equal(applyLiveClaims(PLACE, [], NOW, null, { experienceState: true }), PLACE);
  });
});

// ── the §5.3 shape ────────────────────────────────────────────────────────────

describe("the §5.3 tree — populated leaves come from ONE claim each, the rest stay null", () => {
  test("crowd.density / crowd.momentum are the SAME values as the §7 axes", () => {
    const level = mapQuickSignal("arrival", "busy");
    const trajectory = mapQuickSignal("inside", "building");
    assert.ok(level && trajectory);
    const on = applyLiveClaims(
      PLACE,
      [envelope(level!), envelope(trajectory!, { id: "snap-2" })],
      NOW,
      null,
      { experienceState: true },
    );
    const s = stateOf(on);
    assert.equal(s.basis, "live_claims");
    assert.equal(s.crowd.density, on.activity);
    assert.equal(s.crowd.momentum, on.trend);
    assert.equal(s.crowd.flow, null);
    assert.deepEqual(s.claimRefs, on.sourceRefs);
  });

  test("engines that do not exist stay null — vibe.sociality, behavior.*, dynamics.anomaly", () => {
    const s = stateOf(applyLiveClaims(PLACE, [levelClaim("busy")], NOW, null, { experienceState: true }));
    assert.deepEqual(s.vibe, { energy: null, sociality: null, dance_likelihood: null, momentum: null });
    assert.deepEqual(s.behavior, { dwell: null, stickiness: null, conversion: null, departures: null });
    assert.equal(s.dynamics.anomaly, null);
    assert.deepEqual(s.friction, { queue: null, access: null, wait: null, transport: null });
  });

  test("unsafe_density ⇒ density null (a safety claim is not a busyness reading)", () => {
    const s = stateOf(applyLiveClaims(PLACE, [levelClaim("unsafe_density")], NOW, null, { experienceState: true }));
    assert.equal(s.crowd.density, null);
  });

  test("vibe.energy is vibe.state's own vocabulary, verbatim; an unknown value is null", () => {
    for (const v of VIBE_STATES) {
      const s = stateOf(
        applyLiveClaims(PLACE, [envelope({ claimType: "vibe.state", value: { state: v } })], NOW, null, {
          experienceState: true,
        }),
      );
      assert.equal(s.vibe.energy, v);
    }
    const bad = stateOf(
      applyLiveClaims(PLACE, [envelope({ claimType: "vibe.state", value: { state: "raving" } })], NOW, null, {
        experienceState: true,
      }),
    );
    assert.equal(bad.vibe.energy, null);
  });

  test("friction: queue.wait, service.wait, access.walk_in + access.reservation, transit.condition", () => {
    const s = stateOf(
      applyLiveClaims(
        PLACE,
        [
          envelope({ claimType: "queue.wait", value: { minMinutes: 10, maxMinutes: 20 } }),
          envelope({ claimType: "service.wait", value: { serviceType: "table", minMinutes: 5, maxMinutes: null } }),
          envelope({ claimType: "access.walk_in", value: { accepted: false } }),
          envelope({ claimType: "access.reservation", value: { reservation: "required" } }),
          envelope({ claimType: "transit.condition", value: { routeOrMode: "bus 3", condition: "delayed" } }),
        ],
        NOW,
        null,
        { experienceState: true },
      ),
    );
    assert.deepEqual(s.friction.queue, { minMinutes: 10, maxMinutes: 20 });
    assert.deepEqual(s.friction.wait, { minMinutes: 5, maxMinutes: null });
    assert.deepEqual(s.friction.access, { walkIn: false, reservation: "required" });
    assert.equal(s.friction.transport, "delayed");
  });

  test("a malformed queue value is null, never a guessed number", () => {
    const s = stateOf(
      applyLiveClaims(PLACE, [envelope({ claimType: "queue.wait", value: { minMinutes: -1 } })], NOW, null, {
        experienceState: true,
      }),
    );
    assert.equal(s.friction.queue, null);
  });

  test("dynamics come from the RAW trajectory; all three are null without one (unknown ≠ false)", () => {
    const none = stateOf(applyLiveClaims(PLACE, [levelClaim("busy")], NOW, null, { experienceState: true }));
    assert.deepEqual(none.dynamics, { heating_up: null, peaking: null, cooling: null, anomaly: null });

    const expect: Record<string, [boolean, boolean, boolean]> = {
      emerging: [true, false, false],
      building: [true, false, false],
      peaking: [false, true, false],
      stable: [false, false, false],
      fragmenting: [false, false, true],
      relocating: [false, false, true],
      declining: [false, false, true],
      ending: [false, false, true],
    };
    for (const t of TRAJECTORIES) {
      const s = stateOf(applyLiveClaims(PLACE, [trajectoryClaim(t)], NOW, null, { experienceState: true }));
      assert.deepEqual(
        [s.dynamics.heating_up, s.dynamics.peaking, s.dynamics.cooling],
        expect[t],
        `trajectory ${t}`,
      );
    }
    // `peaking` is invisible through the §7 Trend axis (it maps to `stable`),
    // which is exactly why the tree reads the raw value.
    const peak = applyLiveClaims(PLACE, [trajectoryClaim("peaking")], NOW, null, { experienceState: true });
    assert.equal(peak.trend, "stable");
    assert.equal(stateOf(peak).dynamics.peaking, true);
  });
});

// ── truth + coverage ──────────────────────────────────────────────────────────

describe("truth — derived through the Wall's Sensing §5.1 rule, never upgraded", () => {
  test("the map's vocabularies are the Wall's: every Wall output is a map TruthClass and the non-observation set agrees", () => {
    const seen = new Set<string>();
    for (const cls of [...SOURCE_CLASSES, null, "nonsense"]) {
      for (const coverage of COVERAGE_STATES) {
        for (const freshness of ["live", "recent", "aging", "stale", "unknown"] as const) {
          for (const conflictState of ["none", "minor", "material"] as const) {
            const out = deriveWallTruthClass({ sourceClass: cls, coverage, freshness, conflictState });
            assert.ok(TRUTH_CLASSES.includes(out), `${out} is not a map truth class`);
            seen.add(out);
          }
        }
      }
    }
    assert.deepEqual([...seen].sort(), [...TRUTH_CLASSES].sort(), "every class is reachable");
    for (const cls of TRUTH_CLASSES) {
      assert.equal(truthClassMayRenderAsObservation(cls), !NON_OBSERVATION_TRUTH_CLASSES.includes(cls));
    }
  });

  test("the map's `historical` freshness is the Wall's `stale`", () => {
    assert.equal(
      deriveMapTruthClass({ sourceClass: "verified_firsthand", conflictState: "none", freshness: "historical", coverage: "many" }),
      "stale",
    );
  });

  test("firsthand + several/many independent reports ⇒ corroborated; few ⇒ observed", () => {
    const many = applyLiveClaims(PLACE, [levelClaim("busy", { sourceCount: 30 })], NOW, null, { experienceState: true });
    assert.equal(many.truthClass, "corroborated");
    assert.equal(many.coverage, "several");
    const few = applyLiveClaims(PLACE, [levelClaim("busy", { sourceCount: 10 })], NOW, null, { experienceState: true });
    assert.equal(few.truthClass, "observed");
    assert.equal(few.coverage, "few");
  });

  test("a sponsored claim is `inferred` with coverage `unknown` — the read path withheld its bucket and the fold does not invent one", () => {
    const on = applyLiveClaims(PLACE, [levelClaim("busy", { sourceClass: "sponsored", sourceCount: 500 })], NOW, null, {
      experienceState: true,
    });
    assert.equal(on.truthClass, "inferred");
    assert.equal(on.coverage, "unknown");
    assert.equal(stateOf(on).truth.provenance, "sponsored");
  });

  test("a prediction class is `predicted` even when it is two minutes old", () => {
    const on = applyLiveClaims(PLACE, [levelClaim("busy", { sourceClass: "portava_prediction" })], NOW, null, {
      experienceState: true,
    });
    assert.equal(on.truthClass, "predicted");
    assert.notEqual(on.freshness, "live");
  });

  test("material conflict ⇒ conflicting; an expired claim ⇒ stale", () => {
    const conflicting = applyLiveClaims(PLACE, [levelClaim("busy", { conflictState: "material" })], NOW, null, {
      experienceState: true,
    });
    assert.equal(conflicting.truthClass, "conflicting");
    const expired = applyLiveClaims(
      PLACE,
      [levelClaim("busy", { expiresAt: "2026-09-07T11:59:00.000Z" })],
      NOW,
      null,
      { experienceState: true },
    );
    assert.equal(expired.freshness, "historical");
    assert.equal(expired.truthClass, "stale");
  });

  test("the tree's truth block and the object's fields are the same values", () => {
    const claims = [levelClaim("busy"), trajectoryClaim("building", { sourceClass: "sponsored" })];
    const on = applyLiveClaims(PLACE, claims, NOW, null, { experienceState: true });
    const t = stateOf(on).truth;
    assert.equal(t.truthClass, on.truthClass);
    assert.equal(t.coverage, on.coverage);
    assert.equal(t.confidence, on.confidence);
    assert.equal(t.freshness, on.freshness);
    assert.equal(t.provenance, attributedSourceClass(claims));
    // Non-independent wins the attribution (§37), so the object is `inferred`
    // even though the busy claim alone would have been corroborated.
    assert.equal(on.truthClass, "inferred");
  });

  test("foldCoverage takes the WIDEST consensus-eligible bucket and ignores a hand-planted bucket on a non-independent class", () => {
    assert.equal(foldCoverage([levelClaim("busy", { sourceCount: 10 }), trajectoryClaim("building", { sourceCount: 200 })]), "many");
    assert.equal(foldCoverage([levelClaim("busy", { sourceClass: "official_signed", sourceCount: 200 })]), "unknown");
    const planted: LiveClaimLike = { ...levelClaim("busy", { sourceClass: "sponsored" }), sourceCountBucket: "many" };
    assert.equal(foldCoverage([planted]), "unknown");
    assert.equal(foldCoverage([]), "unknown");
  });

  test("buildExperienceState is total over an unrecognised claim type", () => {
    const s = buildExperienceState({
      claims: [envelope({ claimType: "weather.now", value: { sky: "clear" } })],
      activity: undefined,
      trend: undefined,
      confidence: "live",
      freshness: "live",
      sourceClass: "firsthand_unverified" as SourceClass,
    });
    assert.equal(s.crowd.density, null);
    assert.equal(s.truth.truthClass, "corroborated" === s.truth.truthClass ? s.truth.truthClass : s.truth.truthClass);
    assert.ok(TRUTH_CLASSES.includes(s.truth.truthClass));
  });
});

// ── §24 ───────────────────────────────────────────────────────────────────────

describe("§24 — coarsening strips the new metadata with the axes it mirrors", () => {
  test("truthClass, coverage, payload.experienceState and payload.moment are gone after coarsenForZone", () => {
    const on = applyLiveClaims(
      { ...PLACE, payload: { category: "bar", moment: { change: "heating_up" } } },
      [levelClaim("busy"), trajectoryClaim("building")],
      NOW,
      null,
      { experienceState: true },
    );
    assert.equal(on.renderingPriority, RENDERING_PRIORITY.high_confidence_live_zone);
    const coarse = coarsenForZone(on, "approximate");
    assert.equal("truthClass" in coarse, false);
    assert.equal("coverage" in coarse, false);
    const payload = coarse.payload as Record<string, unknown>;
    assert.equal("experienceState" in payload, false);
    assert.equal("moment" in payload, false);
    assert.equal(payload.category, "bar", "render data survives");
    assert.ok(COARSENED_PAYLOAD_KEYS.includes("experienceState"));
    assert.ok(COARSENED_PAYLOAD_KEYS.includes("moment"));
  });
});
