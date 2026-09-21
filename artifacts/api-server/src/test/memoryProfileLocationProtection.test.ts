/**
 * The profile listing of Memories, and the location protection three of its
 * four sibling reads perform.
 *
 * Highlights/Memories Development Architecture Spec v1
 *   §10  "Publishing location must never exceed the owner's selected precision."
 *   §23  `canSeeExactLocation(userId, memoryId)` — a per-viewer predicate, not a
 *        per-handler habit.
 *   §25  hard invariant: "Public location precision cannot exceed owner policy."
 *   §28.7 "Never allow public location precision above the owner's publication
 *        policy."
 *
 * WHAT WAS WRONG, AND IT IS LIVE RATHER THAN LATENT
 * ------------------------------------------------
 * `routes/memories.ts` has four reads that serve a Memory's coordinates:
 *
 *     GET /memories            protectMemoryRow  ✔
 *     GET /memories/:id        protectMemoryRow  ✔
 *     GET /trips/:tripId/memory protectMemoryRow ✔
 *     GET /users/:userId/memories               ✘   <- this one
 *
 * The fourth went straight to `enrichMemories`, which serializes the raw row.
 * `protectMemoryRow` clamps to the STRICTER of two independent ceilings, and
 * they do not share a blocker:
 *
 *   - the owner's §10 `location_precision` rung is behind
 *     `memory_location_precision_enabled`, because migration 2338 is unapplied;
 *   - the HIDDEN-GEM ceiling is behind nothing. `public.hidden_gems` is a
 *     DEPLOYED table (it is in src/test/generated/liveColumns.json with
 *     `sensitivity_level`, `status`, `latitude`, `longitude`), and
 *     `gemCeilingForItem` clamps a coordinate sitting on a protected gem to
 *     `city` on every other Memory read in the file.
 *
 * So a Memory whose coordinates sit on a protected gem was served COARSE from
 * the discovery feed and EXACT from the owner's profile — the same row, the same
 * viewer, two different disclosures, decided by which handler was reached.
 *
 * The controls below are what make the red mean something: the feed is asserted
 * on the SAME fixture in the same test, so a fixture that failed to trigger a
 * gem ceiling at all would fail the control rather than pass the subject.
 *
 * Run: node --import tsx/esm --test src/test/memoryProfileLocationProtection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";

const OWNER  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const M_ON_GEM = "11111111-1111-1111-1111-111111111111";

/** The exact stored coordinate. A protected gem sits on it. */
const EXACT_LAT = 40.0;
const EXACT_LNG = 10.0;
const CITY = "Lisbon";

interface Row { [k: string]: any }

function memory(over: Row = {}): Row {
  return {
    id: M_ON_GEM, owner_id: OWNER, title: "t", caption: null,
    visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: null,
    location_city: CITY, location_country: "Portugal",
    location_lat: EXACT_LAT, location_lng: EXACT_LNG, canonical_location_id: null,
    starts_at: null, ends_at: null, state: "published",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** A live, restrictive gem on the Memory's coordinates. Ceiling: `city`. */
function protectedGem(over: Row = {}): Row {
  return {
    canonical_place_id: null,
    sensitivity_level: "protected",
    status: "active",
    city: CITY,
    latitude: EXACT_LAT,
    longitude: EXACT_LNG,
    approx_latitude: null,
    approx_longitude: null,
    ...over,
  };
}

interface State {
  memories: Row[];
  hidden_gems: Row[];
  blocks: Row[];
  feature_flags: Row[];
  profiles: Row[];
  errorTables: Set<string>;
}

function baseState(over: Partial<State> = {}): State {
  return {
    memories: [memory()],
    hidden_gems: [protectedGem()],
    blocks: [],
    feature_flags: [],
    profiles: [
      { id: OWNER,  account_status: "active", name: "Owner",  handle: "owner",  avatar_url: null },
      { id: VIEWER, account_status: "active", name: "Viewer", handle: "viewer", avatar_url: null },
    ],
    errorTables: new Set<string>(),
    ...over,
  };
}

function makeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let countMode = false;

    const builder: any = {
      select(_c?: string, opts?: any) { if (opts?.count === "exact" && opts?.head) countMode = true; return builder; },
      update() { return builder; },
      insert() { return builder; },
      upsert() { return builder; },
      delete() { return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return builder; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return builder; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return builder; },
      is(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      not(c: string, op: string, v: any) {
        if (op === "cs") {
          const wanted = String(v).replace(/^\{|\}$/g, "").split(",").filter(Boolean);
          filters.push((r) => !wanted.some((w) => (r[c] ?? []).includes(w)));
        } else if (op === "in") {
          const list = String(v).replace(/^\(|\)$/g, "").split(",")
            .map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
          filters.push((r) => !list.includes(r[c]));
        } else {
          filters.push((r) => r[c] !== v);
        }
        return builder;
      },
      order(c: string, o?: any) { orderCol = c; orderAsc = o?.ascending !== false; return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(onF: any, onR: any) { return resolve(false).then(onF, onR); },
    };

    function matched(): Row[] {
      let out = ((state as any)[table] ?? []).filter((r: Row) => filters.every((f) => f(r)));
      if (orderCol) {
        const c = orderCol;
        out = [...out].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0));
        if (!orderAsc) out.reverse();
      }
      if (limitN != null) out = out.slice(0, limitN);
      return out;
    }

    async function resolve(single: boolean) {
      if (state.errorTables.has(table)) {
        return { data: null, error: { message: `${table} lookup failed` }, count: null };
      }
      const rows = matched();
      if (countMode) return { data: null, error: null, count: rows.length };
      return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length };
    }

    return builder;
  }

  return {
    from,
    async rpc(fn: string) { return { data: null, error: { message: `unknown rpc ${fn}` } }; },
    auth: {
      getUser: async (tok: string) => {
        const map: Record<string, string> = { "owner-tok": OWNER, "viewer-tok": VIEWER };
        const id = map[tok];
        if (!id) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: { id } }, error: null };
      },
    },
  };
}

