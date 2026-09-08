/**
 * WRITE-PRECONDITION unchecked reads — lane B routes.
 *
 * The defect: supabase-js RESOLVES on a database error. `const { data } = await
 * sc.from(T)…maybeSingle()` yields `data === null` both when the row is absent
 * and when T could not be read at all. Every read exercised here is the
 * precondition for a write to that SAME table — an idempotency guard, a
 * duplicate guard, or a merge base — so the "absent" reading is the one that
 * lets the write happen (or lets it happen with the wrong values).
 *
 * Each route below gets:
 *   FAILURE — the read is made to resolve as `{ data: null, error }` and the
 *             route must refuse with the file's own db_error shape (500,
 *             `error: "db_error"`), with the write NOT recorded; or, for
 *             POST /moderation/report, must deliberately proceed.
 *   HEALTHY — the same route with a working table, proving the refusal is not
 *             blanket and the guard it protects still does its job.
 *
 * VACUITY TRAPS AVOIDED (both have produced false green in this repo before):
 *   1. No `assert.notEqual(status, 200)` anywhere. A request rejected at input
 *      validation, at auth, or at the membership gate never reaches the read
 *      under test and would satisfy that. Every assertion names the exact
 *      status AND the exact `error` code, and the write-side assertions read
 *      the fake's `inserted` / `updated` buckets so "refused" means "did not
 *      write", not merely "returned non-200".
 *   2. The `req.log` shim the real server installs is present. Without it these
 *      handlers throw a TypeError on `req.log.error(...)` and the resulting
 *      500-from-crash would masquerade as a deliberate refusal — and, worse,
 *      would pass even with the fix removed.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/p2LaneBWritePreconditions.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";

import collectionsRouter from "../routes/collections.js";
import devicesRouter from "../routes/devices.js";
import moderationRouter from "../routes/moderation.js";
import telegraphFeedbackRouter from "../routes/telegraphFeedback.js";
import circleRouter from "../routes/circle.js";
import neighborhoodsRouter from "../routes/neighborhoods.js";
import tripsExpansionRouter from "../routes/trips-expansion.js";
import geofenceRouter from "../routes/geofence.js";
import stampAdmireRouter from "../routes/stampAdmire.js";

const USER   = "aaaaaaaa-0000-4000-a000-000000000001";
const OTHER  = "bbbbbbbb-0000-4000-a000-000000000002";
const TRIP   = "cccccccc-0000-4000-a000-000000000003";
const STAMP  = "dddddddd-0000-4000-a000-000000000004";
const TOKEN  = "tok-user";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

// ── Capturing log shim ──────────────────────────────────────────────────────
// Cleared by `install()` at the start of every test.
interface LogEntry { level: string; ctx: any; msg: string }
let logged: LogEntry[] = [];
const captureLog: any = {
  info:  (ctx: any, msg?: string) => logged.push({ level: "info",  ctx, msg: String(msg ?? "") }),
  warn:  (ctx: any, msg?: string) => logged.push({ level: "warn",  ctx, msg: String(msg ?? "") }),
  error: (ctx: any, msg?: string) => logged.push({ level: "error", ctx, msg: String(msg ?? "") }),
  debug: (ctx: any, msg?: string) => logged.push({ level: "debug", ctx, msg: String(msg ?? "") }),
};
captureLog.child = () => captureLog;

// ── Server ──────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // The `req.log` shim the real server installs, but CAPTURING rather than
  // no-op: for the one route in this file that is deliberately fail-OPEN
  // (POST /moderation/report) the log line IS the behaviour under test, and a
  // no-op shim would make that test pass with the fix removed.
  app.use((req, _res, next) => { (req as any).log = captureLog; next(); });
  app.use("/api", collectionsRouter);
  app.use("/api", devicesRouter);
  app.use("/api", moderationRouter);
  app.use("/api", telegraphFeedbackRouter);
  app.use("/api", circleRouter);
  app.use("/api", neighborhoodsRouter);
  app.use("/api", tripsExpansionRouter);
  app.use("/api", geofenceRouter);
  app.use("/api", stampAdmireRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
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

/** Install a fake client and return the spec, whose `inserted` / `updated`
 *  buckets are the write-side evidence each test asserts on. */
function install(spec: any) {
  logged = [];
  spec.users = { [TOKEN]: USER };
  spec.inserted ??= {};
  spec.updated  ??= {};
  spec.rows.profiles ??= [{ id: USER, account_status: "active" }];
  _setTestClient(makeFailClosedClient(spec), true);
  return spec;
}

