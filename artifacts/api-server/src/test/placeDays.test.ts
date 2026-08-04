/**
 * Place Days — regression coverage for route-level behaviour.
 *
 * Unit tests: local-time foundation helpers (existing suite).
 * Route tests: auth, feature-flag gating, merged-place resolution,
 *   bidirectional blocks, private-profile filtering, cursor pagination.
 * Worker tests: active→closing→archived lifecycle transitions.
 *
 * Run: node --import tsx/esm --test src/test/placeDays.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import placeDaysRouter from "../routes/placeDays.js";
import {
  isEligiblePlaceDayPost,
  isValidLocalDate,
  localDateFor,
  resolvePlaceTimezone,
  runPlaceDayLifecycleTick,
  shiftLocalDate,
  utcRangeForLocalDate,
  validIanaTimezone,
} from "../lib/places/placeDays.js";

// ── Stable UUIDs ──────────────────────────────────────────────────────────────

const PLACE_ID         = "a1000000-0000-4000-a000-000000000001";
const MERGED_PLACE_ID  = "a2000000-0000-4000-a000-000000000002"; // merged_into → PLACE_ID
const DEAD_PLACE_ID    = "a3000000-0000-4000-a000-000000000003"; // survivor removed
const VIEWER_ID        = "b1000000-0000-4000-a000-000000000001";
const AUTHOR_CLEAN     = "b2000000-0000-4000-a000-000000000002";
const AUTHOR_BLOCKED_BY_ME   = "b3000000-0000-4000-a000-000000000003";
const AUTHOR_BLOCKED_ME      = "b4000000-0000-4000-a000-000000000004";
const AUTHOR_PRIVATE_NONFOLLOWED = "b5000000-0000-4000-a000-000000000005";
const AUTHOR_PRIVATE_FOLLOWED    = "b6000000-0000-4000-a000-000000000006";

const LOCAL_DATE = "2026-08-02";
const VIEWER_TOK = "tok-viewer";

// ── Fake Supabase client ──────────────────────────────────────────────────────

/** Minimal post row with all fields the route reads. */
function makePost(
  id: string,
  authorId: string,
  isPrivateAuthor = false,
  opts: Partial<{ post_status: string; visibility: string; status: string; publish_at: string | null; created_at: string }> = {},
) {
  return {
    id,
    author_id: authorId,
    content: "hello",
    media_urls: ["https://example.com/img.jpg"],
    media_thumbnail_url: null,
    media_type: "image",
    created_at: opts.created_at ?? `2026-08-02T10:00:00.000Z`,
    visibility: opts.visibility ?? "public",
    status: opts.status ?? "active",
    post_status: opts.post_status ?? "published",
    publish_at: opts.publish_at ?? null,
    profiles: { id: authorId, is_private: isPrivateAuthor },
    canonical_place_id: PLACE_ID,
  };
}

type State = {
  flags: { flag: string; enabled: boolean }[];
  places: any[];
  place_days: any[];
  blocks: { blocker_id: string; blocked_id: string }[];
  posts: any[];
  user_follows: { follower_id: string; following_id: string }[];
};

