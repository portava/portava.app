/**
 * Compass Live (Phase 12) route + engine tests.
 *
 * Covers:
 *   - auth required, COMPASS_ENABLED off → honest fallback envelope
 *   - explicit lifecycle: start creates one active session, second start is
 *     idempotent, stop ends it and returns an end-of-session summary
 *   - rolling context carries across a simulated sequence of events: as time
 *     advances past plan items, currentStop/nextItem update and transition
 *     events accumulate in recentEvents across checks
 *   - clean shutdown: after stop, checks evaluate NOTHING and write nothing
 *     (no new nudge rows, session row untouched)
 *   - nudge timeliness: live_next_up only within 30 min of the next item,
 *     live_arriving_early only in the 45 min–3 h window, live_ride_home only
 *     late night
 *   - per-category permissions honored during live sessions; presence level
 *     does NOT gate (live is an explicit opt-in)
 *   - dedupe: the same live nudge never delivers twice
 *   - chat grounding: buildLiveChatContextLines returns session lines only
 *     while a session is active
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-live.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import compassLiveRouter, { _setTestNowMs, _setTestHourUtc } from "../routes/compassLive.js";
import { buildLiveChatContextLines } from "../compass/CompassLiveEngine.js";

const USER_ID = "00000000-0000-0000-0000-000000000001";

/* ── Permissive fake Supabase client ──────────────────────────────────────────
 * Chainable builder with real eq/neq/in/gte/lte/gt filtering, mutating
 * insert/upsert AND mutating update (compass_live_sessions rolling context
 * persistence depends on update actually applying).
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
    let _pendingUpdate: Row | null = null;

    function rows(): Row[] {
      let out = tbl(tableName).filter((r) => filters.every((f) => f(r)));
      if (_limit !== null) out = out.slice(0, _limit);
      return out;
    }

    function applyPendingUpdate(): void {
      if (!_pendingUpdate) return;
      for (const r of tbl(tableName)) {
        if (filters.every((f) => f(r))) Object.assign(r, _pendingUpdate);
      }
      _lastWritten = null;
      _pendingUpdate = null;
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
          return (resolve: Function) => {
            applyPendingUpdate();
            resolve({ data: result(), error: null });
          };
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => {
            applyPendingUpdate();
            return Promise.resolve({ data: result()[0] ?? null, error: result()[0] ? null : (prop === "single" ? { code: "PGRST116" } : null) });
          };
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
        if (prop === "update") {
          return (payload: Row) => { _pendingUpdate = { ...payload }; return b; };
        }
        if (prop === "delete") return (..._a: unknown[]) => b;
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
  _setTestNowMs(null);
  _setTestHourUtc(null);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

/* Base "now": today 08:00 UTC — plan items later the same day never cross
 * midnight as tests advance time. */
const TODAY = new Date().toISOString().slice(0, 10);
const BASE_MS = new Date(`${TODAY}T08:00:00.000Z`).getTime();

