/**
 * census-discovery §81 (lane W10-S2) — A14: Layover mode gets a DWELL source
 * with provenance. Register: D-W10S2-3.
 *
 * node:test + node:assert (NOT vitest). Fake table-backed DB, frozen clock, no
 * network. §37.5 item 2: *"A dwell source with real provenance — a duration
 * column, or a derived figure carrying a source class and confidence … Not a
 * category average."*
 *
 * WHAT IS PINNED
 *   W1  flag OFF (the seed): the timing module reads no dwell table and its
 *       answer is byte-identical to a world where the table does not exist.
 *   W2  flag ON: a curated figure fills the ACTIVITY term of a place nobody
 *       planned, named `curated_dwell`; with a routed journey the certified
 *       universe ADMITS it; with no routed journey it stays UNMEASURED (the
 *       travel half is exactly where §37.5 item 1 left it).
 *   W3  the traveller's own stop supersedes a curated figure.
 *   W4  an unreadable dwell table is an ABSENCE that says so
 *       (`dwell_source_unreadable`), never a number and never "no stop".
 *   W5  a row the CHECKs would refuse is not a figure.
 *   W6  revocation both ways: a withdrawn figure is gone on the next read, a
 *       changed one is the new figure on the next read.
 *   W7  the writer refuses what the table would refuse, a missing place, and an
 *       unreadable place table; it writes the rest.
 *   W8  an OSM element has no subject and is never looked up.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverPlaceDwell.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { statedLayoverTimings } from "../lib/discoveryLayoverTiming.js";
import {
  LAYOVER_PLACE_DWELL_FLAG,
  readCuratedDwell,
  upsertCuratedDwell,
  deleteCuratedDwell,
} from "../services/airport/LayoverPlaceDwell.js";
import { certifiedLayoverSnapshot, certifiedActionUniverse } from "../services/airport/LayoverSnapshot.js";
import type { TravelTimeProvider } from "../domain/trips/contracts/TravelTimeProvider.js";

const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const USER = "user-1";
const SESSION = "session-1";
const PLACE = "11111111-2222-4333-8444-555555555555";
const OTHER = "11111111-2222-4333-8444-666666666666";
const CENTRE = { lat: 25.0797, lng: 121.2342 };
const HERE = { lat: 25.08, lng: 121.235 };

type Rows = Record<string, Array<Record<string, unknown>>>;

/** A routed provider that answers 18 minutes each way — the corridor a real one would give. */
const ROUTED: TravelTimeProvider = {
  id: "test-routed",
  routed: true,
  async estimate() {
    return {
      kind: "estimate" as const,
      estimate: {
        minutes: 18, p50Minutes: 18, p75Minutes: 18, p90Minutes: 18,
        confidence: "HIGH" as const, sourceClass: "LIVE" as const,
        observedAt: null, expiresAt: null, fallbackLevel: 0 as const,
        sourceRefs: ["test-routed"],
      },
    };
  },
};

/** No routed provider — this deployment's answer while the corridor switches are unset. */
const UNROUTED: TravelTimeProvider = {
  id: "test-unrouted",
  routed: false,
  async estimate() { return { kind: "unknown" as const, reason: "NO_ROUTED_PROVIDER" as const }; },
};

function dwellRow(over: Record<string, unknown> = {}) {
  return {
    place_id: PLACE, activity_min: 45, source_class: "curator_measured", confidence: "MEDIUM",
    evidence: "timed visit, 2026-09-10", stated_by: "admin-1",
    stated_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z", ...over,
  };
}

function world(opts: { flag: boolean; dwell?: Array<Record<string, unknown>> | null; stops?: Array<Record<string, unknown>> }): Rows {
  const t: Rows = {
    feature_flags: opts.flag ? [{ flag: LAYOVER_PLACE_DWELL_FLAG, enabled: true }] : [],
    discovery_places: [{ id: PLACE, name: "Night Market", city: "Taoyuan", status: "active" }, { id: OTHER, name: "Temple", city: "Taoyuan", status: "active" }],
    layover_plan_stops: opts.stops ?? [],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      id: SESSION, user_id: USER,
      arrival_time: new Date(NOW - 2 * 3_600_000).toISOString(),
      departure_time: new Date(NOW + 10 * 3_600_000).toISOString(),
    })],
  };
  if (opts.dwell !== null) t.layover_place_dwell = opts.dwell ?? [dwellRow()];
  return t;
}

