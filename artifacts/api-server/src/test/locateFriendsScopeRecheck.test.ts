/**
 * census-map M93 (independent verifier, 2026-10-24) — Locate Friends re-checks the GROUP on every read and
 * publish, not only at join.
 *
 * Group-scope membership (trip, circle, event, plan) was verified only when a person joined, so someone
 * removed from the trip kept reading the session's live positions until they left or it ended (up to 12 h).
 * Latent in production (0 sessions on 2026-10-24).
 *
 *   S1  a viewer removed from the trip reads nothing
 *   S2  a member removed from the trip cannot publish
 *   S3  an unreadable scope serves nobody and accepts nothing (fail closed)
 *   S4  a member removed from the trip is not served to those still in it
 *   S5  CONTROL: members still in the trip read each other and publish
 *   S6  the route wires the re-check (LOCATE_READ_DEPS carries routes/locateFriends.ts verifyScopeMembership)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MEMBERS_TABLE, POSITIONS_TABLE, POSITION_TTL_MS, SESSIONS_TABLE, readSessionForViewer,
  type PositionRow, type SessionRow,
} from "../lib/locateFriendsSession.js";
import { LOCATE_READ_DEPS, publishPosition } from "../routes/locateFriends.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "11111111-1111-4111-8111-111111111112";
const CAROL = "11111111-1111-4111-8111-111111111113";
const TRIP = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

// ── Fake supabase client ──────────────────────────────────────────────────────
//
// Filters are applied generically rather than special-cased per caller, so a
// query the code did not anticipate cannot accidentally be answered correctly.

interface FakeOpts {
  sessions?: Partial<SessionRow>[];
  members?: Array<Record<string, unknown>>;
  positions?: Array<Partial<PositionRow>>;
  profiles?: Array<{ id: string; display_name: string | null }>;
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  protectedZones?: Array<Record<string, unknown>>;
  trips?: Array<{ id: string; owner_id: string }>;
  tripMembers?: Array<{ trip_id: string; user_id: string; role: string }>;
  circles?: Array<{ id: string; owner_id: string }>;
  circleMemberships?: Array<{ user_id: string; other_id: string; status?: string }>;
  routePlans?: Array<{ id: string; owner_user_id: string }>;
  routePlanMembers?: Array<{ route_plan_id: string; user_id: string }>;
  flags?: Record<string, boolean>;
  /** Tables whose reads must fail, to prove the fail-closed branches. */
  failReads?: string[];
}

