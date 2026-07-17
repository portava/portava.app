/**
 * Malformed-tripId guard — admin trip routes
 *
 * Confirms that every admin route accepting a :tripId param returns 400
 * ("invalid_payload") for non-UUID values and never reaches the DB.
 *
 * Routes covered:
 *   POST /admin/trips/:tripId/hide
 *   POST /admin/trips/:tripId/report-resolve
 *   POST /admin/geofence/:tripId/override-reveal
 *   GET  /admin/geofence/:tripId/suspicious-checkins
 *
 * Run:
 *   node --import tsx/esm --test src/test/adminTripIdGuard.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "fake.jwt.token";
const USER_ID    = "aaaaaaaa-1111-1111-1111-000000000001";

const MALFORMED_TRIP_IDS = ["not-a-uuid", "123", "abc"];

// ── Server ────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

// ── Fake client builder ───────────────────────────────────────────────────────

/**
 * Admin client that throws if any "trip-adjacent" DB table is queried —
 * proves the UUID guard fires before any DB round-trip.
 */
function makeGuardingClient() {
  const profileRow = {
    id: USER_ID,
    role: "admin",
    account_status: "active",
    handle: "testuser",
    display_name: null,
    username: null,
  };

  const TRIP_TABLES = new Set(["trips", "plan_geofences", "plan_attendance_events"]);

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (!token || token === "bad") {
          return { data: { user: null }, error: { message: "invalid token" } };
        }
        return { data: { user: { id: USER_ID } }, error: null };
      },
    },
    from: (table: string) => {
      if (TRIP_TABLES.has(table)) {
        throw new Error(
          `DB must not be reached for a malformed tripId (table: ${table})`
        );
      }
      const b: any = {
        select:      () => b,
        eq:          () => b,
        neq:         () => b,
        is:          () => b,
        in:          () => b,
        update:      () => b,
        insert:      () => b,
        upsert:      () => b,
        delete:      () => b,
        order:       () => b,
        limit:       () => b,
        maybeSingle: () => ({ data: profileRow, error: null }),
        single:      () => ({ data: profileRow, error: null }),
        then:        (resolve: any) =>
          Promise.resolve({ data: [profileRow], error: null }).then(resolve),
        get count() { return 1; },
      };
      return b;
    },
    rpc: async () => ({ data: [], error: null }),
  };
  return client;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function request(
  method: "GET" | "POST",
  path: string,
  token?: string,
  body?: object,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token !== undefined) {
      headers["authorization"] = `Bearer ${token}`;
    }
    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) {
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", adminRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /admin/trips/:tripId/hide — malformed tripId guard", () => {
  it("returns 400 with invalid_payload for non-UUID tripIds and never reaches the DB", async () => {
    const fc = makeGuardingClient();
    _setTestClient(fc, true);
    _setTestServiceClient(fc);

    for (const malformed of MALFORMED_TRIP_IDS) {
      const r = await request(
        "POST",
        `/admin/trips/${malformed}/hide`,
        FAKE_TOKEN,
        { reason: "test" },
      );
      assert.equal(
        r.status,
        400,
        `[tripId="${malformed}"] expected 400, got ${r.status}: ${JSON.stringify(r.body)}`,
      );
      assert.equal(
        r.body?.error,
        "invalid_payload",
        `[tripId="${malformed}"] expected error "invalid_payload", got "${r.body?.error}"`,
      );
    }
  });
});

describe("POST /admin/trips/:tripId/report-resolve — malformed tripId guard", () => {
  it("returns 400 with invalid_payload for non-UUID tripIds and never reaches the DB", async () => {
    const fc = makeGuardingClient();
    _setTestClient(fc, true);
    _setTestServiceClient(fc);

    for (const malformed of MALFORMED_TRIP_IDS) {
      const r = await request(
        "POST",
        `/admin/trips/${malformed}/report-resolve`,
        FAKE_TOKEN,
        { resolution: "accepted" },
      );
      assert.equal(
        r.status,
        400,
        `[tripId="${malformed}"] expected 400, got ${r.status}: ${JSON.stringify(r.body)}`,
      );
      assert.equal(
        r.body?.error,
        "invalid_payload",
        `[tripId="${malformed}"] expected error "invalid_payload", got "${r.body?.error}"`,
      );
    }
  });
});

describe("POST /admin/geofence/:tripId/override-reveal — malformed tripId guard", () => {
  it("returns 400 with invalid_payload for non-UUID tripIds and never reaches the DB", async () => {
    const fc = makeGuardingClient();
    _setTestClient(fc, true);
    _setTestServiceClient(fc);

    for (const malformed of MALFORMED_TRIP_IDS) {
      const r = await request(
        "POST",
        `/admin/geofence/${malformed}/override-reveal`,
        FAKE_TOKEN,
      );
      assert.equal(
        r.status,
        400,
        `[tripId="${malformed}"] expected 400, got ${r.status}: ${JSON.stringify(r.body)}`,
      );
      assert.equal(
        r.body?.error,
        "invalid_payload",
        `[tripId="${malformed}"] expected error "invalid_payload", got "${r.body?.error}"`,
      );
    }
  });
});

describe("GET /admin/geofence/:tripId/suspicious-checkins — malformed tripId guard", () => {
  it("returns 400 with invalid_payload for non-UUID tripIds and never reaches the DB", async () => {
    const fc = makeGuardingClient();
    _setTestClient(fc, true);
    _setTestServiceClient(fc);

    for (const malformed of MALFORMED_TRIP_IDS) {
      const r = await request(
        "GET",
        `/admin/geofence/${malformed}/suspicious-checkins`,
        FAKE_TOKEN,
      );
      assert.equal(
        r.status,
        400,
        `[tripId="${malformed}"] expected 400, got ${r.status}: ${JSON.stringify(r.body)}`,
      );
      assert.equal(
        r.body?.error,
        "invalid_payload",
        `[tripId="${malformed}"] expected error "invalid_payload", got "${r.body?.error}"`,
      );
    }
  });
});
