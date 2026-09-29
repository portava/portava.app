/**
 * Compass Sense — the three fail-open reads census-compass §30 left open, closed.
 *
 * THE DEFECTS THIS PINS
 * =====================
 * supabase-js RESOLVES on a database error (`{ data: null, error }`). §30 made
 * the five signal evaluators name an unread source; three reads around them
 * still turned "could not read" into a permissive answer:
 *
 *  A. `getSenseSettings` answered the `passive` default over an unread row, so
 *     GET /compass/sense/settings told the traveller "Sense is on Passive" when
 *     the truth was "we could not read it", and PUT merged the patch into those
 *     defaults and UPSERTED them — overwriting every stored category the
 *     traveller had turned off. PUT also ignored its own write error and
 *     answered 200 with settings that were never saved.
 *  B. `countDeliveredToday` read an unread nudge log as 0 delivered today, so
 *     the daily cap (a "no spam" promise) failed OPEN: a traveller already at
 *     the cap was sent more.
 *  C. `runLiveCheck`'s own settings read fell back to every category ON, so a
 *     category the traveller had turned off was delivered during a settings
 *     outage.
 *
 * WHAT IS ASSERTED
 * ================
 *  A. GET answers 503 `degraded_unavailable` over an unread row (never
 *     `passive`); PUT refuses (503, nothing written) when it needs the current
 *     row and cannot read it; a PUT that sends every field needs no read and
 *     writes exactly what was sent; a failed write is a 503. Healthy bodies are
 *     byte-identical.
 *  B. An unread count delivers nothing (`daily_cap_unread`) and says so:
 *     `failedSources: ["nudge_log"]`, a 200 `partial` on the route, an error in
 *     the sweep. Healthy cap behaviour is unchanged.
 *  C. A live tick over an unread settings row delivers nothing
 *     (`permission_unread`) and reports `failedSources: [..., "settings"]`.
 *
 * Runtime: node:test + node:assert (no real DB)
 * Run: node --import tsx/esm --test src/test/compassSenseFailClosed.test.ts
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
import { runSense, senseCoverage } from "../compass/CompassSenseEngine.js";
import { runLiveCheck } from "../compass/CompassLiveEngine.js";
import { _setTestClient as _setSchedulerClient, runSenseSweep } from "../lib/compassSenseScheduler.js";

const USER_ID = "00000000-0000-0000-0000-00000000f0c1";

/* ── Fake Supabase client with per-query failure ─────────────────────────────
 * `fail(ctx)` decides per query: `ctx.filters` names the columns the query
 * filtered on, so "the day's count" (no dedupe_key filter) can fail while "is
 * this exact nudge a duplicate" (dedupe_key filter) reads. A failed read
 * resolves `{ data: null, error }` like supabase-js; `reject` rejects.
 */
type Row = Record<string, unknown>;
type DbError = { message: string; code: string };
type Outcome = { data: unknown; error: DbError | null };
interface QueryCtx { table: string; filters: string[]; write: boolean }
interface FakeOpts {
  fail?: (ctx: QueryCtx) => boolean;
  reject?: (ctx: QueryCtx) => boolean;
}

const OUTAGE: DbError = { message: "simulated outage", code: "XX000" };
let idCounter = 0;

