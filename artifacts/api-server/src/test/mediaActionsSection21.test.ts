/**
 * mediaActionsSection21 — census-media §21: the §15 / §15.2 / §49-phase-6
 * actions the media rail was missing, each resolving to an EXISTING endpoint
 * and offered only when the viewer passes the question that endpoint asks.
 *
 *   MD94  — Go There / Directions → GET /api/places/:placeId/living (directionsUrl)
 *   MD101 — Find Quieter / Cheaper → POST /api/compass/ask with the comparator axis
 *   MD103 — View Event → the event experience; View Passport → the Postcard
 *   MD104 — Share through Telegraph → POST /api/threads/:threadId/share (§5 contract)
 *   MD107 — Do This Experience → the COMPILED, timed plan, from a trip, event or Trail
 *
 * Fake Supabase clients only.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/mediaActionsSection21.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { isLocationSafe } from "../lib/media/mediaLocationSafety.js";
import { resolveViewer } from "../services/media/MediaProjectionService.js";
import { resolveMediaActions } from "../services/media/MediaActionResolver.js";
import { shareableFor } from "../services/telegraph/shareables.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";

type Dataset = Record<string, any[]>;

function makeSc(data: Dataset) {
  const resolveRows = (table: string, filters: Array<(r: any) => boolean>) =>
    (data[table] ?? []).map((r) => ({ ...r })).filter((r) => filters.every((f) => f(r)));
  const builder = (table: string): any => {
    const filters: Array<(r: any) => boolean> = [];
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push((r) => String(r[col]) === String(val)); return b; },
      neq(col: string, val: any) { filters.push((r) => String(r[col]) !== String(val)); return b; },
      in(col: string, val: any[]) { const v = val.map(String); filters.push((r) => v.includes(String(r[col]))); return b; },
      gt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] > val); return b; },
      gte() { return b; },
      lte() { return b; },
      is(col: string, val: any) { filters.push((r) => (r[col] ?? null) === val); return b; },
      ilike() { return b; },
      like(col: string, val: any) { const pre = String(val).replace(/%$/, ""); filters.push((r) => String(r[col] ?? "").startsWith(pre)); return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve({ data: resolveRows(table, filters), error: null }).then(onF, onR); },
    };
    return b;
  };
  return {
    from(table: string) { return builder(table); },
    rpc() { return Promise.resolve({ data: null, error: { message: "no rpc in this fake" } }); },
    auth: { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) },
  } as any;
}

const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR_A = "22222222-2222-2222-2222-222222222222";
const PLACE_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TRIP_1 = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const MEDIA_1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const EVENT_1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TRAIL_1 = "99999999-9999-9999-9999-999999999999";
const POSTCARD_1 = "88888888-8888-8888-8888-888888888888";
const DRAFT_TRAIL = "77777777-7777-7777-7777-777777777777";

function makePost(o: Record<string, any> = {}): any {
  const id = o.id ?? MEDIA_1;
  const author = o.author_id ?? AUTHOR_A;
  return {
    id,
    author_id: author,
    trip_id: o.trip_id ?? null,
    content: "",
    visibility: o.visibility ?? "public",
    status: "active",
    post_status: "published",
    moderation_status: null,
    publish_at: null,
    expires_at: null,
    deleted_at: null,
    updated_at: new Date().toISOString(),
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    category: "nightlife",
    media_urls: [],
    location_name: "An Thuong Bar",
    location_city: "Da Nang",
    location_country: "Vietnam",
    location_privacy_mode: o.location_privacy_mode ?? "none",
    canonical_place_id: o.canonical_place_id === undefined ? PLACE_1 : o.canonical_place_id,
    post_media: [{ id: `${id}-m1`, media_type: "image", public_url: `https://cdn.example/${id}.jpg`, thumbnail_url: null, duration_seconds: null, width: 1080, height: 1080, sort_order: 0, processing_status: "ready", moderation_status: null }],
    profiles: { id: author, username: "maya", full_name: "Maya", name: "Maya", display_name: "Maya", avatar_url: null, verified: true, is_official: false, account_status: "active", is_private: false },
    location_lat: 16.0544,
    location_lng: 108.2497,
  };
}

function baseData(extra: Dataset = {}): Dataset {
  return {
    profiles: [
      { id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" },
      { id: AUTHOR_A, account_status: "active", passport_visibility: "public", is_private: false },
    ],
    blocks: [], user_mutes: [], user_follows: [], trip_members: [], trips: [], hidden_gems: [],
    feature_flags: [], intel_state_snapshots: [], intel_live_promoted_scopes: [],
    ...extra,
  };
}

function editableTrip(): Dataset {
  return {
    trips: [{ id: TRIP_1, owner_id: AUTHOR_A, plan_edit_permission: "all_members", visibility: "public", title: "Da Nang week", start_date: null, end_date: null }],
    trip_members: [{ trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "accepted" }],
  };
}

async function actionsFor(data: Dataset, mediaId = MEDIA_1) {
  const sc = makeSc(data);
  const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
  return resolveMediaActions(sc, viewer, mediaId, Date.now());
}

beforeEach(() => {
  invalidateFlagsCache();
  _clearPromotedScopeCache();
});

// ── MD94 ──────────────────────────────────────────────────────────────────────

describe("MD94 — Go There / Directions", () => {
  it("is offered for a disclosed place and targets the canonical Places page that carries directionsUrl", async () => {
    const set = await actionsFor(baseData({ posts: [makePost()] }));
    const a = set!.actions.find((x) => x.id === "directions");
    assert.ok(a, "directions offered");
    assert.equal(a!.target.method, "GET");
    assert.equal(a!.target.endpoint, "/api/places/:placeId/living");
    assert.equal(a!.target.params?.placeId, PLACE_1);
    assert.equal(isLocationSafe(set), true, "no coordinate on the rail — the Places page owns the route");
  });

  it("is NOT offered when the owner kept the exact place private (city_only), exactly like show_on_map", async () => {
    const set = await actionsFor(baseData({ posts: [makePost({ location_privacy_mode: "city_only" })] }));
    const ids = set!.actions.map((x) => x.id);
    assert.equal(ids.includes("show_on_map"), false, "control: the place was withheld");
    assert.equal(ids.includes("directions"), false, "no route to a withheld venue");
  });

  it("is NOT offered for media bound to no place", async () => {
    const set = await actionsFor(baseData({ posts: [makePost({ canonical_place_id: null })] }));
    assert.equal(set!.actions.some((x) => x.id === "directions"), false);
  });
});

// ── MD104 ─────────────────────────────────────────────────────────────────────

describe("MD104 — Share through Telegraph uses Telegraph's own share contract", () => {
  it("targets POST /api/threads/:threadId/share with a POST reference — not the media share recorder", async () => {
    const set = await actionsFor(baseData({ posts: [makePost()] }));
    const a = set!.actions.find((x) => x.id === "share_telegraph");
    assert.ok(a);
    assert.equal(a!.target.endpoint, "/api/threads/:threadId/share");
    assert.deepEqual(a!.target.params, { objectType: "POST", objectId: MEDIA_1 });
  });

  it("asks the question Telegraph's POST loader asks: a followers-only post seen through a follow is NOT offered", async () => {
    const data = baseData({
      posts: [makePost({ visibility: "followers" })],
      user_follows: [{ follower_id: VIEWER, following_id: AUTHOR_A, status: "accepted" }],
    });
    const set = await actionsFor(data);
    assert.ok(set, "control: the viewer CAN see the item (follows the author)");
    assert.equal(set!.actions.some((x) => x.id === "share_telegraph"), false);
    // …and the endpoint agrees: Telegraph would refuse the sender.
    const state = await shareableFor(makeSc(data), "POST", MEDIA_1)!.getCurrentState(VIEWER);
    assert.equal(state.available, false);
  });

  it("the author may share their own followers-only post, and Telegraph agrees", async () => {
    const data = baseData({ posts: [makePost({ visibility: "followers", author_id: VIEWER })] });
    const set = await actionsFor(data);
    assert.ok(set!.actions.some((x) => x.id === "share_telegraph"));
    const state = await shareableFor(makeSc(data), "POST", MEDIA_1)!.getCurrentState(VIEWER);
    assert.equal(state.available, true);
  });
});

// ── MD103 ─────────────────────────────────────────────────────────────────────

function eventRow(o: Record<string, unknown> = {}) {
  return { id: EVENT_1, host_id: AUTHOR_A, title: "Beach Festival", visibility: "public", state: "open", starts_at: null, ends_at: null, place_id: null, age_min: null, age_max: null, trust_score_min: null, verified_only: false, ...o };
}

describe("MD103 — View Event / View Passport", () => {
  it("View Event is offered for a linked PUBLIC event and targets the event experience", async () => {
    const set = await actionsFor(baseData({ posts: [makePost()], post_event_links: [{ post_id: MEDIA_1, event_id: EVENT_1 }], events: [eventRow()], event_roles: [], event_rsvps: [] }));
    const a = set!.actions.find((x) => x.id === "view_event");
    assert.ok(a, "view_event offered");
    assert.equal(a!.target.endpoint, "/api/media/experiences/:experienceId");
    assert.equal(a!.target.params?.experienceId, EVENT_1);
  });

  it("View Event is NOT offered for a private event the viewer does not attend — not its id either", async () => {
    const set = await actionsFor(baseData({ posts: [makePost()], post_event_links: [{ post_id: MEDIA_1, event_id: EVENT_1 }], events: [eventRow({ visibility: "private" })], event_roles: [], event_rsvps: [] }));
    assert.equal(set!.actions.some((x) => x.id === "view_event"), false);
    assert.equal(JSON.stringify(set).includes(EVENT_1), false, "a private event's id must not reach the rail");
  });

  it("View Passport is offered for an ACTIVE, PUBLIC Postcard whose author's passport is public", async () => {
    const set = await actionsFor(baseData({ posts: [makePost()], passport_postcards: [{ id: POSTCARD_1, post_id: MEDIA_1, user_id: AUTHOR_A, status: "active", visibility: "public", deleted_at: null }] }));
    const a = set!.actions.find((x) => x.id === "view_passport");
    assert.ok(a, "view_passport offered");
    assert.equal(a!.target.endpoint, "/api/posts/:id");
    assert.equal(a!.target.params?.id, MEDIA_1);
  });

  it("View Passport is NOT offered when the author's passport is private, or the postcard is not active", async () => {
    const privatePassport = baseData({
      posts: [makePost()],
      passport_postcards: [{ id: POSTCARD_1, post_id: MEDIA_1, user_id: AUTHOR_A, status: "active", visibility: "public", deleted_at: null }],
    });
    privatePassport.profiles = privatePassport.profiles.map((p) => (p.id === AUTHOR_A ? { ...p, passport_visibility: "private" } : p));
    assert.equal((await actionsFor(privatePassport))!.actions.some((x) => x.id === "view_passport"), false);
    const removed = baseData({ posts: [makePost()], passport_postcards: [{ id: POSTCARD_1, post_id: MEDIA_1, user_id: AUTHOR_A, status: "removed", visibility: "public", deleted_at: null }] });
    assert.equal((await actionsFor(removed))!.actions.some((x) => x.id === "view_passport"), false);
    const noPostcard = baseData({ posts: [makePost()] });
    assert.equal((await actionsFor(noPostcard))!.actions.some((x) => x.id === "view_passport"), false);
  });

  it("the author sees View Passport on their own postcard even when their passport is private", async () => {
    const data = baseData({
      posts: [makePost({ author_id: VIEWER })],
      passport_postcards: [{ id: POSTCARD_1, post_id: MEDIA_1, user_id: VIEWER, status: "active", visibility: "private", deleted_at: null }],
    });
    assert.ok((await actionsFor(data))!.actions.some((x) => x.id === "view_passport"));
  });

  // The writer (lib/mediaEventLinks): the AUTHOR links their own post to an
  // event they took part in. Same predicate as POST /media/:id/event-link.
  const nearNow = { starts_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), ends_at: new Date(Date.now() + 3_600_000).toISOString() };
  const SHELL_ON = { flag: "MEDIA_WORLD_SHELL_ENABLED", enabled: true };

  it("Link to an event is offered to the AUTHOR, for the event they are going to, and targets the link endpoint", async () => {
    const set = await actionsFor(baseData({
      posts: [makePost({ author_id: VIEWER })],
      events: [eventRow(nearNow)],
      event_roles: [],
      event_rsvps: [{ event_id: EVENT_1, user_id: VIEWER, status: "going" }],
      feature_flags: [SHELL_ON],
    }));
    const a = set!.actions.find((x) => x.id === "link_event");
    assert.ok(a, "link_event offered");
    assert.equal(a!.target.method, "POST");
    assert.equal(a!.target.endpoint, "/api/media/:id/event-link");
    assert.deepEqual((a!.target.params?.candidates as any[]).map((c) => c.eventId), [EVENT_1]);
  });

  it("Link to an event is NOT offered: to a non-author, while the shell flag is off, for a non-participant, or once linked", async () => {
    const going = { event_rsvps: [{ event_id: EVENT_1, user_id: VIEWER, status: "going" }], event_roles: [] };
    const notAuthor = await actionsFor(baseData({ posts: [makePost()], events: [eventRow(nearNow)], ...going, feature_flags: [SHELL_ON] }));
    assert.equal(notAuthor!.actions.some((x) => x.id === "link_event"), false, "not the author");
    const flagOff = await actionsFor(baseData({ posts: [makePost({ author_id: VIEWER })], events: [eventRow(nearNow)], ...going, feature_flags: [] }));
    assert.equal(flagOff!.actions.some((x) => x.id === "link_event"), false, "shell flag off");
    const notGoing = await actionsFor(baseData({ posts: [makePost({ author_id: VIEWER })], events: [eventRow(nearNow)], event_rsvps: [], event_roles: [], feature_flags: [SHELL_ON] }));
    assert.equal(notGoing!.actions.some((x) => x.id === "link_event"), false, "not a participant");
    const linked = await actionsFor(baseData({
      posts: [makePost({ author_id: VIEWER })], events: [eventRow(nearNow)], ...going, feature_flags: [SHELL_ON],
      post_event_links: [{ post_id: MEDIA_1, event_id: EVENT_1 }],
    }));
    assert.equal(linked!.actions.some((x) => x.id === "link_event"), false, "already linked");
    assert.ok(linked!.actions.some((x) => x.id === "view_event"), "and View Event is what the link made reachable");
  });
});

// ── MD101 ─────────────────────────────────────────────────────────────────────

describe("MD101 — Find Quieter / Cheaper reach Compass with the comparator it grounds", () => {
  it("offered when Compass is on and a place anchors the comparison", async () => {
    const set = await actionsFor(baseData({ posts: [makePost()], feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }] }));
    const q = set!.actions.find((x) => x.id === "find_quieter");
    const c = set!.actions.find((x) => x.id === "find_cheaper");
    assert.ok(q && c);
    assert.equal(q!.target.endpoint, "/api/compass/ask");
    assert.equal(q!.target.params?.comparator, "quieter");
    assert.equal(c!.target.params?.comparator, "cheaper");
    // The ask carries THIS media item, which is what makes Compass build the
    // §32 media context (and its comparator baselines) for the anchor place.
    assert.equal(q!.target.params?.mediaId, MEDIA_1);
    assert.equal(c!.target.params?.mediaId, MEDIA_1);
  });

  it("absent when Compass is off, and absent with no anchor place", async () => {
    const off = await actionsFor(baseData({ posts: [makePost()] }));
    assert.equal(off!.actions.some((x) => x.id === "find_quieter" || x.id === "find_cheaper"), false);
    const noPlace = await actionsFor(baseData({ posts: [makePost({ canonical_place_id: null })], feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }] }));
    assert.equal(noPlace!.actions.some((x) => x.id === "find_quieter"), false);
  });
});

// ── MD383 / MD400 ─────────────────────────────────────────────────────────────

describe("MD383 / MD400 — Update this gem, from the media, reaches the gem's own contribution endpoint", () => {
  const GEM = "66666666-6666-6666-6666-666666666666";
  const gem = (o: Record<string, unknown> = {}) => ({ id: GEM, name: "Quiet cove", status: "active", sensitivity_level: "public", canonical_place_id: PLACE_1, submitted_by: AUTHOR_A, ...o });

  it("offered for a disclosable gem while hidden_gems_enabled, carrying the media id", async () => {
    const set = await actionsFor(baseData({ posts: [makePost()], hidden_gems: [gem()], feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }] }));
    const a = set!.actions.find((x) => x.id === "contribute_gem");
    assert.ok(a);
    assert.equal(a!.target.endpoint, "/api/hidden-gems/:id/contribute");
    assert.deepEqual(a!.target.params, { id: GEM, originMediaId: MEDIA_1 });
  });

  it("absent with the flag off, and absent for a gem the viewer may not be told about", async () => {
    const off = await actionsFor(baseData({ posts: [makePost()], hidden_gems: [gem()] }));
    assert.equal(off!.actions.some((x) => x.id === "contribute_gem"), false);
    const hidden = await actionsFor(baseData({ posts: [makePost()], hidden_gems: [gem({ sensitivity_level: "protected" })], feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }] }));
    assert.equal(hidden!.actions.some((x) => x.id === "contribute_gem"), false);
    assert.equal(JSON.stringify(hidden).includes(GEM), false, "no id of an undisclosable gem");
  });
});

// ── MD107 ─────────────────────────────────────────────────────────────────────

describe("MD107 — Do This Experience compiles an EXECUTABLE plan", () => {
  it("a trip experience targets the compiled-plan endpoint", async () => {
    const set = await actionsFor(baseData({ posts: [makePost({ trip_id: TRIP_1 })], ...editableTrip() }));
    const a = set!.actions.find((x) => x.id === "do_this_experience");
    assert.ok(a);
    assert.equal(a!.target.method, "GET");
    assert.equal(a!.target.endpoint, "/api/media/experiences/:experienceId/plan");
    assert.equal(a!.target.params?.compile, true);
    assert.equal(a!.target.params?.source, "experience");
  });

  it("a post in a PUBLISHED trail offers Do This Trail; a draft trail or no editable trip offers nothing", async () => {
    const trailData = (lifecycle: string, withTrip = true) => baseData({
      posts: [makePost()],
      content_trails: [{ trail_id: TRAIL_1, source_type: "post", source_id: MEDIA_1 }],
      trails: [{ id: TRAIL_1, review_state: "approved", lifecycle_status: lifecycle, title: "Night walk" }],
      ...(withTrip ? { trips: editableTrip().trips, trip_members: editableTrip().trip_members } : {}),
    });
    const pub = await actionsFor(trailData("published"));
    const a = pub!.actions.find((x) => x.id === "do_this_experience");
    assert.ok(a, "trail source offered");
    assert.equal(a!.target.params?.source, "trail");
    assert.equal(a!.target.params?.experienceId, TRAIL_1);
    assert.equal((await actionsFor(trailData("draft")))!.actions.some((x) => x.id === "do_this_experience"), false);
    assert.equal((await actionsFor(trailData("published", false)))!.actions.some((x) => x.id === "do_this_experience"), false);
  });

  describe("GET /media/experiences/:id/plan?compile=1 serves the compiled plan", () => {
    let server: ReturnType<typeof createServer> | null = null;
    after(() => { server?.close(); _clearTestClient(); });

    it("returns timed stops for a trail, and 404 for a draft one", async () => {
      const express = (await import("express")).default;
      const { default: router } = await import("../routes/mediaActions.js");
      const data = baseData({
        trails: [{ id: TRAIL_1, review_state: "approved", lifecycle_status: "published", title: "Night walk" }, { id: DRAFT_TRAIL, review_state: "approved", lifecycle_status: "draft", title: "WIP" }],
        content_trails: [
          { trail_id: TRAIL_1, source_type: "place", source_id: PLACE_1, content_state: "published", created_at: "2026-01-01T00:00:00Z" },
          { trail_id: TRAIL_1, source_type: "place", source_id: "place-2", content_state: "published", created_at: "2026-01-02T00:00:00Z" },
        ],
        ...editableTrip(),
      });
      const sc = makeSc(data);
      _setTestClient(sc, true);
      const app = express();
      app.use((req: any, _res: any, next: any) => { req.log = { info() {}, error() {}, warn() {}, debug() {} }; next(); });
      app.use("/api", router);
      server = createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const port = (server.address() as any).port;
      const hit = await fetch(`http://127.0.0.1:${port}/api/media/experiences/${TRAIL_1}/plan?compile=1&source=trail&day=2026-10-03`, { headers: { Authorization: "Bearer t" } });
      assert.equal(hit.status, 200);
      const body: any = await hit.json();
      assert.equal(body.compiled.source.kind, "trail");
      assert.equal(body.compiled.day, "2026-10-03");
      assert.equal(body.compiled.stops.length, 2);
      assert.ok(body.compiled.stops[0].startsAt < body.compiled.stops[1].startsAt, "stops are timed and ordered");
      const draft = await fetch(`http://127.0.0.1:${port}/api/media/experiences/${DRAFT_TRAIL}/plan?compile=1&source=trail`, { headers: { Authorization: "Bearer t" } });
      assert.equal(draft.status, 404);
    });
  });
});
