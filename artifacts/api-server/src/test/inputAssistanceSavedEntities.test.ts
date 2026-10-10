/**
 * §35 Saved entities (census-input-intelligence §4, row G228; §14 G86/G89).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceSavedEntities.test.ts
 *
 * WHAT WAS MISSING
 * ----------------
 * G228 "Saved and Trip-related entities" was BUILT-BUT-WRONG because only half
 * of it read anything: Trip destinations fed the §14 zero-character list
 * (`geoResolver.zeroCharGeoDefaults`) and **no saved / bookmarked / wishlisted
 * source was read anywhere in `lib/inputAssistance/`**. A user who had
 * explicitly saved a place saw no trace of it in any picker.
 *
 * WHY THIS ARM MATTERS MORE THAN THE REST OF §35
 * ----------------------------------------------
 * Every other §35 path is built on `input_selection_history`, which migration
 * 2258 creates and which is **absent from production** — so those paths fail
 * soft to an empty memory for every real user. `discovery_place_saves` is a
 * table production HAS. This arm is the only part of §35 that is live there.
 *
 * EVERY TEST BELOW NAMES ITS MUTATION and each was applied and watched go RED
 * before being written down. The two controls (a user with no saves, and a
 * context whose policy may not surface a place) exist so the positive
 * assertions cannot pass for a reason that has nothing to do with saves.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import {
  buildSavedPlaceSuggestions,
  SAVED_PLACE_CONFIDENCE,
} from "../lib/inputAssistance/savedEntities.js";
import { POLICY_VERSION, resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const AUTHOR = "bb000000-0000-4000-a000-000000000002";
const ME_TOK = "tok-me";

const PLACE_A = "cc000000-0000-4000-a000-00000000000a";
const PLACE_B = "cc000000-0000-4000-a000-00000000000b";

// ── Fake Supabase client (same harness shape as inputAssistanceRankingSignals) ─
interface FakeState { [key: string]: any[] | undefined; }

function makeFakeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let _rangeStart = 0;
      let _rangeEnd = Infinity;
      let _limitN = Infinity;
      const builder: any = {
        select() { return builder; },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => r[col] !== val && r[col] != null);
          return builder;
        },
        is(col: string, val: any) {
          filters.push((r) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        ilike(col: string, pat: string) {
          const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
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
                const re = new RegExp("^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
                return re.test(cellStr);
              }
              if (op === "eq") return cellStr === val;
              return false;
            }),
          );
          return builder;
        },
        gte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] >= val); return builder; },
        lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
        order() { return builder; },
        limit(n: number) { _limitN = n; return builder; },
        range(start: number, end: number) { _rangeStart = start; _rangeEnd = end; return builder; },
        maybeSingle() {
          const matched = sourceRows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = sourceRows
            .filter((r) => filters.every((f) => f(r)))
            .slice(_rangeStart, _rangeEnd < Infinity ? _rangeEnd + 1 : _limitN < Infinity ? _limitN : undefined);
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

let base: string;
let server: Server;

function setup(state: FakeState) {
  _setTestClient(makeFakeClient(state) as any, true);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", inputAssistanceRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});
after(() => server.close());
beforeEach(() => { _resetRateLimit(); setup({}); });

function suggest(body: any) {
  return fetch(`${base}/input-assistance/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${ME_TOK}` },
    body: JSON.stringify(body),
  });
}

/** Saved-place world: one active saved place, no Trips, no blocks. */
function savedWorld(over: FakeState = {}): FakeState {
  return {
    discovery_place_saves: [
      { user_id: ME, place_id: PLACE_A, saved_at: "2026-09-01T00:00:00.000Z" },
    ],
    discovery_places: [
      { id: PLACE_A, name: "Mia Cantina", city: "Da Nang", primary_category: "restaurant",
        category: "food", submitted_by: AUTHOR, status: "active" },
    ],
    blocks: [],
    trip_members: [],
    trips: [],
    canonical_locations: [],
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. End-to-end — a saved place reaches the §14 zero-character list
// ═══════════════════════════════════════════════════════════════════════════════

describe("§35 saved entities (G228) end-to-end through POST /input-assistance/suggest", () => {
  it("offers the viewer's saved place before the first keystroke in place_picker", async () => {
    // MUTATION-PROOF: return [] unconditionally from buildSavedPlaceSuggestions,
    // or drop the `...saved` spread from the gateway's geo zero-character
    // branch. The saved row disappears and this goes RED.
    setup(savedWorld());
    const r = await suggest({ context: "place_picker", text: "" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const places = body.suggestions.filter((s: any) => s.entityType === "place");
    assert.equal(places.length, 1, "the saved place must be offered at zero characters");
    assert.equal(places[0].entityId, PLACE_A);
    assert.equal(places[0].reason, "Saved");
    assert.equal(places[0].source, "memory");
    assert.equal(places[0].policyVersion, POLICY_VERSION);
  });

  it("offers it in global_search too, whose policy also names `place`", async () => {
    setup(savedWorld());
    const r = await suggest({ context: "global_search", text: "" });
    const body = await r.json() as any;
    const places = body.suggestions.filter((s: any) => s.entityType === "place");
    assert.equal(places.length, 1);
    assert.equal(places[0].entityId, PLACE_A);
  });

  it("THE CONTROL — a viewer with no saves gets exactly the zero-state they got before", async () => {
    // Without this, the assertion above could pass for any reason that puts a
    // place row on the surface. With no save rows there must be NO place row.
    setup(savedWorld({ discovery_place_saves: [] }));
    const r = await suggest({ context: "place_picker", text: "" });
    const body = await r.json() as any;
    assert.equal(
      body.suggestions.filter((s: any) => s.entityType === "place").length, 0,
      "a user who saved nothing must see no saved row",
    );
  });

  it("THE POLICY CONTROL — city_picker may not surface a place, so a save reaches it with nothing", async () => {
    // city_picker's entityTypes are ['city','country']. The gate is the POLICY,
    // not a hard-coded context list, so this passes for the right reason.
    // MUTATION-PROOF: delete the `entityTypes.includes('place')` gate in
    // savedEntities.ts and a restaurant appears in a CITY picker. RED.
    setup(savedWorld());
    const r = await suggest({ context: "city_picker", text: "" });
    const body = await r.json() as any;
    assert.equal(
      body.suggestions.filter((s: any) => s.entityType === "place").length, 0,
      "a field that may not surface a place must not surface one because it was saved",
    );
  });

  it("withholds a save whose submitter the viewer is blocked with, in either direction", async () => {
    // MUTATION-PROOF: drop the `submitterIsVisible` filter in savedEntities.ts
    // and the blocked author's venue comes back. RED.
    setup(savedWorld({ blocks: [{ blocker_id: AUTHOR, blocked_id: ME }] }));
    const r = await suggest({ context: "place_picker", text: "" });
    const body = await r.json() as any;
    assert.equal(
      body.suggestions.filter((s: any) => s.entityId === PLACE_A).length, 0,
      "a blocked submitter's row must not re-enter through the saved list",
    );
  });

  it("never surfaces a place that is no longer active, and never renders one from the save row alone", async () => {
    // MUTATION-PROOF: drop `.eq('status','active')`, or project from the save
    // row when the place lookup misses, and a withdrawn venue reappears. RED.
    setup(savedWorld({
      discovery_places: [
        { id: PLACE_A, name: "Mia Cantina", city: "Da Nang", primary_category: "restaurant",
          category: "food", submitted_by: AUTHOR, status: "pending" },
      ],
    }));
    const r = await suggest({ context: "place_picker", text: "" });
    const body = await r.json() as any;
    assert.equal(body.suggestions.filter((s: any) => s.entityId === PLACE_A).length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. The builder itself — ordering, bounds, and the fail-closed block contract
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A stub whose `blocks` read FAILS. The route-level fake above can never
 * produce a read error, and "unreadable block list ⇒ serve nothing" is exactly
 * the case that cannot be asserted without one.
 */
function clientWithBlockFailure(state: FakeState) {
  const ok = makeFakeClient(state);
  return {
    ...ok,
    from: (table: string) => {
      if (table !== "blocks") return ok.from(table);
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        or: () => builder,
        then: (onF: any, onR: any) =>
          Promise.resolve({ data: null, error: { message: "blocks unreadable" } }).then(onF, onR),
      };
      return builder;
    },
  };
}

describe("§35 saved entities — the builder's own contract", () => {
  const policy = resolvePolicy("place_picker")!;

  it("orders newest save first, regardless of the order the driver returns", async () => {
    // MUTATION-PROOF: delete the `.sort(...)` on saved_at and the assertion
    // falls back to insertion order, which seeds the OLDER save first. RED.
    const db = makeFakeClient({
      discovery_place_saves: [
        { user_id: ME, place_id: PLACE_B, saved_at: "2026-01-01T00:00:00.000Z" },
        { user_id: ME, place_id: PLACE_A, saved_at: "2026-09-01T00:00:00.000Z" },
      ],
      discovery_places: [
        { id: PLACE_A, name: "Mia Cantina", city: "Da Nang", primary_category: "restaurant", category: null, submitted_by: null, status: "active" },
        { id: PLACE_B, name: "Old Quarter Bar", city: "Da Nang", primary_category: "bar", category: null, submitted_by: null, status: "active" },
      ],
      blocks: [],
    });
    const out = await buildSavedPlaceSuggestions(db as any, {
      userId: ME, context: "place_picker", policy, policyVersion: POLICY_VERSION, max: 8,
    });
    assert.deepEqual(out.map((s) => s.entityId), [PLACE_A, PLACE_B]);
    assert.equal(out[0]!.confidence, SAVED_PLACE_CONFIDENCE);
  });

  it("serves NOTHING when the block list cannot be read (fail-closed, per lib/blocks)", async () => {
    // MUTATION-PROOF: change `if (blocked === null) return []` to treat null as
    // an empty set and a blocked submitter's venue is served whenever the
    // blocks table is down. RED.
    const db = clientWithBlockFailure({
      discovery_place_saves: [{ user_id: ME, place_id: PLACE_A, saved_at: "2026-09-01T00:00:00.000Z" }],
      discovery_places: [
        { id: PLACE_A, name: "Mia Cantina", city: "Da Nang", primary_category: "restaurant", category: null, submitted_by: AUTHOR, status: "active" },
      ],
    });
    const out = await buildSavedPlaceSuggestions(db as any, {
      userId: ME, context: "place_picker", policy, policyVersion: POLICY_VERSION, max: 8,
    });
    assert.deepEqual(out, [], "uncertain block state must serve nobody, never everybody");
  });

  it("skips an entity the caller already has, so a save never duplicates a recent", async () => {
    const db = makeFakeClient({
      discovery_place_saves: [{ user_id: ME, place_id: PLACE_A, saved_at: "2026-09-01T00:00:00.000Z" }],
      discovery_places: [
        { id: PLACE_A, name: "Mia Cantina", city: "Da Nang", primary_category: "restaurant", category: null, submitted_by: null, status: "active" },
      ],
      blocks: [],
    });
    const out = await buildSavedPlaceSuggestions(db as any, {
      userId: ME, context: "place_picker", policy, policyVersion: POLICY_VERSION, max: 8,
      existingEntityIds: new Set([PLACE_A]),
    });
    assert.deepEqual(out, []);
  });

  it("refuses a context whose policy disallows personalization", async () => {
    const gemPolicy = resolvePolicy("hidden_gem_location")!;
    assert.notEqual(gemPolicy.allowPersonalization, true, "the premise of this test");
    const db = makeFakeClient({
      discovery_place_saves: [{ user_id: ME, place_id: PLACE_A, saved_at: "2026-09-01T00:00:00.000Z" }],
      discovery_places: [
        { id: PLACE_A, name: "Mia Cantina", city: "Da Nang", primary_category: "restaurant", category: null, submitted_by: null, status: "active" },
      ],
      blocks: [],
    });
    const out = await buildSavedPlaceSuggestions(db as any, {
      userId: ME, context: "hidden_gem_location", policy: gemPolicy, policyVersion: POLICY_VERSION, max: 8,
    });
    assert.deepEqual(out, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY-D2d F1 — a failed saved-lane READ is a partial refusal, never "no saves"
//
// The empty-field saved lane caught every failure into `[]` and noted nothing, so
// the serve read as a clean empty answer and the client (G200) replaced its
// retained offline copy with nothing: a transient read failure became a WRITE.
// The lane now tells the gateway's coverage, and the answer carries the partial
// refusal the client already refuses to retain on.
//
// MUTATION-PROOF: drop `onUnreadable` from either gateway call, or any of the four
// `opts.onUnreadable?.()` calls in savedEntities.ts → the matching case is RED.
// ═══════════════════════════════════════════════════════════════════════════════

function clientWithTableFailure(state: FakeState, failing: string) {
  const ok = makeFakeClient(state);
  return {
    ...ok,
    from: (table: string) => {
      if (table !== failing) return ok.from(table);
      const builder: any = {};
      for (const fn of ["select", "eq", "neq", "in", "or", "order", "limit", "is", "not", "gte", "lt", "ilike", "range"]) builder[fn] = () => builder;
      builder.maybeSingle = () => Promise.resolve({ data: null, error: { message: `${failing} unreadable` } });
      builder.then = (onF: any, onR: any) =>
        Promise.resolve({ data: null, error: { message: `${failing} unreadable` } }).then(onF, onR);
      return builder;
    },
  };
}

describe("VERIFY-D2d F1 — a saved-lane read failure is marked, so the client keeps its copy", () => {
  for (const context of ["global_search", "place_picker"]) {
    for (const failing of ["discovery_place_saves", "discovery_places", "blocks"]) {
      it(`${context}: ${failing} unreadable → a partial refusal naming 'saved_places', not a clean empty answer`, async () => {
        _setTestClient(clientWithTableFailure(savedWorld(), failing) as any, true);
        const body = (await (await suggest({ context, text: "" })).json()) as any;
        assert.equal(body.suggestions.filter((s: any) => s.entityType === "place").length, 0);
        assert.ok(body.refusal, `${failing}: the answer must say it could not read the saved lane`);
        assert.equal(body.refusal.coverage, "partial");
        assert.ok((body.refusal.failedSources ?? []).includes("saved_places"), JSON.stringify(body.refusal));
      });
    }
  }

  it("CONTROL: a healthy saved lane serves the save and carries no refusal", async () => {
    setup(savedWorld());
    const body = (await (await suggest({ context: "global_search", text: "" })).json()) as any;
    assert.equal(body.suggestions.filter((s: any) => s.entityType === "place").length, 1);
    assert.equal(body.refusal, undefined);
  });

  it("CONTROL: a viewer with no saves is a clean empty answer (nothing failed)", async () => {
    setup(savedWorld({ discovery_place_saves: [] }));
    const body = (await (await suggest({ context: "global_search", text: "" })).json()) as any;
    assert.equal(body.refusal, undefined);
  });

  it("the builder reports each failure through onUnreadable, and only failures", async () => {
    const policy = resolvePolicy("place_picker")!;
    for (const failing of ["discovery_place_saves", "discovery_places", "blocks"]) {
      let told = 0;
      const out = await buildSavedPlaceSuggestions(clientWithTableFailure(savedWorld(), failing) as any, {
        userId: ME, context: "place_picker", policy, policyVersion: POLICY_VERSION, max: 8, onUnreadable: () => { told++; },
      });
      assert.deepEqual(out, [], failing);
      assert.equal(told, 1, failing);
    }
    let told = 0;
    await buildSavedPlaceSuggestions(makeFakeClient(savedWorld({ discovery_place_saves: [] })) as any, {
      userId: ME, context: "place_picker", policy, policyVersion: POLICY_VERSION, max: 8, onUnreadable: () => { told++; },
    });
    assert.equal(told, 0, "no saves is not a failure");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY-D2e F5 — the Trip and recents lanes beside the saved lane
//
// D2d-F1 marked the saved lane only. The Trip-destination lane in the same two
// gateway blocks (`zeroCharGeoDefaults`) and the recents lane
// (`fetchSelectionMemory` + `buildSelectionRecents`) still turned a failed read
// into a clean empty answer, and the client then replaced its retained copy of
// "Your Trips" with nothing — a failed READ became a WRITE. Each lane now tells
// the coverage sink, so the answer carries a partial refusal naming it.
//
// MUTATION-PROOF (each alone, restored):
//   T1 geoResolver: drop the `memErr` report        → trip_members cases RED
//   T2 geoResolver: drop the `tripsErr` report      → trips cases RED
//   T3 gateway: drop the zero-state `onUnreadable`  → every Trip case RED
//   T4 personalization: drop the memory-read report → input_selection_history cases RED
//   T5 personalization: drop the canonical-rows report → canonical_locations recents case RED
//   T6 gateway: drop `if (memoryUnreadable) …` (geo block) → trip_destination recents case RED
//   T7 gateway: drop `if (memoryUnreadable) …` (non-geo block) → global_search recents case RED
// The client half (an outage answer never SHOWN as an empty list) is pinned in
// smartInputOfflineZeroState.component.test.tsx ("F5: …").
// ═══════════════════════════════════════════════════════════════════════════════

import { zeroCharGeoDefaults } from "../lib/inputAssistance/geoResolver.js";

const TRIP_1 = "dd000000-0000-4000-a000-000000000001";
const CANON_HUE = "ee000000-0000-4000-a000-000000000001";

/** One upcoming Trip to Hoi An, and one remembered pick of Hue — the viewer's own rows. */
function tripWorld(over: FakeState = {}): FakeState {
  return savedWorld({
    discovery_place_saves: [],
    trip_members: [{ user_id: ME, trip_id: TRIP_1, role: "owner" }],
    trips: [{
      id: TRIP_1, destination_city: "Hoi An", destination_country: "Vietnam",
      destination_lat: 15.8801, destination_lng: 108.338, status: "upcoming", start_date: "2026-11-01",
    }],
    input_selection_history: [{
      user_id: ME, context: "trip_destination", entity_type: "city", entity_id: CANON_HUE,
      query_key: "hue", label: "Hue", selection_count: 2, last_selected_at: "2026-09-30T00:00:00.000Z",
    }, {
      user_id: ME, context: "global_search", entity_type: "city", entity_id: CANON_HUE,
      query_key: "hue", label: "Hue", selection_count: 2, last_selected_at: "2026-09-30T00:00:00.000Z",
    }],
    canonical_locations: [{
      id: CANON_HUE, kind: "city", name: "Hue", normalized_name: "hue", search_key: "hue",
      display_name: "Hue, Vietnam", city: null, region: null, country: "Vietnam", country_code: "VN",
      postal_code: null, lat: 16.4637, lng: 107.5909, provider_ids: {}, aliases: [],
    }],
    ...over,
  });
}

describe("VERIFY-D2e F5 — a failed Trip or recents read is a partial refusal, never a clean empty answer", () => {
  it("CONTROL: a healthy world serves the upcoming Trip and the remembered pick, with no refusal", async () => {
    setup(tripWorld());
    const body = (await (await suggest({ context: "trip_destination", text: "" })).json()) as any;
    const reasons = body.suggestions.map((s: any) => s.reason);
    assert.ok(reasons.includes("Upcoming Trip"), JSON.stringify(reasons));
    assert.ok(reasons.includes("Recently selected"), JSON.stringify(reasons));
    assert.equal(body.refusal, undefined);
  });

  it("CONTROL: a viewer with no Trips and no picks is a clean empty answer (nothing failed)", async () => {
    setup(tripWorld({ trip_members: [], trips: [], input_selection_history: [] }));
    const body = (await (await suggest({ context: "trip_destination", text: "" })).json()) as any;
    assert.equal(body.refusal, undefined);
  });

  for (const context of ["trip_destination", "city_picker", "place_picker"]) {
    for (const failing of ["trip_members", "trips"]) {
      it(`${context}: ${failing} unreadable → a partial refusal naming 'trip_zero_state', and no Trip row`, async () => {
        _setTestClient(clientWithTableFailure(tripWorld(), failing) as any, true);
        const body = (await (await suggest({ context, text: "" })).json()) as any;
        assert.ok(!body.suggestions.some((s: any) => /Trip$/.test(s.reason ?? "")), JSON.stringify(body.suggestions));
        assert.ok(body.refusal, `${failing}: the answer must say it could not read the Trip lane`);
        assert.equal(body.refusal.coverage, "partial");
        assert.ok((body.refusal.failedSources ?? []).includes("trip_zero_state"), JSON.stringify(body.refusal));
      });
    }
  }

  for (const failing of ["input_selection_history", "canonical_locations"]) {
    it(`trip_destination: ${failing} unreadable → a partial refusal naming 'recent_selections'; the Trip row still served`, async () => {
      _setTestClient(clientWithTableFailure(tripWorld(), failing) as any, true);
      const body = (await (await suggest({ context: "trip_destination", text: "" })).json()) as any;
      assert.ok(!body.suggestions.some((s: any) => s.reason === "Recently selected"));
      assert.ok(body.suggestions.some((s: any) => s.reason === "Upcoming Trip"), "the readable lane still answers");
      assert.ok(body.refusal, `${failing}: the answer must say it could not read the recents lane`);
      assert.equal(body.refusal.coverage, "partial");
      assert.ok((body.refusal.failedSources ?? []).includes("recent_selections"), JSON.stringify(body.refusal));
    });
  }

  it("global_search: an unreadable selection memory is a partial refusal naming 'recent_selections'", async () => {
    _setTestClient(clientWithTableFailure(tripWorld(), "input_selection_history") as any, true);
    const body = (await (await suggest({ context: "global_search", text: "" })).json()) as any;
    assert.ok(body.refusal, JSON.stringify(body));
    assert.ok((body.refusal.failedSources ?? []).includes("recent_selections"), JSON.stringify(body.refusal));
  });

  it("a TYPED serve is not marked by a memory outage (only the empty field's lanes are)", async () => {
    _setTestClient(clientWithTableFailure(tripWorld(), "input_selection_history") as any, true);
    const body = (await (await suggest({ context: "trip_destination", text: "Hue" })).json()) as any;
    assert.ok(!(body.refusal?.failedSources ?? []).includes("recent_selections"), JSON.stringify(body.refusal));
  });

  it("zeroCharGeoDefaults reports each failure through onUnreadable, and only failures", async () => {
    for (const failing of ["trip_members", "trips"]) {
      const told: string[] = [];
      const out = await zeroCharGeoDefaults(clientWithTableFailure(tripWorld(), failing) as any, {
        userId: ME, city: null, onUnreadable: (lane) => { told.push(lane); },
      });
      assert.deepEqual(out, [], failing);
      assert.deepEqual(told, ["trips"], failing);
    }
    const told: string[] = [];
    const none = await zeroCharGeoDefaults(makeFakeClient(tripWorld({ trip_members: [] })) as any, {
      userId: ME, city: null, onUnreadable: (lane) => { told.push(lane); },
    });
    assert.deepEqual(none, []);
    assert.deepEqual(told, [], "no Trips is not a failure");
    const toldOk: string[] = []; const ok = await zeroCharGeoDefaults(makeFakeClient(tripWorld()) as any, {
      userId: ME, city: null, onUnreadable: (lane) => { toldOk.push(lane); },
    });
    assert.equal(ok.length, 1);
    assert.deepEqual(toldOk, [], "a healthy read tells nothing");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// V-D2f F-E — the THROWN-read direction of the F5 lanes
//
// `clientWithTableFailure` answers `{ error }`; a network failure instead REJECTS,
// and lands in each lane's `catch`. These cases reject, so the catch paths are
// proven too.
// MUTATION-PROOF (each alone, restored):
//   E1 geoResolver zeroCharGeoDefaults: the Trip block's catch silent again → trip_members case RED
//   E2 personalization fetchCanonicalRowsByIds: catch silent again          → canonical_locations case RED
//   E3 personalization fetchSelectionMemory: catch silent again             → input_selection_history case RED
// The gateway's own `.catch(() => { noteTypeUnreadable(…) })` around
// zeroCharGeoDefaults is a belt: the lane catches every throw itself and never
// rejects, so that belt has no reachable input and is not claimed as proven.
// ═══════════════════════════════════════════════════════════════════════════════

function clientWithTableThrow(state: FakeState, failing: string) {
  const ok = makeFakeClient(state);
  return {
    ...ok,
    from: (table: string) => {
      if (table !== failing) return ok.from(table);
      const builder: any = {};
      for (const fn of ["select", "eq", "neq", "in", "or", "order", "limit", "is", "not", "gte", "lt", "ilike", "range"]) builder[fn] = () => builder;
      builder.maybeSingle = () => Promise.reject(new Error(`${failing}: socket hang up`));
      builder.then = (onF: any, onR: any) => Promise.reject(new Error(`${failing}: socket hang up`)).then(onF, onR);
      return builder;
    },
  };
}

describe("V-D2f F-E — a THROWN Trip or recents read is a partial refusal too", () => {
  it("zeroCharGeoDefaults: a rejecting trip_members read reports 'trips'", async () => {
    const told: string[] = [];
    const out = await zeroCharGeoDefaults(clientWithTableThrow(tripWorld(), "trip_members") as any, {
      userId: ME, city: null, onUnreadable: (lane) => { told.push(lane); },
    });
    assert.deepEqual(out, []);
    assert.deepEqual(told, ["trips"]);
  });

  it("trip_destination: a rejecting trip_members read → a partial refusal naming 'trip_zero_state'", async () => {
    _setTestClient(clientWithTableThrow(tripWorld(), "trip_members") as any, true);
    const body = (await (await suggest({ context: "trip_destination", text: "" })).json()) as any;
    assert.ok(!body.suggestions.some((s: any) => /Trip$/.test(s.reason ?? "")), JSON.stringify(body.suggestions));
    assert.ok((body.refusal?.failedSources ?? []).includes("trip_zero_state"), JSON.stringify(body.refusal));
  });

  for (const failing of ["input_selection_history", "canonical_locations"]) {
    it(`trip_destination: a rejecting ${failing} read → a partial refusal naming 'recent_selections'; the Trip row still served`, async () => {
      _setTestClient(clientWithTableThrow(tripWorld(), failing) as any, true);
      const body = (await (await suggest({ context: "trip_destination", text: "" })).json()) as any;
      assert.ok(body.suggestions.some((s: any) => s.reason === "Upcoming Trip"), JSON.stringify(body.suggestions));
      assert.ok((body.refusal?.failedSources ?? []).includes("recent_selections"), JSON.stringify(body.refusal));
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// V-ZS — a zero-state failure lane never shares a dispatched search type's name
//
// `gatewayCoverageRefusal` reads "every DISPATCHED type unreadable" as coverage
// "nothing". The F5 lanes were named `trips` / `cities` / `recents` / `saved`, and
// `trips`, `cities` and `saved` are search types: under a policy that dispatches
// only `trips` (or only `cities`), a failed Trip (or current-city) ZERO-STATE read
// was counted as the dispatched type failing, and the refusal said "nothing"
// although nothing typed was ever looked up. The lanes are now `zeroStateLanes.ts`.
// MUTATION-PROOF (each alone, restored):
//   Z1 ZERO_STATE_LANE.trips back to 'trips'        → trips-only case + static guard RED
//   Z2 ZERO_STATE_LANE.currentCity back to 'cities' → cities-only case + static guard RED
//   Z3 ZERO_STATE_LANE.saved back to 'saved'        → static guard RED
//   Z4 ZERO_STATE_PLACE_LANES 'trip_places' → 'trips' → static guard RED (lane R's names are guarded too)
// ═══════════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { generateSuggestionsWithCoverage, gatewayCoverageRefusal, newGatewayCoverage } from "../lib/inputAssistance/gateway.js";
import { ZERO_STATE_LANE, ZERO_STATE_LANES } from "../lib/inputAssistance/zeroStateLanes.js";

describe("V-ZS — zero-state failure lanes are not dispatched search types", () => {
  const onlyTypes = (entityTypes: string[]) => ({ ...resolvePolicy("trip_destination")!, entityTypes } as any);

  it("PREMISE: a failure named after the ONLY dispatched type reads as 'nothing'", () => {
    const c = newGatewayCoverage();
    c.unreadableTypes.add("trips");
    assert.equal(gatewayCoverageRefusal(c, ["trips"])?.coverage, "nothing");
  });

  it("trips-only policy: a failed Trip zero-state read is coverage 'partial', naming the zero-state lane", async () => {
    const serve = await generateSuggestionsWithCoverage(clientWithTableFailure(tripWorld(), "trip_members") as any, {
      context: "trip_destination", policy: onlyTypes(["trip"]), text: "", userId: ME, limit: 8,
    } as any);
    assert.ok(serve.refusal, "the failure must be reported");
    assert.equal(serve.refusal!.coverage, "partial", JSON.stringify(serve.refusal));
    assert.ok((serve.refusal!.failedSources ?? []).includes(ZERO_STATE_LANE.trips), JSON.stringify(serve.refusal));
  });

  it("cities-only policy: a failed current-city zero-state read is coverage 'partial', naming the zero-state lane", async () => {
    const serve = await generateSuggestionsWithCoverage(clientWithTableThrow(tripWorld(), "canonical_locations") as any, {
      context: "trip_destination", policy: onlyTypes(["city"]), text: "", userId: ME, limit: 8, city: "Hue",
    } as any);
    assert.ok(serve.refusal, "the failure must be reported");
    assert.equal(serve.refusal!.coverage, "partial", JSON.stringify(serve.refusal));
    assert.ok((serve.refusal!.failedSources ?? []).includes(ZERO_STATE_LANE.currentCity), JSON.stringify(serve.refusal));
  });

  it("STATIC: no zero-state failure lane equals a DispatchSearchType or a SEARCH_TYPES value", () => {
    const src = (f: string) => readFileSync(new URL(`../lib/inputAssistance/${f}`, import.meta.url), "utf8");
    const union = /export type DispatchSearchType =([^;]+);/.exec(src("entityMap.ts"))![1]!;
    const dispatch = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    const list = /const SEARCH_TYPES = \[([\s\S]*?)\] as const;/.exec(src("searchCandidates.ts"))![1]!;
    const searchTypes = [...list.replace(/\/\/.*$/gm, "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    assert.ok(dispatch.includes("trips") && searchTypes.includes("saved"), "premise: the parsers read both lists");
    // Both families: the gateway's own four and lane R's four place arms (zeroStatePlaces.ts).
    assert.deepEqual([...ZERO_STATE_LANES].sort(), ["current_city_zero_state", "current_trip", "nearby_places", "recent_places", "recent_selections", "saved_places", "trip_places", "trip_zero_state"]);
    for (const lane of ZERO_STATE_LANES) {
      assert.ok(!dispatch.includes(lane), `${lane} is a DispatchSearchType`);
      assert.ok(!searchTypes.includes(lane), `${lane} is a SEARCH_TYPES value`);
    }
    // And the gateway's zero-state blocks name their lanes only through the constant.
    assert.doesNotMatch(src("gateway.ts"), /noteTypeUnreadable\(coverage, '(?:trips|recents|saved)'\)/);
  });
});