async function startApp(state: State) {
  _setTestClient(makeClient(state) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", memoriesRouter);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

async function get(base: string, path: string, tok?: string) {
  const hdrs: Record<string, string> = { connection: "close" };
  if (tok) hdrs["Authorization"] = `Bearer ${tok}`;
  const res = await fetch(`${base}${path}`, { headers: hdrs });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const firstOf = (b: any): any => (b?.memories ?? [])[0] ?? null;

describe("GET /users/:userId/memories — the Hidden-Gem ceiling three sibling reads apply", () => {
  it("does not serve the exact coordinate of a Memory sitting on a protected gem", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${OWNER}/memories`, "viewer-tok");
      assert.equal(status, 200);
      const m = firstOf(body);
      assert.ok(m, "the public memory is readable by this viewer — the ladder is not what is under test");
      assert.notEqual(
        m.locationLat, EXACT_LAT,
        "the profile listing served the EXACT latitude of a Memory on a protected Hidden Gem",
      );
      assert.notEqual(m.locationLng, EXACT_LNG, "same for longitude");
      // `city` survives a `city` ceiling — what must not survive is the point.
      assert.equal(m.locationCity, CITY);
    } finally { await app.close(); }
  });

  it("agrees, coordinate for coordinate, with the discovery feed on the same row", async () => {
    // The control that makes the subject meaningful: if the fixture triggered no
    // gem ceiling at all, the feed would serve the exact coordinate too and this
    // assertion would hold vacuously — so it is paired with the feed's own
    // coarsening assertion below.
    const app = await startApp(baseState());
    try {
      const feed = firstOf((await get(app.baseUrl, "/api/memories", "viewer-tok")).body);
      const profile = firstOf((await get(app.baseUrl, `/api/users/${OWNER}/memories`, "viewer-tok")).body);
      assert.ok(feed && profile);
      assert.notEqual(feed.locationLat, EXACT_LAT, "CONTROL: the feed must be coarsening this fixture");
      assert.equal(
        profile.locationLat, feed.locationLat,
        "two reads of one row disclosed two different latitudes to one viewer",
      );
      assert.equal(profile.locationLng, feed.locationLng, "same for longitude");
    } finally { await app.close(); }
  });

  it("still serves the owner their own exact coordinate", async () => {
    const app = await startApp(baseState());
    try {
      const m = firstOf((await get(app.baseUrl, `/api/users/${OWNER}/memories`, "owner-tok")).body);
      assert.ok(m);
      assert.equal(m.locationLat, EXACT_LAT, "the owner bypass must survive the fix");
      assert.equal(m.locationLng, EXACT_LNG);
    } finally { await app.close(); }
  });

  it("fails CLOSED when hidden_gems cannot be read", async () => {
    // `loadMemoryGemContext` catches the throw and records `determined: false`,
    // which clamps to UNDETERMINED_GEM_CEILING. A listing that skipped
    // protectMemoryRow never consulted the flag at all.
    const state = baseState({ hidden_gems: [] });
    state.errorTables.add("hidden_gems");
    const app = await startApp(state);
    try {
      const m = firstOf((await get(app.baseUrl, `/api/users/${OWNER}/memories`, "viewer-tok")).body);
      assert.ok(m);
      assert.notEqual(
        m.locationLat, EXACT_LAT,
        "an unreadable gem table must withhold the exact point, not serve it",
      );
    } finally { await app.close(); }
  });

  it("leaves a Memory with no gem over it unchanged", async () => {
    // The fix must not become a blanket coarsener: with no restrictive gem and
    // the precision flag off, `protectMemoryRow` is a no-op by construction and
    // the row must be served exactly as it was before.
    const app = await startApp(baseState({ hidden_gems: [] }));
    try {
      const m = firstOf((await get(app.baseUrl, `/api/users/${OWNER}/memories`, "viewer-tok")).body);
      assert.ok(m);
      assert.equal(m.locationLat, EXACT_LAT, "no gem, flag off ⇒ no constraint ⇒ unchanged");
      assert.equal(m.locationLng, EXACT_LNG);
    } finally { await app.close(); }
  });
});
