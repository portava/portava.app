/**
 * Compass Sense — a failed read is never "no signals" (DV-83).
 *
 * THE DEFECT THIS PINS
 * ====================
 * supabase-js RESOLVES on a database error: `{ data: null, error }`. Every
 * Sense signal evaluator destructured `{ data }` only, folded `data ?? []`
 * into "nothing here", and wrapped the lot in `catch { return []; }`. So an
 * outage on `event_saves`, `route_plans`, `trips`, `trip_plan_items` or
 * `meetup_invites` produced the SAME answer as a traveller with nothing worth
 * a nudge: `POST /compass/sense/check` → `200 { evaluated: 0, delivered: [] }`,
 * and a scheduler tick counted that user as a clean, empty evaluation. That is
 * the masquerade census-discovery DV-83 forbids and lib/discoveryRefusal.ts
 * exists to stop: "we did not look" reported as "we looked and found nothing".
 *
 * WHAT IS ASSERTED
 * ================
 *  A. evaluateSenseSignals — per evaluator, a fake client that fails the
 *     evaluator's specific table(s) puts that evaluator in `failedSources`,
 *     and a healthy twin with the same seed fires its candidate with
 *     `failedSources: []`.
 *  B. POST /compass/sense/check — healthy answers are byte-identical to the
 *     shape shipped before this change; some sources unread → 200 with
 *     `partial: true` + `failedSources`; every source unread → 503
 *     `degraded_unavailable` with `failedSources`, never `evaluated: 0`.
 *     An unreadable presence setting is the same: it used to fall back to
 *     `passive` and answer `evaluated: 0`; it now answers 503 naming
 *     `settings` (the send itself stays fail-closed).
 *  B2. GET /compass/sense/nudges — an unreadable nudge log answers 503, not
 *     `nudges: []`; healthy bodies are byte-identical.
 *  C. runSenseSweep — a user whose sources were unread is recorded as an
 *     error for the tick; all unread is NOT counted as an evaluated user.
 *  D. Compass Live (the other consumer of the evaluators) — a live tick
 *     carries the same `failedSources` instead of absorbing them.
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compassSenseReadHonesty.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import compassSenseRouter, { _setTestHourUtc, _setTestNowMinutes } from "../routes/compassSense.js";
import compassLiveRouter, { _setTestNowMs, _setTestHourUtc as _setLiveTestHourUtc } from "../routes/compassLive.js";
import { evaluateSenseSignals, runSense } from "../compass/CompassSenseEngine.js";
import { runLiveCheck } from "../compass/CompassLiveEngine.js";
import { _setTestClient as _setSchedulerClient, runSenseSweep } from "../lib/compassSenseScheduler.js";

const USER_ID = "00000000-0000-0000-0000-00000000d583";

/* ── Fake Supabase client that fails SPECIFIC tables ─────────────────────────
 * `failTables`: every read on the table resolves `{ data: null, error }` — the
 * way supabase-js reports a database error (it does not throw).
 * `rejectTables`: the read REJECTS — a network-level failure.
 * Every other table behaves like the permissive store the Sense suites use.
 */
type Row = Record<string, unknown>;
type DbError = { message: string; code: string };
type Outcome = { data: unknown; error: DbError | null };

const OUTAGE: DbError = { message: "simulated outage", code: "XX000" };
let idCounter = 0;

interface FakeOpts {
  failTables?: readonly string[];
  rejectTables?: readonly string[];
}

class FakeQuery implements PromiseLike<Outcome> {
  private readonly filters: Array<(r: Row) => boolean> = [];
  private cap: number | null = null;
  private written: Row[] | null = null;
  private pendingUpdate: Row | null = null;

  constructor(
    private readonly store: Record<string, Row[]>,
    private readonly table: string,
    private readonly opts: FakeOpts,
  ) {}

