/**
 * WHICH OF THE FOUR PRESENCE MODELS ACTUALLY READ THROUGH THE FUSION LAYER.
 *
 * census-sensing S3 names four: `circle_presence`,
 * `trip_crew_location_sessions`, `locateFriendsSession`, and the map's
 * `social_zone`/`buddy_zone`/`crew_member` kinds. `presence/fusion/sources.ts`
 * registers all four and states, per source, the module that reads through the
 * store — or `null` plus a NON-EMPTY `blockedBy`.
 *
 * This file is what stops that register being prose. It reads the named file
 * off disk and asserts it really imports the store, and it asserts the CONVERSE
 * for every `null`: a source recorded as not-yet-wired must not in fact be
 * wired, so nobody can wire one and leave a stale excuse behind, and nobody can
 * mark one wired without the import existing.
 *
 * It therefore passes in a PARTIAL state and says exactly how partial — which
 * is the point. A test that could only pass at 4/4 would be deleted the first
 * time it was inconvenient; this one has to be UPDATED, and updating it means
 * writing down what is true.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAP_PRESENCE_KINDS,
  MAP_PRESENCE_KIND_CEILING,
  MAP_PRESENCE_KIND_CLASS_CEILING,
  PRESENCE_SOURCES,
  PRESENCE_SOURCE_CONTRACTS,
  type PresenceSourceId,
} from "../presence/fusion/sources.js";
import {
  PRESENCE_ESTIMATE_TTL_MS,
  PRESENCE_LIVE_WINDOW_MS,
} from "../presence/fusion/store.js";
import { PRECISION_LADDER, FEATURE_PRECISION_CEILING } from "../presence/domain/types.js";
import { MAP_OBJECT_KINDS, PRIVACY_CLASSES, point, type MapObject } from "../lib/mapObjects.js";
import {
  PRIVACY_CLASS_AS_PRESENCE_PRECISION,
  aggregateForViewport,
  gatePresenceObject,
  presenceClassUnder,
} from "../lib/mapAggregation.js";
import {
  DECAY_BOUNDARIES_MS,
  LOCATE_FRIENDS_FEATURE_CEILING,
  POSITION_TTL_MS,
  PRIVACY_CLASS_AS_PRECISION_CEILING,
} from "../lib/locateFriendsSession.js";
import { UNFED_FAMILY_BLOCKERS } from "../lib/crowdFlowProducer.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** True when `file` imports the presence fusion store at all. */
function importsFusionStore(relativePath: string): boolean {
  const body = readFileSync(path.join(PKG, relativePath), "utf8");
  return /from\s+"[^"]*presence\/fusion\/store\.js"/.test(body);
}

describe("presence fusion — the register is honest about all four models", () => {
  test("every source names either a reader or a reason, never both and never neither", () => {
    for (const id of PRESENCE_SOURCES) {
      const c = PRESENCE_SOURCE_CONTRACTS[id];
      assert.equal(c.id, id, `${id}: contract keyed under the wrong id`);
      const wired = c.readsThrough !== null;
      assert.equal(
        wired,
        c.blockedBy === null,
        `${id}: readsThrough and blockedBy must be exactly one of the two — ` +
          `got readsThrough=${JSON.stringify(c.readsThrough)} blockedBy=${JSON.stringify(c.blockedBy)}`,
      );
      if (!wired) {
        assert.ok(
          (c.blockedBy ?? "").trim().length > 40,
          `${id}: "not wired" with a one-line excuse is an assertion, not a reason`,
        );
      }
      assert.ok(c.backing.length > 0, `${id}: a presence model with no named backing`);
      assert.ok(
        (PRECISION_LADDER as readonly string[]).includes(c.ceiling),
        `${id}: ceiling ${c.ceiling} is not a rung of PRECISION_LADDER`,
      );
    }
  });

  test("a source marked WIRED really does import the store", () => {
    const wired: PresenceSourceId[] = [];
    for (const id of PRESENCE_SOURCES) {
      const c = PRESENCE_SOURCE_CONTRACTS[id];
      if (c.readsThrough === null) continue;
      wired.push(id);
      assert.ok(
        importsFusionStore(c.readsThrough),
        `${id} claims ${c.readsThrough} reads through the fusion store, but that file does not import it`,
      );
    }
    assert.ok(wired.length > 0, "a fusion layer with no readers is not a fusion layer");
  });

  test("a source marked NOT WIRED really is not — no stale excuses", () => {
    // The named owning module for each unwired source, so "not wired" is checked
    // against the file it would have to be wired in rather than left unchecked.
    const OWNERS: Partial<Record<PresenceSourceId, readonly string[]>> = {
      circle_presence: ["src/routes/circle.ts", "src/lib/circleResponseShaper.ts"],
      trip_crew_location_sessions: ["src/domain/trips/services/TripCrewLocationService.ts"],
    };
    for (const id of PRESENCE_SOURCES) {
      const c = PRESENCE_SOURCE_CONTRACTS[id];
      if (c.readsThrough !== null) continue;
      const owners = OWNERS[id];
      assert.ok(owners, `${id} is marked unwired but this test names no owning module for it`);
      for (const owner of owners) {
        assert.equal(
          importsFusionStore(owner),
          false,
          `${id} is recorded as blocked, but ${owner} now imports the fusion store — ` +
            `update PRESENCE_SOURCE_CONTRACTS.${id} instead of leaving a stale excuse`,
        );
      }
    }
  });

  test("THE TALLY — how many of the four read through the fusion layer, stated out loud", () => {
    const wired = PRESENCE_SOURCES.filter((s) => PRESENCE_SOURCE_CONTRACTS[s].readsThrough !== null);
    const blocked = PRESENCE_SOURCES.filter((s) => PRESENCE_SOURCE_CONTRACTS[s].readsThrough === null);
    assert.equal(
      wired.length + blocked.length,
      4,
      "the register must hold exactly the four presence models census-sensing S3 names",
    );
    // This assertion is the honest state of the migration and is EXPECTED to be
    // edited upward. If it fails because `wired` grew, the fix is to raise the
    // number here and clear that source's `blockedBy` — not to relax the test.
    assert.deepEqual(
      [...wired].sort(),
      ["locate_friends_session", "map_social_presence"],
      `presence models reading through the fusion layer: ${wired.join(", ") || "none"}; ` +
        `still on their own: ${blocked.join(", ") || "none"}`,
    );
  });
});