class FakeQuery implements PromiseLike<Outcome> {
  private readonly filters: Array<(r: Row) => boolean> = [];
  private readonly filterKeys: string[] = [];
  private cap: number | null = null;
  private pendingWrite: (() => Row[]) | null = null;
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
  private ctx(): QueryCtx {
    return { table: this.table, filters: [...this.filterKeys], write: this.pendingWrite !== null || this.pendingUpdate !== null };
  }
  private outcome(): Outcome {
    if (this.opts.fail?.(this.ctx())) return { data: null, error: OUTAGE };
    if (this.pendingWrite) {
      const written = this.pendingWrite();
      this.pendingWrite = null;
      return { data: written, error: null };
    }
    if (this.pendingUpdate) {
      for (const r of this.rows()) if (this.filters.every((f) => f(r))) Object.assign(r, this.pendingUpdate);
      this.pendingUpdate = null;
    }
    let out = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.cap !== null) out = out.slice(0, this.cap);
    return { data: out, error: null };
  }
  private settle(): Promise<Outcome> {
    if (this.opts.reject?.(this.ctx())) return Promise.reject(new Error(`socket hang up (${this.table})`));
    return Promise.resolve(this.outcome());
  }

  select(): this { return this; }
  order(): this { return this; }
  like(): this { return this; }
  or(): this { return this; }
  not(): this { return this; }
  is(): this { return this; }
  limit(n: number): this { this.cap = n; return this; }
  private filter(k: string, f: (r: Row) => boolean): this { this.filterKeys.push(k); this.filters.push(f); return this; }
  eq(k: string, v: unknown): this { return this.filter(k, (r) => r[k] === v); }
  neq(k: string, v: unknown): this { return this.filter(k, (r) => r[k] !== v); }
  in(k: string, vs: readonly unknown[]): this { return this.filter(k, (r) => vs.includes(r[k])); }
  gte(k: string, v: unknown): this { return this.filter(k, (r) => String(r[k] ?? "") >= String(v)); }
  lte(k: string, v: unknown): this { return this.filter(k, (r) => String(r[k] ?? "") <= String(v)); }
  gt(k: string, v: unknown): this { return this.filter(k, (r) => String(r[k] ?? "") > String(v)); }
  lt(k: string, v: unknown): this { return this.filter(k, (r) => String(r[k] ?? "") < String(v)); }
  insert(payload: Row | Row[]): this {
    this.pendingWrite = () => {
      const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({
        id: `gen-${++idCounter}`, created_at: new Date().toISOString(), ...r,
      }));
      this.rows().push(...arr);
      return arr;
    };
    return this;
  }
  upsert(payload: Row | Row[], o?: { onConflict?: string }): this {
    this.pendingWrite = () => {
      const key = o?.onConflict ?? "id";
      const arr = Array.isArray(payload) ? payload : [payload];
      for (const r of arr) {
        const existing = this.rows().find((e) => e[key] === r[key]);
        if (existing) Object.assign(existing, r);
        else this.rows().push({ ...r });
      }
      return arr;
    };
    return this;
  }
  update(payload: Row): this { this.pendingUpdate = { ...payload }; return this; }
  delete(): this { return this; }
  maybeSingle(): Promise<Outcome> {
    return this.settle().then((o) => ({ data: Array.isArray(o.data) ? (o.data[0] ?? null) : o.data, error: o.error }));
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

/* ── Failure predicates ───────────────────────────────────────────────────── */

const settingsRead = (c: QueryCtx) => c.table === "compass_sense_settings" && !c.write;
const settingsWrite = (c: QueryCtx) => c.table === "compass_sense_settings" && c.write;
/** The day's count: a read of the nudge log that does NOT ask about one dedupe key. */
const dayCountRead = (c: QueryCtx) =>
  c.table === "compass_sense_nudges" && !c.write && !c.filters.includes("dedupe_key");

/* ── Seeds ───────────────────────────────────────────────────────────────── */

const STORED_CATEGORIES = { timing: true, events: false, weather: true, circle: false, free_time: true };

function baseStore(level = "active", categories: Record<string, boolean> = {}): Record<string, Row[]> {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    compass_sense_settings: [{ user_id: USER_ID, presence_level: level, categories }],
  };
}

function seedSavedEvent(s: Record<string, Row[]>, nowMs: number): void {
  s.event_saves = [{ event_id: "evt-1", user_id: USER_ID }];
  s.events = [{ id: "evt-1", title: "Night market", starts_at: new Date(nowMs + 60 * 60_000).toISOString(), state: "published" }];
}

/** `n` nudges already delivered today (distinct dedupe keys, so dedupe never fires). */
function seedDeliveredToday(s: Record<string, Row[]>, n: number, nowMs: number): void {
  const at = new Date(nowMs - 60_000).toISOString();
  s.compass_sense_nudges = Array.from({ length: n }, (_, i) => ({
    id: `prior-${i}`, user_id: USER_ID, nudge_type: "leave_earlier", category: "timing",
    dedupe_key: `prior:${i}`, title: "t", body: "b", action_url: null, confidence: null, created_at: at,
  }));
}

const TODAY = new Date().toISOString().slice(0, 10);
const NOON_MS = new Date(`${TODAY}T12:00:00.000Z`).getTime();

/* ── Mini express app ────────────────────────────────────────────────────── */

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

async function api(method: string, path: string, body: unknown = {}): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const resp = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

/* ── A. Settings: an unread row is never `passive`, never overwritten ─────── */