function makeDb(opts: FakeOpts = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: Object.entries(opts.flags ?? { locate_friends_enabled: true }).map(
      ([flag, enabled]) => ({ flag, enabled }),
    ),
    [SESSIONS_TABLE]: (opts.sessions ?? []).map((s) => ({ ...s })),
    [MEMBERS_TABLE]: (opts.members ?? []).map((m) => ({ ...m })),
    [POSITIONS_TABLE]: (opts.positions ?? []).map((p) => ({ ...p })),
    profiles: (opts.profiles ?? []).map((p) => ({ ...p })),
    blocks: (opts.blocks ?? []).map((b) => ({ ...b })),
    protected_zones: (opts.protectedZones ?? []).map((z) => ({ ...z })),
    trips: (opts.trips ?? []).map((t) => ({ ...t })),
    trip_members: (opts.tripMembers ?? []).map((t) => ({ ...t })),
    circles: (opts.circles ?? []).map((c) => ({ ...c })),
    circle_memberships: (opts.circleMemberships ?? []).map((c) => ({ ...c })),
    route_plans: (opts.routePlans ?? []).map((p) => ({ ...p })),
    route_plan_members: (opts.routePlanMembers ?? []).map((p) => ({ ...p })),
    event_rsvps: [],
    locate_friends_audit: [],
  };
  const failReads = new Set(opts.failReads ?? []);
  const writes: Record<string, number> = {};
  let seq = 0;

  function from(table: string) {
    let op: "select" | "insert" | "insert_select" | "update" | "upsert" | "delete" = "select";
    let payload: any = null;
    let orFilter: string | null = null;
    const filters: Array<{ col: string; val: any; kind: string }> = [];

    const match = (row: any) => {
      if (orFilter) {
        // fetchBlockedSet's `blocker_id.eq.X,blocked_id.eq.X`.
        const clauses = orFilter.split(",").map((c) => c.split("."));
        return clauses.some(([col, , val]) => row[col] === val);
      }
      return filters.every((f) => {
        const cell = row[f.col];
        switch (f.kind) {
          case "in": return (f.val as any[]).includes(cell);
          case "is": return (cell ?? null) === f.val;
          default: return cell === f.val;
        }
      });
    };

    function run(): { data: any; error: any } {
      const store = tables[table] ?? (tables[table] = []);
      if (failReads.has(table)) return { data: null, error: { message: `read failed: ${table}` } };

      if (op === "insert" || op === "insert_select") {
        const row = { id: `${table}-${++seq}`, ...payload };
        store.push(row);
        writes[table] = (writes[table] ?? 0) + 1;
        return { data: op === "insert_select" ? row : null, error: null };
      }
      if (op === "upsert") {
        const key = payload.session_id != null && payload.user_id != null
          ? (r: any) => r.session_id === payload.session_id && r.user_id === payload.user_id
          : (r: any) => r.id === payload.id;
        const existing = store.find(key);
        if (existing) Object.assign(existing, payload);
        else store.push({ ...payload });
        writes[table] = (writes[table] ?? 0) + 1;
        return { data: null, error: null };
      }
      if (op === "update") {
        for (const r of store) if (match(r)) Object.assign(r, payload);
        writes[table] = (writes[table] ?? 0) + 1;
        return { data: null, error: null };
      }
      if (op === "delete") {
        for (let i = store.length - 1; i >= 0; i--) if (match(store[i])) store.splice(i, 1);
        writes[table] = (writes[table] ?? 0) + 1;
        return { data: null, error: null };
      }
      return { data: store.filter(match), error: null };
    }

    const first = () => {
      const r = run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    };

    const b: any = {
      select() {
        op = op === "insert" ? "insert_select" : op;
        return b;
      },
      insert(row: any) { op = "insert"; payload = row; return b; },
      upsert(row: any) { op = "upsert"; payload = row; return b; },
      update(patch: any) { op = "update"; payload = patch; return b; },
      delete() { op = "delete"; return b; },
      eq(col: string, val: any) { filters.push({ col, val, kind: "eq" }); return b; },
      in(col: string, val: any[]) { filters.push({ col, val, kind: "in" }); return b; },
      is(col: string, val: any) { filters.push({ col, val, kind: "is" }); return b; },
      or(expr: string) { orFilter = expr; return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return Promise.resolve(first()); },
      single() { return Promise.resolve(first()); },
      then(resolve: (r: any) => any) { return Promise.resolve(run()).then(resolve); },
    };
    return b;
  }

  return { from, _tables: tables, _writes: writes };
}

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: SESSION,
  group_scope_kind: "trip",
  group_scope_id: TRIP,
  created_by: ALICE,
  started_at: iso(NOW - 60_000),
  expires_at: iso(NOW + 60 * 60_000),
  ended_at: null,
  ceiling: "precise",
  label: null,
  ...over,
});

const member = (userId: string, over: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  user_id: userId,
  opted_in_at: iso(NOW - 60_000),
  consent_source: "group_join",
  left_at: null,
  ...over,
});

const position = (userId: string, over: Partial<PositionRow> = {}): Partial<PositionRow> => ({
  session_id: SESSION,
  user_id: userId,
  rung: "network_location",
  precision: "precise",
  lat: 16.0544,
  lng: 108.2022,
  proximity_bucket: null,
  checkpoint_label: null,
  observed_at: iso(NOW - 30_000),
  expires_at: iso(NOW + POSITION_TTL_MS),
  ...over,
});