  private rows(): Row[] {
    this.store[this.table] ??= [];
    return this.store[this.table]!;
  }
  private outcome(): Outcome {
    if ((this.opts.failTables ?? []).includes(this.table)) return { data: null, error: OUTAGE };
    if (this.pendingUpdate) {
      for (const r of this.rows()) if (this.filters.every((f) => f(r))) Object.assign(r, this.pendingUpdate);
      this.pendingUpdate = null;
      this.written = null;
    }
    if (this.written) return { data: this.written, error: null };
    let out = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.cap !== null) out = out.slice(0, this.cap);
    return { data: out, error: null };
  }
  private settle(): Promise<Outcome> {
    if ((this.opts.rejectTables ?? []).includes(this.table)) {
      return Promise.reject(new Error(`socket hang up (${this.table})`));
    }
    return Promise.resolve(this.outcome());
  }

  select(): this { return this; }
  order(): this { return this; }
  like(): this { return this; }
  or(): this { return this; }
  not(): this { return this; }
  is(): this { return this; }
  limit(n: number): this { this.cap = n; return this; }
  eq(k: string, v: unknown): this { this.filters.push((r) => r[k] === v); return this; }
  neq(k: string, v: unknown): this { this.filters.push((r) => r[k] !== v); return this; }
  in(k: string, vs: readonly unknown[]): this { this.filters.push((r) => vs.includes(r[k])); return this; }
  gte(k: string, v: unknown): this { this.filters.push((r) => String(r[k] ?? "") >= String(v)); return this; }
  lte(k: string, v: unknown): this { this.filters.push((r) => String(r[k] ?? "") <= String(v)); return this; }
  gt(k: string, v: unknown): this { this.filters.push((r) => String(r[k] ?? "") > String(v)); return this; }
  lt(k: string, v: unknown): this { this.filters.push((r) => String(r[k] ?? "") < String(v)); return this; }
  insert(payload: Row | Row[]): this {
    const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({
      id: `gen-${++idCounter}`,
      created_at: new Date().toISOString(),
      ...r,
    }));
    this.rows().push(...arr);
    this.written = arr;
    return this;
  }
  upsert(payload: Row | Row[], o?: { onConflict?: string }): this {
    const key = o?.onConflict ?? "id";
    const arr = Array.isArray(payload) ? payload : [payload];
    for (const r of arr) {
      const existing = this.rows().find((e) => e[key] === r[key]);
      if (existing) Object.assign(existing, r);
      else this.rows().push({ ...r });
    }
    this.written = arr;
    return this;
  }
  update(payload: Row): this { this.pendingUpdate = { ...payload }; return this; }
  delete(): this { return this; }
  maybeSingle(): Promise<Outcome> {
    return this.settle().then((o) => ({
      data: Array.isArray(o.data) ? (o.data[0] ?? null) : o.data,
      error: o.error,
    }));
  }
  single(): Promise<Outcome> {
    return this.settle().then((o) => {
      const first = Array.isArray(o.data) ? (o.data[0] ?? null) : o.data;
      return { data: first, error: o.error ?? (first ? null : { message: "no rows", code: "PGRST116" }) };
    });
  }
  then<A = Outcome, B = never>(
    onFulfilled?: ((value: Outcome) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.settle().then(onFulfilled, onRejected);
  }
}

function makeFakeClient(store: Record<string, Row[]>, opts: FakeOpts = {}): SupabaseClient {
  const client = {
    from: (table: string) => new FakeQuery(store, table, opts),
    auth: {
      getUser: (token: string) =>
        token === "valid-token"
          ? Promise.resolve({ data: { user: { id: USER_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "bad token" } }),
    },
  };
  return client as unknown as SupabaseClient;
}

/* ── Seeds (the same real-data shapes compass-sense.test.ts uses) ─────────── */

const TODAY = new Date().toISOString().slice(0, 10);
/** 12:00 UTC today: daytime, so free_time_block reads its tables. */
const NOON_MS = new Date(`${TODAY}T12:00:00.000Z`).getTime();

/**
 * Seeds are placed relative to ANCHOR. Engine and Live cases pin "now" to
 * NOON_MS; the Sense route and the sweep read the wall clock, so their cases
 * move the anchor to Date.now() before seeding.
 */
let ANCHOR = NOON_MS;
function iso(msFromAnchor: number): string {
  return new Date(ANCHOR + msFromAnchor).toISOString();
}

function baseStore(level = "active"): Record<string, Row[]> {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    compass_sense_settings: [{ user_id: USER_ID, presence_level: level, categories: {} }],
  };
}

