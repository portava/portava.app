/**
 * searchPlatformGolden — census-discovery §70 (lane P30). The behaviour-identity
 * proof for moving search candidate generation out of `routes/discoverySearch.ts`
 * into `lib/inputAssistance/searchCandidates.ts`.
 *
 * The golden (fixtures/searchPlatformGolden.json) was WRITTEN AT THE PRE-MOVE
 * TREE (fd1b1fbb1) by running this file with SEARCH_GOLDEN_WRITE=1, and is only
 * READ afterwards. Each case records:
 *   • the HTTP status and the full response body, with the per-request
 *     `recommendationId` removed (DV-40 mints a fresh one per serve);
 *   • the reads the request issued, in order: every `from(table)`, every
 *     `.select(cols)`, every `.or(expr)` and every `.ilike(col, pat)`.
 * So a case fails if the move changed what is served OR what is asked of the
 * database, including the order of the reads.
 *
 * The cases: every one of the 18 search types, `type=all` (plain, second page by
 * cursor, a handle query, both intent boosts, one bucket unreadable), the
 * `saved` partial, GET /discovery/suggest (three queries and the too-short
 * refusal), and the input gateway's `generateSuggestions` for five contexts,
 * which is the path that reaches `dispatchSearch` from the platform side.
 *
 * Date is frozen (node:test mock timers, Date only) so recency and "upcoming"
 * terms cannot drift the golden between runs.
 *
 * Run: node --import tsx/esm --test src/test/searchPlatformGolden.test.ts
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import discoverySearchRouter, { invalidateBuddyLaunchGateCache } from "../routes/discoverySearch.js";
import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import { generateSuggestions } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import type { InputContext } from "../lib/inputAssistance/types.js";
import {
  VIEWER,
  emptyCalls,
  installKit,
  kitGet,
  makeKitClient,
  emptyState,
  settle,
  startKitServer,
  type KitCalls,
  type KitState,
} from "./discoverySearchTestKit.js";

const GOLDEN = new URL("./fixtures/searchPlatformGolden.json", import.meta.url);
const WRITE = process.env.SEARCH_GOLDEN_WRITE === "1";
const NOW = Date.parse("2026-09-28T12:00:00.000Z");

const ALICE = "c1000000-0000-4000-a000-000000000001";
const BOB   = "c2000000-0000-4000-a000-000000000002"; // blocked by the viewer
const GUS   = "c3000000-0000-4000-a000-000000000003"; // private
const HAL   = "c4000000-0000-4000-a000-000000000004"; // verified, a buddy
const CAST = [
  { key: "alice", id: ALICE, isPrivate: false, verified: false },
  { key: "bob",   id: BOB,   isPrivate: false, verified: false },
  { key: "gus",   id: GUS,   isPrivate: true,  verified: false },
  { key: "hal",   id: HAL,   isPrivate: false, verified: true },
];
const FUTURE = "2026-10-20T18:00:00.000Z";
const LATER = "2026-11-05T18:00:00.000Z";

function world(): Partial<KitState> {
  const profiles = [
    { id: VIEWER, handle: "viewer", username: "viewer", name: "Viewer", display_name: null, avatar_url: null,
      is_private: false, home_city: "Lisbon", home_country: "Portugal", account_status: "active", verified: false,
      is_official: false, show_profile_picture_publicly: true, buddy_verified_at: null },
    ...CAST.map((c, i) => ({
      id: c.id, handle: `zork_${c.key}`, username: `zork_${c.key}`, name: `Zork ${c.key}`, display_name: null,
      avatar_url: `https://cdn/${c.key}.jpg`, is_private: c.isPrivate, home_city: i % 2 ? "Lisbon" : "Porto",
      home_country: "Portugal", account_status: "active", verified: c.verified, is_official: false,
      show_profile_picture_publicly: true, buddy_verified_at: "2026-01-01T00:00:00Z",
    })),
  ];
  const own = (kind: string, k: string) => `${kind}-${k}`;
  return {
    rows: {
      profiles,
      blocks: [{ blocker_id: VIEWER, blocked_id: BOB }],
      user_privacy_settings: [],
      profile_privacy_settings: [],
      user_follows: [{ follower_id: VIEWER, following_id: ALICE, status: "accepted" }],
      friend_requests: [], user_friendships: [], event_rsvps: [],
      events: CAST.map((c, i) => ({
        id: own("event", c.key), title: `zork event ${c.key}`, host_id: c.id, cover_url: null,
        city: i % 2 ? "Lisbon" : "Porto", country: "PT", starts_at: i % 2 ? FUTURE : LATER, visibility: "public",
        state: "open", created_at: "2026-01-0" + (i + 1) + "T00:00:00Z", location_lat: 38.7, location_lng: -9.1,
        show_exact_location: true, verified: c.verified,
      })),
      trips: CAST.map((c, i) => ({
        id: own("trip", c.key), title: `zork trip ${c.key}`, destination_city: i % 2 ? "Lisbon" : "Porto",
        destination_country: "PT", owner_id: c.id, cover_url: null, start_date: (i % 2 ? FUTURE : LATER).slice(0, 10),
        status: "upcoming", visibility: "public", show_in_discovery: true, created_at: "2026-01-01T00:00:00Z",
      })),
      trip_plan_items: CAST.map((c) => ({
        id: own("plan", c.key), title: `zork plan ${c.key}`, trip_id: own("trip", c.key), creator_id: c.id,
        created_at: "2026-01-01T00:00:00Z", removed_at: null,
      })),
      hidden_gems: CAST.map((c) => ({
        id: own("gem", c.key), name: `zork gem ${c.key}`, city: "Lisbon", country: "PT", submitted_by: c.id,
        category: "food", status: "active", created_at: "2026-01-01T00:00:00Z", sensitivity_level: "approximate",
        approx_latitude: 38.71, approx_longitude: -9.14,
      })),
      posts: CAST.map((c) => ({
        id: own("post", c.key), content: `zork post ${c.key}`, author_id: c.id, media_urls: [],
        created_at: "2026-01-01T00:00:00Z", like_count: 3, post_status: "published", visibility: "public", status: "active",
      })),
      circles: CAST.map((c) => ({
        id: own("circle", c.key), name: `zork circle ${c.key}`, description: null, owner_id: c.id,
        cover_image_url: null, city: "Lisbon", visibility: "public", created_at: "2026-01-01T00:00:00Z",
      })),
      discovery_places: [
        ...CAST.map((c, i) => ({
          id: own("place", c.key), name: `zork place ${c.key}`, city: "Lisbon", blurb: null, image_url: null,
          header_image_source: null, image_source_type: null, image_accuracy_status: null, category: i % 2 ? "food" : "culture",
          primary_category: i % 2 ? "food" : "culture", lat: 38.72 + i / 100, lng: -9.13, canonical_location_id: null,
          created_at: "2026-01-01T00:00:00Z", submitted_by: c.id, status: "active", saved_count: i,
        })),
        { id: "place-venue", name: "zork place venue", city: "Lisbon", blurb: null, image_url: null,
          header_image_source: null, image_source_type: null, image_accuracy_status: null, category: "food",
          primary_category: "food", lat: 38.75, lng: -9.1, canonical_location_id: null,
          created_at: "2026-01-01T00:00:00Z", submitted_by: null, status: "active", saved_count: 9 },
      ],
      hashtags: [
        { id: "tag-1", slug: "zorkfood", name: "zorkfood", usage_count: 12, created_at: "2026-01-01T00:00:00Z", is_blocked: false },
        { id: "tag-2", slug: "zorkbeach", name: "zorkbeach", usage_count: 4, created_at: "2026-01-01T00:00:00Z", is_blocked: false },
        { id: "tag-3", slug: "zorkbad", name: "zorkbad", usage_count: 99, created_at: "2026-01-01T00:00:00Z", is_blocked: true },
      ],
      stamp_definitions: [
        { id: "stamp-1", slug: "zork-walker", name: "Zork Walker", description: "walk zork", icon_url: null,
          created_at: "2026-01-01T00:00:00Z", is_active: true },
      ],
      canonical_locations: [
        { id: "cl-lisbon", kind: "city", name: "Lisbon", normalized_name: "lisbon", search_key: "lisbon",
          display_name: "Lisbon, Portugal", city: "Lisbon", region: "Lisboa", country: "Portugal", country_code: "PT",
          lat: 38.72, lng: -9.14, population: 500000 },
        { id: "cl-lisburn", kind: "city", name: "Lisburn", normalized_name: "lisburn", search_key: "lisburn",
          display_name: "Lisburn, United Kingdom", city: "Lisburn", region: null, country: "United Kingdom", country_code: "GB",
          lat: 54.5, lng: -6.0, population: 70000 },
      ],
      wishlist_places: [
        { user_id: VIEWER, place_id: "place-alice", saved_at: "2026-02-01T00:00:00Z",
          place_data: { name: "zork place alice", city: "Lisbon", lat: 38.72, lng: -9.13 } },
      ],
      discovery_place_saves: [
        { user_id: VIEWER, place_id: "place-venue", saved_at: "2026-03-01T00:00:00Z" },
      ],
      rent_buddy_profiles: CAST.map((c) => ({
        id: `rbp-${c.key}`, user_id: c.id, categories: ["city"], category_approvals: {},
        nightlife_admin_approved: false, status: "active", admin_status: "active", risk_hold: false,
        risk_review_status: "normal", verification_status: "unverified", id_verified: false, phone_verified: false,
      })),
    },
  };
}

/** Drop every `recommendationId`, wherever it sits. */
function sansIds(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sansIds);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== "recommendationId")
        .map(([k, x]) => [k, sansIds(x)]),
    );
  }
  return v;
}

