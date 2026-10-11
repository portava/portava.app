/**
 * census-input-intelligence G90, G179, G201 (wave W, lane input-fields, 2026-10-11).
 *
 *   G90  — the EMPTY Hidden Gem location field offers a map point and the add-new
 *          flow (creation.ts#buildZeroStateLocationActions), not only after a failed
 *          match; neither row carries a coordinate.
 *   G201 — the EMPTY global field offers the places the viewer's Trips contain
 *          (gateway.ts non-geo zero state → zeroStatePlaces.ts#buildTripPlaceSuggestions),
 *          with the same Trip and OD-TRIP-3 rules as the place picker.
 *   G179 — a TYPED place row says "in your Trip" when it is on one of the viewer's
 *          Trips' plans (read from the plan items, not the Trip's city) and "saved"
 *          when the viewer saved it (relationshipLabels.ts). A row that is neither
 *          says nothing, another person's save or private plan item says nothing,
 *          and a failed read says nothing.
 *
 * The harness (fake Supabase client, world, router) is the one
 * inputAssistanceZeroStatePlaces.test.ts uses, copied so neither file's cited
 * lines move.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceTripContextAndGemZeroState.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { buildZeroStateLocationActions } from "../lib/inputAssistance/creation.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
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

function makeClient(db: Record<string, Row[]>, failing: ReadonlySet<string> = new Set(), throwing: ReadonlySet<string> = new Set()) {
  function from(table: string): Builder {
    if (throwing.has(table)) throw new Error(`injected throw on ${table}`);
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


interface Wire extends Served { id?: string; label?: string; action?: { type?: string; value?: Record<string, unknown> }; structuredValue?: unknown; relationship?: string }
interface Envelope { suggestions: Wire[]; refusal?: { coverage?: string; failedSources?: string[] } }

async function serve(context: string, text: string, db: Record<string, Row[]>, opts: { failing?: string[]; throwing?: string[]; extra?: Record<string, unknown> } = {}): Promise<Envelope> {
  _setTestClient(makeClient(db, new Set(opts.failing ?? []), new Set(opts.throwing ?? [])) as unknown as Parameters<typeof _setTestClient>[0], true);
  const r = await fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${ME_TOK}` },
    body: JSON.stringify({ context, text, ...(opts.extra ?? { lat: HERE.lat, lng: HERE.lng }) }),
  });
  assert.equal(r.status, 200);
  return (await r.json()) as Envelope;
}

/** Any number-valued lat/lng/latitude/longitude anywhere in a row. */
function carriesCoordinate(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (/^(lat|lng|latitude|longitude|coords?)$/i.test(k) && x != null) return true;
    if (carriesCoordinate(x)) return true;
  }
  return false;
}

