/**
 * census-media §42 — the owner's `posts.location_privacy_mode`, honoured by the
 * post readers OUTSIDE Media.
 *
 * THE DEFECT
 * ==========
 * POST /posts stores the venue the author tagged in `posts.location_name`
 * whatever mode they chose (routes/posts.ts writes `location_name: locationName`
 * unconditionally), and copies the same string into `pulse_geo_tags.venue_name`
 * (writePulseGeoTag is called with `venueName: locationName`). "Show city only",
 * "Hide exact place", "Trusted circle only" and "Show neighborhood only" are
 * honoured at READ time, by lib/postSchemas.mapPublicPost (the Wall) and by
 * lib/mediaLocationVisibility.resolveMediaPlaceDisclosure (Media, lane P §36).
 * Three readers applied neither:
 *
 *   A. GET /api/pulse served `locationName: row.location_name`, the geo tag's
 *      `venueName` and `locationDistrict`, and `canonical_place_id` — for every
 *      post, whatever its author chose. The Pulse card renders `locationName`
 *      as its location chip, so the venue reached the screen.
 *   B. lib/eventPostsDiscovery (GET /discovery/feed "Live from events") fell
 *      back to `posts.location_name` as the venue of an event-linked post, and
 *      listed a post under "venue category" BECAUSE its tagged place is an
 *      events venue, naming that place.
 *   C. GET /api/trips/:tripId/posts served the raw row: `location_name`, and a
 *      `public_location_label` that stored the venue for trusted_circle_only
 *      posts written before §36.
 *
 * THE RULE (one, not a new one)
 * =============================
 * mapPublicPost's own decision, exposed as `postPlaceWithheld` (section D pins
 * the two together). The AUTHOR always sees their own post in full. For anyone
 * else, a withheld post carries its city and country and nothing finer.
 *
 * WHAT EACH SECTION PROVES, and how each was seen red
 * ===================================================
 *   - A mode that withholds is served without the venue, the place id, the
 *     district, the coordinates, and (discovery B) without a listing keyed on
 *     the post's own place.
 *   - The owner still gets their post in full.
 *   - A `none`-mode post, and a RELEASED delayed post, are served EXACTLY as
 *     before: the whole served object is compared with a restatement of the
 *     pre-change shape, and those cases were run green against the unfixed
 *     readers as well as the fixed ones (§42 records both runs).
 *   - The page is the same posts in the same order (A7, Pulse with ranking on),
 *     or the old page minus entries (B7, discovery's per-event cap): the rule
 *     runs on the page as it was ranked, so a withheld place cannot re-rank it.
 *   - An unknown mode fails closed.
 *   - Each query SELECTS the mode: a fake that returns whatever row it is given
 *     would stay green after the column was dropped from the SELECT, and a row
 *     without the column reads as `none` to mapPublicPost.
 *
 * Run: node --import tsx/esm --test src/test/postLocationModeOutsideMedia.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import {
  fetchEventPostsForDiscovery,
  _clearEventPostsCache,
  type DiscoveryEventPost,
} from "../lib/eventPostsDiscovery.js";
import { startApp, BEARER, type FakeState } from "./helpers.js";
import { mapPublicPost, postPlaceWithheld, locationPrivacyMode } from "../lib/postSchemas.js";

const AUTHOR = "a0a0a0a0-aaaa-aaaa-aaaa-000000000001";
const VIEWER = "b0b0b0b0-bbbb-bbbb-bbbb-000000000002";
const NOW = new Date().toISOString();

/** Every mode that withholds the venue from a non-owner, plus one no code knows. */
const WITHHOLDING_MODES = ["city_only", "hidden", "trusted_circle_only", "neighborhood_only"] as const;
const UNKNOWN_MODE = "a_mode_no_reader_knows_yet";

// ═══════════════════════════════════════════════════════════════════════════
// A. GET /api/pulse
// ═══════════════════════════════════════════════════════════════════════════

const GEO = {
  location_visibility: "venue_tagged",
  city: "Lisbon",
  district: "Alfama",
  country: "Portugal",
  country_code: "PT",
  venue_name: "Hotel Alfama",
  hotel_blur_applied: false,
};

