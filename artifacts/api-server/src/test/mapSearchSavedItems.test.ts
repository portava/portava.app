/**
 * §27 "Saved items" — the ninth search heading, end to end on the server.
 *
 * WHAT WAS WRONG (census-map M201, BUILT-BUT-WRONG)
 * ================================================
 * The client carried the whole `saved` branch and had done since map search was
 * written: `MAP_SEARCH_RESULT_TYPES` ends in `'saved'`, `SavedSearchResult`
 * carries a `savedKind` discriminant, `frameFor` has a `case 'saved'` with its
 * own FOCUS_TRIP / FOCUS_AREA / FOCUS_PLACE ladder, `MAP_SEARCH_GROUP_LABELS`
 * has the "Saved items" heading, and `SERVER_TYPE_TO_MAP_TYPE` held a `saved`
 * key. Every one of those was dead: `SEARCH_TYPES` in
 * `routes/discoverySearch.ts` had no `saved` member, so no result of that type
 * could ever leave the server, and the adapter's own comment said so —
 * *"The server has NO `saved` SearchType and never emits one"*.
 *
 * A branch nothing can reach is not a built feature, and the census scored it
 * that way. This file is the executable form of the claim that it is reachable
 * now: the lane is asked for saved items and the assertions are about the rows
 * that come back, not about the table that declares the type.
 *
 * WHY THE FIXTURE HAS TWO SAVE TABLES
 * ===================================
 * `public.saved_places` has zero writers anywhere in this repo — the map's
 * saved layer was moved off it in #446 for exactly that reason. Saves land in
 * `wishlist_places` (served-id TEXT space, with a `place_data` snapshot) and in
 * `discovery_place_saves` (a `discovery_places.id` uuid), written by two paths
 * that never write each other's. A lane reading one alone would return a
 * plausible, wrong answer, so both are seeded here and each has a case that
 * fails if its table stops being read.
 *
 * VACUITY GUARDS. Every positive assertion below names ids. The first test
 * proves the lane is even selectable (a `dispatchSearch` default of `[]` would
 * satisfy a bare "no error" assertion), and the fake client THROWS on any
 * operator it does not model, so a filter that silently matched everything
 * would surface as a wrong id list rather than as a pass.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/mapSearchSavedItems.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { dispatchSearch } from "../routes/discoverySearch.js";
import { _clearPlaceIdBridgeCache } from "../lib/placeIdBridge.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const STRANGER = "bb000000-0000-4000-a000-000000000002";
const BLOCKED = "cc000000-0000-4000-a000-000000000003";

const V_CAFE = "dd000000-0000-4000-a000-000000000010"; // saved via discovery_place_saves
const V_MUSEUM = "dd000000-0000-4000-a000-000000000011"; // saved via wishlist_places (db/<uuid>)
const V_BLOCKED = "dd000000-0000-4000-a000-000000000012"; // submitted by a blocked user
const V_OTHER = "dd000000-0000-4000-a000-000000000013"; // nobody saved it

// ── A PostgREST-shaped read double, narrow on purpose ────────────────────────
//
// Only the operators this lane issues are modelled. An unmodelled one throws:
// a fake that answers every call with "all rows" makes every filter test
// vacuous, which is the failure this suite exists to avoid.

interface FakeOpts {
  /** Tables whose read resolves as an error (supabase-js RESOLVES, never throws). */
  unreadable?: string[];
}

function ilikeToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/\\([%_])/g, "\u0000$1")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".")
    .replace(/\u0000\\?([%_])/g, "$1");
  return new RegExp(`^${body}$`, "i");
}

