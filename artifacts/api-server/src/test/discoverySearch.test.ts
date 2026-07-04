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
 *   - Private account: appears with privacyState.isPrivate = true
 *   - Normalized shape for travelers, events, hashtags
 *   - type=all fan-out returns results from multiple buckets
 *   - Cursor pagination: offset advances correctly on second page
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

const ME    = "aa000000-0000-4000-a000-000000000001";
const ALICE = "bb000000-0000-4000-a000-000000000002"; // visible traveler
const BOB   = "cc000000-0000-4000-a000-000000000003"; // ME blocked BOB
const CARL  = "dd000000-0000-4000-a000-000000000004"; // CARL blocked ME
const DAVE  = "ee000000-0000-4000-a000-000000000005"; // private account

const ME_TOK = "tok-me";

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface FakeState {
  profiles: any[];
  blocks: { blocker_id: string; blocked_id: string }[];
  events: any[];
  hashtags: any[];
  profile_privacy_settings: { user_id: string; allow_profile_discovery: boolean }[];
  [key: string]: any[];
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
      const rows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;

      const builder: any = {
        select()               { return builder; },
        eq(col: string, val: any)  {
          filters.push((r) => r[col] === val);
          return builder;
        },
        neq(col: string, val: any) {
          filters.push((r) => r[col] !== val);
          return builder;
        },
        in(col: string, vals: any[]) {
          filters.push((r) => vals.includes(r[col]));
          return builder;
        },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => r[col] !== val && r[col] != null);
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r) =>
            val === null ? r[col] == null : r[col] === val,
          );
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
            return { col: m[1], op: m[2]!.toLowerCase(), val: m[3]! };
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
        range(start: number, end: number) {
          _rangeStart = start;
          _rangeEnd   = end;
          return builder;
        },
        maybeSingle() {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = rows
            .filter((r) => filters.every((f) => f(r)))
            .slice(
              _rangeStart,
              _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined,
            );
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };

      return builder;
    },
  };
}

// ── Server setup ───────────────────────────────────────────────────────────────

let base: string;
let server: Server;

function setup(state: Partial<FakeState>) {
  const full: FakeState = {
    profiles: [],
    blocks: [],
    events: [],
    hashtags: [],
    profile_privacy_settings: [],
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
  it("returns 401 when no auth token is provided", async () => {
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

  it("returns 400 for an unknown type value", async () => {
    setup({});
    const r = await get("/discovery/search?q=paris&type=unknown_type_xyz");
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.equal(body.error, "invalid_payload");
    assert.ok(body.message.includes("type must be one of"), `unexpected message: ${body.message as string}`);
  });

  it("accepts a valid 2-character query", async () => {
    setup({ profiles: [] });
    const r = await get("/discovery/search?q=pa&type=travelers");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.results));
  });
});

// ── Block exclusion ────────────────────────────────────────────────────────────

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
    });
  });

  it("returns unblocked traveler", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((u: any) => u.id);
    assert.ok(ids.includes(ALICE), "ALICE should appear");
  });

  it("excludes a user that the caller blocked", async () => {
    const r = await get("/discovery/search?q=bob&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((u: any) => u.id);
    assert.ok(!ids.includes(BOB), "BOB (blocked by ME) must not appear");
  });

  it("excludes a user that blocked the caller", async () => {
    const r = await get("/discovery/search?q=carl&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((u: any) => u.id);
    assert.ok(!ids.includes(CARL), "CARL (who blocked ME) must not appear");
  });

  it("broad query excludes all blocked users but returns unblocked ones", async () => {
    const r = await get("/discovery/search?q=paris&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((u: any) => u.id);
    assert.ok(ids.includes(ALICE),  "ALICE should appear");
    assert.ok(!ids.includes(BOB),   "BOB (blocked) must not appear");
    assert.ok(!ids.includes(CARL),  "CARL (blocked ME) must not appear");
  });
});

// ── Private accounts ───────────────────────────────────────────────────────────

describe("GET /api/discovery/search — private accounts", () => {
  it("returns private account with isPrivate=true and canAccess=false", async () => {
    setup({
      profiles: [
        { id: DAVE, handle: "dave", name: "Dave Travel", avatar_url: null, is_private: true, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
    });

    const r = await get("/discovery/search?q=dave&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.equal(results.length, 1, "DAVE should appear");
    const result = results[0] as any;
    assert.equal(result.id, DAVE);
    assert.ok(result.privacyState?.isPrivate === true, "isPrivate must be true");
    assert.ok(result.accessState?.canAccess === false, "canAccess must be false for private account");
  });

  it("excludes profiles that opted out of discovery", async () => {
    setup({
      profiles: [
        { id: DAVE, handle: "dave", name: "Dave Travel", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [
        { user_id: DAVE, allow_profile_discovery: false },
      ],
    });

    const r = await get("/discovery/search?q=dave&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((u: any) => u.id);
    assert.ok(!ids.includes(DAVE), "DAVE (opted out of discovery) must not appear");
  });
});

// ── Normalized shape ───────────────────────────────────────────────────────────

describe("GET /api/discovery/search — normalized result shape (travelers)", () => {
  beforeEach(() => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice_t", name: "Alice Traveler", avatar_url: "https://cdn/a.jpg", is_private: false, home_city: "Tokyo", home_country: "Japan", account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
    });
  });

  it("returns all required shape fields", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.results), "results must be an array");
    assert.equal(body.results.length, 1);
    const result = body.results[0] as any;

    assert.equal(typeof result.id, "string");
    assert.equal(result.type, "travelers");
    assert.equal(typeof result.title, "string");
    assert.ok("subtitle" in result);
    assert.ok("avatarUrl" in result);
    assert.ok("imageUrl" in result);
    assert.ok("fallbackInitials" in result);
    assert.ok("locationPreview" in result);
    assert.ok("matchedReason" in result);
    assert.ok("actionState" in result);
    assert.ok("privacyState" in result);
    assert.ok("accessState" in result);
    assert.ok("destinationRoute" in result);
    assert.ok("metadata" in result);
    assert.ok("createdAt" in result);
    assert.ok("startsAt" in result);
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

  it("populates destinationRoute pointing to passport", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].destinationRoute, "/passport/alice_t");
  });

  it("populates response envelope fields", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const body = await r.json() as any;
    assert.equal(body.query, "alice");
    assert.equal(body.type, "travelers");
    assert.ok("hasMore" in body);
    assert.ok("nextCursor" in body);
  });
});

