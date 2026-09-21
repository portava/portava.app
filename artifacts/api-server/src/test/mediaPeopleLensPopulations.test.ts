/**
 * mediaPeopleLensPopulations — census-media MD216 (§27).
 *
 * The row: *"The People lens prioritises followed users, Trip Crew, Shared
 * Moment participants and relevant creators."* census-media §5 graded it **W**
 * on *"Two of four"* — `buildPeopleProjection` loaded `feedType: "following"`
 * only, whose visibility gate refuses any author the viewer does not follow, so
 * a Trip Crew member and a Shared Moment co-participant were STRUCTURALLY
 * unreachable from this lens no matter what they posted. The client already
 * promised both populations in its own copy
 * (`travel-buddy-standalone/src/features/media/screens/MediaPeopleScreen.tsx`,
 * *"people you follow, your Trip Crew, and Shared Moments"*), so the lens was
 * advertising two populations the server could not supply.
 *
 * What is asserted here:
 *   1. a Trip Crew member's PUBLIC perspective reaches the lens (the follow
 *      graph does not contain them);
 *   2. a Shared Moment co-participant's PUBLIC perspective reaches it;
 *   3. the four populations are ordered as §27 names them — followed first,
 *      then Trip Crew, then Shared Moment;
 *   4. THE BOUND, stated rather than hidden: the affinity lane is `for_you`, so
 *      a crew member's `trip_only` or `private` post is WITHHELD rather than
 *      guessed at — admitting it needs a membership proof this lane does not
 *      carry per item;
 *   5. a membership that is not accepted admits nobody (invited / pending);
 *   6. the lens still emits no precise location.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaPeopleLensPopulations.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isLocationSafe } from "../lib/media/mediaLocationSafety.js";
import {
  resolveViewer,
  loadPeopleAffinities,
  buildPeopleProjection,
} from "../services/media/MediaProjectionService.js";

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
const FOLLOWED = "22222222-2222-2222-2222-222222222222";
const CREW = "33333333-3333-3333-3333-333333333333";
const MOMENT_PAL = "44444444-4444-4444-4444-444444444444";
const STRANGER = "55555555-5555-5555-5555-555555555555";
const TRIP_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MOMENT_1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PLACE_1 = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

let seq = 0;
function makePost(o: { id?: string; author_id?: string; visibility?: string; tripId?: string | null; createdAt?: string } = {}): any {
  const id = o.id ?? `post-${++seq}`;
  const author = o.author_id ?? FOLLOWED;
  return {
    id,
    author_id: author,
    trip_id: o.tripId ?? null,
    content: "",
    visibility: o.visibility ?? "public",
    status: "active",
    post_status: "published",
    moderation_status: null,
    publish_at: null,
    expires_at: null,
    created_at: o.createdAt ?? isoAgo(10 * 60 * 1000),
    category: "nightlife",
    media_urls: [],
    has_video: false,
    location_name: "An Thuong Bar",
    location_city: "Da Nang",
    location_country: "Vietnam",
    canonical_place_id: PLACE_1,
    // Precise coordinates ARE on the row; the projection must never carry them.
    location_lat: 16.0544,
    location_lng: 108.2497,
    post_media: [
      {
        id: `${id}-m1`,
        media_type: "image",
        public_url: `https://cdn.example/${id}.jpg`,
        thumbnail_url: null,
        duration_seconds: null,
        width: 1080,
        height: 1080,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: null,
      },
    ],
    profiles: {
      id: author,
      username: `u-${author.slice(0, 4)}`,
      full_name: "Person",
      name: "Person",
      display_name: "Person",
      avatar_url: null,
      verified: false,
      is_official: false,
      account_status: "active",
      is_private: false,
    },
  };
}

function baseData(extra: Dataset = {}): Dataset {
  return {
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
    blocks: [],
    user_mutes: [],
    post_hides: [],
    user_follows: [],
    trip_members: [],
    trips: [],
    shared_moment_memberships: [],
    feature_flags: [],
    ...extra,
  };
}

/** The viewer is an accepted member of TRIP_1; so is CREW. */
const CREW_MEMBERSHIPS = [
  { trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "accepted" },
  { trip_id: TRIP_1, user_id: CREW, role: "member", status: "accepted" },
];

/** The viewer and MOMENT_PAL both hold accepted memberships of MOMENT_1. */
const MOMENT_MEMBERSHIPS = [
  { moment_id: MOMENT_1, user_id: VIEWER, role: "member", status: "accepted" },
  { moment_id: MOMENT_1, user_id: MOMENT_PAL, role: "member", status: "accepted" },
];

// ── 1. The affinity loader itself ────────────────────────────────────────────

