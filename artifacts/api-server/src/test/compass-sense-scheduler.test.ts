/**
 * Compass Sense Scheduler (background evaluator) tests.
 *
 * Covers:
 *   - Passive users are never evaluated by the sweep (query excludes them,
 *     and no nudges/notifications are ever written for them)
 *   - Opted-in (aware/active) users receive nudges through the existing
 *     notification pathway without any client call
 *   - COMPASS_ENABLED off → the sweep is a no-op
 *   - Storm across TWO job ticks stays bounded by the daily cap (dedupe +
 *     caps are durable via compass_sense_nudges, so they hold across runs)
 *   - Per-user runSense failure doesn't abort the sweep for other users
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-sense-scheduler.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _setTestClient, runSenseSweep } from "../lib/compassSenseScheduler.js";
import { ACTIVE_DAILY_CAP } from "../compass/CompassSenseEngine.js";

const ACTIVE_USER = "00000000-0000-0000-0000-0000000000a1";
const PASSIVE_USER = "00000000-0000-0000-0000-0000000000b1";
const AWARE_USER = "00000000-0000-0000-0000-0000000000c1";

/* ── Permissive fake Supabase client (mirrors compass-sense.test.ts) ───────── */
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
    fakeClient: { from: (name: string) => builder(name) } as any,
    store,
  };
}

/* ── Seed helpers ─────────────────────────────────────────────────────────── */

function enabledFlag(): Row {
  return { flag: "COMPASS_ENABLED", enabled: true };
}

function senseSettings(userId: string, level: string, categories: Record<string, boolean> = {}): Row {
  return { user_id: userId, presence_level: level, categories };
}

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3600_000).toISOString();
}

/** Seed n saved events starting within the 2h window for a user. */
function savedEventSignal(store: Record<string, Row[]>, userId: string, n: number, prefix = "evt"): void {
  store.event_saves ??= [];
  store.events ??= [];
  for (let i = 0; i < n; i++) {
    const id = `${prefix}-${userId.slice(-2)}-${i}`;
    store.event_saves.push({ event_id: id, user_id: userId });
    store.events.push({ id, title: `Event ${id}`, starts_at: hoursFromNow(1), state: "published" });
  }
}

const daytime = { hourUtc: 12, nowMinutes: 720 };

beforeEach(() => {
  invalidateFlagsCache();
});

after(() => {
  _setTestClient(null);
});

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe("Compass Sense background scheduler", () => {
  it("evaluates only opted-in users — passive users are never evaluated", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [
        senseSettings(ACTIVE_USER, "active"),
        senseSettings(PASSIVE_USER, "passive"),
      ],
    };
    // Both users have genuine signals — only the active user may deliver.
    savedEventSignal(store, ACTIVE_USER, 1);
    savedEventSignal(store, PASSIVE_USER, 1);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient);

    const summary = await runSenseSweep(daytime);
    assert.equal(summary.usersEvaluated, 1);
    assert.equal(summary.nudgesDelivered, 1);

    const nudges = store.compass_sense_nudges ?? [];
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0]!.user_id, ACTIVE_USER);
    // Nothing was ever written for the passive user.
    const notifs = store.notifications ?? [];
    assert.equal(notifs.length, 1);
    assert.equal(notifs[0]!.user_id, ACTIVE_USER);
    assert.equal(notifs[0]!.event_type, "compass.sense.saved_event_starting");
  });

  it("users without any settings row (passive by default) are not evaluated", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [],
    };
    savedEventSignal(store, PASSIVE_USER, 2);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient);

    const summary = await runSenseSweep(daytime);
    assert.equal(summary.usersEvaluated, 0);
    assert.equal(summary.nudgesDelivered, 0);
    assert.equal((store.compass_sense_nudges ?? []).length, 0);
    assert.equal((store.notifications ?? []).length, 0);
  });

  it("COMPASS_ENABLED off → sweep is a no-op even for opted-in users with signals", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [],
      compass_sense_settings: [senseSettings(ACTIVE_USER, "active")],
    };
    savedEventSignal(store, ACTIVE_USER, 1);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient);

    const summary = await runSenseSweep(daytime);
    assert.equal(summary.usersEvaluated, 0);
    assert.equal((store.notifications ?? []).length, 0);
  });

  it("aware users deliver through the sweep too (time-critical categories)", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings(AWARE_USER, "aware")],
    };
    savedEventSignal(store, AWARE_USER, 1);
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient);

    const summary = await runSenseSweep(daytime);
    assert.equal(summary.usersEvaluated, 1);
    assert.equal(summary.nudgesDelivered, 1);
  });

  it("a signal storm across TWO job ticks stays bounded by the daily cap", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [senseSettings(ACTIVE_USER, "active")],
    };
    // Tick 1: enough signals to hit the cap outright.
    savedEventSignal(store, ACTIVE_USER, ACTIVE_DAILY_CAP + 2, "wave1");
    const { fakeClient } = makeFakeClient(store);
    _setTestClient(fakeClient);

    const tick1 = await runSenseSweep(daytime);
    assert.equal(tick1.nudgesDelivered, ACTIVE_DAILY_CAP);
    assert.equal((store.compass_sense_nudges ?? []).length, ACTIVE_DAILY_CAP);

    // Tick 2 (same day): fresh, previously-unseen signals arrive — the durable
    // cap in compass_sense_nudges must still bound total delivery at the cap.
    savedEventSignal(store, ACTIVE_USER, 5, "wave2");
    const tick2 = await runSenseSweep(daytime);
    assert.equal(tick2.nudgesDelivered, 0);
    assert.equal((store.compass_sense_nudges ?? []).length, ACTIVE_DAILY_CAP);
    assert.equal((store.notifications ?? []).length, ACTIVE_DAILY_CAP);
  });

  it("one user's failure doesn't abort the sweep for other users", async () => {
    const store: Record<string, Row[]> = {
      feature_flags: [enabledFlag()],
      compass_sense_settings: [
        senseSettings("boom-user", "active"),
        senseSettings(ACTIVE_USER, "active"),
      ],
    };
    savedEventSignal(store, ACTIVE_USER, 1);
    const { fakeClient } = makeFakeClient(store);
    // Wrap: any table access for the boom user's settings lookup throws.
    const wrapped: any = {
      from: (name: string) => {
        const b = fakeClient.from(name);
        if (name === "compass_sense_settings") {
          const origEq = b.eq?.bind(b);
          return new Proxy(b, {
            get(t, prop: string) {
              if (prop === "eq") {
                return (k: string, v: unknown) => {
                  if (k === "user_id" && v === "boom-user") throw new Error("boom");
                  return origEq ? origEq(k, v) : t[prop](k, v);
                };
              }
              return (t as any)[prop];
            },
          });
        }
        return b;
      },
    };
    _setTestClient(wrapped);

    const summary = await runSenseSweep(daytime);
    // boom-user's getSenseSettings throw is swallowed inside the engine or the
    // sweep; the other user still delivers either way.
    assert.equal(summary.nudgesDelivered, 1);
    assert.equal(
      (store.compass_sense_nudges ?? []).filter((n) => n.user_id === ACTIVE_USER).length,
      1,
    );
  });
});