function tracked(tables: Rows, failures: Record<string, { message: string }> = {}) {
  const fake = makeLayoverDb(tables, { failures });
  const read: string[] = [];
  const from = fake.from.bind(fake);
  fake.from = (t: string) => { read.push(t); return from(t); };
  return { db: fake as unknown as SupabaseClient, read };
}

async function timings(db: SupabaseClient, ids: string[] = [PLACE], provider: TravelTimeProvider = UNROUTED) {
  const r = await statedLayoverTimings(db, SESSION, ids.map((id) => ({ id, ...HERE })), {
    centre: CENTRE, departAt: new Date(NOW), provider,
  });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) throw new Error("unreachable");
  return r.byId;
}

describe("W1 — flag OFF (the seed) is byte-identical and reads no dwell table", () => {
  it("the answer equals a world with no dwell table at all, and the table is never read", async () => {
    const withTable = tracked(world({ flag: false }));
    const without = tracked(world({ flag: false, dwell: null }));
    const a = await timings(withTable.db, [PLACE, OTHER]);
    const b = await timings(without.db, [PLACE, OTHER]);
    assert.equal(JSON.stringify([...a]), JSON.stringify([...b]));
    assert.ok(!withTable.read.includes("layover_place_dwell"), `read: ${withTable.read.join(",")}`);
    assert.equal(a.get(PLACE)?.activityTimeMin, null);
    assert.equal(a.get(PLACE)?.activity.absence, "no_plan_stop");
  });
});

describe("W2 — flag ON: a curated figure fills the activity term, and admission still needs a routed journey", () => {
  it("activity = the curated minutes, named `curated_dwell`", async () => {
    const byId = await timings(tracked(world({ flag: true })).db);
    const t = byId.get(PLACE);
    assert.equal(t?.activityTimeMin, 45);
    assert.equal(t?.activitySource, "curated_dwell");
    assert.equal(t?.activity.absence, null);
  });

  it("with a ROUTED journey the certified universe ADMITS a place nobody planned; without one it is UNMEASURED", async () => {
    const { db } = tracked(world({ flag: true }));
    const snap = await certifiedLayoverSnapshot(db, USER, { nowMs: NOW });
    assert.ok(snap.ok, JSON.stringify(snap));
    if (!snap.ok) return;
    for (const [provider, want] of [[ROUTED, "ADMITTED"], [UNROUTED, "UNMEASURED"]] as const) {
      const t = (await timings(db, [PLACE], provider)).get(PLACE)!;
      const u = await certifiedActionUniverse(snap.snapshot, [{
        id: PLACE, ...HERE, insideAirport: false,
        travelTimeMin: t.travelTimeMin, returnTravelTimeMin: t.returnTravelTimeMin, activityTimeMin: t.activityTimeMin,
      }]);
      assert.equal(u.actions[0]?.state, want, `${provider.id}: ${JSON.stringify(u.actions[0])}`);
    }
  });

  it("CONTROL — flag OFF, the same routed journey: UNMEASURED (the admission above is the dwell's)", async () => {
    const { db } = tracked(world({ flag: false }));
    const snap = await certifiedLayoverSnapshot(db, USER, { nowMs: NOW });
    assert.ok(snap.ok);
    if (!snap.ok) return;
    const t = (await timings(db, [PLACE], ROUTED)).get(PLACE)!;
    const u = await certifiedActionUniverse(snap.snapshot, [{
      id: PLACE, ...HERE, insideAirport: false,
      travelTimeMin: t.travelTimeMin, returnTravelTimeMin: t.returnTravelTimeMin, activityTimeMin: t.activityTimeMin,
    }]);
    assert.equal(u.actions[0]?.state, "UNMEASURED");
  });
});

describe("W3 — the traveller's own stop supersedes a curated figure", () => {
  it("a stop with 90 minutes wins over a curated 45", async () => {
    const stop = {
      id: "stop-1", session_id: SESSION, place_id: PLACE, duration_min: 90, travel_min: 25, inside_airport: false,
    };
    const t = (await timings(tracked(world({ flag: true, stops: [stop] })).db)).get(PLACE);
    assert.equal(t?.activityTimeMin, 90);
    assert.equal(t?.activitySource, "traveller_plan_stop");
  });
});

