/**
 * census-discovery §111 (DV-83 round 14, lane W11-X2, sweep, D-W11X2-117): Compass's presence walk never
 * states "nobody is sharing" — or a list of people as everyone — over a walk it cut short.
 *
 * `getWhosAround` and `getMeetupOpportunities` walk the viewer's contexts: `activeContexts` keeps the first
 * three trips of an UNORDERED read, the first three going events (`.limit(3)`) and then the first five of
 * those contexts; each context checks its first twenty members; and the result keeps twenty people. Nothing
 * marked a cut, so `get_whos_around` said "Nobody in the user's circles is sharing their presence right
 * now." while a friend on the fourth trip was sharing, and served the people of three trips as the people
 * around. The walk now marks every cut (`truncated`), and the tools say only some of the circles were
 * checked.
 *
 *   PW1  four trips, the one sharing friend on the fourth → never "Nobody in the user's circles is sharing"
 *   PW2  four trips, a friend sharing on the first and one on the fourth → the list is said not to be everyone
 *   PW3  four going events, nobody sharing on the three checked → never "nobody"
 *   PW4  three trips and three events (six contexts, five checked) → never "nobody"
 *   PW5  one trip with 21 other members, none sharing among the first twenty → never "nobody"
 *   PW6  22 people sharing across two trips → twenty served, said not to be everyone
 *   MO1  get_meetup_opportunities over four trips, nobody sharing on the three checked → never "nobody"
 *   TC1  check_trip_conflicts: 21 planned items on the overlapping trip → the items are said not to be all of them
 *   TCc  CONTROL: 20 planned items → no such line (D-W11X2-119)
 *   MO3  22 occasions → twenty served, said not to be all
 *   MO2  a meetup found beside a cut walk → the occasions are said not to be all (MO2c its control)
 *   PWc  CONTROL: three trips, nobody sharing → "Nobody …" stands; one trip, a friend sharing → the old info
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const trip = (i: number) => `eeee0000-eeee-eeee-eeee-0000000000${String(i).padStart(2, "0")}`;
const event = (i: number) => `ffff0000-ffff-ffff-ffff-0000000000${String(i).padStart(2, "0")}`;
const user = (i: number) => `b${String(i).padStart(7, "0")}-bbbb-bbbb-bbbb-000000000000`;
const profile = { userId: ALICE, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
const NOBODY = "Nobody in the user's circles is sharing their presence right now.";
const NOBODY_MEETUP = "Nobody in the user's circles is sharing a current presence to build a meetup on.";
const OLD_INFO = "Only people who opted in to sharing appear, at the granularity they chose. Location is approximate only — never precise.";
const SOME = /only some of the user's (trips|circles)/i;

type Db = Record<string, any[]>;
function makeClient(db: Db) {
  function builder(rows: any[]) {
    let filtered = [...rows];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in: (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      is: () => b, or: () => b, not: () => b, order: () => b, like: () => b, ilike: () => b,
      gte: (col: string, val: any) => { filtered = filtered.filter((r) => String(r[col] ?? "") >= String(val)); return b; },
      lte: () => b, gt: () => b, lt: () => b,
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any, reject?: any) => Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
    };
    return b;
  }
  return { from: (table: string) => builder(db[table] ?? []), rpc: () => Promise.resolve({ data: null, error: null }) } as any;
}
const sharingOn = (userId: string) => ({ user_id: userId, global_enabled: true, visibility_mode: "status_only", trip_sharing_default: "approximate_area", event_sharing_default: "status_only", is_paused: false, consent_version: "v1", consented_at: "2026-07-01T00:00:00Z" });
const presence = (userId: string, ctxType: "trip" | "event", ctxId: string) => ({ user_id: userId, context_type: ctxType, context_id: ctxId, status: "arrived", status_label: null, approximate_label: "Old town", venue_label: null, checked_in: false, last_seen_at: new Date().toISOString(), expires_at: null, stale_after_secs: 3600, is_stale: false, needs_help: false, updated_at: new Date().toISOString() });

/** Alice on `trips` active trips, each with `membersPer` other members; `sharing` lists [tripIndex, memberIndex] pairs sharing presence. */
function world(o: { trips?: number; membersPer?: number; sharing?: Array<[number, number]>; events?: number; eventSharing?: Array<[number, number]> }): Db {
  const db: Db = { trips: [], trip_members: [], profiles: [], circle_visibility_settings: [], circle_presence: [], circle_context_settings: [], events: [], event_rsvps: [], event_attendees: [], blocks: [], user_account_states: [], feature_flags: [], profile_privacy_settings: [] };
  const soon = new Date(Date.now() + 3600_000).toISOString();
  for (let t = 1; t <= (o.trips ?? 0); t++) {
    db.trips.push({ id: trip(t), title: `Trip ${t}`, destination_city: "Porto", status: "active" });
    db.trip_members.push({ trip_id: trip(t), user_id: ALICE, role: "owner", status: "accepted" });
    for (let m = 1; m <= (o.membersPer ?? 1); m++) db.trip_members.push({ trip_id: trip(t), user_id: user(t * 100 + m), role: "member", status: "accepted" });
  }
  for (let e = 1; e <= (o.events ?? 0); e++) {
    db.events.push({ id: event(e), title: `Event ${e}`, starts_at: soon });
    db.event_rsvps.push({ event_id: event(e), user_id: ALICE, status: "going" }, { event_id: event(e), user_id: user(9000 + e), status: "going" });
    db.event_attendees.push({ event_id: event(e), user_id: ALICE }, { event_id: event(e), user_id: user(9000 + e) });
  }
  for (const [t, m] of o.sharing ?? []) { db.circle_visibility_settings.push(sharingOn(user(t * 100 + m))); db.circle_presence.push(presence(user(t * 100 + m), "trip", trip(t))); }
  for (const [e] of o.eventSharing ?? []) { db.circle_visibility_settings.push(sharingOn(user(9000 + e))); db.circle_presence.push(presence(user(9000 + e), "event", event(e))); }
  for (const r of db.trip_members) db.profiles.push({ id: r.user_id, handle: `h${r.user_id.slice(1, 8)}` });
  return db;
}
const whos = async (db: Db) => (await executeCompassTool(makeClient(db), ALICE, profile, "get_whos_around", {})) as { people: any[]; info: string };
const meet = async (db: Db) => (await executeCompassTool(makeClient(db), ALICE, profile, "get_meetup_opportunities", {})) as { opportunities: any[]; info: string };