function seedSavedEvent(s: Record<string, Row[]>): void {
  s.event_saves = [{ event_id: "evt-1", user_id: USER_ID }];
  s.events = [{ id: "evt-1", title: "Night market", starts_at: iso(60 * 60_000), state: "published" }];
}

function seedLeaveEarlier(s: Record<string, Row[]>): void {
  s.route_plans = [{ id: "rp-1", title: "Day route", owner_user_id: USER_ID }];
  s.route_stops = [{
    id: "st-1", route_plan_id: "rp-1", title: "Museum", order_index: 1,
    checkpoint_status: "pending", planned_arrival_time: iso(30 * 60_000),
  }];
  s.route_legs = [{ route_plan_id: "rp-1", to_stop_id: "st-1", duration_seconds: 3600 }];
}

function seedCircleChange(s: Record<string, Row[]>): void {
  s.meetup_invites = [{ meetup_id: "m-1", user_id: USER_ID, status: "going" }];
  s.meetups = [{ id: "m-1", title: "Sunset drinks", status: "cancelled", updated_at: iso(-10 * 60_000) }];
}

/**
 * An active trip in `city`, one plan item today starting in 4h (a timed item,
 * so free_time_block has a real 4h gap), and a cached forecast so the weather
 * evaluator never reaches the network. `weatherCode` 61 + 8mm is rain (fires),
 * 45 + 1mm is fog (neither rainy nor clear — silent).
 */
function seedTripDay(s: Record<string, Row[]>, city: string, weatherCode = 45, precip = 1): void {
  s.trips = [{ id: "trip-1", owner_id: USER_ID, destination_city: city, status: "active" }];
  s.trip_members = [];
  s.trip_plan_items = [{
    id: "pi-1", trip_id: "trip-1", title: "Dinner", day_date: TODAY,
    starts_at: iso(4 * 60 * 60_000), status: "planned", removed_at: null,
  }];
  s.weather_cache = [{
    destination: city.toLowerCase(),
    date_key: `${TODAY}:${TODAY}`,
    fetched_at: new Date().toISOString(),
    brief_summary: "seeded",
    forecasts_json: [{
      date: TODAY, weatherCode, summary: weatherCode >= 51 ? "Rainy" : "Foggy",
      maxTempC: 30, minTempC: 24, precipMm: precip,
    }],
  }];
}

const ALL_SOURCES = [
  "saved_event_starting",
  "leave_earlier",
  "weather_change",
  "circle_plan_change",
  "free_time_block",
];

/** Every table the five evaluators need first — failing these fails them all. */
const EVERY_FIRST_READ = ["event_saves", "route_plans", "trips", "meetup_invites"];

async function evaluate(store: Record<string, Row[]>, opts: FakeOpts, hourUtc = 12) {
  const sc = makeFakeClient(store, opts);
  _setTestClient(sc, true); // weatherCache reads its DB cache through the service client
  return evaluateSenseSignals(sc, USER_ID, { nowMs: NOON_MS, hourUtc });
}

function types(r: { candidates: Array<{ type: string }> }): string[] {
  return r.candidates.map((c) => c.type);
}

/* ── Mini express app (Sense + Live routes) ──────────────────────────────── */

const testApp = express();
testApp.use(express.json());
testApp.use((req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { log: pino.Logger }).log = pino({ level: "silent" });
  next();
});
testApp.use("/api", compassSenseRouter);
testApp.use("/api", compassLiveRouter);

let server: Server;
let base: string;

before(async () => {
  server = createServer(testApp);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  _setTestHourUtc(null);
  _setTestNowMinutes(null);
  _setTestNowMs(null);
  _setLiveTestHourUtc(null);
  _setSchedulerClient(null);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  invalidateFlagsCache();
  _setTestHourUtc(12);
  _setTestNowMinutes(720);
});

