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
import { _setTestNowUtc } from "../lib/localTime.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { clearUserTimezoneCache } from "../lib/localTime.js";
import compassHomeRouter, {
  _setTestHourUtc,
  _clearCompassHomeCache,
  _setTestHomeCacheTtlMs,
  invalidateCompassHomeCache,
  timeOfDayForHour,
  localHourFor,
} from "../routes/compassHome.js";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID_2 = "00000000-0000-0000-0000-000000000002";

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

    // `not` was in this pass-through set, so a negated filter was a NO-OP.
    // That is exactly the blindness the dead-literal class lived in: while
    // production said `.neq("state","banned")` (a label the enum does not
    // have, 22P02 in reality) this double happily excluded nothing and the
    // test passed. Now that production carries the real predicate
    // `.not("state","in",'("draft","cancelled","archived")')`, the double has
    // to be able to honour it or the cancelled fixture leaks into the rail.
    const passthrough = new Set([
      "select", "order", "or", "like", "ilike", "in", "is",
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
        if (prop === "not") return (k: string, op: string, v: any) => {
          const o = String(op).toLowerCase();
          if (o === "eq") filters.push((r) => r[k] !== v);
          else if (o === "neq") filters.push((r) => r[k] === v);
          else if (o === "is") filters.push((r) => (v === null ? r[k] != null : true));
          else if (o === "in") {
            const set = new Set(
              String(v).replace(/^\(/, "").replace(/\)$/, "").split(",")
                .map((s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")),
            );
            filters.push((r) => !set.has(String(r[k])));
          }
          return b;
        };
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
        getUser: (token: string) => {
          if (token === "valid-token")
            return Promise.resolve({ data: { user: { id: USER_ID } }, error: null });
          if (token === "valid-token-2")
            return Promise.resolve({ data: { user: { id: USER_ID_2 } }, error: null });
          return Promise.resolve({ data: { user: null }, error: { message: "bad token" } });
        },
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
  clearUserTimezoneCache();
  _clearCompassHomeCache();
  _setTestHomeCacheTtlMs(null);
  _setTestHourUtc(null);
  _setTestNowUtc(null);
});

async function getHome(token = "valid-token", query = "") {
  const resp = await fetch(`${base}/api/compass/home${query}`, {
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
    // FIXTURE REPAIRED: `state: "published"` is not a label of the
    // `event_state` enum (draft | open | full | waitlist | started | completed
    // | cancelled | archived) — the fixture invented it, and the double never
    // asked whether it was real. `open` is the state a live public event
    // actually carries (routes/events.ts:1794).
    state: "open", visibility: "public",
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
    _clearCompassHomeCache();
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

describe("compass home per-user cache", () => {
  it("serves the cached payload on repeat opens within the TTL (hit vs miss)", async () => {
    const { fakeClient, store } = makeFakeClient({
      feature_flags: [enabledFlag()],
      events: [eventRow("ev-first", "Sunset run club", hoursFromNow(2))],
    });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(8);

    const first = (await getHome()).json as any;
    assert.deepEqual(first.startingSoon.map((e: any) => e.id), ["ev-first"]);

    // Mutate the underlying data — a cache hit must NOT see it.
    store.events!.push(eventRow("ev-second", "New thing", hoursFromNow(1)));
    const second = (await getHome()).json as any;
    assert.deepEqual(
      second.startingSoon.map((e: any) => e.id),
      ["ev-first"],
      "repeat open within TTL must be served from cache",
    );
    assert.deepEqual(second, first, "cached payload must be identical");
  });

  it("rebuilds after the cache entry expires", async () => {
    _setTestHomeCacheTtlMs(10);
    const { fakeClient, store } = makeFakeClient({
      feature_flags: [enabledFlag()],
      events: [eventRow("ev-first", "Sunset run club", hoursFromNow(2))],
    });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(8);

    const first = (await getHome()).json as any;
    assert.deepEqual(first.startingSoon.map((e: any) => e.id), ["ev-first"]);

    store.events!.push(eventRow("ev-second", "New thing", hoursFromNow(1)));
    await new Promise((r) => setTimeout(r, 30));
    const second = (await getHome()).json as any;
    assert.deepEqual(
      second.startingSoon.map((e: any) => e.id).sort(),
      ["ev-first", "ev-second"],
      "expired entry must trigger a fresh build",
    );
  });

  it("never shares cached payloads across users", async () => {
    const { fakeClient } = makeFakeClient({
      feature_flags: [enabledFlag()],
      notification_preferences: [{ user_id: USER_ID, timezone: "Asia/Manila" }],
      events: [eventRow("ev-shared", "Rooftop session", hoursFromNow(3))],
    });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(13); // 21:00 Manila for user 1; UTC for user 2

    const u1 = (await getHome()).json as any;
    assert.equal(u1.timeOfDay, "evening");

    const u2 = (await getHome("valid-token-2")).json as any;
    assert.equal(
      u2.timeOfDay,
      "afternoon",
      "second user must get their own build, not user 1's cached payload",
    );
  });

  it("caches per tz-offset variant, not across differing offsets", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(13);

    const east = (await getHome("valid-token", "?tzOffsetMinutes=480")).json as any;
    assert.equal(east.timeOfDay, "evening");
    const utc = (await getHome("valid-token", "?tzOffsetMinutes=0")).json as any;
    assert.equal(utc.timeOfDay, "afternoon");
  });

  it("respects COMPASS_ENABLED turning off — cached payload is not served", async () => {
    const { fakeClient, store } = makeFakeClient({
      feature_flags: [enabledFlag()],
      events: [eventRow("ev-soon", "Sunset run club", hoursFromNow(2))],
    });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(8);

    const on = (await getHome()).json as any;
    assert.equal(on.compassEnabled, true);

    // Flip the flag off and expire the flags cache — the home cache must not
    // leak the enabled payload past the flag gate.
    store.feature_flags!.length = 0;
    invalidateFlagsCache();
    const off = (await getHome()).json as any;
    assert.equal(off.compassEnabled, false);
    assert.equal(off.fallback, true);
    assert.equal(off.bestNextMove, undefined);
  });

  it("reflects a block applied between two opens on the second open (invalidation)", async () => {
    const { fakeClient, store } = makeFakeClient({
      feature_flags: [enabledFlag()],
      events: [eventRow("ev-blocked-host", "Sunset run club", hoursFromNow(2), "host-blocked")],
    });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(8);

    const first = (await getHome()).json as any;
    assert.deepEqual(
      first.startingSoon.map((e: any) => e.id),
      ["ev-blocked-host"],
      "event must be visible before the block",
    );

    // The user blocks the host between two opens. Mirror what the block route
    // does: persist the block row, evict the Compass profile cache, and
    // invalidate the user's home-cache entry.
    store.blocks = [{ blocker_id: USER_ID, blocked_id: "host-blocked" }];
    clearCompassProfileCache();
    invalidateCompassHomeCache(USER_ID);

    const second = (await getHome()).json as any;
    assert.equal(
      second.startingSoon,
      null,
      "second open must rebuild and hide the blocked host's event — not serve the pre-block cache",
    );
  });

  it("invalidation only evicts the targeted user's entries", async () => {
    const { fakeClient, store } = makeFakeClient({
      feature_flags: [enabledFlag()],
      events: [eventRow("ev-first", "Sunset run club", hoursFromNow(2))],
    });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(8);

    const u2First = (await getHome("valid-token-2")).json as any;
    assert.deepEqual(u2First.startingSoon.map((e: any) => e.id), ["ev-first"]);

    store.events!.push(eventRow("ev-second", "New thing", hoursFromNow(1)));
    invalidateCompassHomeCache(USER_ID); // user 1, not user 2

    const u2Second = (await getHome("valid-token-2")).json as any;
    assert.deepEqual(
      u2Second.startingSoon.map((e: any) => e.id),
      ["ev-first"],
      "user 2's cached entry must survive user 1's invalidation",
    );
  });

  it("does not cache the disabled fallback envelope", async () => {
    const { fakeClient, store } = makeFakeClient({ feature_flags: [] });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(8);

    const off = (await getHome()).json as any;
    assert.equal(off.compassEnabled, false);

    store.feature_flags!.push(enabledFlag());
    invalidateFlagsCache();
    const on = (await getHome()).json as any;
    assert.equal(on.compassEnabled, true, "re-enabled flag must produce a real payload");
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

describe("localHourFor", () => {
  const noonUtc = new Date(Date.UTC(2026, 0, 15, 13, 0, 0)); // 13:00 UTC

  it("applies an explicit client offset (UTC+8 → 21:00)", () => {
    assert.equal(localHourFor(noonUtc, 480, null), 21);
  });

  it("applies a negative offset with day wrap (UTC-5 at 03:00 UTC → 22:00 prev day)", () => {
    const threeUtc = new Date(Date.UTC(2026, 0, 15, 3, 0, 0));
    assert.equal(localHourFor(threeUtc, -300, null), 22);
  });

  it("uses the IANA timezone when no offset is supplied", () => {
    assert.equal(localHourFor(noonUtc, null, "Asia/Manila"), 21);
    assert.equal(localHourFor(noonUtc, null, "Etc/UTC"), 13);
  });

  it("explicit offset wins over the stored timezone", () => {
    assert.equal(localHourFor(noonUtc, 0, "Asia/Manila"), 13);
  });

  it("falls back to UTC for invalid timezone or out-of-range offset", () => {
    assert.equal(localHourFor(noonUtc, null, "Not/AZone"), 13);
    assert.equal(localHourFor(noonUtc, 9999, null), 13);
    assert.equal(localHourFor(noonUtc, null, null), 13);
  });
});

describe("traveler-local time buckets", () => {
  it("same UTC instant: UTC+8 client offset is 'evening', UTC±0 is 'morning' — tonightVibe gates accordingly", async () => {
    const { fakeClient } = makeFakeClient({
      feature_flags: [enabledFlag()],
      events: [eventRow("ev-manila", "Night market crawl", hoursFromNow(3))],
    });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(13); // 13:00 UTC — 21:00 in Manila, 13:00 in London-ish UTC

    const manila = (await getHome("valid-token", "?tzOffsetMinutes=480")).json as any;
    assert.equal(manila.timeOfDay, "evening", "UTC+8 traveler at 13:00 UTC must be in the evening");
    assert.ok(manila.tonightVibe, "tonight's vibe must be assembled for the UTC+8 evening");
    assert.equal(manila.tonightVibe.events[0].id, "ev-manila");

    invalidateFlagsCache();
    clearCompassProfileCache();
    const utc = (await getHome("valid-token", "?tzOffsetMinutes=0")).json as any;
    assert.equal(utc.timeOfDay, "afternoon", "UTC±0 traveler at 13:00 UTC is in the afternoon");
    assert.equal(utc.tonightVibe, null, "tonightVibe must not appear outside evening/night");
  });

  it("same UTC instant: UTC+8 is 'evening' while UTC±0 is 'morning'", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(10); // 10:00 UTC — 18:00 UTC+8, 10:00 UTC±0

    const east = (await getHome("valid-token", "?tzOffsetMinutes=480")).json as any;
    assert.equal(east.timeOfDay, "evening");

    invalidateFlagsCache();
    clearCompassProfileCache();
    const west = (await getHome("valid-token", "?tzOffsetMinutes=0")).json as any;
    assert.equal(west.timeOfDay, "morning");
  });

  it("uses the stored IANA timezone from notification_preferences when no offset is supplied", async () => {
    const { fakeClient } = makeFakeClient({
      feature_flags: [enabledFlag()],
      notification_preferences: [{ user_id: USER_ID, timezone: "Asia/Manila" }],
      events: [eventRow("ev-tz", "Rooftop session", hoursFromNow(3))],
    });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(13); // 21:00 in Manila

    const j = (await getHome()).json as any;
    assert.equal(j.timeOfDay, "evening", "stored timezone must drive the bucket");
    assert.ok(j.tonightVibe, "tonightVibe should gate on the traveler's local evening");
  });

  it("falls back to UTC when neither offset nor timezone is known", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(13);
    const j = (await getHome()).json as any;
    assert.equal(j.timeOfDay, "afternoon");
  });

  it("auto traveler crossing a time-of-day bucket boundary misses the stale home cache entry", async () => {
    // No client offset — the bucket resolves from the stored IANA timezone.
    const { fakeClient } = makeFakeClient({
      feature_flags: [enabledFlag()],
      notification_preferences: [{ user_id: USER_ID, timezone: "Asia/Manila" }],
      events: [eventRow("ev-boundary", "Sunset rooftop", hoursFromNow(3))],
    });
    _setTestClient(fakeClient, true);
    _setTestHomeCacheTtlMs(60 * 60 * 1_000); // long TTL — only the key can save us

    // 08:59 UTC = 16:59 Manila → afternoon; payload gets cached.
    _setTestNowUtc(new Date(Date.UTC(2026, 6, 21, 8, 59, 0)));
    const first = (await getHome()).json as any;
    assert.equal(first.timeOfDay, "afternoon");

    // Two minutes later: 09:01 UTC = 17:01 Manila → evening. Within the TTL,
    // but the bucket changed — the stale afternoon entry must NOT be served.
    invalidateFlagsCache();
    clearCompassProfileCache();
    _setTestNowUtc(new Date(Date.UTC(2026, 6, 21, 9, 1, 0)));
    const second = (await getHome()).json as any;
    assert.equal(
      second.timeOfDay,
      "evening",
      "auto traveler crossing a bucket boundary must rebuild, not get the cached afternoon payload",
    );
    assert.ok(second.tonightVibe, "evening rebuild must assemble tonightVibe");
  });

  it("explicit-offset traveler crossing a bucket boundary misses the stale home cache entry", async () => {
    // UTC+8 traveler (tzOffsetMinutes=480):
    //   08:59 UTC → 16:59 local → afternoon; payload cached.
    //   09:01 UTC → 17:01 local → evening.  Within the TTL, but bucket changed.
    const { fakeClient } = makeFakeClient({
      feature_flags: [enabledFlag()],
      events: [eventRow("ev-boundary", "Rooftop session", hoursFromNow(3))],
    });
    _setTestClient(fakeClient, true);
    _setTestHomeCacheTtlMs(60 * 60 * 1_000); // long TTL — only the key can save us

    _setTestNowUtc(new Date(Date.UTC(2026, 6, 21, 8, 59, 0))); // 16:59 local → afternoon
    const first = (await getHome("valid-token", "?tzOffsetMinutes=480")).json as any;
    assert.equal(first.timeOfDay, "afternoon", "16:59 local must be afternoon for UTC+8 traveler");

    // Two minutes later: 09:01 UTC = 17:01 local → evening. The cache TTL has not
    // expired, but the bucket changed — the stale afternoon entry must NOT be served.
    invalidateFlagsCache();
    clearCompassProfileCache();
    _setTestNowUtc(new Date(Date.UTC(2026, 6, 21, 9, 1, 0))); // 17:01 local → evening
    const second = (await getHome("valid-token", "?tzOffsetMinutes=480")).json as any;
    assert.equal(
      second.timeOfDay,
      "evening",
      "explicit-offset traveler crossing a bucket boundary must rebuild, not get the cached afternoon payload",
    );
    assert.ok(second.tonightVibe, "evening rebuild must assemble tonightVibe");
  });

  it("ignores a malformed tzOffsetMinutes and falls back honestly", async () => {
    const { fakeClient } = makeFakeClient({ feature_flags: [enabledFlag()] });
    _setTestClient(fakeClient, true);
    _setTestHourUtc(13);
    const j = (await getHome("valid-token", "?tzOffsetMinutes=banana")).json as any;
    assert.equal(j.timeOfDay, "afternoon");
  });
});