describe("A. GET/PUT /compass/sense/settings over an unread settings row", () => {
  it("healthy GET: the shipped body, byte for byte (stored categories merged over defaults)", async () => {
    _setTestClient(makeFakeClient(baseStore("aware", { events: false })), true);
    const r = await api("GET", "/compass/sense/settings");
    assert.equal(r.status, 200);
    assert.equal(r.text, '{"compassEnabled":true,"settings":{"presenceLevel":"aware","categories":{"timing":true,"events":false,"weather":true,"circle":true,"free_time":true}}}');
  });

  it("healthy GET with no row yet: the passive defaults (a real 'never set'), byte for byte", async () => {
    _setTestClient(makeFakeClient({ feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }] }), true);
    const r = await api("GET", "/compass/sense/settings");
    assert.equal(r.text, '{"compassEnabled":true,"settings":{"presenceLevel":"passive","categories":{"timing":true,"events":true,"weather":true,"circle":true,"free_time":true}}}');
  });

  it("GET over a read error → 503 degraded_unavailable, never presenceLevel 'passive'", async () => {
    _setTestClient(makeFakeClient(baseStore("active", STORED_CATEGORIES), { fail: settingsRead }), true);
    const r = await api("GET", "/compass/sense/settings");
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "degraded_unavailable");
    assert.equal(r.json.retryable, true);
    assert.equal("settings" in r.json, false, "an unread row must not be reported as any settings at all");
  });

  it("GET over a REJECTED read (network) → 503 degraded_unavailable", async () => {
    _setTestClient(makeFakeClient(baseStore("active"), { reject: settingsRead }), true);
    const r = await api("GET", "/compass/sense/settings");
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "degraded_unavailable");
  });

  it("healthy PUT: merges into the stored row and answers the shipped body, byte for byte", async () => {
    const s = baseStore("aware", STORED_CATEGORIES);
    _setTestClient(makeFakeClient(s), true);
    const r = await api("PUT", "/compass/sense/settings", { presenceLevel: "active" });
    assert.equal(r.status, 200);
    assert.equal(r.text, `{"compassEnabled":true,"settings":{"presenceLevel":"active","categories":${JSON.stringify(STORED_CATEGORIES)}}}`);
    assert.deepEqual(s.compass_sense_settings![0]!.categories, STORED_CATEGORIES);
  });

  it("PUT that needs the current row, over a read error → 503, and the stored categories are NOT overwritten", async () => {
    const s = baseStore("aware", STORED_CATEGORIES);
    _setTestClient(makeFakeClient(s, { fail: settingsRead }), true);
    const r = await api("PUT", "/compass/sense/settings", { presenceLevel: "active" });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "degraded_unavailable");
    assert.equal("settings" in r.json, false);
    assert.deepEqual(s.compass_sense_settings, [{ user_id: USER_ID, presence_level: "aware", categories: STORED_CATEGORIES }],
      "nothing may be written over a row that could not be read");
  });

  it("PUT of one category, over a read error → 503 (the other categories and the level are needed); nothing written", async () => {
    const s = baseStore("aware", STORED_CATEGORIES);
    _setTestClient(makeFakeClient(s, { reject: settingsRead }), true);
    const r = await api("PUT", "/compass/sense/settings", { categories: { weather: false } });
    assert.equal(r.status, 503);
    assert.deepEqual(s.compass_sense_settings, [{ user_id: USER_ID, presence_level: "aware", categories: STORED_CATEGORIES }]);
  });

  it("PUT of every category but no level, over a read error → 503 (the level is needed)", async () => {
    const s = baseStore("aware", STORED_CATEGORIES);
    _setTestClient(makeFakeClient(s, { fail: settingsRead }), true);
    const r = await api("PUT", "/compass/sense/settings", { categories: { timing: true, events: true, weather: true, circle: true, free_time: true } });
    assert.equal(r.status, 503);
    assert.deepEqual(s.compass_sense_settings![0]!.categories, STORED_CATEGORIES);
  });

  it("PUT that sends every field needs no read: it writes exactly what was sent, and answers the healthy body", async () => {
    const s = baseStore("aware", STORED_CATEGORIES);
    _setTestClient(makeFakeClient(s, { fail: settingsRead }), true);
    const sent = { timing: false, events: true, weather: false, circle: true, free_time: false };
    const r = await api("PUT", "/compass/sense/settings", { presenceLevel: "active", categories: sent });
    assert.equal(r.status, 200);
    assert.equal(r.text, `{"compassEnabled":true,"settings":{"presenceLevel":"active","categories":${JSON.stringify(sent)}}}`);
    assert.equal(s.compass_sense_settings![0]!.presence_level, "active");
    assert.deepEqual(s.compass_sense_settings![0]!.categories, sent);
  });

  it("PUT whose write fails → 503, never 200 with settings that were not saved", async () => {
    const s = baseStore("aware", STORED_CATEGORIES);
    _setTestClient(makeFakeClient(s, { fail: settingsWrite }), true);
    const r = await api("PUT", "/compass/sense/settings", { presenceLevel: "active" });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "degraded_unavailable");
    assert.equal("settings" in r.json, false);
  });
});

