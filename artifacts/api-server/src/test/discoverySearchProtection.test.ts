/**
 * discoverySearchProtection — census-discovery B04 (§46): Map spec §24's
 * protected-place gate on the search serve points, through the search adapter
 * over lib/protectedLocations.
 *
 * PURE (A-series): `applySearchProtection` over literal zones and rows.
 * ROUTE (R-series): GET /discovery/search and GET /discovery/suggest through the
 * PostgREST-shaped kit, with `protected_zones` and `feature_flags` as tables.
 *
 * The three cases the flag ON must distinguish, and that each series pins:
 *   zones READ, none registered   — byte-identical to the flag OFF (production:
 *                                   2217 applied, 0 rows, integrator-read 2026-09-27);
 *   zones READ, some registered   — allow / coarsen / suppress, per the contract;
 *   zones UNREADABLE              — positions withheld, rows kept, never empty;
 * plus the partial failures between them (a malformed zone row, a read that
 * rejects, a flag that cannot be read) and the retry after a failed read.
 *
 * Run: node --import tsx/esm --test src/test/discoverySearchProtection.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import discoverySearchRouter from "../routes/discoverySearch.js";
import { invalidateBuddyLaunchGateCache } from "../routes/discoverySearch.js";
import {
  DISCOVERY_SEARCH_PROTECTION_FLAG,
  applySearchProtection,
  invalidateSearchProtectionFlagCache,
  mapKindForSearchType,
  protectSearchResults,
  type ProtectableSearchRow,
} from "../lib/discoverySearchProtection.js";
import { clearProtectedZoneCache } from "../lib/protectedZoneStore.js";
import type { ProtectedZone } from "../lib/protectedLocations.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import { VIEWER, installKit, kitGet, sansExposure, startKitServer, type KitState } from "./discoverySearchTestKit.js";

// ── Geometry: a shelter, a clinic, and places inside and outside them ────────
const SHELTER_C = { lat: 38.7200, lng: -9.1300 };
const CLINIC_C = { lat: 38.7400, lng: -9.1500 };
const INSIDE_SHELTER = { lat: 38.72005, lng: -9.13005 }; // ~7 m from the shelter centre
const INSIDE_CLINIC = { lat: 38.74003, lng: -9.15002 };
const OUTSIDE = { lat: 38.7600, lng: -9.2000 };

const shelter: ProtectedZone = { id: "z-shelter", category: "shelter", shape: "circle", center: SHELTER_C, radiusMeters: 60 };
const clinic: ProtectedZone = { id: "z-clinic", category: "medical_facility", shape: "circle", center: CLINIC_C, radiusMeters: 80 };
const malformed: ProtectedZone = { id: "z-broken", category: "shelter", shape: "circle", center: SHELTER_C, radiusMeters: 0 };

/** The contract normalises longitude through modular arithmetic, so an anchor is equal to ~1e-12, not bit-for-bit. */
function assertNear(actual: unknown, expected: number, msg?: string): void {
  assert.equal(typeof actual, "number", msg ?? `expected a number near ${expected}, got ${String(actual)}`);
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, msg ?? `${String(actual)} is not ${expected}`);
}

function row(id: string, type: string, pos: { lat: number | null; lng: number | null } | null, extra: Record<string, unknown> = {}): ProtectableSearchRow {
  return { id, type, title: `zork ${id}`, metadata: pos === null ? null : { category: "food", lat: pos.lat, lng: pos.lng, ...extra } };
}

// ═════════════════════════════════════════════════════════════════════════════
// A. The pure pass
// ═════════════════════════════════════════════════════════════════════════════

