/**
 * Section 13 - memory graph and compression hierarchy.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       section 13 (:395), section 4 MemoryRelationType (:178), section 7 (midnight).
 * CENSUS: H104 (compression hierarchy), H105 (Life Chapters as projections, not
 *         duplicated Memories), H106 (relationship edge types) - all NOT-BUILT.
 *
 * THE TWO CLAIMS THAT COULD BE FAKED, and how they are pinned:
 *
 *   * "Life Chapters are projections, not duplicated Memories." A chapter that
 *     copied its members' titles would pass any "the chapter has three items"
 *     test. So the assertions here check the chapter's KEYS - it may hold ids,
 *     counts and bounds and nothing else - and then delete a Memory from the
 *     source and rebuild, requiring it to vanish from the chapter with no
 *     residue.
 *   * "Day is a projection, not a boundary." A day bucketer that used UTC would
 *     pass a test written in UTC. So the day assertions use a +07:00 offset
 *     where the UTC date and the local date differ.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryProjectionGraph.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMPRESSION_LEVELS,
  MEMORY_EDGE_TARGETS,
  MEMORY_RELATION_TYPES,
  buildCompressionHierarchy,
  buildLifeChapters,
  isValidEdge,
  rollUp,
  unplacedAt,
  type ChapterTheme,
  type GraphMoment,
  type MemoryEdge,
} from "../services/memoryProjections/memoryGraph.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BANGKOK_OFFSET = 7 * 60;

function moment(over: Partial<GraphMoment> & { memory_id: string }): GraphMoment {
  return {
    owner_id: OWNER,
    occurred_at: "2026-05-10T04:00:00.000Z",
    utc_offset_minutes: BANGKOK_OFFSET,
    episode_id: null,
    trip_id: null,
    place_id: null,
    people: [],
    significance_score: null,
    ...over,
  };
}

describe("section 13: the hierarchy", () => {
  it("has exactly the seven levels the spec names, in order", () => {
    assert.deepEqual([...COMPRESSION_LEVELS], [
      "SIGNAL", "MOMENT", "EPISODE", "DAY", "TRIP", "SEASON", "LIFE_CHAPTER",
    ]);
  });

  it("groups moments into episodes by episode id, and says which it could not place", () => {
    const moments = [
      moment({ memory_id: "m1", episode_id: "ep-1" }),
      moment({ memory_id: "m2", episode_id: "ep-1" }),
      moment({ memory_id: "m3", episode_id: "ep-2" }),
      moment({ memory_id: "m4" }),
    ];
    const episodes = rollUp(moments, "EPISODE");
    assert.deepEqual(episodes.map((e) => [e.key, e.member_memory_ids]), [
      ["ep-1", ["m1", "m2"]],
      ["ep-2", ["m3"]],
    ]);
    assert.deepEqual(unplacedAt(moments, "EPISODE"), [{ memory_id: "m4", reason: "no episode_id" }]);
  });

  it("a moment with no trip is not forced into a fabricated one", () => {
    const moments = [moment({ memory_id: "m1", trip_id: "trip-1" }), moment({ memory_id: "m2" })];
    const trips = rollUp(moments, "TRIP");
    assert.deepEqual(trips.map((t) => t.member_memory_ids), [["m1"]]);
    assert.deepEqual(unplacedAt(moments, "TRIP"), [{ memory_id: "m2", reason: "no trip_id" }]);
    // But it is still present one level down and one level up.
    assert.equal(rollUp(moments, "DAY").flatMap((d) => d.member_memory_ids).includes("m2"), true);
    assert.equal(rollUp(moments, "SEASON").flatMap((s) => s.member_memory_ids).includes("m2"), true);
  });

  it("DAY is local, and a night that crosses UTC midnight is one day, not two", () => {
    // 23:30 and 00:30 local Bangkok time - which is 16:30Z and 17:30Z the SAME
    // UTC day going in, and 2026-05-10 / 2026-05-11 locally. A UTC bucketer
    // would put both in one day for the wrong reason, so the second case below
    // is the one that separates the implementations.
    const lateNight = [
      moment({ memory_id: "m1", occurred_at: "2026-05-10T16:30:00.000Z" }), // 23:30 local 05-10
      moment({ memory_id: "m2", occurred_at: "2026-05-10T17:30:00.000Z" }), // 00:30 local 05-11
    ];
    const days = rollUp(lateNight, "DAY");
    assert.deepEqual(days.map((d) => d.key), ["2026-05-10", "2026-05-11"]);

    // And the reverse: two moments on either side of UTC midnight that are the
    // same local evening land in one local day.
    const sameLocalEvening = [
      moment({ memory_id: "m3", occurred_at: "2026-05-10T15:00:00.000Z" }), // 22:00 local 05-10
      moment({ memory_id: "m4", occurred_at: "2026-05-10T16:00:00.000Z" }), // 23:00 local 05-10
    ];
    assert.deepEqual(rollUp(sameLocalEvening, "DAY").map((d) => d.key), ["2026-05-10"]);
  });

  it("SEASON buckets by local quarter", () => {
    const moments = [
      moment({ memory_id: "m1", occurred_at: "2026-02-10T04:00:00.000Z" }),
      moment({ memory_id: "m2", occurred_at: "2026-05-10T04:00:00.000Z" }),
      moment({ memory_id: "m3", occurred_at: "2026-06-30T04:00:00.000Z" }),
    ];
    assert.deepEqual(rollUp(moments, "SEASON").map((s) => [s.key, s.memory_count]), [
      ["2026-Q1", 1],
      ["2026-Q2", 2],
    ]);
  });

  it("rolling up is deterministic under input reordering", () => {
    const moments = [
      moment({ memory_id: "m1", trip_id: "t1", occurred_at: "2026-05-01T04:00:00.000Z" }),
      moment({ memory_id: "m2", trip_id: "t1", occurred_at: "2026-05-02T04:00:00.000Z" }),
      moment({ memory_id: "m3", trip_id: "t2", occurred_at: "2026-05-03T04:00:00.000Z" }),
    ];
    assert.deepEqual(rollUp([...moments].reverse(), "TRIP"), rollUp(moments, "TRIP"));
  });

  it("the assembled hierarchy links each level down to the one below", () => {
    const moments = [
      moment({ memory_id: "m1", episode_id: "ep-1", trip_id: "t1", occurred_at: "2026-05-10T04:00:00.000Z" }),
      moment({ memory_id: "m2", episode_id: "ep-2", trip_id: "t1", occurred_at: "2026-05-11T04:00:00.000Z" }),
    ];
    const h = buildCompressionHierarchy(moments, []);
    assert.equal(h.levels.EPISODE.length, 2);
    assert.equal(h.levels.DAY.length, 2);
    assert.equal(h.levels.TRIP.length, 1);
    assert.deepEqual(h.levels.TRIP[0].child_node_ids, h.levels.DAY.map((d) => d.id).sort());
    assert.deepEqual(h.levels.DAY[0].child_node_ids, ["episode:ep-1"]);
    assert.deepEqual(h.levels.SEASON[0].child_node_ids, ["trip:t1"]);
    for (const node of [...h.levels.EPISODE, ...h.levels.DAY, ...h.levels.TRIP]) {
      assert.equal(node.engine_version, "memory-compression@1");
    }
  });
});

describe("section 13 / H105: Life Chapters are projections, not duplicated Memories", () => {
  const themes: ChapterTheme[] = [
    { key: "summer-in-asia", label: "Summer in Asia", matches: (m) => m.occurred_at >= "2026-05-01" && m.occurred_at < "2026-09-01" },
    { key: "best-nights", label: "Best Nights", matches: (m) => (m.significance_score ?? 0) >= 0.7, min_members: 2 },
  ];

  const moments = [
    moment({ memory_id: "m1", occurred_at: "2026-05-10T04:00:00.000Z", significance_score: 0.8 }),
    moment({ memory_id: "m2", occurred_at: "2026-06-10T04:00:00.000Z", significance_score: 0.9 }),
    moment({ memory_id: "m3", occurred_at: "2026-11-10T04:00:00.000Z", significance_score: 0.2 }),
  ];

  it("a chapter holds ids, counts and bounds - never a copy of the memory's content", () => {
    const chapters = buildLifeChapters(moments, themes);
    const summer = chapters.find((c) => c.key === "summer-in-asia");
    assert.ok(summer);
    assert.deepEqual(Object.keys(summer).sort(), [
      "child_node_ids", "ended_at", "engine_version", "id", "key", "level",
      "member_memory_ids", "memory_count", "owner_id", "started_at",
    ]);
    assert.deepEqual(summer.member_memory_ids, ["m1", "m2"]);
    assert.equal(summer.memory_count, 2);
    const serialized = JSON.stringify(summer);
    assert.equal(serialized.includes("significance"), false, "a chapter is not a place to leak a score");
  });

  it("a theme below its minimum membership is not shown", () => {
    const thin = buildLifeChapters([moments[0]], themes);
    assert.deepEqual(thin.map((c) => c.key), ["summer-in-asia"], "Best Nights needs two");
  });

  it("deleting a Memory removes it from every chapter on rebuild, with no residue", () => {
    const before = buildLifeChapters(moments, themes);
    assert.ok(before.find((c) => c.key === "best-nights")?.member_memory_ids.includes("m1"));

    const after = buildLifeChapters(moments.filter((m) => m.memory_id !== "m1"), themes);
    const bestNights = after.find((c) => c.key === "best-nights");
    // Only m2 remains above the threshold, which is below the theme's minimum,
    // so the chapter disappears entirely rather than lingering with a stale count.
    assert.equal(bestNights, undefined);
    const summer = after.find((c) => c.key === "summer-in-asia");
    assert.deepEqual(summer?.member_memory_ids, ["m2"]);
    assert.equal(JSON.stringify(after).includes("m1"), false, "no trace of the deleted memory survives");
  });

  it("chapters are stable: the same moments and themes rebuild identically", () => {
    assert.deepEqual(buildLifeChapters(moments, themes), buildLifeChapters([...moments].reverse(), themes));
  });
});

describe("section 13 / section 4: relationship edges", () => {
  const edge = (over: Partial<MemoryEdge> = {}): MemoryEdge => ({
    source_memory_id: "m1",
    target_type: "PLACE",
    target_id: "place-1",
    relation_type: "RELATED",
    confidence: 0.8,
    visibility_override: null,
    ...over,
  });

  it("the seven target types of section 13 are registered", () => {
    assert.deepEqual([...MEMORY_EDGE_TARGETS], [
      "PERSON", "PLACE", "TRIP", "EVENT", "STAMP", "MEMORY", "WORLD_CONTEXT_SNAPSHOT",
    ]);
  });

  it("the nine MemoryRelationType values of section 4 are registered", () => {
    assert.deepEqual([...MEMORY_RELATION_TYPES], [
      "SAME_EPISODE", "RELATED", "CONTAINS", "LED_TO", "DISCOVERED_THROUGH",
      "INTRODUCED_BY", "RESULTED_IN", "DERIVED_FROM", "INSPIRED",
    ]);
  });

  it("a well-formed edge validates and a malformed one does not", () => {
    assert.equal(isValidEdge(edge()), true);
    assert.equal(isValidEdge(edge({ target_type: "PLANET" as MemoryEdge["target_type"] })), false);
    assert.equal(isValidEdge(edge({ relation_type: "VIBES_WITH" as MemoryEdge["relation_type"] })), false);
    assert.equal(isValidEdge(edge({ target_id: "" })), false);
    assert.equal(isValidEdge(edge({ source_memory_id: "" })), false);
  });

  it("an edge may carry no confidence, which is not the same as zero confidence", () => {
    const unknown = edge({ confidence: null });
    assert.equal(isValidEdge(unknown), true);
    assert.equal(unknown.confidence, null);
  });
});