describe("presence fusion — the two ladders agree with their existing owners", () => {
  test("the store's TTL and live window are the locate-friends decay numbers, not new ones", () => {
    assert.equal(PRESENCE_ESTIMATE_TTL_MS, POSITION_TTL_MS);
    assert.equal(PRESENCE_LIVE_WINDOW_MS, DECAY_BOUNDARIES_MS.precise);
  });

  test("locate_friends' contract ceiling is the same row of FEATURE_PRECISION_CEILING it always was", () => {
    assert.equal(PRESENCE_SOURCE_CONTRACTS.locate_friends_session.ceiling, LOCATE_FRIENDS_FEATURE_CEILING);
    assert.equal(LOCATE_FRIENDS_FEATURE_CEILING, FEATURE_PRECISION_CEILING.crew);
  });

  test("the map's class→rung table is the SAME table locateFriendsSession uses", () => {
    assert.deepEqual(
      { ...PRIVACY_CLASS_AS_PRESENCE_PRECISION },
      { ...PRIVACY_CLASS_AS_PRECISION_CEILING },
      "two copies of the §23↔§52 translation would drift; they must be equal",
    );
  });

  test("the map presence kinds are real map kinds and their class ceilings are real classes", () => {
    for (const k of MAP_PRESENCE_KINDS) {
      assert.ok((MAP_OBJECT_KINDS as readonly string[]).includes(k), `${k} is not a MapObjectKind`);
      assert.ok(
        (PRECISION_LADDER as readonly string[]).includes(MAP_PRESENCE_KIND_CEILING[k]),
        `${k}: rung ceiling is not on the ladder`,
      );
      assert.ok(
        (PRIVACY_CLASSES as readonly string[]).includes(MAP_PRESENCE_KIND_CLASS_CEILING[k]),
        `${k}: class ceiling is not a PrivacyClass`,
      );
    }
    assert.deepEqual([...MAP_PRESENCE_KINDS].sort(), ["buddy_zone", "crew_member", "social_zone"]);
  });

  test("presenceClassUnder can only tighten, for every class × rung", () => {
    for (const cls of PRIVACY_CLASSES) {
      for (const rung of PRECISION_LADDER) {
        const got = presenceClassUnder(cls, rung);
        assert.ok(
          PRIVACY_CLASSES.indexOf(got) <= PRIVACY_CLASSES.indexOf(cls),
          `presenceClassUnder(${cls}, ${rung}) = ${got} is MORE revealing than ${cls}`,
        );
      }
    }
  });
});

// ── The map half, end to end ─────────────────────────────────────────────────

function presenceObject(over: Partial<MapObject> = {}): MapObject {
  return {
    id: "traveler:1",
    kind: "social_zone",
    geometry: point(51.5, -0.12),
    title: "Traveler nearby",
    privacyClass: "approximate",
    renderingPriority: 10,
    ...over,
  };
}

