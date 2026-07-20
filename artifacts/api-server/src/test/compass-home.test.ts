/**
 * Compass Home (Phase 10) route tests.
 *
 * Covers:
 *   - COMPASS_ENABLED off → honest fallback envelope, no sections
 *   - Enabled + no data → every section hides honestly (null), no template cards
 *   - Time-awareness: morning vs night payloads differ (tonightVibe gated)
 *   - startingSoon backed by real seeded events only, 6-hour window enforced
 *   - tonightVibe events are real seeded events (no fabricated entries)
 *   - auth required
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-home.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import compassHomeRouter, { _setTestHourUtc, timeOfDayForHour } from "../routes/compassHome.js";

const USER_ID = "00000000-0000-0000-0000-000000000001";

/* ── Permissive fake Supabase client ──────────────────────────────────────────
 * Generic chainable builder: eq/neq/gte/lte filters are applied; every other
 * builder method is a pass-through. Unknown tables resolve to empty arrays so
 * the wide profile/hydrator query surface degrades to "no data" honestly.
 */
type Row = Record<string, unknown>;

function makeFakeClient(store: Record<string, Row[]> = {}) {
  function tbl(name: string): Row[] {
    if (!store[name]) store[name] = [];
    return store[name]!;
  }

  function builder(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _limit: number | null = null;

    function rows(): Row[] {
      let out = tbl(tableName).filter((r) => filters.every((f) => f(r)));
      if (_limit !== null) out = out.slice(0, _limit);
      return out;
    }

    const passthrough = new Set([
      "select", "order", "or", "like", "ilike", "in", "not", "is",
      "contains", "overlaps", "range", "textSearch", "filter", "match",
    ]);

    const b: any = new Proxy({}, {
      get(_target, prop: string) {
        if (prop === "then") {
          return (resolve: Function) => resolve({ data: rows(), error: null });
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
        if (prop === "limit") {
          return (n: number) => { _limit = n; return b; };
        }
        if (prop === "eq")  return (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; };
        if (prop === "neq") return (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; };
        if (prop === "gte") return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") >= String(v)); return b; };
        if (prop === "lte") return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") <= String(v)); return b; };
        if (prop === "insert" || prop === "upsert" || prop === "update" || prop === "delete") {
          return (..._args: unknown[]) => b;
        }
        if (passthrough.has(prop)) return (..._args: unknown[]) => b;
        return (..._args: unknown[]) => b;
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
testApp.use("/api", compassHomeRouter);

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
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  invalidateFlagsCache();
  clearCompassProfileCache();
  _setTestHourUtc(null);
});

async function getHome(token = "valid-token") {
  const resp = await fetch(`${base}/api/compass/home`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: resp.status, json: await resp.json() };
}

function enabledFlag(): Row {
  return { flag: "COMPASS_ENABLED", enabled: true };
}

function eventRow(id: string, title: string, startsAt: string, hostId = "host-1"): Row {
  return {
    id, title, description: null, city: "Cebu", country: "PH",
    starts_at: startsAt, category: "music", host_id: hostId,
    state: "published", visibility: "public",
  };
}

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3600_000).toISOString();
}

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe("GET /api/compass/home", () => {
  it("requires auth", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    const r = await getHome("bad-token");
    assert.equal(r.status, 401);
  });

  it("returns honest fallback when COMPASS_ENABLED is off", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [] });
    _setTestClient(fakeClient, true);
    const r = await getHome();
    assert.equal(r.status, 200);
    assert.equal((r.json as any).compassEnabled, false);
    assert.equal((r.json as any).fallback, true);
    assert.equal((r.json as any).bestNextMove, undefined);
    assert.equal((r.json as any).startingSoon, undefined);
  });

  it("hides every section honestly when there is no real data", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    const r = await getHome();
    assert.equal(r.status, 200);
    const j = r.json as any;
    assert.equal(j.compassEnabled, true);
    assert.equal(j.fallback, false);
    assert.equal(j.bestNextMove, null);
    assert.equal(j.circleActivity, null);
    assert.equal(j.startingSoon, null);
    assert.equal(j.tonightVibe, null);
    assert.equal(j.weatherWindow, null);
    assert.ok(["morning", "afternoon", "evening", "night"].includes(j.timeOfDay));
  });

  it("morning vs night payloads differ (time-awareness)", async () => {
    const { fakeClient } = makeFakeClient({
      feature_flags: [enabledFlag()],
      events: [eventRow("ev-tonight", "Rooftop DJ set", hoursFromNow(8))],
    });
    _setTestClient(fakeClient, true);

    _setTestHourUtc(8); // morning
    const morning = (await getHome()).json as any;
    assert.equal(morning.timeOfDay, "morning");
    assert.equal(morning.tonightVibe, null, "tonightVibe must not appear in the morning");

    invalidateFlagsCache();
    clearCompassProfileCache();
    _setTestHourUtc(23); // night
    const night = (await getHome()).json as any;
    assert.equal(night.timeOfDay, "night");
    assert.ok(night.tonightVibe, "tonightVibe should appear at night when real events exist");
    assert.equal(night.tonightVibe.events[0].id, "ev-tonight");
    assert.match(night.tonightVibe.headline, /1 event on tonight/);

    assert.notDeepEqual(morning, night, "morning and night payloads must differ");
  });

  it("startingSoon contains only real events inside the 6-hour window", async () => {
    const { fakeClient } = makeFakeClient({
      feature_flags: [enabledFlag()],
      events: [
        eventRow("ev-soon", "Sunset run club", hoursFromNow(2)),
        eventRow("ev-late", "Next-week meetup", hoursFromNow(10)),
        { ...eventRow("ev-cancelled", "Cancelled thing", hoursFromNow(1)), state: "cancelled" },
        { ...eventRow("ev-private", "Private party", hoursFromNow(1)), visibility: "circle_only" },
      ],
    });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(8);
    const j = (await getHome()).json as any;
    assert.ok(Array.isArray(j.startingSoon));
    assert.deepEqual(j.startingSoon.map((e: any) => e.id), ["ev-soon"]);
    assert.equal(j.startingSoon[0].title, "Sunset run club");
    assert.equal(j.startingSoon[0].startsAt !== null, true);
  });

  it("tonightVibe is null at night when no real events exist (no template cards)", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(23);
    const j = (await getHome()).json as any;
    assert.equal(j.timeOfDay, "night");
    assert.equal(j.tonightVibe, null);
  });

  it("bestNextMove, when present, is backed by seeded data only", async () => {
    const { fakeClient } = makeFakeClient({
      feature_flags: [enabledFlag()],
      events: [eventRow("ev-soon", "Sunset run club", hoursFromNow(2))],
    });
    _setTestClient(fakeClient, true);
    const j = (await getHome()).json as any;
    if (j.bestNextMove) {
      assert.ok(
        ["ev-soon"].includes(j.bestNextMove.id),
        `bestNextMove id '${j.bestNextMove.id}' must come from seeded data`,
      );
    }
  });
});

describe("timeOfDayForHour", () => {
  it("maps hours to buckets", () => {
    assert.equal(timeOfDayForHour(6), "morning");
    assert.equal(timeOfDayForHour(12), "afternoon");
    assert.equal(timeOfDayForHour(19), "evening");
    assert.equal(timeOfDayForHour(23), "night");
    assert.equal(timeOfDayForHour(2), "night");
  });
});
