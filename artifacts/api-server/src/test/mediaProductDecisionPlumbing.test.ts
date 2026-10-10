/**
 * census-media §36 — decision-independent plumbing for two rows that wait on
 * the owner, each proved to change nothing any user sees today.
 *
 * MD255 (§33 audiences `following` / `shared_moment` at post level). Every
 * option the owner is asked to choose between needs the post readers to fail
 * CLOSED on a visibility they do not know. The media following-feed gate did
 * the opposite: past the follow check it refused only `private` and checked
 * `trip_only`, so any other value was served to every follower. It now admits
 * only the four audiences it knows.
 *   A1. every value the post enum can hold today is decided EXACTLY as before
 *       (the pre-change branch is restated below as the reference);
 *   A2. an unknown value (`following`, `shared_moment`, anything) reaches
 *       nobody but its author.
 *
 * MD79 (§11 `locationDisclosureExpiresAt`). Every option needs the disclosure
 * choke point to cap a place once its disclosure has ended. The cap exists in
 * resolveMediaPlaceDisclosure and is INERT: no caller supplies an expiry.
 *   B1. absent (or future) ⇒ byte-identical output, over every tier × mode × gem;
 *   B2. ended ⇒ capped at the fallback (default 'hidden'), never widened, never
 *       applied to the owner; an unreadable expiry counts as ended;
 *   B3. the §11 member is served only when a producer supplies a valid instant;
 *   B4. the producer (lead ruling D-26f, 2026-10-07) is supplied at exactly the two
 *       choke-point callers, and never to the §11 member a client receives.
 *
 * Run: node --import tsx/esm --test src/test/mediaProductDecisionPlumbing.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  filterEligibleMediaCandidates,
  FOLLOWING_FEED_ADMITTED_VISIBILITIES,
  type MediaCandidate,
} from "../lib/mediaEligibility.js";
import {
  LOCATION_VISIBILITY_TIERS,
  POST_LOCATION_PRIVACY_MODES,
  coarsenMediaLocation,
  locationDisclosureExpired,
  locationPrivacyModeToCeiling,
  normalizeTier,
  resolveMediaLocationWithGemProtection,
  resolveMediaPlaceDisclosure,
  stricterTier,
  type MediaPlaceDisclosureOpts,
} from "../lib/mediaLocationVisibility.js";
import { resolveMediaTemporalState } from "../lib/media/mediaTemporalState.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR = "22222222-2222-2222-2222-222222222222";
const TRIP = "33333333-3333-3333-3333-333333333333";

/** A client with no blocks, mutes, suspensions or hides — only the visibility gate decides. */
const emptySc = {
  from() {
    const b: any = {
      select() { return b; }, eq() { return b; }, in() { return b; }, or() { return b; },
      then(onF: any, onR: any) { return Promise.resolve({ data: [], error: null }).then(onF, onR); },
    };
    return b;
  },
} as any;

function candidate(visibility: string | null, author = AUTHOR, tripId: string | null = TRIP): MediaCandidate {
  return {
    id: `p-${visibility}-${author}`, author_id: author, status: "active", post_status: "published",
    visibility: visibility as any, trip_id: tripId, moderation_status: "approved",
    created_at: "2026-09-27T10:00:00Z",
    post_media: [{ id: "m1", media_type: "image", processing_status: "ready", moderation_status: "approved" }],
  } as any;
}

async function admitted(visibility: string | null, feedType: "following" | "for_you", author = AUTHOR): Promise<boolean> {
  const { eligible, blockFetchFailed } = await filterEligibleMediaCandidates(
    [candidate(visibility, author)],
    { viewerUserId: VIEWER, feedType, followedCreatorIds: new Set([AUTHOR]), viewerTripIds: new Set([TRIP]) },
    emptySc,
    null,
    Date.parse("2026-09-27T12:00:00Z"),
  );
  assert.equal(blockFetchFailed, false);
  return eligible.length === 1;
}

