/**
 * mediaWorldProjection — Media v2 Phase 2/3 World-first projection layer (§43).
 *
 * Proves, with fake Supabase clients only (no DB, no network, no HTTP listen):
 *   1. The precise-location detector is NOT vacuous and catches coordinate keys.
 *   2. toMediaProjection is COARSE — fed a row that HAS location_lat/location_lng
 *      it emits NO precise location (mutation-proof: a projector that copied a
 *      coord would make the "no precise location" assertion go red).
 *   3. Each §43 builder returns a well-formed projection with NO precise location
 *      anywhere in the response.
 *   4. A stale/absent live state yields NO live label — never fabricated.
 *   5. A blocked / private / ineligible-experience item is excluded.
 *   6. Empty data returns a valid, well-formed EMPTY projection.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaWorldProjection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findPreciseLocation,
  isPreciseLocationKey,
  isLocationSafe,
  scrubPreciseLocation,
} from "../lib/media/mediaLocationSafety.js";
import {
  toMediaProjection,
  MEDIA_PROJECTION_PROFILE_COLUMNS,
  type MediaCandidateRow,
} from "../lib/media/mediaProjection.js";
import {
  resolveViewer,
  buildWorldProjection,
  buildPlaceProjection,
  buildPeopleProjection,
  buildMyWorldProjection,
  buildTimelineProjection,
  buildMediaMapProjection,
  readCurrentState,
} from "../services/media/MediaProjectionService.js";
import { resolveExperience } from "../services/media/MediaExperienceResolver.js";
import {
  rankMediaCandidates,
  scoreMediaCandidate,
} from "../services/media/MediaRankingService.js";

// ── A capable, filtering fake Supabase client ────────────────────────────────

type Dataset = Record<string, any[]>;

function makeSc(data: Dataset) {
  const resolveRows = (table: string, filters: any[]): any[] => {
    let rows = (data[table] ?? []).map((r) => ({ ...r }));
    for (const f of filters) {
      if (f.op === "eq") rows = rows.filter((r) => String(r[f.col]) === String(f.val));
      else if (f.op === "in")
        rows = rows.filter((r) => (f.val as any[]).map(String).includes(String(r[f.col])));
      else if (f.op === "ilike") {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        rows = rows.filter((r) => String(r[f.col] ?? "").toLowerCase().includes(needle));
      } else if (f.op === "gt") rows = rows.filter((r) => r[f.col] != null && r[f.col] > f.val);
    }
    return rows;
  };

  const builder = (table: string): any => {
    const filters: any[] = [];
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push({ op: "eq", col, val }); return b; },
      in(col: string, val: any) { filters.push({ op: "in", col, val }); return b; },
      ilike(col: string, val: any) { filters.push({ op: "ilike", col, val }); return b; },
      gt(col: string, val: any) { filters.push({ op: "gt", col, val }); return b; },
      not() { return b; },
      // `.or(...)` conditions are not modeled; treated as a no-op (tests that
      // rely on OR keep the relevant table empty, so the no-op is safe).
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: resolveRows(table, filters), error: null }).then(onF, onR);
      },
    };
    return b;
  };

  return { from(table: string) { return builder(table); } } as any;
}

const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR_A = "22222222-2222-2222-2222-222222222222";
const AUTHOR_B = "33333333-3333-3333-3333-333333333333";
const PLACE_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const EVENT_1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("MediaRankingService — mutation-proof ranking signals", () => {
  const nowMs = Date.parse("2026-01-01T12:00:00.000Z");
  const row = (id: string, overrides: any = {}): any => ({
    id,
    author_id: AUTHOR_A,
    created_at: "2026-01-01T11:00:00.000Z",
    canonical_place_id: PLACE_1,
    category: "food",
    post_media: [{
      processing_status: "ready",
      moderation_status: "approved",
      public_url: `https://${id}.example/media`,
      width: 1200,
      height: 800,
    }],
    profiles: { id: AUTHOR_A, verified: false, is_official: false },
    ...overrides,
  });

  it("ranks authentic official material above generated/non-official material", () => {
    const authentic = row("authentic", { profiles: { id: AUTHOR_A, is_official: true, verified: false } });
    const generated = row("generated");
    const ranked = rankMediaCandidates([generated, authentic], { nowMs });
    assert.deepEqual(ranked.map((r) => r.id), ["authentic", "generated"]);
  });

  it("applies explicit intent and trip affinity without watch metrics", () => {
    const wanted = row("wanted", { trip_id: "trip-1" });
    const other = row("other", { trip_id: "trip-2" });
    const ranked = rankMediaCandidates([other, wanted], {
      nowMs,
      viewerTripIds: new Set(["trip-1"]),
      intentMediaIds: new Set(["wanted"]),
    });
    assert.equal(ranked[0].id, "wanted");
    assert.equal(scoreMediaCandidate(wanted, {
      nowMs,
      viewerTripIds: new Set(["trip-1"]),
      intentMediaIds: new Set(["wanted"]),
    }).intent, 1);
  });

  it("uses selected media metadata quality, not watch/completion fields", () => {
    const sized = row("sized");
    const unknown = row("unknown", {
      post_media: [{ processing_status: "ready", moderation_status: "approved", public_url: "https://x" }],
      watch_completion_rate: 1,
      view_count: 999999,
    });
    assert.ok(scoreMediaCandidate(sized, { nowMs }).quality > scoreMediaCandidate(unknown, { nowMs }).quality);
  });

  it("keeps exact ties stable and applies diversity penalties", () => {
    const a = row("a");
    const b = row("b");
    const c = row("c", { canonical_place_id: "place-2", category: "art" });
    assert.deepEqual(rankMediaCandidates([a, b], { nowMs }).map((r) => r.id), ["a", "b"]);
    const diverse = rankMediaCandidates([a, b, c], { nowMs });
    assert.equal(diverse[0].id, "a");
    assert.equal(diverse[1].id, "c");
  });

  /**
   * THE INVARIANT THAT LETS THIS RUN BEFORE THE PRIVACY CHOKE POINT.
   *
   * `rankAndProject` feeds the ranker RAW rows and then hands the result to
   * `projectCandidatesProtected`. That is only safe while the ranker is a pure
   * permutation: same rows, same objects, same count. If it ever filtered,
   * cloned or reshaped a row, it would be making a disclosure decision outside
   * the choke point.
   */
  it("is a pure permutation — same rows, same identities, nothing dropped or rewritten", () => {
    const rows = [
      row("r1"),
      row("r2", { canonical_place_id: "place-2" }),
      row("r3", { category: "art", trip_id: "trip-9" }),
      row("r4", { profiles: { id: AUTHOR_A, is_official: true } }),
    ];
    const snapshot = JSON.parse(JSON.stringify(rows));
    const ranked = rankMediaCandidates(rows, { nowMs, intentMediaIds: new Set(["r3"]) });
    assert.equal(ranked.length, rows.length);
    assert.deepEqual([...ranked].map((r) => r.id).sort(), ["r1", "r2", "r3", "r4"]);
    for (const r of ranked) assert.ok(rows.includes(r), "a ranked row must be the SAME object, not a copy");
    assert.deepEqual(rows, snapshot, "the ranker must not mutate the rows it is given");
  });

  it("scores missing signals neutrally rather than penalising them", () => {
    const bare: any = { id: "bare" };
    const score = scoreMediaCandidate(bare, { nowMs });
    assert.equal(score.provenance, 0.5, "an unknown contributor is neutral, not a penalty");
    assert.equal(score.quality, 0.5, "unknown dimensions are neutral, not a penalty");
    assert.equal(score.freshness, 0.5, "an unparseable created_at is neutral");
    assert.equal(score.intent, 0);
    assert.equal(score.tripAffinity, 0);
    assert.equal(rankMediaCandidates([bare], { nowMs }).length, 1);
  });
});

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