function makeClient(state: State) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === VIEWER_TOK
          ? { data: { user: { id: VIEWER_ID } }, error: null }
          : { data: { user: null }, error: { message: "unauthorized" } },
    },
    from: (table: string) => {
      const eqFilters: Array<(r: any) => boolean> = [];
      let ltFilters: Array<(r: any) => boolean> = [];
      let gteFilters: Array<(r: any) => boolean> = [];
      let inFilters: Array<(r: any) => boolean> = [];
      let orCursorFilter: ((r: any) => boolean) | null = null;
      let _order: { col: string; asc: boolean }[] = [];
      let _limit = Infinity;

      function source(): any[] {
        if (table === "feature_flags") return state.flags;
        if (table === "places")        return state.places;
        if (table === "place_days")    return state.place_days;
        if (table === "blocks")        return state.blocks;
        if (table === "posts")         return state.posts;
        if (table === "user_follows")  return state.user_follows;
        return [];
      }

      function applyAll(rows: any[]) {
        let r = rows;
        for (const f of eqFilters)  r = r.filter(f);
        for (const f of ltFilters)  r = r.filter(f);
        for (const f of gteFilters) r = r.filter(f);
        for (const f of inFilters)  r = r.filter(f);
        if (orCursorFilter) r = r.filter(orCursorFilter);
        for (const { col, asc } of _order) {
          r = [...r].sort((a, b) => {
            if (a[col] < b[col]) return asc ? -1 : 1;
            if (a[col] > b[col]) return asc ? 1 : -1;
            return 0;
          });
        }
        return r.slice(0, _limit);
      }

      const b: any = {
        select() { return b; },
        eq(col: string, val: any)    { eqFilters.push((r) => r[col] === val); return b; },
        neq(col: string, val: any)   { eqFilters.push((r) => r[col] !== val); return b; },
        in(col: string, vals: any[]) { inFilters.push((r) => vals.includes(r[col])); return b; },
        gte(col: string, val: any)   { gteFilters.push((r) => r[col] >= val); return b; },
        lt(col: string, val: any)    { ltFilters.push((r) => r[col] < val); return b; },
        gt(col: string, val: any)    { ltFilters.push((r) => r[col] > val); return b; },
        order(col: string, opts?: { ascending?: boolean }) {
          _order.push({ col, asc: opts?.ascending !== false });
          return b;
        },
        limit(n: number) { _limit = n; return b; },

        // Handles two patterns:
        //   "blocker_id.eq.X,blocked_id.eq.X"  — simple OR for blocks
        //   "created_at.lt.T,and(created_at.eq.T,id.lt.I)"  — cursor page
        or(expr: string) {
          const cursorMatch = expr.match(
            /^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/,
          );
          if (cursorMatch) {
            const [, ltTs, eqTs, ltId] = cursorMatch;
            orCursorFilter = (r) =>
              r.created_at < ltTs ||
              (r.created_at === eqTs && r.id < ltId);
          } else {
            // Simple comma-separated "col.op.val" pairs
            const parts = expr.split(",").map((p) => {
              const m = p.trim().match(/^(\w+)\.(\w+)\.(.+)$/);
              return m ? { col: m[1], op: m[2], val: m[3] } : null;
            }).filter(Boolean) as { col: string; op: string; val: string }[];
            eqFilters.push((r) =>
              parts.some(({ col, op, val }) =>
                op === "eq" ? String(r[col]) === val : false,
              ),
            );
          }
          return b;
        },

        upsert(data: any, _opts?: any) {
          return Promise.resolve({ data: null, error: null });
        },
        update(data: any) {
          // Apply update to matching rows in the source array
          const matched = applyAll(source());
          for (const row of matched) Object.assign(row, data);
          return {
            eq(col: string, val: any) {
              // additional eq filter applied to the update set is already handled above
              return { eq() { return Promise.resolve({ error: null }); } };
            },
            then(onF: any) { return Promise.resolve({ error: null }).then(onF); },
          };
        },

        maybeSingle() {
          return Promise.resolve({ data: applyAll(source())[0] ?? null, error: null });
        },
        then(onF: any, onR?: any) {
          return Promise.resolve({ data: applyAll(source()), error: null }).then(onF, onR);
        },
      };

      return b;
    },
  };
}

// ── Server setup ──────────────────────────────────────────────────────────────

let base: string;
let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", placeDaysRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => server.close());

function get(path: string, tok: string | null = VIEWER_TOK) {
  const headers: Record<string, string> = {};
  if (tok) headers.Authorization = `Bearer ${tok}`;
  return fetch(`${base}${path}`, { headers });
}

const BOTH_FLAGS_ON: State["flags"] = [
  { flag: "external_places_enabled", enabled: true },
  { flag: "live_places_enabled", enabled: true },
  { flag: "place_days_enabled", enabled: true },
];