describe("G90 — the EMPTY Hidden Gem location field: map point and add-new before the first character", () => {
  it("offers 'Drop a pin on the map' (drop_pin) and 'Add a new Gem' (create_entity, empty name)", async () => {
    const env = await serve("hidden_gem_location", "", world());
    const pin = env.suggestions.find((s) => s.action?.type === "drop_pin");
    const add = env.suggestions.find((s) => s.action?.type === "set_structured_value" && s.action.value?.kind === "create_entity");
    assert.ok(pin, JSON.stringify(env.suggestions));
    assert.equal(pin!.type, "action");
    assert.equal(pin!.label, "Drop a pin on the map");
    assert.ok(add, JSON.stringify(env.suggestions));
    assert.deepEqual(add!.action!.value, { kind: "create_entity", entityType: "hidden_gem", name: "" });
    assert.equal(add!.label, "Add a new Gem");
  });

  it("the nearby canonical place is still offered, ABOVE the two actions", async () => {
    const env = await serve("hidden_gem_location", "", world());
    const idx = env.suggestions.findIndex((s) => s.entityId === NEAR);
    const pinIdx = env.suggestions.findIndex((s) => s.action?.type === "drop_pin");
    assert.ok(idx >= 0 && pinIdx > idx, JSON.stringify(env.suggestions.map((s) => s.id)));
  });

  it("NO row on the empty sensitive field carries a coordinate", async () => {
    const env = await serve("hidden_gem_location", "", world());
    assert.ok(env.suggestions.length >= 2);
    for (const s of env.suggestions) assert.equal(carriesCoordinate(s), false, JSON.stringify(s));
  });

  it("a full page of nearby places never caps the two actions out", async () => {
    const db = world();
    for (let i = 0; i < 12; i++) {
      db.discovery_places.push(place(`cc000000-0000-4000-a000-0000000001${String(i).padStart(2, "0")}`, `Spot ${i}`, HERE.lat + 0.0005 * i, HERE.lng));
    }
    const env = await serve("hidden_gem_location", "", db);
    assert.equal(env.suggestions.length, 8, "the policy's maxSuggestions");
    assert.deepEqual(env.suggestions.slice(-2).map((s) => s.id), ["hidden_gem_location:zero:drop-pin", "hidden_gem_location:zero:create-hidden_gem"]);
  });

  it("with no position at all the two actions are still there (the field never depends on GPS)", async () => {
    const env = await serve("hidden_gem_location", "", world(), { extra: {} });
    assert.deepEqual(ids(env.suggestions), [], "no nearby place without a position");
    assert.deepEqual(env.suggestions.slice(-2).map((s) => s.id), ["hidden_gem_location:zero:drop-pin", "hidden_gem_location:zero:create-hidden_gem"]);
  });

  it("CONTROL — other location fields gain nothing at zero characters (place_picker allows actions, but is not a Gem field)", async () => {
    for (const ctx of ["place_picker", "event_location", "city_picker", "trip_destination"]) {
      const env = await serve(ctx, "", world());
      assert.equal(env.suggestions.some((s) => s.type === "action"), false, `${ctx}: ${JSON.stringify(env.suggestions)}`);
    }
  });

  it("CONTROL — a TYPED Gem location that matches keeps its own rows; the zero-state actions are not added to it", async () => {
    const env = await serve("hidden_gem_location", "Beach", world());
    assert.equal(env.suggestions.some((s) => typeof s.id === "string" && s.id.includes(":zero:")), false, JSON.stringify(env.suggestions));
  });
});

describe("G201 — the EMPTY global field offers the places the viewer's Trips contain", () => {
  it("the viewer's own Trip stop is offered as 'On your Trip'", async () => {
    const env = await serve("global_search", "", world());
    assert.deepEqual(ids(env.suggestions, "On your Trip"), [TRIP_PLACE]);
    assert.equal(env.refusal, undefined, JSON.stringify(env.refusal));
  });

  it("another member's PRIVATE plan item and a Trip the viewer is not on are never offered", async () => {
    const env = await serve("global_search", "", world());
    const all = env.suggestions.map((s) => s.entityId);
    assert.ok(!all.includes(MATE_PRIVATE));
    assert.ok(!all.includes(OTHER_TRIP_PLACE));
  });

  it("no accepted membership → no Trip stops", async () => {
    const db = world(); db.trip_members = db.trip_members.filter((m) => m.user_id !== ME);
    const env = await serve("global_search", "", db);
    assert.deepEqual(ids(env.suggestions, "On your Trip"), []);
  });

  for (const how of ["error", "throw"] as const) {
    it(`a failed plan read (${how}) is a partial refusal naming trip_places, never a clean "no Trip stops"`, async () => {
      const env = await serve("global_search", "", world(), how === "error" ? { failing: ["trip_plan_items"] } : { throwing: ["trip_plan_items"] });
      assert.equal(env.refusal?.coverage, "partial", JSON.stringify(env.refusal));
      assert.ok((env.refusal?.failedSources ?? []).includes("trip_places"), JSON.stringify(env.refusal));
    });
  }
});