interface PostOverrides {
  id?: string;
  author_id?: string;
  visibility?: string;
  status?: string;
  post_status?: string | null;
  city?: string | null;
  placeId?: string | null;
  category?: string | null;
  createdAt?: string;
  ready?: boolean;
  withCoords?: boolean;
  mediaType?: "image" | "video";
  tripId?: string | null;
  /** `profiles.is_private` on the AUTHOR — input to the private-account guard. */
  authorIsPrivate?: boolean;
  /** §38 search fixtures: the free-text haystack fields. */
  content?: string;
  locationName?: string;
  username?: string;
}

let seq = 0;
function makePost(o: PostOverrides = {}): any {
  const id = o.id ?? `post-${++seq}`;
  const author = o.author_id ?? AUTHOR_A;
  const row: any = {
    id,
    author_id: author,
    trip_id: o.tripId ?? null,
    content: o.content ?? "",
    visibility: o.visibility ?? "public",
    status: o.status ?? "active",
    post_status: o.post_status === undefined ? "published" : o.post_status,
    moderation_status: null,
    publish_at: null,
    expires_at: null,
    created_at: o.createdAt ?? isoAgo(10 * 60 * 1000),
    category: o.category ?? "nightlife",
    media_urls: [],
    has_video: o.mediaType === "video",
    location_name: o.locationName ?? "An Thuong Bar",
    location_city: o.city ?? "Da Nang",
    location_country: "Vietnam",
    canonical_place_id: o.placeId === undefined ? PLACE_1 : o.placeId,
    post_media: [
      {
        id: `${id}-m1`,
        media_type: o.mediaType ?? "image",
        public_url: `https://cdn.example/${id}.jpg`,
        thumbnail_url: null,
        duration_seconds: null,
        width: 1080,
        height: 1080,
        sort_order: 0,
        processing_status: o.ready === false ? "processing" : "ready",
        moderation_status: null,
      },
    ],
    profiles: {
      id: author,
      username: o.username ?? "maya",
      full_name: "Maya",
      name: "Maya",
      display_name: "Maya",
      avatar_url: null,
      verified: true,
      is_official: false,
      account_status: "active",
      is_private: o.authorIsPrivate ?? false,
    },
  };
  // The posts table carries precise coordinates. The projection layer must
  // NEVER read them. We deliberately put them on the fixture rows so the
  // no-precise-location assertions are meaningful.
  if (o.withCoords !== false) {
    row.location_lat = 16.0544;
    row.location_lng = 108.2497;
  }
  return row;
}

/** Base dataset with the viewer profile present and everything else empty. */
function baseData(extra: Dataset = {}): Dataset {
  return {
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
    blocks: [],
    user_mutes: [],
    user_follows: [],
    trip_members: [],
    trips: [],
    feature_flags: [], // all flags off → live is fail-closed OFF
    ...extra,
  };
}

// ── 1. Detector is not vacuous ───────────────────────────────────────────────

describe("mediaLocationSafety — precise-location detector", () => {
  it("flags coordinate keys and passes coarse labels", () => {
    for (const k of ["lat", "lng", "latitude", "longitude", "location_lat", "location_lng", "coordinates", "geohash", "gps", "capture_lat"]) {
      assert.equal(isPreciseLocationKey(k), true, `${k} must be flagged`);
    }
    for (const k of ["city", "country", "neighborhood", "district", "placeLabel", "placeId", "label", "region", "name"]) {
      assert.equal(isPreciseLocationKey(k), false, `${k} must be allowed`);
    }
  });

  it("deep-scans nested structures and reports offending paths", () => {
    const leaky = { a: { b: [{ location_lat: 1, city: "X" }] }, ok: "fine" };
    const leaks = findPreciseLocation(leaky);
    assert.equal(leaks.length, 1);
    assert.match(leaks[0].path, /location_lat/);
    assert.equal(isLocationSafe({ city: "Da Nang", placeId: "x" }), true);
  });

  it("scrubPreciseLocation removes coordinate keys and counts them", () => {
    const { value, removed } = scrubPreciseLocation({ lat: 1, lng: 2, city: "Da Nang", nested: { longitude: 3, ok: 1 } });
    assert.equal(removed, 3);
    assert.equal(isLocationSafe(value), true);
    assert.equal((value as any).city, "Da Nang");
  });
});

// ── 2. Projector is coarse (mutation-proof) ──────────────────────────────────

describe("toMediaProjection — coarse, mutation-proof", () => {
  it("drops precise coordinates from a row that has them", () => {
    const row = makePost({ withCoords: true }) as MediaCandidateRow;
    // Sanity: the INPUT really does carry precise coordinates.
    assert.ok(findPreciseLocation(row).length > 0, "fixture row must carry coords for the test to mean anything");

    const projection = toMediaProjection(row, Date.now());
    assert.ok(projection, "projects a row with ready media");
    // THE mutation-proof assertion: a projector that copied location_lat/lng
    // would put a coordinate key here and this goes red.
    assert.equal(findPreciseLocation(projection).length, 0, "projection must carry NO precise location");
    // Coarse labels survive.
    assert.equal(projection!.placeId, PLACE_1);
    assert.equal(projection!.city, "Da Nang");
    assert.equal(projection!.freshness, "fresh"); // 10 min old
  });

  it("returns null when there is no renderable media", () => {
    const row = makePost({ ready: false }) as MediaCandidateRow;
    assert.equal(toMediaProjection(row, Date.now()), null);
  });
});

// ── 3./6. World projection: shape, empty, no coords ──────────────────────────

describe("GET /media/world projection", () => {
  it("empty data → well-formed empty projection", async () => {
    const sc = makeSc(baseData());
    const viewer = await resolveViewer(sc, VIEWER);
    const w = await buildWorldProjection(sc, viewer, "Da Nang", Date.now());
    assert.deepEqual(w.cityVisualState, []);
    assert.deepEqual(w.forYouNow, []);
    assert.deepEqual(w.changingNow, []);
    assert.equal(w.totalPerspectives, 0);
    assert.equal(isLocationSafe(w), true);
  });

  it("with media → for-you-now counts, zones, and NO precise location", async () => {
    const sc = makeSc(baseData({ posts: [makePost({ category: "nightlife" }), makePost({ category: "food" }), makePost({ category: "nightlife" })] }));
    const viewer = await resolveViewer(sc, VIEWER);
    const w = await buildWorldProjection(sc, viewer, "Da Nang", Date.now());
    assert.equal(w.totalPerspectives, 3);
    assert.ok(w.forYouNow.length >= 2, "at least nightlife + food buckets");
    const nightlife = w.forYouNow.find((b) => b.category === "nightlife");
    assert.equal(nightlife?.totalPerspectives, 2);
    // Zones exist and carry no live label when live is off (see next block too).
    assert.ok(w.cityVisualState.length >= 1);
    for (const z of w.cityVisualState) {
      assert.deepEqual(z.liveClaims, [], "no gated live claims → empty");
      assert.equal(z.liveCrowdLabel, null, "no fabricated crowd label");
    }
    assert.equal(w.changingNow.length, 0, "changing-now is empty without live claims");
    assert.equal(isLocationSafe(w), true);
  });
});

// ── 4. Anti-fabrication: stale/absent live yields no live label ───────────────

describe("no fabricated live state", () => {
  it("readCurrentState returns empty when the gated live path is off", async () => {
    const sc = makeSc(baseData());
    const cs = await readCurrentState(sc, PLACE_1, Date.now());
    assert.equal(cs.live, false);
    assert.deepEqual(cs.claims, []);
    assert.equal(cs.crowdLabel, null);
  });

  it("place projection has media but NO live/'busy now' label", async () => {
    const sc = makeSc(baseData({ posts: [makePost({ placeId: PLACE_1 }), makePost({ placeId: PLACE_1, category: "food" })], places: [{ id: PLACE_1, name: "An Thuong", city: "Da Nang", country: "Vietnam" }] }));
    const viewer = await resolveViewer(sc, VIEWER);
    const p = await buildPlaceProjection(sc, viewer, PLACE_1, Date.now());
    assert.equal(p.currentState.live, false, "no live state fabricated");
    assert.deepEqual(p.currentState.claims, []);
    assert.equal(p.currentState.crowdLabel, null);
    assert.ok(p.perspectives.totalPerspectives >= 2, "media still projected");
    assert.equal(isLocationSafe(p), true);
    // Belt-and-braces: the serialized response contains no live/busy wording
    // in any state field (the labels only exist inside gated live claims).
    const json = JSON.stringify(p);
    assert.doesNotMatch(json, /"(live|busy)":true/i);
  });
});

