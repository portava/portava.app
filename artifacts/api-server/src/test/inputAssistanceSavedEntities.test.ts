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
