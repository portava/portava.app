/**
 * mapLiveAxes — §7's Activity and Trend axes, and §37's "do not let paid
 * businesses buy factual confidence".
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM mapProjection.test.ts
 * =========================================================
 * Three defects shipped together and survived a green suite for the same
 * reason: every fixture was HAND-WRITTEN, so the tests described a world the
 * code agreed with and production did not.
 *
 *   1. `crowdValueToActivity` gated on claim type "crowd" — a LEGACY flat type
 *      (LEGACY_CLAIM_TYPES, migration 2122). Production writes "crowd.level".
 *      It then switched over §7's DISPLAY vocabulary
 *      (very_quiet|…|peak) rather than the claim vocabulary
 *      (intelContracts.CROWD_LEVELS: dead|quiet|moderate|busy|packed|
 *      unsafe_density). Three of six values overlapped by coincidence, which is
 *      precisely why a hand-written fixture looked healthy.
 *   2. There was no Trend producer at all. mapAggregation.aggregateTrend filters
 *      `o.trend` off contributors; nothing wrote it. A closed loop with no seed.
 *   3. `LiveClaimLike.sourceCountBucket` was re-declared non-nullable and the
 *      route's `as unknown as` cast hid the mismatch, so a SPONSORED claim —
 *      whose bucket lib/liveClaimRead deliberately withholds — rendered as
 *      "A few recent traveler reports".
 *
 * So every fixture here is DERIVED FROM THE REAL CONTRACTS:
 *   • the claim shape comes from `mapQuickSignal` — the production mapper;
 *   • the envelope comes from `toLiveClaimEnvelope` — the production read-path
 *     shaper, so the sponsored null bucket is produced by the real
 *     `mayCountAsConsensus` rule rather than typed in by hand;
 *   • the value vocabularies are iterated from CROWD_LEVELS / TRAJECTORIES, so a
 *     new value in intelContracts fails HERE instead of silently returning
 *     undefined in production.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  applyLiveClaims,
  attributedSourceClass,
  crowdValueToActivity,
  crowdValueToTrend,
  type LiveClaimLike,
} from "../lib/mapProjection.js";
import {
  ACTIVITY_LEVELS,
  KIND_DEFAULT_PRIORITY,
  SOURCE_CLASSES as MAP_SOURCE_CLASSES,
  TREND_STATES,
  type MapObject,
} from "../lib/mapObjects.js";
import { applyProtection, type ProtectedZone } from "../lib/protectedLocations.js";
import {
  CLAIM_TYPES,
  CROWD_LEVELS,
  LEGACY_CLAIM_TYPES,
  NON_INDEPENDENT_SOURCE_CLASSES,
  SOURCE_CLASSES,
  SOURCE_CLASS_LABELS,
  SPECIALIST_ONLY_CROWD_LEVELS,
  TRAJECTORIES,
  mayCountAsConsensus,
  type SourceClass,
} from "../lib/intelContracts.js";
import { mapQuickSignal } from "../lib/quickSignal.js";
import { toLiveClaimEnvelope, type LiveClaim } from "../lib/liveClaimRead.js";

// ── fixtures, all derived ─────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const OBSERVED_AT = "2026-08-31T11:58:00.000Z";
const EXPIRES_AT = "2026-08-31T12:40:00.000Z";

const CANONICAL_CLAIM_TYPES: ReadonlySet<string> = new Set(CLAIM_TYPES.map((s) => s.claimType));

/**
 * Build the claim shape production emits by asking the production mapper, then
 * run it through the production envelope shaper. `sourceCount` and `sourceClass`
 * are the only things a test supplies, because those are what the scenario is
 * about; the BUCKET is computed by `toLiveClaimEnvelope`, never asserted into
 * existence here.
 */
function envelope(
  mapped: { claimType: string; value: unknown },
  over: { sourceClass?: SourceClass; sourceCount?: number; id?: string } = {},
): LiveClaimLike {
  const claim: LiveClaim = {
    id: over.id ?? "snap-1",
    claimType: mapped.claimType,
    value: mapped.value,
    confidence: 0.85,
    band: "live",
    sourceClass: over.sourceClass ?? "firsthand_unverified",
    sourceCount: over.sourceCount ?? 30,
    observedAt: OBSERVED_AT,
    expiresAt: EXPIRES_AT,
  };
  return toLiveClaimEnvelope(claim);
}