// ── 5. Eligibility: blocked + private excluded ───────────────────────────────

describe("viewer eligibility before projection", () => {
  it("excludes a blocked author's media", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ author_id: AUTHOR_A, id: "keep" }), makePost({ author_id: AUTHOR_B, id: "drop" })],
        blocks: [{ blocker_id: VIEWER, blocked_id: AUTHOR_B }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const w = await buildWorldProjection(sc, viewer, "Da Nang", Date.now());
    assert.equal(w.totalPerspectives, 1, "blocked author's post is dropped");
  });

  it("excludes a private post from the public world lens", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ visibility: "public", id: "pub" }), makePost({ visibility: "private", id: "priv" })],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const w = await buildWorldProjection(sc, viewer, "Da Nang", Date.now());
    assert.equal(w.totalPerspectives, 1, "private post excluded from for-you world");
  });
});

// ── 5b. The private-ACCOUNT guard at the shared candidate loader ─────────────
//
// Distinct from the private-POST case above. `visibility` is the post's own
// setting; `profiles.is_private` is the AUTHOR'S account setting, and the
// platform rule (lib/privacyFilter.excludePrivateAuthorPosts) is that a private
// account's posts are visible only to approved followers — whatever the post's
// own visibility says.
//
// filterEligibleMediaCandidates does not implement that rule and never has. Both
// LEGACY media feeds call excludePrivateAuthorPosts separately; every net-new
// Media v2 surface loads its candidates through loadEligibleCandidates, which
// did not. So a private account's visibility='public' post was projected —
// media, place label, and contributor credit — into the World shell, the
// experience/action rails and the Wall's Quick Media, while being correctly
// hidden by the two feeds it sat next to.
//
// These tests bite at the choke point: revert the guard in
// MediaProjectionService.loadEligibleCandidates and the first one goes red.

