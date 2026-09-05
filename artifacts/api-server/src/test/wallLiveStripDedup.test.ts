/**
 * §4 — "never repeat a live signal that already appears in the Live For You
 * strip" — for EVERY place-anchored Context Thread kind, not just one.
 *
 * WHAT WAS WRONG
 * --------------
 * The §9 gate has a `duplicatesLiveStrip` condition and it worked. But only ONE
 * of the seven candidate builders ever computed it: `readLivePlaceCandidate`.
 * The other six wrote the literal `duplicatesLiveStrip: false`, so the condition
 * was a dead branch for them — a `hidden_gem` strip item and a `hidden_gem`
 * thread on the same place both rendered, and likewise for `social_presence`,
 * `buddy` and `trip_relevance`. §4 was enforced for one strip kind out of six.
 *
 * The strip's subject-id set alone cannot fix that: it says "this place is in
 * the strip somehow", which is the right rule for `live_place` (it restates the
 * place's current state whatever kind won the slot) and far too coarse for the
 * rest — a `buddy` strip item must not silence an unrelated `hidden_gem`
 * thread. So routes/wall.ts now also builds the strip's (subject, kind) pairs
 * and the gate matches on those.
 *
 * MUTATION PROOF (verified: revert → RED, restore → GREEN)
 *   • put `duplicatesLiveStrip: false` back in readHiddenGemCandidate      →
 *     "hidden_gem thread is suppressed…" RED, the others still GREEN.
 *   • same in readSocialPresenceCandidate / readTripRelevanceCandidate /
 *     readBuddyCandidate                                                   →
 *     that kind's suppression test RED, the rest GREEN.
 *   • make THREAD_KIND_TO_LIVE_OBJECT_TYPE map every kind to one token     →
 *     the four "a DIFFERENT strip kind does not suppress" controls RED.
 *   • drop `liveStripSignals` from the attachContextThreads options object in
 *     routes/wall.ts                                                       →
 *     the plumbing test RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  liveStripSignalKey,
  threadDuplicatesLiveStrip,
  shouldAttachContextThread,
  _internal,
  type ContextThreadViewerContext,
} from "../services/wall/ContextThreadService.js";
import type { ContextThreadKind, WallProjection } from "../lib/wallProjection.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-09-01T12:00:00.000Z");
const PLACE = "place-1";
const CITY = "Bangkok";

function projection(): WallProjection {
  return {
    projectionId: "wall_social_post_p1",
    objectType: "social_post",
    canonicalObjectId: "p1",
    publishedAt: "2026-09-01T00:00:00.000Z",
    visibility: "public",
    actions: [],
    place: { placeId: PLACE, name: "An Thuong", city: CITY, country: "TH" },
  };
}

/** A viewer whose strip carries exactly one (subject, kind) signal. */
function viewerWithStrip(
  liveObjectType: string | null,
  over: Partial<ContextThreadViewerContext> = {},
): ContextThreadViewerContext {
  return {
    viewerId: "viewer-1",
    now: NOW,
    liveStripSignals:
      liveObjectType === null
        ? new Set<string>()
        : new Set([liveStripSignalKey(PLACE, liveObjectType)]),
    ...over,
  };
}

/** Per-table fake: awaiting a builder resolves to the configured rows. */
function tableClient(rowsByTable: Record<string, any[]>, flags: Record<string, boolean> = {}) {
  return {
    from(table: string) {
      const eqs: Record<string, unknown> = {};
      const b: any = {
        select: () => b,
        in: () => b,
        limit: () => b,
        order: () => b,
        gt: () => b,
        gte: () => b,
        lte: () => b,
        eq: (col: string, val: unknown) => {
          eqs[col] = val;
          return b;
        },
        maybeSingle: () =>
          Promise.resolve(
            table === "feature_flags"
              ? { data: { enabled: flags[String(eqs.flag)] === true }, error: null }
              : { data: (rowsByTable[table] ?? [])[0] ?? null, error: null },
          ),
        then: (onF: any, onR: any) =>
          Promise.resolve({ data: rowsByTable[table] ?? [], error: null }).then(onF, onR),
      };
      return b;
    },
  };
}

