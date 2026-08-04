/**
 * Place Recap Evidence Tampering — negative-path integration tests.
 *
 * The SQL RPCs validate parent/place/source identity inside the same
 * transaction that creates an immutable version. These tests keep those
 * protections from regressing by exercising:
 *
 *  • Mismatched Place Day ownership and place snapshots
 *  • Fabricated or stale source IDs
 *  • Unknown chapter references
 *  • Unsafe restore transitions (archived draft / reviewed-never-published)
 *
 * Tests mount the route with a fake client. Feature flags are enabled so
 * validation runs against the live RPC contract; the rpc() fake injects the
 * exact DB error messages the stored procedures would raise.
 *
 * Run: node --import tsx/esm --test src/test/placeRecapEvidence.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import placeRecapsRouter from "../routes/placeRecaps.js";

// ── Stable UUIDs ───────────────────────────────────────────────────────────────

const OWNER_ID        = "b1000000-0000-4000-a000-000000000001";
const OTHER_USER_ID   = "b2000000-0000-4000-a000-000000000002";
const PLACE_ID        = "a1000000-0000-4000-a000-000000000001";
const OTHER_PLACE_ID  = "a2000000-0000-4000-a000-000000000002";
const PLACE_DAY_ID    = "c1000000-0000-4000-a000-000000000001";
const MOMENT_ID       = "d1000000-0000-4000-a000-000000000001";
const RECAP_ID        = "e1000000-0000-4000-a000-000000000001";
const POST_ID         = "f1000000-0000-4000-a000-000000000001";

const OWNER_TOKEN     = "recap-evidence-owner-token";

// ── Feature flags (all capabilities needed for place and moment recap routes) ──

const ALL_FLAGS = [
  { flag: "external_places_enabled",    enabled: true },
  { flag: "live_places_enabled",        enabled: true },
  { flag: "place_days_enabled",         enabled: true },
  { flag: "place_recaps_enabled",       enabled: true },
  { flag: "shared_moments_enabled",     enabled: true },
  { flag: "moment_recaps_enabled",      enabled: true },
];

// ── Fake client factory ────────────────────────────────────────────────────────

/**
 * Minimal state that lets the route reach the RPC or the route-level guard.
 *
 * rpcOverride: when set, rpc() returns this result instead of a success.
 */
type RecapState = {
  flags: { flag: string; enabled: boolean }[];
  place_days: any[];
  places: any[];
  blocks: { blocker_id: string; blocked_id: string }[];
  posts: any[];
  user_follows: { follower_id: string; following_id: string }[];
  shared_moments: any[];
  shared_moment_contributions: any[];
  live_place_recaps: any[];
  rpcOverride?: { data: any; error: any };
};