describe("W4 — an unreadable dwell table is an absence that says so", () => {
  it("value null, `dwell_source_unreadable`, and the plan is still read", async () => {
    const { db } = tracked(world({ flag: true }), { "layover_place_dwell:select": { message: "relation unavailable" } });
    const t = (await timings(db, [PLACE], ROUTED)).get(PLACE);
    assert.equal(t?.activityTimeMin, null);
    assert.equal(t?.activitySource, "unmeasured");
    assert.equal(t?.activity.absence, "dwell_source_unreadable");
    assert.equal(t?.travelTimeMin, 18, "the travel term is not held hostage by the dwell read");
  });
});

describe("W5 — a row the table's CHECKs would refuse is not a figure", () => {
  for (const [name, over] of [
    ["under the floor", { activity_min: 4 }],
    ["over the ceiling", { activity_min: 721 }],
    ["not whole minutes", { activity_min: 45.5 }],
    ["a category default", { source_class: "category_default" }],
    ["no confidence", { confidence: null }],
    ["no evidence", { evidence: "  " }],
  ] as const) {
    it(name, async () => {
      const t = (await timings(tracked(world({ flag: true, dwell: [dwellRow(over)] })).db)).get(PLACE);
      assert.equal(t?.activityTimeMin, null);
    });
  }
});

describe("W6 — revocation both ways", () => {
  it("withdrawn → UNMEASURED on the next read; changed → the new figure on the next read", async () => {
    const tables = world({ flag: true });
    const { db } = tracked(tables);
    assert.equal((await timings(db)).get(PLACE)?.activityTimeMin, 45);
    const del = await deleteCuratedDwell(db, PLACE);
    assert.ok(del.ok);
    assert.equal((await timings(db)).get(PLACE)?.activityTimeMin, null);
    const put = await upsertCuratedDwell(db, PLACE, "admin-1", { activityMin: 60, sourceClass: "venue_stated", confidence: "HIGH", evidence: "venue timetable" });
    assert.ok(put.ok, JSON.stringify(put));
    assert.equal((await timings(db)).get(PLACE)?.activityTimeMin, 60);
    const again = await upsertCuratedDwell(db, PLACE, "admin-1", { activityMin: 30, sourceClass: "venue_stated", confidence: "HIGH", evidence: "venue timetable, revised" });
    assert.ok(again.ok);
    assert.equal((await timings(db)).get(PLACE)?.activityTimeMin, 30);
    assert.equal(tables.layover_place_dwell?.length, 1, "an upsert must replace, not append");
  });
});

describe("W7 — the writer", () => {
  it("refuses a figure outside 5–720, a missing place, and an unreadable place table", async () => {
    const { db } = tracked(world({ flag: true, dwell: [] }));
    const bad = await upsertCuratedDwell(db, PLACE, "admin-1", { activityMin: 900, sourceClass: "venue_stated", confidence: "LOW", evidence: "x" });
    assert.equal(bad.ok ? "ok" : bad.reason, "invalid");
    const missing = await upsertCuratedDwell(db, "99999999-2222-4333-8444-555555555555", "admin-1", { activityMin: 30, sourceClass: "venue_stated", confidence: "LOW", evidence: "x" });
    assert.equal(missing.ok ? "ok" : missing.reason, "place_not_found");
    const failing = tracked(world({ flag: true, dwell: [] }), { "discovery_places:select": { message: "down" } });
    const down = await upsertCuratedDwell(failing.db, PLACE, "admin-1", { activityMin: 30, sourceClass: "venue_stated", confidence: "LOW", evidence: "x" });
    assert.equal(down.ok ? "ok" : down.reason, "unreadable");
  });
});

describe("W8 — an OSM element has no subject and is never looked up", () => {
  it("only uuids reach the dwell read", async () => {
    const tables = world({ flag: true });
    const fake = makeLayoverDb(tables);
    const seen: unknown[] = [];
    const from = fake.from.bind(fake);
    fake.from = (t: string) => {
      const q = from(t);
      if (t !== "layover_place_dwell") return q;
      const inner = q.in.bind(q);
      q.in = (col: string, vals: unknown[]) => { seen.push(...vals); return inner(col, vals); };
      return q;
    };
    const r = await readCuratedDwell(fake as unknown as SupabaseClient, ["node/4242", null, PLACE]);
    assert.equal(r.state, "read");
    assert.deepEqual(seen, [PLACE]);
  });
});