describe("presence fusion — the map's three kinds read through the store", () => {
  test("each of the three kinds is gated and comes back carrying a sealed estimate", () => {
    for (const kind of MAP_PRESENCE_KINDS) {
      const r = gatePresenceObject(presenceObject({ kind, id: `${kind}:1` }), null);
      assert.ok(r.object, `${kind} was refused: ${r.refusal}`);
      assert.ok(r.estimate, `${kind} passed the gate with NO estimate — it did not read through`);
      assert.equal(r.estimate.source, "map_social_presence");
    }
  });

  test("a non-presence kind is passed through untouched and mints nothing", () => {
    const place = presenceObject({ kind: "place", id: "place:1", privacyClass: "place_level" });
    const r = gatePresenceObject(place, null);
    assert.equal(r.object, place);
    assert.equal(r.estimate, null);
  });

  test("a producer that over-claims is NARROWED by the gate", () => {
    // `lib/mapProjection.projectBuddy` hardcodes `approximate` and says
    // precise_temporary "is not reachable here and must never be claimed".
    // This is that sentence with a gate behind it.
    const overclaimed = presenceObject({
      kind: "buddy_zone",
      id: "buddy:1",
      privacyClass: "precise_temporary",
    });
    const r = gatePresenceObject(overclaimed, null);
    assert.ok(r.object);
    assert.equal(r.narrowed, true);
    assert.equal(r.object.privacyClass, "approximate");
    assert.notEqual(r.object, overclaimed, "the input object must not be mutated");
    assert.equal(overclaimed.privacyClass, "precise_temporary");
  });

  test("a crew pin MAY still be a permitted temporary precise share", () => {
    const crew = presenceObject({
      kind: "crew_member",
      id: "friend:u1",
      privacyClass: "precise_temporary",
    });
    const r = gatePresenceObject(crew, null);
    assert.ok(r.object);
    assert.equal(r.object.privacyClass, "precise_temporary", "§23 permits this rung for crew");
    assert.equal(r.narrowed, false);
  });

  test("aggregateForViewport runs the gate on every presence object it serves", () => {
    const objects: MapObject[] = [
      presenceObject({ id: "traveler:1", kind: "social_zone" }),
      presenceObject({ id: "buddy:1", kind: "buddy_zone" }),
      presenceObject({ id: "friend:u1", kind: "crew_member" }),
      presenceObject({ id: "place:1", kind: "place", privacyClass: "place_level" }),
    ];
    const agg = aggregateForViewport(objects, {
      bbox: { north: 52, south: 51, east: 0, west: -1 },
      zoom: 15,
    });
    assert.equal(agg.presenceGated, 3, "all three presence kinds must have gone through the gate");
    assert.deepEqual(agg.presenceRefused, []);
    assert.equal(agg.objects.length, 4);
  });

  test("a presence object the fusion layer refuses is DROPPED and named, never silently served", () => {
    const objects: MapObject[] = [presenceObject({ id: "   ", kind: "social_zone" })];
    const agg = aggregateForViewport(objects, {
      bbox: { north: 52, south: 51, east: 0, west: -1 },
      zoom: 15,
    });
    assert.equal(agg.objects.length, 0);
    assert.equal(agg.dropped, 1);
    assert.deepEqual(agg.presenceRefused, [
      { id: "   ", kind: "social_zone", reason: "no_subject" },
    ]);
  });

  test("with an injected clock, a presence pin older than the TTL is refused", () => {
    const t = 1_700_000_000_000;
    const objects: MapObject[] = [
      presenceObject({
        id: "traveler:1",
        kind: "social_zone",
        observedAt: new Date(t - PRESENCE_ESTIMATE_TTL_MS).toISOString(),
      }),
    ];
    const agg = aggregateForViewport(objects, {
      bbox: { north: 52, south: 51, east: 0, west: -1 },
      zoom: 15,
      nowMs: t,
    });
    assert.equal(agg.objects.length, 0);
    assert.equal(agg.presenceRefused[0]?.reason, "expired");
  });
});

describe("presence fusion — the evidence the census cites is no longer false", () => {
  test("crowdFlowProducer no longer registers 'no store, no fusion layer'", () => {
    const evidence = UNFED_FAMILY_BLOCKERS.aggregate_presence?.evidence ?? [];
    assert.ok(evidence.length > 0);
    for (const line of evidence) {
      assert.ok(
        !/no store,\s*no fusion layer/i.test(line),
        `the register still claims "no store, no fusion layer" while src/presence/fusion exists: ${line}`,
      );
    }
    assert.ok(
      evidence.some((e) => e.includes("src/presence/fusion")),
      "the entry must NAME what replaced the old claim, not just drop it",
    );
    // And the finding itself must SURVIVE: a fusion layer does not supply an
    // origin, so the family is still blocked for the reason it always was.
    assert.equal(UNFED_FAMILY_BLOCKERS.aggregate_presence?.blocker, "no_declared_origin");
  });
});
