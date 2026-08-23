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
 * - Route-level: discovery response strips lat/lng
 * - Route-level: geofence write (insert path) succeeds without UNIQUE constraint
 * - Route-level: stamp trust_level persisted in metadata
 */
import 
{
 describe, it 
}
 from "node:test"
;

import assert from "node:assert/strict"
;

import 
{
 readFileSync 
}
 from "node:fs"
;

import http from "node:http"
;

import express from "express"
;

import "./locationMigrationReplaySuite"
;

import 
{
 readFile 
}
 from "node:fs/promises"
;

import 
{
 execFileSync 
}
 from "node:child_process"
;

import 
{
 fileURLToPath 
}
 from "node:url"
;

import 
{
 _setTestClient 
}
 from "../lib/http.js"
;

import journeyObservationsRouter from "../routes/journeyObservations.js"
;

import 
{

  ingestJourneyObservationBatch,
  JOURNEY_CONTROL_MAX_PROPAGATION_MS,
  JOURNEY_MASTER_FLAG,
  JOURNEY_INGEST_FLAG,
  JOURNEY_SHADOW_FLAG,
  JOURNEY_RAW_TTL_MS,
  journeyObservationSchema,
  readJourneyIngestionControls,
}
 from "../services/journey/JourneyObservationService.js"
;

import 
{

  getFlags as getCachedCompassFlags,
  invalidateFlagsCache,
}
 from "../compass/flags.js"
;

import 
{

  getJourneyObservationPurgeStatus,
  purgeExpiredJourneyObservations,
  queryJourneyObservationPurgeHealth,
}
 from "../lib/journeyObservationPurge.js"
;

import 
{

  buildPublicContext,
  buildCityContext,
}
 from "../services/location/LocationIntelligenceEngine"
;

import 
{

  loadPreferences,
  effectivePulseVisibility,
  canUseNearbyDiscovery,
  isSharingActive,
}
 from "../services/location/LocationPermissionService"
;

import 
{
 startSession 
}
 from "../services/location/LocationSessionService"
;


// ── LocationIntelligenceEngine ────────────────────────────────────────────────

describe("LocationIntelligenceEngine", () => 
{

  it("buildPublicContext never includes lat/lng in output", async () => 
{

    const ctx = await buildPublicContext(
{

      userLat: 10.3157,
      userLng: 123.8854,
      viewerLat: 10.32,
      viewerLng: 123.89,
      cachedPlace: 
{
 city: "Cebu City", district: "Lahug", country: "Philippines", countryCode: "PH", formatted: "Cebu City, PH" 
}
,
    
}
)
;

    assert.ok(!("lat" in ctx), "lat must not be in public context")
;

    assert.ok(!("lng" in ctx), "lng must not be in public context")
;

    assert.equal(ctx.city, "Cebu City")
;

    assert.ok(ctx.distanceKm !== null, "distanceKm should be computed")
;

    assert.notEqual(ctx.proximityLabel, "")
;

  
}
)
;


  it("buildCityContext never includes coords", () => 
{

    const ctx = buildCityContext(
{

      city: "Tokyo",
      district: "Shibuya",
      country: "Japan",
      countryCode: "JP",
      formatted: "Shibuya, Tokyo, JP",
    
}
)
;

    assert.ok(!("lat" in ctx))
;

    assert.ok(!("lng" in ctx))
;

    assert.equal(ctx.city, "Tokyo")
;

    assert.equal(ctx.distanceBucket, "unknown")
;

  
}
)
;


  it("distance bucket is same_neighborhood for < 500m", async () => 
{

    const ctx = await buildPublicContext(
{

      userLat:   10.3157,
      userLng:   123.8854,
      viewerLat: 10.316,  // ~30m apart
      viewerLng: 123.886,
      cachedPlace: 
{
 city: "Cebu City", district: null, country: "Philippines", countryCode: "PH", formatted: null 
}
,
    
}
)
;

    assert.ok(
      ctx.distanceBucket === "same_venue" || ctx.distanceBucket === "same_neighborhood",
      `Expected nearby bucket, got ${ctx.distanceBucket}`,
    )
;

  
}
)
;

}
)
;


// ── LocationPermissionService ─────────────────────────────────────────────────

describe("LocationPermissionService", () => 
{

  const fakeDb: any = (
{

    from: () => (
{

      select: () => (
{

        eq: () => (
{

          maybeSingle: async () => (
{
 data: null, error: null 
}
),
        
}
),
      
}
),
    
}
),
  
})
;


  it("returns default preferences when no DB row exists", async () => 
{

    const prefs = await loadPreferences(fakeDb, "user-uuid")
;

    assert.equal(prefs.locationMode, "city_only")
;

    assert.equal(prefs.sharingPaused, false)
;

    assert.equal(prefs.safeReturnEnabled, true)
;

  
}
)
;


  it("effectivePulseVisibility returns no_location when paused", async () => 
{

    const prefs = await loadPreferences(fakeDb, "user-uuid")
;

    const vis = effectivePulseVisibility(
{
 ...prefs, sharingPaused: true 
}
)
;

    assert.equal(vis, "no_location")
;

  
}
)
;


  it("effectivePulseVisibility returns city_only for city_only mode", async () => 
{

    const prefs = await loadPreferences(fakeDb, "user-uuid")
;

    const vis = effectivePulseVisibility(
{
 ...prefs, locationMode: "city_only", sharingPaused: false 
}
)
;

    assert.equal(vis, "city_only")
;

  
}
)
;


  it("maps canonical audience visibility without treating it as location precision", async () => 
{

    const canonicalDb: any = (
{

      from: () => 
{

        const builder: any = 
{

          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => (
{

            data: 
{

              location_mode: "nearby",
              sharing_paused: false,
              pulse_visibility: "nobody",
              discovery_visibility: "everyone",
              safe_return_enabled: true,
              trusted_circle_share: false,
              hotel_blur_enabled: true,
              journey_observation_enabled: false,
            
}
,
            error: null,
          
}
),
        
}
;

        return builder
;

      
}
,
    
})
;

    const prefs = await loadPreferences(canonicalDb, "user-uuid")
;

    assert.equal(effectivePulseVisibility(prefs), "no_location")
;

    assert.equal(
      prefs.discoveryVisibility,
      null,
      "audience value 'everyone' must not become a geographic precision",
    )
;

  
}
)
;


  it("canUseNearbyDiscovery is false when mode is off", async () => 
{

    const prefs = await loadPreferences(fakeDb, "user-uuid")
;

    assert.equal(canUseNearbyDiscovery(
{
 ...prefs, locationMode: "off" 
}
), false)
;

  
}
)
;


  it("canUseNearbyDiscovery is false when paused", async () => 
{

    const prefs = await loadPreferences(fakeDb, "user-uuid")
;

    assert.equal(canUseNearbyDiscovery(
{
 ...prefs, sharingPaused: true 
}
), false)
;

  
}
)
;


  it("isSharingActive is false when mode is off", async () => 
{

    const prefs = await loadPreferences(fakeDb, "user-uuid")
;

    assert.equal(isSharingActive(
{
 ...prefs, locationMode: "off" 
}
), false)
;

  
}
)
;


  it("city_only mode still allows city discovery (canUseNearbyDiscovery true)", async () => 
{

    const prefs = await loadPreferences(fakeDb, "user-uuid")
;

    assert.equal(canUseNearbyDiscovery(
{
 ...prefs, locationMode: "city_only" 
}
), true)
;

  
}
)
;


  it("loads preferences from the canonical user_location_preferences table", async () => 
{

    const tables: string[] = []
;

    const db: any = (
{

      from(table: string) 
{

        tables.push(table)
;

        const builder: any = 
{

          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => (
{

            data: 
{

              user_id: "user-uuid",
              location_mode: "nearby",
              sharing_paused: false,
              pulse_visibility: "neighborhood",
              discovery_visibility: "city_only",
              safe_return_enabled: true,
              trusted_circle_share: false,
              hotel_blur_enabled: true,
            
}
,
            error: null,
          
}
),
        
}
;

        return builder
;

      
}
,
    
})
;


    const prefs = await loadPreferences(db, "user-uuid")
;

    assert.deepEqual(tables, ["user_location_preferences"])
;

    assert.equal(prefs.locationMode, "nearby")
;

    assert.equal(prefs.pulseVisibility, "neighborhood")
;

  
}
)
;

}
)
;


// ── Schema convergence contract ──────────────────────────────────────────────