/** A crowd.level claim for a given level, in the production `{ level }` shape. */
const levelClaim = (level: string, over?: Parameters<typeof envelope>[1]): LiveClaimLike =>
  envelope({ claimType: "crowd.level", value: { level } }, over);

/** A crowd.trajectory claim, in the production `{ trajectory }` shape. */
const trajectoryClaim = (trajectory: string, over?: Parameters<typeof envelope>[1]): LiveClaimLike =>
  envelope({ claimType: "crowd.trajectory", value: { trajectory } }, { id: "snap-2", ...over });

const PLACE: MapObject = {
  id: "place:p1",
  kind: "place",
  geometry: { type: "Point", coordinates: [108.21, 16.06] },
  title: "Somewhere",
  privacyClass: "place_level",
  renderingPriority: KIND_DEFAULT_PRIORITY.place,
};

// ── the fixtures are the real shapes ──────────────────────────────────────────

describe("fixtures come from the real contracts (the defect class this repo keeps hitting)", () => {
  test("the capture path emits crowd.level and crowd.trajectory, both canonical", () => {
    const level = mapQuickSignal("arrival", "busy");
    const trajectory = mapQuickSignal("inside", "building");
    assert.ok(level && trajectory, "the production mapper must still emit these");

    for (const m of [level!, trajectory!]) {
      assert.ok(
        CANONICAL_CLAIM_TYPES.has(m.claimType),
        `${m.claimType} is not in the canonical CLAIM_TYPES registry`,
      );
      assert.ok(
        !(LEGACY_CLAIM_TYPES as readonly string[]).includes(m.claimType),
        `${m.claimType} is a LEGACY flat type — production stopped writing those`,
      );
    }
    assert.equal(level!.claimType, "crowd.level");
    assert.equal(trajectory!.claimType, "crowd.trajectory");
  });

  test("the value is an object, not a bare string — the old fixture's shape was wrong twice", () => {
    const level = mapQuickSignal("arrival", "busy")!;
    assert.deepEqual(level.value, { level: "busy" });
  });
});

// ── §7 Activity ───────────────────────────────────────────────────────────────