function baseState(): State {
  return {
    flags: BOTH_FLAGS_ON,
    places: [
      { id: PLACE_ID, name: "Test Place", city: "London", latitude: 51.5, longitude: -0.12, merged_into_place_id: null },
      { id: MERGED_PLACE_ID, name: "Old Name", city: null, latitude: null, longitude: null, merged_into_place_id: PLACE_ID },
    ],
    place_days: [
      { id: "d1000000-0000-4000-a000-000000000001", place_id: PLACE_ID, local_date: LOCAL_DATE,
        timezone: "Europe/London", status: "active", opened_at: "2026-08-02T00:00:00.000Z",
        closing_at: null, archived_at: null },
    ],
    blocks: [],
    posts: [],
    user_follows: [],
  };
}

function setup(state: State) {
  const client = makeClient(state) as any;
  _setTestClient(client, true);
  _setTestServiceClient(client);
}

// ── 1. Unit tests — local-time foundation (retained) ─────────────────────────

describe("Place Days local-time foundation", () => {
  it("uses a resolved IANA timezone at a UTC midnight boundary", () => {
    const timezone = resolvePlaceTimezone({ city: "Cebu City", latitude: 10.3157, longitude: 123.8854 });
    assert.equal(timezone, "Asia/Manila");
    assert.equal(localDateFor(new Date("2026-08-02T17:30:00.000Z"), timezone), "2026-08-03");
  });

  it("falls back honestly to UTC for a place with no defensible timezone", () => {
    assert.equal(resolvePlaceTimezone({ city: null, latitude: null, longitude: null }), "UTC");
    assert.equal(validIanaTimezone("not/a-timezone"), null);
  });

  it("validates real calendar dates and uses calendar arithmetic across DST", () => {
    assert.equal(isValidLocalDate("2026-02-29"), false);
    assert.equal(isValidLocalDate("2028-02-29"), true);
    assert.equal(isValidLocalDate("2026-99-99"), false);
    assert.equal(shiftLocalDate("2026-03-09", -1), "2026-03-08");
    const range = utcRangeForLocalDate("2026-03-08", "America/Los_Angeles");
    assert.equal(range.start, "2026-03-08T08:00:00.000Z");
    assert.equal(range.end, "2026-03-09T07:00:00.000Z");
  });

  it("only materializes from published public active source activity", () => {
    assert.equal(isEligiblePlaceDayPost({ visibility: "public", status: "active", post_status: "published" }), true);
    assert.equal(isEligiblePlaceDayPost({ visibility: "private", status: "active", post_status: "published" }), false);
    assert.equal(isEligiblePlaceDayPost({ visibility: "public", status: "deleted", post_status: "published" }), false);
    assert.equal(isEligiblePlaceDayPost({ visibility: "public", status: "active", post_status: "pending_review" }), false);
    assert.equal(isEligiblePlaceDayPost({ visibility: "public", status: "active", post_status: "published", publish_at: "2099-01-01T00:00:00Z" }), false);
  });
});

// ── 2. GET /places/:id/place-days — auth and flag gating ─────────────────────

