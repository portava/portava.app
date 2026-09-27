/**
 * discoverySearchSafetyContracts — the NEGATIVE paths of search safety, run
 * against GET /discovery/search and GET /discovery/suggest (census-discovery
 * §46: C01–C10, C12–C15, B06–B09, A12 re-verified).
 *
 * The existing suites (discoverySearch.test.ts, discoveryPrivacy.test.ts,
 * discoverySearchBlockedSubmitter.test.ts, discoveryRefusalD11.test.ts) prove
 * most rules on ONE type at a time, mostly in one direction, mostly on the
 * happy path. What they did not hold, measured before this file was written:
 *
 *   • the BLOCKED-ME direction for content (only travelers and submitters had it);
 *   • suspension, deletion and age restriction on posts, circles and plans;
 *   • any rule through `type=all` or through /discovery/suggest as a MATRIX;
 *   • REVOCATION between two requests — a block, opt-out, suspension, age
 *     restriction or visibility change taken after the first page was served;
 *   • a CURSOR carried across a revocation;
 *   • the owner-status read failing on its own (not the whole of `profiles`);
 *   • a transient policy failure followed by recovery (no negative caching).
 *
 * One fixture world, one query token ("zork") every row matches, and one owner
 * per rule so a leak names the rule that leaked.
 *
 * Run: node --import tsx/esm --test src/test/discoverySearchSafetyContracts.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import discoverySearchRouter from "../routes/discoverySearch.js";
import { invalidateBuddyLaunchGateCache } from "../routes/discoverySearch.js";
import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import {
  VIEWER,
  installKit,
  kitGet,
  startKitServer,
  type KitState,
} from "./discoverySearchTestKit.js";

// ── The cast: one owner per rule ─────────────────────────────────────────────
const ALICE = "b1000000-0000-4000-a000-000000000001"; // visible to the viewer
const BOB   = "b2000000-0000-4000-a000-000000000002"; // the viewer blocked BOB
const CARL  = "b3000000-0000-4000-a000-000000000003"; // CARL blocked the viewer
const DAN   = "b4000000-0000-4000-a000-000000000004"; // suspended
const DEL   = "b5000000-0000-4000-a000-000000000005"; // deleted
const EVE   = "b6000000-0000-4000-a000-000000000006"; // age-restricted
const FAY   = "b7000000-0000-4000-a000-000000000007"; // opted out of profile discovery
const GUS   = "b8000000-0000-4000-a000-000000000008"; // a PRIVATE account (locked preview)

const CAST: Record<string, { id: string; status: string; isPrivate: boolean }> = {
  alice: { id: ALICE, status: "active", isPrivate: false },
  bob:   { id: BOB,   status: "active", isPrivate: false },
  carl:  { id: CARL,  status: "active", isPrivate: false },
  dan:   { id: DAN,   status: "suspended", isPrivate: false },
  del:   { id: DEL,   status: "deleted", isPrivate: false },
  eve:   { id: EVE,   status: "active", isPrivate: false },
  fay:   { id: FAY,   status: "active", isPrivate: false },
  gus:   { id: GUS,   status: "active", isPrivate: true },
};
const NAMES = Object.keys(CAST);

const FUTURE = new Date(Date.now() + 20 * 86_400_000).toISOString();
const FUTURE_DATE = FUTURE.slice(0, 10);

/** A world in which every rule has exactly one owner whose content every query matches. */
function world(): Partial<KitState> {
  const profiles = [
    { id: VIEWER, handle: "viewer", username: "viewer", name: "Viewer", display_name: null, avatar_url: null,
      is_private: false, home_city: null, home_country: null, account_status: "active", verified: false,
      is_official: false, show_profile_picture_publicly: true, buddy_verified_at: null },
    ...NAMES.map((n) => ({
      id: CAST[n]!.id, handle: `zork_${n}`, username: `zork_${n}`, name: `Zork ${n}`, display_name: null,
      avatar_url: `https://cdn/${n}.jpg`, is_private: CAST[n]!.isPrivate, home_city: `Zork${n}ville`,
      home_country: `Zorkland-${n}`, account_status: CAST[n]!.status, verified: false, is_official: false,
      show_profile_picture_publicly: true, buddy_verified_at: "2026-01-01T00:00:00Z",
    })),
  ];
  const owned = (kind: string, n: string) => `${kind}-${n}`;
  return {
    rows: {
      profiles,
      blocks: [
        { blocker_id: VIEWER, blocked_id: BOB },
        { blocker_id: CARL, blocked_id: VIEWER },
      ],
      user_privacy_settings: [{ user_id: EVE, age_restriction_enabled: true }],
      profile_privacy_settings: [{ user_id: FAY, allow_profile_discovery: false, show_real_name: false }],
      user_follows: [], friend_requests: [], user_friendships: [], event_rsvps: [],
      events: [
        ...NAMES.map((n) => ({
          id: owned("event", n), title: `zork event ${n}`, host_id: CAST[n]!.id, cover_url: null, city: "Lisbon",
          country: "PT", starts_at: FUTURE, visibility: "public", state: "open", created_at: "2026-01-01T00:00:00Z",
          location_lat: 38.7, location_lng: -9.1, show_exact_location: true,
        })),
        { id: "event-alice-private", title: "zork event alice private", host_id: ALICE, cover_url: null, city: "Lisbon",
          country: "PT", starts_at: FUTURE, visibility: "private", state: "open", created_at: "2026-01-01T00:00:00Z",
          location_lat: 38.7, location_lng: -9.1, show_exact_location: true },
        { id: "event-alice-draft", title: "zork event alice draft", host_id: ALICE, cover_url: null, city: "Lisbon",
          country: "PT", starts_at: FUTURE, visibility: "public", state: "draft", created_at: "2026-01-01T00:00:00Z",
          location_lat: 38.7, location_lng: -9.1, show_exact_location: true },
      ],
      trips: [
        ...NAMES.map((n) => ({
          id: owned("trip", n), title: `zork trip ${n}`, destination_city: "Lisbon", destination_country: "PT",
          owner_id: CAST[n]!.id, cover_url: null, start_date: FUTURE_DATE, status: "upcoming", visibility: "public",
          show_in_discovery: true, created_at: "2026-01-01T00:00:00Z",
        })),
        { id: "trip-alice-private", title: "zork trip alice private", destination_city: "Lisbon", destination_country: "PT",
          owner_id: ALICE, cover_url: null, start_date: FUTURE_DATE, status: "upcoming", visibility: "private",
          show_in_discovery: true, created_at: "2026-01-01T00:00:00Z" },
        { id: "trip-viewer-private", title: "viewer own trip", destination_city: "Lisbon", destination_country: "PT",
          owner_id: VIEWER, cover_url: null, start_date: FUTURE_DATE, status: "upcoming", visibility: "private",
          show_in_discovery: false, created_at: "2026-01-01T00:00:00Z" },
      ],
      trip_plan_items: [
        ...NAMES.map((n) => ({
          id: owned("plan", n), title: `zork plan ${n}`, trip_id: owned("trip", n), creator_id: CAST[n]!.id,
          created_at: "2026-01-01T00:00:00Z", removed_at: null,
        })),
        { id: "plan-alice-private", title: "zork plan alice private", trip_id: "trip-alice-private", creator_id: ALICE,
          created_at: "2026-01-01T00:00:00Z", removed_at: null },
        { id: "plan-viewer-own", title: "zork plan viewer own", trip_id: "trip-viewer-private", creator_id: VIEWER,
          created_at: "2026-01-01T00:00:00Z", removed_at: null },
      ],
      hidden_gems: [
        ...NAMES.map((n) => ({
          id: owned("gem", n), name: `zork gem ${n}`, city: "Lisbon", country: "PT", submitted_by: CAST[n]!.id,
          category: "food", status: "active", created_at: "2026-01-01T00:00:00Z", sensitivity_level: "approximate",
          approx_latitude: 38.71, approx_longitude: -9.14,
        })),
        { id: "gem-alice-pending", name: "zork gem alice pending", city: "Lisbon", country: "PT", submitted_by: ALICE,
          category: "food", status: "pending", created_at: "2026-01-01T00:00:00Z", sensitivity_level: "approximate",
          approx_latitude: 38.71, approx_longitude: -9.14 },
      ],
      posts: [
        ...NAMES.map((n) => ({
          id: owned("post", n), content: `zork post ${n}`, author_id: CAST[n]!.id, media_urls: [],
          created_at: "2026-01-01T00:00:00Z", like_count: 0, post_status: "published", visibility: "public", status: "active",
        })),
        { id: "post-alice-private", content: "zork post alice private", author_id: ALICE, media_urls: [],
          created_at: "2026-01-01T00:00:00Z", like_count: 0, post_status: "published", visibility: "private", status: "active" },
        { id: "post-alice-pending", content: "zork post alice pending", author_id: ALICE, media_urls: [],
          created_at: "2026-01-01T00:00:00Z", like_count: 0, post_status: "pending", visibility: "public", status: "active" },
      ],
      circles: [
        ...NAMES.map((n) => ({
          id: owned("circle", n), name: `zork circle ${n}`, description: null, owner_id: CAST[n]!.id,
          cover_image_url: null, city: "Lisbon", visibility: "public", created_at: "2026-01-01T00:00:00Z",
        })),
        { id: "circle-alice-private", name: "zork circle alice private", description: null, owner_id: ALICE,
          cover_image_url: null, city: "Lisbon", visibility: "private", created_at: "2026-01-01T00:00:00Z" },
      ],
      discovery_places: [
        ...NAMES.map((n) => ({
          id: owned("place", n), name: `zork place ${n}`, city: "Lisbon", blurb: null, image_url: null,
          header_image_source: null, image_source_type: null, image_accuracy_status: null, category: "food",
          primary_category: "food", lat: 38.72, lng: -9.13, canonical_location_id: null,
          created_at: "2026-01-01T00:00:00Z", submitted_by: CAST[n]!.id, status: "active", saved_count: 0,
        })),
        { id: "place-venue-fact", name: "zork place venue fact", city: "Lisbon", blurb: null, image_url: null,
          header_image_source: null, image_source_type: null, image_accuracy_status: null, category: "food",
          primary_category: "food", lat: 38.72, lng: -9.13, canonical_location_id: null,
          created_at: "2026-01-01T00:00:00Z", submitted_by: null, status: "active", saved_count: 0 },
      ],
      hashtags: [], stamp_definitions: [], canonical_locations: [], wishlist_places: [], discovery_place_saves: [],
    },
  };
}

