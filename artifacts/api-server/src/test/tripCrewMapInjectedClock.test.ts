/**
 * THE CREW MAP ANSWERS ABOUT THE CLOCK IT IS GIVEN — not the wall clock.
 *
 * This is the `computeTripStatus` defect, one directory over. Two projection
 * builders take an injected `now` and thread it through everything they own:
 *
 *   buildTripPulseProjection  -> readCrewPresenceForPulse(sc, tripId, viewerId, nowMs)
 *   buildTripTodayProjection  -> readCrewSummary(sc, tripId, viewerId, rows, nowMs)
 *
 * Each then calls `getCrewMap`, which had NO clock parameter — so it filtered
 * live-share grants with `.gt("expires_at", new Date())` and called
 * `buildCrewCard(raw)` without the `now` that function has carried since it was
 * written. `buildCrewCard`'s own comment names the hazard exactly ("A guard
 * whose contract is enforced somewhere else is not a guard"), and the guard it
 * describes was being judged on a different clock from the projection wrapped
 * around it.
 *
 * These tests are the ones that would have caught it, and they are written so
 * they cannot rot: every instant is derived from a constant that is NOT the
 * present in either direction, and every assertion is judged against that same
 * constant. A fixed date is only a bomb when the fixture is pinned and the
 * assertion is not; here both are pinned to the same instant, which is the
 * whole point — if the production code reaches for the wall clock again, the
 * pinned answer and the wall-clock answer disagree and these fail.
 *
 * Run: node --import tsx/esm --test src/test/tripCrewMapInjectedClock.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { getCrewMap } from "../domain/trips/services/TripCrewLocationService.js";
import { readCrewPresenceForPulse } from "../domain/trips/projections/TripPulseCrewPresence.js";
import { invalidateTripOperationalProjectionsGate } from "../domain/trips/policies/tripOperationalProjections.js";

type Row = Record<string, any>;

const TRIP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const SHARER = "33333333-3333-4333-8333-333333333333";

/**
 * Two instants that are never "now": one long past, one long future. Using both
 * catches the defect in BOTH directions — a wall-clock read makes the past case
 * look expired and the future case look still-granted, and only an injected
 * clock gets both right.
 */
const PAST_MS = Date.parse("2019-05-04T10:00:00.000Z");
const FUTURE_MS = Date.parse("2031-02-03T08:00:00.000Z");
const MIN = 60_000;

/**
 * A fake that HONOURS `.gt()` and `.is()`, unlike the crew fixtures elsewhere in
 * this suite. That matters: `getCrewMap`'s live-share window is a `.gt` on
 * `expires_at`, so a fake that ignores `.gt` can never see this defect. The
 * existing crew coverage in tripKernelFamiliesWiring.test.ts uses such a fake,
 * which is one reason the gap survived.
 */
function fake(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        gt: (c: string, v: any) => { filters.push((r) => String(r[c]) > String(v)); return chain; },
        lt: (c: string, v: any) => { filters.push((r) => String(r[c]) < String(v)); return chain; },
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (onF: any, onR: any) => Promise.resolve({ data: rows(), error: null }).then(onF, onR),
      };
      return chain;
    },
  };
}

/**
 * A crew of two — the viewer and one sharer — with the sharer's live-share
 * grant and last position both expressed RELATIVE to `atMs`. Nothing in here is
 * a calendar constant; the caller decides which instant the world is about.
 */
function crewAt(atMs: number, opts: { grantEndsMs?: number; observedMs?: number } = {}): Record<string, Row[]> {
  const grantEnds = opts.grantEndsMs ?? atMs + 30 * MIN;
  const observed = opts.observedMs ?? atMs - MIN;
  return {
    // The subgroup gate is off: this defect has nothing to do with subgroups,
    // and leaving it off keeps the fixture to the columns that matter.
    // `feature_flags` is keyed on `flag`, not `key`.
    feature_flags: [{ flag: "trip_operational_projections_enabled", enabled: false }],
    trips: [{ id: TRIP_ID, owner_id: OWNER_ID, version: 1 }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
      { trip_id: TRIP_ID, user_id: VIEWER, role: "member", status: "accepted" },
      { trip_id: TRIP_ID, user_id: SHARER, role: "member", status: "accepted" },
    ],
    blocks: [],
    profiles: [
      { id: SHARER, username: "sharer", display_name: "Sharer" },
      { id: OWNER_ID, username: "owner", display_name: "Owner" },
    ],
    profile_privacy_settings: [],
    trip_crew_location_preferences: [
      { trip_id: TRIP_ID, user_id: SHARER, default_visibility: "nearby", ghost_mode_enabled: false, share_arrival_status: true, share_safe_return_status: false },
    ],
    user_location_state: [
      {
        user_id: SHARER, city: "Lisboa", district: "Alfama", country: "PT",
        updated_at: new Date(observed).toISOString(),
        last_known_at: new Date(observed).toISOString(),
        lat: 38.71, lng: -9.13, source: "gps", accuracy_meters: 20,
      },
    ],
    location_preferences: [],
    plan_checkins: [],
    safe_return_sessions: [],
    trip_crew_location_sessions: [
      {
        id: "s-1", trip_id: TRIP_ID, user_id: SHARER, status: "active",
        expires_at: new Date(grantEnds).toISOString(),
        allowed_member_ids: [VIEWER], visibility_level: "nearby",
      },
    ],
    trip_subgroup_members: [],
  };
}

beforeEach(() => { invalidateTripOperationalProjectionsGate(); });