const HIDDEN_GEM_ROW = {
  id: "g1",
  sensitivity_level: "public",
  verification_level: "community",
  status: "active",
  crowd_level: "low",
  save_count: 2,
  visit_count: 4,
  canonical_place_id: PLACE,
  updated_at: "2026-09-01T09:00:00.000Z",
};

const TRIP_ROW = {
  id: "trip-9",
  destination_city: CITY,
  destination_country: "TH",
  start_date: "2026-09-13",
  status: "upcoming",
};

const SOCIAL_POSTS = [
  { author_id: "f1", created_at: "2026-08-30T00:00:00.000Z" },
  { author_id: "f2", created_at: "2026-08-31T00:00:00.000Z" },
];

// ── The mapping itself ────────────────────────────────────────────────────────

describe("threadDuplicatesLiveStrip — which thread kinds a strip item silences", () => {
  const PLACE_ANCHORED: Array<[ContextThreadKind, string]> = [
    ["hidden_gem", "hidden_gem"],
    ["social_presence", "social_presence"],
    ["buddy", "buddy"],
    ["trip_relevance", "trip_signal"],
  ];

  it("a strip item of the SAME kind on the SAME place suppresses the thread", () => {
    for (const [kind, liveObjectType] of PLACE_ANCHORED) {
      assert.equal(
        threadDuplicatesLiveStrip(kind, PLACE, viewerWithStrip(liveObjectType)),
        true,
        `${kind} must be deduped against a ${liveObjectType} strip item`,
      );
    }
  });

  it("a strip item of a DIFFERENT kind does NOT suppress the thread", () => {
    // The control that stops the rule collapsing into "any strip item silences
    // every thread on that place", which would lose information rather than
    // remove a duplicate.
    for (const [kind] of PLACE_ANCHORED) {
      assert.equal(
        threadDuplicatesLiveStrip(kind, PLACE, viewerWithStrip("place_state")),
        false,
        `${kind} must survive an unrelated place_state strip item`,
      );
    }
  });

  it("a strip item on a DIFFERENT place does not suppress the thread", () => {
    for (const [kind, liveObjectType] of PLACE_ANCHORED) {
      const viewer: ContextThreadViewerContext = {
        viewerId: "viewer-1",
        liveStripSignals: new Set([liveStripSignalKey("other-place", liveObjectType)]),
      };
      assert.equal(threadDuplicatesLiveStrip(kind, PLACE, viewer), false);
    }
  });

  it("kinds that are not live signals are never suppressed by the strip", () => {
    // map / memory / compass are navigation and recall, not current-state
    // claims: nothing in the strip can be a duplicate of them.
    for (const kind of ["map", "memory", "compass"] as ContextThreadKind[]) {
      for (const strip of ["place_state", "hidden_gem", "buddy", "social_presence", "trip_signal"]) {
        assert.equal(threadDuplicatesLiveStrip(kind, PLACE, viewerWithStrip(strip)), false);
      }
    }
  });

  it("is inert without a place id or without a strip", () => {
    assert.equal(threadDuplicatesLiveStrip("hidden_gem", null, viewerWithStrip("hidden_gem")), false);
    assert.equal(threadDuplicatesLiveStrip("hidden_gem", PLACE, { viewerId: "v" }), false);
  });
});

// ── The builders actually consult it ─────────────────────────────────────────