/** Owners whose CONTENT (events, trips, plans, gems, posts, circles) the viewer may see. */
const CONTENT_VISIBLE = ["alice", "fay", "gus"];
/** Owners whose content must never reach the viewer, each for a different rule. */
const CONTENT_DENIED = ["bob", "carl", "dan", "del", "eve"];

let base = "";
let server: Server;

before(async () => {
  ({ base, server } = await startKitServer(discoverySearchRouter));
});
after(() => server.close());

function fresh(over: Partial<KitState> = world()) {
  invalidateBuddyLaunchGateCache();
  invalidateSearchProtectionFlagCache();
  invalidateDiscoveryTripProjectionFlagCache();
  return installKit(over);
}

async function searchIds(type: string, q = "zork", extra = ""): Promise<{ status: number; ids: string[]; body: any }> {
  const { status, body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent(q)}&type=${type}&limit=50${extra}`);
  return { status, ids: ((body?.results ?? []) as any[]).map((r) => String(r.id)), body };
}

async function suggestIds(q = "zork"): Promise<{ status: number; ids: string[]; body: any }> {
  const { status, body } = await kitGet(base, `/discovery/suggest?q=${encodeURIComponent(q)}`);
  const ids = ((body?.groups ?? []) as any[]).flatMap((g) => (g.items as any[]).map((it) => String(it.id)));
  return { status, ids, body };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The cross-viewer denial matrix
// ═════════════════════════════════════════════════════════════════════════════

describe("cross-viewer denial — every owner-bearing type, both block directions, every account rule", () => {
  for (const kind of ["event", "trip", "plan", "gem", "post", "circle"] as const) {
    const type = { event: "events", trip: "trips", plan: "plans", gem: "hidden_gems", post: "posts", circle: "circles" }[kind];
    it(`${type}: blocked (both directions), suspended, deleted and age-restricted owners are denied; the rest are served`, async () => {
      fresh();
      const { status, ids } = await searchIds(type);
      assert.equal(status, 200);
      for (const n of CONTENT_VISIBLE) assert.ok(ids.includes(`${kind}-${n}`), `${type}: ${n}'s row must be served (control)`);
      for (const n of CONTENT_DENIED) assert.ok(!ids.includes(`${kind}-${n}`), `${type}: ${n}'s row leaked`);
    });
  }

  it("events/trips/posts/circles: private visibility is denied, and a draft or pending row is not public (C05)", async () => {
    fresh();
    const all = [
      ...(await searchIds("events")).ids, ...(await searchIds("trips")).ids,
      ...(await searchIds("posts")).ids, ...(await searchIds("circles")).ids, ...(await searchIds("hidden_gems")).ids,
    ];
    for (const id of ["event-alice-private", "event-alice-draft", "trip-alice-private", "post-alice-private",
      "post-alice-pending", "circle-alice-private", "gem-alice-pending"]) {
      assert.ok(!all.includes(id), `${id} leaked`);
    }
  });

  it("plans: a private trip's plan is denied to others and served to its owner (C06)", async () => {
    fresh();
    const { ids } = await searchIds("plans");
    assert.ok(!ids.includes("plan-alice-private"), "a plan on someone else's private trip leaked");
    assert.ok(ids.includes("plan-viewer-own"), "the viewer's own private-trip plan must be served (control)");
  });

  it("travelers and buddies: blocked (both), suspended, deleted, age-restricted and opted-out are denied; private is a LOCKED preview (C01–C03, C08, C11)", async () => {
    for (const type of ["travelers", "buddies"]) {
      fresh();
      const { status, ids, body } = await searchIds(type);
      assert.equal(status, 200);
      assert.ok(ids.includes(ALICE), `${type}: control`);
      for (const denied of [BOB, CARL, DAN, DEL, EVE, FAY]) assert.ok(!ids.includes(denied), `${type}: ${denied} leaked`);
      const gus = (body.results as any[]).find((r) => r.id === GUS);
      assert.ok(gus, `${type}: a private account is discoverable as a locked preview`);
      assert.equal(gus.accessState.canAccess, false);
      assert.equal(gus.avatarUrl, null, "a locked preview carries no avatar");
      assert.equal(gus.locationPreview, null, "a locked preview carries no location");
    }
  });

  it("places and activities: a submitter blocked in EITHER direction is denied; a venue fact with no submitter is served (C17 rule, search leg)", async () => {
    fresh();
    const { ids } = await searchIds("places");
    assert.ok(ids.includes("place-alice") && ids.includes("place-venue-fact"), "control");
    assert.ok(!ids.includes("place-bob"), "the submitter the viewer blocked leaked");
    assert.ok(!ids.includes("place-carl"), "the submitter who blocked the viewer leaked");
  });

  it("cities and countries: only an active, public, unblocked, unrestricted, opted-in resident contributes (C04, C08, header :24-25)", async () => {
    fresh();
    const cities = (await searchIds("cities")).body.results.map((r: any) => r.title);
    assert.deepEqual(cities, ["Zorkaliceville"], `cities leaked a contributor: ${JSON.stringify(cities)}`);
    const countries = (await searchIds("countries")).body.results.map((r: any) => r.title);
    assert.deepEqual(countries, ["Zorkland-alice"], `countries leaked a contributor: ${JSON.stringify(countries)}`);
  });

  it("type=all: no denied owner's row reaches the fan-out", async () => {
    fresh();
    const { status, ids } = await searchIds("all");
    assert.equal(status, 200);
    assert.ok(ids.includes(ALICE) && ids.includes("event-alice"), "control");
    for (const n of CONTENT_DENIED) {
      for (const kind of ["event", "trip", "plan", "gem", "post", "circle"]) assert.ok(!ids.includes(`${kind}-${n}`), `all: ${kind}-${n} leaked`);
    }
    for (const denied of [BOB, CARL, DAN, DEL, EVE, FAY]) assert.ok(!ids.includes(denied), `all: traveler ${denied} leaked`);
  });

  it("/discovery/suggest: no denied owner's row reaches any group", async () => {
    fresh();
    const { status, ids } = await suggestIds();
    assert.equal(status, 200);
    assert.ok(ids.includes(ALICE), "control");
    for (const n of CONTENT_DENIED) {
      for (const kind of ["event", "trip", "plan", "gem", "post", "circle"]) assert.ok(!ids.includes(`${kind}-${n}`), `suggest: ${kind}-${n} leaked`);
    }
    for (const denied of [BOB, CARL, DAN, DEL, EVE, FAY]) assert.ok(!ids.includes(denied), `suggest: traveler ${denied} leaked`);
    assert.ok(!ids.includes("place-bob") && !ids.includes("place-carl"), "suggest: a blocked submitter's place leaked");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Revocation reaches the NEXT request — there is no server-side cache to wait out
// ═════════════════════════════════════════════════════════════════════════════

type Revocation = { name: string; apply: (s: KitState) => void; denies: string[] };

const REVOCATIONS: Revocation[] = [
  { name: "the viewer blocks ALICE",
    apply: (s) => { s.rows.blocks!.push({ blocker_id: VIEWER, blocked_id: ALICE }); },
    denies: [ALICE, "event-alice", "trip-alice", "plan-alice", "gem-alice", "post-alice", "circle-alice", "place-alice"] },
  { name: "ALICE blocks the viewer",
    apply: (s) => { s.rows.blocks!.push({ blocker_id: ALICE, blocked_id: VIEWER }); },
    denies: [ALICE, "event-alice", "trip-alice", "plan-alice", "gem-alice", "post-alice", "circle-alice", "place-alice"] },
  { name: "ALICE opts out of profile discovery",
    apply: (s) => { s.rows.profile_privacy_settings!.push({ user_id: ALICE, allow_profile_discovery: false }); },
    denies: [ALICE] },
  { name: "ALICE is suspended",
    apply: (s) => { s.rows.profiles!.find((p) => p.id === ALICE)!.account_status = "suspended"; },
    denies: [ALICE, "event-alice", "trip-alice", "plan-alice", "gem-alice", "post-alice", "circle-alice"] },
  { name: "ALICE's account is deleted",
    apply: (s) => { s.rows.profiles!.find((p) => p.id === ALICE)!.account_status = "deleted"; },
    denies: [ALICE, "event-alice", "trip-alice", "plan-alice", "gem-alice", "post-alice", "circle-alice"] },
  { name: "ALICE turns on age restriction",
    apply: (s) => { s.rows.user_privacy_settings!.push({ user_id: ALICE, age_restriction_enabled: true }); },
    denies: [ALICE, "event-alice", "trip-alice", "plan-alice", "gem-alice", "post-alice", "circle-alice"] },
  { name: "ALICE makes her event, trip and circle private",
    apply: (s) => {
      s.rows.events!.find((e) => e.id === "event-alice")!.visibility = "private";
      s.rows.trips!.find((t) => t.id === "trip-alice")!.visibility = "private";
      s.rows.circles!.find((c) => c.id === "circle-alice")!.visibility = "private";
    },
    denies: ["event-alice", "trip-alice", "plan-alice", "circle-alice"] },
];

describe("revocation between two requests reaches the second one", () => {
  for (const rv of REVOCATIONS) {
    it(`search type=all: ${rv.name}`, async () => {
      const { state } = fresh();
      const first = await searchIds("all");
      for (const id of rv.denies) {
        if (id === "plan-alice" || id === "circle-alice" || id === "gem-alice") continue; // not every bucket leads the round-robin page
        assert.ok(first.ids.includes(id), `control: ${id} must be served before the revocation`);
      }
      rv.apply(state);
      const second = await searchIds("all");
      for (const id of rv.denies) assert.ok(!second.ids.includes(id), `${id} was still served after "${rv.name}"`);
    });

    it(`suggest: ${rv.name}`, async () => {
      const { state } = fresh();
      rv.apply(state);
      const after = await suggestIds();
      for (const id of rv.denies) assert.ok(!after.ids.includes(id), `suggest still served ${id} after "${rv.name}"`);
    });
  }

  it("per-type search sees the revocation too (events, trips, posts, circles, gems, plans, travelers)", async () => {
    for (const [type, id] of [["events", "event-alice"], ["trips", "trip-alice"], ["posts", "post-alice"],
      ["circles", "circle-alice"], ["hidden_gems", "gem-alice"], ["plans", "plan-alice"], ["travelers", ALICE]] as const) {
      const { state } = fresh();
      assert.ok((await searchIds(type)).ids.includes(id), `${type}: control`);
      state.rows.blocks!.push({ blocker_id: ALICE, blocked_id: VIEWER });
      assert.ok(!(await searchIds(type)).ids.includes(id), `${type}: ${id} survived ALICE blocking the viewer`);
    }
  });

  it("the VIEWER suspended between two requests is refused on the second (the ban gate is read per request)", async () => {
    const { state } = fresh();
    assert.equal((await searchIds("events")).status, 200);
    state.rows.profiles!.find((p) => p.id === VIEWER)!.account_status = "suspended";
    const second = await kitGet(base, "/discovery/search?q=zork&type=events");
    assert.equal(second.status, 403);
    assert.equal(second.body?.results, undefined, "a suspended viewer is served no rows");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Stale state: a cursor minted before a revocation
// ═════════════════════════════════════════════════════════════════════════════

describe("a cursor carries no eligibility", () => {
  it("page 2, requested after the viewer blocks the next owner, does not serve that owner", async () => {
    const w = world();
    // Two visible travelers, in a known order; the page size is 1.
    w.rows!.profiles = w.rows!.profiles!.filter((p) => p.id === VIEWER || p.id === ALICE || p.id === FAY)
      .map((p) => (p.id === FAY ? { ...p, handle: "zork_zed", name: "Zork zed" } : p));
    w.rows!.profile_privacy_settings = [];
    const { state } = fresh(w);
    const p1 = await kitGet(base, "/discovery/search?q=zork&type=travelers&limit=1");
    assert.equal(p1.status, 200);
    assert.equal(p1.body.results.length, 1);
    assert.ok(p1.body.nextCursor, "control: there is a second page");
    const onPage1 = p1.body.results[0].id;
    const other = onPage1 === ALICE ? FAY : ALICE;
    state.rows.blocks!.push({ blocker_id: VIEWER, blocked_id: other });
    const p2 = await kitGet(base, `/discovery/search?q=zork&type=travelers&limit=1&cursor=${p1.body.nextCursor}`);
    assert.equal(p2.status, 200);
    assert.ok(!(p2.body.results as any[]).some((r) => r.id === other), "the cursor replayed an eligibility the viewer has since revoked");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. A policy read that fails fails CLOSED — and says so
// ═════════════════════════════════════════════════════════════════════════════

describe("partial failure: a policy read that errors fails closed", () => {
  for (const [label, over] of [
    ["the blocks read resolves an error", { errorTables: { blocks: { code: "57014", message: "timeout" } } }],
    ["the blocks read rejects", { throwTables: new Set(["blocks"]) }],
    ["the age-restriction read resolves an error", { errorTables: { user_privacy_settings: { code: "57014", message: "timeout" } } }],
  ] as const) {
    it(`${label}: search (single type and all) and suggest serve nothing and refuse`, async () => {
      for (const path of ["/discovery/search?q=zork&type=events", "/discovery/search?q=zork&type=all", "/discovery/suggest?q=zork"]) {
        fresh({ ...world(), ...(over as Partial<KitState>) });
        const { status, body } = await kitGet(base, path);
        assert.equal(status, 200, path);
        assert.deepEqual(body.results ?? body.groups, [], `${path} served rows on an unknown policy state`);
        assert.equal(body.refusal?.code, "visibility_state_unreadable", `${path} did not SAY it refused`);
      }
    });
  }

  it("the discovery opt-out read errors: no traveler is served (fail closed), and cities refuse", async () => {
    fresh({ ...world(), errorTables: { profile_privacy_settings: { code: "57014", message: "timeout" } } });
    const t = await searchIds("travelers");
    assert.equal(t.status, 200);
    assert.deepEqual(t.ids, [], "a traveler was served while opt-outs were unreadable");
    const c = await searchIds("cities");
    assert.deepEqual(c.ids, []);
    assert.equal(c.body.refusal?.coverage, "nothing", "cities must refuse, not answer an empty list");
  });

  it("the owner-status read fails ON ITS OWN: every owner-gated row is withheld while the caller is still admitted", async () => {
    const w = world();
    const narrow: KitState["errorOn"] = ({ table, named, terminal }) =>
      table === "profiles" && terminal === "then" && named.has("account_status") && !named.has("handle")
        ? { code: "57014", message: "timeout" } : null;
    for (const type of ["events", "trips", "posts", "circles", "hidden_gems", "plans"]) {
      fresh({ ...w, errorOn: narrow });
      const { status, ids } = await searchIds(type);
      assert.equal(status, 200, `${type}: the caller's own ban check must still pass`);
      for (const n of NAMES) {
        const kind = { events: "event", trips: "trip", posts: "post", circles: "circle", hidden_gems: "gem", plans: "plan" }[type];
        assert.ok(!ids.includes(`${kind}-${n}`), `${type}: ${n}'s row served with owner status unknown`);
      }
    }
  });

  it("the RSVP read errors: a hidden venue stays hidden even for an attendee (never widened on failure)", async () => {
    const w = world();
    w.rows!.events!.find((e) => e.id === "event-alice")!.show_exact_location = false;
    w.rows!.event_rsvps = [{ event_id: "event-alice", user_id: VIEWER, status: "going" }];
    fresh(w);
    const ok = (await searchIds("events")).body.results.find((r: any) => r.id === "event-alice");
    assert.equal(ok.metadata.lat, 38.7, "control: an attendee sees the venue");
    fresh({ ...world(), rows: w.rows, errorTables: { event_rsvps: { code: "57014", message: "timeout" } } });
    const failed = (await searchIds("events")).body.results.find((r: any) => r.id === "event-alice");
    assert.ok(failed, "the row is still served");
    assert.equal(failed.metadata.lat, null, "an unreadable RSVP widened a hidden venue");
    assert.equal(failed.metadata.lng, null);
  });

  it("the follow read errors: a private account the viewer follows collapses to a locked preview, never the reverse", async () => {
    const w = world();
    w.rows!.user_follows = [{ follower_id: VIEWER, following_id: GUS }];
    fresh(w);
    const followed = (await searchIds("travelers")).body.results.find((r: any) => r.id === GUS);
    assert.equal(followed.accessState.canAccess, true, "control: a followed private account is open");
    fresh({ ...world(), rows: w.rows, errorTables: { user_follows: { code: "57014", message: "timeout" } } });
    const failed = (await searchIds("travelers")).body.results.find((r: any) => r.id === GUS);
    assert.equal(failed.accessState.canAccess, false, "an unreadable follow edge opened a private account");
    assert.equal(failed.avatarUrl, null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. What is never READ — the structural half of C07, A12, B06 and B09
// ═════════════════════════════════════════════════════════════════════════════

/** Column names that must never enter this process on a search, whatever the row. */
// SUBSTRING matches on purpose: `\bemail\b` would pass `contact_email`, because `_` is
// a word character — P24 mutation S20 (`lodging_name` added to the trips read) stayed
// GREEN against the first, word-bounded spelling of these patterns.
const NEVER_SELECTED: Record<string, RegExp> = {
  profiles: /(email|phone|birth|latitude|longitude|safety|verification_doc|document|passport_number|password)|(^|[\s,_])(lat|lng|location|coords?)([\s,_]|$)/i,
  trips: /(lodging|accommodation|hotel|address|latitude|longitude|safety|participant|member|crew)|(^|[\s,_])(lat|lng|location|coords?)([\s,_]|$)/i,
  hidden_gems: /(^|[\s,])(latitude|longitude|exact_lat|exact_lng|lat|lng)([\s,]|$)/i,
};

describe("what search never reads (C07, A12, B06, B09)", () => {
  it("type=all and suggest: no profiles / trips / hidden_gems read names a private column", async () => {
    for (const path of ["/discovery/search?q=zork&type=all&limit=50", "/discovery/suggest?q=zork"]) {
      const { calls } = fresh();
      const { status } = await kitGet(base, path);
      assert.equal(status, 200);
      for (const [table, forbidden] of Object.entries(NEVER_SELECTED)) {
        const reads = calls.selects.filter((s) => s.table === table && s.cols !== "*");
        assert.ok(table === "profiles" || reads.length > 0, `${path}: control — no ${table} read to inspect`);
        for (const r of reads) assert.ok(!forbidden.test(r.cols), `${path}: ${table} read selects a private column: ${r.cols}`);
      }
      assert.ok(!calls.selects.some((s) => ["profiles", "trips", "hidden_gems"].includes(s.table) && s.cols === "*"),
        `${path}: a SELECT * on a table with private columns`);
    }
  });

  it("A12 — a served trip card carries no field beyond the public card (no lodging, position, safety or participant)", async () => {
    fresh();
    const trip = (await searchIds("trips")).body.results.find((r: any) => r.id === "trip-alice");
    assert.ok(trip, "control");
    assert.deepEqual(Object.keys(trip.metadata).sort(), ["ownerId", "status"]);
  });

  it("B06/B09 — a gem serves its APPROXIMATE pair at most, and nothing at all when its sensitivity is `protected`", async () => {
    const w = world();
    w.rows!.hidden_gems!.push({
      id: "gem-alice-protected", name: "zork gem alice protected", city: "Lisbon", country: "PT", submitted_by: ALICE,
      category: "food", status: "active", created_at: "2026-01-01T00:00:00Z", sensitivity_level: "protected",
      approx_latitude: 38.71, approx_longitude: -9.14, latitude: 38.7123456, longitude: -9.1423456,
    });
    for (const g of w.rows!.hidden_gems!) Object.assign(g, { latitude: 38.7123456, longitude: -9.1423456 });
    fresh(w);
    const gems = (await searchIds("hidden_gems")).body.results as any[];
    const plain = gems.find((g) => g.id === "gem-alice");
    assert.equal(plain.metadata.lat, 38.71, "the approximate pair is the most a stranger gets");
    assert.equal(plain.metadata.coordsPrecision, "approximate");
    const prot = gems.find((g) => g.id === "gem-alice-protected");
    assert.equal(prot.metadata.lat, null, "a protected gem carries no position at all");
    assert.equal(prot.metadata.coordsPrecision, "hidden");
    assert.ok(!JSON.stringify(gems).includes("38.7123456"), "the exact pair reached the wire");
  });
});

describe("rate limits are per route and per user (C13)", () => {
  it("search refuses the 31st request in a minute and suggest the 91st, each with 429", async () => {
    fresh();
    for (let i = 0; i < 30; i++) assert.equal((await kitGet(base, "/discovery/search?q=zork&type=vibes")).status, 200);
    assert.equal((await kitGet(base, "/discovery/search?q=zork&type=vibes")).status, 429);
    for (let i = 0; i < 90; i++) assert.equal((await kitGet(base, "/discovery/suggest?q=zz")).status, 200, `suggest request ${i + 1}`);
    const over = await kitGet(base, "/discovery/suggest?q=zz");
    assert.equal(over.status, 429);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Retries: a failed policy read is not remembered
// ═════════════════════════════════════════════════════════════════════════════

describe("retry after a transient policy failure", () => {
  for (const table of ["blocks", "user_privacy_settings"]) {
    it(`${table} unreadable, then healthy: the second request serves (no negative cache) and still applies the rule`, async () => {
      const { state } = fresh({ ...world(), errorTables: { [table]: { code: "57014", message: "timeout" } } });
      const first = await searchIds("events");
      assert.deepEqual(first.ids, []);
      assert.equal(first.body.refusal?.code, "visibility_state_unreadable");
      delete state.errorTables[table];
      const second = await searchIds("events");
      assert.equal(second.body.refusal, undefined, "the recovery is still refusing");
      assert.ok(second.ids.includes("event-alice"), "the recovery serves nothing");
      for (const n of CONTENT_DENIED) assert.ok(!second.ids.includes(`event-${n}`), `the retry dropped the rule: event-${n}`);
    });
  }
});