/** The following-feed visibility branch as it stood at e9e0b0404, verbatim in effect. */
function beforeFollowing(visibility: string, isAuthor: boolean, tripMember: boolean): boolean {
  if (isAuthor) return true;
  if (visibility === "private") return false;
  if (visibility === "trip_only") return tripMember;
  return true;
}

/** Every value `post_visibility` can hold today (baseline + lib/postVisibility), and the raw `followers`. */
const TODAY = ["public", "trip_only", "private", "followers_only", "followers", null];

describe("A. MD255 — the following feed refuses an audience it does not know", () => {
  it("A1: every audience the enum holds today is decided exactly as before", async () => {
    for (const v of TODAY) {
      const expect = beforeFollowing(v ?? "public", false, true);
      assert.equal(await admitted(v, "following"), expect, `following feed, ${String(v)}`);
    }
  });

  it("A2: `following`, `shared_moment` and any other value reach nobody but the author", async () => {
    for (const v of ["following", "shared_moment", "trip_crew", "friends", "garbage"]) {
      assert.equal(beforeFollowing(v, false, true), true, `${v}: the old branch served it to every follower`);
      assert.equal(await admitted(v, "following"), false, `${v}: refused to a follower now`);
      assert.equal(await admitted(v, "following", VIEWER), true, `${v}: the author still sees their own`);
    }
  });

  it("the for-you feed is unchanged: public only", async () => {
    for (const v of [...TODAY, "following", "shared_moment"]) {
      assert.equal(await admitted(v, "for_you"), (v ?? "public") === "public", `for_you, ${String(v)}`);
    }
  });

  it("the admitted set is exactly the four known audiences", () => {
    assert.deepEqual([...FOLLOWING_FEED_ADMITTED_VISIBILITIES].sort(), ["followers", "followers_only", "public", "trip_only"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const INPUT = { name: "An Thuong Bar", neighborhood: "An Thuong", city: "Da Nang", country: "Vietnam", lat: 16.05, lng: 108.24 };
const NOW = Date.parse("2026-09-27T12:00:00Z");
const PAST = "2026-09-27T11:00:00Z";
const FUTURE = "2026-09-28T12:00:00Z";
const GEMS = [{ ceiling: null, determined: true }, { ceiling: "city", determined: true }, { ceiling: null, determined: false }] as const;

/** resolveMediaPlaceDisclosure as it stood before the cap existed (e9e0b0404), restated as the reference. */
function placeDisclosureBefore(input: typeof INPUT, opts: MediaPlaceDisclosureOpts) {
  if (opts.isOwner === true) return { ...coarsenMediaLocation(input, { ...opts, isOwner: true }), mayDisclosePlaceId: true };
  const ownTier = normalizeTier(opts.locationVisibility);
  const modeCeiling = locationPrivacyModeToCeiling(opts.locationPrivacyMode, opts.postStatus);
  const withMode = modeCeiling == null ? ownTier : stricterTier(ownTier, modeCeiling);
  const d = resolveMediaLocationWithGemProtection(input, { ...opts, isOwner: false, locationVisibility: withMode });
  return { ...d, mayDisclosePlaceId: d.visibility === "place" };
}

describe("B. MD79 — the §11 location-disclosure cap, inert until a producer exists", () => {
  it("B1: absent, null, empty or FUTURE expiry ⇒ exactly the pre-cap output, over every tier × mode × gem × viewer", () => {
    for (const tier of LOCATION_VISIBILITY_TIERS) for (const mode of [...POST_LOCATION_PRIVACY_MODES, null]) for (const gem of GEMS) for (const isOwner of [false, true]) {
      const base: MediaPlaceDisclosureOpts = { locationVisibility: tier, locationPrivacyMode: mode, postStatus: "published", isOwner, gem: gem as any, coarsenSeed: "p" };
      const before = placeDisclosureBefore(INPUT, base);
      for (const expiresAt of [undefined, null, "", FUTURE]) {
        assert.deepEqual(resolveMediaPlaceDisclosure(INPUT, { ...base, locationDisclosureExpiresAt: expiresAt as any, nowMs: NOW }), before, `${tier}/${mode}/${isOwner}/${expiresAt}`);
      }
    }
  });

  it("B2: an ENDED disclosure falls to 'hidden' by default, or to the named tier — never wider than it was", () => {
    const open = { locationVisibility: "place", locationPrivacyMode: "none", isOwner: false, gem: { ceiling: null, determined: true }, nowMs: NOW };
    const hidden = resolveMediaPlaceDisclosure(INPUT, { ...open, locationDisclosureExpiresAt: PAST });
    assert.equal(hidden.visibility, "hidden");
    assert.equal(hidden.name, null);
    assert.equal(hidden.city, null);
    assert.equal(hidden.mayDisclosePlaceId, false);
    assert.equal(resolveMediaPlaceDisclosure(INPUT, { ...open, locationDisclosureExpiresAt: PAST, afterLocationDisclosureExpiry: "city" }).visibility, "city");
    // Already coarser than the fallback: the cap never WIDENS.
    const cityOnly = { ...open, locationPrivacyMode: "city_only" };
    assert.equal(resolveMediaPlaceDisclosure(INPUT, { ...cityOnly, locationDisclosureExpiresAt: PAST, afterLocationDisclosureExpiry: "neighborhood" }).visibility, "city");
  });

  it("B2: the owner is never capped; an unreadable expiry counts as ended; now itself has ended", () => {
    assert.equal(resolveMediaPlaceDisclosure(INPUT, { isOwner: true, locationDisclosureExpiresAt: PAST, nowMs: NOW }).name, INPUT.name);
    assert.equal(locationDisclosureExpired("not-a-date", NOW), true);
    assert.equal(locationDisclosureExpired(new Date(NOW).toISOString(), NOW), true);
    assert.equal(locationDisclosureExpired(FUTURE, NOW), false);
    assert.equal(locationDisclosureExpired(null, NOW), false);
  });

  it("B3: the §11 member is served only for a valid instant a producer supplies", () => {
    assert.deepEqual(resolveMediaTemporalState({ eligibility: null }), {});
    assert.deepEqual(resolveMediaTemporalState({ eligibility: null, locationDisclosureExpiresAt: "garbage" }), {});
    assert.deepEqual(resolveMediaTemporalState({ eligibility: null, locationDisclosureExpiresAt: FUTURE }), { locationDisclosureExpiresAt: "2026-09-28T12:00:00.000Z" });
  });

  it("B4: the producers are exactly the two media choke-point callers (census-media MD79, lead ruling D-26f) — and nothing serves the §11 instant", () => {
    const SRC = join(HERE, "..");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) { if (f !== "test" && f !== "node_modules") walk(p); continue; }
        if (!/\.ts$/.test(f)) continue;
        const rel = relative(SRC, p);
        if (rel === join("lib", "mediaLocationVisibility.ts") || rel === join("lib", "media", "mediaTemporalState.ts")) continue;
        if (/locationDisclosureExpiresAt\s*:/.test(readFileSync(p, "utf8"))) hits.push(rel);
      }
    };
    walk(SRC);
    // Was `[]` ("no producer"): the owner-delegated ruling D-26f supplied one, and it is supplied to the choke
    // point ONLY. A third site — above all a caller of resolveMediaTemporalState — would serve
    // published_at + 24 h to a non-owner, which dates the author's exit (3362 withholds published_at for that reason).
    assert.deepEqual(hits.sort(), [join("routes", "mediaFeed.ts"), join("services", "media", "MediaProjectionService.ts")].sort(),
      "the §11 expiry producer moved or spread: census-media MD79 must be re-graded with it");
  });
});
