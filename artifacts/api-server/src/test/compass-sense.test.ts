/**
 * Compass Sense (Phase 11) route + engine tests.
 *
 * Covers:
 *   - auth required, COMPASS_ENABLED off → honest fallback envelope
 *   - default settings (passive + all categories on), PUT validation
 *   - Passive silence: genuine signals seeded, nothing evaluated or sent
 *   - Genuine-signal-only firing: no data → no nudges; saved event within 2h
 *     fires; leave-earlier only when travel time genuinely exceeds time left
 *   - Weather nudges only when real plan items exist today
 *   - Per-category permission enforcement (server-side)
 *   - Aware presence blocks non-time-critical categories; Active allows them
 *   - Quiet hours suppression
 *   - Dedupe: same nudge never delivers twice in a day
 *   - Storm throttling: many simultaneous signals → bounded by the daily cap
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-sense.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import compassSenseRouter, { _setTestHourUtc, _setTestNowMinutes } from "../routes/compassSense.js";
import { ACTIVE_DAILY_CAP, runSense } from "../compass/CompassSenseEngine.js";
import { clearUserTimezoneCache } from "../lib/localTime.js";

const USER_ID = "00000000-0000-0000-0000-000000000001";

/* ── Permissive fake Supabase client ──────────────────────────────────────────
 * Chainable builder with real eq/neq/in/gte/lte/gt filtering and mutating
 * insert/upsert so the durable nudge log, settings, and notification rows
 * behave like a store across calls within one test.
 */
type Row = Record<string, unknown>;

let idCounter = 0;

function makeFakeClient(store: Record<string, Row[]> = {}) {
  function tbl(name: string): Row[] {
    if (!store[name]) store[name] = [];
    return store[name]!;
  }

  function builder(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _limit: number | null = null;
    let _lastWritten: Row[] | null = null;

    function rows(): Row[] {
      let out = tbl(tableName).filter((r) => filters.every((f) => f(r)));
      if (_limit !== null) out = out.slice(0, _limit);
      return out;
    }

    function result(): Row[] {
      return _lastWritten ?? rows();
    }

    const passthrough = new Set([
      "select", "order", "or", "like", "ilike", "not", "is",
      "contains", "overlaps", "range", "textSearch", "filter", "match",
    ]);

    const b: any = new Proxy({}, {
      get(_target, prop: string) {
        if (prop === "then") {
          return (resolve: Function) => resolve({ data: result(), error: null });
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => Promise.resolve({ data: result()[0] ?? null, error: result()[0] ? null : (prop === "single" ? { code: "PGRST116" } : null) });
        }
        if (prop === "limit") return (n: number) => { _limit = n; return b; };
        if (prop === "eq")  return (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; };
        if (prop === "neq") return (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; };
        if (prop === "in")  return (k: string, vs: unknown[]) => { filters.push((r) => (vs as unknown[]).includes(r[k])); return b; };
        if (prop === "gte") return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") >= String(v)); return b; };
        if (prop === "lte") return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") <= String(v)); return b; };
        if (prop === "gt")  return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") > String(v)); return b; };
        if (prop === "insert") {
          return (payload: Row | Row[]) => {
            const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({
              id: `gen-${++idCounter}`,
              created_at: new Date().toISOString(),
              ...r,
            }));
            tbl(tableName).push(...arr);
            _lastWritten = arr;
            return b;
          };
        }
        if (prop === "upsert") {
          return (payload: Row | Row[], opts?: { onConflict?: string }) => {
            const key = opts?.onConflict ?? "id";
            const arr = Array.isArray(payload) ? payload : [payload];
            for (const r of arr) {
              const existing = tbl(tableName).find((e) => e[key] === r[key]);
              if (existing) Object.assign(existing, r);
              else tbl(tableName).push({ ...r });
            }
            _lastWritten = arr;
            return b;
          };
        }
        if (prop === "update" || prop === "delete") return (..._a: unknown[]) => b;
        if (passthrough.has(prop)) return (..._a: unknown[]) => b;
        return (..._a: unknown[]) => b;
      },
    });
    return b;
  }

  return {
    fakeClient: {
      from: (name: string) => builder(name),
      auth: {
        getUser: (token: string) =>
          token === "valid-token"
            ? Promise.resolve({ data: { user: { id: USER_ID } }, error: null })
            : Promise.resolve({ data: { user: null }, error: { message: "bad token" } }),
      },
    } as any,
    store,
  };
}

