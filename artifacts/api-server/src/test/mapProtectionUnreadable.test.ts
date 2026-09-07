/**
 * The blank-map hazard, closed at the gateway.
 *
 * `protected_zones` does not exist in production (migration 2217 unapplied,
 * measured 2026-09-07). Both map routes fail closed when the §24 policy cannot
 * be read — correctly — but they used to fail closed with
 * `enabled: true, objects: []`, and the client treats an `enabled: true`
 * answer as owning every layer (useMapEntities.ts "THE FALLBACK IS
 * ALL-OR-NOTHING"). So the first flip of `map_projection_enabled` in
 * production would have blanked the map: not a leak, an outage.
 *
 * Now an unreadable policy answers `enabled: false` with
 * `refusal: "protection_unreadable"`. The gateway still serves NOTHING; the
 * client keeps the legacy per-layer path that serves all of production today.
 * These tests pin the three facts that make that safe: nothing is served, the
 * answer is `enabled: false` (so the client falls back rather than blanks),
 * and a READABLE policy still answers `enabled: true` (so this cannot become a
 * way of switching the gateway off).
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapProtectionUnreadable.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
  _clearCityZoneCache,
} from "../routes/mapProjection.js";
import temporalRouter from "../routes/mapProjectionTemporal.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const VIEWER = "12121212-dddd-4ddd-8ddd-121212121212";
const TOKEN = "protection-unreadable-token";
const SPOT = { lat: 16.0678, lng: 108.2208 };
const BBOX_STR = "108.0,15.9,108.4,16.2";

/** What PostgREST says when 2217 has not been applied. */
const RELATION_MISSING = { message: 'relation "public.protected_zones" does not exist', code: "42P01" };

function world(over: FakeState = {}): FakeState {
  return {
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    blocks: [],
    geo_zones: [],
    event_roles: [],
    protected_zones: [],
    places: [
      {
        id: "place-1", name: "Han Market", primary_category: "night_market", city: "Da Nang",
        neighborhood: null, country_code: "VN", latitude: SPOT.lat, longitude: SPOT.lng,
        status: "active", merged_into_place_id: null,
      },
    ],
    ...over,
  };
}

describe("an unreadable §24 policy answers enabled:false, never a blank enabled:true", () => {
  let app: ProjectionApp | null = null;

  beforeEach(() => { _clearProtectedZoneCache(); _clearFlowZoneCache(); _clearCityZoneCache(); });
  afterEach(async () => { if (app) await app.close(); app = null; });

  async function gateway(state: FakeState, query: string) {
    app = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId: VIEWER });
    return app.projection(query);
  }
  async function temporal(state: FakeState, query: string): Promise<{ status: number; body: any }> {
    app = await startRouterApp(temporalRouter, state, { token: TOKEN, userId: VIEWER });
    const r = await fetch(`${app.baseUrl}/api/map/projection/temporal?${query}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { status: r.status, body: (await r.json()) as any };
  }

  it("gateway: the table production lacks ⇒ enabled:false, refusal named, nothing served", async () => {
    const r = await gateway(world({ protected_zones: { error: RELATION_MISSING } }), `bbox=${BBOX_STR}&zoom=14&kinds=place`);
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.refusal, "protection_unreadable");
    assert.deepEqual(r.body.objects, []);
    assert.equal(r.body.total, 0);
    assert.deepEqual(r.body.sources, []);
    assert.equal(r.body.protection, null);
  });

  it("gateway: any other read error on the policy is the same answer", async () => {
    const r = await gateway(world({ protected_zones: { error: { message: "boom" } } }), `bbox=${BBOX_STR}&zoom=14&kinds=place`);
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.refusal, "protection_unreadable");
    assert.deepEqual(r.body.objects, []);
  });

  it("gateway: a READABLE (even empty) policy still answers enabled:true and serves — this is not an off switch", async () => {
    const r = await gateway(world(), `bbox=${BBOX_STR}&zoom=14&kinds=place`);
    assert.equal(r.body.enabled, true);
    assert.equal("refusal" in r.body, false);
    assert.equal(r.body.objects.length, 1);
    assert.equal(r.body.objects[0].id, "place:place-1");
  });

  it("gateway: the flag-off envelope is unchanged and carries no refusal", async () => {
    const r = await gateway(world({ feature_flags: [{ flag: "map_projection_enabled", enabled: false }] }), `bbox=${BBOX_STR}&zoom=14`);
    assert.equal(r.body.enabled, false);
    assert.equal("refusal" in r.body, false);
  });

  it("temporal: the same rule — unreadable policy ⇒ enabled:false with the refusal; readable ⇒ enabled:true", async () => {
    const off = await temporal(world({ protected_zones: { error: RELATION_MISSING } }), `bbox=${BBOX_STR}&offsetMinutes=60`);
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.refusal, "protection_unreadable");
    assert.deepEqual(off.body.objects, []);
    await app!.close(); app = null;
    const on = await temporal(world(), `bbox=${BBOX_STR}&offsetMinutes=60`);
    assert.equal(on.body.enabled, true);
    assert.equal("refusal" in on.body, false);
  });
});
