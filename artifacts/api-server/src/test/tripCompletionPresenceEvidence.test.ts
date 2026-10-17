/**
 * H4 — a trip the calendar completed is not a trip anybody took.
 *
 * census-highlights-memories H4: "Planned/saved/nearby never represented as
 * 'experienced' without occurrence evidence or user confirmation."
 *
 * `PATCH /api/trips/:tripId` recomputes `status` from the dates. On a trip whose
 * end date has passed, ANY patch — an empty body included — completes it, and
 * the completion used to award the nine trip-completion stamps, with the
 * destination city and country, to every accepted member. A planned trip
 * nobody took became "first trip completed, Paris, France" and a country on
 * each member's Passport. These cases pin the evidence gate
 * (`services/passport/tripCompletionPresence.ts`) on the route, on its two
 * functions, and on the criteria engine's `trips_completed` metric.
 *
 * Run: node --import tsx/esm --test src/test/tripCompletionPresenceEvidence.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import {
  readTripPresenceEvidence,
  countEvidencedCompletedTrips,
} from "../services/passport/tripCompletionPresence.js";
import { resolveMetric } from "../lib/stamps/criteria/metrics.js";

const OWNER  = "a1000000-0000-4000-8000-0000000000a1";
const MEMBER = "a1000000-0000-4000-8000-0000000000b2";
const TRIP   = "b1000000-0000-4000-8000-0000000000c3";
const OTHER_TRIP = "b1000000-0000-4000-8000-0000000000d4";

const COMPLETION_SLUGS = [
  "first_trip_completed", "long_haul", "weekend_wanderer", "international_voyager",
  "solo_traveler", "group_tripper", "good_host", "road_warrior", "frequent_flyer",
];

type DB = Record<string, any[]>;

function makeDB(over: DB = {}): DB {
  return {
    trips: [{
      id: TRIP, owner_id: OWNER, status: "planning", title: "Paris Adventure",
      destination_city: "Paris", destination_country: "France",
      start_date: "2020-01-03", end_date: "2020-01-05", visibility: "private",
      updated_at: new Date().toISOString(),
    }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner" },
      { trip_id: TRIP, user_id: MEMBER, role: "member" },
    ],
    feature_flags: [{ flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true }],
    stamp_definitions: COMPLETION_SLUGS.map((slug, i) => ({
      id: `d0000000-0000-4000-8000-00000000000${i}`, slug, name: slug, stamp_type: "trip",
      is_active: true, is_repeatable: false, max_awards_per_user: null,
      visibility_default: "public", criteria_type: "automatic", criteria: null,
    })),
    user_stamps: [], stamp_award_events: [], stamp_progress: [], notifications: [],
    notification_devices: [], profiles: [{ id: OWNER, role: "user" }, { id: MEMBER, role: "user" }],
    blocks: [], plan_editors: [], plan_checkins: [], passport_stamps: [],
    ...over,
  };
}

/** In-memory client. `failing` makes every read of a table answer with an error. */
function makeClient(db: DB, failing: ReadonlySet<string> = new Set()) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let ins: any[] | null = null;
    let upd: any = null;
    let ups: any[] | null = null;
    let head = false;
    let one: "single" | "maybe" | null = null;
    const arr = () => (db[table] ??= []);
    const c: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; return c; },
      insert(d: any) { ins = Array.isArray(d) ? d : [d]; return c; },
      update(d: any) { upd = d; return c; },
      upsert(d: any) { ups = Array.isArray(d) ? d : [d]; return c; },
      delete() { return c; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return c; },
      neq(k: string, v: any) { filters.push((r) => r[k] !== v); return c; },
      is(k: string, v: any) { filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return c; },
      in(k: string, vs: any[]) { filters.push((r) => vs.includes(r[k])); return c; },
      not(k: string, op: string, v: any) { if (op === "is" && v === null) filters.push((r) => r[k] != null); return c; },
      or() { return c; }, gte() { return c; }, lte() { return c; }, gt() { return c; }, lt() { return c; },
      ilike() { return c; }, order() { return c; }, range() { return c; }, limit() { return c; },
      single() { one = "single"; return c; },
      maybeSingle() { one = "maybe"; return c; },
      then(res: any, rej: any) {
        return Promise.resolve().then(() => {
          if (failing.has(table) && !ins && !upd && !ups) return res({ data: null, error: { message: `${table} unreadable` }, count: null });
          const match = (r: any) => filters.every((f) => f(r));
          if (ups) { for (const row of ups) { const i = arr().findIndex(match); if (i >= 0) Object.assign(arr()[i], row); else arr().push({ id: `gen-${Math.random()}`, ...row }); } return res({ data: ups, error: null }); }
          if (ins) {
            if (table === "stamp_award_events" && ins.some((r) => arr().some((x) => x.idempotency_key === r.idempotency_key))) {
              return res({ data: null, error: { message: "duplicate key", code: "23505" } });
            }
            for (const row of ins) arr().push({ id: row.id ?? `gen-${Math.random()}`, ...row });
            return res({ data: one ? { ...arr()[arr().length - 1] } : ins, error: null });
          }
          if (upd) { const m = arr().filter(match); for (const r of m) Object.assign(r, upd); return res({ data: one ? m[0] ?? null : m, error: null }); }
          const rows = arr().filter(match).map((r) => ({ ...r }));
          if (head) return res({ data: null, error: null, count: rows.length });
          if (one) return res({ data: rows[0] ?? null, error: null });
          return res({ data: rows, error: null, count: rows.length });
        }).catch(rej);
      },
    };
    return c;
  }
  return {
    auth: { getUser: async () => ({ data: { user: { id: OWNER, email: "o@example.com" } }, error: null }) },
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: null }),
  };
}

