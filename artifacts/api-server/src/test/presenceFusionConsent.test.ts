/**
 * OWNER DECISION A (2026-09-26) — consent scopes THROUGH fusion and reads.
 *
 * census-sensing §24.3 measured §16.5's fused read three times and found the
 * same two holes: (1) an estimate carried its source and its ceiling but not
 * the AUDIENCE it was consented to, so "same class" fused two consents given
 * to two different sets of people; (2) "newest wins" let a fresh non-live
 * assertion downgrade a live position. The owner chose to preserve and enforce
 * source-specific consent and audience restrictions through fusion and reads,
 * define how observations of different quality and freshness compete, and
 * test cross-audience denial and revocation. This file is that test.
 *
 * Four parts, each with a mutation that turns it red named in its header:
 *
 *   A. the STORE requires and matches a scope on every claim;
 *   B. CROSS-AUDIENCE DENIAL — a viewer reaches an estimate only through the
 *      exact scope it was admitted under;
 *   C. REVOCATION — the four revoke operations, and the three production
 *      points that call them (leaving a session, stopping a live share, the
 *      Circle helpers the routes call), produce the effect and report it;
 *   D. COMPETITION — `competePresence` is the rule the owner asked for, and
 *      `resolve` applies it;
 *   E. the ONE FUSED PRODUCTION CONSUMER — `readSessionForViewer` fuses a
 *      Circle estimate into a Locate session ONLY for a viewer whose context
 *      membership is verified, and never past the session's own refusals.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  PRESENCE_LIVE_WINDOW_MS,
  PRESENCE_STATE_STRENGTH,
  PRESENCE_WRITE_CAPABILITIES,
  PresenceFusionStore,
  competePresence,
  isFused,
  presenceFusion,
  type FusedPresenceEstimate,
  type PresenceAudience,
  type PresenceClaim,
} from "../presence/fusion/store.js";
import {
  PRESENCE_SOURCES,
  PRESENCE_SOURCE_CONTRACTS,
  circleConsentScope,
  consentScopeKey,
  isPresenceConsentScope,
  type PresenceConsentScope,
} from "../presence/fusion/sources.js";
import {
  DEFAULT_FUSED_READ_DEPS,
  MEMBERS_TABLE,
  POSITIONS_TABLE,
  POSITION_TTL_MS,
  SESSIONS_TABLE,
  fuseMemberView,
  leaveSession,
  locateSessionScope,
  notSharing,
  projectMember,
  readSessionForViewer,
  circleContextOf,
  circleScopeFor,
  type FusedReadDeps,
  type PositionRow,
  type SessionRow,
} from "../lib/locateFriendsSession.js";
import {
  circlePresenceEstimate,
  revokeAllCirclePresence,
  revokeCircleContext,
  revokeCirclePresence,
  revokeEveryCirclePresence,
  type CircleProfileSnippet,
} from "../lib/circleResponseShaper.js";
import { canViewCirclePresenceBatch, type CircleAccessResult } from "../lib/circleAccessGuard.js";
import { admitCrewPresence } from "../domain/trips/services/TripCrewLocationService.js";
import { stopLiveShare } from "../domain/trips/services/TripCrewLiveShareService.js";
import { buildCrewCard, type RawMemberLocation } from "../domain/trips/services/tripCrewLocation.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

const SESSION_A: PresenceConsentScope = { kind: "locate_session", id: "session-a" };
const SESSION_B: PresenceConsentScope = { kind: "locate_session", id: "session-b" };
const CIRCLE_X: PresenceConsentScope = circleConsentScope("trip", "trip-x");
const CIRCLE_Y: PresenceConsentScope = circleConsentScope("trip", "trip-y");
const CREW_X: PresenceConsentScope = { kind: "trip_crew", id: "trip-x" };

function claim(over: Partial<PresenceClaim> = {}): PresenceClaim {
  return {
    subjectKey: "acct-9",
    linkage: "account_scoped",
    scope: SESSION_A,
    requestedPrecision: "precise",
    observedAtMs: T0,
    state: "precise",
    confidence: 1,
    evidence: ["gps"],
    point: { lat: 51.5, lng: -0.12 },
    ...over,
  };
}

function aud(ceiling: PresenceAudience["ceiling"], ...scopes: PresenceConsentScope[]): PresenceAudience {
  return { ceiling, scopes };
}

// ══ A. The store requires and matches a scope ════════════════════════════════
//
// RED WHEN: `admit` stops checking `isPresenceConsentScope(claim.scope)` or
// `claim.scope.kind !== contract.consentScopeKind`.

describe("A. a claim without a consent scope is not admitted", () => {
  test("no scope at all is refused as `no_scope`", () => {
    const store = new PresenceFusionStore();
    const r = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ scope: undefined as never }),
      T0,
    );
    assert.deepEqual(r, { ok: false, refusal: "no_scope" });
  });

  test("an empty or malformed scope is refused as `no_scope`", () => {
    const store = new PresenceFusionStore();
    for (const bad of [{ kind: "locate_session", id: "  " }, { kind: "locate_session" }, { id: "x" }, "session-a", null, 42]) {
      const r = store.admit(
        PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
        claim({ scope: bad as never }),
        T0,
      );
      assert.deepEqual(r, { ok: false, refusal: "no_scope" }, JSON.stringify(bad));
    }
  });

  test("a scope of another source's kind is refused as `scope_mismatch` — consent cannot be relabelled", () => {
    const store = new PresenceFusionStore();
    for (const source of PRESENCE_SOURCES) {
      const own = PRESENCE_SOURCE_CONTRACTS[source].consentScopeKind;
      for (const kind of ["locate_session", "circle", "trip_crew", "map_public"] as const) {
        if (kind === own) continue;
        const r = store.admit(
          PRESENCE_WRITE_CAPABILITIES[source],
          claim({ scope: { kind, id: "anything" } }),
          T0,
        );
        assert.deepEqual(r, { ok: false, refusal: "scope_mismatch" }, `${source} accepted a ${kind} scope`);
      }
    }
  });

  test("every registered source declares a scope kind the register knows", () => {
    for (const source of PRESENCE_SOURCES) {
      assert.ok(
        isPresenceConsentScope({ kind: PRESENCE_SOURCE_CONTRACTS[source].consentScopeKind, id: "x" }),
        `${source} declares an unknown scope kind`,
      );
    }
  });

  test("the admitted estimate carries its scope, trimmed and frozen", () => {
    const store = new PresenceFusionStore();
    const r = store.admit(
      PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
      claim({ scope: { kind: "locate_session", id: "  session-a  " } }),
      T0,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.estimate.scope, SESSION_A);
    assert.ok(Object.isFrozen(r.estimate.scope));
    assert.equal(consentScopeKey(r.estimate.scope), "locate_session:session-a");
  });
});

// ══ B. Cross-audience denial ═════════════════════════════════════════════════
//
// RED WHEN: `read`/`resolve` look entries up without the audience's scopes
// (e.g. iterate the whole map), or `audienceScopes` stops filtering by kind.

describe("B. a viewer reaches an estimate only through the scope it was admitted under", () => {
  function seeded() {
    const store = new PresenceFusionStore();
    // The same person, seen by session A precisely and by session B at zone.
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_A, ceilings: ["precise"], observedAtMs: T0 }), T0 + 1_000);
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_B, ceilings: ["zone"], observedAtMs: T0 + 200 }), T0 + 1_000);
    // And asserted by the circle of trip X.
    store.admit(
      PRESENCE_WRITE_CAPABILITIES.circle_presence,
      claim({ scope: CIRCLE_X, requestedPrecision: "venue", state: "recent", observedAtMs: T0 + 100, point: null }),
      T0 + 1_000,
    );
    return store;
  }

  test("session B's member does not see session A's precise position", () => {
    const store = seeded();
    const seen = store.read("locate_friends_session", "acct-9", aud("precise", SESSION_B), T0 + 1_000);
    assert.ok(seen);
    assert.equal(seen.scope.id, "session-b");
    assert.equal(seen.precision, "zone");
    assert.equal(seen.position, null, "session A's coordinate leaked into session B");
    const fused = store.resolve("acct-9", "locate_friends_session", aud("precise", SESSION_B), T0 + 1_000);
    assert.ok(fused);
    assert.equal(fused.scope.id, "session-b");
    assert.equal(fused.position, null);
  });

  test("session A's member sees session A's — the scope selects, it does not merely narrow", () => {
    const store = seeded();
    const seen = store.read("locate_friends_session", "acct-9", aud("precise", SESSION_A), T0 + 1_000);
    assert.ok(seen && seen.position, "the entitled viewer must still be served");
    assert.equal(seen.scope.id, "session-a");
  });

  test("no scopes, nothing — existence is withheld, not just the point", () => {
    const store = seeded();
    assert.equal(store.read("locate_friends_session", "acct-9", aud("precise"), T0 + 1_000), null);
    assert.equal(store.resolve("acct-9", "locate_friends_session", aud("precise"), T0 + 1_000), null);
    assert.equal(store.resolve("acct-9", "locate_friends_session", { ceiling: "precise", scopes: undefined as never }, T0 + 1_000), null);
  });

  test("a scope the viewer does not hold is a scope the viewer does not hold, whatever its id says", () => {
    const store = seeded();
    // A session scope with a circle's id, a circle scope with a session's id:
    // kind and id must BOTH match, and a malformed entry matches nothing.
    for (const wrong of [
      { kind: "locate_session", id: "trip:trip-x" },
      { kind: "circle", id: "session-a" },
      { kind: "locate_session", id: "session-c" },
      { kind: "locate_session" },
      { kind: "trip_crew", id: "session-a" },
    ]) {
      const a = { ceiling: "precise", scopes: [wrong] } as unknown as PresenceAudience;
      assert.equal(store.read("locate_friends_session", "acct-9", a, T0 + 1_000), null, JSON.stringify(wrong));
      assert.equal(store.resolve("acct-9", "locate_friends_session", a, T0 + 1_000), null, JSON.stringify(wrong));
    }
  });

  test("a circle scope for trip Y does not reach trip X's circle estimate", () => {
    const store = seeded();
    assert.equal(store.resolve("acct-9", "locate_friends_session", aud("precise", CIRCLE_Y), T0 + 1_000), null);
    const viaX = store.resolve("acct-9", "locate_friends_session", aud("precise", CIRCLE_X), T0 + 1_000);
    assert.ok(viaX);
    assert.equal(viaX.source, "circle_presence");
  });

  test("holding only the circle scope reaches the circle estimate and NOT the session positions", () => {
    const store = seeded();
    const fused = store.resolve("acct-9", "locate_friends_session", aud("precise", CIRCLE_X), T0 + 1_000);
    assert.ok(fused);
    assert.equal(fused.source, "circle_presence");
    assert.equal(fused.position, null);
    assert.ok(!fused.live(T0 + 1_000));
  });

  test("holding both scopes, the live session position wins over the circle assertion", () => {
    const store = seeded();
    const fused = store.resolve("acct-9", "locate_friends_session", aud("precise", SESSION_A, CIRCLE_X), T0 + 1_000);
    assert.ok(fused);
    assert.equal(fused.source, "locate_friends_session");
    assert.equal(fused.scope.id, "session-a");
  });

  test("retention is per scope: a narrower admission in B does not displace, and is not displaced by, A", () => {
    const store = new PresenceFusionStore();
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_A, ceilings: ["precise"] }), T0);
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_B, ceilings: ["venue"] }), T0);
    assert.equal(store.size, 2);
    assert.equal(store.read("locate_friends_session", "acct-9", aud("precise", SESSION_A), T0)?.precision, "precise");
    assert.equal(store.read("locate_friends_session", "acct-9", aud("precise", SESSION_B), T0)?.precision, "venue");
  });

  test("the audience ceiling still narrows a reachable estimate — the scope unlocks, the rung bounds", () => {
    const store = seeded();
    const seen = store.read("locate_friends_session", "acct-9", aud("zone", SESSION_A), T0 + 1_000);
    assert.ok(seen);
    assert.equal(seen.precision, "zone");
    assert.equal(seen.position, null);
    assert.deepEqual(seen.scope, SESSION_A, "the re-minted estimate keeps its scope");
    assert.ok(isFused(seen));
  });
});

// ══ C. Revocation ════════════════════════════════════════════════════════════
//
// RED WHEN: any `revoke*` stops deleting, `leaveSession` / `stopLiveShare` /
// the circle helpers stop calling the store, or a revoke reports a count it
// did not perform.

describe("C. revocation drops exactly what was consented, and reports it", () => {
  function seeded() {
    const store = new PresenceFusionStore();
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_A }), T0);
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_A, subjectKey: "acct-2" }), T0);
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_B }), T0);
    store.admit(PRESENCE_WRITE_CAPABILITIES.circle_presence, claim({ scope: CIRCLE_X, requestedPrecision: "venue", state: "recent", point: null }), T0);
    store.admit(PRESENCE_WRITE_CAPABILITIES.circle_presence, claim({ scope: CIRCLE_Y, requestedPrecision: "venue", state: "recent", point: null }), T0);
    store.admit(PRESENCE_WRITE_CAPABILITIES.trip_crew_location_sessions, claim({ scope: CREW_X }), T0);
    assert.equal(store.size, 6);
    return store;
  }

  test("revokeSubjectInScope drops one person from one consent and nothing else", () => {
    const store = seeded();
    assert.equal(store.revokeSubjectInScope("acct-9", SESSION_A), 1);
    assert.equal(store.size, 5);
    assert.equal(store.read("locate_friends_session", "acct-9", aud("precise", SESSION_A), T0), null);
    assert.ok(store.read("locate_friends_session", "acct-2", aud("precise", SESSION_A), T0), "the other member of A stays");
    assert.ok(store.read("locate_friends_session", "acct-9", aud("precise", SESSION_B), T0), "the same person's other consent stays");
    assert.equal(store.revokeSubjectInScope("acct-9", SESSION_A), 0, "a second revoke has nothing to do and says so");
  });

  test("revokeScope drops every subject under one consent", () => {
    const store = seeded();
    assert.equal(store.revokeScope(SESSION_A), 2);
    assert.equal(store.size, 4);
    assert.equal(store.resolve("acct-9", "locate_friends_session", aud("precise", SESSION_A, SESSION_B, CIRCLE_X), T0)?.scope.id, "session-b");
  });

  test("revokeSubject drops one person everywhere, or only within one scope kind", () => {
    const store = seeded();
    assert.equal(store.revokeSubject("acct-9", "circle"), 2);
    assert.equal(store.size, 4);
    assert.ok(store.read("locate_friends_session", "acct-9", aud("precise", SESSION_A), T0));
    assert.equal(store.revokeSubject("acct-9"), 3, "session A, session B and the crew entry");
    assert.equal(store.size, 1, "only acct-2 remains");
  });

  test("revokeScopeKind is the kill-switch shape", () => {
    const store = seeded();
    assert.equal(store.revokeScopeKind("circle"), 2);
    assert.equal(store.size, 4);
    assert.equal(store.resolve("acct-9", "locate_friends_session", aud("precise", CIRCLE_X, CIRCLE_Y), T0), null);
  });

  test("a malformed scope or subject revokes nothing and reports 0", () => {
    const store = seeded();
    assert.equal(store.revokeScope({ kind: "locate_session", id: " " } as never), 0);
    assert.equal(store.revokeSubjectInScope("", SESSION_A), 0);
    assert.equal(store.revokeSubject("acct-9", "not_a_kind" as never), 0);
    assert.equal(store.revokeScopeKind("not_a_kind" as never), 0);
    assert.equal(store.size, 6);
  });

  test("revocation is not a ban — the next consent is admitted again", () => {
    const store = seeded();
    store.revokeSubjectInScope("acct-9", SESSION_A);
    const r = store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_A, observedAtMs: T0 + 1 }), T0 + 1);
    assert.ok(r.ok);
    assert.ok(store.read("locate_friends_session", "acct-9", aud("precise", SESSION_A), T0 + 1));
  });
});

// ── C (production points) — the process-wide store, cleared per case ─────────

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "11111111-1111-4111-8111-111111111112";
const TRIP = "22222222-2222-4222-8222-222222222222";
const TRIP2 = "22222222-2222-4222-8222-222222222223";
const SESSION = "33333333-3333-4333-8333-333333333333";
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

/** Permissive fake: any chain resolves to `{ data, error: null }` off an in-memory table map. */
function fakeDb(tables: Record<string, any[]> = {}, failReads: string[] = []) {
  const fails = new Set(failReads);
  const writes: Array<{ table: string; op: string; payload: any; filters: Array<[string, any]> }> = [];
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let op = "select";
    let payload: any = null;
    let orFilter: string | null = null;
    const filters: Array<{ col: string; val: any; kind: string }> = [];
    const match = (row: any) => {
      if (orFilter) {
        const clauses = orFilter.split(",").map((c) => c.split("."));
        return clauses.some(([col, , val]) => row[col] === val);
      }
      return filters.every((f) => {
        const cell = row[f.col];
        if (f.kind === "in") return (f.val as any[]).includes(cell);
        if (f.kind === "is") return (cell ?? null) === f.val;
        return cell === f.val;
      });
    };
    const run = () => {
      if (fails.has(table)) return { data: null, error: { message: `read failed: ${table}` } };
      if (op === "insert") { rows.push({ ...payload }); writes.push({ table, op, payload, filters: filters.map((f) => [f.col, f.val]) }); return { data: null, error: null }; }
      if (op === "update") { for (const r of rows) if (match(r)) Object.assign(r, payload); writes.push({ table, op, payload, filters: filters.map((f) => [f.col, f.val]) }); return { data: null, error: null }; }
      if (op === "delete") { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i])) rows.splice(i, 1); writes.push({ table, op, payload, filters: filters.map((f) => [f.col, f.val]) }); return { data: null, error: null }; }
      return { data: rows.filter(match), error: null };
    };
    const first = () => { const r = run(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; };
    const b: any = {
      select() { return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
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

describe("C. the production revocation points reach the store", () => {
  beforeEach(() => { presenceFusion.clear(); });

  test("leaveSession revokes the member's estimate under THAT session before touching the rows", async () => {
    // Two sessions hold the same person; leaving one must not touch the other.
    projectMember({ memberId: BOB, displayName: "Bob", sessionId: SESSION, position: pos(BOB), sessionCeiling: "precise", zones: [], nowMs: NOW });
    projectMember({ memberId: BOB, displayName: "Bob", sessionId: "other-session", position: pos(BOB), sessionCeiling: "precise", zones: [], nowMs: NOW });
    assert.ok(presenceFusion.resolve(BOB, "locate_friends_session", aud("precise", locateSessionScope(SESSION)), NOW));

    const db = fakeDb({
      [MEMBERS_TABLE]: [{ session_id: SESSION, user_id: BOB, opted_in_at: iso(NOW - MIN), consent_source: "group_join", left_at: null }],
      [POSITIONS_TABLE]: [pos(BOB)],
    });
    const r = await leaveSession(db as any, SESSION, BOB, NOW + 1);
    assert.equal(r.outcome, "left");
    assert.equal(r.revokedEstimates, 1);
    assert.equal(presenceFusion.resolve(BOB, "locate_friends_session", aud("precise", locateSessionScope(SESSION)), NOW + 1), null);
    assert.ok(presenceFusion.resolve(BOB, "locate_friends_session", aud("precise", locateSessionScope("other-session")), NOW + 1), "the other session's consent stands");
    assert.equal(db._tables[POSITIONS_TABLE].length, 0, "the row still goes too");
  });

  test("leaveSession revokes even when the membership row is unreadable — the member asked to stop being seen", async () => {
    projectMember({ memberId: BOB, displayName: "Bob", sessionId: SESSION, position: pos(BOB), sessionCeiling: "precise", zones: [], nowMs: NOW });
    const db = fakeDb({}, [MEMBERS_TABLE]);
    const r = await leaveSession(db as any, SESSION, BOB, NOW + 1);
    assert.equal(r.outcome, "error");
    assert.equal(r.revokedEstimates, 1);
    assert.equal(presenceFusion.resolve(BOB, "locate_friends_session", aud("precise", locateSessionScope(SESSION)), NOW + 1), null);
  });

  test("stopLiveShare revokes the member's crew estimate for THAT trip", async () => {
    const raw = sharer();
    admitCrewPresence(buildCrewCard(raw, NOW), raw, NOW, TRIP);
    admitCrewPresence(buildCrewCard(raw, NOW), raw, NOW, TRIP2);
    const crew = (trip: string) => presenceFusion.read("trip_crew_location_sessions", raw.userId, aud("precise", { kind: "trip_crew", id: trip }), NOW);
    assert.ok(crew(TRIP)?.position, "the premise: a precise crew estimate is retained");

    const db = fakeDb({ trip_crew_location_sessions: [{ id: "s1", trip_id: TRIP, user_id: raw.userId, status: "active" }] });
    const r = await stopLiveShare(db as any, TRIP, raw.userId);
    assert.deepEqual(r, { ok: true, revokedEstimates: 1 });
    assert.equal(crew(TRIP), null);
    assert.ok(crew(TRIP2), "the other trip's consent stands");
    assert.equal(db._tables.trip_crew_location_sessions[0].status, "stopped");
  });

  test("the Circle helpers the routes call revoke by member+context, by context, by member, and everything", () => {
    const profile: CircleProfileSnippet = { userId: BOB, avatarUrl: null, displayName: "Bob", username: "bob" };
    const row = { id: "p1", status: "active", checked_in: false, is_stale: false, updated_at: iso(NOW - MIN) };
    assert.ok(circlePresenceEstimate(profile, row, "approximate_area", false, { type: "trip", id: TRIP }));
    assert.ok(circlePresenceEstimate(profile, row, "approximate_area", false, { type: "trip", id: TRIP2 }));
    assert.ok(circlePresenceEstimate({ ...profile, userId: ALICE }, row, "approximate_area", false, { type: "trip", id: TRIP }));
    assert.equal(presenceFusion.size, 3);

    assert.equal(revokeCirclePresence(BOB, "trip", TRIP), 1);
    assert.equal(revokeCircleContext("trip", TRIP), 1, "Alice's entry in the same context");
    assert.equal(revokeAllCirclePresence(BOB), 1, "Bob's remaining context");
    assert.equal(presenceFusion.size, 0);
    assert.ok(circlePresenceEstimate(profile, row, "approximate_area", false, { type: "event", id: "ev-1" }));
    assert.equal(revokeEveryCirclePresence(), 1);
    assert.equal(presenceFusion.size, 0);
  });
});

// ══ D. Competition ═══════════════════════════════════════════════════════════
//
// RED WHEN: `competePresence` reorders its criteria, or `resolve` stops
// using it (e.g. reverts to newest-observedAt).

describe("D. how observations of different quality and freshness compete", () => {
  function mint(over: Partial<PresenceClaim>, source: keyof typeof PRESENCE_WRITE_CAPABILITIES = "locate_friends_session"): FusedPresenceEstimate {
    const store = new PresenceFusionStore();
    const scope = source === "circle_presence" ? CIRCLE_X : source === "trip_crew_location_sessions" ? CREW_X : SESSION_A;
    // Minted against the T0 clock: an UNTIMED admission (nowMs null) can never
    // carry a live state — the store downgrades it — so the live case needs a
    // clock to be live against.
    const r = store.admit(PRESENCE_WRITE_CAPABILITIES[source], claim({ scope, ...over }), T0);
    assert.ok(r.ok, `fixture refused: ${!r.ok && r.refusal}`);
    return r.estimate;
  }
  const wins = (a: FusedPresenceEstimate, b: FusedPresenceEstimate, now: number) => {
    const ab = competePresence(a, b, now);
    const ba = competePresence(b, a, now);
    assert.equal(Math.sign(ab), -Math.sign(ba), "the order must be antisymmetric");
    return ab < 0 ? a : b;
  };

  test("1. live beats not-live — a live `nearby` outranks a STRONGER `precise` that has left the window", () => {
    // The case that isolates rule 1 from rule 2: without live-first, state
    // strength would hand the answer to the stale `precise` (6 > 5).
    const stalePrecise = mint({ observedAtMs: T0, state: "precise" }, "circle_presence");
    const liveNearby = mint({ observedAtMs: T0 + 9 * MIN, state: "nearby" });
    const now = T0 + 10 * MIN;
    assert.equal(stalePrecise.live(now), false, "premise: precise, but ten minutes old");
    assert.equal(liveNearby.live(now), true, "premise: nearby, one minute old");
    assert.equal(wins(stalePrecise, liveNearby, now), liveNearby);
    // Read at an instant when BOTH are inside the window (four minutes after
    // the precise fix; the nearby one is not yet observed, which `live` treats
    // as age 0), and strength decides.
    const both = T0 + 4 * MIN;
    assert.equal(stalePrecise.live(both) && liveNearby.live(both), true, "premise: both live at this instant");
    assert.equal(wins(stalePrecise, liveNearby, both), stalePrecise, "both live: `precise` outranks `nearby`");
    // And a newer non-live assertion never outranks a live position.
    const newerStale = mint({ observedAtMs: T0 + 4 * MIN, state: "last_known" }, "circle_presence");
    const live = mint({ observedAtMs: T0, state: "precise" });
    assert.equal(wins(live, newerStale, T0 + 4 * MIN + 1), live);
    const later = T0 + PRESENCE_LIVE_WINDOW_MS + 1;
    assert.equal(live.live(later), false);
    assert.equal(wins(live, newerStale, later), live, "then state strength decides: `precise` outranks `last_known`");
  });

  test("2. state strength beats recency: a `recent` observation outranks a newer `last_known`", () => {
    const recent = mint({ observedAtMs: T0, state: "recent" });
    const lastKnown = mint({ observedAtMs: T0 + 3 * MIN, state: "last_known" }, "circle_presence");
    assert.equal(wins(recent, lastKnown, T0 + 10 * MIN), recent);
    assert.ok(PRESENCE_STATE_STRENGTH.precise > PRESENCE_STATE_STRENGTH.nearby);
    assert.ok(PRESENCE_STATE_STRENGTH.nearby > PRESENCE_STATE_STRENGTH.relayed);
    assert.ok(PRESENCE_STATE_STRENGTH.relayed > PRESENCE_STATE_STRENGTH.recent);
    assert.ok(PRESENCE_STATE_STRENGTH.recent > PRESENCE_STATE_STRENGTH.last_known);
    assert.ok(PRESENCE_STATE_STRENGTH.last_known > PRESENCE_STATE_STRENGTH.inferred);
    assert.equal(PRESENCE_STATE_STRENGTH.inferred, PRESENCE_STATE_STRENGTH.predicted, "two guesses are equally guesses");
    assert.ok(PRESENCE_STATE_STRENGTH.predicted > PRESENCE_STATE_STRENGTH.unknown);
  });

  test("3. same strength: the newer observation wins; an untimed one loses to any timed one", () => {
    const older = mint({ observedAtMs: T0, state: "recent" });
    const newer = mint({ observedAtMs: T0 + 1, state: "recent" }, "circle_presence");
    assert.equal(wins(older, newer, T0 + 10 * MIN), newer);
    const untimed = mint({ observedAtMs: null, state: "unknown" }, "circle_presence");
    const timedUnknown = mint({ observedAtMs: T0 - 50 * MIN, state: "unknown" });
    assert.equal(wins(untimed, timedUnknown, T0), timedUnknown);
  });

  test("4. same clock: higher confidence wins", () => {
    const sure = mint({ observedAtMs: T0, state: "recent", confidence: 0.9 });
    const unsure = mint({ observedAtMs: T0, state: "recent", confidence: 0.3 }, "circle_presence");
    assert.equal(wins(sure, unsure, T0 + 10 * MIN), sure);
  });

  test("5. a total order: identical estimates from two sources fall back to register order, never 0", () => {
    const a = mint({ observedAtMs: T0, state: "recent", confidence: 0.5 }, "circle_presence");
    const b = mint({ observedAtMs: T0, state: "recent", confidence: 0.5 });
    assert.notEqual(competePresence(a, b, T0), 0);
    assert.equal(wins(a, b, T0), a, "circle_presence precedes locate_friends_session in PRESENCE_SOURCES");
  });

  test("`resolve` applies the rule — three candidates: the live one wins, then the strongest, then the newest", () => {
    const store = new PresenceFusionStore();
    const now = T0 + 10 * MIN;
    // Session A: `nearby`, one minute old — LIVE, but not the strongest state.
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_A, observedAtMs: now - 1 * MIN, state: "nearby" }), now);
    // Session B: `precise` when admitted ten minutes ago — the strongest state,
    // no longer live. (Admitted against ITS clock; the store would otherwise
    // have downgraded a ten-minute-old live state to `recent` on entry.)
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_B, observedAtMs: now - 10 * MIN, state: "precise" }), now - 10 * MIN);
    // Circle X: `recent`, two minutes old — newer than B, weaker than B.
    store.admit(PRESENCE_WRITE_CAPABILITIES.circle_presence, claim({ scope: CIRCLE_X, requestedPrecision: "venue", observedAtMs: now - 2 * MIN, state: "recent", point: null }), now);
    const all = aud("precise", SESSION_A, SESSION_B, CIRCLE_X);
    assert.equal(store.resolve("acct-9", "locate_friends_session", all, now)?.scope.id, "session-a", "live wins over a stronger stale state");
    store.revokeScope(SESSION_A);
    assert.equal(store.resolve("acct-9", "locate_friends_session", all, now)?.scope.id, "session-b", "then `precise` beats the newer `recent`");
    store.revokeScope(SESSION_B);
    assert.equal(store.resolve("acct-9", "locate_friends_session", all, now)?.source, "circle_presence", "then whatever is left");
  });

  test("the winner is still re-minted under the asking source's and the audience's ceilings", () => {
    const store = new PresenceFusionStore();
    store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, claim({ scope: SESSION_A }), T0);
    const asCircle = store.resolve("acct-9", "circle_presence", aud("precise", SESSION_A), T0);
    assert.equal(asCircle?.precision, PRESENCE_SOURCE_CONTRACTS.circle_presence.ceiling);
    assert.equal(asCircle?.position, null);
    const narrowViewer = store.resolve("acct-9", "locate_friends_session", aud("zone", SESSION_A), T0);
    assert.equal(narrowViewer?.precision, "zone");
  });
});

