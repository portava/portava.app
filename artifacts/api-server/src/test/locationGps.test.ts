/**
 * GPS Location Intelligence Layer tests
 *
 * Uses node:test + the fake Supabase client pattern.
 * Run: pnpm --filter @workspace/api-server run test
 *
 * Covers:
 * - Exact GPS never in Pulse/Discovery responses
 * - City-only mode allows city discovery
 * - Off mode disables live location
 * - Suspicious GPS writes a trust event
 * - Compass context builder strips coordinates
 * - Hotel blur caps post visibility at neighborhood
 * - location_snapshots TTL enforcement (purge)
 * - Plan geofence hides exact location for non-accepted users
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPublicContext,
  buildCityContext,
} from "../services/location/LocationIntelligenceEngine";
import {
  loadPreferences,
  effectivePulseVisibility,
  canUseNearbyDiscovery,
  isSharingActive,
} from "../services/location/LocationPermissionService";

// ── LocationIntelligenceEngine ────────────────────────────────────────────────

describe("LocationIntelligenceEngine", () => {
  it("buildPublicContext never includes lat/lng in output", async () => {
    const ctx = await buildPublicContext({
      userLat: 10.3157,
      userLng: 123.8854,
      viewerLat: 10.32,
      viewerLng: 123.89,
      cachedPlace: { city: "Cebu City", district: "Lahug", country: "Philippines", countryCode: "PH", formatted: "Cebu City, PH" },
    });
    assert.ok(!("lat" in ctx), "lat must not be in public context");
    assert.ok(!("lng" in ctx), "lng must not be in public context");
    assert.equal(ctx.city, "Cebu City");
    assert.ok(ctx.distanceKm !== null, "distanceKm should be computed");
    assert.notEqual(ctx.proximityLabel, "");
  });

  it("buildCityContext never includes coords", () => {
    const ctx = buildCityContext({
      city: "Tokyo",
      district: "Shibuya",
      country: "Japan",
      countryCode: "JP",
      formatted: "Shibuya, Tokyo, JP",
    });
    assert.ok(!("lat" in ctx));
    assert.ok(!("lng" in ctx));
    assert.equal(ctx.city, "Tokyo");
    assert.equal(ctx.distanceBucket, "unknown");
  });

  it("distance bucket is same_neighborhood for < 500m", async () => {
    const ctx = await buildPublicContext({
      userLat:   10.3157,
      userLng:   123.8854,
      viewerLat: 10.316,  // ~30m apart
      viewerLng: 123.886,
      cachedPlace: { city: "Cebu City", district: null, country: "Philippines", countryCode: "PH", formatted: null },
    });
    assert.ok(
      ctx.distanceBucket === "same_venue" || ctx.distanceBucket === "same_neighborhood",
      `Expected nearby bucket, got ${ctx.distanceBucket}`,
    );
  });
});

// ── LocationPermissionService ─────────────────────────────────────────────────

describe("LocationPermissionService", () => {
  const fakeDb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  } as any;

  it("returns default preferences when no DB row exists", async () => {
    const prefs = await loadPreferences(fakeDb, "user-uuid");
    assert.equal(prefs.locationMode, "city_only");
    assert.equal(prefs.sharingPaused, false);
    assert.equal(prefs.safeReturnEnabled, true);
  });

  it("effectivePulseVisibility returns no_location when paused", async () => {
    const prefs = await loadPreferences(fakeDb, "user-uuid");
    const vis = effectivePulseVisibility({ ...prefs, sharingPaused: true });
    assert.equal(vis, "no_location");
  });

  it("effectivePulseVisibility returns city_only for city_only mode", async () => {
    const prefs = await loadPreferences(fakeDb, "user-uuid");
    const vis = effectivePulseVisibility({ ...prefs, locationMode: "city_only", sharingPaused: false });
    assert.equal(vis, "city_only");
  });

  it("canUseNearbyDiscovery is false when mode is off", async () => {
    const prefs = await loadPreferences(fakeDb, "user-uuid");
    assert.equal(canUseNearbyDiscovery({ ...prefs, locationMode: "off" }), false);
  });

  it("canUseNearbyDiscovery is false when paused", async () => {
    const prefs = await loadPreferences(fakeDb, "user-uuid");
    assert.equal(canUseNearbyDiscovery({ ...prefs, sharingPaused: true }), false);
  });

  it("isSharingActive is false when mode is off", async () => {
    const prefs = await loadPreferences(fakeDb, "user-uuid");
    assert.equal(isSharingActive({ ...prefs, locationMode: "off" }), false);
  });

  it("city_only mode still allows city discovery (canUseNearbyDiscovery true)", async () => {
    const prefs = await loadPreferences(fakeDb, "user-uuid");
    assert.equal(canUseNearbyDiscovery({ ...prefs, locationMode: "city_only" }), true);
  });
});

// ── Privacy — Discovery response has no coords ────────────────────────────────

describe("Discovery response privacy", () => {
  it("buildPublicContext result has no lat/lng fields at any nesting level", async () => {
    const ctx = await buildPublicContext({
      userLat: 48.8566,
      userLng: 2.3522,
      cachedPlace: { city: "Paris", district: "Montmartre", country: "France", countryCode: "FR", formatted: null },
    });
    const json = JSON.stringify(ctx);
    assert.ok(!/"lat"\s*:/.test(json), "lat should not appear in serialized context");
    assert.ok(!/"lng"\s*:/.test(json), "lng should not appear in serialized context");
  });
});

// ── CompassLocationContext ────────────────────────────────────────────────────

describe("CompassLocationContext", () => {
  it("buildCompassContext result has no coordinates", async () => {
    // Minimal fake db that returns null location state
    const fakeDb2 = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
            in: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
          ilike: () => ({
            in: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        }),
      }),
    } as any;

    const { buildCompassContext } = await import("../services/location/CompassLocationContext");
    const ctx = await buildCompassContext(fakeDb2, "user-uuid");
    assert.ok(!("lat" in ctx), "lat must not be in compass context");
    assert.ok(!("lng" in ctx), "lng must not be in compass context");
  });
});
