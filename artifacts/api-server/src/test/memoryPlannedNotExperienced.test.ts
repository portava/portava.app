/**
 * §1 and §25 of Portava_Highlights_Memories_Development_Architecture_Spec_v1 —
 * "Planned, saved or nearby must never be represented as experienced."
 *
 * WHAT THIS SUITE IS FOR
 * ======================
 * census-highlights-memories.md H239 is §25's hard invariant "planned activity
 * without occurrence cannot earn a visit Memory/Stamp". It is scored BUILT-BUT-
 * WRONG for a stated reason: the invariant is proved only against
 * `services/memoryProjections/evidence.ts`, which no route imports, and "the
 * live stamp path enforces the rule by requiring a real check-in (H4) and is
 * NOT COVERED BY THIS TEST". This suite is that coverage — the live surfaces,
 * through their real routers, asserting the thing the engine asserts in memory.
 *
 * IT FOUND A LIVE DEFECT, AND THE FIRST TEST BELOW IS THE ONE THAT FOUND IT
 * ========================================================================
 * `POST /api/airport/sessions` minted a Passport stamp
 * (`stamp_type: 'activity'`, `verification_level: 'checkin'`) for the layover's
 * city at SESSION CREATION. The same handler validates, thirty lines earlier,
 * that the departure is in the FUTURE — so a traveller describing next
 * Tuesday's connection was awarded a checked-in city stamp for an airport they
 * had not reached, and might never reach. Both production flags are `true` in
 * the committed schema snapshot (`airport_mode_enabled`,
 * `passport_stamps_enabled`), so this was live.
 *
 * The gate is `declaredOccurrenceHasHappened` in
 * `services/memory/occurrenceGate.ts`. It refuses with §6's own reason code,
 * `PLANNED_OR_SAVED_ONLY`, rather than inventing a second vocabulary for the
 * same refusal.
 *
 * WHY A SCHEMA-STRICT CLIENT
 * ==========================
 * The assertion is "no row was written to `passport_stamps`". A fake that
 * accepts any column name can satisfy that assertion while the production write
 * it is standing in for would have failed with 42703 anyway, which would make
 * the green meaningless. `makeSchemaStrictClient` validates every column named
 * in a select, a filter or a write body against `src/test/generated/liveColumns.json`
 * — the live information_schema — and answers 42703 exactly as PostgREST does.
 * `deadColumnErrors` is asserted empty on the control case, so the control's
 * write is a write production would also have accepted.
 *
 * Run: node --import tsx/esm --test src/test/memoryPlannedNotExperienced.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import airportRouter from "../routes/airport.js";
import {
  declaredOccurrenceHasHappened,
  OCCURRENCE_GATE_VERSION,
} from "../services/memory/occurrenceGate.js";
import { makeSchemaStrictClient, type SchemaStrictClient } from "./helpers/schemaStrictSupabase.ts";

const TOKEN = "planned-not-experienced-token";
const USER_ID = "aa000000-0000-4000-a000-0000000000a1";
const AIRPORT_ID = "bb000000-0000-4000-a000-0000000000b1";

let server: http.Server;
let base: string;
let client: SchemaStrictClient;

function req(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    };
    if (payload) headers["content-length"] = Buffer.byteLength(payload).toString();
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * The passport seam is `void (async () => { ... })()` — fire-and-forget, so the
 * HTTP response returns before the stamp write is attempted. Waiting on a fixed
 * timer would make this suite flaky in one direction and slow in the other, so
 * it polls for the write and gives up after a bounded wait. A poll that times
 * out reports "no write", which is the assertion the refusal cases make — so
 * the CONTROL case (which asserts a write DID happen) is what proves the wait
 * is long enough. Without the control, every refusal assertion here could be
 * passing because the seam had not run yet.
 */