describe("Activity axis (spec §7)", () => {
  test("a REAL crowd.level claim produces an activity", () => {
    assert.equal(crowdValueToActivity(levelClaim("busy")), "busy");
    // ...and it reaches the object, which is the part that had never worked.
    const merged = applyLiveClaims(PLACE, [levelClaim("busy")], NOW);
    assert.equal(merged.activity, "busy");
  });

  test("the LEGACY flat 'crowd' type is still honoured — deliberately", () => {
    // RULING: accept it. Migration 2122's flat rows still exist, intelContracts
    // says the legacy list is "kept for readers that still use them", and BOTH
    // sibling readers (MediaProjectionService, inputAssistance/liveSuggestions)
    // already accept the pair. A real observation must not become invisible only
    // because it predates the dotted rename. It buys no laxity: the VALUE must
    // still be a CROWD_LEVELS member.
    assert.ok((LEGACY_CLAIM_TYPES as readonly string[]).includes("crowd"));
    const legacy = envelope({ claimType: "crowd", value: "busy" });
    assert.equal(crowdValueToActivity(legacy), "busy");
    const legacyBadValue = envelope({ claimType: "crowd", value: "rammed" });
    assert.equal(crowdValueToActivity(legacyBadValue), undefined);
  });

  test("EVERY CROWD_LEVELS value is decided — none silently falls through", () => {
    // The exhaustive sweep the old switch could never pass: it recognised only
    // quiet/moderate/busy, so dead and packed produced no activity at all.
    const decided = new Map<string, string | undefined>();
    for (const level of CROWD_LEVELS) {
      decided.set(level, crowdValueToActivity(levelClaim(level)));
    }

    for (const level of CROWD_LEVELS) {
      const got = decided.get(level);
      if ((SPECIALIST_ONLY_CROWD_LEVELS as readonly string[]).includes(level)) continue;
      assert.ok(
        got !== undefined,
        `CROWD_LEVELS value "${level}" produced no activity — an unmapped level is a dead axis`,
      );
      assert.ok(
        (ACTIVITY_LEVELS as readonly string[]).includes(got!),
        `"${level}" mapped to "${got}", which is not a §7 activity level`,
      );
    }

    assert.deepEqual(
      Object.fromEntries(decided),
      {
        dead: "very_quiet",
        quiet: "quiet",
        moderate: "moderate",
        busy: "busy",
        packed: "very_busy",
        unsafe_density: undefined,
      },
      "the CROWD_LEVELS → §7 Activity mapping changed; that is a product decision, not a refactor",
    );
  });

  test("'packed' is NOT 'peak' — a level claim may not assert an apex", () => {
    // "Peak" says the place has topped out. That is a TRAJECTORY statement (there
    // is a literal `peaking` value, and §7 gives Trend its own column). Publishing
    // it from a level claim would publish an inference the contributor never made.
    assert.equal(crowdValueToActivity(levelClaim("packed")), "very_busy");
    for (const level of CROWD_LEVELS) {
      assert.notEqual(
        crowdValueToActivity(levelClaim(level)),
        "peak",
        `no single crowd.level claim may produce "peak" (offender: ${level})`,
      );
    }
  });

  test("'unsafe_density' is withheld from the Activity axis, and says so", () => {
    // A SAFETY claim, not a vibe (SPECIALIST_ONLY_CROWD_LEVELS). §7's Activity
    // scale tops out at "Peak", which on this map is an ATTRACTOR (§38 routes the
    // traveler toward the stronger area), so rendering a dangerous crush there
    // would advertise it. Same ruling inputAssistance/liveSuggestions already
    // makes for this value — one claim, one rendering, on both surfaces.
    assert.deepEqual(SPECIALIST_ONLY_CROWD_LEVELS, ["unsafe_density"]);
    assert.equal(crowdValueToActivity(levelClaim("unsafe_density")), undefined);

    // Withheld from the AXIS is not silenced: the claim still carries a §9
    // provenance line, so the Why? panel can still show it.
    const merged = applyLiveClaims(PLACE, [levelClaim("unsafe_density")], NOW);
    assert.equal(merged.activity, undefined);
    assert.equal(merged.provenance!.lines.length, 1);
    assert.match(merged.provenance!.lines[0].text, /crowd\.level/);
  });

  test("an unrecognised value or an inherited key never becomes an activity", () => {
    assert.equal(crowdValueToActivity(levelClaim("rammed")), undefined);
    assert.equal(crowdValueToActivity(levelClaim("toString")), undefined);
    assert.equal(crowdValueToActivity(levelClaim("constructor")), undefined);
    assert.equal(
      crowdValueToActivity(envelope({ claimType: "vibe.state", value: { state: "social" } })),
      undefined,
    );
    // A trajectory claim is not a level claim.
    assert.equal(crowdValueToActivity(trajectoryClaim("building")), undefined);
  });
});

// ── §7 Trend ──────────────────────────────────────────────────────────────────