describe("G179 — a TYPED place row says how it relates to the viewer", () => {
  const typed = async (text: string, db = world(), opts: { failing?: string[]; throwing?: string[] } = {}) =>
    (await serve("global_search", text, db, { ...opts, extra: {} })).suggestions;
  const rel = (rows: Wire[], id: string) => rows.find((s) => s.entityType === "place" && s.entityId === id);

  it("a place on the viewer's Trip plan says 'in_trip'", async () => {
    const row = rel(await typed("Marble"), TRIP_PLACE);
    assert.ok(row, "the place is served");
    assert.equal(row!.relationship, "in_trip");
  });

  it("a place the viewer SAVED says 'saved'", async () => {
    const db = world(); db.discovery_place_saves = [{ user_id: ME, place_id: FAR, saved_at: "2026-10-01T00:00:00.000Z" }];
    const row = rel(await typed("Hoi An Bakery", db), FAR);
    assert.ok(row);
    assert.equal(row!.relationship, "saved");
  });

  it("a place both on the Trip and saved says 'in_trip' (one label, the stronger claim)", async () => {
    const db = world(); db.discovery_place_saves = [{ user_id: ME, place_id: TRIP_PLACE, saved_at: "2026-10-01T00:00:00.000Z" }];
    assert.equal(rel(await typed("Marble", db), TRIP_PLACE)!.relationship, "in_trip");
  });

  it("CONTROL — a place that is neither says nothing", async () => {
    const row = rel(await typed("Hoi An Bakery"), FAR);
    assert.ok(row);
    assert.equal(row!.relationship, undefined);
  });

  it("CONTROL — in the Trip's CITY is not in the Trip: a Da Nang place off the plan says nothing", async () => {
    const row = rel(await typed("Market Noodles"), RECENT);
    assert.ok(row);
    assert.equal(row!.relationship, undefined);
  });

  it("another person's save, another member's PRIVATE plan item and a Trip the viewer is not on say nothing", async () => {
    const db = world(); db.discovery_place_saves = [{ user_id: MATE, place_id: FAR, saved_at: "2026-10-01T00:00:00.000Z" }];
    assert.equal(rel(await typed("Hoi An Bakery", db), FAR)!.relationship, undefined);
    assert.equal(rel(await typed("Secret Spot", db), MATE_PRIVATE)!.relationship, undefined);
    assert.equal(rel(await typed("Someone Else", db), OTHER_TRIP_PLACE)!.relationship, undefined);
  });

  for (const how of ["error", "throw"] as const) {
    it(`a failed read (${how}) labels nothing and keeps the row`, async () => {
      const db = world(); db.discovery_place_saves = [{ user_id: ME, place_id: FAR, saved_at: "2026-10-01T00:00:00.000Z" }];
      const k = how === "error" ? "failing" : "throwing";
      const tripRow = rel(await typed("Marble", db, { [k]: ["trip_plan_items"] }), TRIP_PLACE);
      assert.ok(tripRow); assert.equal(tripRow!.relationship, undefined);
      const savedRow = rel(await typed("Hoi An Bakery", db, { [k]: ["discovery_place_saves"] }), FAR);
      assert.ok(savedRow); assert.equal(savedRow!.relationship, undefined);
    });
  }

  it("CONTROL — a field without personalization (the Gem location) is never labelled", async () => {
    const env = await serve("hidden_gem_location", "Marble", world(), { extra: {} });
    for (const s of env.suggestions) assert.equal(s.relationship, undefined, JSON.stringify(s));
  });
});

describe("G90 — buildZeroStateLocationActions keeps the failed-match rows' own gates", () => {
  const gem = () => ({ ...resolvePolicy("hidden_gem_location")! });
  it("the add-new row needs the creatable entity in the policy's entityTypes (§37 'under policy')", () => {
    const p = gem(); p.entityTypes = (p.entityTypes ?? []).filter((t) => t !== "hidden_gem");
    assert.deepEqual(buildZeroStateLocationActions("hidden_gem_location", p, "v").map((s) => s.id), ["hidden_gem_location:zero:drop-pin"]);
  });
  it("no `action` rows allowed, or no zero state claimed → nothing", () => {
    const a = gem(); a.allowedSuggestionTypes = a.allowedSuggestionTypes.filter((t) => t !== "action");
    assert.deepEqual(buildZeroStateLocationActions("hidden_gem_location", a, "v"), []);
    const z = gem(); z.zeroStateAssistance = false;
    assert.deepEqual(buildZeroStateLocationActions("hidden_gem_location", z, "v"), []);
  });
  it("the registry's own Gem policy gives exactly the two rows", () => {
    assert.deepEqual(buildZeroStateLocationActions("hidden_gem_location", gem(), "v").map((s) => s.id), ["hidden_gem_location:zero:drop-pin", "hidden_gem_location:zero:create-hidden_gem"]);
  });
});