function pulseRow(id: string, mode: string | null, over: Record<string, any> = {}): Record<string, any> {
  return {
    id,
    author_id: AUTHOR,
    trip_id: null,
    content: `post ${id}`,
    media_urls: [],
    visibility: "public",
    status: "active",
    post_status: "published",
    created_at: NOW,
    updated_at: NOW,
    location_name: "Hotel Alfama",
    location_city: "Lisbon",
    location_country: "Portugal",
    location_source: "gps",
    canonical_place_id: `place-${id}`,
    location_privacy_mode: mode,
    post_media: [],
    pulse_geo_tags: [{ ...GEO }],
    profiles: {
      id: AUTHOR, username: "author", display_name: "Ana Author", name: null, full_name: null,
      avatar_url: null, verified: false, is_official: false,
    },
    ...over,
  };
}

/**
 * The served object for one row, restated from the pre-change route
 * (routes/pulse.ts at 5956c6233, "Shape responses"). Run green against that
 * tree for every row whose place is not withheld.
 */
function pulseShape(row: Record<string, any>, viewerIsOwner: boolean): Record<string, any> {
  const geo = row.pulse_geo_tags[0];
  return {
    id: row.id,
    authorId: row.author_id,
    tripId: null,
    content: row.content,
    mediaUrls: [],
    visibility: "public",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    locationName: row.location_name,
    locationCity: geo.city,
    locationCountry: geo.country,
    locationDistrict: geo.district,
    venueName: geo.venue_name,
    locationVisibility: geo.location_visibility,
    hotelBlurApplied: false,
    author: {
      id: AUTHOR, username: "author",
      // The author sees their own display name; others see the handle
      // (nameVisibilitySet is empty in this fake).
      name: viewerIsOwner ? "Ana Author" : "author",
      avatarUrl: null, verified: false, isOfficial: false,
    },
    media: [],
    spanTags: [],
    spanHashtags: [],
    savedByMe: false,
    featuredByPortava: null,
    canonical_place_id: row.canonical_place_id,
  };
}

/** What a non-owner may still be told about a withheld post: city and country. */
function withheldPulseShape(row: Record<string, any>): Record<string, any> {
  return { ...pulseShape(row, false), locationName: null, venueName: null, locationDistrict: null, canonical_place_id: null };
}

function pulseClient(posts: any[], extra: Record<string, any[]> = {}) {
  const selects: Array<{ table: string; cols: string }> = [];
  const db: Record<string, any[]> = { ...extra, posts };
  function builder(table: string, rows: any[]) {
    let filtered = [...rows];
    const b: any = {
      select: (c?: string) => { selects.push({ table, cols: String(c ?? "") }); return b; },
      eq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in: (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      not: (col: string, op: string, val: any) => {
        if (op === "in" && Array.isArray(val)) filtered = filtered.filter((r) => !val.includes(r[col]));
        return b;
      },
      ilike: () => b, like: () => b,
      lt: () => b, lte: () => b, gt: () => b, gte: () => b,
      contains: () => b, overlaps: () => b, or: () => b, order: () => b,
      limit: () => b, range: () => b,
      is: (col: string, val: any) => {
        filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (res: any, rej?: any) => Promise.resolve({ data: [...filtered], error: null }).then(res, rej),
    };
    return b;
  }
  const client: any = {
    auth: {
      getUser: (token?: string) =>
        token === "viewer-token"
          ? Promise.resolve({ data: { user: { id: VIEWER } }, error: null })
          : token === "author-token"
            ? Promise.resolve({ data: { user: { id: AUTHOR } }, error: null })
            : Promise.resolve({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => {
      const b = builder(table, db[table] ?? []);
      b.insert = () => Promise.resolve({ data: null, error: null });
      b.upsert = () => Promise.resolve({ data: null, error: null });
      b.update = () => ({ eq: () => Promise.resolve({ data: null, error: null }) });
      return b;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { client, selects };
}

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      res({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r(undefined)); }),
      });
    });
  });
}

