/**
 * WallDiversityService — the Feed Diversity Controller (spec §15).
 *
 * Proves the controller prevents the four failure modes it exists to prevent:
 * five-videos-in-a-row (object-type window cap), one-creator floods (actor
 * window cap), a disguised Discovery page (discovery pruning + social ratio),
 * and a wall of annotations (context-thread window cap + live-strip dedup) — and
 * that it is otherwise reorder-preserving (every social object survives).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFeedDiversity,
  DEFAULT_FEED_DIVERSITY_POLICY,
  type FeedDiversityPolicy,
} from "../services/wall/WallDiversityService.js";
import type { ContextThread, WallObjectType, WallProjection } from "../lib/wallProjection.js";

let seq = 0;
function item(
  objectType: WallObjectType,
  actorId: string,
  over: Partial<WallProjection> = {},
): WallProjection {
  const id = `obj-${seq++}`;
  return {
    projectionId: `wall_${objectType}_${id}`,
    objectType,
    canonicalObjectId: id,
    actor: { userId: actorId, displayName: actorId },
    publishedAt: "2026-09-01T00:00:00.000Z",
    visibility: "public",
    actions: [],
    ...over,
  } as WallProjection;
}

function ids(items: WallProjection[]): string[] {
  return items.map((i) => i.canonicalObjectId);
}

/** Assert: within every sliding window of `w`, no key appears more than `cap`. */
function assertWindowCap(items: WallProjection[], key: (p: WallProjection) => string | null, cap: number, w: number, msg: string) {
  for (let end = 0; end < items.length; end++) {
    const start = Math.max(0, end - (w - 1));
    const counts = new Map<string, number>();
    for (let i = start; i <= end; i++) {
      const k = key(items[i]);
      if (k == null) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, n] of counts) {
      assert.ok(n <= cap, `${msg}: window [${start},${end}] has ${n} of "${k}" (cap ${cap})`);
    }
  }
}

describe("Feed Diversity Controller — object-type spacing (no 5-in-a-row)", () => {
  it("spaces videos so no window exceeds maxSameObjectTypeInWindow", () => {
    const policy: FeedDiversityPolicy = {
      ...DEFAULT_FEED_DIVERSITY_POLICY,
      maxSameObjectTypeInWindow: 2,
    };
    const input = [
      item("video", "a"),
      item("video", "b"),
      item("video", "c"),
      item("social_post", "d"),
      item("social_post", "e"),
    ];
    const out = applyFeedDiversity(input, policy, { windowSize: 3 });
    assert.equal(out.items.length, 5, "reorder-preserving: nothing dropped");
    assertWindowCap(out.items, (p) => p.objectType, 2, 3, "object-type cap");
  });
});

describe("Feed Diversity Controller — actor flood defense", () => {
  it("no window exceeds maxSameActorInWindow when actors are mixed", () => {
    const policy: FeedDiversityPolicy = {
      ...DEFAULT_FEED_DIVERSITY_POLICY,
      maxSameActorInWindow: 2,
      maxSameObjectTypeInWindow: 6, // isolate the actor constraint
    };
    const input = [
      item("social_post", "A"),
      item("social_post", "A"),
      item("social_post", "A"),
      item("social_post", "B"),
      item("social_post", "B"),
      item("social_post", "B"),
    ];
    const out = applyFeedDiversity(input, policy, { windowSize: 3 });
    assert.equal(out.items.length, 6, "every item still present (reorder only)");
    assert.deepEqual([...ids(out.items)].sort(), ids(input).sort());
    assertWindowCap(out.items, (p) => p.actor?.userId ?? null, 2, 3, "actor cap");
  });
});