const arrival = (user: string, trip = TRIP, status = "arrived") =>
  ({ trip_id: trip, user_id: user, status, checked_in_at: "2020-01-03T10:00:00Z" });

const slugsOf = (db: DB, user: string) =>
  db.user_stamps
    .filter((s) => s.user_id === user)
    .map((s) => db.stamp_definitions.find((d) => d.id === s.stamp_definition_id)?.slug)
    .sort();

// ── The two functions ────────────────────────────────────────────────────────

describe("readTripPresenceEvidence", () => {
  it("an arrival check-in on THIS trip is evidence; intent, other trips and other people are not", async () => {
    const db = makeDB({
      plan_checkins: [
        arrival(OWNER),
        arrival(MEMBER, TRIP, "on_the_way"),
        arrival(MEMBER, TRIP, "no_show"),
        { trip_id: TRIP, user_id: MEMBER, status: "arrived", checked_in_at: null },
        arrival(MEMBER, OTHER_TRIP),
        arrival("someone-else"),
      ],
    });
    const r = await readTripPresenceEvidence(makeClient(db) as any, TRIP, [OWNER, MEMBER]);
    assert.deepEqual([...r.present], [OWNER]);
    assert.deepEqual(r.unreadable, []);
  });

  it("late and left follow an arrival and count", async () => {
    const db = makeDB({ plan_checkins: [arrival(OWNER, TRIP, "late"), arrival(MEMBER, TRIP, "left")] });
    const r = await readTripPresenceEvidence(makeClient(db) as any, TRIP, [OWNER, MEMBER]);
    assert.deepEqual([...r.present].sort(), [OWNER, MEMBER].sort());
  });

  it("a verified-level passport stamp on this trip counts; an unverified one does not", async () => {
    const db = makeDB({
      passport_stamps: [
        { trip_id: TRIP, user_id: OWNER, verification_level: "gps" },
        { trip_id: TRIP, user_id: MEMBER, verification_level: "unverified" },
      ],
    });
    const r = await readTripPresenceEvidence(makeClient(db) as any, TRIP, [OWNER, MEMBER]);
    assert.deepEqual([...r.present], [OWNER]);
  });

  it("an unreadable source contributes nothing and is reported; the readable one still counts", async () => {
    const db = makeDB({
      plan_checkins: [arrival(MEMBER)],
      passport_stamps: [{ trip_id: TRIP, user_id: OWNER, verification_level: "checkin" }],
    });
    const r = await readTripPresenceEvidence(makeClient(db, new Set(["plan_checkins"])) as any, TRIP, [OWNER, MEMBER]);
    assert.deepEqual([...r.present], [OWNER]);
    assert.deepEqual(r.unreadable, ["plan_checkins"]);
  });
});

