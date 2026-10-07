/**
 * §14 zero-character PLACE sources — census-input-intelligence G86 (place
 * picker: nearby, recent, Trip places), G89 (global search: around you now,
 * current Trip) and G90 (Hidden Gem location: nearby canonical places).
 * Lane R wave 2, 2026-10-07.
 *
 * Every case goes through POST /input-assistance/suggest with an EMPTY field
 * and asserts what the viewer is served. The controls are what keep the
 * positives honest: a field whose policy may not show a place gets none; a
 * place far away is not "nearby"; another member's private plan item, a
 * blocked submitter's venue, a place that is not live, and a Trip the viewer
 * is not on are all withheld; and the personal sources never reach the
 * Hidden Gem location field, which does not allow personalization.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceZeroStatePlaces.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js"; import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js"; import { clearProtectedZoneCache } from "../lib/protectedZoneStore.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const MATE = "aa000000-0000-4000-a000-000000000002";
const AUTHOR = "bb000000-0000-4000-a000-000000000003";
const ME_TOK = "tok-me";

const NEAR = "cc000000-0000-4000-a000-0000000000a1";
const FAR = "cc000000-0000-4000-a000-0000000000a2";
const RECENT = "cc000000-0000-4000-a000-0000000000a3";
const TRIP_PLACE = "cc000000-0000-4000-a000-0000000000a4";
const MATE_PRIVATE = "cc000000-0000-4000-a000-0000000000a5";
const NOT_LIVE = "cc000000-0000-4000-a000-0000000000a6";
const OTHER_TRIP_PLACE = "cc000000-0000-4000-a000-0000000000a7";
const TRIP = "dd000000-0000-4000-a000-0000000000d1";
const NOT_MY_TRIP = "dd000000-0000-4000-a000-0000000000d2";

// Da Nang's beach; NEAR is ~300 m away, FAR ~20 km.
const HERE = { lat: 16.0544, lng: 108.2461 };

type Row = Record<string, unknown>;
interface Result { data: unknown; error: unknown }
interface Builder extends PromiseLike<Result> {
  select(cols?: string): Builder;
  eq(c: string, v: unknown): Builder;
  neq(c: string, v: unknown): Builder;
  in(c: string, vs: readonly unknown[]): Builder;
  is(c: string, v: unknown): Builder;
  not(c: string, op: string, v: unknown): Builder;
  gte(c: string, v: number | string): Builder;
  lte(c: string, v: number | string): Builder;
  gt(c: string, v: number | string): Builder;
  lt(c: string, v: number | string): Builder;
  ilike(c: string, pattern: string): Builder;
  or(expr: string): Builder;
  order(c?: string, o?: unknown): Builder;
  limit(n: number): Builder;
  range(from: number, to: number): Builder;
  maybeSingle(): Promise<Result>;
  single(): Promise<Result>;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeClient(db: Record<string, Row[]>, failing: ReadonlySet<string> = new Set()) {
  function from(table: string): Builder {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    // Postgres refuses a non-UUID compared with a uuid column (22P02) and the
    // WHOLE read fails — so a provider id slipped into `.in('id', …)` costs
    // every row, not just its own. Modelled for the uuid `id` columns read here.
    let badUuid = false;
    const run = async (one: boolean): Promise<Result> => {
      if (failing.has(table)) return { data: null, error: { message: `injected failure on ${table}` } };
      if (badUuid) return { data: null, error: { code: "22P02", message: "invalid input syntax for type uuid" } };
      let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: one ? (rows[0] ?? null) : rows, error: null };
    };
    const cmp = (v: unknown, x: number | string, op: (a: number | string, b: number | string) => boolean) =>
      (typeof v === "number" || typeof v === "string") && op(v, x);
    const b: Builder = {
      select() { return b; },
      eq(c, v) { filters.push((r) => r[c] === v); return b; },
      neq(c, v) { filters.push((r) => r[c] !== v); return b; },
      in(c, vs) {
        if (c === "id" && vs.some((v) => typeof v !== "string" || !UUID_SHAPE.test(v))) badUuid = true;
        filters.push((r) => vs.includes(r[c]));
        return b;
      },
      is(c, v) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not(c, op, v) { if (op === "is") filters.push((r) => r[c] != null && r[c] !== v); return b; },
      gte(c, v) { filters.push((r) => cmp(r[c], v, (a, x) => a >= x)); return b; },
      lte(c, v) { filters.push((r) => cmp(r[c], v, (a, x) => a <= x)); return b; },
      gt(c, v) { filters.push((r) => cmp(r[c], v, (a, x) => a > x)); return b; },
      lt(c, v) { filters.push((r) => cmp(r[c], v, (a, x) => a < x)); return b; },
      ilike(c, pattern) {
        const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
        filters.push((r) => re.test(String(r[c] ?? "")));
        return b;
      },
      or(expr) {
        // `blocker_id.eq.X,blocked_id.eq.X` (fetchBlockedSet) and `col.ilike.%x%` lists.
        const parts = expr.split(",").map((p) => /^(\w+)\.(\w+)\.(.+)$/.exec(p.trim())).filter((m): m is RegExpExecArray => m !== null);
        filters.push((r) => parts.some(([, col = "", op, val = ""]) => {
          const cell = String(r[col] ?? "");
          if (op === "eq") return cell === val;
          if (op === "ilike") return new RegExp("^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i").test(cell);
          return false;
        }));
        return b;
      },
      order() { return b; },
      limit(n) { limitN = n; return b; },
      range() { return b; },
      maybeSingle() { return run(true); },
      single() { return run(true); },
      then(onF, onR) { return run(false).then(onF, onR); },
    };
    return b;
  }
  return {
    from,
    rpc: async (): Promise<Result> => ({ data: null, error: null }),
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK ? { data: { user: { id: ME } }, error: null } : { data: { user: null }, error: { message: "bad token" } },
    },
  };
}

function place(id: string, name: string, lat: number, lng: number, over: Row = {}): Row {
  return { id, name, city: "Da Nang", primary_category: "cafe", category: "food", submitted_by: AUTHOR, status: "active", lat, lng, ...over };
}

function world(): Record<string, Row[]> {
  return {
    discovery_places: [
      place(NEAR, "Beach Coffee", HERE.lat + 0.002, HERE.lng + 0.001),
      place(FAR, "Hoi An Bakery", 15.88, 108.33),
      place(RECENT, "Market Noodles", 16.07, 108.22),
      place(TRIP_PLACE, "Marble Mountains", 16.0, 108.26),
      place(MATE_PRIVATE, "Mate's Secret Spot", 16.02, 108.25),
      place(NOT_LIVE, "Closed Diner", 16.03, 108.24, { status: "pending" }),
      place(OTHER_TRIP_PLACE, "Someone Else's Trip Stop", 16.04, 108.23),
    ],
    discovery_place_saves: [],
    user_recent_places: [
      { user_id: ME, place_snapshot: { id: RECENT, name: "Market Noodles (snapshot)" }, used_at: "2026-10-01T00:00:00.000Z" },
      // a snapshot whose id is not a live canonical place: dropped, never rendered from the snapshot
      { user_id: ME, place_snapshot: { id: NOT_LIVE, name: "Closed Diner" }, used_at: "2026-10-02T00:00:00.000Z" },
      // a provider id that is not a canonical place id at all
      { user_id: ME, place_snapshot: { id: "ChIJ-provider-id", name: "Google Place" }, used_at: "2026-10-03T00:00:00.000Z" },
    ],
    trip_members: [
      { trip_id: TRIP, user_id: ME, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: MATE, role: "owner", status: "accepted" },
    ],
    trips: [
      { id: TRIP, owner_id: MATE, title: "Central Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", status: "active", start_date: "2026-10-01" },
      { id: NOT_MY_TRIP, owner_id: MATE, title: "Mate's solo trip", destination_city: "Hue", destination_country: "Vietnam", status: "active", start_date: "2026-10-02" },
    ],
    trip_plan_items: [
      { id: "pi-1", trip_id: TRIP, source_type: "place", source_id: TRIP_PLACE, sort_order: 1, removed_at: null, creator_id: ME, location_is_private: true },
      { id: "pi-2", trip_id: TRIP, source_type: "place", source_id: MATE_PRIVATE, sort_order: 2, removed_at: null, creator_id: MATE, location_is_private: true },
      { id: "pi-3", trip_id: NOT_MY_TRIP, source_type: "place", source_id: OTHER_TRIP_PLACE, sort_order: 1, removed_at: null, creator_id: MATE, location_is_private: false },
    ],
    blocks: [],
    canonical_locations: [],
  };
}

let base = "";
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } });
    next();
  });
  app.use("/api", inputAssistanceRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => _resetRateLimit());

interface Served { entityType?: string; entityId?: string; reason?: string; type?: string; subtitle?: string }

async function zeroState(context: string, db = world(), extra: Record<string, unknown> = { lat: HERE.lat, lng: HERE.lng }, failing: ReadonlySet<string> = new Set()): Promise<Served[]> {
  _setTestClient(makeClient(db, failing) as unknown as Parameters<typeof _setTestClient>[0], true);
  const r = await fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${ME_TOK}` },
    body: JSON.stringify({ context, text: "", ...extra }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { suggestions: Served[] };
  return body.suggestions;
}

const ids = (rows: Served[], reason?: string) =>
  rows.filter((s) => s.entityType === "place" && (reason === undefined || s.reason === reason)).map((s) => s.entityId);

describe("G86 — place_picker at zero characters: nearby, recent and Trip places", () => {
  it("offers a canonical place NEAR the request's position, and not one 20 km away", async () => {
    const rows = await zeroState("place_picker");
    assert.deepEqual(ids(rows, "Nearby"), [NEAR]);
    assert.ok(!ids(rows).includes(FAR));
    const near = rows.find((s) => s.entityId === NEAR);
    assert.ok(near && !/\bm\b|km/.test(near.subtitle ?? ""), "no distance from the viewer is projected");
  });

  it("with no position on the request there is no nearby row (it is never guessed)", async () => {
    const rows = await zeroState("place_picker", world(), {});
    assert.deepEqual(ids(rows, "Nearby"), []);
  });

  it("offers the viewer's RECENT place, resolved to the live canonical place — never from the stored snapshot", async () => {
    const rows = await zeroState("place_picker");
    assert.deepEqual(ids(rows, "Recent"), [RECENT]);
    const recent = rows.find((s) => s.entityId === RECENT) as Served & { label?: string };
    assert.notEqual((recent as { label?: string }).label, "Market Noodles (snapshot)", "the label is the canonical place's, not the snapshot's");
    assert.ok(!ids(rows).includes(NOT_LIVE), "a snapshot of a place that is not live is dropped");
  });

  it("offers the place on the viewer's own Trip, and NOT another member's private plan item", async () => {
    const rows = await zeroState("place_picker");
    assert.deepEqual(ids(rows, "On your Trip"), [TRIP_PLACE]);
    assert.ok(!ids(rows).includes(MATE_PRIVATE), "OD-TRIP-3: another member's private anchor is not shown");
  });

  it("never reads a Trip the viewer is not on", async () => {
    const rows = await zeroState("place_picker");
    assert.ok(!ids(rows).includes(OTHER_TRIP_PLACE));
  });

  it("a Trip membership that is only an INVITE does not count", async () => {
    const db = world();
    db.trip_members = [{ trip_id: TRIP, user_id: ME, role: "member", status: "invited" }];
    const rows = await zeroState("place_picker", db);
    assert.deepEqual(ids(rows, "On your Trip"), []);
  });

  it("a blocked submitter's venue is withheld from every one of the three sources", async () => {
    const db = world();
    db.blocks = [{ blocker_id: AUTHOR, blocked_id: ME }];
    const rows = await zeroState("place_picker", db);
    assert.deepEqual(ids(rows), [], "every fixture place was submitted by AUTHOR");
  });

  it("an UNREADABLE block list serves none of them (fail closed)", async () => {
    const rows = await zeroState("place_picker", world(), { lat: HERE.lat, lng: HERE.lng }, new Set(["blocks"]));
    assert.deepEqual(ids(rows), []);
  });

  it("THE POLICY CONTROL — city_picker may not show a place, so none of the three reaches it", async () => {
    const rows = await zeroState("city_picker");
    assert.deepEqual(ids(rows), []);
  });
});

describe("G90 — hidden_gem_location at zero characters: nearby canonical places, nothing personal", () => {
  it("offers the nearby canonical place", async () => {
    const rows = await zeroState("hidden_gem_location");
    assert.deepEqual(ids(rows, "Nearby"), [NEAR]);
  });

  it("does NOT offer recent or Trip places — the field does not allow personalization", async () => {
    const rows = await zeroState("hidden_gem_location");
    assert.deepEqual(ids(rows, "Recent"), []);
    assert.deepEqual(ids(rows, "On your Trip"), []);
  });
});

describe("G89 — global_search at zero characters: around you now, and the current Trip", () => {
  it("offers the canonical place around the request's position", async () => {
    const rows = await zeroState("global_search");
    assert.deepEqual(ids(rows, "Nearby"), [NEAR]);
  });

  it("offers the viewer's CURRENT Trip as an entity", async () => {
    const rows = await zeroState("global_search");
    const trips = rows.filter((s) => s.entityType === "trip");
    assert.deepEqual(trips.map((t) => [t.entityId, t.reason]), [[TRIP, "Current Trip"]]);
  });

  it("a Trip the viewer is not an accepted member or owner of is never the current Trip", async () => {
    const db = world();
    db.trip_members = [];
    const rows = await zeroState("global_search", db);
    assert.deepEqual(rows.filter((s) => s.entityType === "trip"), []);
  });

  it("an upcoming Trip is not called current", async () => {
    const db = world();
    db.trips = db.trips!.map((t) => ({ ...t, status: "upcoming" }));
    const rows = await zeroState("global_search", db);
    assert.deepEqual(rows.filter((s) => s.entityType === "trip"), []);
  });
});

describe("G86 — the position bounds the READ, not only the page (wave-2 mutant Z2)", () => {
  it("200 live places a degree away, listed first, do not crowd the near one out of the bounded read", async () => {
    const db = world();
    const far = Array.from({ length: 200 }, (_, i) =>
      place(`f0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `Far ${i}`, HERE.lat + 1, HERE.lng + 1),
    );
    db.discovery_places = [...far, ...db.discovery_places!];
    const rows = await zeroState("place_picker", db);
    assert.deepEqual(ids(rows, "Nearby"), [NEAR], "the bounding box is in the query, so the limit cannot be spent on far rows");
  });

  it("a place in the bounding box's CORNER, ~1.85 km away, is outside the 1.5 km radius and not offered (mutant Z2b)", async () => {
    const db = world();
    const CORNER = "c0000000-0000-4000-8000-0000000000c0";
    db.discovery_places = [...db.discovery_places!, place(CORNER, "Corner Cafe", HERE.lat + 0.012, HERE.lng + 0.012)];
    const rows = await zeroState("place_picker", db);
    assert.deepEqual(ids(rows, "Nearby"), [NEAR]);
  });
});

describe("F3 (wave-2 verification) — nearby rows take the §24 protected-zone pass search takes", () => {
  const ZONE_FLAG = "discovery_search_protected_zones_enabled";
  const NEAR2 = "b0000000-0000-4000-8000-0000000000b2";
  const shelterAt = (lat: number, lng: number) => ({
    id: "z-shelter", category: "shelter", action: null, privacy_floor: null, shape: "circle",
    center_lat: lat, center_lng: lng, radius_meters: 60, ring: null, jurisdiction: null, policy_ref: null, active: true,
  });
  function protectedWorld(zones: Row[] | null): Record<string, Row[]> {
    const db = world();
    db.discovery_places = [...db.discovery_places!, place(NEAR2, "Corner Bakery", HERE.lat - 0.003, HERE.lng - 0.002)];
    db.feature_flags = [{ flag: ZONE_FLAG, enabled: true }];
    if (zones) db.protected_zones = zones;
    return db;
  }
  beforeEach(() => { invalidateSearchProtectionFlagCache(); clearProtectedZoneCache(); });
  after(() => { invalidateSearchProtectionFlagCache(); clearProtectedZoneCache(); });

  it("a place inside a SUPPRESS zone is not offered as nearby; the one outside it still is", async () => {
    const rows = await zeroState("place_picker", protectedWorld([shelterAt(HERE.lat + 0.002, HERE.lng + 0.001)]));
    assert.deepEqual(ids(rows, "Nearby"), [NEAR2]);
  });

  it("flag on and the zone policy UNREADABLE: no nearby row at all — a nearby row's whole claim is its position", async () => {
    const rows = await zeroState("place_picker", protectedWorld([]), { lat: HERE.lat, lng: HERE.lng }, new Set(["protected_zones"]));
    assert.deepEqual(ids(rows, "Nearby"), []);
  });

  it("CONTROL — flag on, zones read and none registered: both nearby places are offered, nearest first", async () => {
    const rows = await zeroState("place_picker", protectedWorld([]));
    assert.deepEqual(ids(rows, "Nearby"), [NEAR, NEAR2]);
  });
});