describe("Trend axis (spec §7) — the producer that did not exist", () => {
  test("a REAL crowd.trajectory claim produces a trend, and it reaches the object", () => {
    assert.equal(crowdValueToTrend(trajectoryClaim("building")), "getting_busier");
    const merged = applyLiveClaims(PLACE, [trajectoryClaim("building")], NOW);
    assert.equal(
      merged.trend,
      "getting_busier",
      "aggregateTrend filters o.trend; if nothing sets it the whole §6/§8/§38 trend chain is dead",
    );
  });

  test("EVERY TRAJECTORIES value maps to a §7 trend state", () => {
    const decided = new Map<string, string | undefined>();
    for (const t of TRAJECTORIES) decided.set(t, crowdValueToTrend(trajectoryClaim(t)));

    for (const [t, got] of decided) {
      assert.ok(got !== undefined, `TRAJECTORIES value "${t}" produced no trend`);
      assert.ok(
        (TREND_STATES as readonly string[]).includes(got!),
        `"${t}" mapped to "${got}", which is not a §7 trend state`,
      );
    }

    assert.deepEqual(
      Object.fromEntries(decided),
      {
        emerging: "getting_busier",
        building: "getting_busier",
        peaking: "stable",
        stable: "stable",
        fragmenting: "getting_quieter",
        relocating: "rapidly_dispersing",
        declining: "cooling",
        ending: "getting_quieter",
      },
      "the TRAJECTORIES → §7 Trend mapping changed; that is a product decision, not a refactor",
    );
  });

  test("no single trajectory claims a RATE — 'increasing_quickly' has no single-claim producer", () => {
    // A rate needs a delta between two observations. That is aggregation's job
    // (mapAggregation.aggregateTrend), not this projection's. `emerging` says a
    // thing is starting, not that it is starting fast.
    for (const t of TRAJECTORIES) {
      assert.notEqual(
        crowdValueToTrend(trajectoryClaim(t)),
        "increasing_quickly",
        `trajectory "${t}" must not assert a rate from a single categorical claim`,
      );
    }
  });

  test("an unrecognised trajectory does not default to 'stable'", () => {
    assert.equal(crowdValueToTrend(trajectoryClaim("vibing")), undefined);
    assert.equal(crowdValueToTrend(trajectoryClaim("hasOwnProperty")), undefined);
    // A level claim is not a trajectory claim, and the legacy flat type never
    // carried a trajectory.
    assert.equal(crowdValueToTrend(levelClaim("busy")), undefined);
    assert.equal(crowdValueToTrend(envelope({ claimType: "crowd", value: "building" })), undefined);
  });

  test("§8's sheet needs BOTH axes at once, so both are read from the whole list", () => {
    // Reading only claims[0] could never populate both: whichever claim sorted
    // first would suppress the other axis.
    const merged = applyLiveClaims(
      PLACE,
      [trajectoryClaim("declining"), levelClaim("packed")],
      NOW,
    );
    assert.equal(merged.activity, "very_busy");
    assert.equal(merged.trend, "cooling");

    const reversed = applyLiveClaims(
      PLACE,
      [levelClaim("packed"), trajectoryClaim("declining")],
      NOW,
    );
    assert.equal(reversed.activity, "very_busy");
    assert.equal(reversed.trend, "cooling");
  });

  test("no trajectory claim ⇒ no trend; the axis is never invented", () => {
    const merged = applyLiveClaims(PLACE, [levelClaim("busy")], NOW);
    assert.equal(merged.trend, undefined);
  });
});

// ── §37: paid confidence is not for sale ──────────────────────────────────────

describe("§37 'Do not let paid businesses buy factual confidence'", () => {
  test("a sponsored claim's cohort bucket is NULL — from the real rule, not by hand", () => {
    const sponsored = levelClaim("busy", { sourceClass: "sponsored", sourceCount: 400 });
    assert.equal(mayCountAsConsensus("sponsored"), false);
    assert.equal(
      sponsored.sourceCountBucket,
      null,
      "liveClaimRead withholds the bucket for a class that is one party talking about itself",
    );
    // A big sourceCount would have produced "many" for an eligible class — proof
    // the null is the RULE biting, not an absent count.
    assert.equal(levelClaim("busy", { sourceCount: 400 }).sourceCountBucket, "many");
  });

  test("every non-independent class gets a null bucket and a NON-traveler description", () => {
    for (const cls of NON_INDEPENDENT_SOURCE_CLASSES) {
      const c = levelClaim("busy", { sourceClass: cls, sourceCount: 400 });
      assert.equal(c.sourceCountBucket, null, `${cls} must not carry a cohort bucket`);

      const merged = applyLiveClaims(PLACE, [c], NOW);
      const text = merged.provenance!.lines[0].text;
      assert.ok(
        !/traveler reports/i.test(text),
        `${cls} rendered as a traveler report: "${text}"`,
      );
      assert.ok(
        !/\brecent\b/i.test(text) && !/\b(a few|several|many)\b/i.test(text),
        `${cls} must not imply a cohort of independent reporters: "${text}"`,
      );
      assert.ok(
        text.startsWith(SOURCE_CLASS_LABELS[cls]),
        `${cls} must be attributed with its canonical label: "${text}"`,
      );
    }
  });

  test("the sponsored line names the source rather than saying nothing", () => {
    // Saying nothing would leave an unattributed assertion, which reads as the
    // map's own finding — the same borrowed credibility by a quieter route.
    const merged = applyLiveClaims(
      PLACE,
      [levelClaim("busy", { sourceClass: "sponsored", sourceCount: 400 })],
      NOW,
    );
    assert.equal(merged.provenance!.lines[0].text, "Sponsored · crowd.level");
  });

  test("sourceClass reaches the object for EVERY class, and the copy is the canonical label", () => {
    for (const cls of SOURCE_CLASSES) {
      const merged = applyLiveClaims(
        PLACE,
        [levelClaim("busy", { sourceClass: cls, sourceCount: 30 })],
        NOW,
      );
      const text = merged.provenance!.lines[0].text;
      if (mayCountAsConsensus(cls)) {
        // Consensus-eligible: the cohort bucket is the honest headline and the
        // class is not withheld information.
        assert.match(text, /recent traveler reports/);
      } else {
        assert.ok(
          text.startsWith(SOURCE_CLASS_LABELS[cls]),
          `${cls} must be distinguishable on the object: "${text}"`,
        );
      }
    }
  });

  test("a consensus-eligible class still gets its cohort bucket", () => {
    for (const cls of SOURCE_CLASSES.filter(mayCountAsConsensus)) {
      const c = levelClaim("busy", { sourceClass: cls, sourceCount: 30 });
      assert.equal(c.sourceCountBucket, "several", `${cls} should still bucket normally`);
    }
  });

  test("the provenance line still never carries a raw contributor count", () => {
    for (const cls of SOURCE_CLASSES) {
      const merged = applyLiveClaims(
        PLACE,
        [levelClaim("busy", { sourceClass: cls, sourceCount: 137 })],
        NOW,
      );
      const text = merged.provenance!.lines[0].text;
      assert.ok(!/\d/.test(text), `provenance line must not contain a count: ${text}`);
    }
  });

  test("an unrecognised source class is not treated as a traveler", () => {
    // LiveClaimLike is structural, so a future/foreign class can arrive. It must
    // fail toward "unattributed", never toward community consensus.
    const rogue: LiveClaimLike = {
      ...levelClaim("busy"),
      sourceClass: "brand_new_class" as SourceClass,
      sourceCountBucket: null,
    };
    const merged = applyLiveClaims(PLACE, [rogue], NOW);
    assert.equal(merged.provenance!.lines[0].text, "Source not attributed · crowd.level");
  });
});