describe("private-ACCOUNT guard — applied at loadEligibleCandidates, not per caller", () => {
  it("a private account's PUBLIC post is not projected to a non-follower", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ id: "open", author_id: AUTHOR_A, visibility: "public", authorIsPrivate: false }),
          makePost({ id: "locked", author_id: AUTHOR_B, visibility: "public", authorIsPrivate: true }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const w = await buildWorldProjection(sc, viewer, "Da Nang", Date.now());
    assert.equal(
      w.totalPerspectives,
      1,
      "only the public account's post may be projected; a private account's post " +
        "is for approved followers, whatever its own visibility says",
    );
  });

  it("an approved follower still sees it — the guard is not a blanket exclusion", async () => {
    // Positive control: without it, a loader that returned [] unconditionally
    // would satisfy the test above.
    const sc = makeSc(
      baseData({
        posts: [makePost({ id: "locked", author_id: AUTHOR_B, visibility: "public", authorIsPrivate: true })],
        user_follows: [{ follower_id: VIEWER, following_id: AUTHOR_B }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const w = await buildWorldProjection(sc, viewer, "Da Nang", Date.now());
    assert.equal(w.totalPerspectives, 1, "an approved follower must still be projected the item");
  });

  it("a public account's post is untouched", async () => {
    // Second positive control: proves the guard keys on is_private rather than
    // having become "drop everything".
    const sc = makeSc(
      baseData({ posts: [makePost({ id: "open", author_id: AUTHOR_A, authorIsPrivate: false })] }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const w = await buildWorldProjection(sc, viewer, "Da Nang", Date.now());
    assert.equal(w.totalPerspectives, 1);
  });

  it("My World still returns the owner's own media when the OWNER is private", async () => {
    // The guard must never hide a user's library from themselves. buildMyWorldProjection
    // reads the owner's rows directly (`author_id = viewer`) rather than through
    // loadEligibleCandidates, so this is a REGRESSION guard: it pins that the
    // private-account rule stays a non-owner rule, and would catch a future
    // refactor routing My World through the choke point with an owner-blind guard.
    const sc = makeSc(
      baseData({
        posts: [makePost({ id: "mine", author_id: VIEWER, visibility: "public", authorIsPrivate: true })],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const me = await buildMyWorldProjection(sc, viewer, Date.now());
    const ownIds = me.buckets.flatMap((b) => b.media.map((m) => m.id));
    assert.ok(
      ownIds.includes("mine"),
      `the owner must still see their own media in My World; buckets held ${JSON.stringify(ownIds)}`,
    );
  });

  it("the profiles SELECT carries is_private — the guard's input, not a display field", () => {
    // The fake client above hands back whole fixture objects, so it cannot
    // notice a column missing from the SELECT string. In production the guard
    // reads `row.profiles.is_private` through `{ profilesKey: "profiles" }`, and
    // excludePrivateAuthorPosts is FAIL-OPEN on a missing value: drop the column
    // from the projection SELECT and every private account silently reads as
    // public again, with the guard still sitting there looking correct.
    const cols = MEDIA_PROJECTION_PROFILE_COLUMNS.split(",").map((c) => c.trim());
    assert.ok(
      cols.includes("is_private"),
      "loadEligibleCandidates' private-account guard reads profiles.is_private; " +
        "without it in the SELECT the guard is fail-open and inert",
    );
  });

  it("is_private is NOT projected onto the contributor credit", () => {
    // It is a gate input. Reading it must not turn it into an output field.
    const row = makePost({ id: "shape", author_id: AUTHOR_A, authorIsPrivate: true });
    const projection = toMediaProjection(row as MediaCandidateRow, Date.now());
    assert.equal(
      JSON.stringify(projection).includes("is_private"),
      false,
      "the account-privacy flag must not leave the server on a projection",
    );
    assert.equal(
      JSON.stringify(projection).includes("isPrivate"),
      false,
      "the account-privacy flag must not leave the server on a projection",
    );
  });
});

// ── People / My World / Timeline / Map shapes ────────────────────────────────

describe("GET /media/people projection", () => {
  it("groups followed authors' media, no coords", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ author_id: AUTHOR_A }), makePost({ author_id: AUTHOR_A })],
        user_follows: [{ follower_id: VIEWER, following_id: AUTHOR_A }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.equal(p.people.length, 1);
    assert.equal(p.people[0].perspectiveCount, 2);
    assert.equal(isLocationSafe(p), true);
  });

  it("empty follow graph → empty people projection", async () => {
    const sc = makeSc(baseData({ posts: [makePost({ author_id: AUTHOR_A })] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.deepEqual(p.people, []);
    assert.equal(p.totalPerspectives, 0);
  });
});

describe("GET /media/me projection", () => {
  it("owner library buckets incl owner-only, no coords", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ author_id: VIEWER, id: "pub", post_status: "published" }),
          makePost({ author_id: VIEWER, id: "draft", post_status: "draft" }),
          makePost({ author_id: VIEWER, id: "proc", ready: false }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const me = await buildMyWorldProjection(sc, viewer, Date.now());
    const keys = me.buckets.map((b) => b.key);
    for (const k of ["all", "posts", "trips", "drafts", "archived", "processing", "postcards", "memories", "tagged", "gems"]) {
      assert.ok(keys.includes(k), `bucket ${k} present`);
    }
    const drafts = me.buckets.find((b) => b.key === "drafts");
    assert.equal(drafts?.ownerOnly, true);
    assert.equal(drafts?.count, 1);
    const processing = me.buckets.find((b) => b.key === "processing");
    assert.equal(processing?.count, 1);
    assert.equal(isLocationSafe(me), true);
  });
});

describe("GET /media/timeline projection", () => {
  it("rails observed-only, forecast never fabricated, no coords", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ author_id: AUTHOR_A, createdAt: isoAgo(5 * 60 * 1000) }), // now
          makePost({ author_id: AUTHOR_A, createdAt: isoAgo(5 * 60 * 60 * 1000) }), // earlier
          makePost({ author_id: AUTHOR_A, createdAt: isoAgo(50 * 60 * 60 * 1000) }), // historical
        ],
        user_follows: [{ follower_id: VIEWER, following_id: AUTHOR_A }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const t = await buildTimelineProjection(sc, viewer, { placeId: null, nowMs: Date.now() });
    assert.equal(t.forecastAvailable, false, "forecast must never be fabricated from media");
    const byKey = Object.fromEntries(t.rails.map((r) => [r.key, r.count]));
    assert.equal(byKey.now, 1);
    assert.equal(byKey.earlier, 1);
    assert.equal(byKey.historical, 1);
    assert.equal(isLocationSafe(t), true);
  });
});

describe("GET /media/map projection", () => {
  it("clusters keyed by placeId carry counts but NO geometry/coords", async () => {
    const sc = makeSc(baseData({ posts: [makePost({ placeId: PLACE_1 }), makePost({ placeId: PLACE_1 })] }));
    const viewer = await resolveViewer(sc, VIEWER);
    const m = await buildMediaMapProjection(sc, viewer, "Da Nang", Date.now());
    assert.equal(m.clusters.length, 1);
    assert.equal(m.clusters[0].placeId, PLACE_1);
    assert.equal(m.clusters[0].perspectiveCount, 2);
    assert.equal(isLocationSafe(m), true, "no coordinates emitted by the media map");
  });
});

// ── Experience resolver: private event excluded ──────────────────────────────

describe("GET /media/experiences/:id resolver", () => {
  it("private event the viewer cannot see → null (excluded)", async () => {
    const sc = makeSc(
      baseData({
        events: [{ id: EVENT_1, title: "Secret", visibility: "invite_only", host_id: AUTHOR_B, place_id: "x" }],
        event_rsvps: [],
        event_roles: [],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const exp = await resolveExperience(sc, viewer, EVENT_1, Date.now());
    assert.equal(exp, null, "private event excluded for a non-participant");
  });

  it("public event → resolved projection with no coords", async () => {
    const sc = makeSc(
      baseData({
        events: [{ id: EVENT_1, title: "Beach Festival", visibility: "public", host_id: AUTHOR_A, place_id: "not-a-uuid" }],
        post_event_links: [{ post_id: "linked", event_id: EVENT_1 }],
        posts: [makePost({ id: "linked", author_id: AUTHOR_A })],
        feature_flags: [],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const exp = await resolveExperience(sc, viewer, EVENT_1, Date.now());
    assert.ok(exp, "public event resolves");
    assert.equal(exp!.kind, "event");
    assert.equal(exp!.title, "Beach Festival");
    assert.equal(exp!.currentState.live, false, "no fabricated live for the experience");
    assert.equal(isLocationSafe(exp), true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §38 SEARCH — census-media MD349 (MediaSearchService) / MD367 (GET /media/search)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Both rows read **N** on "absent": *"No `MediaSearchScreen`, no `mediaSearch`
 * service, no `/media/search` route"* (MD27/MD324/MD349/MD367). The server half
 * is what these tests cover — the client half stays unbuilt and the census rows
 * for it stay N.
 *
 * THE POINT OF THESE TESTS IS THAT SEARCH IS NOT A SECOND READ PATH.
 * A search endpoint is the classic way a privacy gate gets forked: someone
 * writes a new query against `posts`, and blocks / mutes / private accounts /
 * moderation / gem ceilings are re-implemented or forgotten. So the assertions
 * below are mostly NEGATIVE — a blocked author, a private account, an
 * unprojectable coordinate and an undisclosable hidden gem must each be absent
 * from results — and they pass only because the service goes through
 * `loadEligibleCandidates` + `projectCandidatesProtected`, the same two choke
 * points every other §43 surface uses.
 *
 * WHAT THESE TESTS DO NOT CLAIM. There is no visual-similarity search here
 * ("Find places that look like this"), and text recall is bounded by the shared
 * candidate loader's page. Both are stated in the service header and in the
 * census rows; neither is papered over by a test.
 */
import {
  searchMedia,
  MEDIA_SEARCH_UNSUPPORTED,
  type MediaSearchResults,
} from "../services/media/MediaSearchService.js";

const GEM_PLACE = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const MEDIA_ID_1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

describe("MD349 — MediaSearchService: text recall", () => {
  it("matches free text in the caption and excludes what does not match", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ id: "p-roof", content: "sunset from the rooftop bar" }),
          makePost({ id: "p-beach", content: "a quiet morning on the sand" }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r: MediaSearchResults = await searchMedia(sc, viewer, { q: "rooftop" }, Date.now());
    assert.deepEqual(r.media.map((m) => m.id), ["p-roof"]);
  });

  it("matches the venue label too — 'Show my Bangkok rooftop photos' is a place word plus a caption word", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ id: "p1", locationName: "Vertigo Rooftop", content: "" }),
          makePost({ id: "p2", locationName: "An Thuong Bar", content: "" }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { q: "rooftop" }, Date.now());
    assert.deepEqual(r.media.map((m) => m.id), ["p1"]);
  });

  it("a search with NO criteria returns nothing — it must not dump the feed", async () => {
    const sc = makeSc(baseData({ posts: [makePost({ id: "p1" }), makePost({ id: "p2" })] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, {}, Date.now());
    assert.deepEqual(r.criteriaUsed, []);
    assert.equal(r.media.length, 0);
    assert.equal(r.places.length, 0);
    assert.equal(r.people.length, 0);
  });

  it("scope=me returns only the viewer's own media", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ id: "mine", author_id: VIEWER, content: "rooftop" }),
          makePost({ id: "theirs", author_id: AUTHOR_B, content: "rooftop" }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { q: "rooftop", scope: "me" }, Date.now());
    assert.deepEqual(r.media.map((m) => m.id), ["mine"]);
  });

  it("category narrows — 'Nightlife that looks social tonight' is a category plus freshness", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ id: "night", category: "nightlife", createdAt: isoAgo(5 * 60 * 1000) }),
          makePost({ id: "food", category: "food", createdAt: isoAgo(5 * 60 * 1000) }),
          makePost({ id: "old-night", category: "nightlife", createdAt: isoAgo(10 * 60 * 60 * 1000) }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { category: "nightlife", freshOnly: true }, Date.now());
    assert.deepEqual(r.media.map((m) => m.id), ["night"]);
  });
});

describe("MD349 — search is NOT a second read path: every gate still binds", () => {
  it("a PRIVATE account's public post never appears in results", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ id: "open", content: "rooftop" }),
          makePost({ id: "hidden", author_id: AUTHOR_B, content: "rooftop", authorIsPrivate: true }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { q: "rooftop" }, Date.now());
    assert.deepEqual(r.media.map((m) => m.id), ["open"], "the private-account guard must bind on search too");
    assert.equal(r.people.some((p) => p.id === AUTHOR_B), false, "nor may they surface as a person result");
  });

  it("a BLOCKED author's post never appears in results", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ id: "open" , content: "rooftop"}), makePost({ id: "blocked", author_id: AUTHOR_B, content: "rooftop" })],
        blocks: [{ blocker_id: VIEWER, blocked_id: AUTHOR_B }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { q: "rooftop" }, Date.now());
    assert.deepEqual(r.media.map((m) => m.id), ["open"]);
  });

  it("no precise location leaves a search response, on any result kind", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ id: "p1", content: "rooftop", withCoords: true })],
        places: [{ id: PLACE_1, name: "An Thuong Bar", city: "Da Nang", country_code: "VN", neighborhood: null }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { q: "rooftop" }, Date.now());
    assert.ok(r.media.length > 0, "the fixture must actually return a result, or the leak check is vacuous");
    assert.ok(r.places.length > 0, "and a place result, which is where a coordinate would ride");
    assert.equal(findPreciseLocation(r).length, 0, "a search result carried a coordinate");
    assert.equal(isLocationSafe(r), true);
  });
});