async function api(method: string, path: string): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const resp = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
    body: method === "GET" ? undefined : "{}",
  });
  const text = await resp.text();
  return { status: resp.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

/* ── A. Per evaluator: failed read → failedSources; healthy twin fires ───── */

describe("A. evaluateSenseSignals reports each unread source instead of returning []", () => {
  beforeEach(() => { ANCHOR = NOON_MS; });

  it("saved_event_starting — healthy twin fires, failedSources []", async () => {
    const s = baseStore(); seedSavedEvent(s);
    const r = await evaluate(s, {});
    assert.deepEqual(r.failedSources, []);
    assert.deepEqual(types(r), ["saved_event_starting"]);
  });
  it("saved_event_starting — event_saves read error → unread, not empty", async () => {
    const s = baseStore(); seedSavedEvent(s);
    const r = await evaluate(s, { failTables: ["event_saves"] });
    assert.deepEqual(r.failedSources, ["saved_event_starting"]);
    assert.deepEqual(types(r), []);
  });
  it("saved_event_starting — events read error (saves readable) → unread", async () => {
    const s = baseStore(); seedSavedEvent(s);
    const r = await evaluate(s, { failTables: ["events"] });
    assert.deepEqual(r.failedSources, ["saved_event_starting"]);
  });

  it("leave_earlier — healthy twin fires, failedSources []", async () => {
    const s = baseStore(); seedLeaveEarlier(s);
    const r = await evaluate(s, {});
    assert.deepEqual(r.failedSources, []);
    assert.deepEqual(types(r), ["leave_earlier"]);
  });
  for (const table of ["route_plans", "route_stops", "route_legs"]) {
    it(`leave_earlier — ${table} read error → unread, not empty`, async () => {
      const s = baseStore(); seedLeaveEarlier(s);
      const r = await evaluate(s, { failTables: [table] });
      assert.deepEqual(r.failedSources, ["leave_earlier"]);
      assert.deepEqual(types(r), []);
    });
  }

  it("weather_change — healthy twin fires on a rainy forecast over today's plans", async () => {
    const s = baseStore(); seedTripDay(s, "HonestyRainCity", 61, 8);
    const r = await evaluate(s, {}, 8); // 08:00: free_time_block stays out of it
    assert.deepEqual(r.failedSources, []);
    assert.deepEqual(types(r), ["weather_change"]);
  });
  it("weather_change — trip_plan_items read error → unread (not 'no plans today')", async () => {
    const s = baseStore(); seedTripDay(s, "HonestyRainCity", 61, 8);
    const r = await evaluate(s, { failTables: ["trip_plan_items"] }, 8);
    assert.deepEqual(r.failedSources, ["weather_change"]);
    assert.deepEqual(types(r), []);
  });
  it("weather_change — trips read error → unread (not 'no active trip')", async () => {
    const s = baseStore(); seedTripDay(s, "HonestyRainCity", 61, 8);
    const r = await evaluate(s, { failTables: ["trips"] }, 8);
    assert.deepEqual(r.failedSources, ["weather_change"]);
  });
  it("weather_change — trip_members read error → unread (the union is incomplete)", async () => {
    const s = baseStore(); seedTripDay(s, "HonestyRainCity", 61, 8);
    const r = await evaluate(s, { failTables: ["trip_members"] }, 8);
    assert.deepEqual(r.failedSources, ["weather_change"]);
  });

  it("circle_plan_change — healthy twin fires, failedSources []", async () => {
    const s = baseStore(); seedCircleChange(s);
    const r = await evaluate(s, {});
    assert.deepEqual(r.failedSources, []);
    assert.deepEqual(types(r), ["circle_plan_change"]);
  });
  it("circle_plan_change — meetup_invites read error → unread, not empty", async () => {
    const s = baseStore(); seedCircleChange(s);
    const r = await evaluate(s, { failTables: ["meetup_invites"] });
    assert.deepEqual(r.failedSources, ["circle_plan_change"]);
    assert.deepEqual(types(r), []);
  });
  it("circle_plan_change — meetups read REJECTS (network) → unread, not empty", async () => {
    const s = baseStore(); seedCircleChange(s);
    const r = await evaluate(s, { rejectTables: ["meetups"] });
    assert.deepEqual(r.failedSources, ["circle_plan_change"]);
  });

  it("free_time_block — healthy twin fires on a real 4h gap", async () => {
    const s = baseStore(); seedTripDay(s, "HonestyFogCity");
    const r = await evaluate(s, {});
    assert.deepEqual(r.failedSources, []);
    assert.deepEqual(types(r), ["free_time_block"]);
  });
  it("free_time_block — trip_plan_items read error → unread (not 'an unplanned day')", async () => {
    const s = baseStore(); seedTripDay(s, "HonestyFogCity");
    const r = await evaluate(s, { failTables: ["trip_plan_items"] });
    // The weather evaluator reads the same table, so it is unread too.
    assert.deepEqual(r.failedSources, ["weather_change", "free_time_block"]);
    assert.deepEqual(types(r), []);
  });
  it("free_time_block — trips read error → unread", async () => {
    const s = baseStore(); seedTripDay(s, "HonestyFogCity");
    const r = await evaluate(s, { failTables: ["trips"] });
    assert.deepEqual(r.failedSources, ["weather_change", "free_time_block"]);
  });

  it("runSense: an unread presence setting is reported as the 'settings' source", async () => {
    const s = baseStore(); seedSavedEvent(s);
    const sc = makeFakeClient(s, { failTables: ["compass_sense_settings"] });
    _setTestClient(sc, true);
    const r = await runSense(sc, USER_ID, { nowMs: NOON_MS, hourUtc: 12, nowMinutes: 720 });
    assert.equal(r.presenceLevel, "passive", "fail-closed: an unread setting still sends nothing");
    assert.deepEqual(r.failedSources, ["settings"]);
    assert.deepEqual(r.delivered, []);
  });

  it("one unread source does not suppress the others' real signals", async () => {
    const s = baseStore(); seedSavedEvent(s); seedCircleChange(s);
    const r = await evaluate(s, { failTables: ["route_plans"] });
    assert.deepEqual(r.failedSources, ["leave_earlier"]);
    assert.deepEqual(types(r).sort(), ["circle_plan_change", "saved_event_starting"]);
  });
});

/* ── B. POST /compass/sense/check ────────────────────────────────────────── */

describe("B. POST /compass/sense/check never answers evaluated: 0 over a failed read", () => {
  beforeEach(() => { ANCHOR = Date.now(); });

  it("healthy, nothing to nudge: byte-identical to the shipped shape", async () => {
    _setTestClient(makeFakeClient(baseStore()), true);
    const r = await api("POST", "/compass/sense/check");
    assert.equal(r.status, 200);
    assert.equal(r.text, '{"compassEnabled":true,"presenceLevel":"active","evaluated":0,"delivered":[],"suppressed":[]}');
  });

  it("healthy with a signal: the shipped keys, in the shipped order, and no coverage keys", async () => {
    const s = baseStore(); seedSavedEvent(s);
    _setTestClient(makeFakeClient(s), true);
    const r = await api("POST", "/compass/sense/check");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ["compassEnabled", "presenceLevel", "evaluated", "delivered", "suppressed"]);
    assert.equal(r.json.evaluated, 1);
  });

  it("some sources unread → 200 partial with failedSources; the readable signal still delivers", async () => {
    const s = baseStore(); seedSavedEvent(s);
    _setTestClient(makeFakeClient(s, { failTables: ["meetup_invites"] }), true);
    const r = await api("POST", "/compass/sense/check");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), [
      "compassEnabled", "presenceLevel", "evaluated", "delivered", "suppressed", "partial", "failedSources",
    ]);
    assert.equal(r.json.partial, true);
    assert.deepEqual(r.json.failedSources, ["circle_plan_change"]);
    assert.equal(r.json.evaluated, 1);
    assert.equal((r.json.delivered as unknown[]).length, 1);
  });

  it("some sources unread and nothing readable fired → partial, never a bare evaluated: 0", async () => {
    _setTestClient(makeFakeClient(baseStore(), { failTables: ["route_plans"] }), true);
    const r = await api("POST", "/compass/sense/check");
    assert.equal(r.status, 200);
    assert.equal(r.json.evaluated, 0);
    assert.equal(r.json.partial, true);
    assert.deepEqual(r.json.failedSources, ["leave_earlier"]);
  });

  it("every source unread → 503 degraded_unavailable with failedSources; nothing written", async () => {
    const s = baseStore(); seedSavedEvent(s); seedCircleChange(s);
    _setTestClient(makeFakeClient(s, { failTables: EVERY_FIRST_READ }), true);
    const r = await api("POST", "/compass/sense/check");
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "degraded_unavailable");
    assert.equal(r.json.retryable, true);
    assert.deepEqual(r.json.failedSources, ALL_SOURCES);
    assert.equal("evaluated" in r.json, false, "a refusal must not carry an evaluated count");
    assert.equal((s.notifications ?? []).length, 0);
    assert.equal((s.compass_sense_nudges ?? []).length, 0);
  });

  it("at night free_time_block needs no read, so the same outage is partial (4 unread), not 503", async () => {
    _setTestHourUtc(3);
    _setTestClient(makeFakeClient(baseStore(), { failTables: EVERY_FIRST_READ }), true);
    const r = await api("POST", "/compass/sense/check");
    assert.equal(r.status, 200);
    assert.equal(r.json.partial, true);
    assert.deepEqual(r.json.failedSources, ALL_SOURCES.filter((x) => x !== "free_time_block"));
  });

  it("presence setting unread → 503 with failedSources ['settings'], not a passive evaluated: 0", async () => {
    const s = baseStore(); seedSavedEvent(s);
    _setTestClient(makeFakeClient(s, { failTables: ["compass_sense_settings"] }), true);
    const r = await api("POST", "/compass/sense/check");
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "degraded_unavailable");
    assert.deepEqual(r.json.failedSources, ["settings"]);
    assert.equal((s.notifications ?? []).length, 0, "an unread presence setting still sends nothing (fail-closed)");
  });

  it("passive is unchanged: nothing is read, so nothing can be unread", async () => {
    _setTestClient(makeFakeClient(baseStore("passive"), { failTables: EVERY_FIRST_READ }), true);
    const r = await api("POST", "/compass/sense/check");
    assert.equal(r.status, 200);
    assert.equal(r.text, '{"compassEnabled":true,"presenceLevel":"passive","evaluated":0,"delivered":[],"suppressed":[]}');
  });
});