describe("A — applySearchProtection (pure)", () => {
  it("A0 — the probe kinds carry no escalation or exemption the category would not already apply", () => {
    assert.equal(mapKindForSearchType("places"), "place");
    assert.equal(mapKindForSearchType("activities"), "place");
    assert.equal(mapKindForSearchType("cities"), "place");
    assert.equal(mapKindForSearchType("countries"), "place");
    assert.equal(mapKindForSearchType("events"), "event");
    assert.equal(mapKindForSearchType("hidden_gems"), "hidden_gem");
    assert.equal(mapKindForSearchType("saved"), "saved_place");
  });

  it("A1 — zones read and NONE registered: the same array comes back (identity, not a copy)", () => {
    const rows = [row("p1", "places", INSIDE_SHELTER), row("t1", "travelers", null)];
    const out = applySearchProtection(rows, []);
    assert.equal(out.results, rows, "zero zones must be an identity pass by reference");
    assert.equal(out.report.policy, "read");
  });

  it("A2 — zones UNREADABLE: every position is withheld, every row is kept, unpositioned rows are the same objects", () => {
    const p = row("p1", "places", OUTSIDE);
    const g = row("g1", "hidden_gems", INSIDE_CLINIC, { coordsPrecision: "approximate" });
    const t = row("t1", "travelers", null);
    const unplaced = row("c1", "cities", { lat: null, lng: null });
    const before = JSON.stringify([p, g, t, unplaced]);
    const out = applySearchProtection([p, g, t, unplaced], null);
    assert.equal(out.results.length, 4, "an unreadable policy must never empty the search");
    assert.deepEqual(out.results.map((r) => r.id), ["p1", "g1", "t1", "c1"]);
    for (const r of out.results.slice(0, 2)) {
      assert.equal(r.metadata!.lat, null);
      assert.equal(r.metadata!.lng, null);
      assert.equal(r.metadata!.coordsPrecision, "hidden");
      assert.equal(r.metadata!.category, "food", "only the protected fields change");
    }
    assert.equal(out.results[2], t);
    assert.equal(out.results[3], unplaced, "a row that already carries no position is untouched");
    assert.equal(JSON.stringify([p, g, t, unplaced]), before, "the input was mutated");
    assert.equal(out.report.withheld, 2);
    assert.equal(out.report.policy, "unreadable");
  });

  it("A3 — a SUPPRESS-class zone: the row inside it is not served; the row outside is the same object", () => {
    const inside = row("p-in", "places", INSIDE_SHELTER);
    const outside = row("p-out", "places", OUTSIDE);
    const out = applySearchProtection([inside, outside], [shelter]);
    assert.deepEqual(out.results.map((r) => r.id), ["p-out"]);
    assert.equal(out.results[0], outside);
    assert.equal(out.report.suppressed, 1);
  });

  it("A4 — a COARSEN-class zone: the position is snapped to the zone anchor and marked approximate; nothing else changes", () => {
    const inside = row("p-clinic", "places", INSIDE_CLINIC, { headerImageSource: "x" });
    const out = applySearchProtection([inside], [clinic]);
    assert.equal(out.results.length, 1);
    const m = out.results[0]!.metadata!;
    assertNear(m.lat, CLINIC_C.lat);
    assertNear(m.lng, CLINIC_C.lng);
    assert.equal(m.coordsPrecision, "approximate");
    assert.equal(m.headerImageSource, "x");
    assert.notEqual(m.lat, INSIDE_CLINIC.lat, "the precise point must not survive");
  });

  it("A5 — a zone row whose geometry cannot be parsed suppresses every POSITIONED row (the contract's rule 2); unpositioned rows survive", () => {
    const out = applySearchProtection(
      [row("p1", "places", OUTSIDE), row("e1", "events", OUTSIDE), row("t1", "travelers", null)],
      [malformed],
    );
    assert.deepEqual(out.results.map((r) => r.id), ["t1"]);
  });

  it("A6 — a position that is not a coordinate is suppressed when zones exist, and untouched when none do", () => {
    const bad = row("p-bad", "places", { lat: 95, lng: 10 });
    assert.deepEqual(applySearchProtection([bad], [shelter]).results, []);
    assert.deepEqual(applySearchProtection([bad], []).results, [bad]);
  });

  it("A7 — policy_defined coarsen with a floor of 'none' is suppressed (the servable backstop), not emitted precise", () => {
    const z: ProtectedZone = { id: "z-pol", category: "policy_defined", action: "coarsen", privacyFloor: "none", shape: "circle", center: CLINIC_C, radiusMeters: 80 };
    assert.deepEqual(applySearchProtection([row("p", "places", INSIDE_CLINIC)], [z]).results, []);
  });

  it("A8 — an unknown category is the strongest action, not the weakest", () => {
    const z = { id: "z-new", category: "embassy_2031", shape: "circle", center: SHELTER_C, radiusMeters: 60 } as ProtectedZone;
    assert.deepEqual(applySearchProtection([row("p", "places", INSIDE_SHELTER)], [z]).results, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R. The serve points
// ═════════════════════════════════════════════════════════════════════════════

const P_SHELTER = "place-shelter";
const P_CLINIC = "place-clinic";
const P_OUT = "place-out";
const T_ALICE = "b1000000-0000-4000-a000-000000000001";

function world(flag: boolean | "error" | undefined, zones: any[] | "error" | "throw" | "absent"): Partial<KitState> {
  const place = (id: string, p: { lat: number; lng: number }) => ({
    id, name: `zork ${id}`, city: "Lisbon", blurb: null, image_url: null, header_image_source: null,
    image_source_type: null, image_accuracy_status: null, category: "food", primary_category: "food",
    lat: p.lat, lng: p.lng, canonical_location_id: null, created_at: "2026-01-01T00:00:00Z",
    submitted_by: null, status: "active", saved_count: 0,
  });
  const state: Partial<KitState> = {
    rows: {
      profiles: [
        { id: VIEWER, handle: "viewer", name: "Viewer", account_status: "active", is_private: false },
        { id: T_ALICE, handle: "zork_alice", username: "zork_alice", name: "Zork Alice", display_name: null,
          avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active",
          verified: false, is_official: false, show_profile_picture_publicly: true },
      ],
      blocks: [], user_privacy_settings: [], profile_privacy_settings: [], user_follows: [], friend_requests: [],
      user_friendships: [], event_rsvps: [], events: [], trips: [], trip_plan_items: [], hidden_gems: [], posts: [],
      circles: [], hashtags: [], stamp_definitions: [], canonical_locations: [],
      discovery_places: [place(P_SHELTER, INSIDE_SHELTER), place(P_CLINIC, INSIDE_CLINIC), place(P_OUT, OUTSIDE)],
      ...(Array.isArray(zones) ? { protected_zones: zones } : {}),
    },
    flags: flag === undefined ? {} : { [DISCOVERY_SEARCH_PROTECTION_FLAG]: flag },
  };
  if (zones === "error") state.errorTables = { protected_zones: { code: "57014", message: "canceling statement due to statement timeout" } };
  if (zones === "absent") state.errorTables = { protected_zones: { code: "42P01", message: 'relation "public.protected_zones" does not exist' } };
  if (zones === "throw") state.throwTables = new Set(["protected_zones"]);
  return state;
}

const zoneRow = (z: { id: string; category: string; lat: number; lng: number; r: number }) => ({
  id: z.id, category: z.category, action: null, privacy_floor: null, shape: "circle",
  center_lat: z.lat, center_lng: z.lng, radius_meters: z.r, ring: null, jurisdiction: null, policy_ref: null, active: true,
});
const SHELTER_ROW = zoneRow({ id: "z-shelter", category: "shelter", lat: SHELTER_C.lat, lng: SHELTER_C.lng, r: 60 });
const CLINIC_ROW = zoneRow({ id: "z-clinic", category: "medical_facility", lat: CLINIC_C.lat, lng: CLINIC_C.lng, r: 80 });

let base = "";
let server: Server;
before(async () => { ({ base, server } = await startKitServer(discoverySearchRouter)); });
after(() => server.close());
beforeEach(() => {
  clearProtectedZoneCache();
  invalidateSearchProtectionFlagCache();
  invalidateBuddyLaunchGateCache();
  invalidateDiscoveryTripProjectionFlagCache();
});

async function places(path = "/discovery/search?q=zork&type=places&limit=20") {
  return kitGet(base, path);
}
const byId = (body: any) => new Map<string, any>(((body?.results ?? []) as any[]).map((r) => [r.id, r]));

describe("R — the flag OFF is the tree before this pass", () => {
  for (const flag of [undefined, false, "error"] as const) {
    it(`R1 — flag ${flag === undefined ? "ABSENT" : flag === "error" ? "UNREADABLE" : "FALSE"}: the shelter place is served at full precision and protected_zones is never read`, async () => {
      const { calls } = installKit(world(flag, [SHELTER_ROW]));
      const { status, body } = await places();
      assert.equal(status, 200);
      const p = byId(body).get(P_SHELTER);
      assert.ok(p, "flag OFF must not suppress anything");
      assert.equal(p.metadata.lat, INSIDE_SHELTER.lat);
      assert.equal(p.metadata.coordsPrecision, undefined, "flag OFF adds no key");
      assert.equal(calls.tables.filter((t) => t === "protected_zones").length, 0, "flag OFF read the policy table");
    });
  }
});

describe("R — flag ON, zones read and NONE registered (production's state): byte-identical to OFF", () => {
  it("R2 — /discovery/search type=places, type=all and /discovery/suggest", async () => {
    for (const path of ["/discovery/search?q=zork&type=places&limit=20", "/discovery/search?q=zork&type=all&limit=20", "/discovery/suggest?q=zork"]) {
      clearProtectedZoneCache(); invalidateSearchProtectionFlagCache();
      installKit(world(false, []));
      const off = await kitGet(base, path);
      clearProtectedZoneCache(); invalidateSearchProtectionFlagCache();
      const { calls } = installKit(world(true, []));
      const on = await kitGet(base, path);
      assert.equal(calls.tables.filter((t) => t === "protected_zones").length, 1, `${path}: the ON path must actually read the policy`);
      const strip = (b: any) => JSON.stringify(b.results ? { ...b, results: sansExposure(b.results) }
        : { ...b, groups: (b.groups as any[]).map((g) => ({ ...g, items: sansExposure(g.items) })) });
      assert.equal(strip(on.body), strip(off.body), `${path}: zero zones changed the served body`);
    }
  });
});

describe("R — flag ON, zones registered", () => {
  it("R3 — a shelter's place is not served; a clinic's is snapped to the clinic's anchor; the rest are untouched", async () => {
    installKit(world(true, [SHELTER_ROW, CLINIC_ROW]));
    const { status, body } = await places();
    assert.equal(status, 200);
    const m = byId(body);
    assert.equal(m.has(P_SHELTER), false, "a place inside a shelter zone reached the client");
    assertNear(m.get(P_CLINIC).metadata.lat, CLINIC_C.lat);
    assertNear(m.get(P_CLINIC).metadata.lng, CLINIC_C.lng);
    assert.equal(m.get(P_CLINIC).metadata.coordsPrecision, "approximate");
    assert.equal(m.get(P_OUT).metadata.lat, OUTSIDE.lat);
    assert.equal(m.get(P_OUT).metadata.coordsPrecision, undefined);
  });

  it("R4 — type=all and /discovery/suggest apply the same pass", async () => {
    installKit(world(true, [SHELTER_ROW]));
    const all = await kitGet(base, "/discovery/search?q=zork&type=all&limit=20");
    assert.ok(!byId(all.body).has(P_SHELTER), "type=all served the shelter's place");
    assert.ok(byId(all.body).has(P_OUT), "control");
    clearProtectedZoneCache(); invalidateSearchProtectionFlagCache();
    installKit(world(true, [SHELTER_ROW]));
    const sug = await kitGet(base, "/discovery/suggest?q=zork");
    const ids = (sug.body.groups as any[]).flatMap((g) => g.items.map((i: any) => i.id));
    assert.ok(!ids.includes(P_SHELTER), "suggest served the shelter's place");
    assert.ok(ids.includes(P_OUT), "control");
  });

  it("R5 — a suggest group the pass empties is not served as an empty group", async () => {
    const w = world(true, [SHELTER_ROW]);
    w.rows!.discovery_places = w.rows!.discovery_places!.filter((p) => p.id === P_SHELTER);
    installKit(w);
    const sug = await kitGet(base, "/discovery/suggest?q=zork");
    assert.equal(sug.status, 200);
    assert.ok(!(sug.body.groups as any[]).some((g) => g.type === "places"), "an emptied group was served");
    for (const g of sug.body.groups as any[]) assert.ok(g.items.length > 0, "an empty group was served");
  });

  it("R6 — the caller's own ban check, blocks and age reads are unaffected; travelers (no position) pass through", async () => {
    installKit(world(true, [SHELTER_ROW]));
    const t = await kitGet(base, "/discovery/search?q=zork&type=travelers");
    assert.equal(t.status, 200);
    assert.ok(byId(t.body).has(T_ALICE));
  });
});

describe("R — flag ON, zones UNREADABLE: positions withheld, rows kept, never an empty search", () => {
  for (const zones of ["error", "absent", "throw"] as const) {
    it(`R7 — protected_zones ${zones === "error" ? "resolves an error" : zones === "absent" ? "does not exist (42P01)" : "read rejects"}`, async () => {
      installKit(world(true, zones));
      const { status, body } = await places();
      assert.equal(status, 200, "an unreadable policy must not 500");
      assert.equal(body.refusal, undefined, "the rows are real; nothing was refused");
      const m = byId(body);
      assert.deepEqual([...m.keys()].sort(), [P_CLINIC, P_OUT, P_SHELTER].sort(), "an unreadable policy emptied or shortened the search");
      for (const r of m.values()) {
        assert.equal(r.metadata.lat, null, `${r.id}: a position was served under an unreadable policy`);
        assert.equal(r.metadata.lng, null);
        assert.equal(r.metadata.coordsPrecision, "hidden");
      }
    });
  }

  it("R8 — RETRY: an unreadable read is not cached; the next request re-reads and, healthy, serves positions again", async () => {
    const { state, calls } = installKit(world(true, "error"));
    const first = await places();
    assert.equal(byId(first.body).get(P_OUT).metadata.lat, null);
    delete state.errorTables.protected_zones;
    state.rows.protected_zones = [];
    const second = await places();
    assert.equal(byId(second.body).get(P_OUT).metadata.lat, OUTSIDE.lat, "a failed policy read was remembered");
    assert.equal(calls.tables.filter((t) => t === "protected_zones").length, 2);
  });

  it("R9 — a SUCCESSFUL read is reused inside the store's 30 s TTL and re-read after it is cleared (the Map's contract, inherited)", async () => {
    const { state, calls } = installKit(world(true, []));
    await places();
    state.rows.protected_zones!.push(SHELTER_ROW);
    const cached = await places();
    assert.ok(byId(cached.body).has(P_SHELTER), "inside the TTL the cached policy (no zones) still stands");
    assert.equal(calls.tables.filter((t) => t === "protected_zones").length, 1);
    clearProtectedZoneCache();
    const fresh = await places();
    assert.ok(!byId(fresh.body).has(P_SHELTER), "a new zone must take effect once the cache turns over");
  });
});

describe("R — protectSearchResults never throws into a response", () => {
  it("R10 — a client whose every call throws: flag unreadable ⇒ OFF ⇒ the input array itself", async () => {
    const boom: any = { from() { throw new Error("boom"); } };
    const rows = [row("p1", "places", OUTSIDE)];
    assert.equal(await protectSearchResults(boom, rows), rows);
  });
});