function splitOutsideParens(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") { depth++; cur += ch; }
    else if (ch === ")") { depth--; cur += ch; }
    else if (ch === "," && depth === 0) { if (cur.trim() !== "") out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function makeClient(state: Record<string, any[]>, opts: FakeOpts = {}) {
  const reads: Array<{ table: string }> = [];
  const client = {
    from(table: string) {
      reads.push({ table });
      const unreadable = (opts.unreadable ?? []).includes(table);
      let rows = [...(state[table] ?? [])];
      const q: any = {
        select() { return q; },
        eq(col: string, val: unknown) { rows = rows.filter((r) => r[col] === val); return q; },
        in(col: string, vals: unknown[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
        order() { return q; },
        limit(n: number) { rows = rows.slice(0, n); return q; },
        or(expr: string) {
          const preds = splitOutsideParens(expr).map((part) => {
            const m = /^([\w.]+)\.(\w+)\.(.*)$/.exec(part.trim());
            if (!m) throw new Error(`fake: unparseable or() clause ${part}`);
            const [, col, op, val] = m as unknown as [string, string, string, string];
            if (op === "ilike") {
              const re = ilikeToRegExp(val);
              return (r: any) => typeof r[col] === "string" && re.test(r[col]);
            }
            if (op === "in") {
              const list = val.replace(/^\(/, "").replace(/\)$/, "").split(",").map((v) => v.trim());
              return (r: any) => typeof r[col] === "string" && list.includes(r[col]);
            }
            throw new Error(`fake: unsupported or() operator ${op}`);
          });
          rows = rows.filter((r) => preds.some((p) => p(r)));
          return q;
        },
        then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
          const result = unreadable
            ? { data: null, error: { message: `simulated unreadable ${table}` } }
            : { data: rows, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client, reads };
}

function baseState(): Record<string, any[]> {
  return {
    discovery_places: [
      { id: V_CAFE, name: "Cafe Lumina", city: "Da Nang", blurb: "quiet mornings", image_url: null, primary_category: "cafe", category: "cafe", lat: 16.05, lng: 108.2, status: "active", submitted_by: STRANGER, canonical_location_id: null, osm_id: null },
      { id: V_MUSEUM, name: "Lumina Museum", city: "Hoi An", blurb: null, image_url: null, primary_category: "museum", category: "museum", lat: 15.88, lng: 108.33, status: "active", submitted_by: STRANGER, canonical_location_id: null, osm_id: null },
      { id: V_BLOCKED, name: "Lumina Bar", city: "Hue", blurb: null, image_url: null, primary_category: "bar", category: "bar", lat: 16.46, lng: 107.59, status: "active", submitted_by: BLOCKED, canonical_location_id: null, osm_id: null },
      { id: V_OTHER, name: "Lumina Gallery", city: "Hanoi", blurb: null, image_url: null, primary_category: "gallery", category: "gallery", lat: 21.03, lng: 105.85, status: "active", submitted_by: STRANGER, canonical_location_id: null, osm_id: null },
    ],
    discovery_place_saves: [
      { user_id: ME, place_id: V_CAFE, saved_at: "2026-03-01T00:00:00Z" },
      { user_id: ME, place_id: V_BLOCKED, saved_at: "2026-03-02T00:00:00Z" },
      { user_id: STRANGER, place_id: V_OTHER, saved_at: "2026-03-03T00:00:00Z" },
    ],
    wishlist_places: [
      { user_id: ME, place_id: `db/${V_MUSEUM}`, place_data: { name: "Lumina Museum" }, saved_at: "2026-03-04T00:00:00Z" },
      { user_id: STRANGER, place_id: `db/${V_OTHER}`, place_data: { name: "Lumina Gallery" }, saved_at: "2026-03-05T00:00:00Z" },
    ],
  };
}

async function saved(
  state: Record<string, any[]>,
  q = "Lumina",
  opts: FakeOpts = {},
  blocked: Set<string> = new Set([BLOCKED]),
) {
  const { client, reads } = makeClient(state, opts);
  const results = await dispatchSearch(client as any, q, ME, blocked, new Set<string>(), "saved", 0, 20);
  return { results, reads, ids: results.map((r) => r.id) };
}

beforeEach(() => { _clearPlaceIdBridgeCache(); });

describe("§27 Saved items reaches the client at all", () => {
  it("dispatchSearch has a `saved` lane that returns rows — not the default []", async () => {
    const { results, ids } = await saved(baseState());
    // The regression in one line: before the lane existed this returned [],
    // because "saved" fell through dispatchSearch's `default`.
    assert.ok(results.length > 0, "the saved lane returned nothing at all");
    assert.deepEqual([...ids].sort(), [V_CAFE, V_MUSEUM].sort());
  });

  it("every row is typed `saved` — the wire spelling the adapter maps to §27's ninth heading", async () => {
    const { results } = await saved(baseState());
    for (const r of results) assert.equal(r.type, "saved");
  });

  it("carries the geometry §27 needs to frame the map object, and the savedKind discriminant", async () => {
    const { results } = await saved(baseState());
    const cafe = results.find((r) => r.id === V_CAFE);
    assert.ok(cafe, "the discovery_place_saves venue is missing");
    assert.equal(cafe.metadata?.lat, 16.05);
    assert.equal(cafe.metadata?.lng, 108.2);
    // The client hard-coded savedKind because the server sent none. It is
    // stated on the wire now, so a saved Trip or Area can arrive later without
    // a second wire type.
    assert.equal(cafe.metadata?.savedKind, "place");
    assert.equal(cafe.destinationRoute, `/place/${V_CAFE}`);
  });
});

describe("both save tables are read — neither alone is a superset", () => {
  it("a save that exists ONLY in discovery_place_saves arrives", async () => {
    const state = baseState();
    state.wishlist_places = [];
    const { ids } = await saved(state);
    assert.deepEqual(ids, [V_CAFE]);
  });

  it("a save that exists ONLY in wishlist_places arrives, bridged out of the served id space", async () => {
    const state = baseState();
    state.discovery_place_saves = [];
    const { ids } = await saved(state);
    assert.deepEqual(ids, [V_MUSEUM]);
  });

  it("one unreadable save table does not erase the other's saves", async () => {
    // supabase-js RESOLVES on a DB error, so an unreadable table and an empty
    // one are indistinguishable at the call site. Reading them independently is
    // what keeps a broken wishlist_places from reporting "you have no saves".
    const { ids } = await saved(baseState(), "Lumina", { unreadable: ["wishlist_places"] });
    assert.deepEqual(ids, [V_CAFE]);
  });
});

describe("the lane is viewer-scoped and respects blocks", () => {
  it("never returns another person's saves", async () => {
    const { ids } = await saved(baseState());
    assert.ok(!ids.includes(V_OTHER), "a stranger's save leaked into this viewer's results");
  });

  it("a blocked submitter's venue stays out, even when this viewer saved it earlier", async () => {
    const { ids } = await saved(baseState());
    assert.ok(!ids.includes(V_BLOCKED), "blocking was undone by an older save");
  });

  it("with the block lifted the same venue does arrive — the filter is the block, not the fixture", async () => {
    const { ids } = await saved(baseState(), "Lumina", {}, new Set<string>());
    assert.ok(ids.includes(V_BLOCKED));
  });

  it("an unreadable block set refuses outright rather than serving unfiltered saves", async () => {
    const { client } = makeClient(baseState());
    const results = await dispatchSearch(client as any, "Lumina", ME, null, new Set<string>(), "saved", 0, 20);
    assert.deepEqual(results, []);
  });
});

describe("the query actually filters", () => {
  it("a query matching nothing returns nothing", async () => {
    const { ids } = await saved(baseState(), "Reykjavik");
    assert.deepEqual(ids, []);
  });

  it("a query matching one saved venue returns only it", async () => {
    const { ids } = await saved(baseState(), "Museum");
    assert.deepEqual(ids, [V_MUSEUM]);
  });

  it("matches on city as well as name", async () => {
    const { ids } = await saved(baseState(), "Da Nang");
    assert.deepEqual(ids, [V_CAFE]);
  });
});

describe("a wishlist save that reaches no discovery_places row", () => {
  it("is still returned, from the snapshot the save recorded", async () => {
    const state = baseState();
    state.discovery_place_saves = [];
    state.wishlist_places = [
      { user_id: ME, place_id: "node/99887766", place_data: { name: "Lumina Rooftop", city: "Da Lat", lat: 11.94, lng: 108.44 }, saved_at: "2026-03-06T00:00:00Z" },
    ];
    const { results } = await saved(state);
    assert.deepEqual(results.map((r) => r.id), ["node/99887766"]);
    assert.equal(results[0]!.title, "Lumina Rooftop");
    assert.equal(results[0]!.metadata?.lat, 11.94);
    assert.equal(results[0]!.metadata?.fromSnapshot, true);
  });

  it("is dropped when the snapshot does not match the query — not passed through unfiltered", async () => {
    const state = baseState();
    state.discovery_place_saves = [];
    state.wishlist_places = [
      { user_id: ME, place_id: "node/99887766", place_data: { name: "Somewhere Else", city: "Da Lat" }, saved_at: "2026-03-06T00:00:00Z" },
    ];
    const { ids } = await saved(state);
    assert.deepEqual(ids, []);
  });
});