/* ── B2. GET /compass/sense/nudges — an unread log is not "no nudges" ────── */

describe("B2. GET /compass/sense/nudges never answers [] over a failed read", () => {
  beforeEach(() => { ANCHOR = Date.now(); });

  it("healthy twin: the shipped body, byte for byte", async () => {
    const s = baseStore();
    s.compass_sense_nudges = [{
      id: "n-1", user_id: USER_ID, nudge_type: "saved_event_starting", category: "events",
      title: "Saved event starting soon", body: "Night market starts soon.", action_url: "/event/evt-1",
      confidence: null, created_at: iso(-60_000),
    }];
    _setTestClient(makeFakeClient(s), true);
    const r = await api("GET", "/compass/sense/nudges");
    assert.equal(r.status, 200);
    assert.equal(
      r.text,
      JSON.stringify({ compassEnabled: true, nudges: [{
        id: "n-1", type: "saved_event_starting", category: "events", title: "Saved event starting soon",
        body: "Night market starts soon.", actionUrl: "/event/evt-1", confidence: null, createdAt: iso(-60_000),
      }] }),
    );
  });

  it("healthy and empty: still { nudges: [] }", async () => {
    _setTestClient(makeFakeClient(baseStore()), true);
    const r = await api("GET", "/compass/sense/nudges");
    assert.equal(r.text, '{"compassEnabled":true,"nudges":[]}');
  });

  it("compass_sense_nudges read error → 503 degraded_unavailable, not an empty list", async () => {
    _setTestClient(makeFakeClient(baseStore(), { failTables: ["compass_sense_nudges"] }), true);
    const r = await api("GET", "/compass/sense/nudges");
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "degraded_unavailable");
    assert.equal(r.json.retryable, true);
    assert.equal("nudges" in r.json, false);
  });

  it("compass_sense_nudges read REJECTS → 503 degraded_unavailable, not an empty list", async () => {
    _setTestClient(makeFakeClient(baseStore(), { rejectTables: ["compass_sense_nudges"] }), true);
    const r = await api("GET", "/compass/sense/nudges");
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "degraded_unavailable");
  });
});

