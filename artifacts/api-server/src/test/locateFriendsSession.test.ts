/**
 * Locate My Friends (Map spec §12) — the constraints, in the order they would hurt.
 *
 * §37 names the two shapes this feature must never take:
 *
 *     "Do not build a public real-time people tracker."
 *     "Do not create permanent exact-location sharing."
 *
 * so these tests are not about storage mechanics. They are about the five ways
 * a temporary group-location surface becomes one of those two things:
 *
 *   1. a session gets created with no end,
 *   2. an expired session keeps answering because the sweeper is late,
 *   3. precision widens somewhere along the pipeline,
 *   4. leaving takes effect at the next sweep instead of at once,
 *   5. someone who is not a member is served anyway.
 *
 * Everything runs in memory against a fake supabase client shaped like the one
 * in mapObservations.test.ts. Nothing on the path under test is mocked:
 * `validateSessionRequest`, `projectMember`, `readSessionForViewer`,
 * `leaveSession`, `positionRowFor` and `publishPosition` are the shipping
 * implementations, and so are `fetchBlockedSet` and `classifyAgainstProtected`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DECAY_BOUNDARIES_MS,
  DECAY_STAGES,
  DECAY_STAGE_CEILING,
  DEFAULT_SESSION_CEILING,
  GROUP_SCOPE_KINDS,
  LOCATE_FRIENDS_FEATURE_CEILING,
  LOCATE_SIGNAL_RUNGS,
  MAX_SESSION_MINUTES,
  MEMBERS_TABLE,
  POSITIONS_TABLE,
  POSITION_TTL_MS,
  RING_RADIUS_METERS,
  RUNG_PRECISION_CEILING,
  SESSIONS_TABLE,
  coarsenToRing,
  decayStageAt,
  estimateStateFor,
  exposeGeometry,
  isSessionActive,
  leaveSession,
  narrowestOfPrecisions,
  positionRowFor,
  projectMember,
  readSessionForViewer,
  storedPrecisionFor,
  validateSessionRequest,
  type PositionRow,
  type SessionRow,
} from "../lib/locateFriendsSession.js";
import {
  publishPosition,
  startOrJoinSession,
  verifyScopeMembership,
} from "../routes/locateFriends.js";
import {
  FEATURE_PRECISION_CEILING,
  PRECISION_LADDER,
  isLiveState,
  precisionRank,
  type LocationPrecision,
} from "../presence/domain/types.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "11111111-1111-4111-8111-111111111112";
const CAROL = "11111111-1111-4111-8111-111111111113";
const STRANGER = "11111111-1111-4111-8111-1111111111ff";
const TRIP = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
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

// ══ A. §12 "Temporary and auto-expiring" ═════════════════════════════════════

describe("(a) an unbounded session cannot be created", () => {
  it("REJECTS a request with no ttlMinutes at all — there is no default", () => {
    const r = validateSessionRequest(
      { groupScopeKind: "trip", groupScopeId: TRIP, ttlMinutes: undefined },
      NOW,
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "missing_ttl");
  });

  it("REJECTS every shape that could mean 'forever'", () => {
    const forever = [null, 0, -1, Infinity, -Infinity, NaN, "60", "", {}, [], true];
    for (const ttl of forever) {
      const r = validateSessionRequest(
        { groupScopeKind: "trip", groupScopeId: TRIP, ttlMinutes: ttl },
        NOW,
      );
      assert.equal(r.ok, false, `ttlMinutes=${String(ttl)} must be rejected, not defaulted`);
    }
  });

  it("REJECTS a TTL past the cap rather than clamping it down", () => {
    // Clamping would be the quiet failure: the caller believes it got 30 days.
    const r = validateSessionRequest(
      { groupScopeKind: "trip", groupScopeId: TRIP, ttlMinutes: MAX_SESSION_MINUTES + 1 },
      NOW,
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "ttl_exceeds_maximum");
  });

  it("accepts exactly the cap, and the window it produces is bounded", () => {
    const r = validateSessionRequest(
      { groupScopeKind: "trip", groupScopeId: TRIP, ttlMinutes: MAX_SESSION_MINUTES },
      NOW,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.expiresAtMs - r.value.startedAtMs, MAX_SESSION_MINUTES * 60_000);
      assert.equal(MAX_SESSION_MINUTES, 12 * 60, "the cap is 12 hours");
    }
  });

  it("REJECTS a session with no group scope (§12 'group-scoped')", () => {
    assert.equal(
      validateSessionRequest({ groupScopeKind: "global", groupScopeId: TRIP, ttlMinutes: 60 }, NOW).ok,
      false,
    );
    assert.equal(
      validateSessionRequest({ groupScopeKind: "trip", groupScopeId: "", ttlMinutes: 60 }, NOW).ok,
      false,
    );
    assert.equal(
      validateSessionRequest({ groupScopeKind: "trip", groupScopeId: null, ttlMinutes: 60 }, NOW).ok,
      false,
    );
  });

  it("the scope vocabulary contains nothing that means 'everyone'", () => {
    for (const kind of GROUP_SCOPE_KINDS) {
      assert.ok(
        !["global", "public", "nearby", "all", "world"].includes(kind),
        `${kind} would make the session unscoped`,
      );
    }
  });

  it("defaults the CEILING but never the expiry — the two are not the same kind of thing", () => {
    const r = validateSessionRequest({ groupScopeKind: "trip", groupScopeId: TRIP, ttlMinutes: 60 }, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.value.ceiling, DEFAULT_SESSION_CEILING);
    assert.equal(DEFAULT_SESSION_CEILING, "approximate", "§23's UNGRANTED rung for this purpose");
  });

  it("the route cannot insert a session without an expiry either", async () => {
    const db = makeDb({ trips: [{ id: TRIP, owner_id: ALICE }] });
    const outcome = await startOrJoinSession(
      db as any,
      ALICE,
      { groupScopeKind: "trip", groupScopeId: TRIP },
      NOW,
    );
    assert.equal(outcome.ok, false);
    assert.equal(db._tables[SESSIONS_TABLE].length, 0, "no row may be written");
  });

  it("every session the route DOES write carries a bounded expiry", async () => {
    const db = makeDb({ trips: [{ id: TRIP, owner_id: ALICE }] });
    const outcome = await startOrJoinSession(
      db as any,
      ALICE,
      { groupScopeKind: "trip", groupScopeId: TRIP, ttlMinutes: 120 },
      NOW,
    );
    assert.equal(outcome.ok, true);
    const row = db._tables[SESSIONS_TABLE][0];
    assert.ok(row.expires_at, "expires_at must be present");
    const span = new Date(row.expires_at).getTime() - new Date(row.started_at).getTime();
    assert.ok(span > 0 && span <= MAX_SESSION_MINUTES * 60_000);
    // And the creator's opt-in is recorded, not assumed.
    assert.equal(db._tables[MEMBERS_TABLE][0].consent_source, "creator");
    assert.ok(db._tables[MEMBERS_TABLE][0].opted_in_at);
  });
});

// ══ B. Expiry is enforced on READ, not by a sweep ════════════════════════════

describe("(b) an expired session serves nothing, with no sweep anywhere", () => {
  const expired = session({
    started_at: iso(NOW - 3 * 60 * 60_000),
    expires_at: iso(NOW - 1_000), // one second ago; nothing has swept it
  });

  it("isSessionActive is false the instant the expiry passes", () => {
    assert.equal(isSessionActive(expired, NOW), false);
    assert.equal(isSessionActive(session({ expires_at: iso(NOW) }), NOW), false, "boundary is exclusive");
    assert.equal(isSessionActive(session({ expires_at: iso(NOW + 1) }), NOW), true);
  });

  it("serves NO members even though the rows are all still on disk", async () => {
    const db = makeDb({
      sessions: [expired],
      members: [member(ALICE), member(BOB)],
      positions: [position(BOB)],
      profiles: [{ id: BOB, display_name: "Bob" }],
    });

    const result = await readSessionForViewer(db as any, SESSION, ALICE, NOW);

    assert.equal(result.status, "expired");
    assert.deepEqual(result.members, []);
    assert.equal(result.session, null);
    // The rows really are still there — nothing swept them, and that is the point.
    assert.equal(db._tables[POSITIONS_TABLE].length, 1);
    assert.equal(db._tables[MEMBERS_TABLE].length, 2);
  });

  it("an expired session accepts no new positions either", async () => {
    const db = makeDb({ sessions: [expired], members: [member(ALICE)] });
    const outcome = await publishPosition(
      db as any,
      ALICE,
      SESSION,
      { rung: "network_location", precision: "precise", lat: 1, lng: 2, observedAt: NOW },
      NOW,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, "gone");
    assert.equal(db._tables[POSITIONS_TABLE].length, 0);
  });

  it("an explicitly ENDED session stops serving before its expiry", async () => {
    const db = makeDb({
      sessions: [session({ ended_at: iso(NOW - 1) })],
      members: [member(ALICE), member(BOB)],
      positions: [position(BOB)],
    });
    const result = await readSessionForViewer(db as any, SESSION, ALICE, NOW);
    assert.equal(result.status, "expired");
    assert.deepEqual(result.members, []);
  });

  it("§23 decay expires a POSITION inside a live session, again with no sweep", () => {
    const view = projectMember({
      memberId: BOB,
      displayName: "Bob",
      // 61 minutes old: past the last_known horizon.
      position: position(BOB, { observed_at: iso(NOW - 61 * 60_000) }) as PositionRow,
      sessionCeiling: "precise",
      zones: [],
      nowMs: NOW,
    });
    assert.equal(view.precision, "none");
    assert.equal(view.position, null);
    assert.equal(view.ring, null);
    assert.equal(view.displayName, null);
  });

  it("a session with an unparseable expiry is treated as expired, not as forever", () => {
    assert.equal(isSessionActive(session({ expires_at: "not a date" }), NOW), false);
    assert.equal(isSessionActive(session({ expires_at: null as any }), NOW), false);
    assert.equal(isSessionActive(null, NOW), false);
    assert.equal(isSessionActive(session(), Number.NaN), false);
  });
});

// ══ C. Precision can only ever tighten ═══════════════════════════════════════

describe("(c) precision can only tighten — never widen, at any step", () => {
  it("the feature ceiling is DERIVED from the authority, not re-declared", () => {
    assert.ok(
      Object.values(FEATURE_PRECISION_CEILING).includes(LOCATE_FRIENDS_FEATURE_CEILING),
      "the ceiling must still be a row of presence/domain/types.ts FEATURE_PRECISION_CEILING",
    );
    assert.equal(LOCATE_FRIENDS_FEATURE_CEILING, FEATURE_PRECISION_CEILING.crew);
  });

  it("narrowestOfPrecisions never exceeds ANY of its arguments", () => {
    for (const a of PRECISION_LADDER) {
      for (const b of PRECISION_LADDER) {
        for (const c of PRECISION_LADDER) {
          const got = narrowestOfPrecisions(a, b, c);
          assert.ok(precisionRank(got) <= precisionRank(a));
          assert.ok(precisionRank(got) <= precisionRank(b));
          assert.ok(precisionRank(got) <= precisionRank(c));
        }
      }
    }
  });

  it("an unknown or absent bound FAILS CLOSED to none rather than being skipped", () => {
    assert.equal(narrowestOfPrecisions(), "none");
    assert.equal(narrowestOfPrecisions("precise", "street_level" as any), "none");
    assert.equal(narrowestOfPrecisions("precise", null), "none");
    assert.equal(narrowestOfPrecisions("precise", undefined), "none");
  });

  it("a client asking for MORE than the session ceiling gets the session ceiling", () => {
    for (const sessionCeiling of PRECISION_LADDER) {
      for (const rung of LOCATE_SIGNAL_RUNGS) {
        const stored = storedPrecisionFor({ rung, requestedPrecision: "precise" }, sessionCeiling);
        assert.ok(
          precisionRank(stored) <= precisionRank(sessionCeiling),
          `${rung} obtained ${stored} against a ${sessionCeiling} session`,
        );
        assert.ok(
          precisionRank(stored) <= precisionRank(RUNG_PRECISION_CEILING[rung]),
          `${rung} exceeded its own rung ceiling`,
        );
        assert.ok(
          precisionRank(stored) <= precisionRank(LOCATE_FRIENDS_FEATURE_CEILING),
          `${rung} exceeded the §52 feature ceiling`,
        );
      }
    }
  });

  it("§12's chain is monotone non-increasing — a peer relay cannot outrank a live fix", () => {
    for (let i = 1; i < LOCATE_SIGNAL_RUNGS.length; i++) {
      const prev = RUNG_PRECISION_CEILING[LOCATE_SIGNAL_RUNGS[i - 1]];
      const cur = RUNG_PRECISION_CEILING[LOCATE_SIGNAL_RUNGS[i]];
      assert.ok(
        precisionRank(cur) <= precisionRank(prev),
        `rung ${LOCATE_SIGNAL_RUNGS[i]} (${cur}) outranks ${LOCATE_SIGNAL_RUNGS[i - 1]} (${prev})`,
      );
    }
  });

  it("§23 decay ceilings are non-increasing across the four stages", () => {
    for (let i = 1; i < DECAY_STAGES.length; i++) {
      assert.ok(
        precisionRank(DECAY_STAGE_CEILING[DECAY_STAGES[i]]) <=
          precisionRank(DECAY_STAGE_CEILING[DECAY_STAGES[i - 1]]),
      );
    }
    assert.equal(DECAY_STAGE_CEILING.expired, "none");
  });

  it("decay stages follow §23's Precise → Approximate → Last known → Expired", () => {
    assert.equal(decayStageAt(0), "precise");
    assert.equal(decayStageAt(DECAY_BOUNDARIES_MS.precise - 1), "precise");
    assert.equal(decayStageAt(DECAY_BOUNDARIES_MS.precise), "approximate");
    assert.equal(decayStageAt(DECAY_BOUNDARIES_MS.approximate), "last_known");
    assert.equal(decayStageAt(DECAY_BOUNDARIES_MS.last_known), "expired");
    // An age we cannot compute is expired, not fresh.
    assert.equal(decayStageAt(Number.NaN), "expired");
    assert.equal(decayStageAt(Number.POSITIVE_INFINITY), "expired");
    // A device clock ahead of ours buys nothing beyond stage 0.
    assert.equal(decayStageAt(-60_000), "precise");
  });

  it("a position past its decay window is served COARSER, never at what was written", () => {
    const stored = position(BOB, { precision: "precise" }) as PositionRow;
    const at = (ageMs: number) =>
      projectMember({
        memberId: BOB,
        displayName: "Bob",
        position: { ...stored, observed_at: iso(NOW - ageMs) },
        sessionCeiling: "precise",
        zones: [],
        nowMs: NOW,
      });

    const fresh = at(60_000);
    assert.equal(fresh.precision, "precise");
    assert.ok(fresh.position, "a fresh precise fix is a point");

    const aged = at(10 * 60_000); // 10 minutes: past the precise hold
    assert.equal(aged.precision, "approximate");
    assert.equal(aged.position, null, "a decayed fix must not still be a point");
    assert.ok(aged.ring, "it becomes a ring");

    const lastKnown = at(45 * 60_000);
    assert.equal(lastKnown.decayStage, "last_known");
    assert.equal(lastKnown.position, null);
    assert.equal(lastKnown.live, false);

    assert.equal(at(61 * 60_000).precision, "none");
  });

  it("a live label is only ever available inside the 5-minute precise stage", () => {
    for (const rung of LOCATE_SIGNAL_RUNGS) {
      for (const stage of DECAY_STAGES) {
        const state = estimateStateFor(rung, stage);
        if (isLiveState(state)) {
          assert.equal(stage, "precise", `${rung}/${stage} produced the live state ${state}`);
        }
      }
    }
  });

  it("a client cannot widen its own exposure by asking, at any rung", () => {
    for (const requested of PRECISION_LADDER) {
      const stored = storedPrecisionFor(
        { rung: "network_location", requestedPrecision: requested },
        "zone",
      );
      assert.ok(precisionRank(stored) <= precisionRank("zone"));
      assert.ok(precisionRank(stored) <= precisionRank(requested));
    }
  });

  it("a §24 protected zone can only lower a member's rung", async () => {
    // A coarsen-class zone (medical facility) sitting on the member's position.
    const zones = [
      {
        id: "z1",
        category: "medical_facility",
        shape: "circle",
        center: { lat: 16.0544, lng: 108.2022 },
        radiusMeters: 400,
      },
    ] as any[];
    const inside = projectMember({
      memberId: BOB,
      displayName: "Bob",
      position: position(BOB) as PositionRow,
      sessionCeiling: "precise",
      zones,
      nowMs: NOW,
    });
    const outside = projectMember({
      memberId: BOB,
      displayName: "Bob",
      position: position(BOB) as PositionRow,
      sessionCeiling: "precise",
      zones: [],
      nowMs: NOW,
    });
    assert.ok(
      precisionRank(inside.precision) < precisionRank(outside.precision),
      "a protected zone must tighten, and it must actually apply",
    );
    assert.equal(inside.position, null, "no coordinate leaves a protected zone");
  });

  it("an UNREADABLE §24 policy is not an absent policy — it serves nothing", () => {
    const view = projectMember({
      memberId: BOB,
      displayName: "Bob",
      position: position(BOB) as PositionRow,
      sessionCeiling: "precise",
      zones: null, // null means "could not read", per mapProjection's contract
      nowMs: NOW,
    });
    assert.equal(view.precision, "none");
  });
});

// ══ D. Geometry shape: a ring is not a rounded point ═════════════════════════

describe("the wire shape matches the rung — a ring, never a rounded point", () => {
  const p = { lat: 16.054407, lng: 108.202167 };

  it("only `precise` yields a coordinate", () => {
    for (const rung of PRECISION_LADDER) {
      const g = exposeGeometry(p, rung);
      if (rung === "precise") {
        assert.deepEqual(g.position, p);
        assert.equal(g.ring, null);
      } else {
        assert.equal(g.position, null, `${rung} must not emit a point`);
      }
    }
  });

  it("`approximate` yields a RING with an honest radius, and no point", () => {
    const g = exposeGeometry(p, "approximate");
    assert.equal(g.position, null);
    assert.ok(g.ring);
    assert.equal(g.ring!.radiusMeters, RING_RADIUS_METERS.approximate);
    assert.notDeepEqual(g.ring!.center, p, "the centre is the cell, not the observation");
  });

  it("the ring centre is a property of the CELL — polling cannot narrow it", () => {
    // Two different observations a few metres apart inside one 500 m cell.
    const a = coarsenToRing({ lat: 16.05441, lng: 108.20217 }, "approximate");
    const b = coarsenToRing({ lat: 16.05443, lng: 108.20219 }, "approximate");
    assert.deepEqual(a, b, "two fixes in one cell must be byte-identical on the wire");

    // And the grid is a genuine partition: snapping a centre returns itself, so
    // there is no drift a caller could accumulate by re-coarsening.
    for (const rung of ["zone", "approximate", "nearby"] as LocationPrecision[]) {
      const once = coarsenToRing(p, rung)!;
      const twice = coarsenToRing(once.center, rung)!;
      assert.deepEqual(twice, once, `${rung} snapping is not idempotent`);
    }
  });

  it("the advertised radius covers the whole cell it was derived from", () => {
    for (const rung of ["zone", "approximate", "nearby"] as LocationPrecision[]) {
      const ring = coarsenToRing(p, rung)!;
      const dLat = (ring.center.lat - p.lat) * 111_320;
      const dLng = (ring.center.lng - p.lng) * 111_320 * Math.cos((p.lat * Math.PI) / 180);
      const offset = Math.sqrt(dLat * dLat + dLng * dLng);
      assert.ok(
        offset <= ring.radiusMeters,
        `${rung}: the true point sits ${offset.toFixed(0)}m from a centre advertised at ${ring.radiusMeters}m`,
      );
    }
  });

  it("`venue` and below carry no geometry at all", () => {
    for (const rung of ["none", "presence_only", "venue"] as LocationPrecision[]) {
      const g = exposeGeometry(p, rung);
      assert.equal(g.position, null);
      assert.equal(g.ring, null);
    }
  });

  it("a coordinate is never STORED below the precise rung", () => {
    for (const rung of LOCATE_SIGNAL_RUNGS) {
      const row = positionRowFor(SESSION, ALICE, {
        rung,
        requestedPrecision: "precise",
        lat: 16.05,
        lng: 108.2,
        proximityBucket: null,
        checkpointLabel: null,
        observedAtMs: NOW,
      }, "precise", NOW + 60 * 60_000);
      if (row.precision !== "precise") {
        assert.equal(row.lat, null, `${rung} stored a coordinate at ${row.precision}`);
        assert.equal(row.lng, null);
      }
    }
  });

  it("a submission with NO coordinate never becomes a fix at 0,0", () => {
    // Number(null) is 0, so a coercion-first check would fabricate Null Island
    // and present it at the precise rung.
    const row = positionRowFor(SESSION, ALICE, {
      rung: "network_location",
      requestedPrecision: "precise",
      lat: null,
      lng: null,
      proximityBucket: "nearby",
      checkpointLabel: null,
      observedAtMs: NOW,
    }, "precise", NOW + 60 * 60_000);
    assert.equal(row.lat, null);
    assert.equal(row.lng, null);

    const view = projectMember({
      memberId: ALICE,
      displayName: "Alice",
      position: row,
      sessionCeiling: "precise",
      zones: [],
      nowMs: NOW,
    });
    assert.equal(view.position, null);
    assert.equal(view.ring, null);
  });

  it("a stored position never outlives the session or the decay horizon", () => {
    const shortSession = NOW + 5 * 60_000;
    const row = positionRowFor(SESSION, ALICE, {
      rung: "network_location",
      requestedPrecision: "precise",
      lat: 1, lng: 2,
      proximityBucket: null, checkpointLabel: null,
      observedAtMs: NOW,
    }, "precise", shortSession);
    assert.equal(new Date(row.expires_at).getTime(), shortSession, "session expiry wins when it is sooner");

    const longSession = NOW + 11 * 60 * 60_000;
    const row2 = positionRowFor(SESSION, ALICE, {
      rung: "network_location",
      requestedPrecision: "precise",
      lat: 1, lng: 2,
      proximityBucket: null, checkpointLabel: null,
      observedAtMs: NOW,
    }, "precise", longSession);
    assert.equal(new Date(row2.expires_at).getTime(), NOW + POSITION_TTL_MS, "decay horizon wins otherwise");
  });

  it("an identity is attached only from `approximate` up (§23)", () => {
    const at = (sessionCeiling: LocationPrecision) =>
      projectMember({
        memberId: BOB,
        displayName: "Bob",
        position: position(BOB) as PositionRow,
        sessionCeiling,
        zones: [],
        nowMs: NOW,
      });
    assert.equal(at("precise").displayName, "Bob");
    assert.equal(at("approximate").displayName, "Bob");
    assert.equal(at("zone").displayName, null);
    assert.equal(at("venue").displayName, null);
    assert.equal(at("presence_only").displayName, null);
  });
});

// ══ E. Leaving stops exposure immediately ════════════════════════════════════

describe("(d) leaving stops exposure at once, not at the next sweep", () => {
  it("DELETES the stored position and closes the membership in one call", async () => {
    const db = makeDb({
      sessions: [session()],
      members: [member(ALICE), member(BOB)],
      positions: [position(BOB)],
      profiles: [{ id: BOB, display_name: "Bob" }],
    });

    // Before: Alice can see Bob.
    const before = await readSessionForViewer(db as any, SESSION, ALICE, NOW);
    assert.equal(before.status, "ok");
    assert.equal(before.members.length, 1);
    assert.ok(before.members[0].position, "Bob is visible at precise");

    const leave = await leaveSession(db as any, SESSION, BOB, NOW + 1_000);
    assert.equal(leave.outcome, "left");

    // The row is GONE — exposure stopped because there is nothing to project,
    // not because a later job will get to it.
    assert.equal(db._tables[POSITIONS_TABLE].length, 0);

    const after = await readSessionForViewer(db as any, SESSION, ALICE, NOW + 1_001);
    assert.equal(after.status, "ok");
    assert.deepEqual(after.members, [], "Bob is gone from the very next read");
  });

  it("a member who left cannot read the session either", async () => {
    const db = makeDb({
      sessions: [session()],
      members: [member(ALICE), member(BOB, { left_at: iso(NOW - 1) })],
      positions: [position(ALICE)],
    });
    const result = await readSessionForViewer(db as any, SESSION, BOB, NOW);
    assert.equal(result.status, "not_member");
    assert.deepEqual(result.members, []);
  });

  it("a member who left cannot publish a position either", async () => {
    const db = makeDb({
      sessions: [session()],
      members: [member(BOB, { left_at: iso(NOW - 1) })],
    });
    const outcome = await publishPosition(
      db as any,
      BOB,
      SESSION,
      { rung: "network_location", precision: "precise", lat: 1, lng: 2, observedAt: NOW },
      NOW,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, "forbidden");
    assert.equal(db._tables[POSITIONS_TABLE].length, 0);
  });

  it("leaving is idempotent and never reveals whether the session exists", async () => {
    const db = makeDb({ sessions: [session()], members: [] });
    const r = await leaveSession(db as any, SESSION, STRANGER, NOW);
    assert.equal(r.outcome, "not_member");
  });
});

// ══ F. Non-members get nothing ═══════════════════════════════════════════════

describe("(e) a non-member gets nothing, checked server-side per request", () => {
  const db = () =>
    makeDb({
      sessions: [session()],
      members: [member(ALICE), member(BOB)],
      positions: [position(ALICE), position(BOB)],
      profiles: [
        { id: ALICE, display_name: "Alice" },
        { id: BOB, display_name: "Bob" },
      ],
    });

  it("a stranger holding a valid token and the session id gets an empty result", async () => {
    const result = await readSessionForViewer(db() as any, SESSION, STRANGER, NOW);
    assert.equal(result.status, "not_member");
    assert.equal(result.session, null);
    assert.deepEqual(result.members, []);
  });

  it("a stranger cannot publish into the session", async () => {
    const d = db();
    const outcome = await publishPosition(
      d as any,
      STRANGER,
      SESSION,
      { rung: "network_location", precision: "precise", lat: 1, lng: 2, observedAt: NOW },
      NOW,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, "forbidden");
  });

  it("an unreadable membership table serves nothing (fail-closed)", async () => {
    const d = makeDb({
      sessions: [session()],
      members: [member(ALICE), member(BOB)],
      positions: [position(BOB)],
      failReads: [MEMBERS_TABLE],
    });
    const result = await readSessionForViewer(d as any, SESSION, ALICE, NOW);
    assert.equal(result.status, "unreadable");
    assert.deepEqual(result.members, []);
  });

  it("an unreadable BLOCK list means nobody, not everybody", async () => {
    const d = makeDb({
      sessions: [session()],
      members: [member(ALICE), member(BOB)],
      positions: [position(BOB)],
      profiles: [{ id: BOB, display_name: "Bob" }],
      failReads: ["blocks"],
    });
    const result = await readSessionForViewer(d as any, SESSION, ALICE, NOW);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.members, [], "fetchBlockedSet null must mean nobody");
  });

  it("a blocked member is excluded in BOTH directions", async () => {
    const forward = makeDb({
      sessions: [session()],
      members: [member(ALICE), member(BOB)],
      positions: [position(BOB)],
      profiles: [{ id: BOB, display_name: "Bob" }],
      blocks: [{ blocker_id: ALICE, blocked_id: BOB }],
    });
    assert.deepEqual((await readSessionForViewer(forward as any, SESSION, ALICE, NOW)).members, []);

    const reverse = makeDb({
      sessions: [session()],
      members: [member(ALICE), member(BOB)],
      positions: [position(BOB)],
      profiles: [{ id: BOB, display_name: "Bob" }],
      blocks: [{ blocker_id: BOB, blocked_id: ALICE }],
    });
    assert.deepEqual((await readSessionForViewer(reverse as any, SESSION, ALICE, NOW)).members, []);
  });

  it("a viewer never receives their own row back", async () => {
    const d = makeDb({
      sessions: [session()],
      members: [member(ALICE), member(BOB), member(CAROL)],
      positions: [position(ALICE), position(BOB), position(CAROL)],
      profiles: [
        { id: BOB, display_name: "Bob" },
        { id: CAROL, display_name: "Carol" },
      ],
    });
    const result = await readSessionForViewer(d as any, SESSION, ALICE, NOW);
    assert.deepEqual(result.members.map((m) => m.memberId).sort(), [BOB, CAROL].sort());
  });

  it("a session that does not exist is indistinguishable from one you cannot see", async () => {
    const missing = await readSessionForViewer(makeDb() as any, SESSION, ALICE, NOW);
    assert.equal(missing.session, null);
    assert.deepEqual(missing.members, []);
  });
});

// ══ G. Group scope is the join gate ══════════════════════════════════════════

describe("group scope — you can only join a group you are provably in", () => {
  it("an unverifiable scope kind is REFUSED, not waved through", async () => {
    const db = makeDb();
    assert.equal(await verifyScopeMembership(db as any, "circle", TRIP, ALICE), false);
    assert.equal(await verifyScopeMembership(db as any, "plan", TRIP, ALICE), false);
  });

  it("a stranger cannot open a session on someone else's trip", async () => {
    const db = makeDb({ trips: [{ id: TRIP, owner_id: ALICE }] });
    const outcome = await startOrJoinSession(
      db as any,
      STRANGER,
      { groupScopeKind: "trip", groupScopeId: TRIP, ttlMinutes: 60 },
      NOW,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, "forbidden");
    assert.equal(db._tables[SESSIONS_TABLE].length, 0);
  });

  it("a stranger cannot JOIN an existing session by naming its group scope", async () => {
    const db = makeDb({
      trips: [{ id: TRIP, owner_id: ALICE }],
      sessions: [session()],
      members: [member(ALICE, { consent_source: "creator" })],
    });
    const outcome = await startOrJoinSession(
      db as any,
      STRANGER,
      { groupScopeKind: "trip", groupScopeId: TRIP, ttlMinutes: 60 },
      NOW,
    );
    assert.equal(outcome.ok, false);
    assert.equal(db._tables[MEMBERS_TABLE].length, 1, "no membership row may be added");
  });

  it("a real crew member joins the SAME session rather than creating a second one", async () => {
    const db = makeDb({
      trips: [{ id: TRIP, owner_id: ALICE }],
      tripMembers: [{ trip_id: TRIP, user_id: BOB, role: "member" }],
      sessions: [session()],
      members: [member(ALICE, { consent_source: "creator" })],
    });
    const outcome = await startOrJoinSession(
      db as any,
      BOB,
      { groupScopeKind: "trip", groupScopeId: TRIP, ttlMinutes: 60 },
      NOW,
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok === true && outcome.joined, true);
    assert.equal(db._tables[SESSIONS_TABLE].length, 1, "no second session");
    assert.equal(db._tables[MEMBERS_TABLE].length, 2);
    const bobRow = db._tables[MEMBERS_TABLE].find((m: any) => m.user_id === BOB);
    assert.equal(bobRow.consent_source, "group_join", "the opt-in is recorded as an act");
    assert.ok(bobRow.opted_in_at);
  });

  it("an EXPIRED session for the scope is not joined — a fresh one is created", async () => {
    const db = makeDb({
      trips: [{ id: TRIP, owner_id: ALICE }],
      sessions: [session({ expires_at: iso(NOW - 1) })],
      members: [member(ALICE, { consent_source: "creator" })],
    });
    const outcome = await startOrJoinSession(
      db as any,
      ALICE,
      { groupScopeKind: "trip", groupScopeId: TRIP, ttlMinutes: 60 },
      NOW,
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok === true && outcome.joined, false);
    assert.equal(db._tables[SESSIONS_TABLE].length, 2, "the expired one is never revived");
  });
});

// ══ H. Attribution ═══════════════════════════════════════════════════════════

describe("attribution — every membership and position write is recorded", () => {
  it("a position write leaves an audit row naming the actor, rung and precision", async () => {
    const db = makeDb({ sessions: [session()], members: [member(ALICE)] });
    const outcome = await publishPosition(
      db as any,
      ALICE,
      SESSION,
      { rung: "network_location", precision: "precise", lat: 16.05, lng: 108.2, observedAt: NOW },
      NOW,
    );
    assert.equal(outcome.ok, true);
    const audit = db._tables.locate_friends_audit;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].event, "position_written");
    assert.equal(audit[0].actor_id, ALICE);
    assert.equal(audit[0].session_id, SESSION);
    assert.equal(audit[0].rung, "network_location");
    assert.equal(audit[0].precision, "precise");
  });

  it("the audit row carries NO coordinate — attribution must not rebuild a track", async () => {
    const db = makeDb({ sessions: [session()], members: [member(ALICE)] });
    await publishPosition(
      db as any,
      ALICE,
      SESSION,
      { rung: "network_location", precision: "precise", lat: 16.05, lng: 108.2, observedAt: NOW },
      NOW,
    );
    for (const row of db._tables.locate_friends_audit) {
      for (const key of Object.keys(row)) {
        assert.ok(
          !/lat|lng|lon|coord|geo|point|position/i.test(key),
          `audit row carries a location-shaped key: ${key}`,
        );
      }
    }
  });

  it("a session write leaves ONE current position row per member, never a history", async () => {
    const db = makeDb({ sessions: [session()], members: [member(ALICE)] });
    for (let i = 0; i < 5; i++) {
      await publishPosition(
        db as any,
        ALICE,
        SESSION,
        {
          rung: "network_location",
          precision: "precise",
          lat: 16.05 + i / 1000,
          lng: 108.2,
          observedAt: NOW - i * 1_000,
        },
        NOW,
      );
    }
    assert.equal(
      db._tables[POSITIONS_TABLE].length,
      1,
      "five publishes must leave one row — a movement history has nowhere to live",
    );
  });

  it("a future-dated observation is refused rather than buying a longer window", async () => {
    const db = makeDb({ sessions: [session()], members: [member(ALICE)] });
    const outcome = await publishPosition(
      db as any,
      ALICE,
      SESSION,
      {
        rung: "network_location",
        precision: "precise",
        lat: 1, lng: 2,
        observedAt: NOW + 10 * 60_000,
      },
      NOW,
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.code, "invalid_payload");
  });

  it("an observation older than the decay horizon is refused, not stored unservable", async () => {
    const db = makeDb({ sessions: [session()], members: [member(ALICE)] });
    const outcome = await publishPosition(
      db as any,
      ALICE,
      SESSION,
      {
        rung: "network_location",
        precision: "precise",
        lat: 1, lng: 2,
        observedAt: NOW - POSITION_TTL_MS - 1,
      },
      NOW,
    );
    assert.equal(outcome.ok, false);
    assert.equal(db._tables[POSITIONS_TABLE].length, 0);
  });
});
