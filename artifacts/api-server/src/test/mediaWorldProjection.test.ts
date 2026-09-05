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
}

let seq = 0;
function makePost(o: PostOverrides = {}): any {
  const id = o.id ?? `post-${++seq}`;
  const author = o.author_id ?? AUTHOR_A;
  const row: any = {
    id,
    author_id: author,
    trip_id: o.tripId ?? null,
    content: "",
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
    location_name: "An Thuong Bar",
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
      username: "maya",
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