describe("countEvidencedCompletedTrips", () => {
  const completed = (id: string) => ({ id, owner_id: OWNER, status: "completed" });

  it("counts only completed trips the owner checked in on", async () => {
    const db = makeDB({
      trips: [completed("t1"), completed("t2"), completed("t3"), { id: "t4", owner_id: OWNER, status: "planning" }],
      plan_checkins: [arrival(OWNER, "t1"), arrival(OWNER, "t4"), arrival(MEMBER, "t2"), arrival(OWNER, "t3", "nearby")],
      passport_stamps: [{ trip_id: "t2", user_id: OWNER, verification_level: "checkin" }],
    });
    assert.deepEqual(await countEvidencedCompletedTrips(makeClient(db) as any, OWNER), { count: 2, error: null });
  });

  it("any failed read is an error, never a smaller number", async () => {
    for (const t of ["trips", "plan_checkins", "passport_stamps"]) {
      const db = makeDB({ trips: [completed("t1")], plan_checkins: [arrival(OWNER, "t1")] });
      const r = await countEvidencedCompletedTrips(makeClient(db, new Set([t])) as any, OWNER);
      assert.equal(r.count, null, t);
      assert.ok(r.error, t);
    }
  });

  it("the criteria engine's trips_completed metric is the evidenced count", async () => {
    const db = makeDB({
      trips: [completed("t1"), completed("t2"), completed("t3"), completed("t4"), completed("t5")],
      plan_checkins: [arrival(OWNER, "t1")],
    });
    assert.equal(await resolveMetric(makeClient(db) as any, OWNER, "trips_completed", {}), 1);
  });
});

// ── The route ────────────────────────────────────────────────────────────────

describe("PATCH /api/trips/:tripId — a calendar completion awards only evidenced members", () => {
  let server: ReturnType<typeof createServer>;
  let base = "";
  const SETTLE_MS = 300;

  before(async () => {
    const { default: tripsRouter } = await import("../routes/trips.js");
    const app = express();
    app.use(express.json());
    app.use("/api", tripsRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  });
  after(() => { server.close(); });

  async function patch(db: DB, failing?: ReadonlySet<string>) {
    _setTestClient(makeClient(db, failing) as any, true);
    const res = await fetch(`${base}/trips/${TRIP}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer t-${OWNER}` },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200, await res.text());
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }

  it("a trip nobody checked in on completes, and NOBODY earns a completion stamp", async () => {
    const db = makeDB();
    await patch(db);
    assert.equal(db.trips[0].status, "completed", "the trip itself still completes");
    assert.deepEqual(db.user_stamps, [], "no 'first trip completed, Paris, France' for a plan");
    assert.deepEqual(db.stamp_award_events, []);
  });

  it("the owner checked in, the member did not: only the owner earns, with the place", async () => {
    const db = makeDB({ plan_checkins: [arrival(OWNER), arrival(MEMBER, TRIP, "on_the_way")] });
    await patch(db);
    assert.deepEqual(slugsOf(db, MEMBER), [], "membership is intent, not a visit");
    const owner = slugsOf(db, OWNER);
    assert.ok(owner.includes("first_trip_completed"), owner.join(","));
    assert.ok(owner.includes("good_host"), "two accepted members: the owner hosted");
    for (const s of db.user_stamps) {
      assert.equal(s.user_id, OWNER);
      assert.equal(s.city, "Paris");
      assert.equal(s.country, "France");
    }
  });

  it("a member's check-in on ANOTHER trip is not evidence for this one", async () => {
    const db = makeDB({ plan_checkins: [arrival(OWNER), arrival(MEMBER, OTHER_TRIP)] });
    await patch(db);
    assert.deepEqual(slugsOf(db, MEMBER), []);
  });

  it("a verified stamp tied to this trip is evidence for the member", async () => {
    const db = makeDB({
      plan_checkins: [arrival(OWNER)],
      passport_stamps: [{ trip_id: TRIP, user_id: MEMBER, verification_level: "checkin" }],
    });
    await patch(db);
    assert.ok(slugsOf(db, MEMBER).includes("first_trip_completed"));
  });

  it("an unreadable check-in table awards nobody it would have shown present", async () => {
    const db = makeDB({ plan_checkins: [arrival(OWNER), arrival(MEMBER)] });
    await patch(db, new Set(["plan_checkins"]));
    assert.deepEqual(db.user_stamps, []);
  });

  it("road_warrior counts evidenced trips: five completed, one taken, no milestone", async () => {
    const others = ["t1", "t2", "t3", "t4"].map((id) => ({ id, owner_id: OWNER, status: "completed" }));
    const db = makeDB({ plan_checkins: [arrival(OWNER)] });
    db.trips.push(...others);
    await patch(db);
    const owner = slugsOf(db, OWNER);
    assert.ok(owner.includes("first_trip_completed"));
    assert.ok(!owner.includes("road_warrior"), "four calendar completions are not four trips");
  });

  it("road_warrior: five completed and five taken is the milestone (positive control)", async () => {
    const others = ["t1", "t2", "t3", "t4"].map((id) => ({ id, owner_id: OWNER, status: "completed" }));
    const db = makeDB({ plan_checkins: [arrival(OWNER), ...others.map((t) => arrival(OWNER, t.id))] });
    db.trips.push(...others);
    await patch(db);
    assert.ok(slugsOf(db, OWNER).includes("road_warrior"));
  });
});