describe("the candidate builders feed the §9 gate a real duplicatesLiveStrip", () => {
  it("hidden_gem thread is suppressed by a hidden_gem strip item on the same place", async () => {
    const sc = tableClient({ hidden_gems: [HIDDEN_GEM_ROW] });
    const dup = await _internal.readHiddenGemCandidate(sc, projection(), viewerWithStrip("hidden_gem"));
    assert.ok(dup, "the reader must still PRODUCE a candidate — the gate is what refuses it");
    assert.equal(dup!.gate.duplicatesLiveStrip, true);
    assert.equal(shouldAttachContextThread(dup!.gate), false);

    // Positive control: same row, same reader, no matching strip signal.
    const kept = await _internal.readHiddenGemCandidate(sc, projection(), viewerWithStrip(null));
    assert.equal(kept!.gate.duplicatesLiveStrip, false);
  });

  it("trip_relevance thread is suppressed by a trip_signal strip item on the same place", async () => {
    const sc = tableClient({ trips: [TRIP_ROW] });
    const dup = await _internal.readTripRelevanceCandidate(sc, projection(), viewerWithStrip("trip_signal"));
    assert.ok(dup);
    assert.equal(dup!.gate.duplicatesLiveStrip, true);
    assert.equal(shouldAttachContextThread(dup!.gate), false);

    const kept = await _internal.readTripRelevanceCandidate(sc, projection(), viewerWithStrip(null));
    assert.equal(kept!.gate.duplicatesLiveStrip, false);
    assert.equal(shouldAttachContextThread(kept!.gate), true);
  });

  it("social_presence thread is suppressed by a social_presence strip item on the same place", async () => {
    const sc = tableClient({ posts: SOCIAL_POSTS });
    const followed = { followedCreatorIds: new Set(["f1", "f2", "f3"]) };
    const dup = await _internal.readSocialPresenceCandidate(
      sc,
      projection(),
      viewerWithStrip("social_presence", followed),
    );
    assert.ok(dup);
    assert.equal(dup!.gate.duplicatesLiveStrip, true);
    assert.equal(shouldAttachContextThread(dup!.gate), false);

    const kept = await _internal.readSocialPresenceCandidate(
      sc,
      projection(),
      viewerWithStrip(null, followed),
    );
    assert.equal(kept!.gate.duplicatesLiveStrip, false);
  });

  it("buddy thread is suppressed by a buddy strip item on the same place", async () => {
    const flags = { wall_rab_integration_enabled: true, rent_buddy_enabled: true };
    const sc = tableClient({ rent_buddy_profiles: [{ id: "b1", categories: ["food"] }] }, flags);
    const rab = { rabEnabled: true };
    const dup = await _internal.readBuddyCandidate(sc, projection(), viewerWithStrip("buddy", rab));
    assert.ok(dup);
    assert.equal(dup!.gate.duplicatesLiveStrip, true);
    assert.equal(shouldAttachContextThread(dup!.gate), false);

    const kept = await _internal.readBuddyCandidate(sc, projection(), viewerWithStrip(null, rab));
    assert.equal(kept!.gate.duplicatesLiveStrip, false);
  });
});

// ── The route supplies the set ───────────────────────────────────────────────

describe("routes/wall.ts hands attachContextThreads the strip's (subject, kind) pairs", () => {
  it("builds liveStripSignals from the live strip and passes it through", () => {
    // A structural check, deliberately: the gate above is only reachable in
    // production if the route actually populates the set, and the route's own
    // integration tests would stay green with the option dropped — which is
    // exactly how the six hardcoded `false`s survived so long.
    const route = readFileSync(resolve(__dir, "../routes/wall.ts"), "utf8");
    assert.match(
      route,
      /const liveStripSignals = new Set<string>\(\s*liveForYou\.map\(\(i\) => liveStripSignalKey\(i\.subjectId, i\.liveObjectType\)\),\s*\);/,
      "the route must derive the strip's (subject, kind) pairs from liveForYou",
    );
    assert.match(
      route,
      /attachContextThreads\(sc, items, projectViewer, \{[\s\S]*?liveStripSignals,[\s\S]*?\}\)/,
      "the route must hand liveStripSignals to attachContextThreads",
    );

    const service = readFileSync(
      resolve(__dir, "../services/wall/WallProjectionService.ts"),
      "utf8",
    );
    assert.match(
      service,
      /liveStripSignals,/,
      "attachContextThreads must forward liveStripSignals into the thread viewer context",
    );
  });
});