/* ── B. The daily cap fails CLOSED over an unread count ──────────────────── */

describe("B. countDeliveredToday: an unread day's count delivers nothing and says so", () => {
  const daytime = { nowMs: NOON_MS, hourUtc: 12, nowMinutes: 720 };

  it("healthy twin: at the cap (active = 6) a new signal is held back as daily_cap", async () => {
    const s = baseStore("active"); seedSavedEvent(s, NOON_MS); seedDeliveredToday(s, 6, NOON_MS);
    const sc = makeFakeClient(s); _setTestClient(sc, true);
    const r = await runSense(sc, USER_ID, daytime);
    assert.deepEqual(r.failedSources, []);
    assert.deepEqual(r.delivered, []);
    assert.deepEqual(r.suppressed.map((x) => x.reason), ["daily_cap"]);
  });

  it("healthy twin: under the cap the signal is delivered", async () => {
    const s = baseStore("active"); seedSavedEvent(s, NOON_MS); seedDeliveredToday(s, 2, NOON_MS);
    const sc = makeFakeClient(s); _setTestClient(sc, true);
    const r = await runSense(sc, USER_ID, daytime);
    assert.deepEqual(r.failedSources, []);
    assert.deepEqual(r.delivered.map((d) => d.type), ["saved_event_starting"]);
  });

  it("at the cap with the count unread → nothing delivered (daily_cap_unread), failedSources ['nudge_log']", async () => {
    const s = baseStore("active"); seedSavedEvent(s, NOON_MS); seedDeliveredToday(s, 6, NOON_MS);
    const sc = makeFakeClient(s, { fail: dayCountRead }); _setTestClient(sc, true);
    const r = await runSense(sc, USER_ID, daytime);
    assert.deepEqual(r.delivered, [], "an unknown count must not read as 0 delivered today");
    assert.deepEqual(r.suppressed.map((x) => x.reason), ["daily_cap_unread"]);
    assert.deepEqual(r.failedSources, ["nudge_log"]);
    assert.equal((s.notifications ?? []).length, 0);
    assert.equal(s.compass_sense_nudges!.length, 6, "no nudge row was written");
  });

  it("count read REJECTS → the same: nothing delivered, named", async () => {
    const s = baseStore("active"); seedSavedEvent(s, NOON_MS);
    const sc = makeFakeClient(s, { reject: dayCountRead }); _setTestClient(sc, true);
    const r = await runSense(sc, USER_ID, daytime);
    assert.deepEqual(r.delivered, []);
    assert.deepEqual(r.failedSources, ["nudge_log"]);
  });

  it("senseCoverage: the nudge log is not a signal — it makes a run partial, never 'none' by itself", () => {
    assert.equal(senseCoverage(["nudge_log"]), "partial");
    assert.equal(senseCoverage(["saved_event_starting", "leave_earlier", "weather_change", "circle_plan_change", "nudge_log"]), "partial");
    assert.equal(senseCoverage(["saved_event_starting", "leave_earlier", "weather_change", "circle_plan_change", "free_time_block"]), "none");
    assert.equal(senseCoverage([]), "complete");
  });

  it("POST /compass/sense/check with the count unread → 200 partial, failedSources ['nudge_log'], nothing delivered", async () => {
    const now = Date.now();
    const s = baseStore("active"); seedSavedEvent(s, now);
    _setTestClient(makeFakeClient(s, { fail: dayCountRead }), true);
    const r = await api("POST", "/compass/sense/check");
    assert.equal(r.status, 200);
    assert.equal(r.json.partial, true);
    assert.deepEqual(r.json.failedSources, ["nudge_log"]);
    assert.deepEqual(r.json.delivered, []);
    assert.deepEqual((r.json.suppressed as Array<{ reason: string }>).map((x) => x.reason), ["daily_cap_unread"]);
    assert.equal((s.notifications ?? []).length, 0);
  });

  it("POST /compass/sense/check healthy twin: the shipped keys, no coverage keys", async () => {
    const now = Date.now();
    const s = baseStore("active"); seedSavedEvent(s, now);
    _setTestClient(makeFakeClient(s), true);
    const r = await api("POST", "/compass/sense/check");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ["compassEnabled", "presenceLevel", "evaluated", "delivered", "suppressed"]);
    assert.equal((r.json.delivered as unknown[]).length, 1);
  });

  it("the sweep records an unread count as an error for that user", async () => {
    const s = baseStore("active"); seedSavedEvent(s, Date.now());
    _setSchedulerClient(makeFakeClient(s, { fail: dayCountRead }));
    const summary = await runSenseSweep({ hourUtc: 12, nowMinutes: 720 });
    assert.deepEqual(summary, { usersEvaluated: 1, nudgesDelivered: 0, errors: 1 });
  });
});