// ══ E. The one fused production consumer ═════════════════════════════════════
//
// RED WHEN: `readSessionForViewer` stops calling `fuseMemberView`,
// `circleScopeFor` grants the scope without an `allowed` guard result or
// without a fresh admission, the guard's throw is not caught, or
// `fuseMemberView` renders the store's copy of the session's own source.

function pos(userId: string, over: Partial<PositionRow> = {}): PositionRow {
  return {
    session_id: SESSION, user_id: userId, rung: "network_location", precision: "precise",
    lat: 16.0544, lng: 108.2022, proximity_bucket: null, checkpoint_label: null,
    observed_at: iso(NOW - 30_000), expires_at: iso(NOW + POSITION_TTL_MS), ...over,
  } as PositionRow;
}
function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION, group_scope_kind: "trip", group_scope_id: TRIP, created_by: ALICE,
    started_at: iso(NOW - MIN), expires_at: iso(NOW + 60 * MIN), ended_at: null, ceiling: "precise", label: null, ...over,
  };
}
function member(userId: string) {
  return { session_id: SESSION, user_id: userId, opted_in_at: iso(NOW - MIN), consent_source: "group_join", left_at: null };
}
function locateDb(opts: { positions?: PositionRow[]; session?: SessionRow; failReads?: string[] } = {}) {
  return fakeDb({
    feature_flags: [{ flag: "locate_friends_enabled", enabled: true }],
    [SESSIONS_TABLE]: [opts.session ?? session()],
    [MEMBERS_TABLE]: [member(ALICE), member(BOB)],
    [POSITIONS_TABLE]: opts.positions ?? [],
    profiles: [{ id: BOB, display_name: "Bob" }],
    blocks: [],
    protected_zones: [],
  }, opts.failReads ?? []);
}
/** What Circle's guard says about Bob in a context, as the ROW it read. */
function bobAtVenue(over: Partial<CircleAccessResult> = {}): CircleAccessResult {
  return {
    allowed: true,
    visibilityMode: "venue_checkin",
    isStale: false,
    presenceRow: { id: "p1", status: "arrived", checked_in: true, is_stale: false, updated_at: iso(NOW - 2 * MIN) },
    ...over,
  };
}
/**
 * A fake of `canViewCirclePresenceBatch`: answers per (context, target) from
 * `answers`, records every call, and can be told to throw.
 */