describe("GET /api/places/:id/place-days — authentication and feature flags", () => {
  it("returns 401 when no token is supplied", async () => {
    setup(baseState());
    const r = await get(`/places/${PLACE_ID}/place-days`, null);
    assert.equal(r.status, 401);
  });

  it("returns 401 when the token is invalid", async () => {
    setup(baseState());
    const r = await get(`/places/${PLACE_ID}/place-days`, "bad-token");
    assert.equal(r.status, 401);
  });

  it("returns feature_disabled when external_places_enabled flag is off", async () => {
    const s = baseState();
    s.flags = [
      { flag: "external_places_enabled", enabled: false },
      { flag: "live_places_enabled", enabled: true },
      { flag: "place_days_enabled", enabled: true },
    ];
    setup(s);
    const r = await get(`/places/${PLACE_ID}/place-days`);
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "feature_disabled");
  });

  it("returns feature_disabled when place_days_enabled flag is off", async () => {
    const s = baseState();
    s.flags = [
      { flag: "external_places_enabled", enabled: true },
      { flag: "live_places_enabled", enabled: true },
      { flag: "place_days_enabled", enabled: false },
    ];
    setup(s);
    const r = await get(`/places/${PLACE_ID}/place-days`);
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "feature_disabled");
  });

  it("returns feature_disabled when the Live Places master flag is off", async () => {
    const s = baseState();
    s.flags = [
      { flag: "external_places_enabled", enabled: true },
      { flag: "live_places_enabled", enabled: false },
      { flag: "place_days_enabled", enabled: true },
    ];
    setup(s);
    const r = await get(`/places/${PLACE_ID}/place-days`);
    assert.equal(r.status, 404);
    assert.equal((await r.json() as any).error, "feature_disabled");
  });

  it("returns 400 for an invalid UUID", async () => {
    setup(baseState());
    const r = await get("/places/not-a-uuid/place-days");
    assert.equal(r.status, 400);
  });

  it("returns 404 for an unknown place", async () => {
    const s = baseState();
    s.places = [];
    setup(s);
    const r = await get(`/places/${PLACE_ID}/place-days`);
    assert.equal(r.status, 404);
  });

  it("returns the existing day and navigation for a known place and date", async () => {
    setup(baseState());
    const r = await get(`/places/${PLACE_ID}/place-days?date=${LOCAL_DATE}`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(body.day, "day should be present");
    assert.equal(body.day.localDate, LOCAL_DATE);
    assert.equal(body.day.status, "active");
    assert.ok("navigation" in body, "navigation should be present");
  });

  it("returns null day (not a 404) when no Place Day exists for the date", async () => {
    const s = baseState();
    s.place_days = []; // no day rows
    setup(s);
    const r = await get(`/places/${PLACE_ID}/place-days?date=2026-01-01`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.day, null);
    assert.deepEqual(body.navigation, { previousDate: null, nextDate: null });
  });

  it("rejects a malformed date", async () => {
    setup(baseState());
    const r = await get(`/places/${PLACE_ID}/place-days?date=not-a-date`);
    assert.equal(r.status, 400);
  });
});

// ── 3. GET /places/:id/place-days — merged-place resolution ──────────────────

describe("GET /api/places/:id/place-days — merged canonical-place resolution", () => {
  it("resolves a merged place to its survivor and returns the survivor's day", async () => {
    setup(baseState());
    const r = await get(`/places/${MERGED_PLACE_ID}/place-days?date=${LOCAL_DATE}`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    // The day is stored against the canonical (survivor) place id
    assert.ok(body.day !== undefined, "day field must be present");
    assert.equal(body.day?.placeId, PLACE_ID, "placeId in response must be the canonical survivor");
  });

  it("returns 404 when the survivor place row does not exist", async () => {
    const s = baseState();
    // Keep only the merged place; remove the survivor
    s.places = [
      { id: DEAD_PLACE_ID, name: "Dead", city: null, latitude: null, longitude: null,
        merged_into_place_id: PLACE_ID /* survivor missing */ },
    ];
    setup(s);
    const r = await get(`/places/${DEAD_PLACE_ID}/place-days?date=${LOCAL_DATE}`);
    assert.equal(r.status, 404);
  });
});

// ── 4. GET /places/:id/place-days/:date/feed — auth and flag gating ──────────

describe("GET /api/places/:id/place-days/:date/feed — authentication and feature flags", () => {
  it("returns 401 when no token is supplied", async () => {
    setup(baseState());
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`, null);
    assert.equal(r.status, 401);
  });

  it("returns 401 when the token is invalid", async () => {
    setup(baseState());
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`, "bad-token");
    assert.equal(r.status, 401);
  });

  it("returns feature_disabled when both flags are required but one is off", async () => {
    const s = baseState();
    s.flags = [
      { flag: "external_places_enabled", enabled: true },
      { flag: "place_days_enabled", enabled: false },
    ];
    setup(s);
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`);
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "feature_disabled");
  });

  it("returns 404 for an unknown place", async () => {
    const s = baseState();
    s.places = [];
    setup(s);
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`);
    assert.equal(r.status, 404);
  });

  it("rejects an invalid date segment", async () => {
    setup(baseState());
    const r = await get(`/places/${PLACE_ID}/place-days/not-a-date/feed`);
    assert.equal(r.status, 400);
  });

  it("returns an empty feed with no posts", async () => {
    setup(baseState());
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.items, []);
    assert.equal(body.nextCursor, null);
  });
});

// ── 5. Feed — merged-place resolution ────────────────────────────────────────