/* ── Mini express app ─────────────────────────────────────────────────────── */

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.log = pino({ level: "silent" });
  next();
});
testApp.use("/api", compassSenseRouter);

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
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  invalidateFlagsCache();
  _setTestHourUtc(12);      // daytime by default
  _setTestNowMinutes(720);  // 12:00 — outside any quiet window used below
});

async function api(method: string, path: string, body?: unknown, token = "valid-token") {
  const resp = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

/* ── Seed helpers ─────────────────────────────────────────────────────────── */

function enabledFlag(): Row {
  return { flag: "COMPASS_ENABLED", enabled: true };
}

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3600_000).toISOString();
}

function senseSettings(level: string, categories: Record<string, boolean> = {}): Row {
  return { user_id: USER_ID, presence_level: level, categories };
}

function savedEventSignal(store: Record<string, Row[]>, n = 1, startHours = 1): void {
  store.event_saves ??= [];
  store.events ??= [];
  for (let i = 0; i < n; i++) {
    const id = `evt-${i}`;
    store.event_saves.push({ event_id: id, user_id: USER_ID });
    store.events.push({ id, title: `Event ${i}`, starts_at: hoursFromNow(startHours), state: "published" });
  }
}

function circleChangeSignal(store: Record<string, Row[]>): void {
  store.meetup_invites = [{ meetup_id: "m-1", user_id: USER_ID, status: "going" }];
  store.meetups = [{ id: "m-1", title: "Sunset drinks", status: "cancelled", updated_at: new Date().toISOString() }];
}