/** The db_error envelope this codebase sends (lib/http.ts: db_error → 500,
 *  message sanitized). Asserted by code AND status, never by "not 200". */
function assertDbError(r: { status: number; body: any }) {
  assert.equal(r.body?.error, "db_error", `expected the db_error envelope, got ${JSON.stringify(r.body)}`);
  assert.equal(r.status, 500);
}

// ═══════════════════════════════════════════════════════════════════════════
// collections — POST /users/me/collections
// The read picks the new row's `position`. Unreadable → "no collections" → 1,
// stamped on top of the user's real first collection.
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /users/me/collections — collections position read", () => {
  it("FAILURE: an unreadable collections table refuses instead of stamping position 1", async () => {
    const spec = install({
      rows: { collections: [{ id: "c1", owner_id: USER, position: 3 }] },
      failOn: (ctx: any) => (ctx.table === "collections" ? READ_FAIL : null),
    });
    const r = await req("POST", "/api/users/me/collections", { name: "Lisbon" });
    assertDbError(r);
    assert.equal(spec.inserted.collections, undefined, "no collection may be written on an unreadable table");
  });

  it("HEALTHY: an existing collection at position 3 gives the new one position 4", async () => {
    const spec = install({ rows: { collections: [{ id: "c1", owner_id: USER, position: 3 }] } });
    const r = await req("POST", "/api/users/me/collections", { name: "Lisbon" });
    assert.equal(r.status, 201, `expected the create to succeed; got ${JSON.stringify(r.body)}`);
    assert.equal(spec.inserted.collections?.[0]?.position, 4);
  });

  it("HEALTHY: a genuinely empty collections table still starts at position 1", async () => {
    const spec = install({ rows: { collections: [] } });
    const r = await req("POST", "/api/users/me/collections", { name: "First" });
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.equal(spec.inserted.collections?.[0]?.position, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// devices — POST /me/crypto-devices
// The fingerprint lookup is the only thing stopping a second device id being
// minted for the same physical device, orphaning its public_key.
// ═══════════════════════════════════════════════════════════════════════════

const FP = "fingerprint-abc";

describe("POST /me/crypto-devices — devices fingerprint lookup", () => {
  it("FAILURE: an unreadable devices table refuses instead of minting a duplicate device", async () => {
    const spec = install({
      rows: { devices: [{ id: "d1", user_id: USER, device_fingerprint: FP, platform: "ios", public_key: "pk", key_package_count: 5 }] },
      failOn: (ctx: any) => (ctx.table === "devices" ? READ_FAIL : null),
    });
    const r = await req("POST", "/api/me/crypto-devices", { platform: "ios", deviceFingerprint: FP });
    assertDbError(r);
    assert.equal(spec.inserted.devices, undefined, "no second device row may be minted");
  });

  it("HEALTHY: a known fingerprint returns the existing device, not a new one", async () => {
    const spec = install({
      rows: { devices: [{ id: "d1", user_id: USER, device_fingerprint: FP, platform: "ios", public_key: "pk", key_package_count: 5 }] },
    });
    const r = await req("POST", "/api/me/crypto-devices", { platform: "ios", deviceFingerprint: FP });
    assert.equal(r.status, 200, `got ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.device?.id, "d1");
    assert.equal(spec.inserted.devices, undefined);
  });

  it("HEALTHY: an unknown fingerprint still registers a new device", async () => {
    const spec = install({ rows: { devices: [] } });
    const r = await req("POST", "/api/me/crypto-devices", { platform: "ios", deviceFingerprint: "new-fp" });
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.equal(spec.inserted.devices?.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// moderation — POST /moderation/report
// The ONE site in this lane that must fail OPEN: the dedupe lookup is a
// convenience, the report is a safety artifact. A duplicate open report is
// recoverable; a report never filed is not.
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /moderation/report — duplicate-collapse read", () => {
  it("FAILURE: an unreadable moderation_reports table still FILES the report", async () => {
    const spec = install({
      rows: { moderation_reports: [] },
      failOn: (ctx: any) => (ctx.table === "moderation_reports" ? READ_FAIL : null),
    });
    const r = await req("POST", "/api/moderation/report", {
      subjectType: "user", subjectId: OTHER, category: "harassment",
    });
    assert.equal(r.status, 201, `the report must still be recorded; got ${JSON.stringify(r.body)}`);
    assert.equal(spec.inserted.moderation_reports?.length, 1, "the safety report must reach the table");
    assert.equal(spec.inserted.moderation_reports[0].reporter_id, USER);
    // ── The actual subject of this test ────────────────────────────────────
    // Filing the report is what the route did BEFORE the fix too, so asserting
    // only the 201 would measure nothing. What the fix changes is that the lost
    // dedupe is no longer silent: the read error must be bound and logged, or a
    // run of duplicate open reports has no discoverable cause.
    const line = logged.find(
      (l) => l.level === "error" && l.msg.includes("duplicate-collapse read failed"),
    );
    assert.ok(
      line,
      `the failed dedupe read must be logged; captured: ${JSON.stringify(logged.map((l) => [l.level, l.msg]))}`,
    );
    assert.equal((line!.ctx as any).err?.code, "08006", "and must carry the resolved DB error");
    assert.equal((line!.ctx as any).subjectId, OTHER);
  });

  it("HEALTHY: an existing open report is still collapsed rather than duplicated", async () => {
    const spec = install({
      rows: {
        moderation_reports: [{ id: "r1", reporter_id: USER, subject_type: "user", subject_id: OTHER, status: "open" }],
      },
    });
    const r = await req("POST", "/api/moderation/report", {
      subjectType: "user", subjectId: OTHER, category: "harassment",
    });
    assert.equal(r.status, 200, `got ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.reportId, "r1");
    assert.equal(spec.inserted.moderation_reports, undefined, "the collapse must not write a second row");
    assert.equal(
      logged.some((l) => l.msg.includes("duplicate-collapse read failed")), false,
      "a healthy read must not log a failure",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// telegraphFeedback — POST /telegraph/recommendations/:id/feedback
// The profile read is the base of an UPDATE of that same row. Unreadable →
// defaultInferred() → the user's whole learned profile overwritten with blanks.
// ═══════════════════════════════════════════════════════════════════════════

const REC = "eeeeeeee-0000-4000-a000-000000000005";
const LEARNED = JSON.stringify({
  categoryAffinities: { food: 0.91 },
  dismissedCategories: [],
  savedCategories: ["food"],
  addedToPlanCategories: [],
});

describe("POST /telegraph/recommendations/:id/feedback — preference profile read", () => {
  it("FAILURE: an unreadable profile refuses instead of overwriting it with defaults", async () => {
    const spec = install({
      rows: { user_preference_profiles: [{ user_id: USER, inferred_preferences_json: LEARNED }] },
      failOn: (ctx: any) => (ctx.table === "user_preference_profiles" ? READ_FAIL : null),
    });
    const r = await req("POST", `/api/telegraph/recommendations/${REC}/feedback`, {
      category: "food", signal: "less_like_this",
    });
    assertDbError(r);
    assert.equal(
      spec.updated.user_preference_profiles, undefined,
      "the learned profile must not be overwritten by a blank one",
    );
  });

  it("HEALTHY: a readable profile is updated from its stored values", async () => {
    const spec = install({
      rows: { user_preference_profiles: [{ user_id: USER, inferred_preferences_json: LEARNED }] },
    });
    const r = await req("POST", `/api/telegraph/recommendations/${REC}/feedback`, {
      category: "food", signal: "more_like_this",
    });
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    const written = spec.updated.user_preference_profiles?.[0];
    assert.ok(written, "the profile update must still happen on the healthy path");
    const parsed = JSON.parse(String(written.inferred_preferences_json));
    assert.equal(
      parsed.savedCategories?.includes("food"), true,
      "the write must be derived from the STORED profile — a blank defaultInferred() has an empty savedCategories",
    );
    assert.ok(
      parsed.categoryAffinities.food > 0.9,
      "and must carry forward the learned affinity rather than starting from 0",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// circle — PATCH /circle/settings
// The settings read decides `isEnabling`, which decides whether the upsert
// rewrites consent_version / consented_at — the record of WHEN the user
// consented to location sharing.
// ═══════════════════════════════════════════════════════════════════════════

describe("PATCH /circle/settings — visibility settings read", () => {
  it("FAILURE: an unreadable settings row refuses instead of rewriting consent", async () => {
    const spec = install({
      rows: {
        circle_visibility_settings: [{
          user_id: USER, global_enabled: true, consented_at: "2025-01-01T00:00:00.000Z", consent_version: "v1",
        }],
      },
      failOn: (ctx: any) => (ctx.table === "circle_visibility_settings" ? READ_FAIL : null),
    });
    const r = await req("PATCH", "/api/circle/settings", { globalEnabled: true, consentVersion: "v1" });
    assertDbError(r);
    assert.equal(
      spec.inserted.circle_visibility_settings, undefined,
      "no consent timestamp may be rewritten on an unreadable settings row",
    );
  });

  it("HEALTHY: an already-enabled user toggling pause is not asked to re-consent", async () => {
    const spec = install({
      rows: {
        circle_visibility_settings: [{
          user_id: USER, global_enabled: true, consented_at: "2025-01-01T00:00:00.000Z", consent_version: "v1",
        }],
      },
    });
    const r = await req("PATCH", "/api/circle/settings", { isPaused: true });
    assert.equal(r.status, 200, `got ${JSON.stringify(r.body)}`);
    const written = spec.inserted.circle_visibility_settings?.[0];
    assert.ok(written, "the settings upsert must still happen");
    assert.equal(written.consented_at, undefined, "and must not touch the stored consent timestamp");
  });

  it("HEALTHY: a genuinely absent row still demands consent before enabling", async () => {
    install({ rows: { circle_visibility_settings: [] } });
    const r = await req("PATCH", "/api/circle/settings", { globalEnabled: true });
    assert.equal(r.body?.error, "consent_required", `got ${JSON.stringify(r.body)}`);
    assert.equal(r.status, 409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// neighborhoods — PUT /trips/:tripId/area-preferences
// The read is the MERGE BASE for a partial PUT. Unreadable → the fields this
// PUT does not carry are upserted as defaults, silently erasing them.
// ═══════════════════════════════════════════════════════════════════════════

function tripRows(extra: Record<string, any[]> = {}) {
  return {
    profiles: [{ id: USER, account_status: "active" }],
    trips: [{ id: TRIP, owner_id: USER }],
    trip_members: [],
    ...extra,
  };
}

describe("PUT /trips/:tripId/area-preferences — merge-base read", () => {
  it("FAILURE: an unreadable preferences row refuses instead of clobbering the untouched field", async () => {
    const spec = install({
      rows: tripRows({
        trip_area_preferences: [{ trip_id: TRIP, user_id: USER, sleep_vs_play: "close", priorities: { food: 0.9 } }],
      }),
      failOn: (ctx: any) => (ctx.table === "trip_area_preferences" ? READ_FAIL : null),
    });
    const r = await req("PUT", `/api/trips/${TRIP}/area-preferences`, { sleepVsPlay: "inside" });
    assertDbError(r);
    assert.equal(
      spec.inserted.trip_area_preferences, undefined,
      "the saved priorities must not be overwritten with {} ",
    );
  });

  it("HEALTHY: a partial PUT still merges the field it did not carry", async () => {
    const spec = install({
      rows: tripRows({
        trip_area_preferences: [{ trip_id: TRIP, user_id: USER, sleep_vs_play: "close", priorities: { food: 0.9 } }],
      }),
    });
    const r = await req("PUT", `/api/trips/${TRIP}/area-preferences`, { sleepVsPlay: "inside" });
    assert.equal(r.status, 200, `got ${JSON.stringify(r.body)}`);
    const written = spec.inserted.trip_area_preferences?.[0];
    assert.ok(written, "the upsert must still happen");
    assert.equal(written.sleep_vs_play, "inside");
    assert.deepEqual(written.priorities, { food: 0.9 }, "the untouched field must survive the partial PUT");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// trips-expansion — POST /trips/:tripId/saved-places
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /trips/:tripId/saved-places — duplicate guard", () => {
  it("FAILURE: an unreadable trip_saved_places refuses instead of saving a second copy", async () => {
    const spec = install({
      rows: tripRows({
        trip_saved_places: [{ id: "sp1", trip_id: TRIP, user_id: USER, place_id: "p1" }],
      }),
      failOn: (ctx: any) => (ctx.table === "trip_saved_places" ? READ_FAIL : null),
    });
    const r = await req("POST", `/api/trips/${TRIP}/saved-places`, { placeId: "p1", placeName: "Time Out Market" });
    assertDbError(r);
    assert.equal(spec.inserted.trip_saved_places, undefined, "no duplicate saved place may be written");
  });

  it("HEALTHY: a real duplicate still gets the 409", async () => {
    const spec = install({
      rows: tripRows({
        trip_saved_places: [{ id: "sp1", trip_id: TRIP, user_id: USER, place_id: "p1" }],
      }),
    });
    const r = await req("POST", `/api/trips/${TRIP}/saved-places`, { placeId: "p1", placeName: "Time Out Market" });
    assert.equal(r.body?.error, "duplicate", `got ${JSON.stringify(r.body)}`);
    assert.equal(r.status, 409);
    assert.equal(spec.inserted.trip_saved_places, undefined);
  });

  it("HEALTHY: a new place is still saved", async () => {
    const spec = install({ rows: tripRows({ trip_saved_places: [] }) });
    const r = await req("POST", `/api/trips/${TRIP}/saved-places`, { placeId: "p2", placeName: "Belém" });
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.equal(spec.inserted.trip_saved_places?.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// geofence — POST /trips/:tripId/geofence
// The read chooses UPDATE vs INSERT against a UNIQUE(trip_id). Unreadable →
// INSERT over an existing geofence, so the host's edit is lost.
// ═══════════════════════════════════════════════════════════════════════════

const GEOFENCE_BODY = { lat: 38.72, lng: -9.14, checkInRadiusM: 300 };

function geofenceRows(extra: Record<string, any[]> = {}) {
  return tripRows({
    geofence_admin_settings: [],
    feature_flags: [{ flag: "plan_geofence_enabled", enabled: true }],
    plan_geofences: [],
    ...extra,
  });
}

describe("POST /trips/:tripId/geofence — existing-geofence read", () => {
  it("FAILURE: an unreadable plan_geofences refuses instead of inserting over the existing row", async () => {
    const spec = install({
      rows: geofenceRows({ plan_geofences: [{ id: "g1", trip_id: TRIP }] }),
      failOn: (ctx: any) => (ctx.table === "plan_geofences" ? READ_FAIL : null),
    });
    const r = await req("POST", `/api/trips/${TRIP}/geofence`, GEOFENCE_BODY);
    assertDbError(r);
    assert.equal(spec.inserted.plan_geofences, undefined, "no INSERT may be attempted against a UNIQUE(trip_id)");
    assert.equal(spec.updated.plan_geofences, undefined);
  });

  it("HEALTHY: an existing geofence is UPDATED, not inserted", async () => {
    const spec = install({ rows: geofenceRows({ plan_geofences: [{ id: "g1", trip_id: TRIP }] }) });
    const r = await req("POST", `/api/trips/${TRIP}/geofence`, GEOFENCE_BODY);
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.equal(spec.updated.plan_geofences?.length, 1, "the existing row must be updated");
    assert.equal(spec.inserted.plan_geofences, undefined);
  });

  it("HEALTHY: a trip with no geofence yet still gets one inserted", async () => {
    const spec = install({ rows: geofenceRows() });
    const r = await req("POST", `/api/trips/${TRIP}/geofence`, GEOFENCE_BODY);
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.equal(spec.inserted.plan_geofences?.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// stampAdmire — POST /stamps/:userStampId/admire
// The idempotency read is what stops the stamp owner being re-notified for an
// admire they were already told about.
// ═══════════════════════════════════════════════════════════════════════════

function stampRows(extra: Record<string, any[]> = {}) {
  return {
    profiles: [{ id: USER, account_status: "active" }],
    feature_flags: [{ flag: "stamp_admire_enabled", enabled: true }],
    user_stamps: [{ id: STAMP, user_id: OTHER, visibility: "public", is_revoked: false, city: "Lisbon", country: "PT", title_override: null }],
    stamp_admires: [],
    ...extra,
  };
}

describe("POST /stamps/:userStampId/admire — idempotency read", () => {
  it("FAILURE: an unreadable stamp_admires refuses instead of re-admiring", async () => {
    const spec = install({
      rows: stampRows({ stamp_admires: [{ id: "a1", user_stamp_id: STAMP, admirer_id: USER }] }),
      failOn: (ctx: any) => (ctx.table === "stamp_admires" ? READ_FAIL : null),
    });
    const r = await req("POST", `/api/stamps/${STAMP}/admire`, {});
    assertDbError(r);
    assert.equal(spec.inserted.stamp_admires, undefined, "no second admire row may be written");
  });

  it("HEALTHY: a repeat admire is still the silent duplicate 200", async () => {
    const spec = install({
      rows: stampRows({ stamp_admires: [{ id: "a1", user_stamp_id: STAMP, admirer_id: USER }] }),
    });
    const r = await req("POST", `/api/stamps/${STAMP}/admire`, {});
    assert.equal(r.status, 200, `got ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.duplicate, true);
    assert.equal(spec.inserted.stamp_admires, undefined);
  });

  it("HEALTHY: a first admire is still recorded", async () => {
    const spec = install({ rows: stampRows() });
    const r = await req("POST", `/api/stamps/${STAMP}/admire`, {});
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.equal(spec.inserted.stamp_admires?.length, 1);
  });
});