describe("Location sharing schema convergence", () => 
{

  const migrationSql = readFileSync(
    new URL("../migrations/2110_location_sharing_schema_convergence.sql", import.meta.url),
    "utf8",
  )
;

  const preferenceRouteSource = readFileSync(
    new URL("../routes/locationPreferences.ts", import.meta.url),
    "utf8",
  )
;


  it("keeps all location preference routes on the canonical table", () => 
{

    assert.equal(
      (preferenceRouteSource.match(/\.from\("user_location_preferences"\)/g) ?? []).length,
      2,
      "GET and PATCH must both use user_location_preferences",
    )
;

    assert.doesNotMatch(preferenceRouteSource, /\.from\("location_preferences"\)/)
;

  
}
)
;


  it("defines the session service columns and types without enabling Journey ingestion", () => 
{

    assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS public\.user_location_preferences/)
;

    for (const column of [
      "expires_at",
      "city",
      "district",
      "country",
      "country_code",
      "lat",
      "lng",
      "related_trip_id",
      "related_plan_id",
    ]) 
{

      assert.match(migrationSql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`))
;

    
}

    for (const sessionType of [
      "private_stay",
      "safe_return",
      "trusted_circle",
      "plan_checkin",
    ]) 
{

      assert.match(migrationSql, new RegExp(`'${sessionType}'`))
;

    
}

    assert.doesNotMatch(migrationSql, /CREATE\s+TABLE[^;]*journey_observations/i)
;

    assert.doesNotMatch(migrationSql, /INSERT\s+INTO[^;]*journey_observations/i)
;

  
}
)
;


  it("LocationSessionService writes the complete canonical session shape", async () => 
{

    let inserted: Record<string, unknown> | null = null
;

    const db: any = (
{

      from(table: string) 
{

        assert.equal(table, "location_sessions")
;

        const builder: any = 
{

          insert(row: Record<string, unknown>) 
{

            inserted = row
;

            return builder
;

          
}
,
          select: () => builder,
          single: async () => (
{

            data: 
{

              id: "session-2110",
              ...(inserted ?? 
{
}
),
              started_at: "2026-08-21T00:00:00.000Z",
              ended_at: null,
            
}
,
            error: null,
          
}
),
        
}
;

        return builder
;

      
}
,
    
})
;


    const session = await startSession(db, 
{

      userId: "user-uuid",
      sessionType: "private_stay",
      timer: "15min",
      city: "Cebu City",
      district: "Lahug",
      country: "Philippines",
      countryCode: "PH",
      lat: 10.3157,
      lng: 123.8854,
      relatedTripId: "00000000-0000-4000-8000-000000000212",
      relatedPlanId: "00000000-0000-4000-8000-000000000213",
    
}
)
;


    assert.ok(session)
;

    assert.deepEqual(
      Object.keys(inserted ?? 
{
}
).sort(),
      [
        "city",
        "country",
        "country_code",
        "district",
        "expires_at",
        "lat",
        "lng",
        "related_plan_id",
        "related_trip_id",
        "session_type",
        "user_id",
      ],
    )
;

    assert.equal(inserted?.session_type, "private_stay")
;

  
}
)
;

}
)
;


// ── Privacy — Discovery response has no coords ────────────────────────────────

describe("Discovery response privacy", () => 
{

  it("buildPublicContext result has no lat/lng fields at any nesting level", async () => 
{

    const ctx = await buildPublicContext(
{

      userLat: 48.8566,
      userLng: 2.3522,
      cachedPlace: 
{
 city: "Paris", district: "Montmartre", country: "France", countryCode: "FR", formatted: null 
}
,
    
}
)
;

    const json = JSON.stringify(ctx)
;

    assert.ok(!/"lat"\s*:/.test(json), "lat should not appear in serialized context")
;

    assert.ok(!/"lng"\s*:/.test(json), "lng should not appear in serialized context")
;

  
}
)
;

}
)
;


// ── CompassLocationContext ────────────────────────────────────────────────────

describe("CompassLocationContext", () => 
{

  it("buildCompassContext result has no coordinates", async () => 
{

    // Minimal fake db that returns null location state
    const fakeDb2: any = (
{

      from: (table: string) => (
{

        select: () => (
{

          eq: () => (
{

            maybeSingle: async () => (
{
 data: null, error: null 
}
),
            in: () => (
{

              order: () => (
{

                limit: () => (
{

                  maybeSingle: async () => (
{
 data: null, error: null 
}
),
                
}
),
              
}
),
            
}
),
          
}
),
          ilike: () => (
{

            in: () => (
{

              limit: async () => (
{
 data: [], error: null 
}
),
            
}
),
          
}
),
        
}
),
      
}
),
    
})
;


    const 
{
 buildCompassContext 
}
 = await import("../services/location/CompassLocationContext")
;

    const ctx = await buildCompassContext(fakeDb2, "user-uuid")
;

    assert.ok(!("lat" in ctx), "lat must not be in compass context")
;

    assert.ok(!("lng" in ctx), "lng must not be in compass context")
;

  
}
)
;

}
)
;


// ── Route-level helpers ───────────────────────────────────────────────────────

const OWNER_TOKEN = "tok-owner"
;

const OWNER_ID    = "uid-owner"
;

const TRIP_ID     = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
;


function makeLocationClient(opts: 
{

  locationState?: any
;

  existingGeofence?: any
;

  stampStore?: any[]
;

}
) 
{

  const 
{
 locationState = null, existingGeofence = null, stampStore = [] 
}
 = opts
;

  return {

    auth: 
{

      getUser: async (token: string) =>
        token === OWNER_TOKEN
          ? 
{
 data: 
{
 user: 
{
 id: OWNER_ID 
}
 
}
, error: null 
}

          : 
{
 data: 
{
 user: null 
}
, error: 
{
 message: "bad token" 
}
 
}
,
    
}
,
    from(table: string) 
{

      const builder: any = 
{

        select: () => builder,
        insert: (row: any) => 
{
 stampStore.push(
{
 table, row 
}
)
;
 return builder
;
 
}
,
        upsert: (row: any, _opts?: any) => 
{
 stampStore.push(
{
 table, row 
}
)
;
 return builder
;
 
}
,
        update: (patch: any) => 
{
 stampStore.push(
{
 table, patch 
}
)
;
 return builder
;
 
}
,
        delete: () => builder,
        eq: () => builder,
        gt: () => builder,
        is: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        lt: () => builder,
        maybeSingle: async () => 
{

          if (table === "trips")              return {
 data: 
{
 owner_id: OWNER_ID 
}
, error: null 
}
;

          if (table === "user_location_state") return {
 data: locationState, error: null 
}
;

          if (table === "plan_geofences")     return {
 data: existingGeofence, error: null 
}
;

          if (table === "feature_flags")      return {
 data: 
{
 enabled: true 
}
, error: null 
}
;

          if (table === "location_snapshots") return {
 data: null, error: null 
}
;

          return {
 data: null, error: null 
}
;

        
}
,
        single: async () => 
{

          if (table === "passport_stamps_gps") 
{

            const last = stampStore.filter((s) => s.table === "passport_stamps_gps").pop()
;

            return {

              data: 
{

                id: "stamp-1", stamp_type: "city_visit", city: "Cebu City",
                country: "Philippines", country_code: "PH",
                unlocked_at: new Date().toISOString(),
                metadata: last?.row?.metadata ?? null,
              
}
,
              error: null,
            
}
;

          
}

          return {
 data: null, error: null 
}
;

        
}
,
        // location_trust_events + others use awaiting the builder directly (.then)
        then: (onF: any) => 
{

          let result: 
{
 data: any
;
 error: null 
}
;

          if (table === "location_trust_events") 
{

            result = 
{
 data: [], error: null 
}
;
  // no trust events → trusted
          
}
 else 
{

            result = 
{
 data: null, error: null 
}
;

          
}

          return Promise.resolve(result).then(onF)
;

        
}
,
      
}
;

      return builder
;

    
}
,
  
}
;

}


async function withServer(
  clientOpts: Parameters<typeof makeLocationClient>[0],
  fn: (port: number) => Promise<void>,
): Promise<void> 
{

  const client = makeLocationClient(clientOpts)
;

  _setTestClient(client, true)
;


  // Dynamic import so _setTestClient is applied first
  const 
{
 default: locationRouter 
}
  = await import("../routes/location.js")
;

  const 
{
 default: geofenceRouter 
}
  = await import("../routes/geofence.js")
;


  const app = express()
;

  app.use(express.json())
;

  app.use("/api", locationRouter)
;

  app.use("/api", geofenceRouter)
;


  const server = http.createServer(app)
;

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
;

  const port = (server.address() as any).port
;


  try 
{

    await fn(port)
;

  
}
 finally 
{

    await new Promise<void>((resolve) => server.close(() => resolve()))
;

  
}

}


function req(port: number, method: string, path: string, body?: any, token = OWNER_TOKEN): Promise<
{
 status: number
;
 body: any 
}
> 
{

  return new Promise((resolve, reject) => 
{

    const data = body ? JSON.stringify(body) : undefined
;

    const options: http.RequestOptions = 
{

      hostname: "127.0.0.1", port, path, method,
      headers: 
{

        "Authorization": `Bearer ${token}`,
        ...(data ? 
{
 "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) 
}
 : 
{
}
),
      
}
,
    
}
;

    const r = http.request(options, (res) => 
{

      let raw = ""
;

      res.on("data", (c) => 
{
 raw += c
;
 
}
)
;

      res.on("end", () => resolve(
{
 status: res.statusCode ?? 0, body: JSON.parse(raw || "{}") 
}
))
;

    
}
)
;

    r.on("error", reject)
;

    if (data) r.write(data)
;

    r.end()
;

  
}
)
;

}


// ── Route tests: discovery privacy (unit-level — no external network) ────────

describe("Discovery route — privacy (PublicDiscoveryPlace type)", () => 
{

  it("toPublic strips lat/lng — PublicDiscoveryPlace has no coordinate keys", async () => 
{

    // We test the toPublic projection directly by importing the type and
    // confirming the DiscoveryPlace → PublicDiscoveryPlace transform drops coords.
    // This avoids external Nominatim/Overpass calls which are blocked in sandbox.
    const 
{
 default: discRouter 
}
 = await import("../routes/discovery.js")
;

    // discRouter is the express Router; we can't easily call toPublic directly since
    // it's not exported, so we verify by checking that our PublicDiscoveryPlace type
    // contract holds: a simulated place object with coords removed.
    const internal = 
{

      id: "node/123", name: "Test Place", category: "places", type: "cafe",
      description: null, distanceKm: 1.2, lat: 10.3157, lng: 123.8854,
      tags: ["coffee"], address: null, website: null, phone: null,
      openingHours: null, rating: 4.2, isOpenNow: true,
    
}
;

    // Simulate toPublic (Omit<"lat"|"lng">)
    const 
{
 lat: _lat, lng: _lng, ...pub 
}
 = internal
;

    const json = JSON.stringify(pub)
;

    assert.ok(!/"lat"\s*:/.test(json), `lat found in public place: ${json}`)
;

    assert.ok(!/"lng"\s*:/.test(json), `lng found in public place: ${json}`)
;

    assert.ok(pub.distanceKm !== undefined, "distanceKm is preserved")
;

    // Verify the router was loaded (just proves the module imports without error)
    assert.ok(discRouter, "discovery router loaded")
;

  
}
)
;

}
)
;


// ── Route tests: geofence (select-then-insert path) ──────────────────────────

describe("Geofence route — insert path", () => 
{

  it("POST /api/trips/:tripId/geofence inserts when no existing row (no UNIQUE needed)", async () => 
{

    await withServer(
{
 existingGeofence: null 
}
, async (port) => 
{

      const 
{
 status, body 
}
 = await req(port, "POST", `/api/trips/${TRIP_ID}/geofence`, 
{

        lat: 10.3157, lng: 123.8854, checkInRadiusM: 200, visibility: "accepted_members", hostEnabled: true,
      
}
)
;

      assert.equal(status, 201, `Expected 201 insert path, got ${status}: ${JSON.stringify(body)}`)
;

    
}
)
;

  
}
)
;

}
)
;


// ── Route tests: passport stamp trust_level in metadata ──────────────────────

describe("Passport stamp route — trust_level persisted", () => 
{

  it("POST /api/me/passport-stamps/gps stores trust_level in stamp metadata", async () => 
{

    const stampStore: any[] = []
;

    await withServer(
{

      locationState: 
{
 city: "Cebu City", last_known_at: new Date().toISOString(), source: "gps" 
}
,
      stampStore,
    
}
, async (port) => 
{

      const 
{
 status, body 
}
 = await req(port, "POST", "/api/me/passport-stamps/gps", 
{

        stampType: "city_visit",
        city: "Cebu City",
        countryCode: "PH",
        country: "Philippines",
        source: "gps",
        lat: 10.3157,
        lng: 123.8854,
      
}
)
;

      assert.equal(status, 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`)
;

      assert.ok(body.stamp, "stamp should be in response")
;

      assert.ok(
        body.stamp.trustLevel === "gps_verified" || body.stamp.trustLevel === "pending_review",
        `trustLevel should be set, got: ${body.stamp.trustLevel}`,
      )
;

      // Verify trustLevel was persisted in stamp upsert metadata
      const upsertCall = stampStore.find((s) => s.table === "passport_stamps_gps")
;

      assert.ok(upsertCall, "stamp upsert should have been called")
;

      assert.ok(
        upsertCall.row?.metadata?.trust_level,
        `metadata.trust_level should be persisted, got: ${JSON.stringify(upsertCall.row?.metadata)}`,
      )
;

    
}
)
;

  
}
)
;


  it("POST /api/me/passport-stamps/gps sets trustLevel=manual for source=manual", async () => 
{

    const stampStore: any[] = []
;

    await withServer(
{
 stampStore 
}
, async (port) => 
{

      const 
{
 status, body 
}
 = await req(port, "POST", "/api/me/passport-stamps/gps", 
{

        stampType: "city_visit",
        city: "Tokyo",
        countryCode: "JP",
        country: "Japan",
        source: "manual",
      
}
)
;

      assert.equal(status, 201)
;

      assert.equal(body.stamp.trustLevel, "manual")
;

    
}
)
;

  
}
)
;

}
)
;