function guard(answers: Record<string, Record<string, CircleAccessResult>> | "throw") {
  const calls: Array<[string, string[], string, string]> = [];
  const deps: FusedReadDeps = {
    circlePresenceBatch: async (_db, viewerId, targets, kind, id) => {
      calls.push([viewerId, [...targets], kind, id]);
      if (answers === "throw") throw new Error("guard unavailable");
      const out = new Map<string, CircleAccessResult>();
      for (const t of targets) {
        const a = answers[`${kind}:${id}`]?.[t];
        out.set(t, a ?? { allowed: false, reason: "viewer_not_member" });
      }
      return out;
    },
  };
  return { deps, calls };
}
/** Another instance admitted Bob's circle row earlier — a retained copy with no fresh row behind it. */
function staleCopyFromAnotherInstance(tripId: string = TRIP) {
  const e = circlePresenceEstimate(
    { userId: BOB, avatarUrl: null, displayName: "Bob", username: "bob" },
    { id: "p0", status: "arrived", checked_in: true, is_stale: false, updated_at: iso(NOW - 3 * MIN) },
    "venue_checkin",
    false,
    { type: "trip", id: tripId },
  );
  assert.ok(e && e.precision === "venue", "fixture: the circle estimate must sit at `venue`");
  return e;
}

