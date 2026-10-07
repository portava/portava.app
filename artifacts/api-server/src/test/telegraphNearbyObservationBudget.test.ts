/**
 * census-telegraph T26 — §4.3 "Do not allow repeated refreshes to become a
 * movement-tracking side channel", as a per-RELATIONSHIP observation budget
 * (services/telegraph/proximityObservationBudget.ts, migration 3651).
 *
 * The census's remainder: "the guard is per-request quantisation, not the
 * per-relationship budget §4.5 describes, and nothing bounds observations across
 * a long session." A viewer polling once a minute saw every bucket edge a
 * crewmate crossed, timed to the minute.
 *
 * WHAT IS EXERCISED: the real budget over an in-memory table that keys rows the
 * way 3651's primary key does — (viewer_id, subject_id) — so an upsert replaces;
 * and the real route over the fail-closed double for the refusal path.
 *
 * Run: node --import tsx/esm --test src/test/telegraphNearbyObservationBudget.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import express from "express";
import {
  applyObservationBudget,
  OBSERVATION_INTERVAL_MS,
  OBSERVATION_RETENTION_MS,
} from "../services/telegraph/proximityObservationBudget.js";
import { nearbyRank, type ReachablePersonProjection } from "../services/telegraph/reachablePeople.js";
import type { ProximityBucket, TravelBand } from "../lib/proximityBuckets.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import nearbyReachableRouter from "../routes/nearbyReachable.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const ANA = "22222222-2222-4222-8222-222222222222";
const BEN = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const MIN = 60_000;

const TRAVEL: Record<ProximityBucket, TravelBand> = {
  same_area: "walkable", nearby: "walkable", same_city: "short_ride", same_region: "long_ride", far: "out_of_range", unknown: "unknown",
};

/** A projection as the loader builds it; the rank is nearbyRank over the same factors. */
function person(id: string, bucket: ProximityBucket, published = true): ReachablePersonProjection {
  const travel = TRAVEL[bucket];
  const rank = nearbyRank({
    availability: "available_now", relationship: "crew", proximity: bucket, overlap: "none", sharedContextCount: 1,
    intentOverlap: 0, travel, freshness: "live", safety: "clear",
  });
  return {
    personId: id,
    relationship: { tier: "crew", origins: ["CREW"] },
    availability: { state: "available_now", intents: [], overlap: "none", publishedUntil: null },
    proximity: { bucket: published ? bucket : "unknown", precision: "bucket", travel: published ? travel : "unknown", freshness: "live" },
    sharedContext: { trips: 1, circles: 0, kinds: ["trip"] },
    privacy: { availabilityPublished: true, proximityPublished: published, preciseShared: false },
    safety: { state: "clear" },
    rank,
  };
}

/** The 3651 table in memory: rows keyed by (viewer_id, subject_id), as its primary key. */
function budgetDb(opts: { readError?: boolean; writeError?: boolean; deleteError?: boolean } = {}) {
  const rows = new Map<string, Record<string, string>>();
  const key = (v: string, s: string) => `${v}|${s}`;
  const writes: Array<Record<string, string>> = [];
  const db: any = {
    from(table: string) {
      assert.equal(table, "nearby_proximity_observations");
      const filters: Array<(r: Record<string, string>) => boolean> = [];
      let mode: "select" | "upsert" | "delete" = "select";
      let pending: Array<Record<string, string>> = [];
      const q: any = {
        select() { return q; },
        eq(c: string, v: string) { filters.push((r) => r[c] === v); return q; },
        in(c: string, vs: string[]) { filters.push((r) => vs.includes(r[c]!)); return q; },
        lt(c: string, v: string) { filters.push((r) => Date.parse(r[c]!) < Date.parse(v)); return q; },
        upsert(rs: Array<Record<string, string>>, o: { onConflict?: string }) {
          assert.equal(o?.onConflict, "viewer_id,subject_id", "the upsert must name 3651's primary key");
          mode = "upsert"; pending = rs; return q;
        },
        delete() { mode = "delete"; return q; },
        then(resolve: (v: any) => void) {
          const match = () => [...rows.values()].filter((r) => filters.every((f) => f(r)));
          if (mode === "select") return resolve(opts.readError ? { data: null, error: { message: "relation does not exist", code: "42P01" } } : { data: match(), error: null });
          if (mode === "upsert") {
            if (opts.writeError) return resolve({ data: null, error: { message: "permission denied", code: "42501" } });
            for (const r of pending) { rows.set(key(r.viewer_id!, r.subject_id!), { ...r }); writes.push({ ...r }); }
            return resolve({ data: null, error: null });
          }
          if (opts.deleteError) return resolve({ data: null, error: { message: "permission denied", code: "42501" } });
          for (const r of match()) rows.delete(key(r.viewer_id!, r.subject_id!));
          return resolve({ data: null, error: null });
        },
      };
      return q;
    },
  };
  return { db, rows, writes, row: (s: string) => rows.get(key(VIEWER, s)) };
}

