/**
 * GET /api/discovery/search  — unified search endpoint
 *
 * Run: node --import tsx/esm --test src/test/discoverySearch.test.ts
 *
 * Covers:
 *   - Validation: 400 on short/missing q, 400 on bad type, 401 unauthenticated
 *   - Query sanitization: PostgREST metacharacters (, and parens) stripped
 *   - Block exclusion: both directions; fail-closed when DB error
 *   - Private accounts excluded entirely (is_private=true)
 *   - Discovery opt-out excluded (fail-closed)
 *   - Normalized shape: all fields for travelers, events, hashtags
 *   - actionState derived: isFollowing for travelers, isAttending for events
 *   - Plans visibility: public trips included, private trips excluded
 *   - Plans visibility: caller-owned private trips included
 *   - Cursor pagination: limit+1 over-fetch semantics, no false-positive hasMore
 *   - type=all: all type buckets including cities/countries; round-robin; cursor
 *   - Rate limiting: 429 on request 31
 *   - Age-restriction: profiles with age_restriction_enabled=true excluded from travelers, events; fail-closed on DB error
 *   - Hidden gems: age-restricted/suspended submitters excluded; fail-closed
 *   - Plans: trips with deleted/cancelled/banned status excluded from plan search
 *   - Cities/Countries: discovery opt-out (allow_profile_discovery=false) excluded; fail-closed on error
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
const TRIP_PUB = "ff000000-0000-4000-a000-000000000010";
const TRIP_PRI = "ff000000-0000-4000-a000-000000000011";

const ME_TOK = "tok-me";

// Event fixtures must be UPCOMING — discovery search filters out past events.
//
// A literal date here is ambient state: the wall clock, not the code, decides
// whether the test passes. These fixtures were "2026-08-10T18:00:00Z" and began
// failing the instant that moment passed — the event vanished from results, so
// "should include events" failed and actionState was read off a missing element.
// Bumping the year to 2027 fixed the symptom and re-armed the identical failure
// for 2027-08-10.
//
// Derive from now instead, so what the fixture DECLARES is "30 days ahead"
// rather than a literal that merely happens to be in the future today.
const UPCOMING_EVENT_ISO = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface FakeState {
  profiles?: any[];
  blocks?: { blocker_id: string; blocked_id: string }[];
  events?: any[];
  hashtags?: any[];
  profile_privacy_settings?: { user_id: string; allow_profile_discovery: boolean }[];
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

/** Build a fake client. tableErrors: set of table names that return a DB error.
 *  ignoreEqCols: columns whose `.eq()` the fake records but does NOT apply — it
 *  feeds those rows PAST the query filter the way a widened query would, so a
 *  route's in-memory re-check is the only thing left to refuse them. */