/* ── C. The background sweep records a failed run, not a clean empty one ─── */

describe("C. runSenseSweep counts unread sources as errors", () => {
  const daytime = { hourUtc: 12, nowMinutes: 720 };
  beforeEach(() => { ANCHOR = Date.now(); });

  it("healthy twin: one user evaluated, one nudge, zero errors", async () => {
    const s = baseStore(); seedSavedEvent(s);
    _setSchedulerClient(makeFakeClient(s));
    const summary = await runSenseSweep(daytime);
    assert.deepEqual(summary, { usersEvaluated: 1, nudgesDelivered: 1, errors: 0 });
  });

  it("every source unread → an error, and the user is NOT counted as evaluated", async () => {
    _setSchedulerClient(makeFakeClient(baseStore(), { failTables: EVERY_FIRST_READ }));
    const summary = await runSenseSweep(daytime);
    assert.deepEqual(summary, { usersEvaluated: 0, nudgesDelivered: 0, errors: 1 });
  });

  it("some sources unread → evaluated (the readable signal delivers) AND an error", async () => {
    const s = baseStore(); seedSavedEvent(s);
    _setSchedulerClient(makeFakeClient(s, { failTables: ["route_plans"] }));
    const summary = await runSenseSweep(daytime);
    assert.deepEqual(summary, { usersEvaluated: 1, nudgesDelivered: 1, errors: 1 });
  });
});