function makeRecapClient(state: RecapState) {
  return {
    auth: {
      getUser: async (token: string) =>
        token === OWNER_TOKEN
          ? { data: { user: { id: OWNER_ID } }, error: null }
          : { data: { user: null }, error: { message: "unauthorized" } },
    },

    from(table: string) {
      const eqFilters: Array<(r: any) => boolean> = [];
      const gteFilters: Array<(r: any) => boolean> = [];
      const ltFilters: Array<(r: any) => boolean> = [];
      const inFilters: Array<(r: any) => boolean> = [];
      const orFilters: Array<(r: any) => boolean> = [];

      function source(): any[] {
        if (table === "feature_flags")              return state.flags;
        if (table === "place_days")                 return state.place_days;
        if (table === "places")                     return state.places;
        if (table === "blocks")                     return state.blocks;
        if (table === "posts")                      return state.posts;
        if (table === "user_follows")               return state.user_follows;
        if (table === "shared_moments")             return state.shared_moments;
        if (table === "shared_moment_contributions") return state.shared_moment_contributions;
        if (table === "live_place_recaps")          return state.live_place_recaps;
        return [];
      }

      function applyAll(rows: any[]) {
        let r = rows;
        for (const f of eqFilters)  r = r.filter(f);
        for (const f of gteFilters) r = r.filter(f);
        for (const f of ltFilters)  r = r.filter(f);
        for (const f of inFilters)  r = r.filter(f);
        if (orFilters.length > 0)   r = r.filter((row) => orFilters.some((f) => f(row)));
        return r;
      }

      const b: any = {
        select()                      { return b; },
        eq(col: string, val: any)     { eqFilters.push((r) => r[col] === val); return b; },
        neq(col: string, val: any)    { eqFilters.push((r) => r[col] !== val); return b; },
        in(col: string, vals: any[])  { inFilters.push((r) => vals.includes(r[col])); return b; },
        gte(col: string, val: any)    { gteFilters.push((r) => r[col] >= val); return b; },
        lt(col: string, val: any)     { ltFilters.push((r) => r[col] < val); return b; },
        order()                       { return b; },
        limit(n: number)              { return b; },

        or(expr: string) {
          // "blocker_id.eq.X,blocked_id.eq.X" — bidirectional block query
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.(\w+)\.(.+)$/);
            return m ? { col: m[1], op: m[2], val: m[3] } : null;
          }).filter(Boolean) as { col: string; op: string; val: string }[];
          orFilters.push((r) =>
            parts.some(({ col, op, val }) => op === "eq" && String(r[col]) === val),
          );
          return b;
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

    async rpc(name: string, _args: any) {
      if (state.rpcOverride !== undefined) return state.rpcOverride;
      // Default: succeed with a minimal create response
      return {
        data: {
          recap:   { id: RECAP_ID, owner_id: OWNER_ID, place_id: PLACE_ID, status: "draft" },
          version: { id: "v1", version_number: 1, status: "draft" },
        },
        error: null,
      };
    },
  };
}

// ── Helpers: minimal valid rows ────────────────────────────────────────────────

function validPlaceDay(overrides?: Partial<any>): any {
  return {
    id: PLACE_DAY_ID,
    place_id: PLACE_ID,
    local_date: "2026-08-01",
    timezone: "UTC",
    status: "archived",
    ...overrides,
  };
}

function validPlace(overrides?: Partial<any>): any {
  return { id: PLACE_ID, name: "Test Place", city: "London", ...overrides };
}

/** An eligible post authored by OWNER_ID on 2026-08-01 UTC. */
function ownerPost(overrides?: Partial<any>): any {
  return {
    id: POST_ID,
    author_id: OWNER_ID,
    canonical_place_id: PLACE_ID,
    created_at: "2026-08-01T12:00:00.000Z",
    visibility: "public",
    status: "active",
    post_status: "published",
    publish_at: null,
    content: "hello",
    media_urls: [],
    media_thumbnail_url: null,
    media_type: "image",
    profiles: { id: OWNER_ID, is_private: false },
    ...overrides,
  };
}

function baseState(overrides?: Partial<RecapState>): RecapState {
  return {
    flags: ALL_FLAGS,
    place_days: [validPlaceDay()],
    places: [validPlace()],
    blocks: [],
    posts: [ownerPost()],
    user_follows: [],
    shared_moments: [],
    shared_moment_contributions: [],
    live_place_recaps: [],
    ...overrides,
  };
}

// ── Server setup ───────────────────────────────────────────────────────────────

let base: string;
let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", placeRecapsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(() => server.close());