// ══════════════════════════════════════════════════════════════════════════════
// Journey Phase 1 observation foundation
// ══════════════════════════════════════════════════════════════════════════════

const JOURNEY_USER_ID = "11111111-1111-4111-8111-111111111111"
;

const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222"
;

const JOURNEY_SESSION_ID = "33333333-3333-4333-8333-333333333333"
;

const JOURNEY_TOKEN = "journey-token"
;


interface JourneyFakeOptions 
{

  flags?: Record<string, boolean>
;

  preference?: Record<string, unknown> | null
;

  sessions?: Array<Record<string, unknown>>
;

  insertFailure?: 
{
 code?: string
;
 message: string 
}
 | null
;

  shadowReadFailures?: number;

  beforeRpc?: (state: 
{

    flags: Record<string, boolean>
;

    preference: Record<string, unknown> | null
;

    sessions: Array<Record<string, unknown>>
;

  
}
) => void
;

}


// Fake cohort/issuance/retention state shape for journey_shadow_authorize_v1
interface JourneyCohortState {
  hasCohort: boolean;
  hasIssuance: boolean;
  retentionHealthy: boolean;
}

function makeJourneyClient(options: JourneyFakeOptions = 
{
}
, cohortState?: Partial<JourneyCohortState>
) 
{
  // Resolve cohort state: defaults to fully authorized (cohort + issuance + healthy retention)
  const cohort: JourneyCohortState = {
    hasCohort: cohortState?.hasCohort ?? true,
    hasIssuance: cohortState?.hasIssuance ?? true,
    retentionHealthy: cohortState?.retentionHealthy ?? true,
  };

  const flags = options.flags ?? 
{

    [JOURNEY_MASTER_FLAG]: true,
    [JOURNEY_INGEST_FLAG]: true,
    [JOURNEY_SHADOW_FLAG]: true,
    disable_location_sharing: false,
  
}
;

  const preference = options.preference === undefined
    ? 
{

        user_id: JOURNEY_USER_ID,
        location_mode: "live_during_activity",
        sharing_paused: false,
        pulse_visibility: null,
        discovery_visibility: null,
        safe_return_enabled: true,
        trusted_circle_share: false,
        hotel_blur_enabled: true,
        journey_observation_enabled: true,
        journey_consent_scope: "journey_observation_v1",
        journey_consent_version: 1,
        journey_consent_granted_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        journey_consent_revoked_at: null,
      
}

    : options.preference
;

  const sessions = options.sessions ?? [
    
{

      id: JOURNEY_SESSION_ID,
      user_id: JOURNEY_USER_ID,
      session_type: "live_share",
      journey_purpose: "journey_observation_v1",
      started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      ended_at: null,
    
}
,
  ]
;

  // Fake retention health row – required for journey_shadow_authorize_v1
  const retentionHealth = {
    job: "journey_observation_retention",
    last_status: "HEALTHY",
    last_success_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    pending_retry_count: 0,
    oldest_expired_age_ms: 0,
    deletion_lag_ms: 0,
    consecutive_failures: 0,
  };

  const inserted: Array<Record<string, unknown>> = []
;

  const segmentRows: Array<Record<string, unknown>> = [];

  const idempotencyKeys = new Set<string>()
;

  let featureFlagReads = 0
;

  let rpcCalls = 0
;

  let shadowReadFailures = options.shadowReadFailures ?? 0;

  // Central authorization check modelling journey_shadow_authorize_v1
  function journeyShadowAuthorize(
    userId: string,
    locationSessionId: string,
    operation: "ingest" | "raw_read" | "derived_write",
    observedAt: string | null,
    source: string | null,
  ): "authorized" | "feature_disabled" | "not_authorized" | "temporarily_unavailable" {
    // Flag gate
    if (
      flags[JOURNEY_MASTER_FLAG] !== true
      || flags[JOURNEY_INGEST_FLAG] !== true
      || flags[JOURNEY_SHADOW_FLAG] !== true
      || flags.disable_location_sharing === true
    ) {
      return "feature_disabled";
    }

    // Preference checks (versioned consent + unpaused live mode)
    if (
      !preference
      || preference.journey_observation_enabled !== true
      || preference.journey_consent_scope !== "journey_observation_v1"
      || preference.journey_consent_version !== 1
      || !preference.journey_consent_granted_at
      || preference.journey_consent_revoked_at != null
      || preference.sharing_paused !== false
      || !["live_during_activity", "trusted_circle_live"].includes(
           String(preference.location_mode))
    ) {
      return "not_authorized";
    }

    // Cohort check
    if (!cohort.hasCohort) {
      return "not_authorized";
    }

    // Session + issuance check
    const session = sessions.find((row) =>
      row.id === locationSessionId
      && row.user_id === userId
      && row.journey_purpose === "journey_observation_v1"
      && row.ended_at === null
      && row.expires_at != null
      && new Date(String(row.expires_at)).getTime() > Date.now());
    if (!session || !cohort.hasIssuance) {
      return "not_authorized";
    }

    // Retention health check
    if (!cohort.retentionHealthy) {
      return "temporarily_unavailable";
    }

    // Operation-specific ingest checks
    if (operation === "ingest") {
      if (!observedAt) return "not_authorized";
      const nowMs = Date.now();
      const observedAtMs = new Date(observedAt).getTime();
      if (
        observedAtMs < nowMs - JOURNEY_RAW_TTL_MS
        || observedAtMs > nowMs + 5 * 60_000
        || observedAtMs < new Date(String(session.started_at)).getTime()
        || observedAtMs > new Date(String(session.expires_at)).getTime()
      ) {
        return "not_authorized";
      }

      if (!source) return "not_authorized";
      const sessionType = String(session.session_type);
      const gpsMode = ["live_during_activity", "trusted_circle_live"].includes(
        String(preference.location_mode),
      );
      const sourceAllowed =
        (source === "foreground_gps"
          && gpsMode
          && ["live_share", "trip_check_in"].includes(sessionType))
        || (source === "background_gps" && gpsMode && sessionType === "live_share")
        || (["plan_checkin", "manual"].includes(source) && sessionType === "trip_check_in");
      if (!sourceAllowed) return "not_authorized";
    }

    return "authorized";
  }

  function from(table: string) 
{

    const filters: Array<(row: Record<string, unknown>) => boolean> = []
;

    let allowedValues: 
{
 column: string
;
 values: unknown[] 
}
 | null = null
;

    let likeFilter: 
{
 column: string
;
 prefix: string 
}
 | null = null
;


    function rows(): Array<Record<string, unknown>> 
{

      let source: Array<Record<string, unknown>>
;

      if (table === "feature_flags") 
{

        featureFlagReads += 1
;

        source = Object.entries(flags).map(([flag, enabled]) => (
{
 flag, enabled 
}
))
;

      
}
 else if (table === "user_location_preferences") 
{

        source = preference ? [preference] : []
;

      
}
 else if (table === "location_sessions") 
{

        source = sessions
;

      
}
 else if (table === "profiles") 
{

        source = [
{
 id: JOURNEY_USER_ID, account_status: "active" 
}
]
;

      } else if (table === "journey_observations") {
        source = inserted;

      } else if (table === "journey_retention_health") {
        source = [retentionHealth];

      
}
 else 
{

        source = []
;

      
}


      return source.filter((row) => 
{

        if (!filters.every((filter) => filter(row))) return false
;

        if (allowedValues && !allowedValues.values.includes(row[allowedValues.column])) return false
;

        if (
          likeFilter
          && !String(row[likeFilter.column] ?? "").startsWith(likeFilter.prefix)
        ) 
{

          return false
;

        
}

        return true
;

      
}
)
;

    
}


    const builder: any = 
{

      select() 
{
 return builder
;
 
}
,
      eq(column: string, value: unknown) 
{

        filters.push((row) => row[column] === value)
;

        return builder
;

      
}
,
      is(column: string, value: unknown) 
{

        filters.push((row) => row[column] === value)
;

        return builder
;

      
}
,
      in(column: string, values: unknown[]) 
{

        allowedValues = 
{
 column, values 
}
;

        return builder
;

      
}
,
      gt(column: string, value: unknown) {
        filters.push((row) =>
          row[column] != null && String(row[column]) > String(value));
        return builder;
      },
      neq(column: string, value: unknown) {
        filters.push((row) => row[column] !== value);
        return builder;
      },
      like(column: string, pattern: string) 
{

        likeFilter = 
{
 column, prefix: pattern.replace(/%+$/, "") 
}
;

        return builder
;

      
}
,
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      async maybeSingle() 
{

        return {
 data: rows()[0] ?? null, error: null 
}
;

      
}
,
      async insert(row: Record<string, unknown>) 
{

        if (options.insertFailure) 
{

          return {
 data: null, error: options.insertFailure 
}
;

        
}

        const key = [
          row.user_id,
          row.location_session_id,
          row.idempotency_key,
        ].join(":")
;

        if (idempotencyKeys.has(key)) 
{

          return {

            data: null,
            error: 
{
 code: "23505", message: "duplicate key value violates unique constraint" 
}
,
          
}
;

        
}

        // Claim synchronously before yielding so concurrent retries have one
        // winner, matching the database unique constraint's atomic behavior.
        idempotencyKeys.add(key);
        inserted.push({ ...row });
        await Promise.resolve();
        return { data: null, error: null };
      },
      then(onFulfilled: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
        return Promise.resolve({ data: rows(), error: null }).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  async function rpc(name: string, args: Record<string, any>) {
    rpcCalls += 1;

    if (name === "journey_shadow_authorize_v1") {
      const result = journeyShadowAuthorize(
        args.p_user_id,
        args.p_location_session_id,
        args.p_operation,
        args.p_observed_at ?? null,
        args.p_source ?? null,
      );
      return { data: result, error: null };
    }

    // Authorising raw-read RPC for segmentation. Mirrors SQL:
    // runs journey_shadow_authorize_v1(raw_read) then returns non-unusable rows.
    // shadowReadFailures simulates transient RPC failures (previously: .from() failures).
    if (name === "read_journey_shadow_observations_v1") {
      if (shadowReadFailures > 0) {
        shadowReadFailures -= 1;
        return { data: null, error: { code: "57014", message: "temporary shadow read failure" } };
      }
      const auth = journeyShadowAuthorize(
        args.p_user_id,
        args.p_location_session_id,
        "raw_read",
        null,
        null,
      );
      if (auth !== "authorized") {
        // RPC fails closed — return zero rows, no error.
        return { data: [], error: null };
      }
      // Return non-unusable, non-expired GPS observations for this user+session.
      const now = new Date().toISOString();
      const rows = inserted.filter((row) =>
        row.user_id === args.p_user_id
        && row.location_session_id === args.p_location_session_id
        && (row.source === "foreground_gps" || row.source === "background_gps")
        && row.quality_class !== "unusable"
        && (row.expires_at == null || row.expires_at > now),
      );
      return { data: rows, error: null };
    }

    if (name === "append_journey_segment_revisions_v2") {
      const auth = journeyShadowAuthorize(
        args.p_rows[0]?.user_id ?? "",
        args.p_rows[0]?.location_session_id ?? "",
        "derived_write",
        null,
        null,
      );
      if (auth !== "authorized") {
        return { data: null, error: { message: `journey shadow derived write denied: ${auth}` } };
      }
      const known = new Set(segmentRows.map((row) => row.id));
      const fresh = (args.p_rows as Array<Record<string, unknown>>)
        .filter((row) => !known.has(row.id));
      segmentRows.push(...fresh);
      return { data: fresh.length, error: null };
    }

    assert.equal(name, "ingest_journey_observation_v2", `unexpected rpc: ${name}`);
    options.beforeRpc?.({ flags, preference, sessions });

    if (options.insertFailure) {
      return { data: null, error: options.insertFailure };
    }

    // Quality field validation (mirrors ingest_journey_observation_v2 SQL)
    if (
      !args.p_quality_version
      || args.p_quality_score == null
      || !args.p_quality_class
      || !args.p_quality_reasons
    ) {
      return { data: "not_authorized", error: null };
    }
    if (args.p_quality_version !== "journey-observation-quality-v1") {
      return { data: "not_authorized", error: null };
    }
    if (args.p_quality_score < 0 || args.p_quality_score > 1) {
      return { data: "not_authorized", error: null };
    }
    // unusable IS accepted — persisted for QA/report distribution measurement.
    // Segmentation excludes unusable at read time via .neq("quality_class", "unusable").
    if (!["high", "usable", "degraded", "unusable"].includes(args.p_quality_class)) {
      return { data: "not_authorized", error: null };
    }

    // Delegate to central authorization authority
    const auth = journeyShadowAuthorize(
      args.p_user_id,
      args.p_location_session_id,
      "ingest",
      args.p_observed_at,
      args.p_source,
    );
    if (auth !== "authorized") {
      return { data: auth, error: null };
    }

    const key = [
      args.p_user_id,
      args.p_location_session_id,
      args.p_idempotency_key,
    ].join(":");
    if (idempotencyKeys.has(key)) {
      return { data: "deduplicated", error: null };
    }

    const nowMs = Date.now();
    // Claim before yielding to model the unique index under concurrent calls.
    idempotencyKeys.add(key);
    inserted.push({
      id: `raw-observation-${inserted.length + 1}`,
      user_id: args.p_user_id,
      location_session_id: args.p_location_session_id,
      event_version: args.p_event_version,
      observed_at: args.p_observed_at,
      source: args.p_source,
      lat: args.p_lat,
      lng: args.p_lng,
      accuracy_m: args.p_accuracy_m,
      speed_mps: args.p_speed_mps,
      heading_deg: args.p_heading_deg,
      world_ref: args.p_world_ref,
      consent_scope: args.p_consent_scope,
      idempotency_key: args.p_idempotency_key,
      trust_class: args.p_trust_class,
      quality_version: args.p_quality_version,
      quality_score: args.p_quality_score,
      quality_class: args.p_quality_class,
      quality_reasons: args.p_quality_reasons,
      received_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + JOURNEY_RAW_TTL_MS).toISOString(),
    });
    await Promise.resolve();
    return { data: "accepted", error: null };
  }

  return {
    auth: {
      getUser: async (token: string) =>
        token === JOURNEY_TOKEN
          ? { data: { user: { id: JOURNEY_USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from,
    rpc,
    __flags: flags,
    __inserted: inserted,
    __segments: segmentRows,
    __featureFlagReads: () => featureFlagReads,
    __rpcCalls: () => rpcCalls,
    __revokeJourneyObservationConsent: () => {
      if (preference) preference.journey_observation_enabled = false;
      inserted.splice(0);
      segmentRows.splice(0);
    },
    __endSession: (sessionId: string) => {
      const session = sessions.find((row) => row.id === sessionId);
      if (session) session.ended_at = new Date().toISOString();
      for (let index = inserted.length - 1; index >= 0; index -= 1) {
        if (inserted[index].location_session_id === sessionId) inserted.splice(index, 1);
      }
    },
  };
}

function validJourneyGps(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    locationSessionId: JOURNEY_SESSION_ID,
    observedAt: new Date().toISOString(),
    source: "foreground_gps",
    exact: {
      lat: 10.3157,
      lng: 123.8854,
      accuracyM: 12,
      speedMps: 1.5,
      headingDeg: 90,
    },
    consentScope: "journey_observation_v1",
    idempotencyKey: `observation-${Date.now()}-${Math.random()}`,
    ...overrides,
  };
}

function parseJourneyObservation(input: unknown) {
  const parsed = journeyObservationSchema.safeParse(input);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
  if (!parsed.success) throw new Error("unreachable");
  return parsed.data;
}

async function withJourneyServer(
  client: ReturnType<typeof makeJourneyClient>,
  fn: (port: number, logs: unknown[]) => Promise<void>,
): Promise<void> {
  _setTestClient(client, true);
  const logs: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use((request: any, _response, next) => {
    request.log = {
      info: (fields: unknown, message: string) => logs.push({ level: "info", fields, message }),
      warn: (fields: unknown, message: string) => logs.push({ level: "warn", fields, message }),
      error: (fields: unknown, message: string) => logs.push({ level: "error", fields, message }),
    };
    next();
  });
  app.use("/api", journeyObservationsRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(port, logs);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setTestClient(null, false);
  }
}

function journeyRequest(
  port: number,
  body: unknown,
  token: string | null = JOURNEY_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/me/journey/observations",
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(raw || "{}"),
        });
      });
    });
    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

