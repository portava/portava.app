/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's residual, D-W11X2-172): Compass's presence
 * walk never answers an event's members from a read the server cut at its row cap.
 *
 * contextMemberIds reads an event's going RSVPs and its checked-in attendees in one unbounded read each and keeps the
 * travellers in both. PostgREST caps every answer at 1000 rows and says nothing, so at an event with more than 1000
 * going, the checked-in travellers whose RSVPs fell past the cap were dropped, and `get_whos_around` said "Nobody in the
 * user's circles is sharing their presence right now." over a friend sharing at that event. Each read now asks for the
 * exact count; a read the server cut (fewer rows than the count) is read whole, paged by key (lib/pagedRead).
 *
 *   CM0 CONTROL: one event, 3 other going, the one checked-in friend sharing → listed
 *   CM1 1001 other going, the checked-in friend's RSVP past the 1000-row cap → listed, never "Nobody …"
 *   CM2 1001 checked-in attendees, the friend's attendee row past the cap → listed
 *   CM3 a server whose count is unknown (no count) → the one read, as before (CM0's world)
 *   CM4 the paged read FAILS on its second page → the walk says it could not check, never "Nobody …"
 *
 * Harness: compassPresenceWalkBounds' world and gate tables, its double given PostgREST's 1000-row cap, the exact count,
 * `.order()`, `.gt()` and `.range()`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const EVENT = "ffff0000-ffff-ffff-ffff-000000000001";
const FRIEND = "b0009001-bbbb-bbbb-bbbb-000000000000";
const filler = (i: number) => `c${String(i).padStart(7, "0")}-cccc-cccc-cccc-000000000000`;
const profile = { userId: ALICE, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
const NOBODY = "Nobody in the user's circles is sharing their presence right now.";
const CAP = 1000;

type Db = Record<string, any[]>;
function makeClient(db: Db, o: { noCount?: boolean; failSecondPage?: string } = {}) {
  const pages: Record<string, number> = {};
  function builder(table: string, rows: any[]) {
    let filtered = [...rows]; let counted = false; let orderCol: string | null = null; let rng: [number, number] | null = null; let lim: number | null = null;
    const b: any = {
      select: (_c?: string, opts?: { count?: string }) => { counted = opts?.count === "exact"; return b; },
      eq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in: (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      is: () => b, or: () => b, not: () => b, like: () => b, ilike: () => b,
      order: (col: string) => { orderCol = col; return b; },
      gt: (col: string, val: any) => { filtered = filtered.filter((r) => String(r[col] ?? "") > String(val)); return b; },
      gte: (col: string, val: any) => { filtered = filtered.filter((r) => String(r[col] ?? "") >= String(val)); return b; },
      lte: () => b, lt: () => b,
      range: (a: number, z: number) => { rng = [a, z]; return b; },
      limit: (n: number) => { lim = n; return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any, reject?: any) => {
        let out = orderCol ? [...filtered].sort((x, y) => (String(x[orderCol!]) < String(y[orderCol!]) ? -1 : String(x[orderCol!]) > String(y[orderCol!]) ? 1 : 0)) : [...filtered];
        const total = out.length;
        if (rng) out = out.slice(rng[0], rng[1] + 1);
        if (lim !== null) out = out.slice(0, lim);
        out = out.slice(0, CAP);  // PostgREST's db-max-rows: a capped answer looks like a whole one
        if (rng) { pages[table] = (pages[table] ?? 0) + 1; if (o.failSecondPage === table && pages[table] === 2) return Promise.resolve({ data: null, error: { message: "canceling statement due to statement timeout" } }).then(resolve, reject); }
        return Promise.resolve({ data: out, error: null, ...(counted && !o.noCount ? { count: total } : {}) }).then(resolve, reject);
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table, db[table] ?? []), rpc: () => Promise.resolve({ data: null, error: null }) } as any;
}
const sharingOn = (userId: string) => ({ user_id: userId, global_enabled: true, visibility_mode: "status_only", trip_sharing_default: "approximate_area", event_sharing_default: "status_only", is_paused: false, consent_version: "v1", consented_at: "2026-07-01T00:00:00Z" });
const presence = (userId: string) => ({ user_id: userId, context_type: "event", context_id: EVENT, status: "arrived", status_label: null, approximate_label: "Old town", venue_label: null, checked_in: false, last_seen_at: new Date().toISOString(), expires_at: null, stale_after_secs: 3600, is_stale: false, needs_help: false, updated_at: new Date().toISOString() });

/** Alice and FRIEND going to EVENT and checked in, FRIEND sharing; `goingFillers` more going (not checked in) and `attendeeFillers` more checked in (not going), each placed BEFORE FRIEND's row. */
function world(o: { goingFillers?: number; attendeeFillers?: number }): Db {
  const db: Db = { trips: [], trip_members: [], profiles: [], circle_visibility_settings: [sharingOn(FRIEND)], circle_presence: [presence(FRIEND)], circle_context_settings: [], events: [{ id: EVENT, title: "Rooftop quiz", starts_at: new Date(Date.now() + 3600_000).toISOString() }], event_rsvps: [], event_attendees: [], blocks: [], user_account_states: [], feature_flags: [], profile_privacy_settings: [] };
  db.event_rsvps.push({ event_id: EVENT, user_id: ALICE, status: "going" });
  for (let i = 0; i < (o.goingFillers ?? 0); i++) db.event_rsvps.push({ event_id: EVENT, user_id: filler(i), status: "going" });
  db.event_rsvps.push({ event_id: EVENT, user_id: FRIEND, status: "going" });
  db.event_attendees.push({ event_id: EVENT, user_id: ALICE });
  for (let i = 0; i < (o.attendeeFillers ?? 0); i++) db.event_attendees.push({ event_id: EVENT, user_id: filler(i) });
  db.event_attendees.push({ event_id: EVENT, user_id: FRIEND });
  db.profiles.push({ id: FRIEND, handle: "friend" });
  return db;
}
const whos = async (db: Db, o: Parameters<typeof makeClient>[1] = {}) => (await executeCompassTool(makeClient(db, o), ALICE, profile, "get_whos_around", {})) as { people: any[]; info: string };

describe("census-discovery §119 (residual, D-W11X2-172): the presence walk reads an event's members whole", () => {
  it("CM0 CONTROL: 3 other going, the checked-in friend sharing → listed", async () => {
    const r = await whos(world({ goingFillers: 3 }));
    assert.equal(r.people.length, 1, JSON.stringify(r));
  });
  it("CM1 1001 other going, the friend's RSVP past the row cap → listed, never 'Nobody …'", async () => {
    const r = await whos(world({ goingFillers: 1001 }));
    assert.notEqual(r.info, NOBODY, JSON.stringify(r));
    assert.equal(r.people.length, 1, JSON.stringify(r));
  });
  it("CM2 1001 other checked in, the friend's attendee row past the row cap → listed", async () => {
    const r = await whos(world({ attendeeFillers: 1001 }));
    assert.equal(r.people.length, 1, JSON.stringify(r));
  });
  it("CM3 a server that answers no count → the one read, as before", async () => {
    const r = await whos(world({ goingFillers: 3 }), { noCount: true });
    assert.equal(r.people.length, 1, JSON.stringify(r));
  });
  it("CM4 the paged read FAILS on its second page → never 'Nobody …'", async () => {
    const r = await whos(world({ goingFillers: 1001 }), { failSecondPage: "event_rsvps" });
    assert.notEqual(r.info, NOBODY, JSON.stringify(r));
  });
});