describe("MD216 — loadPeopleAffinities resolves the two missing §27 populations", () => {
  it("names the viewer's Trip Crew, excluding the viewer", async () => {
    const sc = makeSc(baseData({ trip_members: CREW_MEMBERSHIPS }));
    const aff = await loadPeopleAffinities(sc, VIEWER);
    assert.deepEqual([...aff.tripCrewIds], [CREW]);
    assert.equal(aff.tripCrewIds.has(VIEWER), false, "the viewer is not their own crew");
  });

  it("names the viewer's Shared Moment participants, excluding the viewer", async () => {
    const sc = makeSc(baseData({ shared_moment_memberships: MOMENT_MEMBERSHIPS }));
    const aff = await loadPeopleAffinities(sc, VIEWER);
    assert.deepEqual([...aff.sharedMomentIds], [MOMENT_PAL]);
    assert.equal(aff.sharedMomentIds.has(VIEWER), false);
  });

  it("an UNACCEPTED membership admits nobody — on either table", async () => {
    const sc = makeSc(
      baseData({
        trip_members: [
          { trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "accepted" },
          { trip_id: TRIP_1, user_id: CREW, role: "member", status: "invited" },
        ],
        shared_moment_memberships: [
          { moment_id: MOMENT_1, user_id: VIEWER, role: "member", status: "accepted" },
          { moment_id: MOMENT_1, user_id: MOMENT_PAL, role: "member", status: "pending" },
        ],
      }),
    );
    const aff = await loadPeopleAffinities(sc, VIEWER);
    assert.deepEqual([...aff.tripCrewIds], []);
    assert.deepEqual([...aff.sharedMomentIds], []);
  });

  it("a trip the VIEWER has not accepted yields no crew at all", async () => {
    const sc = makeSc(
      baseData({
        trip_members: [
          { trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "invited" },
          { trip_id: TRIP_1, user_id: CREW, role: "member", status: "accepted" },
        ],
      }),
    );
    const aff = await loadPeopleAffinities(sc, VIEWER);
    assert.deepEqual([...aff.tripCrewIds], [], "an invitation the viewer never accepted is not a crew");
  });

  it("a read failure leaves the affinity sets EMPTY rather than guessing", async () => {
    const sc = {
      from() {
        throw new Error("postgrest down");
      },
    } as any;
    const aff = await loadPeopleAffinities(sc, VIEWER);
    assert.deepEqual([...aff.tripCrewIds], []);
    assert.deepEqual([...aff.sharedMomentIds], []);
  });
});

// ── 2. The lens ──────────────────────────────────────────────────────────────

describe("MD216 — the People lens carries all four §27 populations", () => {
  it("a Trip Crew member the viewer does NOT follow reaches the lens", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ author_id: CREW })],
        trip_members: CREW_MEMBERSHIPS,
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    assert.equal(viewer.followedCreatorIds.size, 0, "precondition: the follow graph is empty");
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.deepEqual(
      p.people.map((g) => g.contributor?.id),
      [CREW],
      "the crew member's public perspective must reach the People lens",
    );
    assert.equal(p.people[0].relation, "trip_crew");
  });

  it("a Shared Moment participant the viewer does NOT follow reaches the lens", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ author_id: MOMENT_PAL })],
        shared_moment_memberships: MOMENT_MEMBERSHIPS,
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.deepEqual(p.people.map((g) => g.contributor?.id), [MOMENT_PAL]);
    assert.equal(p.people[0].relation, "shared_moment");
  });

  it("orders the populations as §27 names them: followed, Trip Crew, Shared Moment", async () => {
    const sc = makeSc(
      baseData({
        // The Shared Moment pal has the MOST perspectives, so a count-only sort
        // would put them first. §27's order must beat the count.
        posts: [
          makePost({ author_id: FOLLOWED }),
          makePost({ author_id: CREW }),
          makePost({ author_id: CREW }),
          makePost({ author_id: MOMENT_PAL }),
          makePost({ author_id: MOMENT_PAL }),
          makePost({ author_id: MOMENT_PAL }),
        ],
        user_follows: [{ follower_id: VIEWER, following_id: FOLLOWED }],
        trip_members: CREW_MEMBERSHIPS,
        shared_moment_memberships: MOMENT_MEMBERSHIPS,
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.deepEqual(p.people.map((g) => g.contributor?.id), [FOLLOWED, CREW, MOMENT_PAL]);
    assert.deepEqual(p.people.map((g) => g.relation), ["followed", "trip_crew", "shared_moment"]);
    assert.equal(p.totalPerspectives, 6);
  });

  it("a person who is BOTH followed and crew is counted ONCE, at the stronger relation", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ id: "shared-one", author_id: CREW })],
        user_follows: [{ follower_id: VIEWER, following_id: CREW }],
        trip_members: CREW_MEMBERSHIPS,
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.equal(p.people.length, 1);
    assert.equal(p.people[0].perspectiveCount, 1, "the post must not be double-counted by two lanes");
    assert.equal(p.people[0].relation, "followed");
    assert.equal(p.totalPerspectives, 1);
  });

  it("a stranger — no follow, no crew, no moment — reaches nothing", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ author_id: STRANGER })],
        trip_members: CREW_MEMBERSHIPS,
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.deepEqual(p.people, []);
  });

  it("THE BOUND: a crew member's trip_only and private posts are withheld", async () => {
    const sc = makeSc(
      baseData({
        posts: [
          makePost({ id: "crew-trip-only", author_id: CREW, visibility: "trip_only", tripId: TRIP_1 }),
          makePost({ id: "crew-private", author_id: CREW, visibility: "private" }),
        ],
        trip_members: CREW_MEMBERSHIPS,
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    assert.equal(viewer.viewerTripIds.has(TRIP_1), true, "precondition: the viewer IS a member of that trip");
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.deepEqual(p.people, [], "the affinity lane is public-only and says so");
    assert.equal(p.totalPerspectives, 0);
  });

  it("a blocked crew member is still blocked", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ author_id: CREW })],
        trip_members: CREW_MEMBERSHIPS,
        blocks: [{ blocker_id: VIEWER, blocked_id: CREW }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.deepEqual(p.people, [], "the shared eligibility gate still runs on the affinity lane");
  });

  it("emits no precise location for any population", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ author_id: CREW }), makePost({ author_id: MOMENT_PAL })],
        trip_members: CREW_MEMBERSHIPS,
        shared_moment_memberships: MOMENT_MEMBERSHIPS,
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.equal(p.people.length, 2);
    assert.equal(isLocationSafe(p), true);
  });
});