describe("get_whos_around over a presence walk it cut short (§111, D-W11X2-117)", () => {
  it("PWc CONTROL: three trips, nobody sharing → 'Nobody …' stands; one trip, a friend sharing → the old info", async () => {
    const none = await whos(world({ trips: 3 }));
    assert.equal(none.info, NOBODY, JSON.stringify(none));
    const one = await whos(world({ trips: 1, sharing: [[1, 1]] }));
    assert.equal(one.people.length, 1, JSON.stringify(one));
    assert.equal(one.info, OLD_INFO, JSON.stringify(one));
  });
  it("PW1 four trips, the one sharing friend on the fourth → never 'Nobody … is sharing'", async () => {
    const r = await whos(world({ trips: 4, sharing: [[4, 1]] }));
    assert.notEqual(r.info, NOBODY, `a walk cut at three trips said nobody is sharing: ${JSON.stringify(r)}`);
    assert.match(r.info, SOME, JSON.stringify(r));
  });
  it("PW2 four trips, friends sharing on the first and the fourth → the list is said not to be everyone", async () => {
    const r = await whos(world({ trips: 4, sharing: [[1, 1], [4, 1]] }));
    assert.equal(r.people.length, 1, JSON.stringify(r));
    assert.match(r.info, SOME, JSON.stringify(r));
  });
  it("PW3 four going events, nobody sharing on the three checked → never 'nobody'", async () => {
    const r = await whos(world({ events: 4, eventSharing: [[4, 1]] }));
    assert.notEqual(r.info, NOBODY, JSON.stringify(r));
    assert.match(r.info, SOME, JSON.stringify(r));
  });
  it("PW4 three trips and three events — six contexts, five checked → never 'nobody'", async () => {
    const r = await whos(world({ trips: 3, events: 3 }));
    assert.notEqual(r.info, NOBODY, JSON.stringify(r));
    assert.match(r.info, SOME, JSON.stringify(r));
  });
  it("PW5 one trip with 21 other members, none sharing among the first twenty → never 'nobody'", async () => {
    const r = await whos(world({ trips: 1, membersPer: 21, sharing: [[1, 21]] }));
    assert.notEqual(r.info, NOBODY, JSON.stringify(r));
    assert.match(r.info, SOME, JSON.stringify(r));
  });
  it("PW6 22 people sharing across two trips → twenty served, said not to be everyone", async () => {
    const sharing: Array<[number, number]> = [];
    for (let m = 1; m <= 11; m++) sharing.push([1, m], [2, m]);
    const r = await whos(world({ trips: 2, membersPer: 11, sharing }));
    assert.equal(r.people.length, 20, JSON.stringify(r.people.length));
    assert.match(r.info, SOME, r.info);
  });
});