// ── §8 badge: the attribution is a VALUE, not a sentence ──────────────────────

/**
 * `describeClaim` closed the misattribution — a sponsored claim renders as
 * "Sponsored · crowd.level" instead of "A few recent traveler reports". But it
 * closed it in PROSE, and a §8 badge cannot switch on a sentence. These tests
 * pin the machine-readable half: `MapObject.sourceClass`.
 *
 * The interesting case is not the single sponsored claim — it is the MIXED one.
 * §7 keeps Activity and Trend as separate axes fed by two different claim types,
 * so one object routinely carries two speakers, and a naive `claims[0]` would
 * re-open §37 by a new route the moment a traveler claim sorted first.
 */
describe("§8/§37 sourceClass — a paid claim is distinguishable without parsing English", () => {
  test("the map's wire vocabulary IS the intel vocabulary, not a retyped copy", () => {
    assert.deepEqual([...MAP_SOURCE_CLASSES], [...SOURCE_CLASSES]);
  });

  test("every class reaches the object as a value", () => {
    for (const cls of SOURCE_CLASSES) {
      const merged = applyLiveClaims(PLACE, [levelClaim("busy", { sourceClass: cls })], NOW);
      assert.equal(merged.sourceClass, cls, `${cls} did not reach the object`);
    }
  });

  test("a sponsored claim's object carries the sponsored class", () => {
    const merged = applyLiveClaims(
      PLACE,
      [levelClaim("busy", { sourceClass: "sponsored", sourceCount: 400 })],
      NOW,
    );
    assert.equal(merged.sourceClass, "sponsored");
    // The badge and the §9 line must name the same speaker.
    assert.equal(merged.provenance!.lines[0].text, "Sponsored · crowd.level");
    assert.equal(SOURCE_CLASS_LABELS[merged.sourceClass!], "Sponsored");
  });

  test("a traveler claim carries its own class and never a non-independent one", () => {
    const merged = applyLiveClaims(
      PLACE,
      [levelClaim("busy", { sourceClass: "firsthand_unverified" })],
      NOW,
    );
    assert.equal(merged.sourceClass, "firsthand_unverified");
    assert.ok(mayCountAsConsensus(merged.sourceClass!));
    assert.ok(
      !NON_INDEPENDENT_SOURCE_CLASSES.includes(merged.sourceClass!),
      "a traveler report must not be labelled as one party talking about itself",
    );
  });

  test("a forecast class reaches the object, so §37 can keep it from looking observed", () => {
    // "Do not make predictions look like observations." The client cannot make
    // that distinction from freshness alone — a prediction stamped 2 minutes ago
    // is 'live' by age. The class is the only thing that says it is a forecast.
    for (const cls of ["portava_prediction", "historical_pattern"] as const) {
      const merged = applyLiveClaims(PLACE, [levelClaim("busy", { sourceClass: cls })], NOW);
      assert.equal(merged.sourceClass, cls);
    }
  });

  test("no live claim ⇒ no sourceClass key at all, not a default", () => {
    const merged = applyLiveClaims(PLACE, [], NOW);
    assert.equal(merged, PLACE, "an empty claim list must return the object untouched");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(merged, "sourceClass"),
      "an object with no claim must carry no attribution key",
    );
    assert.ok(!JSON.stringify(merged).includes("sourceClass"));
  });

  test("MIXED: a paid claim cannot hide behind a traveler primary", () => {
    // The realistic shape: a traveler reports the level, the business publishes
    // the trajectory. Both axes populate, so the object really is fed by both.
    const claims = [
      levelClaim("busy", { sourceClass: "firsthand_unverified", id: "snap-t" }),
      trajectoryClaim("building", { sourceClass: "sponsored", sourceCount: 400 }),
    ];
    const merged = applyLiveClaims(PLACE, claims, NOW);
    assert.equal(merged.activity, "busy", "fixture is wrong: the level axis must be populated");
    assert.equal(merged.trend, "getting_busier", "fixture is wrong: the trend axis must be populated");
    assert.equal(
      merged.sourceClass,
      "sponsored",
      "a non-independent contributor must win the fold — understating attribution is the §37 failure",
    );
    // §9 stays lossless: every claim keeps its OWN line.
    assert.equal(merged.provenance!.lines.length, 2);
    assert.match(merged.provenance!.lines[0].text, /traveler reports/);
    assert.equal(merged.provenance!.lines[1].text, "Sponsored · crowd.trajectory");
  });

  test("MIXED: the same answer whichever claim sorts first", () => {
    const sponsoredFirst = applyLiveClaims(
      PLACE,
      [
        levelClaim("busy", { sourceClass: "sponsored", sourceCount: 400 }),
        trajectoryClaim("building", { sourceClass: "firsthand_unverified" }),
      ],
      NOW,
    );
    assert.equal(sponsoredFirst.sourceClass, "sponsored");
  });

  test("every non-independent class wins the fold, from either position", () => {
    for (const cls of NON_INDEPENDENT_SOURCE_CLASSES) {
      const traveler = levelClaim("busy", { sourceClass: "firsthand_unverified", id: "snap-t" });
      const paid = trajectoryClaim("building", { sourceClass: cls, sourceCount: 400 });
      assert.equal(attributedSourceClass([traveler, paid]), cls, `${cls} lost from second place`);
      assert.equal(attributedSourceClass([paid, traveler]), cls, `${cls} lost from first place`);
    }
  });

  test("with no non-independent claim, the badge describes the SAME claim as the headline state", () => {
    // observedAt / expiresAt / freshness / confidence all come from claims[0];
    // so must the attribution, or the badge describes a different claim than the
    // state next to it.
    const primary = levelClaim("busy", { sourceClass: "verified_firsthand", id: "snap-a" });
    const merged = applyLiveClaims(
      PLACE,
      [primary, trajectoryClaim("building", { sourceClass: "hearsay" })],
      NOW,
    );
    assert.equal(merged.sourceClass, "verified_firsthand");
    assert.equal(merged.observedAt, primary.observedAt);
    assert.equal(merged.confidence, primary.band);
  });

  test("an unrecognised class is never published as a class", () => {
    // LiveClaimLike is structural, so a foreign value can arrive. Emitting it
    // would put a string on the wire that neither mirror declares, and a client
    // doing `LABELS[cls] ?? friendlyDefault` would fail OPEN.
    const rogue: LiveClaimLike = {
      ...levelClaim("busy"),
      sourceClass: "brand_new_class" as SourceClass,
      sourceCountBucket: null,
    };
    const merged = applyLiveClaims(PLACE, [rogue], NOW);
    assert.equal(merged.sourceClass, undefined);
    assert.ok(!JSON.stringify(merged).includes("brand_new_class"));
    // Same ruling the prose already makes: never toward traveler.
    assert.equal(merged.provenance!.lines[0].text, "Source not attributed · crowd.level");
  });

  test("an unrecognised PRIMARY is not papered over by a recognised secondary", () => {
    const rogue: LiveClaimLike = {
      ...levelClaim("busy"),
      sourceClass: "brand_new_class" as SourceClass,
      sourceCountBucket: null,
    };
    const merged = applyLiveClaims(
      PLACE,
      [rogue, trajectoryClaim("building", { sourceClass: "firsthand_unverified" })],
      NOW,
    );
    assert.equal(
      merged.sourceClass,
      undefined,
      "borrowing the second claim's class would attribute the headline state to a claim that did not make it",
    );
  });

  test("a rogue class alongside a paid one still reports the paid one", () => {
    const rogue: LiveClaimLike = {
      ...levelClaim("busy"),
      sourceClass: "brand_new_class" as SourceClass,
      sourceCountBucket: null,
    };
    const paid = trajectoryClaim("building", { sourceClass: "sponsored", sourceCount: 400 });
    assert.equal(attributedSourceClass([rogue, paid]), "sponsored");
  });

  test("the fold is empty-safe", () => {
    assert.equal(attributedSourceClass([]), undefined);
  });

  test("every published class has a canonical label — no badge can be unlabelable", () => {
    for (const cls of SOURCE_CLASSES) {
      const merged = applyLiveClaims(PLACE, [levelClaim("busy", { sourceClass: cls })], NOW);
      assert.equal(typeof SOURCE_CLASS_LABELS[merged.sourceClass!], "string");
      assert.notEqual(SOURCE_CLASS_LABELS[merged.sourceClass!], "");
    }
  });
});