/* ── C. A live tick fails CLOSED over an unread settings row ─────────────── */

describe("C. runLiveCheck: an unread settings row is not 'every category on'", () => {
  beforeEach(() => {
    _setTestNowMs(NOON_MS);
    _setLiveTestHourUtc(12);
  });

  function liveStore(categories: Record<string, boolean>): Record<string, Row[]> {
    const s = baseStore("passive", categories); // live checks are not gated by presence
    seedSavedEvent(s, NOON_MS);
    s.compass_live_sessions = [{
      id: "live-1", user_id: USER_ID, status: "active", trip_id: null,
      started_at: new Date(NOON_MS - 10 * 60_000).toISOString(), checks_run: 0, nudges_delivered: 0, context: {},
    }];
    return s;
  }

  it("healthy twin: a category the traveller turned off is held back as category_disabled", async () => {
    const s = liveStore({ events: false });
    const sc = makeFakeClient(s); _setTestClient(sc, true);
    const r = await runLiveCheck(sc, USER_ID, { nowMs: NOON_MS, hourUtc: 12 });
    assert.equal(r.active, true);
    assert.deepEqual(r.failedSources, []);
    assert.equal(r.delivered.some((d) => d.category === "events"), false);
    assert.ok(r.suppressed.some((x) => x.type === "saved_event_starting" && x.reason === "category_disabled"));
  });

  it("healthy twin: with the category on, the live nudge is delivered", async () => {
    const s = liveStore({});
    const sc = makeFakeClient(s); _setTestClient(sc, true);
    const r = await runLiveCheck(sc, USER_ID, { nowMs: NOON_MS, hourUtc: 12 });
    assert.deepEqual(r.failedSources, []);
    assert.ok(r.delivered.some((d) => d.type === "saved_event_starting"));
  });

  it("settings unread → nothing delivered (permission_unread), failedSources names 'settings'", async () => {
    const s = liveStore({ events: false });
    const sc = makeFakeClient(s, { fail: settingsRead }); _setTestClient(sc, true);
    const r = await runLiveCheck(sc, USER_ID, { nowMs: NOON_MS, hourUtc: 12 });
    assert.equal(r.active, true);
    assert.deepEqual(r.delivered, [], "a category turned off must not be delivered because its setting could not be read");
    assert.ok(r.suppressed.length > 0 && r.suppressed.every((x) => x.reason === "permission_unread"), JSON.stringify(r.suppressed));
    assert.deepEqual(r.failedSources, ["settings"]);
    assert.equal((s.notifications ?? []).length, 0);
    assert.equal((s.compass_sense_nudges ?? []).length, 0);
  });

  it("POST /compass/live/check with settings unread → 200 partial, failedSources ['settings'], nothing delivered", async () => {
    const s = liveStore({ events: false });
    _setTestClient(makeFakeClient(s, { reject: settingsRead }), true);
    const r = await api("POST", "/compass/live/check");
    assert.equal(r.status, 200);
    assert.equal(r.json.partial, true);
    assert.deepEqual(r.json.failedSources, ["settings"]);
    assert.deepEqual(r.json.delivered, []);
  });

  it("POST /compass/live/check healthy twin: the shipped keys, no coverage keys", async () => {
    const s = liveStore({});
    _setTestClient(makeFakeClient(s), true);
    const r = await api("POST", "/compass/live/check");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ["compassEnabled", "active", "session", "evaluated", "delivered", "suppressed"]);
  });
});