function makeFakeClient(
  state: FakeState,
  tableErrors: Set<string> = new Set(),
  ignoreEqCols: Set<string> = new Set(),
) {
  const errorBuilder: any = {};
  const errorFns = ["select","eq","neq","in","not","is","ilike","or","gte","lt","order","limit","range","maybeSingle"];
  for (const fn of errorFns) {
    errorBuilder[fn] = () => errorBuilder;
  }
  errorBuilder.then = (onF: any, _onR: any) =>
    Promise.resolve({ data: null, error: { message: "simulated DB error" } }).then(onF, _onR);

  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => {
      if (tableErrors.has(table)) return errorBuilder;

      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd   = Infinity;
      let _limitN     = Infinity;
      // Column projection for "profiles" only: this table is queried with
      // several different column lists in discoverySearch.ts (traveler
      // search, city/country aggregation, active-owner check). Without
      // projection, a test asserting on a field the real SELECT doesn't
      // request would pass for the wrong reason — the mock would return it
      // anyway. Each `from()` call gets its own builder/closure, so this is
      // scoped correctly per query even though all four hit "profiles".
      let profileCols: string[] | null = null;
      function project(rowsIn: any[]): any[] {
        if (table !== "profiles" || !profileCols) return rowsIn;
        return rowsIn.map((r) => Object.fromEntries(profileCols!.filter((c) => c in r).map((c) => [c, r[c]])));
      }

      const builder: any = {
        select(cols?: string) {
          if (table === "profiles" && typeof cols === "string" && cols !== "*") {
            profileCols = cols.split(",").map((c) => c.trim());
          }
          return builder;
        },
        eq(col: string, val: any)     {
          CAPTURED_EQS.push({ table, col, val });
          if (!ignoreEqCols.has(col)) filters.push((r) => r[col] === val);
          return builder;
        },
        neq(col: string, val: any)    { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[])  { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") { filters.push((r) => r[col] !== val && r[col] != null); return builder; }
          // `.not(col, "in", '("a","b")')` — PostgREST's negated set filter.
          // Modelling only `is` here meant a `.not(…, "in", …)` clause was a
          // silent no-op in the mock: the route could exclude rows in
          // production while every fixture sailed through the test.
          if (op === "in") {
            const vals = new Set(
              String(val).replace(/^\(|\)$/g, "").split(",")
                .map((v) => v.trim().replace(/^"|"$/g, "")),
            );
            filters.push((r) => !vals.has(String(r[col] ?? "")));
            return builder;
          }
          throw new Error(`fake client: unmodelled .not(${col}, "${op}", …)`);
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
        gte(col: string, val: any) {
          filters.push((r) => r[col] != null && r[col] >= val);
          return builder;
        },
        lt(col: string, val: any) {
          filters.push((r) => r[col] != null && r[col] < val);
          return builder;
        },
        order()  { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(start: number, end: number) { _rangeStart = start; _rangeEnd = end; return builder; },
        maybeSingle() {
          const matched = project(sourceRows.filter((r) => filters.every((f) => f(r))));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = project(sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(
              _rangeStart,
              _rangeEnd < Infinity
                ? _rangeEnd + 1
                : _limitN < Infinity
                  ? _limitN
                  : undefined,
            ));
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

// ── Server + helpers ───────────────────────────────────────────────────────────

/** Every `.eq(col, val)` any query carried, so a test can assert that a query
 *  CARRIES a predicate rather than only that its response happened to be right.
 *  Without it, the fake's own row filtering hides a deleted DB predicate. */
const CAPTURED_EQS: Array<{ table: string; col: string; val: any }> = [];

let base: string;
let server: Server;

function setup(state: Partial<FakeState>, tableErrors: string[] = [], ignoreEqCols: string[] = []) {
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
  CAPTURED_EQS.length = 0;
  _setTestClient(makeFakeClient(full, new Set(tableErrors), new Set(ignoreEqCols)) as any, true);
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

// ── Query sanitization ─────────────────────────────────────────────────────────

describe("GET /api/discovery/search — query sanitization", () => {
  it("strips PostgREST metacharacter comma so the query still executes", async () => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Paris France", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],
    });
    // "Paris,France" has a comma that would break PostgREST .or() expression;
    // sanitization should strip it and still find "Paris France".
    const r = await get("/discovery/search?q=Paris%2CFrance&type=travelers");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    // The request should not 500; results may or may not match depending on
    // how the DB interprets the sanitized query — the key assertion is no crash.
    assert.ok(Array.isArray(body.results), "response should have results array after sanitization");
  });

  it("returns 400 when query reduces to less than 2 chars after sanitization", async () => {
    // q=",()" reduces to "" after stripping commas/parens
    setup({});
    const r = await get("/discovery/search?q=%2C%28%29");
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.equal(body.error, "invalid_payload");
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
      // All three opted in to real-name visibility + discovery so the broad
      // "paris" query (which matches only their real names) still surfaces them,
      // keeping the block-exclusion behavior under test exercised.
      profile_privacy_settings: [
        { user_id: ALICE, show_real_name: true },
        { user_id: BOB,   show_real_name: true },
        { user_id: CARL,  show_real_name: true },
      ],
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

  it("broad query: blocks excluded, others visible", async () => {
    const r = await get("/discovery/search?q=paris&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((u: any) => u.id as string);
    assert.ok(ids.includes(ALICE),  "ALICE should appear");
    assert.ok(!ids.includes(BOB),   "BOB (blocked) must not appear");
    assert.ok(!ids.includes(CARL),  "CARL (blocked ME) must not appear");
  });
});

// ── Block fail-closed ─────────────────────────────────────────────────────────

describe("GET /api/discovery/search — block lookup fail-closed", () => {
  it("returns empty results when the blocks table returns a DB error", async () => {
    // Seed profiles that would normally match, but blocks table errors → fail-closed
    setup(
      {
        profiles: [
          { id: ALICE, handle: "alice", name: "Alice Paris", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
        ],
        profile_privacy_settings: [],
        user_follows: [],
      },
      ["blocks"],  // simulate DB error on blocks table
    );
    const r = await get("/discovery/search?q=alice&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.equal(results.length, 0, "Fail-closed: results must be empty when block state is unknown");
  });
});

// ── Private accounts: locked preview, not excluded ─────────────────────────────

describe("GET /api/discovery/search — private accounts shown as a locked preview", () => {
  it("returns a private account as a locked preview (matches /users/search behavior)", async () => {
    const PRIVATE = "ee000000-0000-4000-a000-000000000005";
    setup({
      profiles: [
        { id: PRIVATE, handle: "ghost", name: "Ghost Traveler", avatar_url: "https://cdn/ghost.jpg", is_private: true, home_city: "Berlin", home_country: "Germany", account_status: "active" },
        { id: ALICE,   handle: "alice", name: "Alice Travel",   avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      // ALICE opted in so the "travel" query (matching only her real name) surfaces her.
      profile_privacy_settings: [{ user_id: ALICE, show_real_name: true }],
      user_follows: [],
    });

    const r = await get("/discovery/search?q=ghost&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ghost = (results as any[]).find((u: any) => u.id === PRIVATE);
    assert.ok(ghost, "Private account should be discoverable by handle, not vanish entirely");
    assert.equal(ghost.privacyState?.isPrivate, true);
    assert.equal(ghost.accessState?.canAccess, false);
    assert.equal(ghost.avatarUrl, null, "Locked preview must not leak the avatar");
    assert.equal(ghost.locationPreview, null, "Locked preview must not leak location");
    assert.equal(ghost.actionState?.isFollowing, false);
    assert.equal(ghost.actionState?.isRequestSent, false);
  });

  it("shows a followed private account with full info, not a locked preview", async () => {
    const PRIVATE = "ee000000-0000-4000-a000-000000000006";
    setup({
      profiles: [
        { id: PRIVATE, handle: "ghost2", name: "Ghost Two", avatar_url: "https://cdn/ghost2.jpg", is_private: true, home_city: "Berlin", home_country: "Germany", account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [{ user_id: PRIVATE, show_real_name: true }],
      user_follows: [{ follower_id: ME, following_id: PRIVATE }],
    });

    const r = await get("/discovery/search?q=ghost2&type=travelers");
    const { results } = await r.json() as any;
    const ghost = results[0] as any;
    assert.equal(ghost.privacyState?.isPrivate, false);
    assert.equal(ghost.accessState?.canAccess, true);
    assert.equal(ghost.avatarUrl, "https://cdn/ghost2.jpg");
    assert.equal(ghost.actionState?.isFollowing, true);
  });

  it("excludes profiles that opted out of discovery (fail-closed on opt-out error)", async () => {
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

// ── show_profile_picture_publicly enforcement ───────────────────────────────────
//
// Independent of the is_private locked-preview gate above: a PUBLIC profile's
// owner can still opt out of showing their photo to searchers who aren't
// already a follower or friend. Before this fix, isPrivate = is_private &&
// !isFollowing was the ONLY gate on avatarUrl — a public profile (is_private
// = false) fell straight through to `p.avatar_url` regardless of the flag.

describe("GET /api/discovery/search — show_profile_picture_publicly enforcement", () => {
  it("hides avatarUrl for a public profile whose owner turned the photo off, for a stranger", async () => {
    const DAVE = "ee000000-0000-4000-a000-000000000007";
    setup({
      profiles: [
        { id: DAVE, handle: "dave_hidden", name: "Dave Hidden", avatar_url: "https://cdn/dave.jpg", is_private: false, home_city: null, home_country: null, account_status: "active", show_profile_picture_publicly: false },
      ],
      profile_privacy_settings: [{ user_id: DAVE, show_real_name: true }],
      user_follows: [],
      user_friendships: [],
    });
    const r = await get("/discovery/search?q=dave&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const dave = (results as any[]).find((u: any) => u.id === DAVE);
    assert.ok(dave, "public profile must still be discoverable");
    assert.equal(dave.privacyState?.isPrivate, false, "the ACCOUNT is public — this is not the locked-preview case");
    assert.equal(dave.accessState?.canAccess, true);
    assert.equal(dave.avatarUrl, null, "avatarUrl must be null when show_profile_picture_publicly=false and the viewer is unconnected");
  });

  it("shows avatarUrl for a public profile whose owner left the photo on", async () => {
    const EVE = "ee000000-0000-4000-a000-000000000008";
    setup({
      profiles: [
        { id: EVE, handle: "eve_shown", name: "Eve Shown", avatar_url: "https://cdn/eve.jpg", is_private: false, home_city: null, home_country: null, account_status: "active", show_profile_picture_publicly: true },
      ],
      profile_privacy_settings: [{ user_id: EVE, show_real_name: true }],
      user_follows: [],
      user_friendships: [],
    });
    const r = await get("/discovery/search?q=eve&type=travelers");
    const { results } = await r.json() as any;
    const eve = (results as any[]).find((u: any) => u.id === EVE);
    assert.equal(eve.avatarUrl, "https://cdn/eve.jpg");
  });

  it("shows avatarUrl to a follower even when the flag is off", async () => {
    const FRED = "ee000000-0000-4000-a000-000000000009";
    setup({
      profiles: [
        { id: FRED, handle: "fred_hidden", name: "Fred Hidden", avatar_url: "https://cdn/fred.jpg", is_private: false, home_city: null, home_country: null, account_status: "active", show_profile_picture_publicly: false },
      ],
      profile_privacy_settings: [{ user_id: FRED, show_real_name: true }],
      user_follows: [{ follower_id: ME, following_id: FRED }],
      user_friendships: [],
    });
    const r = await get("/discovery/search?q=fred&type=travelers");
    const { results } = await r.json() as any;
    const fred = (results as any[]).find((u: any) => u.id === FRED);
    assert.equal(fred.avatarUrl, "https://cdn/fred.jpg");
  });

  it("shows avatarUrl to a friend even when the flag is off (friendship stored as user_a < user_b, viewer on either side)", async () => {
    const GINA = "ee000000-0000-4000-a000-00000000000a";
    // GINA's uuid sorts AFTER ME, so the normalized row is (ME, GINA) — this
    // exercises the "friendsAsA" query direction.
    setup({
      profiles: [
        { id: GINA, handle: "gina_hidden", name: "Gina Hidden", avatar_url: "https://cdn/gina.jpg", is_private: false, home_city: null, home_country: null, account_status: "active", show_profile_picture_publicly: false },
      ],
      profile_privacy_settings: [{ user_id: GINA, show_real_name: true }],
      user_follows: [],
      user_friendships: [{ user_a: ME, user_b: GINA }],
    });
    const r = await get("/discovery/search?q=gina&type=travelers");
    const { results } = await r.json() as any;
    const gina = (results as any[]).find((u: any) => u.id === GINA);
    assert.equal(gina.avatarUrl, "https://cdn/gina.jpg");
  });

  it("shows avatarUrl to a friend on the other normalized side (friendsAsB direction)", async () => {
    const AAA = "01000000-0000-4000-a000-000000000001"; // uuid sorts BEFORE ME
    // AAA's uuid sorts before ME's ("aa000000..."), so the normalized row is
    // (AAA, ME) — this exercises the "friendsAsB" query direction.
    setup({
      profiles: [
        { id: AAA, handle: "aaa_hidden", name: "Aaa Hidden", avatar_url: "https://cdn/aaa.jpg", is_private: false, home_city: null, home_country: null, account_status: "active", show_profile_picture_publicly: false },
      ],
      profile_privacy_settings: [{ user_id: AAA, show_real_name: true }],
      user_follows: [],
      user_friendships: [{ user_a: AAA, user_b: ME }],
    });
    const r = await get("/discovery/search?q=aaa&type=travelers");
    const { results } = await r.json() as any;
    const aaa = (results as any[]).find((u: any) => u.id === AAA);
    assert.equal(aaa.avatarUrl, "https://cdn/aaa.jpg");
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
      // ALICE opted in to real-name visibility so title/initials reflect her real name.
      profile_privacy_settings: [{ user_id: ALICE, show_real_name: true }],
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

  it("populates title, subtitle (@handle), avatarUrl, fallbackInitials, locationPreview, destinationRoute", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    const res = results[0] as any;
    assert.equal(res.title,            "Alice Traveler");
    assert.equal(res.subtitle,         "@alice_t");
    assert.equal(res.avatarUrl,        "https://cdn/a.jpg");
    assert.equal(res.fallbackInitials, "AT");
    assert.equal(res.locationPreview,  "Tokyo, Japan");
    assert.equal(res.destinationRoute, "/passport/alice_t");
  });

  it("derives actionState.isFollowing=true when caller follows the traveler", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].actionState?.isFollowing, true);
  });

  it("derives actionState.isFollowing=false when caller does not follow", async () => {
    setup({
      profiles: [{ id: ALICE, handle: "alice_t", name: "Alice Traveler", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" }],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],
    });
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].actionState?.isFollowing, false);
  });

  it("privacyState.isPrivate=false and accessState.canAccess=true for public accounts", async () => {
    const r = await get("/discovery/search?q=alice&type=travelers");
    const { results } = await r.json() as any;
    assert.equal(results[0].privacyState?.isPrivate, false);
    assert.equal(results[0].accessState?.canAccess, true);
  });

  it("includes query and type in response envelope", async () => {
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
  const EVT_ID = "fe000000-0000-4000-a000-000000000020";

  beforeEach(() => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      events: [
        {
          id: EVT_ID, title: "Paris Jazz Festival",
          description: "Annual jazz in Paris",
          host_id: ALICE, cover_url: "https://cdn/evt.jpg",
          city: "Paris", country: "France",
          starts_at: UPCOMING_EVENT_ISO,
          visibility: "public", state: "open",
          created_at: "2026-07-01T00:00:00Z",
        },
      ],
      event_rsvps: [{ event_id: EVT_ID, user_id: ME, status: "going" }],
      profile_privacy_settings: [],
    });
  });

  it("returns event with correct shape and actionState.isAttending=true", async () => {
    const r = await get("/discovery/search?q=paris&type=events");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.equal(results.length, 1);
    const evt = results[0] as any;
    assert.equal(evt.id,            EVT_ID);
    assert.equal(evt.type,          "events");
    assert.equal(evt.title,         "Paris Jazz Festival");
    assert.equal(evt.locationPreview, "Paris, France");
    assert.equal(evt.imageUrl,      "https://cdn/evt.jpg");
    assert.equal(evt.startsAt,      UPCOMING_EVENT_ISO);
    assert.equal(evt.destinationRoute, `/event/${EVT_ID}`);
    assert.equal(evt.actionState?.isAttending, true);
  });

  it("derives actionState.isAttending=false when caller has no RSVP", async () => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      events: [{ id: EVT_ID, title: "Paris Jazz Festival", description: "Jazz", host_id: ALICE, city: "Paris", country: "France", starts_at: UPCOMING_EVENT_ISO, visibility: "public", state: "open", created_at: "2026-07-01T00:00:00Z" }],
      event_rsvps: [],
      profile_privacy_settings: [],
    });
    const r = await get("/discovery/search?q=paris&type=events");
    const { results } = await r.json() as any;
    assert.equal(results[0].actionState?.isAttending, false);
  });

  it("excludes events hosted by a blocked user", async () => {
    setup({
      blocks: [{ blocker_id: ME, blocked_id: ALICE }],
      events: [{ id: EVT_ID, title: "Paris Jazz Festival", description: "Jazz", host_id: ALICE, city: "Paris", country: "France", starts_at: null, visibility: "public", state: "open", created_at: "2026-07-01T00:00:00Z" }],
      event_rsvps: [],
      profile_privacy_settings: [],
    });
    const r = await get("/discovery/search?q=paris&type=events");
    const { results } = await r.json() as any;
    assert.ok(!(results as any[]).some((e: any) => e.id === EVT_ID), "Blocked host's event must not appear");
  });

  it("excludes events hosted by a suspended account", async () => {
    const SUSPENDED = "su000000-0000-4000-a000-000000000099";
    setup({
      profiles: [
        { id: SUSPENDED, handle: "susp", name: "Suspended User", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "suspended" },
      ],
      blocks: [],
      events: [{ id: EVT_ID, title: "Paris Jazz Festival", description: "Jazz", host_id: SUSPENDED, city: "Paris", country: "France", starts_at: null, visibility: "public", state: "open", created_at: "2026-07-01T00:00:00Z" }],
      event_rsvps: [],
      profile_privacy_settings: [],
    });
    const r = await get("/discovery/search?q=paris&type=events");
    const { results } = await r.json() as any;
    assert.ok(!(results as any[]).some((e: any) => e.id === EVT_ID), "Suspended host's event must not appear");
  });
});

// ── Hashtags shape ─────────────────────────────────────────────────────────────

describe("GET /api/discovery/search — normalized result shape (hashtags)", () => {
  const HT_ID = "gg000000-0000-4000-a000-000000000030";

  it("returns hashtag with correct shape", async () => {
    setup({
      blocks: [],
      hashtags: [{ id: HT_ID, slug: "wanderlust", name: "wanderlust", usage_count: 1234, is_blocked: false, created_at: "2026-01-01T00:00:00Z" }],
      profile_privacy_settings: [],
    });
    const r = await get("/discovery/search?q=wander&type=hashtags");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.equal(results.length, 1);
    const ht = results[0] as any;
    assert.equal(ht.id,              HT_ID);
    assert.equal(ht.type,            "hashtags");
    assert.equal(ht.title,           "#wanderlust");
    assert.equal(ht.fallbackInitials, "#");
    assert.equal(ht.destinationRoute, "/hashtag/wanderlust");
    assert.equal((ht.metadata as any).usageCount, 1234);
  });

  it("excludes blocked hashtags", async () => {
    setup({
      blocks: [],
      hashtags: [{ id: HT_ID, slug: "spamtag", name: "spamtag", usage_count: 0, is_blocked: true, created_at: "2026-01-01T00:00:00Z" }],
      profile_privacy_settings: [],
    });
    const r = await get("/discovery/search?q=spam&type=hashtags");
    const { results } = await r.json() as any;
    assert.equal(results.length, 0, "Blocked hashtag must not appear");
  });
});

// ── Plans — trip visibility enforcement ───────────────────────────────────────

describe("GET /api/discovery/search — plans: trip visibility enforcement", () => {
  const PLAN_PUB = "ph000000-0000-4000-a000-000000000001";
  const PLAN_PRI = "ph000000-0000-4000-a000-000000000002";
  const PLAN_OWN = "ph000000-0000-4000-a000-000000000003";

  beforeEach(() => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],
      trips: [
        { id: TRIP_PUB, visibility: "public",  owner_id: ALICE, status: "planning", show_in_discovery: true },
        { id: TRIP_PRI, visibility: "private", owner_id: ALICE, status: "planning", show_in_discovery: false },
      ],
      trip_plan_items: [
        { id: PLAN_PUB, title: "Visit Tokyo Tower", notes: "Amazing", trip_id: TRIP_PUB, creator_id: ALICE, removed_at: null, created_at: "2026-01-01T00:00:00Z" },
        { id: PLAN_PRI, title: "Secret Tokyo Plan",  notes: "Hidden",  trip_id: TRIP_PRI, creator_id: ALICE, removed_at: null, created_at: "2026-01-01T00:00:00Z" },
      ],
    });
  });

  it("returns plan items from public trips", async () => {
    const r = await get("/discovery/search?q=tokyo&type=plans");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.ok((results as any[]).some((p: any) => p.id === PLAN_PUB), "Plan from public trip should appear");
  });

  it("excludes plan items from private trips (security)", async () => {
    const r = await get("/discovery/search?q=tokyo&type=plans");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.ok(!(results as any[]).some((p: any) => p.id === PLAN_PRI), "Plan from private trip must NOT appear");
  });

  it("includes caller-owned private trip plans", async () => {
    setup({
      profiles: [
        { id: ME, handle: "me", name: "Me", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],
      trips: [{ id: TRIP_PRI, visibility: "private", owner_id: ME, status: "planning" }],
      trip_plan_items: [
        { id: PLAN_OWN, title: "My Secret Plan", notes: null, trip_id: TRIP_PRI, creator_id: ME, removed_at: null, created_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const r = await get("/discovery/search?q=secret&type=plans");
    const { results } = await r.json() as any;
    assert.ok((results as any[]).some((p: any) => p.id === PLAN_OWN), "Caller's own plan from private trip should appear");
  });
});

// ── Cursor pagination ──────────────────────────────────────────────────────────

describe("GET /api/discovery/search — cursor pagination", () => {
  it("hasMore=true and nextCursor set when DB returns more than limit rows (limit+1 semantics)", async () => {
    // With limit=3, route fetches limit+1=4 rows. Seed exactly 4 trips → DB returns 4 → hasMore=true.
    const trips = Array.from({ length: 4 }, (_, i) => ({
      id: `tt00000${i}-0000-4000-a000-000000000000`,
      title: `Tokyo Trip ${i}`, destination_city: "Tokyo",
      destination_country: "Japan", owner_id: ALICE,
      cover_url: null, start_date: "2026-09-01",
      status: "planning", visibility: "public", show_in_discovery: true,
      created_at: "2026-01-01T00:00:00Z",
    }));
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [], trips, profile_privacy_settings: [],
    });

    const r = await get("/discovery/search?q=tokyo&type=trips&limit=3");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.results.length, 3, "Should return exactly limit results");
    assert.equal(body.hasMore, true,  "hasMore must be true when DB has limit+1 rows");
    assert.ok(body.nextCursor !== null, "nextCursor must be set");
  });

  it("hasMore=false and nextCursor=null when DB returns exactly limit rows (no false positive)", async () => {
    // Seed exactly 3 trips → DB returns 3 < limit+1=4 → hasMore=false (no false positive)
    const trips = Array.from({ length: 3 }, (_, i) => ({
      id: `tt10000${i}-0000-4000-a000-000000000000`,
      title: `Tokyo Trip ${i}`, destination_city: "Tokyo",
      destination_country: "Japan", owner_id: ALICE,
      cover_url: null, start_date: "2026-09-01",
      status: "planning", visibility: "public", show_in_discovery: true,
      created_at: "2026-01-01T00:00:00Z",
    }));
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [], trips, profile_privacy_settings: [],
    });

    const r = await get("/discovery/search?q=tokyo&type=trips&limit=3");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.hasMore, false,   "No false-positive hasMore when DB has exactly limit rows");
    assert.equal(body.nextCursor, null, "nextCursor must be null when hasMore=false");
  });

  it("excludes trips owned by a suspended account", async () => {
    const SUSPENDED = "su000000-0000-4000-a000-000000000099";
    const trips = [{
      id: "tt-susp-0000-4000-a000-000000000099",
      title: "Tokyo Adventure", destination_city: "Tokyo",
      destination_country: "Japan", owner_id: SUSPENDED,
      cover_url: null, start_date: "2026-09-01",
      status: "planning", visibility: "public", show_in_discovery: true,
      created_at: "2026-01-01T00:00:00Z",
    }];
    setup({
      profiles: [
        { id: SUSPENDED, handle: "susp", name: "Suspended", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "suspended" },
      ],
      blocks: [], trips, profile_privacy_settings: [],
    });
    const r = await get("/discovery/search?q=tokyo&type=trips");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.equal(results.length, 0, "Suspended owner's trip must not appear");
  });

  it("type=all: hasMore and nextCursor reflect merged pool size vs limit", async () => {
    // Seed enough items across types so merged pool exceeds limit=1
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice Travel", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      events: [
        { id: "evt-1", title: "Travel Expo", description: "Expo", host_id: ALICE, city: null, country: null, starts_at: null, visibility: "public", state: "open", created_at: "2026-01-01T00:00:00Z" },
      ],
      hashtags: [
        { id: "ht-1", slug: "travellife", name: "travellife", usage_count: 100, is_blocked: false, created_at: "2026-01-01T00:00:00Z" },
      ],
      profile_privacy_settings: [],
      user_follows: [],
      event_rsvps: [],
    });

    const r = await get("/discovery/search?q=travel&type=all&limit=1");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.results.length, 1,   "Should return exactly limit=1 result");
    assert.equal(body.hasMore, true,       "hasMore must be true when merged pool exceeds limit");
    assert.ok(body.nextCursor !== null,    "nextCursor must be set for type=all with hasMore");
  });
});

// ── type=all fan-out ───────────────────────────────────────────────────────────

describe("GET /api/discovery/search — type=all fan-out", () => {
  it("merges results from travelers, events, and hashtags (multi-bucket)", async () => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice Travel", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      events: [
        { id: "evt-1", title: "Travel Expo", description: "Expo", host_id: ALICE, city: null, country: null, starts_at: UPCOMING_EVENT_ISO, visibility: "public", state: "open", created_at: "2026-01-01T00:00:00Z" },
      ],
      hashtags: [
        { id: "ht-1", slug: "travellife", name: "travellife", usage_count: 100, is_blocked: false, created_at: "2026-01-01T00:00:00Z" },
      ],
      // ALICE opted in so the "travel" query matches her real name in the travelers bucket.
      profile_privacy_settings: [{ user_id: ALICE, show_real_name: true }],
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

  it("includes cities and countries in the fan-out", async () => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice Travel", avatar_url: null, is_private: false, home_city: "Tokyo", home_country: "Japan", account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],
    });

    const r = await get("/discovery/search?q=tokyo&type=all");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const types = new Set((results as any[]).map((res: any) => res.type as string));
    // cities aggregated from profiles.home_city
    assert.ok(types.has("cities"), "type=all should include cities");
  });

  it("includes static types (languages, interests, vibes) in fan-out", async () => {
    setup({ blocks: [], profile_privacy_settings: [] });

    const r = await get("/discovery/search?q=eng&type=all");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const types = new Set((results as any[]).map((res: any) => res.type as string));
    assert.ok(types.has("languages"), "type=all should include languages (English matches 'eng')");
  });

  it("interleaves round-robin so no single type dominates the top results", async () => {
    const manyEvents = Array.from({ length: 8 }, (_, i) => ({
      id: `evt-${i}`, title: `Travel Event ${i}`, description: "desc",
      // Missed by the 2026->2027 bump, so these eight stayed expired. That
      // silently defanged this test rather than failing it: past events are
      // filtered out, leaving nothing for round-robin to interleave against,
      // so `travelerIdx < 5` passed vacuously with travelers as the only
      // bucket. A fixture that expires does not always go red — sometimes it
      // just stops testing anything.
      host_id: ALICE, city: null, country: null, starts_at: UPCOMING_EVENT_ISO,
      visibility: "public", state: "open",
      created_at: "2026-01-01T00:00:00Z",
    }));
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice Travel", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      events: manyEvents,
      // ALICE opted in so the "travel" query surfaces her in the travelers bucket.
      profile_privacy_settings: [{ user_id: ALICE, show_real_name: true }],
      user_follows: [],
      event_rsvps: [],
    });

    const r = await get("/discovery/search?q=travel&type=all");
    const { results } = await r.json() as any;
    const types = (results as any[]).map((res: any) => res.type as string);
    const travelerIdx = types.indexOf("travelers");
    assert.ok(travelerIdx >= 0, "travelers should appear");
    // Round-robin: travelers (bucket 0) should appear at position 0
    assert.ok(travelerIdx < 5, "travelers should appear near the top with round-robin interleave");
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────────

describe("GET /api/discovery/search — rate limiting", () => {
  it("returns 429 after 30 requests in the same window", async () => {
    setup({ blocks: [], profile_privacy_settings: [], user_follows: [] });

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

// ── Age-restriction exclusion ──────────────────────────────────────────────────
//
// Profiles with age_restriction_enabled=true in user_privacy_settings must be
// excluded fail-closed from all search types. Viewer age is unverifiable, so
// the rule is unconditional.

const AGE_DAVE = "ee000000-0000-4000-a000-000000000020";
const EVT_AGE  = "ee000000-0000-4000-a000-000000000021";

describe("GET /api/discovery/search — age-restricted content exclusion", () => {
  it("excludes a traveler whose profile has age_restriction_enabled=true", async () => {
    setup({
      profiles: [
        {
          id: ALICE, handle: "alice", name: "Alice Travel", avatar_url: null,
          is_private: false, home_city: null, home_country: null, account_status: "active",
        },
        {
          id: AGE_DAVE, handle: "dave", name: "Dave Travel", avatar_url: null,
          is_private: false, home_city: null, home_country: null, account_status: "active",
        },
      ],
      blocks: [],
      // ALICE opted in so the "travel" query matches her real name; DAVE is
      // excluded by age-restriction regardless of name visibility.
      profile_privacy_settings: [{ user_id: ALICE, show_real_name: true }],
      user_follows: [],
      user_privacy_settings: [
        { user_id: AGE_DAVE, age_restriction_enabled: true },
      ],
    });

    const r = await get("/discovery/search?q=travel&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((u: any) => u.id as string);
    assert.ok(!ids.includes(AGE_DAVE), "Age-restricted profile must NOT appear in travelers");
    assert.ok(ids.includes(ALICE),     "Non-age-restricted profile should appear");
  });

  it("excludes an event whose host has age_restriction_enabled=true", async () => {
    setup({
      profiles: [
        {
          id: AGE_DAVE, handle: "dave", name: "Dave", avatar_url: null,
          is_private: false, home_city: null, home_country: null, account_status: "active",
        },
        {
          id: ALICE, handle: "alice", name: "Alice", avatar_url: null,
          is_private: false, home_city: null, home_country: null, account_status: "active",
        },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],
      events: [
        {
          id: EVT_AGE, title: "Night Travel Fest", host_id: AGE_DAVE,
          city: "Manila", country: null, starts_at: UPCOMING_EVENT_ISO, cover_url: null,
          description: null, visibility: "public", status: "upcoming", created_at: "2026-09-01T00:00:00Z",
        },
        {
          id: "ee000000-0000-4000-a000-000000000022", title: "Day Travel Fair", host_id: ALICE,
          city: "Cebu", country: null, starts_at: UPCOMING_EVENT_ISO, cover_url: null,
          description: null, visibility: "public", status: "upcoming", created_at: "2026-09-02T00:00:00Z",
        },
      ],
      event_rsvps: [],
      user_privacy_settings: [
        { user_id: AGE_DAVE, age_restriction_enabled: true },
      ],
    });

    const r = await get("/discovery/search?q=travel&type=events");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((u: any) => u.id as string);
    assert.ok(!ids.includes(EVT_AGE), "Event hosted by age-restricted user must NOT appear");
    assert.ok(ids.some((id: string) => id !== EVT_AGE), "Events from non-age-restricted hosts should appear");
  });

  it("returns empty results (fail-closed) when user_privacy_settings table returns a DB error", async () => {
    setup(
      {
        profiles: [
          {
            id: ALICE, handle: "alice", name: "Alice Travel", avatar_url: null,
            is_private: false, home_city: null, home_country: null, account_status: "active",
          },
        ],
        blocks: [],
        profile_privacy_settings: [],
        user_follows: [],
      },
      ["user_privacy_settings"],
    );

    const r = await get("/discovery/search?q=alice&type=travelers");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.equal(results.length, 0, "Fail-closed: must return empty when age-restriction state is unknown");
  });
});

// ── Hidden gems — submitter account-state and age-restriction ──────────────────

const GEM_OK   = "gg000000-0000-4000-a000-000000000030";
const GEM_AGE  = "gg000000-0000-4000-a000-000000000031";
const GEM_SUSP = "gg000000-0000-4000-a000-000000000032";
const SUSP_USER = "gg000000-0000-4000-a000-000000000033";

describe("GET /api/discovery/search — hidden gems submitter enforcement", () => {
  it("excludes a hidden gem submitted by an age-restricted user", async () => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
        { id: AGE_DAVE, handle: "dave", name: "Dave", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],
      hidden_gems: [
        { id: GEM_OK,  name: "Secret Beach",    description: null, city: "Cebu", country: "PH", submitted_by: ALICE,    image_url: null, category: "nature", status: "active", sensitivity_level: "public", approx_latitude: 10.31, approx_longitude: 123.89, created_at: "2026-01-01T00:00:00Z" },
        { id: GEM_AGE, name: "Adult Night Spot", description: null, city: "Cebu", country: "PH", submitted_by: AGE_DAVE, image_url: null, category: "nightlife", status: "active", sensitivity_level: "public", approx_latitude: 10.31, approx_longitude: 123.89, created_at: "2026-01-01T00:00:00Z" },
      ],
      user_privacy_settings: [
        { user_id: AGE_DAVE, age_restriction_enabled: true },
      ],
    });

    const r = await get("/discovery/search?q=cebu&type=hidden_gems");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((g: any) => g.id as string);
    assert.ok(ids.includes(GEM_OK),   "Gem from non-restricted submitter should appear");
    assert.ok(!ids.includes(GEM_AGE), "Gem from age-restricted submitter must NOT appear");
  });

  it("excludes a hidden gem submitted by a suspended account", async () => {
    setup({
      profiles: [
        { id: ALICE,     handle: "alice", name: "Alice", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
        { id: SUSP_USER, handle: "susp",  name: "Susp",  avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "suspended" },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],
      hidden_gems: [
        { id: GEM_OK,   name: "Gem Cebu",  description: null, city: "Cebu", country: "PH", submitted_by: ALICE,     image_url: null, category: "nature", status: "active", sensitivity_level: "public", approx_latitude: 10.31, approx_longitude: 123.89, created_at: "2026-01-01T00:00:00Z" },
        { id: GEM_SUSP, name: "Gem Cebu2", description: null, city: "Cebu", country: "PH", submitted_by: SUSP_USER, image_url: null, category: "nature", status: "active", sensitivity_level: "public", approx_latitude: 10.31, approx_longitude: 123.89, created_at: "2026-01-01T00:00:00Z" },
      ],
      user_privacy_settings: [],
    });

    const r = await get("/discovery/search?q=cebu&type=hidden_gems");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((g: any) => g.id as string);
    assert.ok(ids.includes(GEM_OK),    "Gem from active submitter should appear");
    assert.ok(!ids.includes(GEM_SUSP), "Gem from suspended submitter must NOT appear");
  });
});

// ── Plans — deleted/cancelled/banned trip status exclusion ────────────────────

const PLAN_DEL = "pd000000-0000-4000-a000-000000000040";
const TRIP_DEL = "td000000-0000-4000-a000-000000000041";
const PLAN_LIVE = "pd000000-0000-4000-a000-000000000042";
const TRIP_LIVE = "td000000-0000-4000-a000-000000000043";

describe("GET /api/discovery/search — plans: deleted/cancelled/banned trip exclusion", () => {
  it("excludes plan items from a deleted trip", async () => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [],
      user_follows: [],
      trips: [
        { id: TRIP_LIVE, visibility: "public", owner_id: ALICE, status: "planning", show_in_discovery: true },
        { id: TRIP_DEL,  visibility: "public", owner_id: ALICE, status: "deleted",  show_in_discovery: true },
      ],
      trip_plan_items: [
        { id: PLAN_LIVE, title: "Visit Museum",  notes: null, trip_id: TRIP_LIVE, creator_id: ALICE, removed_at: null, created_at: "2026-01-01T00:00:00Z" },
        { id: PLAN_DEL,  title: "Visit Museum2", notes: null, trip_id: TRIP_DEL,  creator_id: ALICE, removed_at: null, created_at: "2026-01-01T00:00:00Z" },
      ],
      user_privacy_settings: [],
    });

    const r = await get("/discovery/search?q=museum&type=plans");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const ids = (results as any[]).map((p: any) => p.id as string);
    assert.ok(ids.includes(PLAN_LIVE),  "Plan from active trip should appear");
    assert.ok(!ids.includes(PLAN_DEL), "Plan from deleted trip must NOT appear");
  });
});

// ── Places — livingPageId enrichment ─────────────────────────────────────────
//
// When a discovery_places row has a canonical_location_id, the corresponding
// search result must carry livingPageId in its metadata.  When the field is
// absent (or null), metadata must NOT include livingPageId at all.

const PLACE_A_ID  = "11100000-0000-4000-a000-000000000001"; // has canonical_location_id
const PLACE_B_ID  = "22200000-0000-4000-a000-000000000002"; // no canonical_location_id
const LIVING_UUID = "33300000-0000-4000-a000-000000000003"; // the canonical places.id

describe("GET /api/discovery/search — places: livingPageId enrichment", () => {
  beforeEach(() => {
    setup({
      discovery_places: [
        {
          id: PLACE_A_ID,
          name: "Kawasan Falls",
          city: "Badian",
          blurb: "Stunning tiered waterfall",
          image_url: null,
          header_image_source: null,
          image_source_type: null,
          image_accuracy_status: null,
          category: "nature",
          primary_category: "nature",
          lat: 9.8,
          lng: 123.4,
          canonical_location_id: LIVING_UUID,
          status: "active",
          saved_count: 50,
          created_at: "2025-01-01T00:00:00Z",
        },
        {
          id: PLACE_B_ID,
          name: "Bantayan Beach",
          city: "Bantayan",
          blurb: "White sand beach getaway",
          image_url: null,
          header_image_source: null,
          image_source_type: null,
          image_accuracy_status: null,
          category: "beach",
          primary_category: "beach",
          lat: 11.2,
          lng: 123.7,
          canonical_location_id: null,
          status: "active",
          saved_count: 30,
          created_at: "2025-01-02T00:00:00Z",
        },
      ],
    });
  });

  it("place result with canonical_location_id carries livingPageId in metadata", async () => {
    const r = await get("/discovery/search?q=kawasan&type=places");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const place = (results as any[]).find((p: any) => p.id === PLACE_A_ID);
    assert.ok(place, "Kawasan Falls should appear");
    assert.equal(
      (place.metadata as any)?.livingPageId,
      LIVING_UUID,
      "livingPageId must equal the canonical_location_id from the DB row",
    );
  });

  it("place result without canonical_location_id does NOT carry livingPageId", async () => {
    const r = await get("/discovery/search?q=bantayan&type=places");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const place = (results as any[]).find((p: any) => p.id === PLACE_B_ID);
    assert.ok(place, "Bantayan Beach should appear");
    assert.equal(
      (place.metadata as any)?.livingPageId,
      undefined,
      "livingPageId must be absent when canonical_location_id is null",
    );
  });
});

// ── Cities — discovery opt-out exclusion ──────────────────────────────────────

describe("GET /api/discovery/search — cities: discovery opt-out exclusion", () => {
  it("excludes a city contributed only by opt-out profiles", async () => {
    setup({
      profiles: [
        { id: ALICE,    handle: "alice", name: "Alice", avatar_url: null, is_private: false, home_city: "Cebu",   home_country: "PH", account_status: "active" },
        { id: AGE_DAVE, handle: "dave",  name: "Dave",  avatar_url: null, is_private: false, home_city: "Manila", home_country: "PH", account_status: "active" },
      ],
      blocks: [],
      profile_privacy_settings: [
        { user_id: AGE_DAVE, allow_profile_discovery: false },
      ],
      user_follows: [],
      user_privacy_settings: [],
    });

    const r = await get("/discovery/search?q=manila&type=cities");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    const titles = (results as any[]).map((c: any) => (c.title as string).toLowerCase());
    assert.ok(!titles.includes("manila"), "City contributed only by opted-out profile must NOT appear");
  });

  it("returns empty cities (fail-closed) when profile_privacy_settings errors", async () => {
    setup(
      {
        profiles: [
          { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false, home_city: "Cebu", home_country: "PH", account_status: "active" },
        ],
        blocks: [],
        user_follows: [],
        user_privacy_settings: [],
      },
      ["profile_privacy_settings"],
    );

    const r = await get("/discovery/search?q=cebu&type=cities");
    assert.equal(r.status, 200);
    const { results } = await r.json() as any;
    assert.equal(results.length, 0, "Fail-closed: must return empty cities when opt-out state is unknown");
  });
});

// ── Posts: delayed-publish gate (§23/§37) ─────────────────────────────────────
//
// searchPosts had no publication filter at all — only `visibility = 'public'`
// and "not deleted, not banned". `status = 'active'` is exactly what POST /posts
// writes for a delayed-geotag post, and its body was full-text searchable the
// instant it was created: anyone typing a phrase from it found the post (and its
// author) while that author was still standing at the place they had asked not
// to reveal. The canonical predicate is lib/postVisibility.isPostPublished, and
// it is applied at the query AND in memory — these tests pin both.

describe("GET /api/discovery/search — posts are gated on post_status", () => {
  const AUTHOR_ROW = {
    id: ALICE, handle: "alice", name: "Alice", avatar_url: null,
    is_private: false, account_status: "active",
  };
  const postRow = (id: string, over: Record<string, any> = {}) => ({
    id, author_id: ALICE, content: `bougainvillea rooftop ${id}`, media_urls: [],
    created_at: "2026-09-01T10:00:00Z", like_count: 0, visibility: "public",
    // NOT NULL DEFAULT 'published' in the schema — a real row always has one.
    status: "active", post_status: "published",
    ...over,
  });
  const PUBLISHED = postRow("published-1");
  const PENDING = [
    postRow("pending-exit-1", { post_status: "pending_location_exit" }),
    postRow("pending-delay-1", { post_status: "pending_delay" }),
    postRow("review-1", { post_status: "pending_safety_review" }),
  ];

  async function idsFor(ignoreEqCols: string[] = []) {
    setup({ profiles: [AUTHOR_ROW], posts: [PUBLISHED, ...PENDING] }, [], ignoreEqCols);
    const r = await get("/discovery/search?q=bougainvillea&type=posts");
    assert.equal(r.status, 200);
    const { results } = (await r.json()) as any;
    return (results as any[]).map((x: any) => x.id as string);
  }

  it("the posts query CARRIES post_status='published' (the DB-layer predicate)", async () => {
    const ids = await idsFor();
    assert.deepEqual(ids, ["published-1"], "only the published post is searchable");
    const postEqs = CAPTURED_EQS.filter((e) => e.table === "posts");
    assert.ok(
      postEqs.some((e) => e.col === "post_status" && e.val === "published"),
      "searchPosts must carry the canonical predicate on the query",
    );
  });

  it("pending rows fed PAST the query filter are still refused in memory", async () => {
    const ids = await idsFor(["post_status"]);
    for (const p of PENDING) {
      assert.ok(!ids.includes(p.id), `${p.id} (status='active', pending post_status) must never be searchable`);
    }
    assert.deepEqual(ids, ["published-1"]);
  });

  it("a legacy row with NO post_status reads as published (absent ⇒ published)", async () => {
    const legacy: any = postRow("legacy-1");
    delete legacy.post_status;
    setup({ profiles: [AUTHOR_ROW], posts: [legacy] }, [], ["post_status"]);
    const r = await get("/discovery/search?q=bougainvillea&type=posts");
    assert.equal(r.status, 200);
    const { results } = (await r.json()) as any;
    assert.deepEqual((results as any[]).map((x: any) => x.id), ["legacy-1"],
      "the column is NOT NULL DEFAULT 'published'; absent must not fail closed");
  });
});