describe("GET /api/places/:id/place-days/:date/feed — merged canonical-place resolution", () => {
  it("returns feed posts from the canonical survivor when a merged place id is used", async () => {
    const s = baseState();
    s.posts = [
      makePost("post-001", AUTHOR_CLEAN, false, { created_at: "2026-08-02T10:00:00.000Z" }),
    ];
    setup(s);
    const r = await get(`/places/${MERGED_PLACE_ID}/place-days/${LOCAL_DATE}/feed`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.placeId, PLACE_ID, "placeId in response is the canonical survivor");
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].id, "post-001");
  });
});

// ── 6. Feed — bidirectional block filtering ───────────────────────────────────

describe("GET /api/places/:id/place-days/:date/feed — bidirectional block filtering", () => {
  beforeEach(() => {
    const s = baseState();
    s.blocks = [
      { blocker_id: VIEWER_ID,         blocked_id: AUTHOR_BLOCKED_BY_ME },  // viewer blocked them
      { blocker_id: AUTHOR_BLOCKED_ME, blocked_id: VIEWER_ID },             // they blocked viewer
    ];
    s.posts = [
      makePost("post-clean",    AUTHOR_CLEAN,        false, { created_at: "2026-08-02T12:00:00.000Z" }),
      makePost("post-blocked-out", AUTHOR_BLOCKED_BY_ME, false, { created_at: "2026-08-02T11:00:00.000Z" }),
      makePost("post-blocked-in",  AUTHOR_BLOCKED_ME,    false, { created_at: "2026-08-02T10:00:00.000Z" }),
    ];
    setup(s);
  });

  it("omits a post whose author was blocked by the viewer", async () => {
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`);
    assert.equal(r.status, 200);
    const { items } = await r.json() as any;
    const ids = items.map((i: any) => i.id);
    assert.ok(!ids.includes("post-blocked-out"), "post from author blocked-by-viewer must not appear");
  });

  it("omits a post whose author blocked the viewer", async () => {
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`);
    assert.equal(r.status, 200);
    const { items } = await r.json() as any;
    const ids = items.map((i: any) => i.id);
    assert.ok(!ids.includes("post-blocked-in"), "post from author who blocked viewer must not appear");
  });

  it("still returns the unblocked author's post", async () => {
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`);
    assert.equal(r.status, 200);
    const { items } = await r.json() as any;
    const ids = items.map((i: any) => i.id);
    assert.ok(ids.includes("post-clean"), "post from unblocked author must appear");
  });
});

// ── 7. Feed — private-profile filtering ──────────────────────────────────────

describe("GET /api/places/:id/place-days/:date/feed — private profile filtering", () => {
  beforeEach(() => {
    const s = baseState();
    s.blocks = [];
    s.user_follows = [
      { follower_id: VIEWER_ID, following_id: AUTHOR_PRIVATE_FOLLOWED },
    ];
    s.posts = [
      makePost("post-public",    AUTHOR_CLEAN,                false, { created_at: "2026-08-02T14:00:00.000Z" }),
      makePost("post-priv-no",   AUTHOR_PRIVATE_NONFOLLOWED,  true,  { created_at: "2026-08-02T13:00:00.000Z" }),
      makePost("post-priv-yes",  AUTHOR_PRIVATE_FOLLOWED,     true,  { created_at: "2026-08-02T12:00:00.000Z" }),
    ];
    setup(s);
  });

  it("hides a post from a private account the viewer does not follow", async () => {
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`);
    assert.equal(r.status, 200);
    const { items } = await r.json() as any;
    const ids = items.map((i: any) => i.id);
    assert.ok(!ids.includes("post-priv-no"), "post from private-unfollowed author must not appear");
  });

  it("includes a post from a private account the viewer follows", async () => {
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`);
    assert.equal(r.status, 200);
    const { items } = await r.json() as any;
    const ids = items.map((i: any) => i.id);
    assert.ok(ids.includes("post-priv-yes"), "post from private-followed author must appear");
  });

  it("always includes a post by the viewer themselves regardless of their privacy setting", async () => {
    const s = baseState();
    s.posts = [
      makePost("post-self", VIEWER_ID, true /* private account */, { created_at: "2026-08-02T11:00:00.000Z" }),
    ];
    setup(s);
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed`);
    assert.equal(r.status, 200);
    const { items } = await r.json() as any;
    const ids = items.map((i: any) => i.id);
    assert.ok(ids.includes("post-self"), "viewer's own post must always appear");
  });
});

