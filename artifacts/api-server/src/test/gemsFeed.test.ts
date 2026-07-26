/**
 * Gems feed API tests — GET /api/media/gems-feed
 *
 * Covers:
 *   - Feature flag gate (MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED)
 *   - Eligible gem returned with populated location.canonicalPlaceId
 *   - Ineligible gem (no canonical_place_id) is excluded from results
 *   - AI-generated gem (source_type = ai_generated_generic) is excluded
 *   - Gem with NULL source_type is included (NULL != excluded)
 *   - Near Me mode requires X-User-Lat / X-User-Lng headers
 *   - My Trip mode: member allowed, non-member denied, owner (not in trip_members) allowed
 *   - DB-level keyset cursor pagination: no gaps or duplicates across all pages for >150 items
 *   - Wrong-place report route: POST /api/media/:id/report
 *
 * Run: node --import tsx/esm --test src/test/gemsFeed.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import mediaFeedRouter from "../routes/mediaFeed.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN = "gems-feed-token";
const USER_ID    = "user-gems-feed-1";
const OTHER_ID   = "user-gems-feed-2";
const TRIP_ID    = "trip-0000-0000-0000-000000000001";
const PLACE_ID_A = "place-aaa";

// ── Fake client ───────────────────────────────────────────────────────────────

interface FakeState {
  featureFlags?:  Record<string, boolean>;
  gems?:          any[];
  gemSaves?:      any[];
  gemReports?:    any[];
  profiles?:      any[];
  userFollows?:   any[];
  trips?:         any[];
  tripMembers?:   any[];
}

/**
 * Parse a single PostgREST filter term like `col.op.value`.
 * Returns a predicate function, or null when the term is not recognised.
 * Handles: eq, neq, lt, gt, lte, gte, is (null check).
 * Works for ISO timestamps, UUIDs, and numbers (lexicographic comparison on
 * strings is correct for ISO-8601 timestamps and suffices for UUIDs in tests).
 */
function parseTerm(term: string): ((r: any) => boolean) | null {
  const m = term.trim().match(/^(\w+)\.(eq|neq|lt|gt|lte|gte|is)\.(.*)$/);
  if (!m) return null;
  const [, col, op, rawVal] = m;
  return (r: any) => {
    const rv = r[col];
    switch (op) {
      case "is":   return rawVal === "null" ? rv == null : String(rv) === rawVal;
      case "eq":   return rv != null && String(rv) === rawVal;
      case "neq":  return rv != null && String(rv) !== rawVal;
      case "lt":   return rv != null && String(rv) < rawVal;
      case "gt":   return rv != null && String(rv) > rawVal;
      case "lte":  return rv != null && String(rv) <= rawVal;
      case "gte":  return rv != null && String(rv) >= rawVal;
      default:     return false;
    }
  };
}

/**
 * Split a top-level comma-separated PostgREST expression, respecting nested
 * parentheses (e.g. `a.lt.x,and(b.eq.y,c.gt.z)` → [`a.lt.x`, `and(b.eq.y,c.gt.z)`]).
 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") { depth++; cur += ch; }
    else if (ch === ")") { depth--; cur += ch; }
    else if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Evaluate a single PostgREST expression token against a row.
 * Supports: bare terms (`col.op.val`) and `and(...)` groups.
 */
function evalExpr(expr: string, r: any): boolean {
  const t = expr.trim();
  if (t.startsWith("and(") && t.endsWith(")")) {
    return splitTopLevel(t.slice(4, -1)).every((sub) => evalExpr(sub, r));
  }
  const pred = parseTerm(t);
  return pred ? pred(r) : false;
}

/**
 * Evaluate a full PostgREST `.or(expr)` expression against a row.
 * Top-level terms are OR-ed; `and(...)` groups are evaluated together.
 */
function evalOr(expr: string, r: any): boolean {
  return splitTopLevel(expr).some((sub) => evalExpr(sub, r));
}

