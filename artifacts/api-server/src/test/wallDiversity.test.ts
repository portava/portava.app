/**
 * WallDiversityService — the Feed Diversity Controller (spec §15).
 *
 * Proves the controller prevents the failure modes it OWNS: five-videos-in-a-row
 * (object-type window cap), one-creator floods (actor window cap) and a
 * disguised Discovery page (discovery pruning + social ratio) — and that it is
 * otherwise reorder-preserving (every social object survives).
 *
 * It no longer owns annotation capping or §4 live-strip dedup. Those used to
 * live here as a second copy that could never fire — routes/wall.ts calls
 * applyFeedDiversity before attachContextThreads, so the copy always saw zero
 * context threads and an empty strip set, and the two tests that covered it
 * exercised a path production never took. Both rules are enforced upstream by
 * ContextThreadService's §9 gate, where the excess/duplicate thread is never
 * BUILT; wallContextThread.test.ts covers them there, including the four
 * place-anchored kinds the old copy never handled.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFeedDiversity,
  DEFAULT_FEED_DIVERSITY_POLICY,
  type FeedDiversityPolicy,
} from "../services/wall/WallDiversityService.js";
import type { WallObjectType, WallProjection } from "../lib/wallProjection.js";

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