describe("MD294 — the result kinds this search actually produces", () => {
  it("places are distinct canonical places with a perspective count", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ id: "p1", content: "rooftop", placeId: PLACE_1 }),
          makePost({ id: "p2", content: "rooftop", placeId: PLACE_1 }),
          makePost({ id: "p3", content: "rooftop", placeId: GEM_PLACE }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { q: "rooftop" }, Date.now());
    const ids = r.places.map((p) => p.placeId).sort();
    assert.deepEqual(ids, [GEM_PLACE, PLACE_1].sort());
    const first = r.places.find((p) => p.placeId === PLACE_1)!;
    assert.equal(first.perspectiveCount, 2, "two perspectives at one place is one place result");
  });

  it("people are distinct contributors, deduplicated", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ id: "p1", content: "rooftop", author_id: AUTHOR_A }),
          makePost({ id: "p2", content: "rooftop", author_id: AUTHOR_A }),
          makePost({ id: "p3", content: "rooftop", author_id: AUTHOR_B, username: "kai" }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { q: "rooftop" }, Date.now());
    assert.deepEqual(r.people.map((p) => p.id).sort(), [AUTHOR_A, AUTHOR_B].sort());
    assert.equal(r.people.find((p) => p.id === AUTHOR_A)!.perspectiveCount, 2);
  });

  it("a hidden gem result appears ONLY for a gem the viewer may be told exists", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ id: "p1", content: "beach", placeId: GEM_PLACE })],
        hidden_gems: [
          {
            id: "gem-open",
            canonical_place_id: GEM_PLACE,
            name: "Secret Cove",
            status: "active",
            sensitivity_level: "public",
            submitted_by: AUTHOR_B,
          },
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { q: "beach" }, Date.now());
    assert.deepEqual(r.hiddenGems.map((g) => g.gemId), ["gem-open"]);
  });

  /**
   * A PROTECTED gem never reaches `mayDiscloseGemIdentity` at all: the location
   * choke point upstream (loadRestrictiveGems → disclosureForRow) withholds the
   * place id itself, so the gem lookup is handed no place to look under. That is
   * a real second defence and it is asserted below — but it means the protected
   * case does NOT exercise the gem predicate. The ARCHIVED case after it does:
   * `archived` is not in LIVE_GEM_STATUSES so the gem is not restrictive and the
   * place stays disclosable, while `mayDiscloseGemIdentity` still refuses to name
   * a non-active gem. Removing the predicate leaves the protected test green and
   * turns the archived one red, which is why both are here.
   */
  it("a PROTECTED hidden gem yields no gem result — not its id, not its name", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ id: "p1", content: "beach", placeId: GEM_PLACE })],
        hidden_gems: [
          {
            id: "gem-secret",
            canonical_place_id: GEM_PLACE,
            name: "Truly Secret Cove",
            status: "active",
            sensitivity_level: "protected",
            submitted_by: AUTHOR_B,
          },
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { q: "beach" }, Date.now());
    assert.deepEqual(r.hiddenGems, []);
    assert.equal(JSON.stringify(r).includes("Truly Secret Cove"), false);
    assert.equal(JSON.stringify(r).includes("gem-secret"), false);
  });

  it("an ARCHIVED but public gem is not named, even though its place stays disclosable", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ id: "p1", content: "beach", placeId: GEM_PLACE })],
        hidden_gems: [
          {
            id: "gem-archived",
            canonical_place_id: GEM_PLACE,
            name: "Closed Cove",
            status: "archived",
            sensitivity_level: "public",
            submitted_by: AUTHOR_B,
          },
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { q: "beach" }, Date.now());
    assert.deepEqual(
      r.places.map((p) => p.placeId),
      [GEM_PLACE],
      "the place must still be disclosable, or this case does not reach the gem predicate",
    );
    assert.deepEqual(r.hiddenGems, [], "mayDiscloseGemIdentity refuses a non-active gem");
    assert.equal(JSON.stringify(r).includes("Closed Cove"), false);
  });

  it("the unsupported list names what this search cannot do, rather than implying it can", () => {
    assert.ok(MEDIA_SEARCH_UNSUPPORTED.length > 0);
    assert.ok(
      MEDIA_SEARCH_UNSUPPORTED.some((u) => /visual/i.test(u)),
      "visual similarity is absent and must say so",
    );
  });
});

describe("MD291 — 'Where was this photo taken?' resolves a media id to its coarse place", () => {
  it("returns the place for a media the viewer may see", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ id: MEDIA_ID_1, placeId: PLACE_1 })],
        places: [{ id: PLACE_1, name: "An Thuong Bar", city: "Da Nang", country_code: "VN", neighborhood: null }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { mediaId: MEDIA_ID_1 }, Date.now());
    assert.deepEqual(r.places.map((p) => p.placeId), [PLACE_1]);
    assert.deepEqual(r.media.map((m) => m.id), [MEDIA_ID_1]);
    assert.equal(findPreciseLocation(r).length, 0, "answering 'where' must stay coarse");
  });

  it("returns nothing for a media the viewer may NOT see", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ id: MEDIA_ID_1, author_id: AUTHOR_B, placeId: PLACE_1 })],
        blocks: [{ blocker_id: VIEWER, blocked_id: AUTHOR_B }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const r = await searchMedia(sc, viewer, { mediaId: MEDIA_ID_1 }, Date.now());
    assert.deepEqual(r.media, []);
    assert.deepEqual(r.places, []);
  });
});

// ── MD367: the endpoint is REGISTERED, auth-gated, and not shadowed ──────────
/**
 * A service nobody can call is not a build. These three assertions are the
 * cheapest complete proof that `GET /media/search` is reachable:
 *
 *   1. It answers 401/403 rather than 404 — an unregistered path 404s, so this
 *      distinguishes "the route exists" from "the file exists".
 *   2. A path that really is unregistered still 404s, so (1) is not vacuous.
 *   3. `routes/index.ts` mounts mediaWorldRouter BEFORE mediaFeedRouter. That
 *      ordering is the whole reason `/media/search` is not swallowed by
 *      mediaFeed's `/media/:id`, and it is one line away from silently
 *      regressing into "search returns the media item whose id is 'search'".
 */