function makeFakeClient(state: FakeState, userId: string) {
  const inserted: Array<{ table: string; row: any }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let sortCols: Array<{ col: string; asc: boolean }> = [];
    let limitVal: number | null = null;

    const builder: any = {
      select()                    { return builder; },
      insert(row: any)            { inserted.push({ table, row }); return builder; },
      update()                    { return builder; },
      delete()                    { return builder; },

      eq(col: string, val: any) {
        filters.push((r) => r[col] === val); return builder;
      },
      neq(col: string, val: any) {
        // SQL neq: only matches when value is not null and != val
        filters.push((r) => r[col] != null && r[col] !== val); return builder;
      },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.includes(r[col])); return builder;
      },
      not(col: string, op: string, val: any) {
        if (op === "is" && val === null) {
          // .not(col, "is", null) → col IS NOT NULL
          filters.push((r) => r[col] != null);
        } else if (op === "eq") {
          filters.push((r) => r[col] !== val);
        }
        return builder;
      },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return builder;
      },
      ilike(col: string, val: any) {
        filters.push((r) =>
          typeof r[col] === "string" && r[col].toLowerCase() === String(val).toLowerCase()
        );
        return builder;
      },
      gt()   { return builder; },
      lte()  { return builder; },
      gte()  { return builder; },
      lt()   { return builder; },

      or(expr: string) {
        filters.push((r) => evalOr(expr, r));
        return builder;
      },

      order(col: string, opts?: { ascending?: boolean }) {
        sortCols.push({ col, asc: opts?.ascending !== false });
        return builder;
      },
      limit(n: number) {
        limitVal = n;
        return builder;
      },
      range()      { return builder; },

      maybeSingle() { return resolveSingle(true); },
      single()      { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): any[] {
      const tableData: Record<string, any[]> = {
        feature_flags:     Object.entries(state.featureFlags ?? {}).map(([key, enabled]) => ({ flag: key, enabled })),
        hidden_gems:       state.gems ?? [],
        hidden_gem_saves:  state.gemSaves ?? [],
        hidden_gem_reports: state.gemReports ?? [],
        profiles:          state.profiles ?? [],
        user_follows:      state.userFollows ?? [],
        trips:             state.trips ?? [],
        trip_members:      state.tripMembers ?? [],
      };
      let result = (tableData[table] ?? []).filter((r) => filters.every((f) => f(r)));

      // Apply sort
      if (sortCols.length > 0) {
        result = [...result].sort((a, b) => {
          for (const { col, asc } of sortCols) {
            const av = a[col] ?? "";
            const bv = b[col] ?? "";
            if (av === bv) continue;
            const cmp = String(av) < String(bv) ? -1 : 1;
            return asc ? cmp : -cmp;
          }
          return 0;
        });
      }

      // Apply limit
      if (limitVal != null) result = result.slice(0, limitVal);
      return result;
    }

    function resolveSingle(nullable: boolean) {
      const filtered = rows();
      if (filtered.length === 0) {
        if (nullable) return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: null, error: { message: "not found", code: "PGRST116" } });
      }
      return Promise.resolve({ data: filtered[0], error: null });
    }
    function resolveList() { return Promise.resolve({ data: rows(), error: null }); }

    return builder;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) return { data: { user: { id: userId } }, error: null };
        if (token === "other-token") return { data: { user: { id: OTHER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from,
    rpc: async () => ({ data: null, error: null }),
    _inserted: inserted,
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function get(
  path: string,
  opts: { token?: string; extraHeaders?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${opts.token ?? FAKE_TOKEN}`,
          ...opts.extraHeaders,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

function post(
  path: string,
  body: any,
  token: string = FAKE_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "authorization": `Bearer ${token}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

// ── Gem fixture ───────────────────────────────────────────────────────────────

let _gemSeq = 0;
function makeGem(id: string, overrides: Partial<any> = {}): any {
  _gemSeq++;
  return {
    id,
    name: `Gem ${_gemSeq}`,
    category: "nature",
    city: "Bali",
    country: "Indonesia",
    neighborhood: null,
    description: "Beautiful waterfall",
    latitude: -8.5,
    longitude: 115.2,
    approx_latitude: -8.5,
    approx_longitude: 115.2,
    vibe_tags: ["nature"],
    price_range: "free",
    safety_notes: null,
    best_time_to_go: "Morning",
    layover_safe: false,
    minimum_layover_minutes: null,
    sensitivity_level: "public",
    verification_level: "community",
    status: "active",
    moderation_status: "approved",
    submitted_by: OTHER_ID,
    guide_verified_by: null,
    save_count: 5,
    visit_count: 2,
    report_count: 0,
    image_url: "https://example.com/gem.jpg",
    canonical_place_id: PLACE_ID_A,
    source_type: null,
    created_at: `2026-01-${String(_gemSeq % 28 + 1).padStart(2, "0")}T00:00:00Z`,
    updated_at: `2026-01-01T00:00:00Z`,
    ...overrides,
  };
}

/** Generate a UUID-like string suitable for lexicographic ordering tests. */
function makeId(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(express.json());
  app.use("/api", mediaFeedRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null, false);
  _setTestServiceClient(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Feature flag gate
// ─────────────────────────────────────────────────────────────────────────────

describe("Gems feed — feature flag gate", () => {
  it("returns feature_disabled when MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED is false", async () => {
    const client = makeFakeClient(
      { featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: false } },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get("/api/media/gems-feed?areaMode=all");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("returns 200 with items when flag is enabled", async () => {
    const gem = makeGem(makeId(1));
    const client = makeFakeClient(
      {
        featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true },
        gems: [gem],
        profiles: [{ id: OTHER_ID, username: "creator", is_private: false, is_verified: false }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get("/api/media/gems-feed?areaMode=all");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items), "items should be an array");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Eligibility filter
// ─────────────────────────────────────────────────────────────────────────────

describe("Gems feed — eligibility filter", () => {
  it("returns gem with populated location.canonicalPlaceId", async () => {
    const gem = makeGem(makeId(10), { canonical_place_id: PLACE_ID_A });
    const client = makeFakeClient(
      {
        featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true },
        gems: [gem],
        profiles: [{ id: OTHER_ID, username: "creator", is_private: false, is_verified: false }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get("/api/media/gems-feed?areaMode=all");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1, "eligible gem should be included");
    const item = r.body.items[0];
    assert.equal(item.location?.canonicalPlaceId, PLACE_ID_A, "canonicalPlaceId should be populated");
    assert.equal(item.sourceType, "gem");
    assert.ok(item.media?.length >= 1, "should have at least one media item");
    assert.equal(item.media[0].url, gem.image_url);
  });

  it("excludes gem with no canonical_place_id", async () => {
    // Fake client's .not("canonical_place_id", "is", null) filter drops this row
    const gem = makeGem(makeId(11), { canonical_place_id: null });
    const client = makeFakeClient(
      {
        featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true },
        gems: [gem],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get("/api/media/gems-feed?areaMode=all");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 0, "gem without canonical_place_id must be excluded");
  });

  it("excludes ai_generated_generic gems", async () => {
    // Fake client's .or("source_type.is.null,source_type.neq.ai_generated_generic") drops this
    const gem = makeGem(makeId(12), { source_type: "ai_generated_generic" });
    const client = makeFakeClient(
      {
        featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true },
        gems: [gem],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get("/api/media/gems-feed?areaMode=all");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 0, "AI-generated gem must be excluded");
  });

  it("includes gem with NULL source_type (NULL is not excluded)", async () => {
    const gem = makeGem(makeId(13), { source_type: null });
    const client = makeFakeClient(
      {
        featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true },
        gems: [gem],
        profiles: [{ id: OTHER_ID, username: "creator", is_private: false, is_verified: false }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get("/api/media/gems-feed?areaMode=all");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1, "gem with NULL source_type should be included");
  });

  it("marks illustrative image with provenanceLabel", async () => {
    const gem = makeGem(makeId(14), { source_type: "illustrative" });
    const client = makeFakeClient(
      {
        featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true },
        gems: [gem],
        profiles: [{ id: OTHER_ID, username: "creator", is_private: false, is_verified: false }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get("/api/media/gems-feed?areaMode=all");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1, "illustrative gem should be included (only labeled, not excluded)");
    assert.equal(r.body.items[0].media[0].provenanceLabel, "illustrative");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Near Me mode
// ─────────────────────────────────────────────────────────────────────────────

describe("Gems feed — Near Me mode", () => {
  it("rejects near_me without lat/lng headers", async () => {
    const client = makeFakeClient(
      { featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true, MEDIA_HIDDEN_GEMS_NEARBY_ENABLED: true } },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get("/api/media/gems-feed?areaMode=near_me");
    assert.equal(r.status, 400);
    assert.ok(r.body.error, "should return an error code");
  });

  it("returns feature_disabled when MEDIA_HIDDEN_GEMS_NEARBY_ENABLED is false", async () => {
    const client = makeFakeClient(
      {
        featureFlags: {
          MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true,
          MEDIA_HIDDEN_GEMS_NEARBY_ENABLED: false,
        },
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get("/api/media/gems-feed?areaMode=near_me", {
      extraHeaders: { "x-user-lat": "35.6", "x-user-lng": "139.7" },
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. My Trip mode — membership checks
// ─────────────────────────────────────────────────────────────────────────────

describe("Gems feed — My Trip access control", () => {
  it("returns gems for a trip member", async () => {
    const gem = makeGem(makeId(20), { city: "Tokyo" });
    const client = makeFakeClient(
      {
        featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true },
        gems: [gem],
        trips: [{ id: TRIP_ID, destination_city: "Tokyo", owner_id: OTHER_ID }],
        tripMembers: [{ trip_id: TRIP_ID, user_id: USER_ID, status: "accepted" }],
        profiles: [{ id: OTHER_ID, username: "creator", is_private: false, is_verified: false }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get(`/api/media/gems-feed?areaMode=my_trip&tripId=${TRIP_ID}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
  });

  it("returns gems for the trip owner (not in trip_members)", async () => {
    const gem = makeGem(makeId(21), { city: "Tokyo" });
    const client = makeFakeClient(
      {
        featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true },
        gems: [gem],
        trips: [{ id: TRIP_ID, destination_city: "Tokyo", owner_id: USER_ID }],
        tripMembers: [],
        profiles: [{ id: OTHER_ID, username: "creator", is_private: false, is_verified: false }],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get(`/api/media/gems-feed?areaMode=my_trip&tripId=${TRIP_ID}`);
    assert.equal(r.status, 200, "trip owner must be allowed even without a trip_members row");
    assert.equal(r.body.items.length, 1);
  });

  it("rejects a non-member who is also not the owner", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true },
        trips: [{ id: TRIP_ID, destination_city: "Tokyo", owner_id: OTHER_ID }],
        tripMembers: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get(`/api/media/gems-feed?areaMode=my_trip&tripId=${TRIP_ID}`);
    assert.equal(r.status, 403, "non-member non-owner must receive 403");
  });

  it("returns 400 when tripId is missing for my_trip mode", async () => {
    const client = makeFakeClient(
      { featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true } },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await get("/api/media/gems-feed?areaMode=my_trip");
    assert.equal(r.status, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DB-level keyset cursor pagination — no gaps or duplicates
// ─────────────────────────────────────────────────────────────────────────────

describe("Gems feed — DB-level keyset cursor pagination", () => {
  it("page 2 does not repeat page 1 items (created_at DESC, id DESC)", async () => {
    const GEM_A = makeId(100);
    const GEM_B = makeId(200);
    const GEM_C = makeId(300);
    const gems = [
      makeGem(GEM_A, { created_at: "2026-03-01T00:00:00Z" }),
      makeGem(GEM_B, { created_at: "2026-02-01T00:00:00Z" }),
      makeGem(GEM_C, { created_at: "2026-01-01T00:00:00Z" }),
    ];
    const profiles = [{ id: OTHER_ID, username: "creator", is_private: false, is_verified: false }];
    const client = makeFakeClient(
      { featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true }, gems, profiles },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const p1 = await get("/api/media/gems-feed?areaMode=all&limit=2");
    assert.equal(p1.status, 200);
    assert.equal(p1.body.items.length, 2);
    assert.ok(p1.body.nextCursor, "page 1 should have a nextCursor");

    const p1Ids = p1.body.items.map((i: any) => i.id);

    const p2 = await get(
      `/api/media/gems-feed?areaMode=all&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`,
    );
    assert.equal(p2.status, 200);
    assert.equal(p2.body.items.length, 1, "page 2 should have 1 remaining item");

    const p2Ids = p2.body.items.map((i: any) => i.id);
    const overlap = p1Ids.filter((id: string) => p2Ids.includes(id));
    assert.equal(overlap.length, 0, "page 2 must not repeat any item from page 1");
    assert.equal(p2.body.nextCursor, null, "no more pages after page 2");
  });

  it("paginates a corpus of 200 gems with no gaps or duplicates (regression for in-memory truncation)", async () => {
    // Create 200 gems with distinct timestamps spread across 200 days.
    // Mix up the IDs so numeric and timestamp ordering differ, catching
    // any remaining in-memory sort/truncation that would silently drop items.
    const TOTAL = 200;
    const PAGE_SIZE = 20;
    const gems: any[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const day = String(i + 1).padStart(3, "0");
      // Use a timestamp that is NOT in insertion order (i % 7 shuffles them)
      const shuffledDay = (i * 7 + 13) % TOTAL;
      const ts = `2026-01-01T${String(shuffledDay % 24).padStart(2, "0")}:${String(shuffledDay % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
      gems.push(makeGem(makeId(i + 1000), {
        created_at: ts,
        canonical_place_id: `place-${day}`,
        source_type: null,
      }));
    }

    const profiles = [{ id: OTHER_ID, username: "creator", is_private: false, is_verified: false }];
    const client = makeFakeClient(
      { featureFlags: { MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED: true }, gems, profiles },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // Walk through all pages collecting IDs
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;

    while (true) {
      const url = cursor
        ? `/api/media/gems-feed?areaMode=all&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
        : `/api/media/gems-feed?areaMode=all&limit=${PAGE_SIZE}`;
      const r = await get(url);
      assert.equal(r.status, 200, `page ${pageCount + 1} should succeed`);
      assert.ok(Array.isArray(r.body.items), "items should be an array");

      for (const item of r.body.items) {
        assert.ok(!seen.has(item.id), `duplicate item ${item.id} on page ${pageCount + 1}`);
        seen.add(item.id);
      }

      cursor = r.body.nextCursor ?? null;
      pageCount++;

      if (!cursor) break;
      // Safety guard: avoid infinite loop if cursor never advances
      assert.ok(pageCount < TOTAL + 5, "pagination produced more pages than expected — possible infinite loop");
    }

    assert.equal(seen.size, TOTAL, `expected ${TOTAL} distinct items across all pages, got ${seen.size}`);
    assert.equal(pageCount, Math.ceil(TOTAL / PAGE_SIZE), `expected ${Math.ceil(TOTAL / PAGE_SIZE)} pages`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Wrong-place report
// ─────────────────────────────────────────────────────────────────────────────

describe("Gems feed — wrong-place report", () => {
  it("POST /api/media/:id/report succeeds", async () => {
    const GEM_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const gem = makeGem(GEM_UUID);
    const client = makeFakeClient(
      { featureFlags: {}, gems: [gem], gemReports: [] },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await post(`/api/media/${GEM_UUID}/report`, {
      reason: "media_does_not_match_place",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});