async function settleSeam(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (client.writes.some((w) => w.table === "passport_stamps")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

function stampWrites(): Array<Record<string, unknown>> {
  return client.writes.filter((w) => w.table === "passport_stamps").flatMap((w) => w.rows);
}

/**
 * Give the just-inserted layover session the `id` Postgres would have.
 *
 * The double implements columns and filters, not column DEFAULTs, so a row
 * inserted through the route comes back without the generated `id` and
 * `DELETE /airport/sessions/:id` then matches nothing. `settle()` pushes the
 * SAME object it recorded in `writes` into the store, so naming it here names
 * the stored row. This stands in for a DEFAULT and for nothing else — every
 * term the seam actually decides on (completion, election, the flag, the
 * arrival instant) is still read from the route's own data.
 */
function idLastSession(id: string): void {
  const w = [...client.writes].reverse().find((x) => x.table === "layover_sessions");
  assert.ok(w, "no layover_sessions insert was recorded — the route did not create a session");
  (w.rows[0] as Record<string, unknown>).id = id;
}

function stage(): SchemaStrictClient {
  const c = makeSchemaStrictClient(
    {
      feature_flags: [
        { flag: "airport_mode_enabled", enabled: true, description: null, metadata: null, updated_at: null },
        { flag: "passport_stamps_enabled", enabled: true, description: null, metadata: null, updated_at: null },
        { flag: "passport_memories_enabled", enabled: true, description: null, metadata: null, updated_at: null },
      ],
      airport_profiles: [
        {
          id: AIRPORT_ID,
          iata_code: "CEB",
          name: "Mactan-Cebu International",
          city: "Cebu",
          country: "Philippines",
          country_code: "PH",
          timezone: "UTC",
          lat: 10.31,
          lng: 123.98,
          verified: true,
          canonical_location_id: null,
          created_by: null,
          created_at: null,
          updated_at: null,
          terminal_info: null,
          domestic_buffer_min: null,
          domestic_buffer_max: null,
          international_buffer_min: null,
          international_buffer_max: null,
          immigration_extra_min: null,
          checked_bags_extra_min: null,
          traffic_extra_min: null,
        },
      ],
      layover_sessions: [],
      layover_events: [],
      passport_stamps: [],
      passport_visibility_preferences: [],
      canonical_locations: [],
      trips: [],
    },
    // `catalog_stamp_definitions` and the trust-event tables are reached by
    // best-effort seams wrapped in try/catch; they are not this suite's subject
    // and `liveColumns` throws on a table it has never heard of, which would
    // turn an unrelated seam into a failure of the assertion under test.
    { unchecked: ["stamp_catalog_queue", "location_trust_events", "trust_events", "trip_items"] },
  );
  (c as any).auth = {
    getUser: async (token: string) =>
      token === TOKEN
        ? { data: { user: { id: USER_ID } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
  };
  return c;
}

/** ISO instant `deltaMs` from now. */
function at(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

const HOUR = 3_600_000;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", airportRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  client = stage();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── The gate itself ──────────────────────────────────────────────────────────

describe("§1 occurrence gate — the predicate", () => {
  it("refuses an instant that has not arrived, with §6's PLANNED_OR_SAVED_ONLY", () => {
    const v = declaredOccurrenceHasHappened(at(6 * HOUR), Date.now());
    assert.equal(v.occurred, false);
    assert.equal(v.occurred === false && v.reason, "PLANNED_OR_SAVED_ONLY");
  });

  it("admits an instant already in the past", () => {
    const iso = at(-2 * HOUR);
    const v = declaredOccurrenceHasHappened(iso, Date.now());
    assert.equal(v.occurred, true);
    assert.equal(v.occurred === true && v.occurredAt, iso);
  });

  it("the boundary instant counts as occurred — `<= now`, not `< now`", () => {
    const now = Date.now();
    const v = declaredOccurrenceHasHappened(new Date(now).toISOString(), now);
    assert.equal(v.occurred, true);
  });

  it("fails closed on an absent instant", () => {
    for (const absent of [null, undefined, ""]) {
      const v = declaredOccurrenceHasHappened(absent as any, Date.now());
      assert.equal(v.occurred, false, `absent instant ${JSON.stringify(absent)} must not read as occurrence`);
      assert.equal(v.occurred === false && v.reason, "NO_DECLARED_OCCURRENCE");
    }
  });

  it("fails closed on an unparseable instant rather than treating it as now", () => {
    const v = declaredOccurrenceHasHappened("not-a-timestamp", Date.now());
    assert.equal(v.occurred, false);
    assert.equal(v.occurred === false && v.reason, "UNPARSEABLE_OCCURRENCE");
  });

  it("carries a policy version, because a refusal a replay cannot attribute is not replayable", () => {
    assert.match(OCCURRENCE_GATE_VERSION, /@\d+$/);
  });
});

// ── The live surface ─────────────────────────────────────────────────────────

/**
 * RE-POINTED AT INTEGRATION, exactly as §F's consequence 2 instructed.
 *
 * These cases used to drive `POST /api/airport/sessions`, because that is where
 * the stamp was minted when they were written. The sibling Layover lane deleted
 * that seam and re-hung it on `DELETE /api/airport/sessions/:id` behind
 * completion and an election, so a control asserting "a past arrival DOES earn
 * a stamp at session creation" could no longer pass — nothing earns one at
 * session creation now. §F said *"whoever merges must re-point this control at
 * the end-of-session path, not delete it"*, and that is what these do.
 *
 * §F also predicted the gate would become UNREACHABLE. It did not: the
 * integration kept the Layover lane's structure and added this predicate as a
 * FOURTH term on `writeElectedLayoverStamp`, because completion and election
 * are things the caller SAYS and `endSession` never consults a clock. So the
 * refusal below is still `declaredOccurrenceHasHappened` refusing — on a
 * different route. See §G, and src/test/layoverStampOccurrence.test.ts for the
 * seam's own four-term suite.
 *
 * The schema-strict client is why these two are kept rather than folded into
 * that suite: they assert `deadColumnErrors` is empty, so the earning path is
 * one production could actually execute.
 */
describe("§25 H239 — a layover that has not begun earns no Passport stamp", () => {
  it("a session whose arrival is still in the future writes NO passport_stamps row", async () => {
    const created = await req("POST", "/api/airport/sessions", {
      iata: "CEB",
      arrivalTime: at(48 * HOUR),
      departureTime: at(54 * HOUR),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await settleSeam();
    assert.deepEqual(stampWrites(), [], "creation must mint nothing at all now");

    idLastSession("session-future");
    const closed = await req("DELETE", "/api/airport/sessions/session-future", {
      outcome: "completed",
      passportStamp: true,
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    await settleSeam();
    assert.deepEqual(
      stampWrites(),
      [],
      "a layover the traveller has not arrived at is PLANNED. §1: planned must never be represented as experienced — and saying `completed` does not make it so.",
    );
    assert.equal(closed.body.passportStamp.reason, "not_occurred");
  });

  it("the refusal is not a blanket deny — an arrival already in the past DOES earn the stamp", async () => {
    const created = await req("POST", "/api/airport/sessions", {
      iata: "CEB",
      arrivalTime: at(-2 * HOUR),
      departureTime: at(4 * HOUR),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    idLastSession("session-past");
    const closed = await req("DELETE", "/api/airport/sessions/session-past", {
      outcome: "completed",
      passportStamp: true,
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    await settleSeam();
    const rows = stampWrites();
    assert.equal(rows.length, 1, "the traveller was at the airport and elected it; the stamp is earned");
    assert.equal(rows[0]!["city"], "Cebu");
    assert.equal(rows[0]!["source_type"], "layover_session");
    assert.deepEqual(
      client.deadColumnErrors,
      [],
      "every column this path names must exist in the live schema, or the control proves nothing about production",
    );
  });

  it("a session created with no arrival instant at all writes no stamp", async () => {
    // The route refuses the session outright (arrival is required), which is
    // the same outcome by a shorter road — asserted so that a future relaxation
    // of that validation cannot silently open the seam.
    const r = await req("POST", "/api/airport/sessions", {
      iata: "CEB",
      departureTime: at(30 * HOUR),
    });
    assert.equal(r.status, 400);
    await settleSeam();
    assert.deepEqual(stampWrites(), []);
  });
});

// ── The second live surface: a planned meetup nobody attended ────────────────
//
// `POST /api/trips/:tripId/geofence/check-in` is the path H4's evidence cites,
// and the one §25's sentence is closest to: a PLAN (a geofence on a trip) earns
// a Passport stamp and a suggested Memory only when somebody actually turns up
// inside it. Every refusal below is a way of not turning up, and each must mint
// nothing — a plan is not an experience however many times it is asked about.
//
// The client is schema-strict for the same reason as above: an assertion that
// no `passport_stamps` row was written means nothing if the write it stands in
// for names a column production does not have. The CONTROL case asserts
// `deadColumnErrors` is empty, so the earning path is one production would also
// have accepted.

const TRIP_ID = "cc000000-0000-4000-a000-0000000000c1";
const GEOFENCE_ID = "dd000000-0000-4000-a000-0000000000d1";
const MEETUP_LAT = 48.8566;
const MEETUP_LNG = 2.3522;

let gfServer: http.Server;
let gfBase: string;
let gfClient: SchemaStrictClient;

function gfReq(path: string, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, gfBase);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload).toString(),
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

interface GeofenceStageOptions {
  role?: string;
  status?: string;
  windowStart?: string | null;
}

function stageGeofence(o: GeofenceStageOptions = {}): SchemaStrictClient {
  const c = makeSchemaStrictClient(
    {
      feature_flags: [
        { flag: "plan_geofence_enabled", enabled: true, description: null, metadata: null, updated_at: null },
        { flag: "passport_stamps_enabled", enabled: true, description: null, metadata: null, updated_at: null },
        { flag: "passport_memories_enabled", enabled: true, description: null, metadata: null, updated_at: null },
      ],
      trips: [{ id: TRIP_ID, owner_id: "ee000000-0000-4000-a000-0000000000e1", visibility: "public", status: "active" }],
      trip_members: [
        {
          trip_id: TRIP_ID,
          user_id: USER_ID,
          role: o.role ?? "member",
          status: o.status ?? "accepted",
          joined_at: null, created_at: null, updated_at: null, permissions: null, invite_link_id: null,
        },
      ],
      plan_geofences: [
        {
          id: GEOFENCE_ID,
          trip_id: TRIP_ID,
          lat: MEETUP_LAT,
          lng: MEETUP_LNG,
          check_in_radius_m: 150,
          check_in_required: true,
          check_in_window_start: o.windowStart ?? null,
          check_in_window_end: null,
          host_enabled: true,
          city: "Paris",
          neighborhood: "Le Marais",
          location_name: "Cafe",
        },
      ],
      plan_checkins: [],
      plan_attendance_events: [],
      location_snapshots: [],
      passport_stamps: [],
      passport_memories: [],
      passport_visibility_preferences: [],
      profiles: [],
    },
    { unchecked: ["location_trust_events", "trust_events", "stamp_catalog_queue", "passport_contributions"] },
  );
  (c as any).auth = {
    getUser: async (token: string) =>
      token === TOKEN
        ? { data: { user: { id: USER_ID } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
  };
  return c;
}

async function settleGeofenceSeam(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (gfClient.writes.some((w) => w.table === "passport_stamps")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

function gfWrites(table: string): Array<Record<string, unknown>> {
  return gfClient.writes.filter((w) => w.table === table).flatMap((w) => w.rows);
}

describe("§25 H239 — a planned meetup earns nothing without attendance", () => {
  before(async () => {
    const geofenceRouter = (await import("../routes/geofence.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/api", geofenceRouter);
    gfServer = http.createServer(app);
    await new Promise<void>((r) => gfServer.listen(0, "127.0.0.1", r));
    gfBase = `http://127.0.0.1:${(gfServer.address() as any).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => gfServer.close(() => r()));
  });

  beforeEach(() => {
    gfClient = stageGeofence();
    _setTestClient(gfClient as any, true);
    _setTestServiceClient(gfClient as any);
  });

  it("CONTROL — turning up inside the radius DOES earn the stamp", async () => {
    const r = await gfReq(`/api/trips/${TRIP_ID}/geofence/check-in`, {
      lat: MEETUP_LAT,
      lng: MEETUP_LNG + 0.0002, // ~15 m
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    await settleGeofenceSeam();
    assert.equal(gfWrites("passport_stamps").length, 1, "attendance is occurrence evidence; the stamp is earned");
    assert.deepEqual(
      gfClient.deadColumnErrors,
      [],
      "the earning path must name only live columns, or the refusals below prove nothing about production",
    );
  });

  it("standing 5 km away earns no stamp and no suggested Memory", async () => {
    const r = await gfReq(`/api/trips/${TRIP_ID}/geofence/check-in`, { lat: 48.810, lng: MEETUP_LNG });
    assert.equal(r.body.ok, false, JSON.stringify(r.body));
    assert.equal(r.body.reason, "outside_radius");
    await settleGeofenceSeam();
    assert.deepEqual(gfWrites("passport_stamps"), []);
    assert.deepEqual(gfWrites("passport_memories"), []);
  });

  it("checking in before the window opens earns nothing — the plan exists, the attendance does not", async () => {
    gfClient = stageGeofence({ windowStart: at(6 * HOUR) });
    _setTestClient(gfClient as any, true);
    _setTestServiceClient(gfClient as any);
    const r = await gfReq(`/api/trips/${TRIP_ID}/geofence/check-in`, {
      lat: MEETUP_LAT,
      lng: MEETUP_LNG + 0.0002,
    });
    assert.equal(r.body.ok, false, JSON.stringify(r.body));
    assert.equal(r.body.reason, "window_not_open");
    await settleGeofenceSeam();
    assert.deepEqual(gfWrites("passport_stamps"), []);
    assert.deepEqual(gfWrites("passport_memories"), []);
  });

  it("an invited-but-not-accepted member earns nothing", async () => {
    gfClient = stageGeofence({ status: "invited" });
    _setTestClient(gfClient as any, true);
    _setTestServiceClient(gfClient as any);
    const r = await gfReq(`/api/trips/${TRIP_ID}/geofence/check-in`, {
      lat: MEETUP_LAT,
      lng: MEETUP_LNG + 0.0002,
    });
    assert.equal(r.body.error, "not_member", JSON.stringify(r.body));
    await settleGeofenceSeam();
    assert.deepEqual(gfWrites("passport_stamps"), []);
    assert.deepEqual(gfWrites("passport_memories"), []);
  });
});