// ── 8. Feed — cursor pagination ──────────────────────────────────────────────

describe("GET /api/places/:id/place-days/:date/feed — cursor pagination", () => {
  /** Build N sequential posts with UUID ids, ascending timestamps (oldest first). */
  function makePosts(count: number): any[] {
    return Array.from({ length: count }, (_, i) => {
      const seq = String(i + 1).padStart(12, "0");
      const id  = `c${seq.slice(0, 7)}-0000-4000-a000-${seq.slice(0, 12)}`;
      const ts  = `2026-08-02T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`;
      return makePost(id, AUTHOR_CLEAN, false, { created_at: ts });
    });
  }

  it("returns nextCursor when there are more results beyond the limit", async () => {
    const s = baseState();
    s.posts = makePosts(5);
    setup(s);
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed?limit=3`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.items.length, 3);
    assert.ok(body.nextCursor !== null, "nextCursor must be set when there are more items");
  });

  it("returns no nextCursor when all results fit in a single page", async () => {
    const s = baseState();
    s.posts = makePosts(3);
    setup(s);
    const r = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed?limit=10`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.items.length, 3);
    assert.equal(body.nextCursor, null);
  });

  it("second page contains the remaining items and no duplicate ids with the first page", async () => {
    const s = baseState();
    s.posts = makePosts(5);
    setup(s);

    const r1 = await get(`/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed?limit=3`);
    assert.equal(r1.status, 200);
    const page1 = await r1.json() as any;
    assert.equal(page1.items.length, 3);
    assert.ok(page1.nextCursor, "page1 must have a nextCursor");

    const r2 = await get(
      `/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed?limit=3&cursor=${encodeURIComponent(page1.nextCursor)}`,
    );
    assert.equal(r2.status, 200);
    const page2 = await r2.json() as any;
    assert.ok(page2.items.length > 0, "page2 must have at least one item");

    const ids1 = new Set(page1.items.map((i: any) => i.id));
    for (const item of page2.items) {
      assert.ok(!ids1.has(item.id), `item ${item.id} appeared on both pages`);
    }
  });

  it("rejects a malformed cursor value", async () => {
    setup(baseState());
    const r = await get(
      `/places/${PLACE_ID}/place-days/${LOCAL_DATE}/feed?cursor=not-a-valid-cursor`,
    );
    assert.equal(r.status, 400);
  });
});

// ── 9. Lifecycle worker — status transitions ──────────────────────────────────

