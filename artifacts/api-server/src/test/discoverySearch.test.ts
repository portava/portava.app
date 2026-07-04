/**
 * GET /api/discovery/search  — unified search endpoint
 *
 * Run: node --import tsx/esm --test src/test/discoverySearch.test.ts
 *
 * Covers:
 *   - 400 on missing/short query (< 2 chars)
 *   - 400 on unknown type value
 *   - 401 when no auth token
 *   - Blocked user excluded from travelers results (both directions)
 *   - Private accounts excluded entirely (is_private=true filtered out)
 *   - Discovery opt-out excluded
 *   - Normalized shape for travelers, events, hashtags (all required fields)
 *   - actionState derived: isFollowing for travelers, isAttending for events
 *   - Blocked event host excluded
 *   - Blocked hashtag excluded
 *   - type=all fan-out returns results from multiple type buckets
 *   - type=all supports cursor pagination (hasMore/nextCursor)
 *   - Single-type cursor pagination: nextCursor set when results fill limit
 *   - hasMore=false when results fewer than limit
 *   - Plans from private trips excluded (security)
 *   - Plans from public trips included
 *   - Rate limit: 429 after 30 requests in the same window
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import discoverySearchRouter from "../routes/discoverySearch.js";

// ── Stable test UUIDs ──────────────────────────────────────────────────────────

const ME       = "aa000000-0000-4000-a000-000000000001";
const ALICE    = "bb000000-0000-4000-a000-000000000002";
const BOB      = "cc000000-0000-4000-a000-000000000003"; // ME blocked BOB
const CARL     = "dd000000-0000-4000-a000-000000000004"; // CARL blocked ME
const PRIVATE  = "ee000000-0000-4000-a000-000000000005"; // private account
const TRIP_PUB = "ff000000-0000-4000-a000-000000000010"; // public trip
const TRIP_PRI = "ff000000-0000-4000-a000-000000000011"; // private trip

const ME_TOK = "tok-me";

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface FakeState {
  profiles: any[];
  blocks: { blocker_id: string; blocked_id: string }[];
  events: any[];
  hashtags: any[];
  profile_privacy_settings: { user_id: string; allow_profile_discovery: boolean }[];
  user_follows?: any[];
  event_rsvps?: any[];
  trips?: any[];
  posts?: any[];
  circles?: any[];
  stamp_definitions?: any[];
  hidden_gems?: any[];
  discovery_places?: any[];
  trip_plan_items?: any[];
  [key: string]: any[] | undefined;
}

function makeFakeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => {
      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd   = Infinity;
      let _limitN     = Infinity;

      const builder: any = {
        select()                      { return builder; },
        eq(col: string, val: any)     { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any)    { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[])  { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => r[col] !== val && r[col] != null);
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r) => val === null ? r[col] == null : r[col] === val);
          return builder;
        },
        ilike(col: string, pat: string) {
          const re = new RegExp(
            "^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$",
            "i",
          );
          filters.push((r) => re.test(String(r[col] ?? "")));
          return builder;
        },
        or(expr: string) {
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.([\w]+)\.(.+)$/);
            if (!m) return null;
            return { col: m[1]!, op: m[2]!.toLowerCase(), val: m[3]! };
          }).filter(Boolean) as { col: string; op: string; val: string }[];

          filters.push((r) =>
            parts.some(({ col, op, val }) => {
              const cellStr = String(r[col] ?? "");
              if (op === "ilike") {
                const re = new RegExp(
                  "^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$",
                  "i",
                );
                return re.test(cellStr);
              }
              if (op === "eq") return cellStr === val;
              return false;
            }),
          );
          return builder;
        },
        order()  { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(start: number, end: number) { _rangeStart = start; _rangeEnd = end; return builder; },
        maybeSingle() {
          const matched = sourceRows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(
              _rangeStart,
              _rangeEnd < Infinity
                ? _rangeEnd + 1
                : _limitN < Infinity
                  ? _limitN
                  : undefined,
            );
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };

      return builder;
    },
  };
}

// ── Server + setup helpers ─────────────────────────────────────────────────────

let base: string;
let server: Server;

function setup(state: Partial<FakeState>) {
  const full: FakeState = {
    profiles: [],
    blocks: [],
    events: [],
    hashtags: [],
    profile_privacy_settings: [],
    user_follows: [],
    event_rsvps: [],
    trips: [],
    posts: [],
    circles: [],
    stamp_definitions: [],
    hidden_gems: [],
    discovery_places: [],
    trip_plan_items: [],
    ...state,
  };
  _setTestClient(makeFakeClient(full) as any, true);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", discoverySearchRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => server.close());

beforeEach(() => {
  _resetRateLimit();
  setup({});
});

function get(path: string, tok = ME_TOK) {
  return fetch(`${base}${path}`, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  });
}

// ── Validation ─────────────────────────────────────────────────────────────────

describe("GET /api/discovery/search — validation", () => {
  it("returns 401 when no auth token", async () => {
    const r = await get("/discovery/search?q=paris", "");
    assert.equal(r.status, 401);
  });

  it("returns 400 when q is missing", async () => {
    setup({});
    const r = await get("/discovery/search");
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 400 when q is a single character", async () => {
    setup({});
    const r = await get("/discovery/search?q=a");
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 400 when q is empty string", async () => {
    setup({});
    const r = await get("/discovery/search?q=");
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 400 for unknown type value", async () => {
    setup({});
    const r = await get("/discovery/search?q=paris&type=not_a_type");
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.equal(body.error, "invalid_payload");
  });

  it("accepts a 2-character query and returns 200", async () => {
    setup({ profiles: [] });
    const r = await get("/discovery/search?q=pa&type=travelers");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.results));
  });
});

// ── Block exclusion — travelers ────────────────────────────────────────────────

describe("GET /api/discovery/search — block exclusion (travelers)", () => {
  beforeEach(() => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice Paris", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
        { id: BOB,   handle: "bob",   name: "Bob Paris",   avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
        { id: CARL,  handle: "carl",  name: "Carl Paris",  avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [
        { blocker_id: ME,   blocked_id: BOB  },
        { blocker_id: CARL, blocked_id: ME   },
      ],
      profile_privacy_settings: [],
      user_follows: [],
    });
  });

  it("returns unblocked traveler", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.ok((results as any[]).some((u: any) => u.id === ALICE), "ALICE should appear");
  });

  it("excludes a user that the caller blocked", async () => {
    const r = await get("/discovery/search?q=bob&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.ok(!(results as any[]).some((u: any) => u.id === BOB), "BOB (blocked by ME) must not appear");
  });

  it("excludes a user that blocked the caller", async () => {
    const r = await get("/discovery/search?q=carl&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.ok(!(results as any[]).some((u: any) => u.id === CARL), "CARL (who blocked ME) must not appear");
  });

  it("broad query excludes all blocked users but returns unblocked ones", async () => {
    const r = await get("/discovery/search?q=paris&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((u: any) => u.id as string);
    assert.ok(ids.includes(ALICE),  "ALICE should appear");
    assert.ok(!ids.includes(BOB),   "BOB (blocked) must not appear");
    assert.ok(!ids.includes(CARL),  "CARL (blocked ME) must not appear");
  });
});

// ── Private accounts excluded ──────────────────────────────────────────────────

describe("GET /api/discovery/search — private accounts excluded entirely", () => {
  it("does NOT return private accounts in travelers search", async () => {
    setup({
      profiles: [
        { id: PRIVATE, handle: "ghost", name: "Ghost Traveler", avatar_url: null, is_private: true, home_city: null, home_country: null, account_status: "active" },
        { id: ALICE,   handle: "alice", name: "Alice Travel",   avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],
    });

    const r = await get("/discovery/search?q=travel&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((u: any) => u.id as string);
    assert.ok(!ids.includes(PRIVATE), "Private account must NOT appear in results");
    assert.ok(ids.includes(ALICE),    "Non-private account should appear");
  });

  it("excludes profiles that opted out of discovery", async () => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice Opt-Out", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [{ user_id: ALICE, allow_profile_discovery: false }],
      user_follows: [],
    });

    const r = await get("/discovery/search?q=alice&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.ok(!(results as any[]).some((u: any) => u.id === ALICE), "Opt-out profile must not appear");
  });
});

// ── Normalized shape — travelers ───────────────────────────────────────────────

describe("GET /api/discovery/search — normalized result shape (travelers)", () => {
  beforeEach(() => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice_t", name: "Alice Traveler", avatar_url: "https://cdn/a.jpg", is_private: false, home_city: "Tokyo", home_country: "Japan", account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [{ follower_id: ME, following_id: ALICE }],
    });
  });

  it("contains all required shape fields", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.equal(results.length, 1);
    const res = results[0] as any;

    for (const field of [
      "id","type","title","subtitle","avatarUrl","imageUrl","fallbackInitials",
      "locationPreview","matchedReason","actionState","privacyState","accessState",
      "destinationRoute","metadata","createdAt","startsAt",
    ]) {
      assert.ok(field in res, `Missing field: ${field}`);
    }
  });

  it("populates title with profile name", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].title, "Alice Traveler");
  });

  it("populates subtitle with @handle", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].subtitle, "@alice_t");
  });

  it("populates avatarUrl", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].avatarUrl, "https://cdn/a.jpg");
  });

  it("populates fallbackInitials from name", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].fallbackInitials, "AT");
  });

  it("populates locationPreview from home_city and home_country", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].locationPreview, "Tokyo, Japan");
  });

  it("populates destinationRoute pointing to passport by handle", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].destinationRoute, "/passport/alice_t");
  });

  it("derives actionState.isFollowing=true when caller follows the traveler", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].actionState?.isFollowing, true);
  });

  it("derives actionState.isFollowing=false when caller does not follow", async () => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice_t", name: "Alice Traveler", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],  // not following ALICE
    });
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].actionState?.isFollowing, false);
  });

  it("populates response envelope fields", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const body = await r.json() as any;
    assert.equal(body.query, "alice");
    assert.equal(body.type, "travelers");
    assert.ok("hasMore" in body);
    assert.ok("nextCursor" in body);
  });

  it("privacyState.isPrivate=false for non-private account", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].privacyState?.isPrivate, false);
    assert.equal(results[0].accessState?.canAccess, true);
  });
});

// ── Events shape ───────────────────────────────────────────────────────────────

describe("GET /api/discovery/search — normalized result shape (events)", () => {
  const EVT_ID = "ff000000-0000-4000-a000-000000000020";

  beforeEach(() => {
    setup({
      profiles: [],
      blocks: [],
      events: [
        {
          id: EVT_ID, title: "Paris Jazz Festival",
          description: "Annual jazz festival in Paris",
          host_id: ALICE, cover_image_url: "https://cdn/evt.jpg",
          city: "Paris", country: "France",
          starts_at: "2026-08-10T18:00:00Z",
          visibility: "public", status: "published",
          created_at: "2026-07-01T00:00:00Z",
        },
      ],
      event_rsvps: [{ event_id: EVT_ID, user_id: ME, status: "going" }],
      profile_privacy_settings: [],
    });
  });

  it("returns event with correct shape", async () => {
    const r = await get("/discovery/search?q=paris&type=events");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.equal(results.length, 1);
    const evt = results[0] as any;
    assert.equal(evt.id, EVT_ID);
    assert.equal(evt.type, "events");
    assert.equal(evt.title, "Paris Jazz Festival");
    assert.equal(evt.locationPreview, "Paris, France");
    assert.equal(evt.imageUrl, "https://cdn/evt.jpg");
    assert.equal(evt.startsAt, "2026-08-10T18:00:00Z");
    assert.equal(evt.destinationRoute, `/event/${EVT_ID}`);
  });

  it("derives actionState.isAttending=true when caller RSVP'd going", async () => {
    const r = await get("/discovery/search?q=paris&type=events");
    const { results } = await r.json() as any;
    assert.equal(results[0].actionState?.isAttending, true);
  });

  it("derives actionState.isAttending=false when caller has no RSVP", async () => {
    setup({
      profiles: [],
      blocks: [],
      events: [
        {
          id: EVT_ID, title: "Paris Jazz Festival", description: "Jazz",
          host_id: ALICE, city: "Paris", country: "France",
          starts_at: "2026-08-10T18:00:00Z",
          visibility: "public", status: "published",
          created_at: "2026-07-01T00:00:00Z",
        },
      ],
      event_rsvps: [],  // no RSVP
      profile_privacy_settings: [],
    });
    const r = await get("/discovery/search?q=paris&type=events");
    const { results } = await r.json() as any;
    assert.equal(results[0].actionState?.isAttending, false);
  });

  it("excludes events hosted by a blocked user", async () => {
    setup({
      profiles: [],
      blocks: [{ blocker_id: ME, blocked_id: ALICE }],
      events: [
        {
          id: EVT_ID, title: "Paris Jazz Festival", description: "Jazz",
          host_id: ALICE, city: "Paris", country: "France",
          starts_at: "2026-08-10T18:00:00Z",
          visibility: "public", status: "published",
          created_at: "2026-07-01T00:00:00Z",
        },
      ],
      event_rsvps: [],
      profile_privacy_settings: [],
    });
    const r = await get("/discovery/search?q=paris&type=events");
    const { results } = await r.json() as any;
    assert.ok(!(results as any[]).some((e: any) => e.id === EVT_ID), "Blocked host's event must not appear");
  });
});

// ── Hashtags shape ─────────────────────────────────────────────────────────────

describe("GET /api/discovery/search — normalized result shape (hashtags)", () => {
  const HT_ID = "gg000000-0000-4000-a000-000000000030";

  beforeEach(() => {
    setup({
      profiles: [],
      blocks: [],
      hashtags: [
        { id: HT_ID, slug: "wanderlust", name: "wanderlust", usage_count: 1234, is_blocked: false, created_at: "2026-01-01T00:00:00Z" },
      ],
      profile_privacy_settings: [],
    });
  });

  it("returns hashtag with correct shape", async () => {
    const r = await get("/discovery/search?q=wander&type=hashtags");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.equal(results.length, 1);
    const ht = results[0] as any;
    assert.equal(ht.id, HT_ID);
    assert.equal(ht.type, "hashtags");
    assert.equal(ht.title, "#wanderlust");
    assert.equal(ht.fallbackInitials, "#");
    assert.equal(ht.destinationRoute, "/hashtag/wanderlust");
    assert.equal((ht.metadata as any).usageCount, 1234);
  });

  it("excludes blocked hashtags", async () => {
    setup({
      profiles: [],
      blocks: [],
      hashtags: [
        { id: HT_ID, slug: "spamtag", name: "spamtag", usage_count: 0, is_blocked: true, created_at: "2026-01-01T00:00:00Z" },
      ],
      profile_privacy_settings: [],
    });
    const r = await get("/discovery/search?q=spam&type=hashtags");
    const { results } = await r.json() as any;
    assert.equal(results.length, 0, "Blocked hashtag must not appear");
  });
});

// ── Plans security — visibility enforcement ────────────────────────────────────

describe("GET /api/discovery/search — plans: trip visibility enforcement", () => {
  const PLAN_PUB = "ph000000-0000-4000-a000-000000000001";
  const PLAN_PRI = "ph000000-0000-4000-a000-000000000002";

  beforeEach(() => {
    setup({
      profiles: [],
      blocks: [],
      profile_privacy_settings: [],
      trips: [
        { id: TRIP_PUB, visibility: "public",  owner_id: ALICE },
        { id: TRIP_PRI, visibility: "private", owner_id: ALICE },
      ],
      trip_plan_items: [
        { id: PLAN_PUB, title: "Visit Tokyo Tower", notes: "Amazing view", trip_id: TRIP_PUB, creator_id: ALICE, removed_at: null, created_at: "2026-01-01T00:00:00Z" },
        { id: PLAN_PRI, title: "Secret Tokyo Plan",  notes: "Hidden info",  trip_id: TRIP_PRI, creator_id: ALICE, removed_at: null, created_at: "2026-01-01T00:00:00Z" },
      ],
    });
  });

  it("returns plan items from public trips", async () => {
    const r = await get("/discovery/search?q=tokyo&type=plans");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((p: any) => p.id as string);
    assert.ok(ids.includes(PLAN_PUB), "Plan from public trip should appear");
  });

  it("excludes plan items from private trips (security)", async () => {
    const r = await get("/discovery/search?q=tokyo&type=plans");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((p: any) => p.id as string);
    assert.ok(!ids.includes(PLAN_PRI), "Plan from private trip must NOT appear");
  });

  it("includes caller-owned private trip plans", async () => {
    // When ME owns the private trip, their own plan items should be visible
    setup({
      profiles: [],
      blocks: [],
      profile_privacy_settings: [],
      trips: [
        { id: TRIP_PRI, visibility: "private", owner_id: ME },  // ME owns this
      ],
      trip_plan_items: [
        { id: PLAN_PRI, title: "My Secret Plan", notes: null, trip_id: TRIP_PRI, creator_id: ME, removed_at: null, created_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const r = await get("/discovery/search?q=secret&type=plans");
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((p: any) => p.id as string);
    assert.ok(ids.includes(PLAN_PRI), "Caller's own plan from private trip should appear");
  });
});

// ── Cursor pagination ──────────────────────────────────────────────────────────

describe("GET /api/discovery/search — cursor pagination", () => {
  it("returns nextCursor and hasMore=true when results fill the limit", async () => {
    const trips = Array.from({ length: 3 }, (_, i) => ({
      id: `trip-${i}`, title: `Tokyo Trip ${i}`,
      destination_city: "Tokyo", destination_country: "Japan",
      owner_id: ALICE, cover_image_url: null,
      start_date: "2026-09-01", status: "planning",
      visibility: "public", created_at: "2026-01-01T00:00:00Z",
    }));
    setup({ profiles: [], blocks: [], trips, profile_privacy_settings: [] });

    const r = await get("/discovery/search?q=tokyo&type=trips&limit=3");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.results.length, 3);
    assert.equal(body.hasMore, true);
    assert.ok(body.nextCursor !== null, "nextCursor should be set");
  });

  it("returns hasMore=false and nextCursor=null when fewer than limit", async () => {
    setup({
      profiles: [],
      blocks: [],
      trips: [
        {
          id: "trip-1", title: "Tokyo Adventure",
          destination_city: "Tokyo", destination_country: "Japan",
          owner_id: ALICE, cover_image_url: null,
          start_date: "2026-09-01", status: "planning",
          visibility: "public", created_at: "2026-01-01T00:00:00Z",
        },
      ],
      profile_privacy_settings: [],
    });

    const r = await get("/discovery/search?q=tokyo&type=trips&limit=10");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.hasMore, false);
    assert.equal(body.nextCursor, null);
  });

  it("type=all respects hasMore/nextCursor based on merged result size", async () => {
    // Seed enough results that the merged set is larger than limit=2
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice Travel", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      events: [
        { id: "evt-1", title: "Travel Expo", description: "Big expo", host_id: ALICE, cover_image_url: null, city: null, country: null, starts_at: null, visibility: "public", status: "published", created_at: "2026-01-01T00:00:00Z" },
      ],
      hashtags: [
        { id: "ht-1", slug: "travellife", name: "travellife", usage_count: 100, is_blocked: false, created_at: "2026-01-01T00:00:00Z" },
      ],
      profile_privacy_settings: [],
      user_follows: [],
      event_rsvps: [],
    });

    // limit=1 forces the merged set to likely exceed 1 → hasMore=true
    const r = await get("/discovery/search?q=travel&type=all&limit=1");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.results.length, 1);
    assert.equal(body.hasMore, true);
    assert.ok(body.nextCursor !== null, "nextCursor should be set for type=all when hasMore");
  });
});

// ── type=all fan-out ───────────────────────────────────────────────────────────

describe("GET /api/discovery/search — type=all fan-out", () => {
  it("merges results from multiple type buckets", async () => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice Travel", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      events: [
        { id: "evt-1", title: "Travel Expo", description: "Big expo", host_id: ALICE, cover_image_url: null, city: null, country: null, starts_at: null, visibility: "public", status: "published", created_at: "2026-01-01T00:00:00Z" },
      ],
      hashtags: [
        { id: "ht-1", slug: "travellife", name: "travellife", usage_count: 100, is_blocked: false, created_at: "2026-01-01T00:00:00Z" },
      ],
      profile_privacy_settings: [],
      user_follows: [],
      event_rsvps: [],
    });

    const r = await get("/discovery/search?q=travel&type=all");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.ok((results as any[]).length > 0, "type=all should return merged results");

    const types = new Set((results as any[]).map((res: any) => res.type as string));
    assert.ok(types.has("travelers"), "should include travelers");
    assert.ok(types.has("events"),    "should include events");
    assert.ok(types.has("hashtags"),  "should include hashtags");
  });

  it("interleaves results round-robin so no single type dominates", async () => {
    // Multiple events + one traveler → traveler should appear early (not at end)
    const manyEvents = Array.from({ length: 5 }, (_, i) => ({
      id: `evt-${i}`, title: `Travel Event ${i}`, description: "desc",
      host_id: ALICE, cover_image_url: null, city: null, country: null,
      starts_at: null, visibility: "public", status: "published",
      created_at: "2026-01-01T00:00:00Z",
    }));
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice Travel", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      events: manyEvents,
      profile_privacy_settings: [],
      user_follows: [],
      event_rsvps: [],
    });

    const r = await get("/discovery/search?q=travel&type=all");
    const { results } = await r.json() as any;
    const types = (results as any[]).map((res: any) => res.type as string);
    const travelerIdx = types.indexOf("travelers");
    assert.ok(travelerIdx >= 0, "travelers should appear");
    // With round-robin interleave, traveler (from bucket 0) appears at index 0
    assert.ok(travelerIdx < 5, "travelers should appear near the top, not at the end");
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────────

describe("GET /api/discovery/search — rate limiting", () => {
  it("returns 429 after 30 requests in the same window", async () => {
    setup({ profiles: [], blocks: [], profile_privacy_settings: [], user_follows: [] });

    for (let i = 0; i < 30; i++) {
      const r = await get("/discovery/search?q=tr&type=travelers");
      assert.equal(r.status, 200, `Request ${i + 1} should succeed`);
    }

    const limited = await get("/discovery/search?q=tr&type=travelers");
    assert.equal(limited.status, 429, "31st request should be rate-limited");
    const body = await limited.json() as any;
    assert.equal(body.error, "rate_limited");
  });
});