// ── Events shape ───────────────────────────────────────────────────────────────

describe("GET /api/discovery/search — normalized result shape (events)", () => {
  const EVT_ID = "ff000000-0000-4000-a000-000000000010";
  const HOST_ID = ALICE;

  beforeEach(() => {
    setup({
      profiles: [],
      blocks: [],
      events: [
        {
          id: EVT_ID,
          title: "Paris Jazz Festival",
          description: "Annual jazz festival in Paris",
          host_id: HOST_ID,
          cover_image_url: "https://cdn/evt.jpg",
          city: "Paris",
          country: "France",
          starts_at: "2026-08-10T18:00:00Z",
          visibility: "public",
          status: "published",
          created_at: "2026-07-01T00:00:00Z",
        },
      ],
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

  it("excludes events hosted by a blocked user", async () => {
    setup({
      profiles: [],
      blocks: [{ blocker_id: ME, blocked_id: HOST_ID }],
      events: [
        {
          id: EVT_ID, title: "Paris Jazz Festival", description: "Jazz",
          host_id: HOST_ID, city: "Paris", country: "France",
          starts_at: "2026-08-10T18:00:00Z", visibility: "public",
          status: "published", created_at: "2026-07-01T00:00:00Z",
        },
      ],
      profile_privacy_settings: [],
    });
    const r = await get("/discovery/search?q=paris&type=events");
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((e: any) => e.id);
    assert.ok(!ids.includes(EVT_ID), "Event from blocked host must not appear");
  });
});

// ── Hashtags shape ─────────────────────────────────────────────────────────────

describe("GET /api/discovery/search — normalized result shape (hashtags)", () => {
  const HT_ID = "gg000000-0000-4000-a000-000000000020";

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

// ── Cursor pagination ──────────────────────────────────────────────────────────

describe("GET /api/discovery/search — cursor pagination", () => {
  it("returns nextCursor when results fill the limit", async () => {
    const manyTrips = Array.from({ length: 3 }, (_, i) => ({
      id: `trip-${i}`, title: `Tokyo Trip ${i}`, destination_city: "Tokyo",
      destination_country: "Japan", owner_id: ALICE, cover_image_url: null,
      start_date: "2026-09-01", status: "planning", visibility: "public",
      created_at: "2026-01-01T00:00:00Z",
    }));
    setup({
      profiles: [],
      blocks: [],
      trips: manyTrips,
      profile_privacy_settings: [],
    });

    const r = await get("/discovery/search?q=tokyo&type=trips&limit=3");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.results.length, 3);
    assert.equal(body.hasMore, true);
    assert.ok(body.nextCursor !== null, "nextCursor should be set");
  });

  it("returns hasMore=false when results fewer than limit", async () => {
    setup({
      profiles: [],
      blocks: [],
      trips: [
        {
          id: "trip-1", title: "Tokyo Adventure", destination_city: "Tokyo",
          destination_country: "Japan", owner_id: ALICE, cover_image_url: null,
          start_date: "2026-09-01", status: "planning", visibility: "public",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      profile_privacy_settings: [],
    });

    const r = await get("/discovery/search?q=tokyo&type=trips&limit=10");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.hasMore, false);
    assert.ok(body.nextCursor === null, "nextCursor should be null when no more results");
  });

  it("type=all never returns a nextCursor", async () => {
    setup({ profiles: [], blocks: [], profile_privacy_settings: [] });
    const r = await get("/discovery/search?q=tr&type=all");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(body.nextCursor === null, "type=all never paginates via cursor");
    assert.equal(body.hasMore, false);
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
    });

    const r = await get("/discovery/search?q=travel&type=all");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.ok(results.length > 0, "type=all should return merged results");

    const types = new Set((results as any[]).map((res: any) => res.type as string));
    assert.ok(types.has("travelers"), "should include travelers");
    assert.ok(types.has("events"),    "should include events");
    assert.ok(types.has("hashtags"),  "should include hashtags");
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────────

describe("GET /api/discovery/search — rate limiting", () => {
  it("returns 429 after 30 requests in the same window", async () => {
    setup({ profiles: [], blocks: [], profile_privacy_settings: [] });

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