describe("E. readSessionForViewer fuses a Circle estimate only through Circle's own guard, per member", () => {
  beforeEach(() => { presenceFusion.clear(); });

  test("a member with no session position is answered by the Circle row the guard allowed", async () => {
    const { deps, calls } = guard({ [`trip:${TRIP}`]: { [BOB]: bobAtVenue() } });
    const r = await readSessionForViewer(locateDb() as any, SESSION, ALICE, NOW, deps);
    assert.equal(r.status, "ok");
    assert.deepEqual(calls, [[ALICE, [BOB], "trip", TRIP]], "the guard is asked for THIS viewer, THESE members, in the session's context");
    const bob = r.members.find((m) => m.memberId === BOB);
    assert.ok(bob);
    assert.equal(bob.fusedFrom, "circle_presence");
    assert.equal(bob.precision, "venue");
    assert.equal(bob.estimateState, "recent");
    assert.equal(bob.live, false);
    assert.equal(bob.position, null);
    assert.equal(bob.ring, null);
    assert.equal(bob.displayName, null, "§23: no identity below `approximate`");
    assert.equal(bob.ageSeconds, 120);
    assert.equal(presenceFusion.size, 1, "the store was refreshed from the row under the circle scope");
  });

  test("DENIED: the guard refuses (viewer not a member, paused, blocked, kill switch…) — no scope, nothing served", async () => {
    staleCopyFromAnotherInstance();
    for (const reason of ["viewer_not_member", "target_not_member", "paused", "blocked", "kill_switch", "unavailable"]) {
      const { deps } = guard({ [`trip:${TRIP}`]: { [BOB]: { allowed: false, reason } } });
      const r = await readSessionForViewer(locateDb() as any, SESSION, ALICE, NOW, deps);
      assert.deepEqual(r.members, [notSharing(BOB)], reason);
    }
    // A refusal that still CARRIES the row (a guard may return what it read
    // for audit) is a refusal. `allowed` decides; the row's presence does not.
    const { deps } = guard({ [`trip:${TRIP}`]: { [BOB]: bobAtVenue({ allowed: false, reason: "paused" }) } });
    const r = await readSessionForViewer(locateDb() as any, SESSION, ALICE, NOW, deps);
    assert.deepEqual(r.members, [notSharing(BOB)], "a denied result with a row attached");
  });

  test("DENIED, fail-closed: a guard that throws grants nobody anything, and the read still answers", async () => {
    staleCopyFromAnotherInstance();
    const { deps } = guard("throw");
    const r = await readSessionForViewer(locateDb() as any, SESSION, ALICE, NOW, deps);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.members, [notSharing(BOB)]);
  });

  test("DENIED: the session is attached to ANOTHER trip — the guard is asked about THAT trip", async () => {
    staleCopyFromAnotherInstance(TRIP);
    const { deps, calls } = guard({ [`trip:${TRIP}`]: { [BOB]: bobAtVenue() } });
    const r = await readSessionForViewer(locateDb({ session: session({ group_scope_id: TRIP2 }) }) as any, SESSION, ALICE, NOW, deps);
    assert.deepEqual(calls, [[ALICE, [BOB], "trip", TRIP2]]);
    assert.deepEqual(r.members, [notSharing(BOB)]);
  });

  test("a session attached to a `circle` or `plan` scope has no Circle context — the guard is not even asked", async () => {
    staleCopyFromAnotherInstance();
    for (const kind of ["circle", "plan"]) {
      const { deps, calls } = guard({ [`trip:${TRIP}`]: { [BOB]: bobAtVenue() } });
      const r = await readSessionForViewer(locateDb({ session: session({ group_scope_kind: kind }) }) as any, SESSION, ALICE, NOW, deps);
      assert.deepEqual(calls, [], kind);
      assert.deepEqual(r.members, [notSharing(BOB)], kind);
    }
  });

  test("MULTI-PROCESS: a retained copy with no current row behind it is NOT served — allowed, but nothing to admit", async () => {
    staleCopyFromAnotherInstance();
    const { deps } = guard({ [`trip:${TRIP}`]: { [BOB]: bobAtVenue({ presenceRow: null }) } });
    const r = await readSessionForViewer(locateDb() as any, SESSION, ALICE, NOW, deps);
    assert.deepEqual(r.members, [notSharing(BOB)], "the scope is granted only on a fresh admission");
  });

  test("a `precise_live` visibility mode is skipped, as the members route skips it", async () => {
    const { deps } = guard({ [`trip:${TRIP}`]: { [BOB]: bobAtVenue({ visibilityMode: "precise_live" }) } });
    const r = await readSessionForViewer(locateDb() as any, SESSION, ALICE, NOW, deps);
    assert.deepEqual(r.members, [notSharing(BOB)]);
  });

  test("the session's own live position answers over the Circle, with its full geometry", async () => {
    const { deps } = guard({ [`trip:${TRIP}`]: { [BOB]: bobAtVenue() } });
    const r = await readSessionForViewer(locateDb({ positions: [pos(BOB)] }) as any, SESSION, ALICE, NOW, deps);
    const bob = r.members[0];
    assert.equal(bob.fusedFrom, null);
    assert.equal(bob.precision, "precise");
    assert.ok(bob.position);
    assert.equal(bob.live, true);
    assert.equal(bob.displayName, "Bob");
  });

  test("REVOCATION: after the member pauses the context, the same read serves nothing — in this instance AND in another", async () => {
    const allowed = guard({ [`trip:${TRIP}`]: { [BOB]: bobAtVenue() } });
    const before = await readSessionForViewer(locateDb() as any, SESSION, ALICE, NOW, allowed.deps);
    assert.equal(before.members[0].fusedFrom, "circle_presence");
    // The instance that handled the pause: the route revokes the store's copy,
    // and the guard now answers `paused`.
    assert.equal(revokeCirclePresence(BOB, "trip", TRIP), 1);
    const paused = guard({ [`trip:${TRIP}`]: { [BOB]: { allowed: false, reason: "paused" } } });
    const after = await readSessionForViewer(locateDb() as any, SESSION, ALICE, NOW, paused.deps);
    assert.deepEqual(after.members, [notSharing(BOB)]);
    // Another instance: its copy was NOT revoked, but its guard reads the same
    // rows, so it answers the same way.
    staleCopyFromAnotherInstance();
    const elsewhere = await readSessionForViewer(locateDb() as any, SESSION, ALICE, NOW, paused.deps);
    assert.deepEqual(elsewhere.members, [notSharing(BOB)]);
  });

  test("the §24 policy unreadable: no fusion at all — the guard is not asked, nothing is served", async () => {
    const { deps, calls } = guard({ [`trip:${TRIP}`]: { [BOB]: bobAtVenue() } });
    const r = await readSessionForViewer(locateDb({ positions: [pos(BOB)], failReads: ["protected_zones"] }) as any, SESSION, ALICE, NOW, deps);
    assert.deepEqual(calls, []);
    assert.deepEqual(r.members, [notSharing(BOB)]);
  });

  test("the store's RETAINED copy of the session's own source never resurrects a position the current read refused", () => {
    projectMember({ memberId: BOB, displayName: "Bob", sessionId: SESSION, position: pos(BOB), sessionCeiling: "precise", zones: [], nowMs: NOW });
    const audience: PresenceAudience = aud("precise", locateSessionScope(SESSION));
    assert.ok(presenceFusion.resolve(BOB, "locate_friends_session", audience, NOW), "premise: the copy is retained");
    const own = notSharing(BOB);
    assert.deepEqual(fuseMemberView(own, BOB, SESSION, audience, NOW), own);
  });

  test("circleContextOf: trip and event sessions have a Circle context; circle, plan and a blank id do not", () => {
    assert.deepEqual(circleContextOf(session()), { type: "trip", id: TRIP });
    assert.deepEqual(circleContextOf(session({ group_scope_kind: "event", group_scope_id: "ev-1" })), { type: "event", id: "ev-1" });
    assert.equal(circleContextOf(session({ group_scope_kind: "circle" })), null);
    assert.equal(circleContextOf(session({ group_scope_kind: "plan" })), null);
    assert.equal(circleContextOf(session({ group_scope_id: "  " })), null);
  });

  test("circleScopeFor: the scope exists only for an allowed result whose row admits", () => {
    const ctx = { type: "trip", id: TRIP };
    assert.deepEqual(circleScopeFor(BOB, ctx, bobAtVenue()), circleConsentScope("trip", TRIP));
    assert.equal(circleScopeFor(BOB, ctx, null), null);
    assert.equal(circleScopeFor(BOB, ctx, { allowed: false, reason: "paused" }), null);
    assert.equal(circleScopeFor(BOB, ctx, bobAtVenue({ allowed: false, reason: "paused" })), null, "denied, row attached");
    assert.equal(circleScopeFor(BOB, ctx, bobAtVenue({ presenceRow: null })), null);
    assert.equal(circleScopeFor(BOB, ctx, bobAtVenue({ visibilityMode: "precise_live" })), null);
    // A guard result that says allowed but carries a mode the ceiling table
    // does not know folds to `none` — the store refuses, so no scope.
    assert.equal(circleScopeFor(BOB, ctx, bobAtVenue({ visibilityMode: "everything" })), null);
  });

  test("the default dependency IS Circle's guard — not a stub, not a re-implementation", () => {
    assert.equal(DEFAULT_FUSED_READ_DEPS.circlePresenceBatch, canViewCirclePresenceBatch);
  });
});

// ── crew fixture ──────────────────────────────────────────────────────────────
function sharer(): RawMemberLocation {
  return {
    userId: BOB,
    name: "Sharer",
    handle: "sharer",
    avatarUrl: null,
    prefs: { defaultVisibility: "neighborhood", ghostModeEnabled: false, shareArrivalStatus: true, shareSafeReturnStatus: false },
    locationState: {
      city: "Cebu City", district: "IT Park", country: "PH",
      updatedAt: iso(NOW - MIN), lastKnownAt: iso(NOW - MIN), source: "gps", accuracyMeters: 20,
      lat: 10.3273, lng: 123.9057,
    },
    hotelBlurEnabled: false,
    checkInStatus: null,
    hasSafeReturnActive: false,
    liveShare: { id: "sess-1", visibilityLevel: "nearby", expiresAt: iso(NOW + 30 * MIN) },
  };
}