async function serve(db: any, people: ReachablePersonProjection[], now: number) {
  const out = await applyObservationBudget(db, VIEWER, people, now);
  assert.ok(out.ok, JSON.stringify(out));
  return out.people;
}
const bucketOf = (ps: ReachablePersonProjection[], id: string) => ps.find((p) => p.personId === id)!.proximity.bucket;

describe("T26 — one observation of a relationship's proximity per interval", () => {
  it("the first poll serves the fresh proximity and records it", async () => {
    const b = budgetDb();
    const ps = await serve(b.db, [person(ANA, "nearby")], T0);
    assert.equal(bucketOf(ps, ANA), "nearby");
    assert.equal(b.row(ANA)?.bucket, "nearby");
    assert.equal(b.row(ANA)?.observed_at, new Date(T0).toISOString());
  });

  it("THE POINT: ANA moves inside the interval — the viewer is still shown what was recorded, and nothing is re-recorded", async () => {
    const b = budgetDb();
    await serve(b.db, [person(ANA, "nearby")], T0);
    for (const [m, now] of [[1, "same_city"], [5, "far"], [14, "same_area"]] as Array<[number, ProximityBucket]>) {
      const ps = await serve(b.db, [person(ANA, now)], T0 + m * MIN);
      assert.equal(bucketOf(ps, ANA), "nearby", `minute ${m}: a move to ${now} reached the viewer inside the interval`);
      assert.equal(ps[0]!.proximity.travel, "walkable");
    }
    assert.equal(b.writes.length, 1, "inside the interval the record is not refreshed");
  });

  it("at the interval boundary the fresh proximity is observed and recorded", async () => {
    const b = budgetDb();
    await serve(b.db, [person(ANA, "nearby")], T0);
    const ps = await serve(b.db, [person(ANA, "far")], T0 + OBSERVATION_INTERVAL_MS);
    assert.equal(bucketOf(ps, ANA), "far");
    assert.equal(b.row(ANA)?.bucket, "far");
  });

  it("a day of polling every minute while ANA changes bucket every minute observes her at most 96 times", async () => {
    const b = budgetDb();
    const ladder: ProximityBucket[] = ["same_area", "nearby", "same_city", "same_region", "far"];
    let changes = 0;
    let last: string | null = null;
    for (let m = 0; m < 24 * 60; m++) {
      const ps = await serve(b.db, [person(ANA, ladder[m % ladder.length]!)], T0 + m * MIN);
      const shown = bucketOf(ps, ANA);
      if (shown !== last) { changes += 1; last = shown; }
    }
    assert.ok(changes <= (24 * 60 * MIN) / OBSERVATION_INTERVAL_MS, `the viewer saw ${changes} changes in a day`);
    assert.equal(b.writes.length, 96);
  });

  it("the ORDER follows the served proximity, so the sort cannot leak a move the budget withheld", async () => {
    const b = budgetDb();
    // First observation: ANA nearby, BEN far → ANA first.
    let ps = await serve(b.db, [person(ANA, "nearby"), person(BEN, "far")], T0);
    assert.deepEqual(ps.map((p) => p.personId), [ANA, BEN]);
    // Inside the interval they swap places for real. Served: still nearby / far, so the order holds.
    ps = await serve(b.db, [person(ANA, "far"), person(BEN, "nearby")], T0 + 5 * MIN);
    assert.deepEqual(ps.map((p) => p.personId), [ANA, BEN], "the order moved with an unserved move");
    assert.equal(ps[0]!.rank, person(ANA, "nearby").rank, "the served rank is the rank of the served proximity");
  });

  it("withdrawal is never delayed: ANA stops publishing → withheld at once, and her record is deleted", async () => {
    const b = budgetDb();
    await serve(b.db, [person(ANA, "nearby")], T0);
    const ps = await serve(b.db, [person(ANA, "nearby", false)], T0 + 2 * MIN);
    assert.equal(bucketOf(ps, ANA), "unknown");
    assert.equal(ps[0]!.privacy.proximityPublished, false);
    assert.equal(b.row(ANA), undefined, "a record outlived the consent it was observed under");
    // Publishing again starts a NEW observation, not the old one.
    const again = await serve(b.db, [person(ANA, "far")], T0 + 3 * MIN);
    assert.equal(bucketOf(again, ANA), "far");
  });

  it("a person who LEAVES the list (blocked, invisible, no longer a candidate) loses their record at once", async () => {
    const b = budgetDb();
    await serve(b.db, [person(ANA, "nearby"), person(BEN, "far")], T0);
    assert.ok(b.row(ANA) && b.row(BEN));
    const ps = await serve(b.db, [person(BEN, "far")], T0 + 2 * MIN);
    assert.deepEqual(ps.map((p) => p.personId), [BEN]);
    assert.equal(b.row(ANA), undefined, "a record outlived the person's place on the list");
    assert.ok(b.row(BEN), "a listed person's record was deleted");
    await serve(b.db, [], T0 + 3 * MIN);
    assert.equal(b.rows.size, 0, "an empty list leaves no record behind");
  });

  it("a viewer who stopped polling leaves rows behind; ANY viewer's read deletes them once past retention", async () => {
    const b = budgetDb();
    const GONE = "55555555-5555-4555-8555-555555555555";
    const old = new Date(T0 - OBSERVATION_RETENTION_MS - MIN).toISOString();
    const young = new Date(T0 - OBSERVATION_RETENTION_MS + MIN).toISOString();
    b.rows.set(`${GONE}|${BEN}`, { viewer_id: GONE, subject_id: BEN, bucket: "far", travel: "out_of_range", freshness: "live", observed_at: old });
    b.rows.set(`${GONE}|${ANA}`, { viewer_id: GONE, subject_id: ANA, bucket: "nearby", travel: "walkable", freshness: "live", observed_at: young });
    await serve(b.db, [person(ANA, "nearby")], T0);
    assert.equal(b.rows.get(`${GONE}|${BEN}`), undefined, "another viewer's day-old record was kept");
    assert.ok(b.rows.get(`${GONE}|${ANA}`), "a record inside the retention window was purged");
    assert.ok(b.row(ANA));
  });

  it("an unreadable record, a refused write or a refused delete REFUSES the answer — never fresh proximity unrecorded", async () => {
    for (const opts of [{ readError: true }, { writeError: true }]) {
      const out = await applyObservationBudget(budgetDb(opts).db, VIEWER, [person(ANA, "nearby")], T0);
      assert.equal(out.ok, false, JSON.stringify(opts));
    }
    const b = budgetDb({ deleteError: true });
    const out = await applyObservationBudget(b.db, VIEWER, [person(ANA, "nearby")], T0);
    assert.equal(out.ok, false, "the retention purge failing must not pass silently");
  });

  it("a record holding an unknown value is not served — the fresh proximity is observed instead", async () => {
    const b = budgetDb();
    b.rows.set(`${VIEWER}|${ANA}`, { viewer_id: VIEWER, subject_id: ANA, bucket: "1.2km", travel: "walkable", freshness: "live", observed_at: new Date(T0).toISOString() });
    const ps = await serve(b.db, [person(ANA, "far")], T0 + MIN);
    assert.equal(bucketOf(ps, ANA), "far");
  });
});

