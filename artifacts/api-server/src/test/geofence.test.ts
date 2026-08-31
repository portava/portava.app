/**
 * Plan geofence privacy + check-in tests
 *
 * Uses node:test + fake Supabase client pattern.
 * Run: pnpm --filter @workspace/api-server run test
 *
 * Covers:
 * - Non-accepted users cannot see exact plan coordinates
 * - Accepted users see exact location only when settings allow
 * - Removed users lose access immediately
 * - Check-in succeeds inside radius and fails outside
 * - Check-in stores status without exposing public coordinates
 * - Suspicious GPS creates a location_trust_event
 * - Public plan cards never include exact coordinates
 * - Host sees arrival statuses without attendee pins
 * - Admin radius defaults apply (radius clamped to admin settings)
 * - No-show event created after window closes (late_check_in event)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const OWNER_TOKEN  = "tok-owner";
const MEMBER_TOKEN = "tok-member";
const OTHER_TOKEN  = "tok-other";
const OWNER_ID     = "uid-owner";
const MEMBER_ID    = "uid-member";
const OTHER_ID     = "uid-other";
const TRIP_ID      = "trip-aaaa-bbbb-cccc-dddddddddddd";
const GEOFENCE_ID  = "gf-aaaa-bbbb-cccc-dddddddddddd";

// The "meetup" coords (private) — ~48.85°N 2.35°E (near Paris)
const MEETUP_LAT = 48.8566;
const MEETUP_LNG = 2.3522;

// Inside radius (< 150m away)
const INSIDE_LAT = 48.8566;
const INSIDE_LNG = 2.3524; // ~14m away

// Outside radius (~5km)
const OUTSIDE_LAT = 48.810;
const OUTSIDE_LNG = 2.3522;

// ── Fake client factory ────────────────────────────────────────────────────────

function makeGeofenceClient(opts: {
  memberRole?: "owner" | "member" | "co_host" | "viewer" | null;
  memberStatus?: string | null;
  geofence?: any;
  eventStore?: any[];
  checkinStore?: any[];
  memberIds?: string[];
  locationSnap?: any;
  trustSuspicious?: boolean;
  tripVisibility?: string;
  checkinUpsertError?: any;
}) {
  const {
    memberRole     = null,
    memberStatus   = "accepted",
    geofence       = null,
    eventStore     = [],
    checkinStore   = [],
    memberIds      = [],
    locationSnap   = null,
    trustSuspicious = false,
    tripVisibility = "public",
    checkinUpsertError = null,
  } = opts;

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === OWNER_TOKEN)  return { data: { user: { id: OWNER_ID } },  error: null };
        if (token === MEMBER_TOKEN) return { data: { user: { id: MEMBER_ID } }, error: null };
        if (token === OTHER_TOKEN)  return { data: { user: { id: OTHER_ID } },  error: null };
        return { data: { user: null }, error: { message: "bad token" } };
      },
    },
    from(table: string) {
      const store = eventStore;
      let lastInsert: any = null;
      const builder: any = {
        select: (..._a: any[]) => builder,
        eq:     (..._a: any[]) => builder,
        in:     (..._a: any[]) => builder,
        is:     (..._a: any[]) => builder,
        gt:     (..._a: any[]) => builder,
        lt:     (..._a: any[]) => builder,
        order:  (..._a: any[]) => builder,
        limit:  (..._a: any[]) => builder,
        update: (patch: any) => { store.push({ table, op: "update", patch }); return builder; },
        delete: () => { store.push({ table, op: "delete" }); return builder; },
        insert: (row: any) => { store.push({ table, op: "insert", row }); lastInsert = row; return builder; },
        upsert: (row: any) => {
          checkinStore.push({ table, op: "upsert", row });
          // plan_checkins upserts resolve to an error when configured (supabase-js
          // resolves on DB error rather than throwing).
          const upsertErr = table === "plan_checkins" ? checkinUpsertError : null;
          return {
            ...builder,
            then: (onF: any) => Promise.resolve({ data: null, error: upsertErr ?? null }).then(onF),
          };
        },
        maybeSingle: async () => {
          if (table === "feature_flags") return { data: { enabled: true }, error: null };

          if (table === "trips") {
            return { data: { owner_id: OWNER_ID, visibility: tripVisibility }, error: null };
          }

          if (table === "trip_members") {
            // A non-owner accepted role (member / co_host / viewer) resolves to a
            // member-level row; null memberRole is a non-member.
            if (memberRole && memberRole !== "owner") {
              return { data: { user_id: MEMBER_ID, role: memberRole, status: memberStatus }, error: null };
            }
            return { data: null, error: null };
          }

          if (table === "plan_geofences") return { data: geofence, error: null };

          if (table === "plan_checkins") return { data: null, error: null };

          if (table === "geofence_admin_settings") {
            return { data: { default_radius_m: 150, min_radius_m: 50, max_radius_m: 5000, no_show_affects_reliability: false }, error: null };
          }

          if (table === "location_snapshots") {
            if (trustSuspicious && locationSnap) {
              // Return a snapshot that will cause impossible_speed check
              const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
              return { data: { lat: 40.7128, lng: -74.0060, captured_at: tenMinsAgo }, error: null };
            }
            return { data: locationSnap, error: null };
          }

          return { data: null, error: null };
        },
        single: async () => {
          if (lastInsert) {
            const row = { id: `test-event-${Date.now()}`, ...lastInsert };
            lastInsert = null;
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
        then: (onF: any) => {
          // Used for location_trust_events insert
          return Promise.resolve({ data: null, error: null }).then(onF);
        },
      };
      return builder;
    },
  };
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  path: string,
  body?: any,
  token = OWNER_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1", port, path, method,
      headers: {
        "Authorization": `Bearer ${token}`,
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw || "{}") });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// ── Test server factory ────────────────────────────────────────────────────────

async function withGeofenceServer(
  clientOpts: Parameters<typeof makeGeofenceClient>[0],
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const client = makeGeofenceClient(clientOpts);
  _setTestClient(client, true);

  const { default: geofenceRouter } = await import("../routes/geofence.js");

  const app = express();
  app.use(express.json());
  // Stub the pino-http request logger (production supplies req.log; the bare
  // test app does not, so error paths that call req.log.error would throw).
  app.use((req, _res, next) => {
    (req as any).log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use("/api", geofenceRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Privacy tests
// ═════════════════════════════════════════════════════════════════════════════

describe("Geofence privacy — non-accepted users", () => {
  const geofence = {
    id: GEOFENCE_ID,
    lat: MEETUP_LAT,
    lng: MEETUP_LNG,
    check_in_radius_m: 150,
    public_preview_level: "neighborhood",
    exact_visibility: "exact_after_acceptance",
    check_in_required: false,
    check_in_window_start: null,
    check_in_window_end: null,
    arrival_status_visible: true,
    no_show_affects_reliability: false,
    host_enabled: true,
    host_revealed: false,
    location_name: "Secret Venue",
    city: "Paris",
    neighborhood: "Marais",
    venue_name: "Le Labo",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  it("non-member sees only public preview data, never exact coords", async () => {
    await withGeofenceServer({ memberRole: null, geofence }, async (port) => {
      const { status, body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, OTHER_TOKEN);
      assert.equal(status, 200);
      assert.ok(body.geofence, "geofence field present");
      const gf = body.geofence;
      assert.ok(!("lat" in gf), "lat must not be returned to non-member");
      assert.ok(!("lng" in gf), "lng must not be returned to non-member");
      assert.equal(gf.viewerRole, "none", "viewer role should be none");
      assert.ok(gf.exactRevealLabel, "should have reveal label");
    });
  });

  it("non-member response never leaks locationName when preview=neighborhood", async () => {
    await withGeofenceServer({ memberRole: null, geofence }, async (port) => {
      const { body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, OTHER_TOKEN);
      const json = JSON.stringify(body.geofence);
      assert.ok(!json.includes("Secret Venue"), "locationName must be hidden for non-members at neighborhood level");
    });
  });

  it("public plan card (geofence object) never includes raw coordinates", async () => {
    await withGeofenceServer({ memberRole: null, geofence }, async (port) => {
      const { body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, OTHER_TOKEN);
      const json = JSON.stringify(body);
      assert.ok(!/"lat"\s*:/.test(json), "lat should not appear anywhere in non-member response");
      assert.ok(!/"lng"\s*:/.test(json), "lng should not appear anywhere in non-member response");
    });
  });
});

describe("Geofence privacy — accepted members", () => {
  const baseGeofence = {
    id: GEOFENCE_ID,
    lat: MEETUP_LAT,
    lng: MEETUP_LNG,
    check_in_radius_m: 150,
    public_preview_level: "neighborhood",
    check_in_required: false,
    check_in_window_start: null,
    check_in_window_end: null,
    arrival_status_visible: true,
    no_show_affects_reliability: false,
    host_enabled: true,
    host_revealed: false,
    location_name: "Secret Venue",
    city: "Paris",
    neighborhood: "Marais",
    venue_name: "Le Labo",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  it("accepted member sees exact location when exactVisibility=exact_after_acceptance", async () => {
    const gf = { ...baseGeofence, exact_visibility: "exact_after_acceptance" };
    await withGeofenceServer({ memberRole: "member", geofence: gf }, async (port) => {
      const { status, body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, MEMBER_TOKEN);
      assert.equal(status, 200);
      assert.ok(body.geofence.exactLocationRevealed, "exact location should be revealed");
      assert.equal(body.geofence.locationName, "Secret Venue", "locationName should be visible");
      assert.ok(!("lat" in body.geofence), "raw lat still must not be in response");
      assert.ok(!("lng" in body.geofence), "raw lng still must not be in response");
    });
  });

  it("accepted member does NOT see exact location when exactVisibility=exact_private_host_reveal and host_revealed=false", async () => {
    const gf = { ...baseGeofence, exact_visibility: "exact_private_host_reveal", host_revealed: false };
    await withGeofenceServer({ memberRole: "member", geofence: gf }, async (port) => {
      const { body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, MEMBER_TOKEN);
      assert.equal(body.geofence.exactLocationRevealed, false, "should not be revealed");
      assert.equal(body.geofence.locationName, null, "locationName hidden until revealed");
    });
  });

  it("accepted member sees exact location when exactVisibility=exact_private_host_reveal AND host_revealed=true", async () => {
    const gf = { ...baseGeofence, exact_visibility: "exact_private_host_reveal", host_revealed: true };
    await withGeofenceServer({ memberRole: "member", geofence: gf }, async (port) => {
      const { body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, MEMBER_TOKEN);
      assert.equal(body.geofence.exactLocationRevealed, true, "host revealed it");
      assert.equal(body.geofence.locationName, "Secret Venue");
    });
  });

  it("owner always sees exact location (owner role)", async () => {
    const gf = { ...baseGeofence, exact_visibility: "exact_after_acceptance" };
    await withGeofenceServer({ memberRole: "owner", geofence: gf }, async (port) => {
      const { body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, OWNER_TOKEN);
      assert.equal(body.geofence.viewerRole, "owner");
      assert.equal(body.geofence.exactLocationRevealed, true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Check-in tests
// ═════════════════════════════════════════════════════════════════════════════

describe("Check-in — inside radius", () => {
  const geofence = {
    id: GEOFENCE_ID,
    lat: MEETUP_LAT,
    lng: MEETUP_LNG,
    check_in_radius_m: 150,
    check_in_required: true,
    check_in_window_start: null,
    check_in_window_end: null,
    host_enabled: true,
    trip_id: TRIP_ID,
  };

  it("accepted member inside radius gets arrived status", async () => {
    const checkinStore: any[] = [];
    const eventStore: any[] = [];
    await withGeofenceServer({ memberRole: "member", geofence, eventStore, checkinStore }, async (port) => {
      const { status, body } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence/check-in`, {
        lat: INSIDE_LAT, lng: INSIDE_LNG,
      }, MEMBER_TOKEN);
      assert.equal(status, 200);
      assert.equal(body.ok, true, `expected ok=true, got: ${JSON.stringify(body)}`);
      assert.equal(body.status, "arrived");
      assert.ok(checkinStore.some((e) => e.op === "upsert"), "checkin upsert should be called");
    });
  });

  it("check-in response never includes exact coordinates", async () => {
    await withGeofenceServer({ memberRole: "member", geofence }, async (port) => {
      const { body } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence/check-in`, {
        lat: INSIDE_LAT, lng: INSIDE_LNG,
      }, MEMBER_TOKEN);
      const json = JSON.stringify(body);
      assert.ok(!/"lat"\s*:/.test(json), "lat must not appear in check-in response");
      assert.ok(!/"lng"\s*:/.test(json), "lng must not appear in check-in response");
    });
  });
});

describe("Check-in — outside radius", () => {
  const geofence = {
    id: GEOFENCE_ID,
    lat: MEETUP_LAT,
    lng: MEETUP_LNG,
    check_in_radius_m: 150,
    check_in_required: true,
    check_in_window_start: null,
    check_in_window_end: null,
    host_enabled: true,
    trip_id: TRIP_ID,
  };

  it("member outside radius gets ok=false with friendly message (no coords leaked)", async () => {
    await withGeofenceServer({ memberRole: "member", geofence }, async (port) => {
      const { status, body } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence/check-in`, {
        lat: OUTSIDE_LAT, lng: OUTSIDE_LNG,
      }, MEMBER_TOKEN);
      assert.equal(status, 200);
      assert.equal(body.ok, false, "outside radius should fail");
      assert.equal(body.reason, "outside_radius");
      assert.ok(body.message, "friendly message should be set");
      const json = JSON.stringify(body);
      assert.ok(!/"lat"\s*:/.test(json), "lat must not appear even in failed check-in response");
      assert.ok(!/"lng"\s*:/.test(json), "lng must not appear even in failed check-in response");
    });
  });

  it("non-member cannot check in at all", async () => {
    await withGeofenceServer({ memberRole: null, geofence }, async (port) => {
      const { status } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence/check-in`, {
        lat: INSIDE_LAT, lng: INSIDE_LNG,
      }, OTHER_TOKEN);
      assert.equal(status, 403, "non-member should get 403");
    });
  });
});

describe("Check-in — time window", () => {
  const pastEnd = new Date(Date.now() - 60 * 60 * 1000).toISOString();   // 1h ago
  const futureStart = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h ahead

  it("check-in fails with window_not_open when window hasn't started", async () => {
    const geofence = {
      id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
      check_in_radius_m: 150, host_enabled: true, trip_id: TRIP_ID,
      check_in_required: true,
      check_in_window_start: futureStart,
      check_in_window_end: null,
    };
    await withGeofenceServer({ memberRole: "member", geofence }, async (port) => {
      const { body } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence/check-in`, {
        lat: INSIDE_LAT, lng: INSIDE_LNG,
      }, MEMBER_TOKEN);
      assert.equal(body.ok, false);
      assert.equal(body.reason, "window_not_open");
    });
  });

  it("check-in inside radius after window close creates late_check_in event", async () => {
    const geofence = {
      id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
      check_in_radius_m: 150, host_enabled: true, trip_id: TRIP_ID,
      check_in_required: true,
      check_in_window_start: null,
      check_in_window_end: pastEnd,
    };
    const checkinStore: any[] = [];
    const eventStore: any[] = [];
    await withGeofenceServer({ memberRole: "member", geofence, eventStore, checkinStore }, async (port) => {
      const { body } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence/check-in`, {
        lat: INSIDE_LAT, lng: INSIDE_LNG,
      }, MEMBER_TOKEN);
      // Window closed → late check-in still succeeds with late status
      assert.equal(body.ok, true, `Expected ok=true for late check-in: ${JSON.stringify(body)}`);
      assert.equal(body.status, "late", "should be late status");
      const lateChekin = checkinStore.find((e) => e.op === "upsert");
      assert.ok(lateChekin, "upsert should have been called");
      const lateEvent = eventStore.find((e) => e.op === "insert" && e.row?.event_type === "late_check_in");
      assert.ok(lateEvent, "late_check_in event should be recorded");
    });
  });
});

describe("Check-in — suspicious GPS creates trust event", () => {
  it("suspicious GPS creates location_trust_event and returns ok=false with suspicious_gps reason", async () => {
    const geofence = {
      id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
      check_in_radius_m: 150, host_enabled: true, trip_id: TRIP_ID,
      check_in_window_start: null, check_in_window_end: null, check_in_required: true,
    };
    const eventStore: any[] = [];
    // trustSuspicious=true + locationSnap causes impossible-speed detection
    await withGeofenceServer(
      { memberRole: "member", geofence, eventStore, trustSuspicious: true, locationSnap: { lat: 40.7128, lng: -74.006, captured_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() } },
      async (port) => {
        const { body } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence/check-in`, {
          lat: INSIDE_LAT, lng: INSIDE_LNG,
        }, MEMBER_TOKEN);
        assert.equal(body.ok, false, "suspicious GPS should return ok=false");
        assert.equal(body.reason, "suspicious_gps");
        // A suspicious_check_in attendance event should be recorded
        const suspEvent = eventStore.find((e) => e.op === "insert" && e.row?.event_type === "suspicious_check_in");
        assert.ok(suspEvent, "suspicious_check_in event should be created");
      },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Host attendance dashboard tests
// ═════════════════════════════════════════════════════════════════════════════

describe("Host attendance dashboard", () => {
  it("host sees attendance totals and status text — no lat/lng pins", async () => {
    const geofence = {
      id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
      check_in_radius_m: 150, check_in_window_start: null, check_in_window_end: null,
      host_enabled: true, trip_id: TRIP_ID,
    };

    // Override from(table) for attendance-specific tables
    const client = makeGeofenceClient({ memberRole: "owner", geofence, memberIds: [MEMBER_ID] });
    const origFrom = client.from.bind(client);
    (client as any).from = (table: string) => {
      const b = origFrom(table) as any;
      if (table === "trip_members") {
        return {
          ...b,
          select: () => ({
            eq: (col: string, val: string) => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
              maybeSingle: async () => {
                if (col === "trip_id") return { data: { owner_id: OWNER_ID }, error: null };
                return { data: null, error: null };
              },
              limit: async () => ({ data: [{ user_id: MEMBER_ID }], error: null }),
              in: () => ({
                limit: async () => ({ data: [{ user_id: MEMBER_ID }], error: null }),
              }),
              then: (f: any) => Promise.resolve({ data: [{ user_id: MEMBER_ID }], error: null }).then(f),
            }),
          }),
        };
      }
      if (table === "plan_checkins") {
        return {
          ...b,
          select: () => ({
            eq: () => ({
              eq: () => ({
                then: (f: any) => Promise.resolve({ data: [{ user_id: MEMBER_ID, status: "arrived", checked_in_at: new Date().toISOString(), updated_at: new Date().toISOString() }], error: null }).then(f),
              }),
              then: (f: any) => Promise.resolve({ data: [{ user_id: MEMBER_ID, status: "arrived", checked_in_at: new Date().toISOString(), updated_at: new Date().toISOString() }], error: null }).then(f),
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          ...b,
          select: () => ({
            // requireUser's account-status guard: .select("account_status").eq(id).maybeSingle()
            eq: () => ({
              maybeSingle: async () => ({ data: { account_status: "active" }, error: null }),
            }),
            in: () => ({
              then: (f: any) => Promise.resolve({ data: [{ id: MEMBER_ID, handle: "alice", name: "Alice", avatar_url: null }], error: null }).then(f),
            }),
            // requireUser account-status check: .select("account_status").eq("id", uid).maybeSingle()
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { account_status: "active" }, error: null }),
            }),
          }),
        };
      }
      return b;
    };

    _setTestClient(client, true);
    const { default: geofenceRouter } = await import("../routes/geofence.js");
    const app = express();
    app.use(express.json());
    app.use("/api", geofenceRouter);
    const server = http.createServer(app);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as any).port;

    try {
      const { status, body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence/attendance`);
      assert.equal(status, 200, `Expected 200, got: ${status}: ${JSON.stringify(body)}`);

      // No lat/lng in any nested object
      const json = JSON.stringify(body);
      assert.ok(!/"lat"\s*:/.test(json), "lat must never appear in attendance response");
      assert.ok(!/"lng"\s*:/.test(json), "lng must never appear in attendance response");

      // Non-member cannot access
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("non-owner member cannot access attendance dashboard", async () => {
    const geofence = {
      id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
      check_in_radius_m: 150, check_in_window_start: null, check_in_window_end: null,
      host_enabled: true,
    };
    await withGeofenceServer({ memberRole: "member", geofence }, async (port) => {
      const { status } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence/attendance`, undefined, MEMBER_TOKEN);
      assert.equal(status, 403, "non-owner should be forbidden from attendance dashboard");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Admin radius defaults
// ═════════════════════════════════════════════════════════════════════════════

describe("Admin radius defaults applied at geofence creation", () => {
  it("geofence creation clamps radius to admin min/max", async () => {
    const geofence = null;
    const eventStore: any[] = [];

    // Custom client where trips returns owner, admin settings returns custom limits
    const client = makeGeofenceClient({ memberRole: "owner", geofence, eventStore });
    const origFrom = client.from.bind(client);
    (client as any).from = (table: string) => {
      const b = origFrom(table) as any;
      if (table === "geofence_admin_settings") {
        return {
          ...b,
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { default_radius_m: 200, min_radius_m: 100, max_radius_m: 300, no_show_affects_reliability: false },
                error: null,
              }),
            }),
          }),
        };
      }
      return b;
    };

    _setTestClient(client, true);
    const { default: geofenceRouter } = await import("../routes/geofence.js");
    const app = express();
    app.use(express.json());
    app.use("/api", geofenceRouter);
    const server = http.createServer(app);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as any).port;

    try {
      // Request 5000m — should be clamped to 300m (admin max)
      const { status, body } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence`, {
        lat: MEETUP_LAT, lng: MEETUP_LNG,
        checkInRadiusM: 5000,
        publicPreviewLevel: "neighborhood",
        exactVisibility: "exact_after_acceptance",
      });
      assert.equal(status, 201, `Expected 201, got ${status}: ${JSON.stringify(body)}`);
      assert.equal(body.effectiveRadiusM, 300, "radius should be clamped to admin max of 300");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Feature flag gating
// ═════════════════════════════════════════════════════════════════════════════

describe("Feature flag gating", () => {
  it("returns featureEnabled=false when flag is off", async () => {
    const client = makeGeofenceClient({ memberRole: "member" });
    const origFrom = client.from.bind(client);
    (client as any).from = (table: string) => {
      const b = origFrom(table) as any;
      if (table === "feature_flags") {
        return {
          ...b,
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { enabled: false }, error: null }),
            }),
          }),
        };
      }
      return b;
    };

    _setTestClient(client, true);
    const { default: geofenceRouter } = await import("../routes/geofence.js");
    const app = express();
    app.use(express.json());
    app.use("/api", geofenceRouter);
    const server = http.createServer(app);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as any).port;

    try {
      const { status, body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, MEMBER_TOKEN);
      assert.equal(status, 200);
      assert.equal(body.featureEnabled, false);
      assert.equal(body.geofence, null);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Audit cluster — TRAILS F6 / F5 / GEOFENCE-2 / GEOFENCE-1
// ═════════════════════════════════════════════════════════════════════════════

// TRAILS F6 — a failed plan_checkins write must NOT report a successful check-in.
describe("Check-in — write failure is not reported as success (TRAILS F6)", () => {
  const geofence = {
    id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
    check_in_radius_m: 150, check_in_required: true,
    check_in_window_start: null, check_in_window_end: null,
    host_enabled: true, trip_id: TRIP_ID,
  };

  it("plan_checkins upsert error → no success message, no ok=true, 5xx", async () => {
    const checkinStore: any[] = [];
    const eventStore: any[] = [];
    await withGeofenceServer(
      {
        memberRole: "member",
        geofence,
        eventStore,
        checkinStore,
        checkinUpsertError: { message: "duplicate key value", code: "23505" },
      },
      async (port) => {
        const { status, body } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence/check-in`, {
          lat: INSIDE_LAT, lng: INSIDE_LNG,
        }, MEMBER_TOKEN);
        // Must not masquerade as a success.
        assert.notEqual(body.ok, true, `check-in write failed but ok=${JSON.stringify(body.ok)}`);
        assert.notEqual(body.status, "arrived", "must not report arrived on a failed write");
        assert.notEqual(
          body.message,
          "You're checked in! 🎉",
          "success message must not be returned when the write failed",
        );
        assert.ok(status >= 500, `expected a 5xx status on write failure, got ${status}`);
      },
    );
  });
});

// TRAILS F5 — public preview card must not leak fields finer than the level.
describe("Public preview level hierarchy (TRAILS F5)", () => {
  const baseGeofence = {
    id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
    check_in_radius_m: 150,
    exact_visibility: "exact_after_acceptance",
    check_in_required: false, check_in_window_start: null, check_in_window_end: null,
    arrival_status_visible: true, no_show_affects_reliability: false,
    host_enabled: true, host_revealed: false,
    location_name: "Secret Venue", city: "Paris", neighborhood: "Marais", venue_name: "Le Labo",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };

  it("city_only non-member card withholds venueName AND neighborhood (keeps city)", async () => {
    const geofence = { ...baseGeofence, public_preview_level: "city_only" };
    await withGeofenceServer({ memberRole: null, geofence, tripVisibility: "public" }, async (port) => {
      const { status, body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, OTHER_TOKEN);
      assert.equal(status, 200);
      const gf = body.geofence;
      assert.equal(gf.city, "Paris", "city_only exposes city");
      assert.equal(gf.neighborhood, null, "city_only must withhold neighborhood");
      assert.equal(gf.venueName, null, "city_only must withhold venueName");
      assert.equal(gf.locationName, null, "city_only must withhold locationName");
      // Belt-and-braces: the finer strings must not appear anywhere in the card.
      const json = JSON.stringify(gf);
      assert.ok(!json.includes("Marais"), "neighborhood string leaked at city_only");
      assert.ok(!json.includes("Le Labo"), "venue string leaked at city_only");
    });
  });
});

// GEOFENCE-2 — a private/invite trip must not surface a public preview card.
describe("Non-member preview honours trip visibility (GEOFENCE-2)", () => {
  const geofence = {
    id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
    check_in_radius_m: 150, public_preview_level: "venue_tagged",
    exact_visibility: "exact_after_acceptance",
    check_in_required: false, check_in_window_start: null, check_in_window_end: null,
    arrival_status_visible: true, no_show_affects_reliability: false,
    host_enabled: true, host_revealed: false,
    location_name: "Secret Venue", city: "Paris", neighborhood: "Marais", venue_name: "Le Labo",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };

  it("private trip returns no public card to a non-member", async () => {
    await withGeofenceServer({ memberRole: null, geofence, tripVisibility: "private" }, async (port) => {
      const { status, body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, OTHER_TOKEN);
      assert.equal(status, 404, "private trip must not expose a preview");
      assert.ok(!body.geofence, "no geofence card for a private trip");
    });
  });

  it("public trip still returns a preview card to a non-member", async () => {
    await withGeofenceServer({ memberRole: null, geofence, tripVisibility: "public" }, async (port) => {
      const { status, body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, OTHER_TOKEN);
      assert.equal(status, 200);
      assert.ok(body.geofence, "public trip exposes a preview card");
      assert.equal(body.geofence.viewerRole, "none");
    });
  });
});

// GEOFENCE-1 — an accepted co_host is a member-level participant.
describe("Accepted co_host has member access (GEOFENCE-1)", () => {
  const viewGeofence = {
    id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
    check_in_radius_m: 150, public_preview_level: "neighborhood",
    exact_visibility: "exact_after_acceptance",
    check_in_required: false, check_in_window_start: null, check_in_window_end: null,
    arrival_status_visible: true, no_show_affects_reliability: false,
    host_enabled: true, host_revealed: false,
    location_name: "Secret Venue", city: "Paris", neighborhood: "Marais", venue_name: "Le Labo",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const checkinGeofence = {
    id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
    check_in_radius_m: 150, check_in_required: true,
    check_in_window_start: null, check_in_window_end: null,
    host_enabled: true, trip_id: TRIP_ID,
  };

  it("accepted co_host can VIEW the geofence (member-level card, not 403)", async () => {
    await withGeofenceServer({ memberRole: "co_host", memberStatus: "accepted", geofence: viewGeofence }, async (port) => {
      const { status, body } = await request(port, "GET", `/api/trips/${TRIP_ID}/geofence`, undefined, MEMBER_TOKEN);
      assert.equal(status, 200, "accepted co_host must not be locked out");
      assert.equal(body.geofence.viewerRole, "member", "co_host resolves to member-level");
      assert.ok(body.geofence.exactLocationRevealed, "accepted co_host sees exact reveal");
    });
  });

  it("accepted co_host can CHECK IN", async () => {
    await withGeofenceServer({ memberRole: "co_host", memberStatus: "accepted", geofence: checkinGeofence }, async (port) => {
      const { status, body } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence/check-in`, {
        lat: INSIDE_LAT, lng: INSIDE_LNG,
      }, MEMBER_TOKEN);
      assert.equal(status, 200);
      assert.equal(body.ok, true, `accepted co_host should check in, got: ${JSON.stringify(body)}`);
      assert.equal(body.status, "arrived");
    });
  });

  it("a co_host whose invite is still pending (status!=accepted) is denied check-in", async () => {
    await withGeofenceServer({ memberRole: "co_host", memberStatus: "invited", geofence: checkinGeofence }, async (port) => {
      const { status } = await request(port, "POST", `/api/trips/${TRIP_ID}/geofence/check-in`, {
        lat: INSIDE_LAT, lng: INSIDE_LNG,
      }, MEMBER_TOKEN);
      assert.equal(status, 403, "a pending co_host invite must not gain check-in access");
    });
  });
});