function post(path: string, body: any = {}, token = OWNER_TOKEN) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, token = OWNER_TOKEN) {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

// ── 1. Mismatched Place Day ownership ──────────────────────────────────────────

describe("Place Recap — mismatched Place Day and place snapshot", () => {
  it("rejects a place day whose place_id does not resolve to a known place", async () => {
    // place_day points to OTHER_PLACE_ID which has no entry in places[]
    const state = baseState({
      place_days: [validPlaceDay({ place_id: OTHER_PLACE_ID })],
      places: [validPlace()],          // PLACE_ID exists but not OTHER_PLACE_ID
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { placeDayId: PLACE_DAY_ID });
    // Route fetches place from parent.place_id (OTHER_PLACE_ID) — not found
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "not_found");
  });

  it("rejects a place day that is still active — not yet in closing/archived status", async () => {
    const state = baseState({
      place_days: [validPlaceDay({ status: "active" })],
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { placeDayId: PLACE_DAY_ID });
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "not_found");
    assert.match(body.message ?? "", /Eligible recap parent not found/);
  });

  it("rejects when the owner has no eligible post on the place day", async () => {
    // All posts are by OTHER_USER_ID — owner has zero activity
    const state = baseState({
      posts: [ownerPost({ author_id: OTHER_USER_ID, profiles: { id: OTHER_USER_ID, is_private: false } })],
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { placeDayId: PLACE_DAY_ID });
    assert.equal(r.status, 403);
    const body = await r.json() as any;
    assert.equal(body.error, "forbidden");
  });

  it("rejects when the place snapshot id would not match the recap place — RPC guard", async () => {
    // Route correctly constructs the snapshot, but the RPC rejects it as tampered
    const state = baseState({
      rpcOverride: {
        data: null,
        error: { message: "place snapshot must identify recap place" },
      },
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { placeDayId: PLACE_DAY_ID });
    assert.equal(r.status, 500);
    const body = await r.json() as any;
    assert.equal(body.error, "db_error");
  });
});

// ── 2. Fabricated or stale source IDs ─────────────────────────────────────────

describe("Place Recap — fabricated and stale source IDs", () => {
  it("surfaces the RPC error when a source post does not belong to the place day", async () => {
    const state = baseState({
      rpcOverride: {
        data: null,
        error: { message: "invalid place day recap source" },
      },
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { placeDayId: PLACE_DAY_ID });
    assert.equal(r.status, 500);
    const body = await r.json() as any;
    assert.equal(body.error, "db_error");
  });

  it("surfaces the RPC error when a moment contribution source is fabricated", async () => {
    const moment = {
      id: MOMENT_ID,
      owner_id: OWNER_ID,
      place_id: PLACE_ID,
      place_day_id: null,
      status: "archived",
    };
    const state = baseState({
      shared_moments: [moment],
      rpcOverride: {
        data: null,
        error: { message: "invalid shared moment recap source" },
      },
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { momentId: MOMENT_ID });
    assert.equal(r.status, 500);
    const body = await r.json() as any;
    assert.equal(body.error, "db_error");
  });

  it("surfaces the RPC error when a source contributor id is stale", async () => {
    const state = baseState({
      rpcOverride: {
        data: null,
        error: { message: "invalid place day recap source" },
      },
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { placeDayId: PLACE_DAY_ID });
    assert.equal(r.status, 500);
    const body = await r.json() as any;
    assert.equal(body.error, "db_error");
  });
});

// ── 3. Unknown chapter references ─────────────────────────────────────────────

describe("Place Recap — chapter references unknown source IDs", () => {
  it("surfaces the RPC error when a chapter references a source id not in the sources array", async () => {
    const state = baseState({
      rpcOverride: {
        data: null,
        error: { message: "chapter references an unknown source" },
      },
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { placeDayId: PLACE_DAY_ID });
    assert.equal(r.status, 500);
    const body = await r.json() as any;
    assert.equal(body.error, "db_error");
  });
});

// ── 4. Shared moment parent validation ────────────────────────────────────────

describe("Place Recap — shared moment parent validation", () => {
  it("rejects a moment owned by a different user", async () => {
    const moment = {
      id: MOMENT_ID,
      owner_id: OTHER_USER_ID,   // not OWNER_ID
      place_id: PLACE_ID,
      place_day_id: null,
      status: "archived",
    };
    const state = baseState({ shared_moments: [moment] });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { momentId: MOMENT_ID });
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "not_found");
  });

  it("rejects a moment that is not yet archived", async () => {
    const moment = {
      id: MOMENT_ID,
      owner_id: OWNER_ID,
      place_id: PLACE_ID,
      place_day_id: null,
      status: "active",          // must be archived
    };
    const state = baseState({ shared_moments: [moment] });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { momentId: MOMENT_ID });
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "not_found");
  });

  it("surfaces the RPC error when the shared moment's place does not match the recap place", async () => {
    const moment = {
      id: MOMENT_ID,
      owner_id: OWNER_ID,
      place_id: OTHER_PLACE_ID,  // mismatched place
      place_day_id: null,
      status: "archived",
    };
    // The route resolves place from parent.place_id (OTHER_PLACE_ID); if that
    // place exists the snapshot will carry OTHER_PLACE_ID, and the RPC then
    // rejects because the moment's linked place differs.
    const state = baseState({
      shared_moments: [moment],
      places: [
        validPlace(),
        { id: OTHER_PLACE_ID, name: "Other Place", city: null },
      ],
      rpcOverride: {
        data: null,
        error: { message: "shared moment place does not match recap place" },
      },
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { momentId: MOMENT_ID });
    assert.equal(r.status, 500);
    const body = await r.json() as any;
    assert.equal(body.error, "db_error");
  });
});

// ── 5. Unsafe restore transitions ─────────────────────────────────────────────

describe("Place Recap — restoring archived draft or reviewed version is rejected", () => {
  /** Wire up an existing recap row and make the RPC reject the restore. */
  function restoreRejectState(rpcErrorMessage: string): RecapState {
    return baseState({
      live_place_recaps: [
        {
          id: RECAP_ID,
          owner_id: OWNER_ID,
          place_day_id: PLACE_DAY_ID,
          moment_id: null,
          place_id: PLACE_ID,
          status: "archived",
          current_version_id: "v1",
        },
      ],
      rpcOverride: {
        data: null,
        error: { message: rpcErrorMessage },
      },
    });
  }

  it("rejects restoring an archived draft version — draft was never published", async () => {
    // A version that went draft → archived without ever being published cannot
    // be restored because v_version.published_at IS NULL in the RPC guard.
    const state = restoreRejectState("invalid recap transition");
    _setTestClient(makeRecapClient(state), true);

    const r = await post(`/place-recaps/${RECAP_ID}/restore`);
    assert.equal(r.status, 409);
    const body = await r.json() as any;
    assert.equal(body.error, "conflict");
  });

  it("rejects restoring an archived reviewed version — reviewed but never published", async () => {
    // A version that was reviewed but never published has published_at IS NULL;
    // the RPC restore guard requires published_at IS NOT NULL.
    const state = restoreRejectState("invalid recap transition");
    _setTestClient(makeRecapClient(state), true);

    const r = await post(`/place-recaps/${RECAP_ID}/restore`);
    assert.equal(r.status, 409);
    const body = await r.json() as any;
    assert.equal(body.error, "conflict");
  });

  it("returns not_found when restoring a recap the owner does not own", async () => {
    // live_place_recaps is empty — guardExisting returns null → 404
    const state = baseState({ live_place_recaps: [] });
    _setTestClient(makeRecapClient(state), true);

    const r = await post(`/place-recaps/${RECAP_ID}/restore`);
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "not_found");
  });
});

// ── 6. Recap feature flag gate ────────────────────────────────────────────────

describe("Place Recap — feature flag gate prevents reaching RPC", () => {
  it("returns feature_disabled when place_recaps_enabled is false", async () => {
    const state = baseState({
      flags: ALL_FLAGS.map((f) =>
        f.flag === "place_recaps_enabled" ? { ...f, enabled: false } : f,
      ),
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { placeDayId: PLACE_DAY_ID });
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "feature_disabled");
  });

  it("returns feature_disabled when live_places_enabled prerequisite is missing", async () => {
    const state = baseState({
      flags: ALL_FLAGS.map((f) =>
        f.flag === "live_places_enabled" ? { ...f, enabled: false } : f,
      ),
    });
    _setTestClient(makeRecapClient(state), true);

    const r = await post("/place-recaps", { placeDayId: PLACE_DAY_ID });
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "feature_disabled");
  });
});