// ── §24: the attribution must not survive coarsening ──────────────────────────

/**
 * The composition test. `applyLiveClaims` stamps `sourceClass` and
 * `applyProtection` runs AFTER it in the route (see routes/mapProjection: "It
 * runs AFTER enrichment … and BEFORE aggregation"), so an enriched object that
 * happens to stand inside a protected zone reaches the gate WITH an attribution
 * already attached. If coarsening does not remove it, a coarse pin on a medical
 * facility still publishes "a presence-verified person observed this place" —
 * the §24 disclosure, with the coordinate removed and the fact intact.
 */
describe("§24 — an enriched object inside a protected zone publishes no attribution", () => {
  const ZONE: ProtectedZone = {
    id: "zone-med-1",
    category: "medical_facility",
    shape: "circle",
    center: { lat: 16.06, lng: 108.21 },
    radiusMeters: 500,
    policyRef: "policy-test",
  } as ProtectedZone;

  test("the attribution a live claim attached is gone after protection", () => {
    const enriched = applyLiveClaims(
      PLACE,
      [levelClaim("busy", { sourceClass: "verified_firsthand" })],
      NOW,
    );
    assert.equal(enriched.sourceClass, "verified_firsthand", "precondition: it was attached");

    const { objects, report } = applyProtection([enriched], [ZONE]);
    assert.equal(report.coarsened, 1, "precondition: the object took the coarsen path");
    assert.equal(objects[0].sourceClass, undefined);
    assert.ok(
      !JSON.stringify(objects[0]).includes("verified_firsthand"),
      "the class must not survive anywhere in the serialized object",
    );
    assert.ok(!JSON.stringify(objects[0]).includes("sourceClass"));
  });

  test("a sponsored attribution is stripped too — §24 does not care who spoke", () => {
    const enriched = applyLiveClaims(
      PLACE,
      [levelClaim("busy", { sourceClass: "sponsored", sourceCount: 400 })],
      NOW,
    );
    const { objects } = applyProtection([enriched], [ZONE]);
    assert.equal(objects[0].sourceClass, undefined);
  });

  test("outside the zone the same object keeps its attribution", () => {
    // Proof the strip above is the ZONE biting, not the field failing to attach.
    const enriched = applyLiveClaims(
      PLACE,
      [levelClaim("busy", { sourceClass: "verified_firsthand" })],
      NOW,
    );
    const far = { ...ZONE, center: { lat: -40, lng: -80 } } as ProtectedZone;
    const { objects, report } = applyProtection([enriched], [far]);
    assert.equal(report.allowed, 1);
    assert.equal(objects[0].sourceClass, "verified_firsthand");
  });
});