const pub = (db: any, who: string) => publishPosition(db, who, SESSION, { rung: "network_location", precision: "precise", lat: 16.05, lng: 108.2, observedAt: NOW }, NOW);
// ALICE owns the trip; BOB and CAROL joined the session as trip members.
const world = (over: Record<string, unknown> = {}) => makeDb({
  sessions: [session()],
  members: [member(ALICE), member(BOB), member(CAROL)],
  positions: [position(ALICE), position(BOB), position(CAROL)],
  profiles: [{ id: ALICE, display_name: "Alice" }, { id: BOB, display_name: "Bob" }, { id: CAROL, display_name: "Carol" }],
  trips: [{ id: TRIP, owner_id: ALICE }],
  tripMembers: [{ trip_id: TRIP, user_id: BOB, role: "member" }, { trip_id: TRIP, user_id: CAROL, role: "member" }],
  ...over,
});

describe("census-map M93 — the group is re-checked on every read and publish", () => {
  it("S5 CONTROL: members still in the trip read each other and publish", async () => {
    const db = world();
    const r = await readSessionForViewer(db as any, SESSION, BOB, NOW, LOCATE_READ_DEPS);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.members.map((m: any) => m.memberId).sort(), [ALICE, CAROL].sort());
    assert.equal((await pub(db, BOB)).ok, true);
  });

  it("S1 a viewer removed from the trip reads nothing", async () => {
    const db = world({ tripMembers: [{ trip_id: TRIP, user_id: CAROL, role: "member" }] }); // BOB removed
    const r = await readSessionForViewer(db as any, SESSION, BOB, NOW, LOCATE_READ_DEPS);
    assert.equal(r.status, "not_member");
    assert.deepEqual(r.members, []);
    assert.equal(r.session, null);
  });

  it("S2 a member removed from the trip cannot publish, and nothing is written", async () => {
    const db = world({ tripMembers: [{ trip_id: TRIP, user_id: CAROL, role: "member" }], positions: [] });
    const out = await pub(db, BOB);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.code, "forbidden");
    assert.equal(db._tables[POSITIONS_TABLE].length, 0);
  });

  it("S3 an unreadable scope serves nobody and accepts nothing", async () => {
    const db = world({ failReads: ["trip_members"], positions: [position(ALICE)] });
    const r = await readSessionForViewer(db as any, SESSION, BOB, NOW, LOCATE_READ_DEPS);
    assert.equal(r.status, "not_member", "BOB cannot be vouched for");
    assert.deepEqual(r.members, []);
    const out = await pub(db, BOB);
    assert.equal(out.ok, false);
    assert.equal(db._tables[POSITIONS_TABLE].length, 1, "only the seeded row; nothing written");
    const owner = await readSessionForViewer(db as any, SESSION, ALICE, NOW, LOCATE_READ_DEPS);
    assert.equal(owner.status, "ok", "the trip OWNER is vouched for by the trips row alone");
    assert.deepEqual(owner.members, [], "no member who cannot be vouched for is served");
  });

  it("S4 a member removed from the trip is not served to those still in it", async () => {
    const db = world({ tripMembers: [{ trip_id: TRIP, user_id: CAROL, role: "member" }] }); // BOB removed
    const r = await readSessionForViewer(db as any, SESSION, CAROL, NOW, LOCATE_READ_DEPS);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.members.map((m: any) => m.memberId), [ALICE]);
  });

  it("S6 the route wires the re-check", async () => {
    assert.equal(typeof LOCATE_READ_DEPS.scopeMember, "function");
    const db = world({ tripMembers: [] });
    assert.equal(await LOCATE_READ_DEPS.scopeMember!(db as any, "trip", TRIP, BOB), false);
    assert.equal(await LOCATE_READ_DEPS.scopeMember!(db as any, "trip", TRIP, ALICE), true);
    assert.equal(await LOCATE_READ_DEPS.scopeMember!(db as any, "unknown_kind", TRIP, ALICE), false, "a kind with no verifier refuses");
  });
});