beforeEach(() => {
  invalidateFlagsCache();
  _setTestNowMs(BASE_MS);
  _setTestHourUtc(null); // derive from nowMs unless a test overrides
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

function atHour(h: number, m = 0): string {
  return new Date(BASE_MS + ((h - 8) * 60 + m) * 60_000).toISOString();
}

function seedTrip(store: Record<string, Row[]>, city = "Cebu City"): void {
  // FIXTURE REPAIRED: `status: "in_progress"` is not a label of the
  // `trip_status` enum (draft | planning | upcoming | active | completed |
  // cancelled | archived), so the fake client matched the production
  // filter while PostgREST would have rejected BOTH with 22P02. The test
  // proved the code matched the fixture and nothing about the database.
  store.trips = [{ id: "trip-1", owner_id: USER_ID, destination_city: city, status: "active" }];
  store.trip_members = [];
  // Neutral cached forecast (not rainy, not clear) so the Phase 11 weather
  // evaluator neither fires nor reaches out to the live Open-Meteo API.
  store.weather_cache = [{
    destination: city.toLowerCase(),
    date_key: `${TODAY}:${TODAY}`,
    fetched_at: new Date().toISOString(),
    brief_summary: "seeded",
    forecasts_json: [{ date: TODAY, weatherCode: 45, summary: "Foggy", maxTempC: 30, minTempC: 24, precipMm: 1 }],
  }];
}

function seedPlanItem(store: Record<string, Row[]>, id: string, title: string, startsAtIso: string): void {
  store.trip_plan_items ??= [];
  store.trip_plan_items.push({
    id, trip_id: "trip-1", title, starts_at: startsAtIso,
    status: "planned", day_date: TODAY, removed_at: null,
  });
}

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe("Compass Live", () => {
  it("requires auth", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    const r = await api("POST", "/compass/live/start", {}, "bad-token");
    assert.equal(r.status, 401);
  });

  it("returns honest fallback when COMPASS_ENABLED is off", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [] });
    _setTestClient(fakeClient, true);
    const r = await api("GET", "/compass/live/session");
    assert.equal(r.status, 200);
    assert.equal(r.json.compassEnabled, false);
    assert.equal(r.json.fallback, true);
  });

  it("starts a session explicitly, is idempotent, and reports state", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);

    const none = await api("GET", "/compass/live/session");
    assert.equal(none.json.active, false);

    const start = await api("POST", "/compass/live/start");
    assert.equal(start.status, 201);
    assert.equal(start.json.active, true);
    assert.equal(start.json.alreadyActive, false);
    const id = start.json.session.id;
    assert.equal(start.json.session.context.recentEvents[0].kind, "session_started");

    const again = await api("POST", "/compass/live/start");
    assert.equal(again.status, 200);
    assert.equal(again.json.alreadyActive, true);
    assert.equal(again.json.session.id, id);

    const state = await api("GET", "/compass/live/session");
    assert.equal(state.json.active, true);
    assert.equal(state.json.session.id, id);
  });

  it("carries rolling context across a simulated sequence of events", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    seedTrip(store);
    seedPlanItem(store, "item-a", "Basilica visit", atHour(9));
    seedPlanItem(store, "item-b", "Lechon lunch", atHour(11));

    await api("POST", "/compass/live/start");

    // T0 = 08:00 — nothing reached yet, Basilica is next.
    const c1 = await api("POST", "/compass/live/check");
    assert.equal(c1.json.active, true);
    assert.equal(c1.json.session.context.currentStop, null);
    assert.equal(c1.json.session.context.nextItem.id, "item-a");
    assert.equal(c1.json.session.context.city, "Cebu City");

    // T1 = 09:30 — Basilica reached, lunch is next; transition recorded.
    _setTestNowMs(BASE_MS + 90 * 60_000);
    const c2 = await api("POST", "/compass/live/check");
    assert.equal(c2.json.session.context.currentStop.id, "item-a");
    assert.equal(c2.json.session.context.nextItem.id, "item-b");
    const kinds2 = c2.json.session.context.recentEvents.map((e: any) => e.kind);
    assert.ok(kinds2.includes("session_started"));
    assert.ok(kinds2.includes("reached_stop"));

    // T2 = 11:30 — lunch reached too; context still carries earlier events.
    _setTestNowMs(BASE_MS + 210 * 60_000);
    const c3 = await api("POST", "/compass/live/check");
    assert.equal(c3.json.session.context.currentStop.id, "item-b");
    const events3 = c3.json.session.context.recentEvents;
    const reached = events3.filter((e: any) => e.kind === "reached_stop").map((e: any) => e.detail);
    assert.deepEqual(reached, ["Basilica visit", "Lechon lunch"]);
    assert.ok(events3.some((e: any) => e.kind === "session_started"), "context carried from session start");
    assert.equal(c3.json.session.checksRun, 3);
  });

  it("emits a realtime notification.created event when a live nudge is delivered — and none after stop", async () => {
    const { activityBus } = await import("../services/notifications/RealtimeActivityService.js");
    const seen: any[] = [];
    const unsub = activityBus.subscribe((e) => { if (e.type === "notification.created") seen.push(e); });
    try {
      const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
      _setTestClient(fakeClient, true);
      seedTrip(store);
      seedPlanItem(store, "item-rt", "Gallery walk", atHour(8, 15)); // 15 min away → live_next_up

      await api("POST", "/compass/live/start");
      const r = await api("POST", "/compass/live/check");
      assert.ok(r.json.delivered.some((d: any) => d.type === "live_next_up"));
      const live = seen.filter((e) => String(e.payload?.eventType ?? "").startsWith("compass.live."));
      assert.ok(live.length >= 1, "expected an SSE notification.created emit for the live nudge");
      assert.equal(live[0].userId, USER_ID);
      assert.equal(live[0].payload.category, "compass");

      // After stop: check is inert — no evaluation, no emission of any kind.
      await api("POST", "/compass/live/stop");
      seen.length = 0;
      const after = await api("POST", "/compass/live/check");
      assert.equal(after.json.active, false);
      assert.equal(seen.length, 0, "no realtime emission after the session is stopped");
    } finally {
      unsub();
    }
  });

  it("delivers live_next_up only within 30 minutes of the next item", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    seedTrip(store);
    seedPlanItem(store, "item-soon", "Museum entry", atHour(8, 20)); // 20 min away

    await api("POST", "/compass/live/start");
    const r = await api("POST", "/compass/live/check");
    const types = r.json.delivered.map((d: any) => d.type);
    assert.ok(types.includes("live_next_up"), `expected live_next_up in ${types}`);
    assert.ok(!types.includes("live_arriving_early"));
  });

  it("delivers live_arriving_early only in the 45min–3h window (40 min gap → neither)", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    seedTrip(store);
    seedPlanItem(store, "item-mid", "Fort tour", atHour(8, 40)); // 40 min — between windows

    await api("POST", "/compass/live/start");
    const r1 = await api("POST", "/compass/live/check");
    const t1 = r1.json.delivered.map((d: any) => d.type);
    assert.ok(!t1.includes("live_next_up") && !t1.includes("live_arriving_early"), `40min gap should be quiet, got ${t1}`);

    // Fresh store: 2h gap → arriving early.
    const second = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(second.fakeClient, true);
    seedTrip(second.store);
    seedPlanItem(second.store, "item-late", "Dinner", atHour(10)); // 2 h away
    await api("POST", "/compass/live/start");
    const r2 = await api("POST", "/compass/live/check");
    const t2 = r2.json.delivered.map((d: any) => d.type);
    assert.ok(t2.includes("live_arriving_early"), `expected live_arriving_early in ${t2}`);
  });

  it("routes every delivered live nudge to the AI live surface (/(tabs)/ai)", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    seedTrip(store);
    seedPlanItem(store, "item-soon", "Museum entry", atHour(8, 20)); // live_next_up

    await api("POST", "/compass/live/start");
    _setTestHourUtc(23); // also trigger live_ride_home
    const r = await api("POST", "/compass/live/check");
    assert.ok(r.json.delivered.length >= 2, `expected multiple nudges, got ${r.json.delivered.length}`);
    for (const d of r.json.delivered) {
      assert.equal(d.actionUrl, "/(tabs)/ai", `nudge ${d.type} should point at the live surface, got ${d.actionUrl}`);
    }
  });

  it("offers ride-home help only late at night", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    await api("POST", "/compass/live/start");

    const day = await api("POST", "/compass/live/check");
    assert.ok(!day.json.delivered.some((d: any) => d.type === "live_ride_home"));

    _setTestHourUtc(23);
    const night = await api("POST", "/compass/live/check");
    assert.ok(night.json.delivered.some((d: any) => d.type === "live_ride_home"));
  });

  it("honors per-category permissions during live sessions", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    store.compass_sense_settings = [{ user_id: USER_ID, presence_level: "passive", categories: { timing: false } }];
    seedTrip(store);
    seedPlanItem(store, "item-soon", "Museum entry", atHour(8, 20));

    await api("POST", "/compass/live/start");
    const r = await api("POST", "/compass/live/check");
    assert.equal(r.json.delivered.length, 0);
    assert.ok(r.json.suppressed.some((s: any) => s.reason === "category_disabled"));
  });

  it("never delivers the same live nudge twice (durable dedupe)", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    seedTrip(store);
    seedPlanItem(store, "item-soon", "Museum entry", atHour(8, 20));

    await api("POST", "/compass/live/start");
    const first = await api("POST", "/compass/live/check");
    assert.equal(first.json.delivered.length, 1);
    const secondCheck = await api("POST", "/compass/live/check");
    assert.equal(secondCheck.json.delivered.length, 0);
    assert.ok(secondCheck.json.suppressed.some((s: any) => s.reason === "duplicate"));
  });

  it("stops cleanly with an end-of-session summary and ZERO activity after stop", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    seedTrip(store);
    seedPlanItem(store, "item-a", "Basilica visit", atHour(9));

    await api("POST", "/compass/live/start");
    _setTestNowMs(BASE_MS + 90 * 60_000);
    await api("POST", "/compass/live/check");

    _setTestNowMs(BASE_MS + 120 * 60_000);
    const stop = await api("POST", "/compass/live/stop");
    assert.equal(stop.json.stopped, true);
    assert.equal(stop.json.summary.durationMinutes, 120);
    assert.equal(stop.json.summary.checksRun, 1);
    assert.equal(stop.json.summary.stopsReached, 1);
    assert.equal(stop.json.summary.city, "Cebu City");

    // Post-stop: no active session, nothing evaluated, nothing written.
    const nudgeRowsBefore = (store.compass_sense_nudges ?? []).length;
    const sessionRow = store.compass_live_sessions![0] as any;
    const checksBefore = sessionRow.checks_run;

    const after1 = await api("POST", "/compass/live/check");
    assert.equal(after1.json.active, false);
    assert.equal(after1.json.evaluated, 0);
    assert.equal(after1.json.delivered.length, 0);
    assert.equal((store.compass_sense_nudges ?? []).length, nudgeRowsBefore);
    assert.equal(sessionRow.checks_run, checksBefore);
    assert.equal(sessionRow.status, "ended");

    // Stopping again is a no-op, not an error.
    const stopAgain = await api("POST", "/compass/live/stop");
    assert.equal(stopAgain.json.stopped, false);
    assert.equal(stopAgain.json.summary, null);
  });

  it("grounds chat context only while a session is active", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    seedTrip(store);
    seedPlanItem(store, "item-b", "Lechon lunch", atHour(11));

    const before = await buildLiveChatContextLines(fakeClient, USER_ID, BASE_MS);
    assert.deepEqual(before, []);

    await api("POST", "/compass/live/start");
    _setTestNowMs(BASE_MS + 60 * 60_000);
    await api("POST", "/compass/live/check");

    const lines = await buildLiveChatContextLines(fakeClient, USER_ID, BASE_MS + 60 * 60_000);
    assert.ok(lines[0].includes("Live session: ACTIVE"));
    assert.ok(lines.some((l) => l.includes("Cebu City")));
    assert.ok(lines.some((l) => l.includes("Lechon lunch")));
    // The plan-item title (UGC — a co-member can set it) must reach the /ask
    // prompt wrapped in <portava:ugc>, never as bare, trustable text.
    assert.ok(
      lines.some((l) => l.includes("<portava:ugc>Lechon lunch</portava:ugc>")),
      "live stop / next-item titles are UGC-wrapped",
    );

    await api("POST", "/compass/live/stop");
    const afterStop = await buildLiveChatContextLines(fakeClient, USER_ID, BASE_MS + 61 * 60_000);
    assert.deepEqual(afterStop, []);
  });
});
