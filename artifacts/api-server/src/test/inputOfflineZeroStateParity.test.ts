/**
 * census G200/G201 — PARITY between the server's zero-state rows and the
 * device's rule for which of them it may keep (lead ruling 2026-10-07: "keep
 * saved-place and trip-destination zero-state rows in the existing
 * account-tagged device store, erased on account change, used only by
 * offline-allowed fields, with no position stored").
 *
 * The device recognises the two row kinds by the SHAPE the server projects them
 * in (`travel-buddy-standalone/src/platform/input-assistance/services/
 * localRecentsStore.ts#isRetainableZeroStateRow`): a saved place
 * (`savedEntities.ts#projectSavedPlace`) and a current/upcoming Trip destination
 * (`projection.ts#projectGeoDefault`). This file runs the REAL gateway for an
 * empty field and feeds what it serves through the client's own predicate, so a
 * change to either side that makes them disagree goes red here:
 *   - a renamed saved/Trip id or reason → the "is kept" assertions go red (the
 *     device would silently stop keeping them);
 *   - the current-location default, or the server's own §35 recents, becoming
 *     recognisable → the "is never kept" assertions go red;
 *   - a coordinate surviving the client's scrub → the "no position" assertion.
 *
 * The client functions are imported across the package boundary on purpose, as
 * inputLocalSufficiencyParity.test.ts does.
 *
 * MUTATION LOG (applied with scratchpad mutate.py, watched go red, restored):
 *   - projectSavedPlace's id `:saved:place:` → `:saved:` → "a saved place … is
 *     kept" red.
 *   - projectGeoDefault's reason/kind ids: `${def.kind}` → `trip` → "the
 *     viewer's current and upcoming Trip destinations are kept" red.
 *   - client `isRetainableZeroStateRow` accepting `:default:current:` → "the
 *     current location is never kept" red.
 *
 * Run: node --import tsx/esm --test src/test/inputOfflineZeroStateParity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateSuggestions } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import type { InputContext, InputSuggestion } from "../lib/inputAssistance/types.js";
import {
  isRetainableZeroStateRow,
  stripRetainedPosition,
} from "../../../../travel-buddy-standalone/src/platform/input-assistance/services/localRecentsStore.ts";

const VIEWER = "aa000000-0000-4000-a000-00000000000a";
const PLACE = "cc000000-0000-4000-a000-00000000000a";
const DEST_LAT = 13.7563;
const DEST_LNG = 100.5018;

/** A permissive fake: every table answers, with the rows the case supplies. */
function fakeClient(state: Record<string, any[]> = {}) {
  return {
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const rows = [...(state[table] ?? [])];
      const b: any = {
        select: () => b, eq: () => b, neq: () => b, in: () => b, not: () => b, is: () => b, ilike: () => b,
        or: () => b, gte: () => b, lt: () => b, lte: () => b, gt: () => b, order: () => b, limit: () => b, range: () => b,
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (f: any, r: any) => Promise.resolve({ data: rows, error: null }).then(f, r),
      };
      return b;
    },
  };
}

async function serveEmpty(context: InputContext, state: Record<string, any[]>, city: string | null = null): Promise<InputSuggestion[]> {
  const policy = resolvePolicy(context)!;
  return generateSuggestions(fakeClient(state) as any, {
    context, policy, text: "", userId: VIEWER, limit: policy.maxSuggestions,
    lat: null, lng: null, city, tz: null,
  });
}

const SAVED_STATE = {
  discovery_place_saves: [{ place_id: PLACE, saved_at: "2026-10-01T00:00:00Z" }],
  blocks: [],
  discovery_places: [{ id: PLACE, name: "Roast Lab", city: "Bangkok", primary_category: "cafe", category: null, submitted_by: null, status: "active" }],
};

const TRIP_STATE = {
  trip_members: [{ trip_id: "t-1", role: "owner" }],
  trips: [
    { destination_city: "Bangkok", destination_country: "Thailand", destination_lat: DEST_LAT, destination_lng: DEST_LNG, status: "active", start_date: "2026-10-01" },
    { destination_city: "Lisbon", destination_country: "Portugal", destination_lat: 38.7223, destination_lng: -9.1393, status: "upcoming", start_date: "2026-12-01" },
  ],
};

/** Every number found under a position key, anywhere in a value. */
function positions(v: unknown, out: number[] = []): number[] {
  if (!v || typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (["lat", "lng", "latitude", "longitude"].includes(k) && typeof val === "number") out.push(val);
    else positions(val, out);
  }
  return out;
}

describe("G200/G201 parity: which zero-state rows the device may keep", () => {
  it("a saved place served to the empty global_search field is kept", async () => {
    const rows = await serveEmpty("global_search", SAVED_STATE);
    const saved = rows.filter((r) => r.entityId === PLACE);
    assert.equal(saved.length, 1, "the server serves the saved place (premise)");
    assert.equal(isRetainableZeroStateRow(saved[0] as any), true);
  });

  it("the viewer's current and upcoming Trip destinations are kept, and the current location is never kept", async () => {
    const rows = await serveEmpty("trip_destination", TRIP_STATE, "Paris");
    const labels = rows.map((r) => r.label);
    for (const l of ["Paris", "Bangkok", "Lisbon"]) assert.ok(labels.includes(l), `the server serves ${l} (premise)`);
    const kept = rows.filter((r) => isRetainableZeroStateRow(r as any)).map((r) => r.label).sort();
    assert.deepEqual(kept, ["Bangkok", "Lisbon"]);
  });

  it("the current location is never kept, in any geo picker the server answers it in", async () => {
    for (const context of ["city_picker", "trip_destination", "country_picker"] as InputContext[]) {
      const rows = await serveEmpty(context, {}, "Paris");
      assert.ok(rows.some((r) => r.label === "Paris"), `${context} serves the current location (premise)`);
      for (const r of rows) assert.equal(isRetainableZeroStateRow(r as any), false, `${context}: ${r.id}`);
    }
  });

  it("no position survives the client's scrub of a served Trip row", async () => {
    const rows = await serveEmpty("trip_destination", TRIP_STATE);
    const bangkok = rows.find((r) => r.label === "Bangkok")!;
    assert.ok(positions(bangkok).includes(DEST_LAT), "the served row carries the destination's position (premise)");
    const kept = stripRetainedPosition(bangkok as any);
    assert.deepEqual(positions(kept), []);
    const sv = kept.structuredValue as Record<string, unknown>;
    assert.equal(sv.city, "Bangkok");
    assert.equal(sv.timezone, "Asia/Bangkok", "the timezone derived from the centre is kept (G66 note)");
  });

  it("the fields the server serves saved or Trip rows to that may keep them are exactly the offline-allowed public ones", () => {
    // `retainZeroStateRows` keeps nothing for a field whose offlinePolicy has no
    // offline surface, or whose privacy class may not retain. Pin which fields
    // that leaves among those the gateway serves these rows to, so a registry
    // change that widens it is a visible decision rather than a silent one.
    const open = (c: InputContext) => {
      const p = resolvePolicy(c)!;
      return ["static_dictionary", "cached_local", "recent_only"].includes(p.offlinePolicy as string) && p.privacyClass === "public";
    };
    const served: InputContext[] = [
      "global_search", "city_picker", "country_picker", "neighborhood_picker", "place_picker", "trip_destination",
      "trip_stop_place", "event_location", "passport_homebase", "address", "buddy_service_area", "hidden_gem_location",
    ];
    assert.deepEqual(served.filter(open).sort(), ["city_picker", "country_picker", "global_search", "neighborhood_picker", "trip_destination"]);
  });
});