describe("Feed Diversity Controller — disguised-Discovery-page defense", () => {
  it("drops discovery insertions that break the social-object ratio", () => {
    const policy: FeedDiversityPolicy = {
      ...DEFAULT_FEED_DIVERSITY_POLICY,
      minSocialObjectRatio: 0.5,
      maxDiscoveryInsertionsInWindow: 3,
    };
    // A window stuffed with discovery: 1 social + 4 discovery would be 20% social.
    const input = [
      item("social_post", "s"),
      item("discovery", "d1", { objectType: "discovery", discoveryReason: "r" } as any),
      item("discovery", "d2", { objectType: "discovery", discoveryReason: "r" } as any),
      item("discovery", "d3", { objectType: "discovery", discoveryReason: "r" } as any),
      item("discovery", "d4", { objectType: "discovery", discoveryReason: "r" } as any),
    ];
    const out = applyFeedDiversity(input, policy, { windowSize: 4 });
    assert.ok(out.droppedDiscovery > 0, "at least one discovery insertion is pruned");
    // The social object is never dropped.
    assert.ok(out.items.some((i) => i.objectType === "social_post"));
    // Every window keeps the social ratio at/above the floor.
    for (let end = 0; end < out.items.length; end++) {
      const start = Math.max(0, end - 3);
      const win = out.items.slice(start, end + 1);
      const social = win.filter((p) => p.objectType !== "discovery" && p.objectType !== "contextual_opportunity").length;
      assert.ok(social / win.length >= 0.5, `window [${start},${end}] social ratio below floor`);
    }
  });

  it("caps discovery insertions per window", () => {
    const policy: FeedDiversityPolicy = {
      ...DEFAULT_FEED_DIVERSITY_POLICY,
      minSocialObjectRatio: 0, // isolate the discovery cap
      maxDiscoveryInsertionsInWindow: 1,
    };
    const input = [
      item("social_post", "s1"),
      item("discovery", "d1", { objectType: "discovery", discoveryReason: "r" } as any),
      item("discovery", "d2", { objectType: "discovery", discoveryReason: "r" } as any),
      item("social_post", "s2"),
    ];
    const out = applyFeedDiversity(input, policy, { windowSize: 2 });
    assertWindowCap(out.items, (p) => (p.objectType === "discovery" ? "d" : null), 1, 2, "discovery cap");
  });
});

describe("Feed Diversity Controller — annotation overload + live-strip dedup", () => {
  const thread = (kind: ContextThread["kind"], targetId?: string): ContextThread => ({
    kind,
    label: `${kind} thread`,
    confidence: 0.8,
    action: targetId ? { type: "see_place", label: "See place", targetType: "place", targetId } : undefined,
  });

  it("strips context threads beyond maxContextThreadsInWindow (object stays)", () => {
    const policy: FeedDiversityPolicy = {
      ...DEFAULT_FEED_DIVERSITY_POLICY,
      maxContextThreadsInWindow: 1,
      // Disable reordering constraints so positions are stable for the assertion.
      maxSameActorInWindow: 9,
      maxSameObjectTypeInWindow: 9,
    };
    const input = [
      item("social_post", "a", { contextThread: thread("trip_relevance") }),
      item("social_post", "b", { contextThread: thread("trip_relevance") }),
      item("social_post", "c", { contextThread: thread("trip_relevance") }),
    ];
    const out = applyFeedDiversity(input, policy, { windowSize: 3 });
    assert.equal(out.items.length, 3, "no object dropped — only annotations stripped");
    const withThread = out.items.filter((i) => !!i.contextThread).length;
    assert.ok(withThread <= 1, "at most one thread survives per window");
    assert.ok(out.strippedThreads >= 2);
  });

  it("de-duplicates a live_place thread already shown in the Live For You strip", () => {
    const policy: FeedDiversityPolicy = {
      ...DEFAULT_FEED_DIVERSITY_POLICY,
      liveStripDeduplication: true,
      maxContextThreadsInWindow: 9, // isolate the live-strip dedup
      maxSameActorInWindow: 9,
      maxSameObjectTypeInWindow: 9,
    };
    const input = [
      item("social_post", "a", {
        place: { placeId: "place-live", name: "P" },
        contextThread: thread("live_place", "place-live"),
      }),
      item("social_post", "b", {
        place: { placeId: "place-other", name: "Q" },
        contextThread: thread("live_place", "place-other"),
      }),
    ];
    const out = applyFeedDiversity(input, policy, {
      windowSize: 3,
      liveStripSubjectIds: new Set(["place-live"]),
    });
    const a = out.items.find((i) => i.canonicalObjectId === input[0].canonicalObjectId)!;
    const b = out.items.find((i) => i.canonicalObjectId === input[1].canonicalObjectId)!;
    assert.equal(a.contextThread, undefined, "live thread duplicating the strip is removed");
    assert.ok(b.contextThread, "a distinct live thread is kept");
    assert.ok(out.strippedThreads >= 1);
  });
});

describe("Feed Diversity Controller — degenerate inputs", () => {
  it("returns empty unchanged", () => {
    const out = applyFeedDiversity([]);
    assert.deepEqual(out.items, []);
  });
});