function reads(calls: KitCalls) {
  return { tables: calls.tables, selects: calls.selects, ors: calls.ors, ilikes: calls.ilikes };
}

function fresh(over: Partial<KitState> = world()) {
  invalidateBuddyLaunchGateCache();
  invalidateSearchProtectionFlagCache();
  invalidateDiscoveryTripProjectionFlagCache();
  return installKit(over);
}

type Case =
  | { name: string; kind: "get"; path: string; over?: (w: Partial<KitState>) => Partial<KitState> }
  | { name: string; kind: "gateway"; context: InputContext; text: string };

const TYPES = [
  ["travelers", "zork"], ["buddies", "zork"], ["events", "zork"], ["trips", "zork"], ["plans", "zork"],
  ["places", "zork"], ["hidden_gems", "zork"], ["hashtags", "zork"], ["posts", "zork"], ["circles", "zork"],
  ["stamps", "zork"], ["activities", "zork"], ["cities", "lis"], ["countries", "port"], ["languages", "span"],
  ["interests", "hik"], ["vibes", "beach"], ["saved", "zork"],
] as const;

const CASES: Case[] = [
  ...TYPES.map(([type, q]): Case => ({ name: `search type=${type} q=${q}`, kind: "get", path: `/discovery/search?q=${q}&type=${type}&limit=10` })),
  { name: "search type=places near a point", kind: "get", path: "/discovery/search?q=zork&type=places&limit=10&lat=38.72&lng=-9.13&city=Lisbon" },
  { name: "search type=travelers second page", kind: "get", path: "/discovery/search?q=zork&type=travelers&limit=1&cursor=MQ" },
  { name: "search type=all", kind: "get", path: "/discovery/search?q=zork&limit=20" },
  { name: "search type=all limit=5", kind: "get", path: "/discovery/search?q=zork&type=all&limit=5" },
  { name: "search type=all @handle", kind: "get", path: "/discovery/search?q=%40zork_alice&type=all&limit=20" },
  { name: "search type=all intentCategory=food", kind: "get", path: "/discovery/search?q=zork&type=all&limit=20&intentCategory=food" },
  { name: "search type=all intentSafety", kind: "get", path: "/discovery/search?q=zork&type=all&limit=20&intentSafety=true&city=Lisbon" },
  { name: "search type=events next week", kind: "get", path: "/discovery/search?q=zork%20next%20week&type=events&limit=10&tz=Europe%2FLisbon" },
  {
    name: "search type=all with hashtags rejecting", kind: "get", path: "/discovery/search?q=zork&type=all&limit=20",
    over: (w) => ({ ...w, throwTables: new Set(["hashtags"]) }),
  },
  {
    name: "search type=all with hashtags unreadable", kind: "get", path: "/discovery/search?q=zork&type=all&limit=20",
    over: (w) => ({ ...w, errorTables: { hashtags: { code: "08006", message: "connection failure" } } }),
  },
  {
    name: "search type=saved with wishlist unreadable", kind: "get", path: "/discovery/search?q=zork&type=saved&limit=10",
    over: (w) => ({ ...w, errorTables: { wishlist_places: { code: "08006", message: "connection failure" } } }),
  },
  {
    name: "search type=stamps unreadable", kind: "get", path: "/discovery/search?q=zork&type=stamps&limit=10",
    over: (w) => ({ ...w, errorTables: { stamp_definitions: { code: "08006", message: "connection failure" } } }),
  },
  { name: "suggest q=zork", kind: "get", path: "/discovery/suggest?q=zork" },
  { name: "suggest q=@zork", kind: "get", path: "/discovery/suggest?q=%40zork" },
  { name: "suggest q=lis", kind: "get", path: "/discovery/suggest?q=lis&lat=38.72&lng=-9.13&city=Lisbon" },
  { name: "suggest q=z (too short)", kind: "get", path: "/discovery/suggest?q=z" },
  {
    name: "suggest q=zork with circles rejecting", kind: "get", path: "/discovery/suggest?q=zork",
    over: (w) => ({ ...w, throwTables: new Set(["circles"]) }),
  },
  {
    name: "suggest q=zork with circles unreadable", kind: "get", path: "/discovery/suggest?q=zork",
    over: (w) => ({ ...w, errorTables: { circles: { code: "08006", message: "connection failure" } } }),
  },
  { name: "gateway global_search zork", kind: "gateway", context: "global_search", text: "zork" },
  { name: "gateway telegraph_recipient zork", kind: "gateway", context: "telegraph_recipient", text: "zork" },
  { name: "gateway city_picker lis", kind: "gateway", context: "city_picker", text: "lis" },
  { name: "gateway hashtag zork", kind: "gateway", context: "hashtag", text: "#zork" },
  { name: "gateway place_picker zork", kind: "gateway", context: "place_picker", text: "zork" },
];