describe("MD367 — GET /media/search is a reachable, auth-gated endpoint", () => {
  it("is registered (401/403, not 404) and an unregistered sibling still 404s", async () => {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { default: mediaWorldRouter } = await import("../routes/mediaWorld.js");
    const app = express();
    app.use((req: any, _res: any, next: any) => {
      req.log = { info() {}, error() {}, warn() {}, debug() {} };
      next();
    });
    app.use("/api", mediaWorldRouter);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    try {
      const hit = await fetch(`http://127.0.0.1:${port}/api/media/search?q=rooftop`);
      assert.notEqual(hit.status, 404, "GET /media/search must be registered on the media world router");
      assert.ok(
        hit.status === 401 || hit.status === 403,
        `search must refuse an unauthenticated caller; got ${hit.status}`,
      );
      const miss = await fetch(`http://127.0.0.1:${port}/api/media/definitely-not-a-route`);
      assert.equal(miss.status, 404, "the 404 control must really 404, or assertion 1 proves nothing");
    } finally {
      server.close();
    }
  });

  it("routes/index.ts mounts the world router BEFORE the feed router", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const code = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "routes", "index.ts"),
      "utf8",
    );
    const world = code.indexOf("router.use(mediaWorldRouter)");
    const feed = code.indexOf("router.use(mediaFeedRouter)");
    assert.ok(world >= 0 && feed >= 0, "both routers must still be mounted");
    assert.ok(
      world < feed,
      "mediaWorldRouter must mount first, or mediaFeed's /media/:id swallows /media/search",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §23.1 EXPERIENCE CHAINS — census-media MD171
// ═════════════════════════════════════════════════════════════════════════════
/**
 * MD171 read **N**: *"No chain type, no ordered multi-place experience anywhere
 * in `services/media/`. `MediaExperienceProjection` carries `placeIds: string[]`
 * with no ordering semantics and no traversal."* Both halves were true —
 * `placeIds` came out of a `Set` over the projected media, which is insertion
 * order over a created_at-descending page, i.e. no order at all.
 *
 * THE ORDER IS OBSERVED, NOT ASSERTED. "Dinner → Rooftop → Nightclub" is a claim
 * about a sequence, and the only honest evidence Media holds for one is WHEN
 * each place was photographed. So a chain stop's position is the FIRST observed
 * perspective at that place inside the experience, and `derivedFrom` says so on
 * the object. Nothing here infers a route, a traveller's path, or an intention:
 * a place with no perspective is not a stop, and one place is not a chain.
 */
describe("MD171 — an experience carries an ORDERED chain derived from observed capture times", () => {
  const P_A = "11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const P_B = "22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const P_C = "33333333-cccc-cccc-cccc-cccccccccccc";
  const TRIP_C = "44444444-dddd-dddd-dddd-dddddddddddd";

  function chainData(): Dataset {
    return baseData({
      trips: [{ id: TRIP_C, owner_id: VIEWER, visibility: "public", title: "Friday night", start_date: null, end_date: null }],
      posts: [
        // Deliberately inserted NEWEST-first, the order the loader returns, so an
        // implementation that just kept insertion order would emit C → B → A.
        makePost({ id: "c1", placeId: P_C, locationName: "Nightclub", tripId: TRIP_C, createdAt: isoAgo(30 * 60 * 1000) }),
        makePost({ id: "b1", placeId: P_B, locationName: "Rooftop", tripId: TRIP_C, createdAt: isoAgo(90 * 60 * 1000) }),
        makePost({ id: "a1", placeId: P_A, locationName: "Dinner", tripId: TRIP_C, createdAt: isoAgo(180 * 60 * 1000) }),
        makePost({ id: "a2", placeId: P_A, locationName: "Dinner", tripId: TRIP_C, createdAt: isoAgo(170 * 60 * 1000) }),
      ],
    });
  }

  it("orders the stops by first observed perspective — Dinner → Rooftop → Nightclub", async () => {
    const sc = makeSc(chainData());
    const viewer = await resolveViewer(sc, VIEWER);
    const exp = await resolveExperience(sc, viewer, TRIP_C, Date.now());
    assert.ok(exp, "the trip experience resolves");
    assert.deepEqual(exp!.chain.stops.map((s) => s.placeId), [P_A, P_B, P_C]);
    assert.deepEqual(exp!.chain.stops.map((s) => s.label), ["Dinner", "Rooftop", "Nightclub"]);
    assert.equal(exp!.chain.isChain, true);
    assert.equal(exp!.chain.derivedFrom, "observed_capture_times");
  });

  it("a place with several perspectives is ONE stop, positioned by its FIRST", async () => {
    // The order key must be the FIRST perspective, not the last. Dinner is shot
    // at −180m and again at −20m (the party came back); Rooftop only at −90m. By
    // first-perspective the night is Dinner → Rooftop; by LAST it would invert,
    // so this fixture is what makes the choice of key load-bearing.
    const sc = makeSc(
      baseData({
        trips: [{ id: TRIP_C, owner_id: VIEWER, visibility: "public", title: "Returned to dinner" }],
        posts: [
          makePost({ id: "a1", placeId: P_A, locationName: "Dinner", tripId: TRIP_C, createdAt: isoAgo(180 * 60 * 1000) }),
          makePost({ id: "b1", placeId: P_B, locationName: "Rooftop", tripId: TRIP_C, createdAt: isoAgo(90 * 60 * 1000) }),
          makePost({ id: "a2", placeId: P_A, locationName: "Dinner", tripId: TRIP_C, createdAt: isoAgo(20 * 60 * 1000) }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const exp = await resolveExperience(sc, viewer, TRIP_C, Date.now());
    assert.deepEqual(exp!.chain.stops.map((st) => st.placeId), [P_A, P_B], "ordered by FIRST perspective");
    const first = exp!.chain.stops[0];
    assert.equal(first.perspectiveCount, 2);
    assert.ok(
      Date.parse(first.firstPerspectiveAt) < Date.parse(first.lastPerspectiveAt),
      "a stop spanning two captures must report a real span, not the same instant twice",
    );
  });

  it("ONE place is not a chain", async () => {
    const sc = makeSc(
      baseData({
        trips: [{ id: TRIP_C, owner_id: VIEWER, visibility: "public", title: "One stop" }],
        posts: [makePost({ id: "only", placeId: P_A, tripId: TRIP_C })],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const exp = await resolveExperience(sc, viewer, TRIP_C, Date.now());
    assert.equal(exp!.chain.stops.length, 1);
    assert.equal(exp!.chain.isChain, false, "a single place is a place, not a night");
  });

  it("an experience with no perspectives has an empty chain, not a fabricated one", async () => {
    const sc = makeSc(
      baseData({ trips: [{ id: TRIP_C, owner_id: VIEWER, visibility: "public", title: "Nothing yet" }], posts: [] }),
    );
    const viewer = await resolveViewer(sc, VIEWER);
    const exp = await resolveExperience(sc, viewer, TRIP_C, Date.now());
    assert.deepEqual(exp!.chain.stops, []);
    assert.equal(exp!.chain.isChain, false);
    assert.equal(exp!.chain.startedAt, null);
  });

  it("a chain carries no coordinate", async () => {
    const sc = makeSc(chainData());
    const viewer = await resolveViewer(sc, VIEWER);
    const exp = await resolveExperience(sc, viewer, TRIP_C, Date.now());
    assert.equal(findPreciseLocation(exp!.chain).length, 0);
  });

  it("a place the disclosure choke point withheld is not a chain stop", async () => {
    // A protected hidden gem at P_B: the place id is withheld from the
    // projection, so the chain must skip it rather than name it as a stop.
    const sc = makeSc({
      ...chainData(),
      hidden_gems: [
        {
          id: "gem-x",
          canonical_place_id: P_B,
          name: "Secret Rooftop",
          status: "active",
          sensitivity_level: "protected",
          submitted_by: AUTHOR_B,
        },
      ],
    });
    const viewer = await resolveViewer(sc, VIEWER);
    const exp = await resolveExperience(sc, viewer, TRIP_C, Date.now());
    assert.equal(exp!.chain.stops.some((s) => s.placeId === P_B), false);
    assert.equal(JSON.stringify(exp!.chain).includes("Secret Rooftop"), false);
    // And the withheld item must not become an ANONYMOUS stop either: a chain
    // entry whose placeId is null/empty is a stop nobody can navigate to, and it
    // still tells the reader "there was another place on this night".
    for (const st of exp!.chain.stops) {
      assert.equal(typeof st.placeId, "string", "every chain stop must carry a real canonical place id");
      assert.ok(st.placeId.length > 0);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A FAILED CANDIDATE READ IS NOT AN EMPTY WORLD
// ═════════════════════════════════════════════════════════════════════════════
/**
 * `loadEligibleCandidates` is the shared candidate source for EVERY §43 surface
 * — all six World-shell builders, the experience resolver and §38 search — and
 * its own docstring promised the defect: *"Returns the eligible raw rows … or []
 * on any failure / empty result."*
 *
 * supabase-js RESOLVES on a database error. `{ data: null, error: {...} }` and
 * `{ data: [], error: null }` are two different facts that both became `[]`, so
 * an unreadable `posts` table was served to the client as a 200 carrying a
 * well-formed, confident, EMPTY world. "There is no media anywhere near you" is
 * a claim, and it was being assembled out of a query that did not answer.
 *
 * The router's stated invariant — *"Empty data yields a well-formed empty
 * projection, never an error (pre-launch = empty is normal)"* — is correct for
 * emptiness and was being applied to unreadability. These tests hold BOTH
 * halves: a healthy-but-empty read must still be a 200 empty projection, and an
 * unreadable read must be a retryable 503.
 *
 * VACUITY TRAPS AVOIDED, deliberately, both of which produce false green here:
 *   1. Never a bare `assert.notEqual(status, 200)` — a fixture that fails auth
 *      or validation never reaches the loader and would satisfy it. Every case
 *      names the exact envelope code, and each is paired with a HEALTHY control
 *      that must still be 200 on the same fixture and the same token.
 *   2. The `req.log` shim and `globalErrorHandler` the real server installs are
 *      both present. Without the shim these handlers crash and a 500-from-crash
 *      masquerades as a refusal; without the handler a thrown refusal becomes
 *      Express's default HTML 500 and the envelope is never exercised.
 */
describe("a failed candidate read refuses; an empty one does not", () => {
  const TOKEN = "tok-media-viewer";
  const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };
  /** Seeded and visible — the experience the refusal case resolves. */
  const EXPERIENCE_TRIP = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  /** Never seeded — the experience the control case legitimately cannot find. */
  const ABSENT_EXPERIENCE = "cccccccc-cccc-cccc-cccc-cccccccccc99";

  function spec(failPosts: boolean) {
    return {
      users: { [TOKEN]: VIEWER },
      rows: {
        profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
        posts: [] as any[],
        // A REAL, viewer-visible trip. Without it `resolveTrip` returns null at
        // "no such trip" and never reaches the hero-media `posts` read, so the
        // experience case below would be asserting against a code path the
        // request never enters.
        trips: [{ id: EXPERIENCE_TRIP, title: "Vietnam", visibility: "public", owner_id: AUTHOR_A }],
        blocks: [], user_mutes: [], trip_members: [], feature_flags: [],
        // The viewer FOLLOWS someone on purpose. `loadEligibleCandidatesOrRefuse`
        // short-circuits a `following` feed with an empty follow graph BEFORE it
        // reads `posts` — correctly, since there is provably nothing to fetch —
        // so with no follows the People lens answers 200-empty having attempted
        // no read at all, and asserting 503 there would be asserting a refusal
        // for a read that never happened.
        user_follows: [{ follower_id: VIEWER, following_id: AUTHOR_A }],
      },
      failOn: (ctx: any) => (failPosts && ctx.table === "posts" ? READ_FAIL : null),
    };
  }

  async function withServer<T>(failPosts: boolean, run: (base: string) => Promise<T>): Promise<T> {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { default: mediaWorldRouter } = await import("../routes/mediaWorld.js");
    const { globalErrorHandler } = await import("../lib/errorEnvelope.js");
    const { _setTestClient, _setTestServiceClient } = await import("../lib/http.js");
    const { makeFailClosedClient, noopLog } = await import("./helpers/failClosedSupabase.js");

    const client = makeFailClosedClient(spec(failPosts) as any);
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const app = express();
    app.use((req: any, _res: any, next: any) => { req.log = noopLog; next(); });
    app.use("/api", mediaWorldRouter);
    app.use(globalErrorHandler);
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    try {
      return await run(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
      _setTestClient(null, false);
      _setTestServiceClient(null);
    }
  }

  const get = (base: string, path: string) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(async (r) => ({
      status: r.status,
      body: (await r.json().catch(() => null)) as unknown,
    }));

  /**
   * Read the parsed body, ASSERTING it was JSON at all.
   *
   * `r.json()` is typed `Promise<unknown>`, so `r.body.error` does not compile —
   * and the tempting fixes are the two this repository's test-typecheck gate
   * exists to stop: `any`, or a `.catch(() => ({}))` that makes "the body was
   * not JSON" indistinguishable from "the body was an empty object". A refusal
   * test whose whole subject is the envelope must not silently accept a
   * response that carried no envelope.
   *
   * So the narrowing is a real runtime check with its own failure message, and
   * the cast below is to a structural record rather than to `any`.
   */
  const body = (r: { status: number; body: unknown }): Record<string, unknown> => {
    assert.ok(
      r.body !== null && typeof r.body === "object",
      `the response carried no JSON body to assert on (status ${r.status})`,
    );
    return r.body as Record<string, unknown>;
  };

  it("CONTROL — a healthy but EMPTY posts table is still a 200 empty projection", async () => {
    await withServer(false, async (base) => {
      const r = await get(base, "/api/media/world");
      assert.equal(r.status, 200, `pre-launch emptiness must stay a 200; got ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(body(r).totalPerspectives, 0);
      assert.deepEqual(body(r).cityVisualState, []);
    });
  });

  it("GET /media/world refuses with a retryable 503 when the candidate read fails", async () => {
    await withServer(true, async (base) => {
      const r = await get(base, "/api/media/world");
      assert.equal(r.status, 503, `an unreadable posts table must not be served as an empty world; got ${r.status}`);
      assert.equal(body(r).error, "degraded_unavailable");
      assert.equal(body(r).retryable, true);
    });
  });

  it("the refusal binds on the other §43 read surfaces too, not just /world", async () => {
    await withServer(true, async (base) => {
      for (const path of ["/api/media/people", "/api/media/me", "/api/media/timeline", "/api/media/search?q=rooftop"]) {
        const r = await get(base, path);
        assert.equal(r.status, 503, `${path} served an unreadable posts table as a settled answer (${r.status})`);
        assert.equal(body(r).error, "degraded_unavailable", `${path} envelope`);
      }
    });
  });

  it("GET /media/experiences/:id refuses instead of answering available:false", async () => {
    // The worst-shaped instance of this defect: `resolveExperience` returned
    // null on a refused read and the route renders null as a 200 carrying
    // `available: false`, which reads as an AUTHORIZATION outcome ("not visible
    // to you") rather than an outage. A client cannot distinguish it from a
    // genuinely private trip and will not retry.
    await withServer(true, async (base) => {
      const r = await get(base, `/api/media/experiences/${EXPERIENCE_TRIP}`);
      assert.notEqual(
        r.status, 200,
        `a refused read must not be served as an availability verdict; got 200 ${JSON.stringify(r.body)}`,
      );
      assert.equal(r.status, 503);
      assert.equal(body(r).error, "degraded_unavailable");
      assert.equal(body(r).retryable, true);
    });
  });

  it("CONTROL — a genuinely absent experience still answers 200 available:false", async () => {
    // Without this the case above would also pass if the route had started
    // refusing every experience request, which is a different bug.
    await withServer(false, async (base) => {
      const r = await get(base, `/api/media/experiences/${ABSENT_EXPERIENCE}`);
      assert.equal(r.status, 200, `absence is not an outage; got ${r.status}`);
      assert.equal(body(r).available, false);
    });
  });

  it("buildWorldProjection REFUSES rather than returning a confident empty projection", async () => {
    const { makeFailClosedClient } = await import("./helpers/failClosedSupabase.js");
    const client = makeFailClosedClient(spec(true) as any);
    const viewer = await resolveViewer(client, VIEWER, { needFollows: false });
    await assert.rejects(
      () => buildWorldProjection(client, viewer, null, Date.now()),
      /unavailable/i,
      "an unreadable candidate read must propagate a refusal, not resolve to an empty world",
    );
  });

  it("CONTROL — buildWorldProjection still RESOLVES, empty, on a healthy empty read", async () => {
    const { makeFailClosedClient } = await import("./helpers/failClosedSupabase.js");
    const client = makeFailClosedClient(spec(false) as any);
    const viewer = await resolveViewer(client, VIEWER, { needFollows: false });
    const p = await buildWorldProjection(client, viewer, null, Date.now());
    assert.equal(p.totalPerspectives, 0);
  });

  // ── Survivors found by mutation, and closed ────────────────────────────────
  //
  // Both cases below were added because a mutation SURVIVED the suite: the
  // behaviour was implemented and nothing asserted it, which is the same as not
  // having it. Recorded here so the reason the tests exist is not lost.

  it("SURVIVOR M2 — an unreadable BLOCK list refuses; it does not quietly empty the feed", async () => {
    // Mutation that survived: `if (blockFetchFailed) throw …` → `return []`.
    // The old fail-closed empty withheld exactly the right content and told the
    // viewer the wrong thing about why. `posts` reads FINE here — only `blocks`
    // fails — so a refusal cannot be coming from the candidate read.
    const { makeFailClosedClient } = await import("./helpers/failClosedSupabase.js");
    const client = makeFailClosedClient({
      rows: {
        profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
        posts: [makePost({ id: "p-visible", content: "rooftop" })],
        blocks: [], user_mutes: [], user_follows: [], trip_members: [], trips: [], feature_flags: [],
      },
      failOn: (ctx: any) => (ctx.table === "blocks" ? { message: "deadlock detected", code: "40P01" } : null),
    } as any);
    const viewer = await resolveViewer(client, VIEWER, { needFollows: false });
    await assert.rejects(
      () => buildWorldProjection(client, viewer, null, Date.now()),
      /eligibility/i,
      "an unprovable block list must refuse, naming the eligibility input",
    );
  });

  it("CONTROL for M2 — the same fixture with a READABLE block list projects the post", async () => {
    // Without this, the case above passes for any reason at all, including a
    // fixture that never produced a candidate in the first place.
    const { makeFailClosedClient } = await import("./helpers/failClosedSupabase.js");
    const client = makeFailClosedClient({
      rows: {
        profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
        posts: [makePost({ id: "p-visible", content: "rooftop" })],
        blocks: [], user_mutes: [], user_follows: [], trip_members: [], trips: [], feature_flags: [],
      },
    } as any);
    const viewer = await resolveViewer(client, VIEWER, { needFollows: false });
    const p = await buildWorldProjection(client, viewer, null, Date.now());
    assert.equal(p.totalPerspectives, 1, "the fixture must really yield a candidate, or M2 proves nothing");
  });

  it("SURVIVOR M4 — an unreadable gem table is reported UNDETERMINED, not as 'no gems'", async () => {
    // Mutation that survived: `determined: false` → `determined: true` on the
    // error branch. Withholding the gems is the privacy decision and is
    // unchanged; claiming they do not exist is the separate false statement.
    const { makeFailClosedClient } = await import("./helpers/failClosedSupabase.js");
    const rows = {
      profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
      posts: [makePost({ id: "p-roof", content: "rooftop" })],
      blocks: [], user_mutes: [], user_follows: [], trip_members: [], trips: [], feature_flags: [], hidden_gems: [],
    };
    // TWO DIFFERENT READS HIT `hidden_gems` on this path and only one is under
    // test here. `lib/mediaLocationVisibility.loadRestrictiveGems` reads it to
    // compute the GEM CEILING, filtering on `status` + `sensitivity_level`;
    // when that read fails the projection already coarsens every item
    // defensively and strips `placeId`, so `places` comes back empty and the
    // gem roll-up is never reached — which is correct, and is why failing the
    // whole table made this test vacuously pass its own premise.
    //
    // So the failure is targeted at the ROLL-UP's read specifically, which is
    // the only one of the two that carries no `status` filter. Two reads of one
    // table succeeding and failing independently is ordinary (a statement
    // timeout on the wider scan, a dropped connection between them); here it is
    // an isolation device, stated rather than disguised.
    const failing = makeFailClosedClient({
      rows,
      failOn: (ctx: any) =>
        ctx.table === "hidden_gems" && !ctx.filters.some((f: any) => f.col === "status")
          ? { message: "relation unavailable", code: "57P01" }
          : null,
    } as any);
    const viewer = await resolveViewer(failing, VIEWER, { needFollows: false });
    const bad = await searchMedia(failing, viewer, { q: "rooftop" }, Date.now());
    assert.deepEqual(bad.media.map((m) => m.id), ["p-roof"], "the search itself must still answer");
    assert.deepEqual(bad.hiddenGems, [], "and must still withhold the gems");
    assert.ok(
      bad.undetermined.includes("hiddenGems"),
      "but it must say the gem list was not determined rather than implying there are none",
    );

    // CONTROL: the same query with a READABLE (and genuinely empty) gem table
    // must NOT be marked undetermined, or the marker means nothing.
    const healthy = makeFailClosedClient({ rows } as any);
    const viewer2 = await resolveViewer(healthy, VIEWER, { needFollows: false });
    const good = await searchMedia(healthy, viewer2, { q: "rooftop" }, Date.now());
    assert.deepEqual(good.hiddenGems, []);
    assert.deepEqual(good.undetermined, [], "a genuinely empty gem table is determined, and must read as such");
  });

  it("SURVIVOR M7 — an experience whose own read refused marks experiences UNDETERMINED", async () => {
    // Mutation that survived: the `catch` around `resolveExperience` swallowed
    // the refusal and `continue`d, putting this list straight back into the
    // state the rest of this change removes. A `null` from the resolver is a
    // DECISION (not visible to you / no perspectives) and is still skipped
    // silently; a REJECTION is not a decision.
    //
    // Isolation: only the posts read that carries a `trip_id` filter fails —
    // that is the resolver's own hero-media read (MediaExperienceResolver
    // line ~287). The search's primary read carries no trip filter and stays
    // healthy, so a refusal cannot be leaking from there.
    const TRIP = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const { makeFailClosedClient } = await import("./helpers/failClosedSupabase.js");
    const rows = {
      profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
      posts: [makePost({ id: "p-trip", content: "rooftop", tripId: TRIP })],
      trips: [{ id: TRIP, title: "Vietnam", visibility: "public", owner_id: AUTHOR_A }],
      blocks: [], user_mutes: [], user_follows: [], trip_members: [], feature_flags: [], hidden_gems: [],
    };
    const tripReadFails = (ctx: any) =>
      ctx.table === "posts" && ctx.filters.some((f: any) => f.col === "trip_id")
        ? { message: "canceling statement due to statement timeout", code: "57014" }
        : null;

    const failing = makeFailClosedClient({ rows, failOn: tripReadFails } as any);
    const viewer = await resolveViewer(failing, VIEWER, { needFollows: false });
    const bad = await searchMedia(failing, viewer, { q: "rooftop" }, Date.now());
    assert.deepEqual(bad.media.map((m) => m.id), ["p-trip"], "the search itself must still answer");
    assert.deepEqual(bad.experiences, [], "and must not invent an experience it could not resolve");
    assert.ok(
      bad.undetermined.includes("experiences"),
      "but it must say the experience list was not determined",
    );

    // CONTROL: same fixture, every read healthy — the experience resolves and
    // nothing is marked undetermined, so the marker is not unconditional.
    const healthy = makeFailClosedClient({ rows } as any);
    const viewer2 = await resolveViewer(healthy, VIEWER, { needFollows: false });
    const good = await searchMedia(healthy, viewer2, { q: "rooftop" }, Date.now());
    assert.deepEqual(good.undetermined, [], "a healthy search determines every list");
    assert.deepEqual(good.experiences.map((e) => e.id), [TRIP], "the fixture must really resolve an experience");
  });

  it("SURVIVOR M8 — a non-array payload with NO error is unknown, not empty", async () => {
    // Mutation that survived: `if (!Array.isArray(settled.data)) return []`.
    // PostgREST can answer 200 with a body this code cannot read (a single
    // object where a page was asked for, an error document shaped as JSON). No
    // `error` is set, so the old guard filed it under "no rows" — a confident
    // claim built on a payload nobody understood. It is the same unknown as a
    // failed read and must refuse alike.
    const nonArray: any = {
      from(table: string) {
        const b: any = new Proxy({}, {
          get(_t, prop: string) {
            if (prop === "then") {
              return (onF: any, onR: any) =>
                Promise.resolve(
                  table === "posts"
                    ? { data: { unexpected: "object" }, error: null, count: null }
                    : { data: [], error: null, count: null },
                ).then(onF, onR);
            }
            if (prop === "maybeSingle" || prop === "single") {
              return () => Promise.resolve({ data: null, error: null, count: null });
            }
            return () => b;
          },
        });
        return b;
      },
    };
    const viewer = await resolveViewer(nonArray, VIEWER, { needFollows: false });
    await assert.rejects(
      () => buildWorldProjection(nonArray, viewer, null, Date.now()),
      /non-array payload/i,
      "an unreadable payload shape must refuse, not be filed as an empty world",
    );
  });

  it("searchMedia REFUSES rather than reporting zero hits it never looked for", async () => {
    const { makeFailClosedClient } = await import("./helpers/failClosedSupabase.js");
    const client = makeFailClosedClient(spec(true) as any);
    const viewer = await resolveViewer(client, VIEWER, { needFollows: false });
    await assert.rejects(
      () => searchMedia(client, viewer, { q: "rooftop" }, Date.now()),
      /unavailable/i,
      "a search that could not read is not a search that found nothing",
    );
  });
});