describe("A. GET /api/pulse — the owner's location mode", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache(); // COMPASS_ENABLED absent ⇒ the ranking pass is skipped
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => { req.log = { error() {}, info() {}, warn() {} }; next(); });
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));
  });
  after(async () => { await close(); _setTestClient(null as any, false); });

  async function servedAs(token: string, rows: any[], extra: Record<string, any[]> = {}) {
    const f = pulseClient(rows, extra);
    _setTestClient(f.client, true);
    const r = await fetch(`${url}/api/pulse`, { headers: { Authorization: `Bearer ${token}`, connection: "close" } });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    const byId = new Map<string, any>((body.posts as any[]).map((p) => [p.id, p]));
    return { body, byId, selects: f.selects };
  }

  it("A1. a `none`-mode post is served EXACTLY as before — the whole object, and the whole envelope", async () => {
    const none = pulseRow("n1", "none");
    const absent = pulseRow("n2", null);
    const { body, byId } = await servedAs("viewer-token", [none, absent]);
    assert.deepEqual(Object.keys(body).sort(), ["placeCards", "posts", "prompts", "sessionId", "tab", "total"]);
    assert.equal(body.total, 2);
    assert.deepEqual(byId.get("n1"), pulseShape(none, false));
    assert.deepEqual(byId.get("n2"), pulseShape(absent, false), "an absent mode is `none`, as mapPublicPost reads it");
  });

  it("A2. a RELEASED delayed post: 'At a time' keeps its venue; 'After I leave' is withheld here, because this reader does not SELECT published_at (census-media MD79, fail-closed)", async () => {
    // Lead ruling D-26f (2026-10-07): a released "Publish after I leave" post shows its place for 24 h, and a
    // row whose release time was not read has ENDED. routes/pulse.ts does not select published_at, so Pulse
    // shows the city from release — less than the ruling allows, never more.
    const exit = pulseRow("d1", "delayed_until_exit");
    const time = pulseRow("d2", "delayed_until_time");
    const { byId } = await servedAs("viewer-token", [exit, time]);
    assert.deepEqual(byId.get("d1"), withheldPulseShape(exit));
    assert.deepEqual(byId.get("d2"), pulseShape(time, false));
  });

  it("A3. every withholding mode reaches a non-owner as city and country only — no venue, district or place id", async () => {
    const rows = WITHHOLDING_MODES.map((m, i) => pulseRow(`w${i}`, m));
    const { byId } = await servedAs("viewer-token", rows);
    for (const row of rows) {
      const served = byId.get(row.id);
      assert.ok(served, `${row.location_privacy_mode}: still served (the post is public; only its place is withheld)`);
      assert.deepEqual(served, withheldPulseShape(row), `${row.location_privacy_mode}: nothing finer than the city`);
      assert.ok(!JSON.stringify(served).includes("Hotel Alfama"), `${row.location_privacy_mode}: the venue appears nowhere in the served object`);
      assert.ok(!JSON.stringify(served).includes("Alfama\""), `${row.location_privacy_mode}: nor the district`);
    }
  });

  it("A4. an unknown mode fails closed", async () => {
    const row = pulseRow("u1", UNKNOWN_MODE);
    const { byId } = await servedAs("viewer-token", [row]);
    assert.deepEqual(byId.get("u1"), withheldPulseShape(row));
  });

  it("A5. the OWNER still sees their own post in full, whatever its mode", async () => {
    const rows = [...WITHHOLDING_MODES, UNKNOWN_MODE, "none"].map((m, i) => pulseRow(`o${i}`, m));
    const { byId } = await servedAs("author-token", rows);
    for (const row of rows) {
      assert.deepEqual(byId.get(row.id), pulseShape(row, true), `${row.location_privacy_mode}: the author's own post, in full`);
    }
  });

  it("A7. with the ranking pass ON, the served page is the same posts in the same order — only the withheld fields differ", async () => {
    // Two authors (no creator cap), one timestamp. The viewer has viewed
    // `place-hot`, so the post there earns the ×1.15 place-affinity boost.
    const OTHER = "c0c0c0c0-cccc-cccc-cccc-000000000003";
    const cold = pulseRow("rank-cold", "none", {
      author_id: OTHER, canonical_place_id: "place-cold",
      profiles: { id: OTHER, username: "other", display_name: null, name: null, full_name: null, avatar_url: null, verified: false, is_official: false },
    });
    const hot = (mode: string) => pulseRow("rank-hot", mode, { canonical_place_id: "place-hot" });
    const compassOn = (affinity: boolean) => ({
      feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
      compass_profiles: [{ user_id: VIEWER, current_city: "Lisbon", persona_type: "explorer", travel_intensity: "moderate", active_trip_id: null, vibe_tags: [] }],
      rank_events: affinity ? [1, 2, 3].map((i) => ({ event_type: "place_view", user_id: VIEWER, item_id: "place-hot", served_at: NOW, id: `pv${i}` })) : [],
    });
    const order = async (mode: string, affinity: boolean) =>
      ((await servedAs("viewer-token", [cold, hot(mode)], compassOn(affinity))).body.posts as any[]).map((p) => p.id as string);

    const withBoost = await order("none", true);
    const withoutBoost = await order("none", false);
    assert.notDeepEqual(withBoost, withoutBoost, "precondition: in this fixture the place id really moves the ranking");

    const { body } = await servedAs("viewer-token", [cold, hot("city_only")], compassOn(true));
    assert.deepEqual((body.posts as any[]).map((p) => p.id), withBoost,
      "a withheld place must not re-rank the page: the redaction runs on the served page, after ranking");
    const served = (body.posts as any[]).find((p) => p.id === "rank-hot");
    assert.equal(served.canonical_place_id, null);
    assert.equal(served.locationName, null);
    assert.equal(served.venueName, null);
  });

  it("A6. the Pulse query SELECTS location_privacy_mode (a row without it reads as `none`)", async () => {
    const { selects } = await servedAs("viewer-token", [pulseRow("s1", "none")]);
    const postReads = selects.filter((s) => s.table === "posts" && s.cols.includes("location_name"));
    assert.ok(postReads.length >= 1, "precondition: the feed read posts");
    for (const s of postReads) {
      assert.match(s.cols, /\blocation_privacy_mode\b/, "the feed SELECT must carry the owner's mode");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. lib/eventPostsDiscovery — "Live from events" on GET /discovery/feed
// ═══════════════════════════════════════════════════════════════════════════

type Row = Record<string, any>;

function discoveryDb(tables: Record<string, Row[]>) {
  const reads: string[] = [];
  const selects: Array<{ table: string; cols: string }> = [];
  const chainFor = (table: string, rows: Row[]) => {
    const chain: any = {
      select: (cols: string) => { selects.push({ table, cols: String(cols) }); return chain; },
      eq: () => chain, ilike: () => chain, is: () => chain, not: () => chain,
      in: () => chain, limit: () => chain,
      then: (resolve: (v: any) => void) => {
        reads.push(table);
        const out = { data: rows, error: null };
        resolve(out);
        return Promise.resolve(out);
      },
    };
    return chain;
  };
  return { db: { from: (t: string) => chainFor(t, tables[t] ?? []) } as any, reads, selects };
}

function discoveryPost(id: string, mode: string | null, over: Row = {}): Row {
  return {
    id,
    author_id: AUTHOR,
    content: `post ${id}`,
    media_urls: [],
    location_city: "Lisbon",
    location_name: "Hotel Alfama",
    location_place_id: `osm-${id}`,
    public_lat: 38.711,
    public_lng: -9.13,
    created_at: NOW,
    like_count: 4,
    comment_count: 1,
    visibility: "public",
    status: "active",
    post_status: "published",
    deleted_at: null,
    publish_eligible_at: null,
    location_privacy_mode: mode,
    ...over,
  };
}

const EVENT_WITH_VENUE = {
  id: "event-venue", title: "Fado Night", location_lat: 38.711, location_lng: -9.13,
  starts_at: null, ends_at: null, location_name: "Clube de Fado", tags: [],
};
const EVENT_NO_VENUE = { ...EVENT_WITH_VENUE, id: "event-novenue", title: "Pop-up", location_name: null };
const EVENT_PLACE = { name: "Hotel Alfama", primary_category: "events", city: "Lisbon", lat: 38.711, lng: -9.13 };

const linkRow = (post: Row, event: Row) => ({ post_id: post.id, event_id: event.id, posts: post, events: event });
const placeRow = (post: Row) => ({ ...post, discovery_places: { ...EVENT_PLACE } });

/** Restated from the pre-change module (5956c6233): Path A's served object. */
function pathAShape(post: Row, event: Row): DiscoveryEventPost {
  return {
    id: post.id, authorId: post.author_id, content: post.content, mediaUrls: [],
    venueName: event.location_name ?? post.location_name ?? null,
    locationCity: post.location_city, publicLat: post.public_lat, publicLng: post.public_lng,
    createdAt: post.created_at, likeCount: post.like_count, commentCount: post.comment_count,
    linkedEventId: event.id, linkedEventTitle: event.title, venueLabel: event.location_name ?? null,
    sourceKind: "event_link",
  };
}

/** Restated from the pre-change module (5956c6233): Path B's served object. */
function pathBShape(post: Row): DiscoveryEventPost {
  return {
    id: post.id, authorId: post.author_id, content: post.content, mediaUrls: [],
    venueName: EVENT_PLACE.name, locationCity: post.location_city,
    publicLat: post.public_lat, publicLng: post.public_lng,
    createdAt: post.created_at, likeCount: post.like_count, commentCount: post.comment_count,
    linkedEventId: null, linkedEventTitle: null, venueLabel: EVENT_PLACE.name, sourceKind: "venue_category",
  };
}

function discoveryParams(db: any, viewerId: string | null) {
  return {
    db, lat: 38.71, lng: -9.13, city: "Lisbon", radiusKm: 10, viewerId,
    blockedIds: new Set<string>(), seenPostIds: new Set<string>(),
  };
}

describe("B. eventPostsDiscovery — the owner's location mode, per viewer, after the shared cache", () => {
  beforeEach(() => _clearEventPostsCache());

  it("B1. `none`-mode and released 'At a time' posts are served EXACTLY as before, on both paths; a released 'After I leave' post lends no venue (MD79: this reader does not SELECT published_at)", async () => {
    const aNone = discoveryPost("a-none", "none");
    const aAbsent = discoveryPost("a-absent", null);
    const aNoVenue = discoveryPost("a-fallback", "none");
    const aReleased = discoveryPost("a-released", "delayed_until_exit");
    const bNone = discoveryPost("b-none", "none");
    const bReleased = discoveryPost("b-released", "delayed_until_time");
    const { db } = discoveryDb({
      post_event_links: [
        linkRow(aNone, EVENT_WITH_VENUE), linkRow(aAbsent, EVENT_WITH_VENUE),
        linkRow(aNoVenue, EVENT_NO_VENUE), linkRow(aReleased, EVENT_WITH_VENUE),
      ],
      posts: [placeRow(bNone), placeRow(bReleased)],
    });
    const out = await fetchEventPostsForDiscovery(discoveryParams(db, VIEWER));
    const byId = new Map(out.map((p) => [p.id, p]));
    assert.equal(out.length, 6);
    assert.deepEqual(byId.get("a-none"), pathAShape(aNone, EVENT_WITH_VENUE));
    assert.deepEqual(byId.get("a-absent"), pathAShape(aAbsent, EVENT_WITH_VENUE));
    assert.deepEqual(byId.get("a-fallback"), pathAShape(aNoVenue, EVENT_NO_VENUE), "a none-mode post still lends the venue when the event has none");
    assert.equal(byId.get("a-fallback")!.venueName, "Hotel Alfama");
    assert.deepEqual(byId.get("a-released"), { // census-media MD79 (lead ruling D-26f): no published_at read ⇒ the place window has ended ⇒ withheld, exactly as B2's modes
      ...pathAShape(aReleased, EVENT_WITH_VENUE),
      venueName: EVENT_WITH_VENUE.location_name ?? null,
      publicLat: null,
      publicLng: null,
    });
    assert.ok(!JSON.stringify(byId.get("a-released")).includes("Hotel Alfama"), "the post's venue appears nowhere");
    assert.deepEqual(byId.get("b-none"), pathBShape(bNone));
    assert.deepEqual(byId.get("b-released"), pathBShape(bReleased));
  });

  it("B2. event link: a withheld post never lends its venue, and carries no coordinates", async () => {
    const posts = WITHHOLDING_MODES.flatMap((m, i) => [
      discoveryPost(`a-venue-${i}`, m),
      discoveryPost(`a-novenue-${i}`, m),
    ]);
    // One event per post: the module caps a page at three posts per event, and
    // this case is about the venue, not the diversity cap.
    const eventOf = (p: Row) => ({ ...(p.id.startsWith("a-venue") ? EVENT_WITH_VENUE : EVENT_NO_VENUE), id: `ev-${p.id}` });
    const { db } = discoveryDb({ post_event_links: posts.map((p) => linkRow(p, eventOf(p))) });
    const out = await fetchEventPostsForDiscovery(discoveryParams(db, VIEWER));
    const byId = new Map(out.map((p) => [p.id, p]));
    assert.equal(out.length, posts.length, "precondition: every post is on the page");
    for (const p of posts) {
      const event = eventOf(p);
      const served = byId.get(p.id);
      assert.ok(served, `${p.location_privacy_mode}: still listed under the event its author linked it to`);
      assert.deepEqual(served, {
        ...pathAShape(p, event),
        venueName: event.location_name ?? null, // the EVENT's venue, never the post's
        publicLat: null,
        publicLng: null,
      }, `${p.location_privacy_mode} / ${event.id}`);
      assert.ok(!JSON.stringify(served).includes("Hotel Alfama"), `${p.location_privacy_mode}: the post's venue appears nowhere`);
    }
  });

  it("B3. venue category: a withheld post is not listed at all — it was chosen BECAUSE of the place it withholds", async () => {
    const rows = WITHHOLDING_MODES.map((m, i) => placeRow(discoveryPost(`b-${i}`, m)));
    const { db } = discoveryDb({ posts: rows });
    const out = await fetchEventPostsForDiscovery(discoveryParams(db, VIEWER));
    assert.deepEqual(out, [], "no withheld post is listed under its own place");
  });

  it("B4. an unknown mode fails closed on both paths", async () => {
    const a = discoveryPost("a-unknown", UNKNOWN_MODE);
    const b = discoveryPost("b-unknown", UNKNOWN_MODE);
    const { db } = discoveryDb({ post_event_links: [linkRow(a, EVENT_NO_VENUE)], posts: [placeRow(b)] });
    const out = await fetchEventPostsForDiscovery(discoveryParams(db, VIEWER));
    assert.deepEqual(out, [{ ...pathAShape(a, EVENT_NO_VENUE), venueName: null, publicLat: null, publicLng: null }]);
  });

  it("B5. the OWNER sees their own withheld posts in full on both paths — from the SAME cache entry a non-owner is redacted from", async () => {
    const a = discoveryPost("a-own", "city_only");
    const b = discoveryPost("b-own", "hidden");
    const f = discoveryDb({ post_event_links: [linkRow(a, EVENT_NO_VENUE)], posts: [placeRow(b)] });
    const owner = await fetchEventPostsForDiscovery(discoveryParams(f.db, AUTHOR));
    const readsAfterOwner = f.reads.length;
    const other = await fetchEventPostsForDiscovery(discoveryParams(f.db, VIEWER));
    assert.equal(f.reads.length, readsAfterOwner, "precondition: the second call was served from the (city, radius) cache");
    const mine = new Map(owner.map((p) => [p.id, p]));
    assert.deepEqual(mine.get("a-own"), pathAShape(a, EVENT_NO_VENUE), "owner: event link in full, own venue included");
    assert.deepEqual(mine.get("b-own"), pathBShape(b), "owner: venue category in full");
    assert.deepEqual(other.map((p) => p.id), ["a-own"], "non-owner, same cache: the venue-category listing is withheld");
    assert.equal(other[0]!.venueName, null);
    // And the other way round: a non-owner first must not poison the owner's view.
    _clearEventPostsCache();
    const f2 = discoveryDb({ post_event_links: [linkRow(a, EVENT_NO_VENUE)], posts: [placeRow(b)] });
    await fetchEventPostsForDiscovery(discoveryParams(f2.db, VIEWER));
    const ownerAfter = await fetchEventPostsForDiscovery(discoveryParams(f2.db, AUTHOR));
    assert.deepEqual(new Map(ownerAfter.map((p) => [p.id, p])).get("b-own"), pathBShape(b));
  });

  it("B7. the page a non-owner gets is the page as scored and capped, minus entries: a withheld post cannot win a slot by losing its coordinates", async () => {
    // One event, four posts, one timestamp, one engagement. The withheld post
    // carries coordinates 90 km from the viewer (a legacy or seeded row: the
    // write path leaves public_lat/lng null for a withholding mode), so it scores
    // lowest and the three-per-event cap drops it. Redacting BEFORE scoring would
    // null its coordinates, lift its proximity score to the maximum, and let it
    // push a none-mode post off the page.
    const far = { public_lat: 38.71 + 0.81, public_lng: -9.13 };
    const w = discoveryPost("cap-w", "city_only", far);
    const ns = [1, 2, 3].map((i) => discoveryPost(`cap-n${i}`, "none", { public_lat: 38.71, public_lng: -9.13 }));
    const event = { ...EVENT_WITH_VENUE, id: "ev-cap" };
    const { db } = discoveryDb({ post_event_links: [w, ...ns].map((p) => linkRow(p, event)) });
    const out = await fetchEventPostsForDiscovery(discoveryParams(db, VIEWER));
    assert.deepEqual(out.map((p) => p.id), ["cap-n1", "cap-n2", "cap-n3"], "the three none-mode posts, as before; the withheld one stays capped out");
    for (const [i, p] of out.entries()) assert.deepEqual(p, pathAShape(ns[i]!, event));
  });

  it("B6. both paths SELECT location_privacy_mode", async () => {
    const f = discoveryDb({});
    await fetchEventPostsForDiscovery(discoveryParams(f.db, VIEWER));
    const pathA = f.selects.find((s) => s.table === "post_event_links");
    const pathB = f.selects.find((s) => s.table === "posts" && s.cols.includes("discovery_places"));
    assert.ok(pathA && pathB, "precondition: both paths were read");
    assert.match(pathA!.cols, /posts!inner\s*\([^)]*\blocation_privacy_mode\b/s, "Path A's posts embed carries the mode");
    assert.match(pathB!.cols, /\blocation_privacy_mode\b/, "Path B's posts read carries the mode");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. GET /api/trips/:tripId/posts
// ═══════════════════════════════════════════════════════════════════════════

const TRIP = "00000000-0000-0000-0000-00000000c0de";

function tripRow(id: string, mode: string | null, over: Row = {}): Row {
  return {
    id, trip_id: TRIP, author_id: "author-1", content: `post ${id}`,
    media_urls: [], visibility: "public", status: "active", post_status: "published",
    created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-20T10:00:00Z",
    location_name: "Hotel Alfama", location_city: "Lisbon", location_country: "Portugal",
    location_privacy_mode: mode,
    // What safeLocationLabel stored for a trusted_circle_only post before §36: the venue.
    public_location_label: "Hotel Alfama",
    public_lat: null, public_lng: null,
    ...over,
  };
}

/** The served object restated from the pre-change route (5956c6233): the row, spread, plus the route's own keys. */
function tripShape(row: Row, viewerIsMember: boolean): Row {
  const canEngage = row.visibility === "public" || (row.visibility === "trip_only" && viewerIsMember);
  return {
    ...row,
    author: null,
    likeCount: 0, commentCount: 0, likedByMe: false,
    saveCount: 0, savedByMe: false, stampCount: 0, isStampedByViewer: false,
    canLike: canEngage, canComment: canEngage, canShare: canEngage,
    tags: [], hashtagUsages: [], media: [],
  };
}

function tripState(posts: Row[]): FakeState {
  return {
    users: { "author-tok": { id: "author-1" }, "stranger-tok": { id: "stranger-1" } },
    trips: new Set([TRIP]),
    members: [{ trip_id: TRIP, user_id: "author-1", role: "owner" }],
    posts,
  };
}

async function tripFeed(token: string, posts: Row[]) {
  const { baseUrl, close } = await startApp(tripState(posts));
  try {
    const res = await fetch(`${baseUrl}/api/trips/${TRIP}/posts`, { headers: { Authorization: BEARER(token), connection: "close" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    return new Map<string, any>((body.posts as any[]).map((p) => [p.id, p]));
  } finally {
    await close();
  }
}

describe("C. GET /api/trips/:tripId/posts — the Wall's redactor, which this reader never applied", () => {
  it("C1. `none`-mode, absent-mode and released delayed posts are served EXACTLY as before — a released 'After I leave' post inside its 24 h place window", async () => {
    const rows = [
      tripRow("t-none", "none", { public_location_label: "Hotel Alfama" }),
      tripRow("t-absent", null),
      // POST_COLUMNS selects published_at (routes/posts.ts), so this reader has the MD79 window.
      tripRow("t-released", "delayed_until_exit", { public_lat: 38.711, public_lng: -9.13, published_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    ];
    const served = await tripFeed("stranger-tok", rows);
    for (const row of rows) assert.deepEqual(served.get(row.id), tripShape(row, false), String(row.location_privacy_mode));
  });

  it("C1b. census-media MD79 (lead ruling D-26f): once the 24 h window has ended, the venue, its label and the exact public point go; the city stays", async () => {
    const ended = tripRow("t-ended", "delayed_until_exit", { public_lat: 38.711, public_lng: -9.13, published_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    const served = await tripFeed("stranger-tok", [ended]);
    assert.deepEqual(served.get("t-ended"), { ...tripShape(ended, false), location_name: null, public_location_label: "Lisbon, Portugal", public_lat: null, public_lng: null });
    assert.ok(!JSON.stringify(served.get("t-ended")).includes("Hotel Alfama"), "the venue appears nowhere");
  });

  it("C2. a withholding mode reaches a non-owner without the venue, and with a label rebuilt from city/country", async () => {
    const rows = WITHHOLDING_MODES.map((m, i) => tripRow(`t-w${i}`, m));
    const served = await tripFeed("stranger-tok", rows);
    for (const row of rows) {
      const label = row.location_privacy_mode === "hidden" ? null : "Lisbon, Portugal";
      assert.deepEqual(
        served.get(row.id),
        { ...tripShape(row, false), location_name: null, public_location_label: label },
        String(row.location_privacy_mode),
      );
      assert.ok(!JSON.stringify(served.get(row.id)).includes("Hotel Alfama"), `${row.location_privacy_mode}: the venue appears nowhere`);
    }
  });

  it("C3. an unknown mode fails closed", async () => {
    const row = tripRow("t-unknown", UNKNOWN_MODE);
    const served = await tripFeed("stranger-tok", [row]);
    assert.deepEqual(served.get("t-unknown"), { ...tripShape(row, false), location_name: null, public_location_label: "Lisbon, Portugal" });
  });

  it("C4. the OWNER still sees their own post in full, whatever its mode", async () => {
    const rows = [...WITHHOLDING_MODES, UNKNOWN_MODE].map((m, i) => tripRow(`t-own${i}`, m));
    const served = await tripFeed("author-tok", rows);
    for (const row of rows) assert.deepEqual(served.get(row.id), tripShape(row, true), String(row.location_privacy_mode));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. postPlaceWithheld IS mapPublicPost's decision — it cannot drift from it
// ═══════════════════════════════════════════════════════════════════════════

describe("D. postPlaceWithheld ≡ mapPublicPost, over every mode × post_status", () => {
  const statuses = ["published", "pending_location_exit", "pending_delay", "pending_safety_review", "draft", null, undefined];
  const modes: Array<string | null | undefined> = [...locationPrivacyMode.options, UNKNOWN_MODE, "", null, undefined];

  it("D1. withheld exactly when mapPublicPost redacts the venue", () => {
    let withheld = 0;
    let passed = 0;
    for (const mode of modes) {
      for (const status of statuses) {
        const row: Row = { location_name: "Hotel Alfama", location_city: "Lisbon", location_country: "Portugal", public_location_label: "Hotel Alfama" };
        if (mode !== undefined) row.location_privacy_mode = mode;
        if (status !== undefined) row.post_status = status;
        const redacted = mapPublicPost(row);
        const w = postPlaceWithheld(row);
        assert.equal(w, redacted.location_name === null, `mode=${String(mode)} status=${String(status)}`);
        if (w) withheld++; else passed++;
      }
    }
    assert.ok(withheld > 0 && passed > 0, "precondition: both outcomes are exercised");
  });

  it("D2. the table, stated: none/absent and a released delayed post pass; everything else is withheld", () => {
    const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // inside the MD79 24 h window
    const w = (mode: string | null | undefined, post_status: string | null = "published") =>
      postPlaceWithheld({ location_privacy_mode: mode, post_status, published_at: RECENT });
    assert.equal(w("none"), false);
    assert.equal(w(null), false);
    assert.equal(w(undefined), false);
    assert.equal(w("delayed_until_exit"), false);
    assert.equal(postPlaceWithheld({ location_privacy_mode: "delayed_until_exit", post_status: "published" }), true, "MD79: a released 'After I leave' row read WITHOUT published_at has ended (fail closed)");
    assert.equal(postPlaceWithheld({ location_privacy_mode: "delayed_until_exit", post_status: "published", published_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }), true, "MD79: …and so has one past its 24 h window");
    assert.equal(w("delayed_until_time"), false);
    assert.equal(w("delayed_until_exit", "pending_location_exit"), true, "an unreleased delayed post is withheld");
    for (const m of WITHHOLDING_MODES) assert.equal(w(m), true, m);
    assert.equal(w(UNKNOWN_MODE), true, "unknown ⇒ withheld (fail closed)");
  });
});