/* ── D. Compass Live consumes the same evaluators ─────────────────────────── */

describe("D. Compass Live carries failedSources through a live tick", () => {
  const LIVE_NOW = NOON_MS;

  beforeEach(() => {
    ANCHOR = NOON_MS;
    _setTestNowMs(LIVE_NOW);
    _setLiveTestHourUtc(12);
  });

  it("healthy twin: /compass/live/check carries no coverage keys", async () => {
    const s = baseStore(); seedSavedEvent(s);
    _setTestClient(makeFakeClient(s), true);
    await api("POST", "/compass/live/start");
    const r = await api("POST", "/compass/live/check");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ["compassEnabled", "active", "session", "evaluated", "delivered", "suppressed"]);
  });

  it("a Sense source unread during a live tick → partial + failedSources on the route", async () => {
    const s = baseStore(); seedSavedEvent(s);
    _setTestClient(makeFakeClient(s, { failTables: ["meetup_invites"] }), true);
    await api("POST", "/compass/live/start");
    const r = await api("POST", "/compass/live/check");
    assert.equal(r.status, 200);
    assert.equal(r.json.partial, true);
    assert.deepEqual(r.json.failedSources, ["circle_plan_change"]);
  });

  it("runLiveCheck itself returns failedSources (engine level)", async () => {
    const s = baseStore();
    const sc = makeFakeClient(s, { failTables: ["event_saves"] });
    _setTestClient(sc, true);
    await api("POST", "/compass/live/start");
    const r = await runLiveCheck(sc, USER_ID, { nowMs: LIVE_NOW, hourUtc: 12 });
    assert.equal(r.active, true);
    assert.deepEqual(r.failedSources, ["saved_event_starting"]);
  });
});
