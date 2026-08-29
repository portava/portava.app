/**
 * Traveler-local time resolution across Compass surfaces (Task: time-of-day
 * surfaces beyond Compass Home must follow the traveler's clock).
 *
 * Covers:
 *   - lib/localTime.ts: localHourFor priority (offset → timezone → UTC)
 *   - A UTC+8 traveler at 13:00 UTC lands in the "evening" bucket (local 21)
 *   - defaultSignals honours an explicit local-hour override
 *   - GET /compass/feed builds an evening/night context for a far-from-UTC
 *     traveler even when the server clock reads early afternoon UTC
 *   - GET /compass/me/context flips to night_mode via tzOffsetMinutes and via
 *     the stored notification_preferences timezone
 *
 * Runtime: node:test (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-local-time.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import compassRouter, { _getLastFeedContext } from "../routes/compass.js";
import { timeOfDayForHour } from "../routes/compassHome.js";
import { localHourFor, _setTestNowUtc, resolveLocalHour, clearUserTimezoneCache } from "../lib/localTime.js";
import { defaultSignals } from "../compass/CompassContextEngine.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearL1Cache } from "../compass/CompassCacheEngine.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import type { CompassProfile } from "../compass/types.js";

const ALICE_ID = "00000000-0000-0000-0000-0000000000a1";

/** Fixed instant: 13:00 UTC. */
const NOON13_UTC = new Date(Date.UTC(2026, 6, 21, 13, 0, 0));

function baseProfile(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId:               ALICE_ID,
    preferredCities:      [],
    preferredLanguages:   [],
    budgetStyle:          null,
    travelStyles:         [],
    socialStyle:          null,
    safetyPreference:     "standard",
    visibilityPreference: "public",
    blockedUserIds:       [],
    blockerUserIds:       [],
    mutedUserIds:         [],
    blockCount:           0,
    blockerCount:         0,
    trustScore:           null,
    trustLevel:           null,
    activeUserScore:      null,
    hasActiveTrip:        false,
    hasActiveBooking:     false,
    upcomingTripWithin48h:    false,
    hasFutureTripScheduled:   false,
    currentCity:          null,
    currentCountry:       null,
    safeReturnActive:     false,
    computedAt:           new Date().toISOString(),
  ...overrides,
  } as CompassProfile;
}

/* ── Permissive fake Supabase client ─────────────────────────────────────── */
type Row = Record<string, unknown>;

function makeFakeClient(store: Record<string, Row[]>) {
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: Function) => resolve({ data: rows(), error: null });
        if (prop === "maybeSingle" || prop === "single") {
          return () => Promise.resolve({ data: rows()[0] ?? null, error: null });
        }
        if (prop === "eq") return (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; };
        if (prop === "neq") return (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; };
        return (..._args: unknown[]) => b;
      },
    });
    return b;
  }
  return {
    from: (table: string) => builder(table),
    auth: {
      getUser: async (token: string) =>
        token === "alice-tok"
          ? { data: { user: { id: ALICE_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

function makeStore(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    feature_flags: [
      { flag: "COMPASS_ENABLED", enabled: true },
      { flag: "COMPASS_FEED_ENABLED", enabled: true },
    ],
    profiles: [{ id: ALICE_ID, spoken_languages: ["en"] }],
    notification_preferences: [],
    ...overrides,
  };
}

let server: Server | null = null;

async function startApp(store: Record<string, Row[]>): Promise<number> {
  const client = makeFakeClient(store);
  _setTestClient(client as any, true);
  invalidateFlagsCache();
  clearCompassProfileCache();
  clearL1Cache();
  clearUserTimezoneCache();
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { info: () => {}, error: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", compassRouter);
  return new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as any).port));
  });
}

async function get(port: number, path: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    headers: { Authorization: "Bearer alice-tok" },
  });
  return res.json();
}

function closeServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => { server = null; resolve(); });
  });
}

/* ── Unit: local-hour resolution ─────────────────────────────────────────── */

describe("localHourFor (shared lib)", () => {
  it("UTC+8 traveler at 13:00 UTC resolves to local 21 — the evening bucket", () => {
    const h = localHourFor(NOON13_UTC, 480, null);
    assert.equal(h, 21);
    assert.equal(timeOfDayForHour(h), "evening");
  });

  it("client offset wins over stored timezone", () => {
    assert.equal(localHourFor(NOON13_UTC, 480, "America/New_York"), 21);
  });

  it("stored IANA timezone used when no offset (Asia/Singapore = UTC+8)", () => {
    const h = localHourFor(NOON13_UTC, null, "Asia/Singapore");
    assert.equal(h, 21);
  });

  it("falls back to UTC when neither offset nor timezone is known", () => {
    assert.equal(localHourFor(NOON13_UTC, null, null), 13);
  });

  it("invalid timezone name falls through to UTC", () => {
    assert.equal(localHourFor(NOON13_UTC, null, "Not/AZone"), 13);
  });

  it("negative offsets wrap across midnight (UTC-14 max)", () => {
    assert.equal(localHourFor(NOON13_UTC, -840, null), 23);
  });
});

describe("defaultSignals local-hour override", () => {
  it("uses the provided local hour instead of the server's UTC hour", () => {
    const signals = defaultSignals(baseProfile(), 21);
    assert.equal(signals.hourUtc, 21);
  });
});

describe("resolveLocalHour", () => {
  it("reads notification_preferences.timezone when no offset is supplied", async () => {
    clearUserTimezoneCache();
    const sc = makeFakeClient(makeStore({
      notification_preferences: [{ user_id: ALICE_ID, timezone: "Asia/Singapore" }],
    }));
    const h = await resolveLocalHour(sc, ALICE_ID, null, NOON13_UTC);
    assert.equal(h, 21);
  });
});

/* ── Route: feed + context follow the traveler's clock ───────────────────── */

describe("Compass surfaces follow the traveler's clock", () => {
  beforeEach(async () => {
    await closeServer();
    _setTestNowUtc(NOON13_UTC);
  });

  after(async () => {
    _setTestNowUtc(null);
    _setTestClient(null as any, false);
    await closeServer();
  });

  it("feed: UTC+8 traveler at 13:00 UTC gets an evening-hour (21) context", async () => {
    const port = await startApp(makeStore());
    await get(port, "/compass/feed?tzOffsetMinutes=480");
    const ctx = _getLastFeedContext();
    assert.ok(ctx, "feed context was computed");
    assert.equal(ctx!.hourUtc, 21);
    assert.equal(timeOfDayForHour(ctx!.hourUtc), "evening");
  });

  it("feed: UTC+11 traveler at 13:00 UTC gets a night context (local 0)", async () => {
    const port = await startApp(makeStore());
    await get(port, "/compass/feed?tzOffsetMinutes=660");
    const ctx = _getLastFeedContext();
    assert.equal(ctx!.hourUtc, 0);
    assert.equal(ctx!.contextState, "night_mode");
  });

  it("me/context: stored timezone flips contextState to night_mode without a client offset", async () => {
    const port = await startApp(makeStore({
      notification_preferences: [{ user_id: ALICE_ID, timezone: "Pacific/Auckland" }], // UTC+12 in July
    }));
    const body = await get(port, "/compass/me/context");
    assert.equal(body.contextState, "night_mode"); // local 01:00
  });

  it("me/context: no offset and no timezone stays on UTC (13:00 → not night)", async () => {
    const port = await startApp(makeStore());
    const body = await get(port, "/compass/me/context");
    assert.notEqual(body.contextState, "night_mode");
  });
});