function activeTrip(store: Record<string, Row[]>, city: string): void {
  // FIXTURE REPAIRED: `status: "in_progress"` is not a label of the
  // `trip_status` enum (draft | planning | upcoming | active | completed |
  // cancelled | archived), so the fake client matched the production
  // filter while PostgREST would have rejected BOTH with 22P02. The test
  // proved the code matched the fixture and nothing about the database.
  store.trips = [{ id: "trip-1", owner_id: USER_ID, destination_city: city, status: "active" }];
  store.trip_members = [];
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function weatherCacheRow(city: string, code: number, precip: number): Row {
  const today = todayStr();
  return {
    destination: city.toLowerCase(),
    date_key: `${today}:${today}`,
    fetched_at: new Date().toISOString(),
    brief_summary: "seeded",
    forecasts_json: [{ date: today, weatherCode: code, summary: code >= 51 ? "Rainy" : "Clear", maxTempC: 30, minTempC: 24, precipMm: precip }],
  };
}

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe("Compass Sense", () => {
  it("requires auth", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    const r = await api("POST", "/compass/sense/check", {}, "bad-token");
    assert.equal(r.status, 401);
  });

  it("returns honest fallback when COMPASS_ENABLED is off", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [] });
    _setTestClient(fakeClient, true);
    const r = await api("GET", "/compass/sense/settings");
    assert.equal(r.status, 200);
    assert.equal(r.json.compassEnabled, false);
    assert.equal(r.json.fallback, true);
  });

  it("defaults to passive presence with all categories enabled", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    const r = await api("GET", "/compass/sense/settings");
    assert.equal(r.json.settings.presenceLevel, "passive");
    for (const v of Object.values(r.json.settings.categories)) assert.equal(v, true);
  });

  it("PUT updates presence + categories and rejects unknown categories", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    const ok = await api("PUT", "/compass/sense/settings", {
      presenceLevel: "aware",
      categories: { events: false },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.settings.presenceLevel, "aware");
    assert.equal(ok.json.settings.categories.events, false);
    assert.equal(ok.json.settings.categories.weather, true);

    const bad = await api("PUT", "/compass/sense/settings", { categories: { spam: true } });
    assert.equal(bad.status, 400);

    const bad2 = await api("PUT", "/compass/sense/settings", { presenceLevel: "loud" });
    assert.equal(bad2.status, 400);
  });

  it("Passive is fully silent even with genuine signals present", async () => {
    const store: Record<string, Row[]> = { feature_flags: [enabledFlag()] };
    savedEventSignal(store, 2);
    circleChangeSignal(store);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    const r = await api("POST", "/compass/sense/check", {});
    assert.equal(r.json.presenceLevel, "passive");
    assert.equal(r.json.evaluated, 0);
    assert.equal(r.json.delivered.length, 0);
    assert.equal((store.notifications ?? []).length, 0);
    assert.equal((store.compass_sense_nudges ?? []).length, 0);
  });

  it("no real signals → nothing fires (no scheduled spam)", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("active")],
    };
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    const r = await api("POST", "/compass/sense/check", {});
    assert.equal(r.json.evaluated, 0);
    assert.equal(r.json.delivered.length, 0);
    assert.equal((store.notifications ?? []).length, 0);
  });

  it("saved event within 2h fires with confidence label and real deep link", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("aware")],
    };
    savedEventSignal(store, 1, 1);
    // saved event outside the window must NOT fire
    store.event_saves!.push({ event_id: "evt-far", user_id: USER_ID });
    store.events!.push({ id: "evt-far", title: "Far event", starts_at: hoursFromNow(30), state: "published" });
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    const r = await api("POST", "/compass/sense/check", {});
    assert.equal(r.json.delivered.length, 1);
    const nudge = r.json.delivered[0];
    assert.equal(nudge.type, "saved_event_starting");
    assert.equal(nudge.actionUrl, "/event/evt-0");
    assert.equal(nudge.confidence.sourceClass, "verified_live");
    assert.ok(nudge.confidence.label);
    // Delivered through the existing notification pathway
    const notifs = store.notifications ?? [];
    assert.equal(notifs.length, 1);
    assert.equal(notifs[0]!.event_type, "compass.sense.saved_event_starting");
    assert.equal(notifs[0]!.category, "compass");
    assert.equal(notifs[0]!.action_url, "/event/evt-0");
  });

  it("leave-earlier fires only when travel time genuinely exceeds time left", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("aware")],
      route_plans: [{ id: "rp-1", title: "Day route", owner_user_id: USER_ID }],
      route_stops: [
        // 30 min until arrival, 60 min travel → genuine "leave earlier"
        { id: "st-1", route_plan_id: "rp-1", title: "Museum", order_index: 1, checkpoint_status: "pending", planned_arrival_time: new Date(Date.now() + 30 * 60_000).toISOString() },
      ],
      route_legs: [{ route_plan_id: "rp-1", to_stop_id: "st-1", duration_seconds: 3600 }],
    };
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    const r = await api("POST", "/compass/sense/check", {});
    assert.equal(r.json.delivered.length, 1);
    assert.equal(r.json.delivered[0].type, "leave_earlier");
    assert.equal(r.json.delivered[0].actionUrl, "/route-plan/rp-1");

    // Ample time (2h left, 20 min travel) → silence
    const store2: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("aware")],
      route_plans: [{ id: "rp-2", title: "Easy route", owner_user_id: USER_ID }],
      route_stops: [
        { id: "st-2", route_plan_id: "rp-2", title: "Cafe", order_index: 1, checkpoint_status: "pending", planned_arrival_time: new Date(Date.now() + 120 * 60_000).toISOString() },
      ],
      route_legs: [{ route_plan_id: "rp-2", to_stop_id: "st-2", duration_seconds: 1200 }],
    };
    const { fakeClient: fc2 } = makeFakeClient(store2);
    _setTestClient(fc2, true);
    const r2 = await api("POST", "/compass/sense/check", {});
    assert.equal(r2.json.delivered.length, 0);
    assert.equal(r2.json.evaluated, 0);
  });

  it("weather nudge fires only when real plan items exist today", async () => {
    const city = "SenseRainCity";
    const today = todayStr();
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("aware")],
      weather_cache: [weatherCacheRow(city, 61, 8)],
      trip_plan_items: [{ id: "pi-1", trip_id: "trip-1", day_date: today, starts_at: null, status: "planned", removed_at: null }],
    };
    activeTrip(store, city);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    const r = await api("POST", "/compass/sense/check", {});
    assert.equal(r.json.delivered.length, 1);
    assert.equal(r.json.delivered[0].type, "weather_change");
    assert.ok(r.json.delivered[0].title.includes(city));
    assert.equal(r.json.delivered[0].actionUrl, "/trip/trip-1");

    // Same rainy forecast but NO plan items today → silence (no fabricated relevance)
    const city2 = "SenseRainCityTwo";
    const store2: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("aware")],
      weather_cache: [weatherCacheRow(city2, 61, 8)],
      trip_plan_items: [],
    };
    activeTrip(store2, city2);
    const { fakeClient: fc2 } = makeFakeClient(store2);
    _setTestClient(fc2, true);
    const r2 = await api("POST", "/compass/sense/check", {});
    assert.equal(r2.json.delivered.length, 0);
  });

  it("per-category permission is enforced server-side", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("aware", { events: false })],
    };
    savedEventSignal(store, 1);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    const r = await api("POST", "/compass/sense/check", {});
    assert.equal(r.json.delivered.length, 0);
    assert.equal(r.json.suppressed.length, 1);
    assert.equal(r.json.suppressed[0].reason, "category_disabled");
    assert.equal((store.notifications ?? []).length, 0);
  });

  it("aware blocks circle nudges; active allows them", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("aware")],
    };
    circleChangeSignal(store);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    const r = await api("POST", "/compass/sense/check", {});
    assert.equal(r.json.delivered.length, 0);
    assert.equal(r.json.suppressed[0].reason, "presence_aware_category");

    store.compass_sense_settings = [senseSettings("active")];
    const r2 = await api("POST", "/compass/sense/check", {});
    assert.equal(r2.json.delivered.length, 1);
    assert.equal(r2.json.delivered[0].type, "circle_plan_change");
    assert.equal(r2.json.delivered[0].actionUrl, "/meetup/m-1");
  });

  it("quiet hours silence all sense nudges", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("aware")],
      notification_preferences: [{ user_id: USER_ID, quiet_hours_enabled: true, quiet_start: "22:00", quiet_end: "08:00", timezone: null }],
    };
    savedEventSignal(store, 1);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    _setTestNowMinutes(23 * 60); // 23:00 — inside quiet window
    const r = await api("POST", "/compass/sense/check", {});
    assert.equal(r.json.delivered.length, 0);
    assert.equal(r.json.suppressed[0].reason, "quiet_hours");

    _setTestNowMinutes(12 * 60); // noon — outside quiet window
    const r2 = await api("POST", "/compass/sense/check", {});
    assert.equal(r2.json.delivered.length, 1);
  });

  it("the same nudge never delivers twice (dedupe)", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("aware")],
    };
    savedEventSignal(store, 1);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    const r1 = await api("POST", "/compass/sense/check", {});
    assert.equal(r1.json.delivered.length, 1);

    const r2 = await api("POST", "/compass/sense/check", {});
    assert.equal(r2.json.delivered.length, 0);
    assert.equal(r2.json.suppressed[0].reason, "duplicate");
    assert.equal((store.compass_sense_nudges ?? []).length, 1);
  });

  it("signal storm produces a bounded number of alerts (daily cap)", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("active")],
    };
    savedEventSignal(store, 12); // 12 simultaneous genuine signals
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    const r = await api("POST", "/compass/sense/check", {});
    assert.equal(r.json.evaluated, 12);
    assert.equal(r.json.delivered.length, ACTIVE_DAILY_CAP);
    const capped = r.json.suppressed.filter((s: any) => s.reason === "daily_cap");
    assert.equal(capped.length, 12 - ACTIVE_DAILY_CAP);
    assert.equal((store.notifications ?? []).length, ACTIVE_DAILY_CAP);

    // A second storm the same day delivers nothing more
    savedEventSignal(store, 0);
    const r2 = await api("POST", "/compass/sense/check", {});
    assert.equal(r2.json.delivered.length, 0);
  });

  it("free-time block fires only in daytime on a planned day with a real gap", async () => {
    const today = todayStr();
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("active")],
      trip_plan_items: [
        { id: "pi-1", trip_id: "trip-1", day_date: today, starts_at: hoursFromNow(5), status: "planned", removed_at: null },
      ],
      // neutral forecast so the weather evaluator stays silent
      weather_cache: [weatherCacheRow("SenseFreeCity", 45, 1)],
    };
    activeTrip(store, "SenseFreeCity");
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    const r = await api("POST", "/compass/sense/check", {});
    assert.equal(r.json.delivered.length, 1);
    assert.equal(r.json.delivered[0].type, "free_time_block");
    assert.equal(r.json.delivered[0].confidence.sourceClass, "ai_inference");

    // Night time → silence
    const store2: Record<string, Row[]> = JSON.parse(JSON.stringify(store));
    store2.compass_sense_nudges = [];
    store2.notifications = [];
    const { fakeClient: fc2 } = makeFakeClient(store2);
    _setTestClient(fc2, true);
    _setTestHourUtc(23);
    const r2 = await api("POST", "/compass/sense/check", {});
    assert.equal(r2.json.delivered.filter((d: any) => d.type === "free_time_block").length, 0);
  });

  it("stored UTC-far timezone governs the free-time daytime window — UTC 03:00 is daytime in Asia/Shanghai", async () => {
    // UTC 03:00 → raw UTC hour = 3 (< 9 → nighttime by UTC, no free-time block).
    // Asia/Shanghai is UTC+8 → local hour = 11 (daytime → free_time_block should fire).
    const nowMs = new Date("2025-06-15T03:00:00.000Z").getTime();
    const today = "2025-06-15";
    // Plan item 5 hours after nowMs so the gap is well above the 3-hour threshold.
    const planStartsAt = new Date("2025-06-15T08:00:00.000Z").toISOString();

    function buildStore(tz: string | null): Record<string, Row[]> {
      return {
        feature_flags: [enabledFlag()],
        compass_sense_settings: [senseSettings("active")],
        notification_preferences: tz ? [{ user_id: USER_ID, timezone: tz }] : [],
        trips: [{ id: "trip-tz", owner_id: USER_ID, destination_city: "ShanghaiFreeCity", status: "active" }], // real trip_status label; see activeTrip()
        trip_members: [],
        trip_plan_items: [
          { id: "pi-tz", trip_id: "trip-tz", day_date: today, starts_at: planStartsAt, status: "planned", removed_at: null },
        ],
        // neutral forecast so the weather evaluator stays silent
        weather_cache: [weatherCacheRow("ShanghaiFreeCity", 45, 1)],
      };
    }

    // Asia/Shanghai: local time is 11:00 → daytime → free_time_block must fire.
    clearUserTimezoneCache(USER_ID);
    const { fakeClient: fcSH } = makeFakeClient(buildStore("Asia/Shanghai"));
    const r1 = await runSense(fcSH as any, USER_ID, { nowMs });
    const freeBlockSH = r1.delivered.find((d) => d.type === "free_time_block");
    assert.ok(freeBlockSH, "free_time_block should fire when local time (11:00 Asia/Shanghai) is daytime");

    // UTC timezone: local time is 03:00 → nighttime → free_time_block must NOT fire.
    clearUserTimezoneCache(USER_ID);
    const { fakeClient: fcUTC } = makeFakeClient(buildStore("UTC"));
    const r2 = await runSense(fcUTC as any, USER_ID, { nowMs });
    const freeBlockUTC = r2.delivered.find((d) => d.type === "free_time_block");
    assert.equal(freeBlockUTC, undefined, "free_time_block should NOT fire when local time (03:00 UTC) is nighttime");

    // No stored timezone at all: falls back to UTC → same nighttime result.
    clearUserTimezoneCache(USER_ID);
    const { fakeClient: fcNone } = makeFakeClient(buildStore(null));
    const r3 = await runSense(fcNone as any, USER_ID, { nowMs });
    const freeBlockNone = r3.delivered.find((d) => d.type === "free_time_block");
    assert.equal(freeBlockNone, undefined, "free_time_block should NOT fire when no timezone stored (UTC fallback 03:00)");
  });

  it("GET /compass/sense/nudges returns the delivered log", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings("aware")],
    };
    savedEventSignal(store, 1);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient, true);

    await api("POST", "/compass/sense/check", {});
    const r = await api("GET", "/compass/sense/nudges");
    assert.equal(r.json.nudges.length, 1);
    assert.equal(r.json.nudges[0].type, "saved_event_starting");
    assert.ok(r.json.nudges[0].confidence);
  });
});
