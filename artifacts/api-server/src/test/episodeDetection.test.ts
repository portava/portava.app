/**
 * Section 7 - episode detection and the boundary engine.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       section 7 (:266), section 3.2 (:84), section 25 (replay).
 * CENSUS: H58, H59, H60, H61, H62 - all NOT-BUILT before this suite.
 *
 * WHY THESE TESTS AND NOT ONE HAPPY EXAMPLE. A detector that never splits
 * passes any "these two belong together" test, and a detector that always splits
 * passes any "these two are different" test. So every rule is tested on BOTH
 * sides of its threshold, and the midnight rule - the one section 7 states
 * explicitly - is paired with a same-length gap inside one calendar day, which a
 * date-bucketing detector would join. Only a detector that reads elapsed time
 * rather than the calendar passes both.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/episodeDetection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS,
  EPISODE_DETECTOR_VERSION,
  EPISODE_REASON_CODES,
  detectEpisodes,
  featureFromEvidence,
  haversineKm,
  relateEpisodes,
  type EpisodeFeature,
} from "../services/memoryProjections/episodeDetection.js";
import { normalizeEvidence } from "../services/memoryProjections/evidence.js";

const OWNER = "22222222-2222-4222-8222-222222222222";

function f(id: string, at: string, over: Partial<EpisodeFeature> = {}): EpisodeFeature {
  return {
    evidence_id: id,
    owner_id: OWNER,
    source_type: "CAMERA_CAPTURE",
    at_ms: Date.parse(at),
    place_id: "place-a",
    lat: 13.75,
    lng: 100.5,
    trip_id: "trip-1",
    event_id: null,
    participants: ["marcus"],
    activity_type: "dining",
    transport_mode: null,
    is_home_or_hotel_return: false,
    explicit_remember: false,
    confidence: 0.7,
    ...over,
  };
}

const ids = (r: ReturnType<typeof detectEpisodes>) => r.episodes.map((e) => e.evidence_ids);

describe("section 7: midnight is not a boundary", () => {
  it("a late-night experience spanning two calendar dates is ONE episode", () => {
    const r = detectEpisodes([f("a", "2026-05-09T23:50:00Z"), f("b", "2026-05-10T00:10:00Z")]);
    assert.equal(r.episodes.length, 1, JSON.stringify(ids(r)));
    assert.deepEqual(r.episodes[0].evidence_ids, ["a", "b"]);
    assert.equal(r.boundaries[0].crosses_midnight, true, "the detector saw the date change");
    assert.equal(r.boundaries[0].split, false, "and did nothing with it");
    assert.deepEqual(r.boundaries[0].features, [], "no boundary feature fired");
  });

  it("PAIRED - the same 20-minute gap inside one calendar day is also ONE episode", () => {
    const r = detectEpisodes([f("a", "2026-05-10T14:50:00Z"), f("b", "2026-05-10T15:10:00Z")]);
    assert.equal(r.episodes.length, 1);
  });

  it("PAIRED - a genuinely long pause DOES split, so the rule above is not 'never splits'", () => {
    const r = detectEpisodes([f("a", "2026-05-10T08:00:00Z"), f("b", "2026-05-10T14:00:00Z")]);
    assert.equal(r.episodes.length, 2, JSON.stringify(ids(r)));
    assert.ok(r.boundaries[0].features.includes("TIME_GAP"));
  });

  it("a 4-hour pause that crosses midnight splits for the pause, not for the date", () => {
    const r = detectEpisodes([f("a", "2026-05-09T22:00:00Z"), f("b", "2026-05-10T02:00:00Z")]);
    assert.equal(r.episodes.length, 2);
    assert.deepEqual(r.boundaries[0].features, ["TIME_GAP"]);
  });
});

describe("section 7: each boundary feature, on both sides of its threshold", () => {
  it("TIME_GAP: exactly at the threshold does not split; one minute past it does", () => {
    const at = detectEpisodes([
      f("a", "2026-05-10T08:00:00Z"),
      f("b", `2026-05-10T${String(8 + DEFAULT_THRESHOLDS.time_gap_minutes / 60).padStart(2, "0")}:00:00Z`),
    ]);
    assert.equal(at.episodes.length, 1, "180 minutes is not MORE than 180 minutes");
    const past = detectEpisodes([f("a", "2026-05-10T08:00:00Z"), f("b", "2026-05-10T11:01:00Z")]);
    assert.equal(past.episodes.length, 2);
  });

  it("GEO_TRANSITION: 20 km apart holds together, 30 km apart splits, at the same instant gap", () => {
    const near = detectEpisodes([
      f("a", "2026-05-10T08:00:00Z", { lat: 13.75, lng: 100.5 }),
      f("b", "2026-05-10T08:30:00Z", { lat: 13.75, lng: 100.685, place_id: "place-a" }),
    ]);
    assert.equal(near.episodes.length, 1, `20 km: ${JSON.stringify(near.boundaries)}`);
    const far = detectEpisodes([
      f("a", "2026-05-10T08:00:00Z", { lat: 13.75, lng: 100.5 }),
      f("b", "2026-05-10T08:30:00Z", { lat: 14.05, lng: 100.5, place_id: "place-a" }),
    ]);
    assert.equal(far.episodes.length, 2);
    assert.ok(far.boundaries[0].features.includes("GEO_TRANSITION"));
  });

  it("TRIP_TRANSITION splits even when everything else is identical", () => {
    const r = detectEpisodes([
      f("a", "2026-05-10T08:00:00Z", { trip_id: "trip-1" }),
      f("b", "2026-05-10T08:10:00Z", { trip_id: "trip-2" }),
    ]);
    assert.equal(r.episodes.length, 2);
    assert.ok(r.boundaries[0].features.includes("TRIP_TRANSITION"));
  });

  it("PARTICIPANT_CHANGE: overlap at the floor holds, below it splits", () => {
    const held = detectEpisodes([
      f("a", "2026-05-10T08:00:00Z", { participants: ["marcus", "ana"] }),
      f("b", "2026-05-10T08:10:00Z", { participants: ["marcus", "ana", "kit"] }),
    ]);
    assert.equal(held.episodes.length, 1, "2 of 3 shared is above the 0.5 floor");
    const split = detectEpisodes([
      f("a", "2026-05-10T08:00:00Z", { participants: ["marcus"] }),
      f("b", "2026-05-10T08:10:00Z", { participants: ["kit", "sol"] }),
    ]);
    assert.equal(split.episodes.length, 2);
    assert.ok(split.boundaries[0].features.includes("PARTICIPANT_CHANGE"));
  });

  it("ACTIVITY_CHANGE needs a pause too: back-to-back activity switching is one episode", () => {
    const quick = detectEpisodes([
      f("a", "2026-05-10T08:00:00Z", { activity_type: "dining" }),
      f("b", "2026-05-10T08:05:00Z", { activity_type: "music" }),
    ]);
    assert.equal(quick.episodes.length, 1, "5 minutes later is the same night out");
    const paused = detectEpisodes([
      f("a", "2026-05-10T08:00:00Z", { activity_type: "dining" }),
      f("b", "2026-05-10T09:00:00Z", { activity_type: "music" }),
    ]);
    assert.equal(paused.episodes.length, 2);
    assert.ok(paused.boundaries[0].features.includes("ACTIVITY_CHANGE"));
  });

  it("TRANSPORT_CONTINUITY suppresses a long gap; the same gap without it splits", () => {
    const continuous = detectEpisodes([
      f("a", "2026-05-10T06:00:00Z", { transport_mode: "train", place_id: null, lat: null, lng: null, activity_type: "transit" }),
      f("b", "2026-05-10T12:00:00Z", { transport_mode: "train", place_id: null, lat: null, lng: null, activity_type: "transit" }),
    ]);
    assert.equal(continuous.episodes.length, 1, JSON.stringify(continuous.boundaries));
    assert.deepEqual(continuous.boundaries[0].suppressed_by, ["TRANSPORT_CONTINUITY"]);

    const discontinuous = detectEpisodes([
      f("a", "2026-05-10T06:00:00Z", { transport_mode: null, place_id: null, lat: null, lng: null, activity_type: "transit" }),
      f("b", "2026-05-10T12:00:00Z", { transport_mode: null, place_id: null, lat: null, lng: null, activity_type: "transit" }),
    ]);
    assert.equal(discontinuous.episodes.length, 2);
  });

  it("HOME_OR_HOTEL_RETURN closes an episode", () => {
    const r = detectEpisodes([
      f("a", "2026-05-10T20:00:00Z"),
      f("b", "2026-05-10T20:30:00Z", { is_home_or_hotel_return: true, place_id: "hotel-1" }),
    ]);
    assert.equal(r.episodes.length, 2);
    assert.ok(r.boundaries[0].features.includes("HOME_OR_HOTEL_RETURN"));
  });

  it("EVENT_COMMITMENT_BOUNDARY splits when the event commitment changes", () => {
    const r = detectEpisodes([
      f("a", "2026-05-10T18:00:00Z", { event_id: null }),
      f("b", "2026-05-10T18:20:00Z", { event_id: "evt-1" }),
    ]);
    assert.equal(r.episodes.length, 2);
    assert.ok(r.boundaries[0].features.includes("EVENT_COMMITMENT_BOUNDARY"));
  });
});

describe("section 7: user corrections outrank computed features", () => {
  it("a user split cuts an episode the detector would have kept whole", () => {
    const plain = detectEpisodes([f("a", "2026-05-10T08:00:00Z"), f("b", "2026-05-10T08:10:00Z")]);
    assert.equal(plain.episodes.length, 1, "control: the detector keeps these together");

    const r = detectEpisodes([f("a", "2026-05-10T08:00:00Z"), f("b", "2026-05-10T08:10:00Z")], {
      user_splits: new Set(["b"]),
    });
    assert.equal(r.episodes.length, 2);
    assert.ok(r.boundaries[0].features.includes("USER_SPLIT"));
  });

  it("a user merge joins across a gap the detector would have cut, and says so", () => {
    const r = detectEpisodes([f("a", "2026-05-10T08:00:00Z"), f("b", "2026-05-10T18:00:00Z")], {
      user_merges: new Set(["b"]),
    });
    assert.equal(r.episodes.length, 1);
    assert.deepEqual(r.boundaries[0].suppressed_by, ["USER_MERGED"]);
    assert.ok(r.episodes[0].reason_codes.includes("USER_MERGED"));
  });

  it("a split and a merge on the same point: the split wins (a cut is the stronger instruction)", () => {
    const r = detectEpisodes([f("a", "2026-05-10T08:00:00Z"), f("b", "2026-05-10T08:10:00Z")], {
      user_splits: new Set(["b"]), user_merges: new Set(["b"]),
    });
    assert.equal(r.episodes.length, 2);
  });
});

describe("section 25: replay", () => {
  const set = [
    f("a", "2026-05-10T08:00:00Z"),
    f("b", "2026-05-10T08:30:00Z"),
    f("c", "2026-05-10T18:00:00Z", { place_id: "place-b", activity_type: "music" }),
    f("d", "2026-05-10T18:20:00Z", { place_id: "place-b", activity_type: "music" }),
  ];

  it("input order cannot change the output, byte for byte", () => {
    const forward = detectEpisodes(set);
    const shuffled = detectEpisodes([set[2], set[0], set[3], set[1]]);
    assert.deepEqual(shuffled.episodes, forward.episodes);
  });

  it("the same input twice yields the same episode ids", () => {
    const one = detectEpisodes(set).episodes.map((e) => e.id);
    const two = detectEpisodes(set).episodes.map((e) => e.id);
    assert.deepEqual(one, two);
    assert.ok(one.every((id) => id.startsWith("ep_")));
  });

  it("changing one member changes that episode's id and not the other's", () => {
    const base = detectEpisodes(set).episodes;
    const changed = detectEpisodes([...set.slice(0, 3), f("e", "2026-05-10T18:20:00Z", { place_id: "place-b", activity_type: "music" })]).episodes;
    assert.equal(base[0].id, changed[0].id, "the untouched episode keeps its identity");
    assert.notEqual(base[1].id, changed[1].id, "the changed episode does not");
  });

  it("every episode carries the detector version it was produced by", () => {
    for (const e of detectEpisodes(set).episodes) assert.equal(e.detector_version, EPISODE_DETECTOR_VERSION);
  });
});

describe("section 7: candidate reason codes", () => {
  it("FIRST_VISIT and REPEATED_PLACE are decided by the owner's history, not by the run", () => {
    const first = detectEpisodes([f("a", "2026-05-10T08:00:00Z")]);
    assert.ok(first.episodes[0].reason_codes.includes("FIRST_VISIT"));
    const repeat = detectEpisodes([f("a", "2026-05-10T08:00:00Z")], { visited_place_ids: new Set(["place-a"]) });
    assert.ok(repeat.episodes[0].reason_codes.includes("REPEATED_PLACE"));
    assert.ok(!repeat.episodes[0].reason_codes.includes("FIRST_VISIT"), "a place cannot be both");
  });

  it("SAME_TRIP, SAME_CREW, SAME_PLACE_CLUSTER and TIME_PROXIMITY are earned, not stamped on", () => {
    const cohesive = detectEpisodes([f("a", "2026-05-10T08:00:00Z"), f("b", "2026-05-10T08:20:00Z")]).episodes[0];
    for (const code of ["SAME_TRIP", "SAME_CREW", "SAME_PLACE_CLUSTER", "TIME_PROXIMITY"] as const) {
      assert.ok(cohesive.reason_codes.includes(code), `${code} missing from ${JSON.stringify(cohesive.reason_codes)}`);
    }
    const loose = detectEpisodes([f("a", "2026-05-10T08:00:00Z", { trip_id: null, participants: [] })]).episodes[0];
    assert.ok(!loose.reason_codes.includes("SAME_TRIP"));
    assert.ok(!loose.reason_codes.includes("SAME_CREW"));
  });

  it("EXPLICIT_REMEMBER and EVENT_CONTEXT appear only when their evidence does", () => {
    const remembered = detectEpisodes([f("a", "2026-05-10T08:00:00Z", { explicit_remember: true, source_type: "EXPLICIT_REMEMBER", confidence: 0.95 })]);
    assert.ok(remembered.episodes[0].reason_codes.includes("EXPLICIT_REMEMBER"));
    assert.equal(remembered.episodes[0].confidence_band, "HIGH", "an explicit remember is high-confidence");

    const evented = detectEpisodes([f("a", "2026-05-10T08:00:00Z", { event_id: "evt-1" })]);
    assert.ok(evented.episodes[0].reason_codes.includes("EVENT_CONTEXT"));
    assert.ok(!remembered.episodes[0].reason_codes.includes("EVENT_CONTEXT"));
  });

  it("no episode ever carries a code outside the registered vocabulary", () => {
    const r = detectEpisodes([
      f("a", "2026-05-10T08:00:00Z"),
      f("b", "2026-05-10T18:00:00Z", { place_id: "place-b", transport_mode: "taxi" }),
    ]);
    for (const e of r.episodes) {
      for (const code of e.reason_codes) assert.ok(EPISODE_REASON_CODES.includes(code), `unregistered code ${code}`);
    }
  });

  it("five weak proximity pings do not add up to a confident episode", () => {
    const pings = [0, 10, 20, 30, 40].map((m) =>
      f(`g${m}`, new Date(Date.parse("2026-05-10T08:00:00Z") + m * 60000).toISOString(), {
        source_type: "GPS_PROXIMITY", confidence: 0.35,
      }),
    );
    const e = detectEpisodes(pings).episodes[0];
    // Weak inference does not accumulate into certainty: with no
    // occurrence-bearing source the band is capped at LOW, however many pings.
    assert.equal(e.confidence_band, "LOW", `got ${e.confidence_band}`);
    const withPhoto = detectEpisodes([...pings, f("cam", "2026-05-10T08:45:00Z", { source_type: "CAMERA_CAPTURE", confidence: 0.7 })]);
    assert.equal(withPhoto.episodes[0].confidence_band, "HIGH", "PAIRED: one occurrence-bearing record changes the band");
  });
});

describe("section 7: deduplication relationships", () => {
  const base = detectEpisodes([f("a", "2026-05-10T08:00:00Z"), f("b", "2026-05-10T08:20:00Z")]).episodes[0];

  it("SAME_EPISODE for identical membership", () => {
    const again = detectEpisodes([f("a", "2026-05-10T08:00:00Z"), f("b", "2026-05-10T08:20:00Z")]).episodes[0];
    assert.equal(relateEpisodes(base, again), "SAME_EPISODE");
  });

  it("CONTAINS when one episode's evidence is a strict subset of the other's", () => {
    const smaller = detectEpisodes([f("a", "2026-05-10T08:00:00Z")]).episodes[0];
    assert.equal(relateEpisodes(base, smaller), "CONTAINS");
    assert.equal(relateEpisodes(smaller, base), "POSSIBLE_DUPLICATE", "the containment is directional");
  });

  it("POSSIBLE_DUPLICATE for overlapping time at the same place with no shared evidence", () => {
    const other = detectEpisodes([f("x", "2026-05-10T08:10:00Z"), f("y", "2026-05-10T08:15:00Z")]).episodes[0];
    assert.equal(relateEpisodes(base, other), "POSSIBLE_DUPLICATE");
  });

  it("RELATED for the same trip on a different day, and null for nothing in common", () => {
    const laterSameTrip = detectEpisodes([f("z", "2026-05-14T08:00:00Z", { place_id: "place-z" })]).episodes[0];
    assert.equal(relateEpisodes(base, laterSameTrip), "RELATED");
    const unrelated = detectEpisodes([f("q", "2026-08-01T08:00:00Z", { place_id: "place-q", trip_id: "trip-9" })]).episodes[0];
    assert.equal(relateEpisodes(base, unrelated), null);
  });
});

describe("section 6 to section 7: the adapter", () => {
  it("normalized evidence becomes a feature without the detector reading raw json anywhere else", () => {
    const r = normalizeEvidence({
      owner_id: OWNER,
      source_type: "EXPLICIT_REMEMBER",
      source_id: "rem-1",
      assertion_type: "OCCURRED",
      observed_at: "2026-05-10T08:00:00Z",
      assertion_json: { place_id: "p1", lat: 1.5, lng: 2.5, trip_id: "t1", participants: ["b", "a", "a"], activity_type: "dining" },
    }, new Date("2026-05-11T00:00:00Z"));
    assert.ok(r.ok);
    const feat = featureFromEvidence(r.evidence);
    assert.equal(feat.evidence_id, "EXPLICIT_REMEMBER:rem-1");
    assert.equal(feat.explicit_remember, true);
    assert.deepEqual(feat.participants, ["a", "b"], "deduplicated and sorted for stable comparison");
    assert.equal(feat.at_ms, Date.parse("2026-05-10T08:00:00Z"));
  });

  it("a coordinate-free pair yields no distance rather than a fabricated zero", () => {
    assert.equal(haversineKm({ lat: null, lng: null }, { lat: 1, lng: 1 }), null);
    assert.ok((haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) ?? 0) > 111 - 1);
  });
});