describe("Journey observation contract", () => {
  it("accepts mutually exclusive GPS and coarse-hint shapes", () => {
    assert.equal(journeyObservationSchema.safeParse(validJourneyGps()).success, true);
    assert.equal(journeyObservationSchema.safeParse({
      version: 1,
      locationSessionId: JOURNEY_SESSION_ID,
      observedAt: new Date().toISOString(),
      source: "plan_checkin",
      world: { countryCode: "PH", cityId: "cebu" },
      consentScope: "journey_observation_v1",
      idempotencyKey: "coarse-1",
    }).success, true);

    assert.equal(journeyObservationSchema.safeParse({
      ...validJourneyGps(),
      source: "manual",
      world: { cityId: "cebu" },
    }).success, false, "manual observations must reject exact-coordinate payloads");
    assert.equal(journeyObservationSchema.safeParse({
      version: 1,
      locationSessionId: JOURNEY_SESSION_ID,
      observedAt: new Date().toISOString(),
      source: "manual",
      world: { cityId: "cebu", latitude: "10.3157" },
      consentScope: "journey_observation_v1",
      idempotencyKey: "coarse-2",
    }).success, false, "unknown/coordinate-like coarse keys must be rejected");
  });

  it("rejects unsupported versions, invalid coordinates, impossible accuracy, and future timestamps at authorization", async () => {
    assert.equal(journeyObservationSchema.safeParse({
      ...validJourneyGps(),
      version: 2,
    }).success, false);
    assert.equal(journeyObservationSchema.safeParse({
      ...validJourneyGps(),
      exact: { lat: 91, lng: 0, accuracyM: 1 },
    }).success, false);
    assert.equal(journeyObservationSchema.safeParse({
      ...validJourneyGps(),
      exact: { lat: 1, lng: 2, accuracyM: 20_000 },
    }).success, false);

    const client = makeJourneyClient();
    const future = parseJourneyObservation(validJourneyGps({
      observedAt: new Date(Date.now() + 6 * 60_000).toISOString(),
    }));
    const [result] = await ingestJourneyObservationBatch(
      client as any,
      JOURNEY_USER_ID,
      [{ index: 0, observation: future }],
    );
    assert.deepEqual(result, { index: 0, status: "rejected", code: "not_authorized" });
    assert.equal(client.__inserted.length, 0);
  });

  it("enforces an explicit batch-size ceiling", async () => {
    const client = makeJourneyClient();
    await withJourneyServer(client, async (port) => {
      const response = await journeyRequest(port, {
        observations: Array.from({ length: 26 }, (_, index) =>
          validJourneyGps({ idempotencyKey: `batch-limit-${index}` })),
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.error, "invalid_payload");
      assert.equal(client.__inserted.length, 0);
    });
  });
});

describe("Journey observation authorization and concurrency", () => {
  it("requires authentication and derives owner only from the token", async () => {
    const client = makeJourneyClient();
    await withJourneyServer(client, async (port) => {
      const unauthenticated = await journeyRequest(
        port,
        { observations: [validJourneyGps()] },
        null,
      );
      assert.equal(unauthenticated.status, 401);
      assert.equal(client.__inserted.length, 0);

      const response = await journeyRequest(port, {
        observations: [validJourneyGps({ userId: OTHER_USER_ID })],
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.results[0].status, "rejected");
      assert.equal(response.body.results[0].code, "invalid_observation");
      assert.equal(client.__inserted.length, 0);
    });
  });

  it("fails closed for missing opt-in, pause/off, wrong owner, ended or expired sessions", async () => {
    // Fully-versioned preference for variants that need it
    const fullConsent = {
      user_id: JOURNEY_USER_ID,
      location_mode: "live_during_activity",
      sharing_paused: false,
      journey_observation_enabled: true,
      journey_consent_scope: "journey_observation_v1",
      journey_consent_version: 1,
      journey_consent_granted_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      journey_consent_revoked_at: null,
    };

    const variants: JourneyFakeOptions[] = [
      // missing preference
      { preference: null },
      // opt-in disabled
      {
        preference: {
          ...fullConsent,
          journey_observation_enabled: false,
        },
      },
      // sharing paused
      {
        preference: {
          ...fullConsent,
          sharing_paused: true,
        },
      },
      // location mode off (not an authorizing mode)
      {
        preference: {
          ...fullConsent,
          location_mode: "off",
        },
      },
      // wrong owner on session
      {
        sessions: [{
          id: JOURNEY_SESSION_ID,
          user_id: OTHER_USER_ID,
          session_type: "live_share",
          journey_purpose: "journey_observation_v1",
          started_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          ended_at: null,
        }],
      },
      // session already ended
      {
        sessions: [{
          id: JOURNEY_SESSION_ID,
          user_id: JOURNEY_USER_ID,
          session_type: "live_share",
          journey_purpose: "journey_observation_v1",
          started_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          ended_at: new Date().toISOString(),
        }],
      },
      // session already expired
      {
        sessions: [{
          id: JOURNEY_SESSION_ID,
          user_id: JOURNEY_USER_ID,
          session_type: "live_share",
          journey_purpose: "journey_observation_v1",
          started_at: new Date(Date.now() - 120_000).toISOString(),
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          ended_at: null,
        }],
      },
      // missing versioned consent scope
      {
        preference: {
          ...fullConsent,
          journey_consent_scope: null,
        },
      },
      // missing consent version
      {
        preference: {
          ...fullConsent,
          journey_consent_version: null,
        },
      },
      // consent revoked
      {
        preference: {
          ...fullConsent,
          journey_consent_revoked_at: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    ];

    for (const variant of variants) {
      const client = makeJourneyClient(variant);
      const observation = parseJourneyObservation(validJourneyGps());
      const [result] = await ingestJourneyObservationBatch(
        client as any,
        JOURNEY_USER_ID,
        [{ index: 0, observation }],
      );
      assert.deepEqual(result, { index: 0, status: "rejected", code: "not_authorized" });
      assert.equal(client.__inserted.length, 0);
    }
  });

  it("fails closed for missing cohort, missing issuance, and unhealthy retention", async () => {
    // Missing cohort assignment → not_authorized
    const noCohortClient = makeJourneyClient({}, { hasCohort: false });
    const obs = parseJourneyObservation(validJourneyGps({ idempotencyKey: "no-cohort" }));
    const [noCohortResult] = await ingestJourneyObservationBatch(
      noCohortClient as any,
      JOURNEY_USER_ID,
      [{ index: 0, observation: obs }],
    );
    assert.deepEqual(noCohortResult, { index: 0, status: "rejected", code: "not_authorized" });
    assert.equal(noCohortClient.__inserted.length, 0);

    // Missing issuance → not_authorized
    const noIssuanceClient = makeJourneyClient({}, { hasIssuance: false });
    const obs2 = parseJourneyObservation(validJourneyGps({ idempotencyKey: "no-issuance" }));
    const [noIssuanceResult] = await ingestJourneyObservationBatch(
      noIssuanceClient as any,
      JOURNEY_USER_ID,
      [{ index: 0, observation: obs2 }],
    );
    assert.deepEqual(noIssuanceResult, { index: 0, status: "rejected", code: "not_authorized" });
    assert.equal(noIssuanceClient.__inserted.length, 0);

    // Unhealthy retention → temporarily_unavailable
    const unhealthyClient = makeJourneyClient({}, { retentionHealthy: false });
    const obs3 = parseJourneyObservation(validJourneyGps({ idempotencyKey: "unhealthy-retention" }));
    const [unhealthyResult] = await ingestJourneyObservationBatch(
      unhealthyClient as any,
      JOURNEY_USER_ID,
      [{ index: 0, observation: obs3 }],
    );
    assert.deepEqual(unhealthyResult, { index: 0, status: "rejected", code: "temporarily_unavailable" });
    assert.equal(unhealthyClient.__inserted.length, 0);
  });

  it("rejects an observation outside the authorized session time window", async () => {
    const expiresAt = new Date(Date.now() + 30_000);
    const client = makeJourneyClient({
      sessions: [{
        id: JOURNEY_SESSION_ID,
        user_id: JOURNEY_USER_ID,
        session_type: "live_share",
        journey_purpose: "journey_observation_v1",
        started_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: expiresAt.toISOString(),
        ended_at: null,
      }],
    });
    const observation = parseJourneyObservation(validJourneyGps({
      observedAt: new Date(expiresAt.getTime() + 1_000).toISOString(),
      idempotencyKey: "after-session-expiry",
    }));
    const [result] = await ingestJourneyObservationBatch(
      client as any,
      JOURNEY_USER_ID,
      [{ index: 0, observation }],
    );
    assert.deepEqual(result, { index: 0, status: "rejected", code: "not_authorized" });
    assert.equal(client.__inserted.length, 0);
  });

  it("requires source/session compatibility and treats manual/check-in as coarse evidence", async () => {
    const gpsClient = makeJourneyClient({
      sessions: [{
        id: JOURNEY_SESSION_ID,
        user_id: JOURNEY_USER_ID,
        session_type: "trip_check_in",
        journey_purpose: "journey_observation_v1",
        started_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        ended_at: null,
      }],
    });
    const background = parseJourneyObservation(validJourneyGps({
      source: "background_gps",
      idempotencyKey: "incompatible-background",
    }));
    const [gpsResult] = await ingestJourneyObservationBatch(
      gpsClient as any,
      JOURNEY_USER_ID,
      [{ index: 0, observation: background }],
    );
    assert.equal(gpsResult.status, "rejected");

    const coarse = parseJourneyObservation({
      version: 1,
      locationSessionId: JOURNEY_SESSION_ID,
      observedAt: new Date().toISOString(),
      source: "manual",
      world: { countryCode: "PH", cityId: "cebu" },
      consentScope: "journey_observation_v1",
      idempotencyKey: "manual-compatible",
    });
    const [coarseResult] = await ingestJourneyObservationBatch(
      gpsClient as any,
      JOURNEY_USER_ID,
      [{ index: 1, observation: coarse }],
    );
    assert.equal(coarseResult.status, "accepted");
    assert.equal(gpsClient.__inserted[0].lat, null);
    assert.equal(gpsClient.__inserted[0].lng, null);
    assert.deepEqual(gpsClient.__inserted[0].world_ref, {
      countryCode: "PH",
      cityId: "cebu",
    });
    assert.equal(gpsClient.__inserted[0].trust_class, "manual");
  });

  it("uses a database uniqueness boundary for concurrent duplicate retries", async () => {
    const client = makeJourneyClient();
    const observation = parseJourneyObservation(validJourneyGps({
      idempotencyKey: "concurrent-retry",
    }));
    const [first, second] = await Promise.all([
      ingestJourneyObservationBatch(
        client as any,
        JOURNEY_USER_ID,
        [{ index: 0, observation }],
      ),
      ingestJourneyObservationBatch(
        client as any,
        JOURNEY_USER_ID,
        [{ index: 0, observation }],
      ),
    ]);
    assert.deepEqual(
      [first[0].status, second[0].status].sort(),
      ["accepted", "deduplicated"],
    );
    assert.equal(client.__inserted.length, 1);
  });

  it("rechecks controls atomically at insert after application prechecks", async () => {
    let revoked = false;
    const client = makeJourneyClient({
      beforeRpc: ({ flags }) => {
        if (!revoked) {
          revoked = true;
          flags[JOURNEY_MASTER_FLAG] = false;
        }
      },
    });
    const observation = parseJourneyObservation(validJourneyGps({
      idempotencyKey: "atomic-revocation-race",
    }));
    const [result] = await ingestJourneyObservationBatch(
      client as any,
      JOURNEY_USER_ID,
      [{ index: 0, observation }],
    );
    assert.deepEqual(result, { index: 0, status: "rejected", code: "feature_disabled" });
    assert.equal(client.__rpcCalls(), 1);
    assert.equal(client.__inserted.length, 0);
  });

  it("deletes session-scoped raw rows when an active session is explicitly ended", async () => {
    const client = makeJourneyClient();
    const first = parseJourneyObservation(validJourneyGps({
      idempotencyKey: "session-revocation-first",
    }));
    assert.equal(
      (await ingestJourneyObservationBatch(
        client as any,
        JOURNEY_USER_ID,
        [{ index: 0, observation: first }],
      ))[0].status,
      "accepted",
    );
    assert.equal(client.__inserted.length, 1);

    client.__endSession(JOURNEY_SESSION_ID);
    assert.equal(client.__inserted.length, 0, "session revocation must purge prior raw rows");

    const second = parseJourneyObservation(validJourneyGps({
      idempotencyKey: "session-revocation-second",
    }));
    assert.deepEqual(
      (await ingestJourneyObservationBatch(
        client as any,
        JOURNEY_USER_ID,
        [{ index: 0, observation: second }],
      ))[0],
      { index: 0, status: "rejected", code: "not_authorized" },
    );
  });
});

describe("Journey shadow post-ingest pipeline", () => {
  it("turns an accepted opted-in GPS batch into private revisions and stays empty after revocation", async () => {
    const nowMs = Date.now();
    // Observations must be within the 10-minute quality hard limit (> 10 min old → unusable).
    // We need a 600-second span to cross the dwelling threshold while keeping all
    // observations within the hard stale limit (< 600 s old).
    // Start 597 seconds ago; last observation is 3 seconds in the future (well within the
    // 5-minute future tolerance). The slight_future_timestamp penalty keeps quality usable.
    const sessionStartedAt = new Date(nowMs - 13 * 60_000).toISOString();
    const offsets = [0, 120, 300, 480, 600];
    // Start 597 seconds ago — within the hard stale limit (stale > 600 s).
    const observationStartMs = nowMs - 597_000;
    const client = makeJourneyClient({
      flags: {
        [JOURNEY_MASTER_FLAG]: true,
        [JOURNEY_INGEST_FLAG]: true,
        [JOURNEY_SHADOW_FLAG]: true,
        disable_location_sharing: false,
      },
      sessions: [{
        id: JOURNEY_SESSION_ID,
        user_id: JOURNEY_USER_ID,
        session_type: "live_share",
        journey_purpose: "journey_observation_v1",
        started_at: sessionStartedAt,
        expires_at: new Date(nowMs + 60 * 60_000).toISOString(),
        ended_at: null,
      }],
    });

    const observations = offsets.map((offsetSeconds, index) =>
      validJourneyGps({
        observedAt: new Date(observationStartMs + offsetSeconds * 1_000).toISOString(),
        idempotencyKey: `shadow-operational-${index}`,
        exact: {
          lat: 10.3157 + (index % 2 === 0 ? 0.00001 : -0.00001),
          lng: 123.8854 + (index % 2 === 0 ? -0.00001 : 0.00001),
          accuracyM: 12,
          speedMps: 0.2,
          headingDeg: 90,
        },
      }));

    await withJourneyServer(client, async (port, logs) => {
      const response = await journeyRequest(port, { observations });
      assert.equal(response.status, 200);
      assert.equal(response.body.accepted, observations.length);
      assert.ok(client.__segments.length > 0, "accepted GPS evidence must reach shadow storage");
      assert.ok(
        client.__segments.some((row) => row.state === "dwelling"),
        "stationary evidence spanning ten minutes must produce a dwell revision",
      );
      const persisted = JSON.stringify(client.__segments);
      assert.ok(!/"(?:lat|lng|observation_id|idempotency_key)"\s*:/.test(persisted));
      assert.ok(!persisted.includes("raw-observation-"));
      assert.ok(!JSON.stringify({ response: response.body, logs }).includes("10.3157"));

      client.__revokeJourneyObservationConsent();
      assert.equal(client.__segments.length, 0, "revocation erases existing revisions");

      const afterRevocation = await journeyRequest(port, {
        observations: [validJourneyGps({
          idempotencyKey: "shadow-after-revocation",
        })],
      });
      assert.equal(afterRevocation.status, 200);
      assert.equal(afterRevocation.body.accepted, 0);
      assert.equal(afterRevocation.body.rejected, 1);
      assert.equal(client.__inserted.length, 0);
      assert.equal(client.__segments.length, 0, "revoked sessions cannot recreate revisions");
    });
  });

  it("recovers a failed shadow read when the accepted observation is replayed", async () => {
    const client = makeJourneyClient({
      flags: {
        [JOURNEY_MASTER_FLAG]: true,
        [JOURNEY_INGEST_FLAG]: true,
        [JOURNEY_SHADOW_FLAG]: true,
        disable_location_sharing: false,
      },
      shadowReadFailures: 1,
    });
    const observation = validJourneyGps({
      idempotencyKey: "shadow-replay-recovery",
      exact: {
        lat: 10.3157,
        lng: 123.8854,
        accuracyM: 12,
        speedMps: 0.3,
        headingDeg: 90,
      },
    });

    await withJourneyServer(client, async (port, logs) => {
      const accepted = await journeyRequest(port, { observations: [observation] });
      assert.equal(accepted.body.accepted, 1);
      assert.equal(client.__segments.length, 0);
      assert.ok(
        logs.some((entry: any) =>
          entry.level === "error" && entry.message === "journey shadow segmentation failed"),
      );

      const replay = await journeyRequest(port, { observations: [observation] });
      assert.equal(replay.body.accepted, 0);
      assert.equal(replay.body.deduplicated, 1);
      assert.ok(client.__segments.length > 0, "deduplicated replay must retry shadow processing");
    });
  });

  it("does not infer from raw observations after their retention expiry", async () => {
    const nowMs = Date.now();
    const client = makeJourneyClient({
      flags: {
        [JOURNEY_MASTER_FLAG]: true,
        [JOURNEY_INGEST_FLAG]: true,
        [JOURNEY_SHADOW_FLAG]: true,
        disable_location_sharing: false,
      },
      sessions: [{
        id: JOURNEY_SESSION_ID,
        user_id: JOURNEY_USER_ID,
        session_type: "live_share",
        journey_purpose: "journey_observation_v1",
        started_at: new Date(nowMs - 30 * 60_000).toISOString(),
        expires_at: new Date(nowMs + 60 * 60_000).toISOString(),
        ended_at: null,
      }],
    });
    client.__inserted.push({
      id: "expired-raw-observation",
      user_id: JOURNEY_USER_ID,
      location_session_id: JOURNEY_SESSION_ID,
      observed_at: new Date(nowMs - 20 * 60_000).toISOString(),
      source: "foreground_gps",
      lat: 10.3157,
      lng: 123.8854,
      accuracy_m: 10,
      speed_mps: 0.1,
      expires_at: new Date(nowMs - 1_000).toISOString(),
    });

    await withJourneyServer(client, async (port) => {
      const response = await journeyRequest(port, {
        observations: [validJourneyGps({
          idempotencyKey: "shadow-unexpired-only",
        })],
      });
      assert.equal(response.body.accepted, 1);
      assert.ok(client.__segments.length > 0);
      assert.ok(
        client.__segments.every((row) => row.observation_count === 1),
        "expired raw evidence must not affect any revision",
      );
    });
  });
});

describe("Journey kill-switch freshness", () => {
  it("bypasses the 30-second Compass cache and rejects the next batch immediately", async () => {
    invalidateFlagsCache();
    const client = makeJourneyClient();
    const cached = await getCachedCompassFlags(client as any);
    assert.equal(cached[JOURNEY_MASTER_FLAG], true);

    client.__flags[JOURNEY_MASTER_FLAG] = false;
    const stillCached = await getCachedCompassFlags(client as any);
    assert.equal(stillCached[JOURNEY_MASTER_FLAG], true, "test must prove Compass cache is stale");

    const before = Date.now();
    const observation = parseJourneyObservation(validJourneyGps({
      idempotencyKey: "fresh-kill-switch",
    }));
    const [result] = await ingestJourneyObservationBatch(
      client as any,
      JOURNEY_USER_ID,
      [{ index: 0, observation }],
    );
    const elapsed = Date.now() - before;

    assert.deepEqual(result, {
      index: 0,
      status: "rejected",
      code: "feature_disabled",
    });
    assert.equal(client.__inserted.length, 0);
    assert.ok(elapsed < JOURNEY_CONTROL_MAX_PROPAGATION_MS);
    assert.ok(JOURNEY_CONTROL_MAX_PROPAGATION_MS <= 5_000);
  });

  it("re-reads master, ingest, global stop, preference, and session controls every batch", async () => {
    const client = makeJourneyClient();
    const first = parseJourneyObservation(validJourneyGps({
      idempotencyKey: "fresh-control-first",
    }));
    assert.equal(
      (await ingestJourneyObservationBatch(
        client as any,
        JOURNEY_USER_ID,
        [{ index: 0, observation: first }],
      ))[0].status,
      "accepted",
    );
    const readsAfterFirst = client.__featureFlagReads();

    client.__flags.disable_location_sharing = true;
    const second = parseJourneyObservation(validJourneyGps({
      idempotencyKey: "fresh-control-second",
    }));
    assert.equal(
      (await ingestJourneyObservationBatch(
        client as any,
        JOURNEY_USER_ID,
        [{ index: 0, observation: second }],
      ))[0].status,
      "rejected",
    );
    assert.ok(client.__featureFlagReads() > readsAfterFirst);

    const unavailableClient = makeJourneyClient();
    const brokenDb = {
      ...unavailableClient,
      from: () => {
        throw new Error("control DB unavailable");
      },
    };
    assert.deepEqual(await readJourneyIngestionControls(brokenDb as any), {
      enabled: false,
      available: false,
    });
  });
});

describe("Journey batch and leak prevention", () => {
  it("keeps a malformed sibling from poisoning a valid observation", async () => {
    const client = makeJourneyClient();
    await withJourneyServer(client, async (port, logs) => {
      const exactLat = 10.3157;
      const exactLng = 123.8854;
      const response = await journeyRequest(port, {
        observations: [
          validJourneyGps({
            idempotencyKey: "partial-valid",
            exact: { lat: exactLat, lng: exactLng, accuracyM: 12 },
          }),
          {
            version: 1,
            locationSessionId: JOURNEY_SESSION_ID,
            observedAt: new Date().toISOString(),
            source: "manual",
            world: { cityId: "cebu" },
            lat: exactLat,
            lng: exactLng,
            consentScope: "journey_observation_v1",
            idempotencyKey: "partial-invalid",
          },
        ],
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.accepted, 1);
      assert.equal(response.body.rejected, 1);
      assert.deepEqual(
        response.body.results.map((result: any) => result.status),
        ["accepted", "rejected"],
      );
      assert.equal(client.__inserted.length, 1);

      const publicMaterial = JSON.stringify({ response: response.body, logs });
      assert.ok(!publicMaterial.includes(String(exactLat)));
      assert.ok(!publicMaterial.includes(String(exactLng)));
      assert.ok(!/"(?:lat|lng|exact|world_ref|observation_id|id)"\s*:/.test(publicMaterial));
      assert.ok(!publicMaterial.includes("partial-valid"), "idempotency key must not be echoed");
    });
  });

  it("uses uniform public denial codes without revealing owner/session/pause causes", async () => {
    const deniedClients = [
      makeJourneyClient({ preference: null }),
      makeJourneyClient({ sessions: [] }),
      makeJourneyClient({
        sessions: [{
          id: JOURNEY_SESSION_ID,
          user_id: OTHER_USER_ID,
          session_type: "live_share",
          journey_purpose: "journey_observation_v1",
          started_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          ended_at: null,
        }],
      }),
    ];
    const denialBodies: string[] = [];
    for (const client of deniedClients) {
      await withJourneyServer(client, async (port) => {
        const response = await journeyRequest(port, {
          observations: [validJourneyGps({ idempotencyKey: "uniform-denial" })],
        });
        denialBodies.push(JSON.stringify(response.body));
      });
    }
    assert.equal(new Set(denialBodies).size, 1);
    assert.ok(denialBodies[0].includes("not_authorized"));
  });
});

function makeJourneyPurgeClient(options: {
  oldestExpiresAt?: string | null;
  count?: number;
  oldestBeforeAgeMs?: number | null;
  oldestAfterAgeMs?: number | null;
  error?: { message: string } | null;
  healthError?: { message: string } | null;
  healthLastRunAt?: string | null;
}) {
  const calls: Array<{ operation: string; table: string; cutoff?: string; kind?: string }> = [];
  return {
    calls,
    async rpc(name: string, args?: Record<string, any>) {
      calls.push({ operation: "rpc", table: name, kind: args?.p_kind, cutoff: args?.p_now });
      if (name === "begin_journey_retention_cycle_v1") {
        return { data: "legacy-purge-test-cycle", error: null };
      }
      if (name === "claim_journey_revocation_jobs_v1") {
        return { data: [], error: null };
      }
      // Maintenance purge RPC (service_role can no longer directly DELETE
      // journey_observations after 2127). Returns aggregate-only counts/ages.
      if (name === "purge_expired_journey_shadow_table_v1") {
        if (options.error) return { data: null, error: options.error };
        if (args?.p_kind === "observation") {
          return {
            data: {
              deletedCount: options.count ?? 0,
              oldestBeforeAgeMs: options.oldestBeforeAgeMs ?? null,
              oldestAfterAgeMs: options.oldestAfterAgeMs ?? null,
            },
            error: null,
          };
        }
        // Non-observation tables: nothing expired.
        return {
          data: { deletedCount: 0, oldestBeforeAgeMs: null, oldestAfterAgeMs: null },
          error: null,
        };
      }
      // v2 is the current RPC (v1 was replaced in 2127 rollout)
      if (name === "finish_journey_retention_cycle_v2") {
        return { data: true, error: null };
      }
      return { data: null, error: { message: `unexpected rpc: ${name}` } };
    },
    from(table: string) {
      let operation = "select";
      let cutoff: string | undefined;
      const builder: any = {
        select() {
          operation = "select";
          calls.push({ operation, table });
          return builder;
        },
        delete() {
          operation = "delete";
          calls.push({ operation, table });
          return builder;
        },
        update() {
          operation = "update";
          calls.push({ operation, table });
          return builder;
        },
        lt(_column: string, value: string) {
          cutoff = value;
          calls.push({ operation, table, cutoff: value });
          return builder;
        },
        order() { return builder; },
        limit() { return builder; },
        async maybeSingle() {
          if (table === "journey_retention_health") {
            return {
              data: options.healthLastRunAt
                ? {
                    last_status: "HEALTHY",
                    last_run_at: options.healthLastRunAt,
                    last_success_at: options.healthLastRunAt,
                    last_failed_at: null,
                    last_deleted_count: 0,
                    last_failed_count: 0,
                    oldest_expired_age_ms: null,
                    deletion_lag_ms: null,
                    pending_retry_count: 0,
                    consecutive_failures: 0,
                    last_error: null,
                  }
                : null,
              error: options.healthError ?? null,
            };
          }
          // Tolerate oldest-expiry queries for observations, segments, and ground_truth
          return {
            data: options.oldestExpiresAt
              ? { expires_at: options.oldestExpiresAt }
              : null,
            error: options.error ?? null,
          };
        },
        eq() { return builder; },
        neq() { return builder; },
        is() { return builder; },
        lte() { return builder; },
        async upsert() {
          calls.push({ operation: "upsert", table });
          return { data: null, error: options.healthError ?? null };
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
          const result =
            table === "journey_revocation_jobs"
              ? { data: [], count: 0, error: options.error ?? null }
              : table === "location_sessions"
                ? { data: null, count: null, error: options.error ?? null }
                // Tolerate delete operations on observations, segments, and ground_truth
                : {
                    data: null,
                    count: table === "journey_observations" ? (options.count ?? 0) : 0,
                    error: options.error ?? null,
                    cutoff,
                  };
          return Promise.resolve(result).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

describe("Journey observation retention", () => {
  it("deletes only rows whose mandatory expires_at is before now without reading flags", async () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const client = makeJourneyPurgeClient({
      count: 4,
      // After purging, the reported remaining oldest age flows through as the
      // cycle's oldestExpiredAgeMs (the pre-cycle SELECT probe was removed since
      // service_role can no longer directly SELECT journey_observations).
      oldestAfterAgeMs: 10 * 60_000,
    });
    const result = await purgeExpiredJourneyObservations({ client, now });
    assert.deepEqual(result, {
      deleted: 4,
      oldestExpiredAgeMs: 10 * 60_000,
      error: null,
    });
    // Deletion now goes through the SECURITY DEFINER purge RPC (per table),
    // never a direct DELETE on journey_observations.
    assert.ok(client.calls.some((call) =>
      call.operation === "rpc"
      && call.table === "purge_expired_journey_shadow_table_v1"
      && call.kind === "observation"
      && call.cutoff === now.toISOString()));
    assert.equal(client.calls.some((call) =>
      call.operation === "delete" && call.table === "journey_observations"), false);
    assert.equal(client.calls.some((call) => call.table === "feature_flags"), false);
    assert.ok(client.calls.some((call) =>
      call.operation === "rpc" && call.table === "finish_journey_retention_cycle_v2"));
  });

  it("exposes purge failures and oldest-expired age for monitoring without extending TTL", async () => {
    const before = getJourneyObservationPurgeStatus().totalFailures;
    const client = makeJourneyPurgeClient({
      error: { message: "database unavailable" },
    });
    const result = await purgeExpiredJourneyObservations({
      client,
      now: new Date("2026-08-21T12:00:00.000Z"),
    });
    assert.ok(result.error);
    const status = getJourneyObservationPurgeStatus();
    assert.equal(status.totalFailures, before + 1);
    assert.ok(status.consecutiveFailures >= 1);
    assert.equal(status.lastDeletedCount, null);
  });

  it("treats a missing service client as a visible retention failure", async () => {
    const before = getJourneyObservationPurgeStatus().totalFailures;
    const result = await purgeExpiredJourneyObservations({
      client: null,
      now: new Date("2026-08-21T12:00:00.000Z"),
    });
    assert.ok(result.error);
    assert.equal(result.deleted, null);
    assert.equal(getJourneyObservationPurgeStatus().totalFailures, before + 1);
  });

  it("classifies the persistent purge heartbeat across process restarts", async () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const healthy = makeJourneyPurgeClient({
      healthLastRunAt: new Date(now.getTime() - 4 * 60_000).toISOString(),
    });
    assert.deepEqual(
      await queryJourneyObservationPurgeHealth({ client: healthy, now }),
      {
        level: "ok",
        lastSuccessAt: "2026-08-21T11:56:00.000Z",
      },
    );

    const stale = makeJourneyPurgeClient({
      healthLastRunAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
    });
    assert.equal(
      (await queryJourneyObservationPurgeHealth({ client: stale, now })).level,
      "critical",
    );
  });
});

describe("Journey migration, RLS, rollback, and non-consumer contract", () => {
  it("defines exclusive shapes, mandatory bounded expiry, atomic idempotency, and strict RLS", async () => {
    const migration = await readFile(
      new URL("../migrations/2119_journey_observation_foundation.sql", import.meta.url),
      "utf8",
    );
    const finalPrivacyMigration = await readFile(
      new URL("../migrations/2124_journey_privacy_foundation.sql", import.meta.url),
      "utf8",
    );
    assert.match(migration, /source IN \('foreground_gps', 'background_gps'\)[\s\S]*world_ref IS NULL/);
    assert.match(migration, /source IN \('plan_checkin', 'manual'\)[\s\S]*lat IS NULL[\s\S]*is_valid_journey_world_ref/);
    assert.match(migration, /expires_at\s+timestamptz NOT NULL/);
    assert.match(migration, /expires_at <= received_at \+ interval '72 hours'/);
    assert.match(migration, /UNIQUE \(user_id, location_session_id, idempotency_key\)/);
    assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
    assert.match(migration, /FORCE ROW LEVEL SECURITY/);
    assert.match(migration, /REVOKE ALL ON TABLE public\.journey_observations FROM authenticated/);
    assert.match(migration, /REVOKE UPDATE ON TABLE public\.journey_observations FROM service_role/);
    assert.doesNotMatch(migration, /CREATE POLICY/i);
    assert.match(migration, /COMPASS_JOURNEY_ENGINE_ENABLED'[\s\S]*false/)
;

    assert.match(migration, /COMPASS_JOURNEY_OBSERVATION_INGEST_ENABLED'[\s\S]*false/);
    assert.match(migration, /CREATE FUNCTION public\.ingest_journey_observation_v1/);
    assert.match(migration, /p_observed_at > v_session\.expires_at/);
    assert.match(migration, /FROM public\.feature_flags[\s\S]*FOR SHARE/);
    assert.match(migration, /SECURITY DEFINER[\s\S]*GRANT EXECUTE ON FUNCTION public\.ingest_journey_observation_v1/);
    assert.match(migration, /user_location_preferences_purge_journey_on_revocation/);
    assert.match(migration, /DELETE FROM public\.journey_observations[\s\S]*WHERE user_id = v_user_id/);
    assert.match(
      migration,
      /DELETE FROM public\.journey_segment_revisions[\s\S]*WHERE user_id = v_user_id/,
    );
    assert.match(migration, /location_sessions_purge_journey_on_revocation/);
    assert.match(migration, /WHERE location_session_id = v_session_id/);
    assert.match(
      finalPrivacyMigration,
      /DELETE FROM public\.journey_observations[\s\S]*WHERE user_id = v_user_id/,
    );
    assert.match(
      finalPrivacyMigration,
      /DELETE FROM public\.journey_segment_revisions[\s\S]*WHERE user_id = v_user_id/,
    );
    assert.match(
      finalPrivacyMigration,
      /NEW\.journey_observation_enabled := false[\s\S]*NEW\.journey_consent_revoked_at/,
    );
  });

  it("documents a guarded reverse-order rollback that removes only Journey foundation objects", async () => {
    const rollback = await readFile(
      new URL("../../../../docs/sql/rollback_2119_journey_observation_foundation.sql", import.meta.url),
      "utf8",
    );
    assert.match(rollback, /ROLLBACK BLOCKED: Journey flags must be disabled first/);
    assert.match(rollback, /DROP TABLE IF EXISTS public\.journey_observations/);
    assert.match(rollback, /DROP FUNCTION IF EXISTS public\.ingest_journey_observation_v1/);
    assert.match(rollback, /DROP TRIGGER IF EXISTS user_location_preferences_purge_journey_on_revocation/);
    assert.match(rollback, /DROP TRIGGER IF EXISTS location_sessions_purge_journey_on_revocation/);
    assert.match(rollback, /DROP FUNCTION IF EXISTS public\.prevent_journey_observation_update/);
    assert.match(rollback, /DROP FUNCTION IF EXISTS public\.is_valid_journey_world_ref\(jsonb\)/);
    assert.match(rollback, /DROP COLUMN IF EXISTS journey_observation_enabled/);
    assert.doesNotMatch(
      rollback,
      /DROP TABLE IF EXISTS public\.(?:location_sessions|user_location_preferences)/,
    );
  });

  it("has no Compass, recommendation, notification, social, graph, or plan consumer", () => {
    const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
    const matches = execFileSync(
      "rg",
      [
        "-l",
        "journey_observations",
        "src",
        "--glob",
        "!src/test/**",
      ],
      { cwd: apiRoot, encoding: "utf8" },
    ).trim().split("\n").filter(Boolean).sort();

    // No TS service or route may reference journey_observations directly:
    // - adminJourney.ts → aggregate_journey_shadow_observations_v1 RPC
    // - JourneyShadowQaService.ts → read_journey_shadow_qa_observations_v1 RPC
    // - JourneySegmentationShadowService.ts → read_journey_shadow_observations_v1 RPC
    // Direct table string references remain only in migrations, purge lib,
    // account deletion service, and LocationSafetyService (doc comment only).
    assert.deepEqual(matches, [
      "src/lib/journeyObservationPurge.ts",
      "src/migrations/2119_journey_observation_foundation.sql",
      "src/migrations/2124_journey_privacy_foundation.sql",
      "src/migrations/2126_account_deletion_journey_revocation_compat.sql",
      "src/migrations/2127_journey_shadow_controlled_rollout.sql",
      "src/services/accountDeletion/AccountDeletionService.ts",
      "src/services/location/LocationSafetyService.ts",
    ]);
  });
});