describe("runPlaceDayLifecycleTick — active → closing → archived transitions", () => {
  function makeDayRows(overrides: Partial<any>[]): any[] {
    return overrides.map((o, i) => ({
      id: `day-${i + 1}`,
      place_id: PLACE_ID,
      local_date: "2026-07-01",
      timezone: "UTC",
      status: "active",
      ...o,
    }));
  }

  function fakeScForLifecycle(rows: any[]) {
    return {
      from: (table: string) => {
        if (table !== "place_days") throw new Error(`unexpected table: ${table}`);
        const eqFilters: Array<(r: any) => boolean> = [];
        const inFilters: Array<(r: any) => boolean> = [];
        let _limit = Infinity;
        let _update: any = null;

        // Chains return the same builder
        const b: any = {
          select()                  { return b; },
          in(col: string, vals: any[]) { inFilters.push((r) => vals.includes(r[col])); return b; },
          eq(col: string, val: any) { eqFilters.push((r) => r[col] === val); return b; },
          limit(n: number)          { _limit = n; return b; },
          update(data: any)         {
            _update = data;
            return {
              eq(col: string, val: any) {
                const f = (r: any) => r[col] === val;
                return {
                  eq(_c2: string, _v2: any) {
                    // second eq chained on the update — apply both filters then patch
                    const matched = rows.filter((r) => r[col] === val && r[_c2] === _v2);
                    for (const row of matched) Object.assign(row, _update);
                    return Promise.resolve({ error: null });
                  },
                  then(onF: any) {
                    const matched = rows.filter(f);
                    for (const row of matched) Object.assign(row, _update);
                    return Promise.resolve({ error: null }).then(onF);
                  },
                };
              },
            };
          },
          then(onF: any, onR?: any) {
            const visible = rows
              .filter((r) => eqFilters.every((f) => f(r)) && inFilters.every((f) => f(r)))
              .slice(0, _limit);
            return Promise.resolve({ data: visible, error: null }).then(onF, onR);
          },
        };
        return b;
      },
      // arePlaceDaysEnabled reads feature_flags
      // We mock it by making the lifecycle call go through a sc that returns true for flags
    };
  }

  it("does not advance rows whose local_date is today (UTC) or in the future", async () => {
    const today = localDateFor(new Date(), "UTC");
    const rows = makeDayRows([
      { local_date: today, status: "active" },
    ]);
    // arePlaceDaysEnabled needs feature_flags — use the full fake client
    const s = baseState();
    s.place_days = rows;
    const client = makeClient(s) as any;
    // Override place_days source so update calls mutate `rows`
    const result = await runPlaceDayLifecycleTick(client);
    assert.equal(result.closing,  0);
    assert.equal(result.archived, 0);
    assert.equal(rows[0].status, "active");
  });

  it("transitions a past active day to closing", async () => {
    const pastDate = shiftLocalDate(localDateFor(new Date(), "UTC"), -1);
    const s = baseState();
    s.place_days = makeDayRows([{ local_date: pastDate, status: "active" }]);
    const client = makeClient(s) as any;
    const result = await runPlaceDayLifecycleTick(client);
    assert.equal(result.closing, 1);
    assert.equal(result.archived, 0);
    assert.equal(s.place_days[0].status, "closing");
  });

  it("transitions a closing day that is older than yesterday to archived", async () => {
    const twoDaysAgo = shiftLocalDate(localDateFor(new Date(), "UTC"), -2);
    const s = baseState();
    s.place_days = makeDayRows([{ local_date: twoDaysAgo, status: "closing" }]);
    const client = makeClient(s) as any;
    const result = await runPlaceDayLifecycleTick(client);
    assert.equal(result.closing,  0);
    assert.equal(result.archived, 1);
    assert.equal(s.place_days[0].status, "archived");
  });

  it("skips a closing day that is still within the one-day grace window", async () => {
    // yesterday's date: closing but not yet old enough to archive
    const yesterday = shiftLocalDate(localDateFor(new Date(), "UTC"), -1);
    const s = baseState();
    s.place_days = makeDayRows([{ local_date: yesterday, status: "closing" }]);
    const client = makeClient(s) as any;
    const result = await runPlaceDayLifecycleTick(client);
    assert.equal(result.archived, 0);
    assert.equal(s.place_days[0].status, "closing");
  });

  it("returns zeroes and does not throw when the feature flags are disabled", async () => {
    const s = baseState();
    s.flags = [
      { flag: "external_places_enabled", enabled: false },
      { flag: "place_days_enabled",       enabled: true },
    ];
    const client = makeClient(s) as any;
    const result = await runPlaceDayLifecycleTick(client);
    assert.deepEqual(result, { closing: 0, archived: 0 });
  });

  it("advances multiple rows in a single tick", async () => {
    const pastDate   = shiftLocalDate(localDateFor(new Date(), "UTC"), -1);
    const olderDate  = shiftLocalDate(localDateFor(new Date(), "UTC"), -3);
    const s = baseState();
    s.place_days = [
      { id: "d-a", place_id: PLACE_ID, local_date: pastDate,  timezone: "UTC", status: "active"  },
      { id: "d-b", place_id: PLACE_ID, local_date: olderDate, timezone: "UTC", status: "closing" },
    ];
    const client = makeClient(s) as any;
    const result = await runPlaceDayLifecycleTick(client);
    assert.equal(result.closing,  1);
    assert.equal(result.archived, 1);
  });
});
