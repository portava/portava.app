/**
 * census-media MD77 — `socialExpiresAt`. Lead ruling D-26e
 * (docs/ops/lead-rulings-20261007-media.md): NO social expiry (census-media
 * §36.4 MD77 option (c)). A post stays on social surfaces until its author
 * deletes it or narrows its audience; spec §11's optional `socialExpiresAt` is
 * never set. Option (c) needs no build, so what is pinned here is that the tree
 * keeps the ruled behaviour — that nothing quietly starts expiring people's
 * posts by age:
 *
 *   A. the §11 member is never served (no producer exists);
 *   B. Media eligibility is time-invariant for a post: a three-year-old post is
 *      admitted to the For You and Following feeds exactly as a new one is;
 *   C. no `social_expires_at` column exists on posts, post_media or media_assets
 *      in the baseline or any migration.
 *
 * A change that adds a social lifetime turns this red, and has to come with a
 * new ruling.
 *
 * Run: node --import tsx/esm --test src/test/mediaNoSocialExpiry.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveMediaTemporalState } from "../lib/media/mediaTemporalState.js";
import { filterEligibleMediaCandidates, type MediaCandidate } from "../lib/mediaEligibility.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, "..", "..");
const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR = "22222222-2222-2222-2222-222222222222";
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** A client with no blocks, mutes, suspensions or hides — only visibility and lifecycle decide. */
const emptySc = {
  from() {
    const b: any = {
      select() { return b; }, eq() { return b; }, in() { return b; }, or() { return b; },
      then(onF: any, onR: any) { return Promise.resolve({ data: [], error: null }).then(onF, onR); },
    };
    return b;
  },
} as any;

function post(ageMs: number): MediaCandidate {
  return {
    id: `p-${ageMs}`, author_id: AUTHOR, status: "active", post_status: "published",
    visibility: "public", trip_id: null, moderation_status: "approved",
    created_at: new Date(NOW - ageMs).toISOString(),
    post_media: [{ id: "m1", media_type: "image", processing_status: "ready", moderation_status: "approved" }],
  } as any;
}

describe("A. the §11 socialExpiresAt member is never served", () => {
  it("whatever eligibility and disclosure input the projection hands it", () => {
    const inputs = [
      { eligibility: null },
      { eligibility: { eligible: true, expiresAt: new Date(NOW + DAY).toISOString() } },
      { eligibility: { eligible: false, expiresAt: new Date(NOW - DAY).toISOString() } },
      { eligibility: null, locationDisclosureExpiresAt: new Date(NOW + DAY).toISOString() },
    ];
    for (const i of inputs) assert.equal("socialExpiresAt" in resolveMediaTemporalState(i as any), false);
  });
});

describe("B. a post's age never takes it off a social surface", () => {
  it("For You and Following admit a three-year-old post exactly as a new one", async () => {
    for (const feedType of ["for_you", "following"] as const) {
      const ages = [0, DAY, 30 * DAY, 365 * DAY, 3 * 365 * DAY];
      const { eligible, blockFetchFailed } = await filterEligibleMediaCandidates(
        ages.map(post),
        { viewerUserId: VIEWER, feedType, followedCreatorIds: new Set([AUTHOR]), viewerTripIds: new Set() },
        emptySc,
        null,
        NOW,
      );
      assert.equal(blockFetchFailed, false);
      assert.deepEqual(eligible.map((c) => c.id).sort(), ages.map((a) => `p-${a}`).sort(), feedType);
    }
  });
});

describe("C. no social-expiry column exists", () => {
  it("in the baseline or in any migration", () => {
    const files = [join(API, "baseline", "20260819_baseline_structure.sql")];
    const dir = join(API, "src", "migrations");
    for (const f of readdirSync(dir)) if (f.endsWith(".sql")) files.push(join(dir, f));
    assert.ok(files.length > 100, "precondition: the migration chain was read");
    const hits = files.filter((f) => /social_expires_at/i.test(readFileSync(f, "utf8")));
    assert.deepEqual(hits, []);
  });
});