describe("getCrewMap answers about the instant it is given (second-clock guard)", () => {
  it("a grant that is ACTIVE at a long-past instant is served when that instant is the one asked about", async () => {
    const db = fake(crewAt(PAST_MS)) as any;
    const map = await getCrewMap(db, TRIP_ID, VIEWER, PAST_MS);
    const sharer = map.members.find((m) => m.userId === SHARER);
    assert.ok(sharer, "the sharer is missing from the crew map");
    assert.equal(
      sharer!.liveShareActive, true,
      "the grant runs until 30 minutes after the asked-about instant; reading the wall clock instead calls it expired",
    );
    assert.ok(
      sharer!.exactCoords,
      "an active 'nearby' grant is the only way a card carries exact coordinates; the wall clock withheld them",
    );
  });

  it("the position's freshness is judged on the asked-about instant, not on today", async () => {
    const db = fake(crewAt(PAST_MS, { observedMs: PAST_MS - MIN })) as any;
    const map = await getCrewMap(db, TRIP_ID, VIEWER, PAST_MS);
    const sharer = map.members.find((m) => m.userId === SHARER)!;
    assert.equal(
      sharer.freshnessClass, "LIVE",
      "a fix one minute before the asked-about instant is LIVE; against the wall clock it is years old",
    );
    assert.equal(sharer.observedAtSource, "last_known_at");
  });

  it("a grant that has ALREADY EXPIRED at a long-future instant is refused, even though the wall clock says it is still running", async () => {
    // expires 30 minutes BEFORE the asked-about instant — but years AFTER the
    // real present. Only an injected clock can tell these apart, and this is
    // the direction that leaks: the wall clock would release coordinates under
    // a grant the viewer no longer holds.
    const db = fake(crewAt(FUTURE_MS, { grantEndsMs: FUTURE_MS - 30 * MIN })) as any;
    const map = await getCrewMap(db, TRIP_ID, VIEWER, FUTURE_MS);
    const sharer = map.members.find((m) => m.userId === SHARER)!;
    assert.equal(sharer.liveShareActive, false, "an expired grant was reported as active");
    assert.equal(sharer.exactCoords ?? null, null, "exact coordinates were released under an expired grant");
  });

  it("the parameter is additive: with no clock passed, the answer is the wall clock's, exactly as before", async () => {
    // The window is derived from the clock this assertion is judged against —
    // never from a calendar constant, which is how the three date bombs of
    // 2026-09-15 were armed.
    const db = fake(crewAt(Date.now())) as any;
    const map = await getCrewMap(db, TRIP_ID, VIEWER);
    const sharer = map.members.find((m) => m.userId === SHARER)!;
    assert.equal(sharer.liveShareActive, true);
    assert.ok(sharer.exactCoords);
  });
});

describe("the two injected-clock projections carry their clock all the way down", () => {
  /**
   * These assert the THREADING, at the one place it is observable: the instant
   * the live-share window is read at. Recording the `.gt("expires_at", …)`
   * argument is the whole test — if either projection ever stops passing its
   * `now` (or `getCrewMap` goes back to reading the wall clock), the recorded
   * instant is today's and these fail on any day the suite runs.
   *
   * It is done by spy rather than through the returned observations because
   * `readCrewPresenceForPulse` cannot produce any: `getCrewMap` excludes the
   * viewer from `members` by design, so that function's `viewerPoint` is always
   * null and its `for` loop always `continue`s. That is a real defect, but a
   * different one — reported, not fixed here.
   */
  function spy(tables: Record<string, Row[]>) {
    const windowReads: string[] = [];
    const inner = fake(tables) as any;
    return {
      windowReads,
      client: {
        from(table: string) {
          const chain = inner.from(table);
          if (table !== "trip_crew_location_sessions") return chain;
          const gt = chain.gt;
          chain.gt = (c: string, v: any) => { if (c === "expires_at") windowReads.push(String(v)); return gt(c, v); };
          return chain;
        },
      },
    };
  }

  function crewFlagOn(atMs: number): Record<string, Row[]> {
    const tables = crewAt(atMs);
    tables.feature_flags = [
      { flag: "trip_operational_projections_enabled", enabled: false },
      { flag: "trip_crew_map_enabled", enabled: true },
    ];
    return tables;
  }

  it("the Pulse reads the crew map's live-share window at the Pulse's own nowMs", async () => {
    const s = spy(crewFlagOn(PAST_MS));
    const res = await readCrewPresenceForPulse(s.client as any, TRIP_ID, VIEWER, PAST_MS);
    assert.equal(res.source.status, "ok", JSON.stringify(res.source));
    assert.deepEqual(
      s.windowReads, [new Date(PAST_MS).toISOString()],
      "the crew map's grant window was read at a different instant from the one the Pulse was asked about",
    );
  });

  it("the Today projection reads the crew map's live-share window at the builder's own now", async () => {
    const { buildTripTodayProjection } = await import("../domain/trips/projections/TripTodayProjection.js");
    const tables = crewFlagOn(PAST_MS);
    // The Today builder refuses before it reaches the crew unless its own gate
    // is on; every other input stays empty, which it reports rather than guesses.
    tables.feature_flags = [
      { flag: "trip_operational_projections_enabled", enabled: true },
      { flag: "trip_crew_map_enabled", enabled: true },
    ];
    const s = spy(tables);
    invalidateTripOperationalProjectionsGate();
    await buildTripTodayProjection(s.client as any, TRIP_ID, VIEWER, { now: new Date(PAST_MS) });
    assert.ok(
      s.windowReads.length > 0,
      "the Today projection never reached the crew map; the fixture no longer exercises the path this guards",
    );
    assert.deepEqual(
      [...new Set(s.windowReads)], [new Date(PAST_MS).toISOString()],
      "the crew summary counted live shares at the wall clock, not at the instant the projection is about",
    );
  });
});
