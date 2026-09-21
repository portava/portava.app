/**
 * THE DELAYED-PUBLISH GATE ANSWERS ABOUT THE CLOCK IT IS GIVEN.
 *
 * `filterEligibleMediaCandidates` decides `publish_at <= now` — whether a
 * scheduled post has come due. Every media projection builder takes a `nowMs`,
 * stamps its envelope's `generatedAt` from it, and then reached this filter,
 * which read `Date.now()` for itself. So one gate in an injected-clock answer
 * was decided by the real date: the `computeTripStatus` defect, in the media
 * lane.
 *
 * Nothing went red at midnight on 2026-09-15 for this one, because no test on
 * this path pins a `nowMs`. That is luck, not safety — which is exactly why
 * these exist. Both instants below are far from the present in OPPOSITE
 * directions, so a wall-clock read gets one wrong whichever day the suite runs,
 * and the fixture and the assertion are pinned to the SAME instant, which is
 * what makes a fixed date safe rather than a bomb.
 *
 * Run: node --import tsx/esm --test src/test/mediaEligibilityInjectedClock.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { filterEligibleMediaCandidates, type MediaCandidate, type ViewerCtx } from "../lib/mediaEligibility.js";
import { loadEligibleCandidatesOrRefuse } from "../services/media/MediaProjectionService.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const AUTHOR = "22222222-2222-4222-8222-222222222222";

/** Long past and long future — neither is ever "now". */
const PAST_MS = Date.parse("2019-05-04T10:00:00.000Z");
const FUTURE_MS = Date.parse("2031-02-03T08:00:00.000Z");
const HOUR = 3_600_000;

const viewer: ViewerCtx = { viewerUserId: VIEWER, feedType: "for_you", followedCreatorIds: new Set<string>() };

/** Every eligibility side-read comes back empty; only the clock is under test. */
function emptyClient(): any {
  const chain: any = {
    select: () => chain, eq: () => chain, in: () => chain, or: () => chain, is: () => chain,
    gt: () => chain, lt: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (onF: any, onR: any) => Promise.resolve({ data: [], error: null }).then(onF, onR),
  };
  return { from: () => chain };
}

function scheduled(publishAtMs: number): MediaCandidate {
  return {
    id: "post-scheduled",
    author_id: AUTHOR,
    status: "active",
    post_status: "published",
    visibility: "public",
    moderation_status: "approved",
    publish_at: new Date(publishAtMs).toISOString(),
    created_at: new Date(publishAtMs - HOUR).toISOString(),
    post_media: [{ processing_status: "ready", moderation_status: "approved" }],
  };
}

describe("filterEligibleMediaCandidates judges publish_at on the injected clock", () => {
  it("a post scheduled AFTER the asked-about instant is withheld, though the wall clock says it is long due", async () => {
    const { eligible } = await filterEligibleMediaCandidates(
      [scheduled(PAST_MS + HOUR)], viewer, emptyClient(), new Set(), PAST_MS,
    );
    assert.deepEqual(
      eligible.map((c) => c.id), [],
      "the post comes due an hour after the instant this answer is about; only the wall clock calls it published",
    );
  });

  it("a post scheduled BEFORE the asked-about instant is served, though the wall clock says it is not due yet", async () => {
    const { eligible } = await filterEligibleMediaCandidates(
      [scheduled(FUTURE_MS - HOUR)], viewer, emptyClient(), new Set(), FUTURE_MS,
    );
    assert.deepEqual(
      eligible.map((c) => c.id), ["post-scheduled"],
      "the post came due an hour before the instant this answer is about; the wall clock suppressed it",
    );
  });

  it("the parameter is additive: with no clock passed, the wall clock decides, exactly as before", async () => {
    // Both windows are derived from the clock the assertion is judged against,
    // never from a calendar constant.
    const due = await filterEligibleMediaCandidates([scheduled(Date.now() - HOUR)], viewer, emptyClient(), new Set());
    assert.deepEqual(due.eligible.map((c) => c.id), ["post-scheduled"]);
    const notYet = await filterEligibleMediaCandidates([scheduled(Date.now() + HOUR)], viewer, emptyClient(), new Set());
    assert.deepEqual(notYet.eligible.map((c) => c.id), []);
  });
});

describe("the shared candidate loader carries its caller's clock into that gate", () => {
  /** A client whose `posts` table answers with one scheduled row. */
  function postsClient(row: MediaCandidate): any {
    const make = (table: string) => {
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, or: () => chain, is: () => chain,
        gt: () => chain, lt: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (onF: any, onR: any) =>
          Promise.resolve({ data: table === "posts" ? [row] : [], error: null }).then(onF, onR),
      };
      return chain;
    };
    return { from: (t: string) => make(t) };
  }

  const resolvedViewer: any = {
    viewerId: VIEWER,
    followedCreatorIds: new Set<string>(),
    viewerTripIds: new Set<string>(),
  };

  it("loadEligibleCandidatesOrRefuse(filter.nowMs) withholds a post not yet due at that instant", async () => {
    const rows = await loadEligibleCandidatesOrRefuse(
      postsClient(scheduled(PAST_MS + HOUR)) as any, resolvedViewer,
      { feedType: "for_you", nowMs: PAST_MS },
    );
    assert.deepEqual(rows.map((r: any) => r.id), [], "the loader dropped its caller's clock on the way to the gate");
  });

  it("loadEligibleCandidatesOrRefuse(filter.nowMs) serves a post already due at that instant", async () => {
    const rows = await loadEligibleCandidatesOrRefuse(
      postsClient(scheduled(FUTURE_MS - HOUR)) as any, resolvedViewer,
      { feedType: "for_you", nowMs: FUTURE_MS },
    );
    assert.deepEqual(rows.map((r: any) => r.id), ["post-scheduled"]);
  });
});