describe("get_meetup_opportunities over a presence walk it cut short (§111, D-W11X2-117)", () => {
  it("MO1 four trips, nobody sharing on the three checked → never 'nobody'", async () => {
    const r = await meet(world({ trips: 4, sharing: [[4, 1]] }));
    assert.notEqual(r.info, NOBODY_MEETUP, JSON.stringify(r));
    assert.match(r.info, SOME, JSON.stringify(r));
  });
  it("MO2 four trips, a meetup on the first and a friend sharing on the fourth → the occasions are said not to be all", async () => {
    const db = world({ trips: 4, sharing: [[1, 1], [4, 1]] });
    db.circle_visibility_settings.push(sharingOn(ALICE)); db.circle_presence.push(presence(ALICE, "trip", trip(1)));
    const r = await meet(db);
    assert.ok(r.opportunities.length > 0, JSON.stringify(r));
    assert.match(r.info, SOME, JSON.stringify(r));
  });
  it("MO3 22 occasions across two trips → twenty served, said not to be all", async () => {
    const sharing: Array<[number, number]> = [];
    for (let m = 1; m <= 11; m++) sharing.push([1, m], [2, m]);
    const db = world({ trips: 2, membersPer: 11, sharing });
    db.circle_visibility_settings.push(sharingOn(ALICE)); db.circle_presence.push(presence(ALICE, "trip", trip(1)), presence(ALICE, "trip", trip(2)));
    const r = await meet(db);
    assert.equal(r.opportunities.length, 20, JSON.stringify(r.opportunities.length));
    assert.match(r.info, SOME, r.info);
  });
  it("MO2c CONTROL: one trip, the same meetup → the old info", async () => {
    const db = world({ trips: 1, sharing: [[1, 1]] });
    db.circle_visibility_settings.push(sharingOn(ALICE)); db.circle_presence.push(presence(ALICE, "trip", trip(1)));
    const r = await meet(db);
    assert.ok(r.opportunities.length > 0, JSON.stringify(r));
    assert.doesNotMatch(r.info, SOME, JSON.stringify(r));
  });
  it("MOc CONTROL: three trips, nobody sharing → 'Nobody …' stands", async () => {
    const r = await meet(world({ trips: 3 }));
    assert.equal(r.info, NOBODY_MEETUP, JSON.stringify(r));
  });
});

// ── D-W11X2-119: check_trip_conflicts' planned-items read, an unordered `.limit(20)` served as the plan ──
describe("check_trip_conflicts over its capped planned-items read (§111, D-W11X2-119)", () => {
  const T = "eeee0000-eeee-eeee-eeee-0000000000aa";
  const conflictsWorld = (items: number): Db => ({
    trips: [{ id: T, owner_id: ALICE, title: "Porto trip", destination_city: "Porto", start_date: "2026-08-01", end_date: "2026-08-07", status: "upcoming" }],
    trip_members: [], plan_editors: [],
    trip_plan_items: Array.from({ length: items }, (_, i) => ({ trip_id: T, title: `Item ${i}`, day_date: `2026-08-0${2 + (i % 4)}`, removed_at: null })),
  });
  const conflicts = async (db: Db) => (await executeCompassTool(makeClient(db), ALICE, profile, "check_trip_conflicts", { startDate: "2026-08-02", endDate: "2026-08-05" })) as { conflicts: any[]; plannedItems: any[]; info?: string };
  it("TCc CONTROL: 20 planned items → all listed, no 'not all' line", async () => {
    const r = await conflicts(conflictsWorld(20));
    assert.equal(r.conflicts.length, 1, JSON.stringify(r));
    assert.equal(r.plannedItems.length, 20);
    assert.equal(r.info, undefined, JSON.stringify(r.info));
  });
  it("TC1 21 planned items → twenty listed, and the items are said not to be all of them", async () => {
    const r = await conflicts(conflictsWorld(21));
    assert.equal(r.plannedItems.length, 20, JSON.stringify(r.plannedItems.length));
    assert.match(String(r.info), /not all of the planned items/i, JSON.stringify(r.info));
  });
});