describe("T26 — the route refuses when the budget cannot be kept", () => {
  let server: Server;
  let port = 0;
  before(() => new Promise<void>((resolve) => {
    const a = express();
    a.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {}, child() { return (req as any).log; } }; next(); });
    a.use("/api", nearbyReachableRouter);
    server = createServer(a);
    server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); });
  }));
  after(() => new Promise<void>((resolve) => { _setTestClient(null as any, false); _setTestServiceClient(null as any); server.close(() => resolve()); }));

  // The world nearbyReachableRoute.test.ts drives (a crewmate on a shared trip, sharing a fresh
  // position), so the loader projects someone and the budget MUST be consulted.
  const CREWMATE = ANA;
  const TRIP = "44444444-4444-4444-8444-444444444444";
  const LAT = 41.157944;
  const LNG = -8.629105;
  function routeWorld() {
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const fresh = new Date(Date.now() - 60_000).toISOString();
    return {
      users: { tok: VIEWER },
      rows: {
        feature_flags: [{ flag: "nearby_reachable_enabled", enabled: true }],
        blocks: [],
        circle_memberships: [{ user_id: VIEWER, other_id: CREWMATE }],
        trip_members: [
          { trip_id: TRIP, user_id: VIEWER, status: "accepted" },
          { trip_id: TRIP, user_id: CREWMATE, status: "accepted" },
        ],
        location_preferences: [
          { user_id: VIEWER, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
          { user_id: CREWMATE, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
        ],
        user_privacy_settings: [{ user_id: CREWMATE, allow_location_sharing: true }],
        profile_privacy_settings: [{ user_id: CREWMATE, allow_profile_discovery: true }],
        user_location_state: [
          { user_id: VIEWER, lat: LAT, lng: LNG, last_known_at: fresh },
          { user_id: CREWMATE, lat: LAT + 0.01, lng: LNG + 0.01, last_known_at: fresh },
        ],
        user_availability: [{ user_id: CREWMATE, open_to_meet: true }],
        quick_availability_status: [{ user_id: CREWMATE, status: "free_now", expires_at: soon }],
        availability_windows: [],
        profiles: [{ id: CREWMATE, message_privacy: "everyone", allow_message_requests: true }],
        friendships: [],
        follows: [],
      } as Record<string, Record<string, any>[]>,
    };
  }
  const get = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/nearby/reachable`, { headers: { Authorization: "Bearer tok" } });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("CONTROL: with the budget table readable, the crewmate is served and the observation is recorded", async () => {
    const spec: any = { ...routeWorld(), inserted: {} };
    _setTestClient(makeFailClosedClient(spec) as any, true);
    const { status, body } = await get();
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.people.length, 1);
    assert.equal(body.observationIntervalMs, OBSERVATION_INTERVAL_MS);
    const recorded = spec.inserted?.nearby_proximity_observations ?? [];
    assert.equal(recorded.length, 1, "the observation served was not recorded");
    assert.equal(recorded[0].viewer_id, VIEWER);
    assert.equal(recorded[0].subject_id, CREWMATE);
    assert.equal(recorded[0].bucket, body.people[0].proximity.bucket);
    assert.ok(!("lat" in recorded[0]) && !("lng" in recorded[0]), "a position reached the record");
  });

  it("THE ROUTE SERVES THE BUDGET: a crewmate observed 'far' a minute ago is still 'far', wherever she is now", async () => {
    const w = routeWorld();
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    w.rows.nearby_proximity_observations = [
      { viewer_id: VIEWER, subject_id: CREWMATE, bucket: "far", travel: "out_of_range", freshness: "live", observed_at: observedAt },
    ];
    _setTestClient(makeFailClosedClient(w) as any, true);
    const { status, body } = await get();
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.people[0].proximity.bucket, "far", "the route served the fresh bucket past the record");
    assert.equal(body.people[0].proximity.travel, "out_of_range");
  });

  it("a database without 3651 (the table unreadable) answers 503 — never a list served past the budget", async () => {
    _setTestClient(makeFailClosedClient({
      ...routeWorld(),
      failOn: (ctx) => (ctx.table === "nearby_proximity_observations" ? { message: 'relation "nearby_proximity_observations" does not exist', code: "42P01" } : null),
    }) as any, true);
    const { status, body } = await get();
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal("people" in body, false);
  });

  it("a budget write that does not land answers 503", async () => {
    _setTestClient(makeFailClosedClient({
      ...routeWorld(),
      failWritesOn: (t) => (t === "nearby_proximity_observations" ? { message: "permission denied", code: "42501" } : null),
    }) as any, true);
    const { status } = await get();
    assert.equal(status, 503);
  });
});