let base = "";
let server: Server;
const observed: Record<string, unknown> = {};

before(async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  ({ base, server } = await startKitServer(discoverySearchRouter));
});
after(() => {
  server.close();
  mock.timers.reset();
  if (WRITE) writeFileSync(GOLDEN, JSON.stringify(observed, null, 2) + "\n");
});

async function run(c: Case): Promise<unknown> {
  if (c.kind === "get") {
    const w = world();
    const { calls } = fresh(c.over ? c.over(w) : w);
    const { status, body } = await kitGet(base, c.path);
    await settle();
    return { status, body: sansIds(body), reads: reads(calls) };
  }
  invalidateBuddyLaunchGateCache();
  const calls = emptyCalls();
  const sc = makeKitClient(emptyState(world()), calls);
  const policy = resolvePolicy(c.context)!;
  const suggestions = await generateSuggestions(sc, {
    context: c.context, policy, text: c.text, userId: VIEWER, limit: policy.maxSuggestions,
    lat: 38.72, lng: -9.13, city: "Lisbon",
  });
  await settle();
  return { suggestions: sansIds(suggestions), reads: reads(calls) };
}

describe("search platform golden (census-discovery §70): the move served and read exactly what the pre-move tree did", () => {
  const golden: Record<string, unknown> = WRITE ? {} : JSON.parse(readFileSync(GOLDEN, "utf8"));

  it("the golden holds every case, and every case is non-trivial somewhere", () => {
    if (WRITE) return;
    assert.deepEqual(Object.keys(golden).sort(), CASES.map((c) => c.name).sort());
    // Vacuity control: a golden of empty answers would prove nothing about the
    // searchers. Most search types must have served at least one row.
    const served = TYPES.filter(([type, q]) => {
      const g = golden[`search type=${type} q=${q}`] as { body?: { results?: unknown[] } };
      return (g.body?.results?.length ?? 0) > 0;
    });
    assert.ok(served.length >= 15, `only ${served.length} of ${TYPES.length} types served a row in the golden`);
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const got = JSON.parse(JSON.stringify(await run(c)));
      observed[c.name] = got;
      if (WRITE) return;
      assert.deepEqual(got, golden[c.name]);
    });
  }
});
