/**
 * census-layover L166 / L203 (B58 lane LAY-C1) — the crew location grant store
 * (3787, ported from PR #569) and the decision over it.
 *
 *   L166 "Precise crew sharing: separate explicit control, off by default"
 *   L203 "Crew membership/location rows require membership and explicit permission"
 *
 * Owner questions OQ-1 (audience) and OQ-2 (duration) are OPEN; what is tested
 * here is the fail-closed default this lane implements, not an approved policy:
 *   OQ-1 — precise only to a CURRENT member of the SAME crew, no block either
 *          way (an unreadable OR THROWN block read = not shared), a live grant
 *          from the target, AND a mutual follow (D-103's shape);
 *   OQ-2 — no invented ceiling: bounded by the crew's life and the certified
 *          hard return, ended by the first §14.1 terminator; airport re-entry
 *          read from 2992's checkpoints, unreadable/absent = NOT active.
 *
 * WHAT THIS DOES NOT PROVE. `fakeLayoverDb` models no RLS, no unique index and
 * no foreign keys; the database half (RLS, the four restrictive denials, the
 * CHECKs, the cascades) is src/test/db/layoverCrewLocationGrants.db.test.ts on
 * real PostgreSQL. Its `.or()` is a no-op, which is why the block read under
 * test is the `among`-scoped one (two `.in()` reads), the one this module uses.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/layover/__tests__/layoverCrewLocationShare.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "../../../test/helpers/fakeLayoverDb.js";
import {
  GRANT_READ_LIMIT,
  MAX_GRANTS_PER_MEMBER,
  boundedGrantWindow,
  grantCrewLocation,
  newestGrantsForCrew,
  revokeCrewLocation,
  revokeCrewLocationGrantsForCrew,
  type MemberGrant,
} from "../LayoverCrewLocationGrantStore.js";
import {
  CREW_LOCATION_SHARING_FLAG,
  crewOwnLocationShare,
  memberShareState,
  preciseCrewLocationVisible,
  reentryAfter,
  type MemberShareFacts,
} from "../LayoverCrewLocationShare.js";
import { locationPrecisionFor } from "../../airport/LayoverCrewService.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const CREW = "crew-1";
const V = "user-viewer";
const T = "user-target";
const X = "user-stranger";
const S_V = "session-viewer";
const S_T = "session-target";
const JOINED = iso(NOW - 60 * MIN);

// ── pure: memberShareState ────────────────────────────────────────────────────

function held(over: Partial<MemberGrant["grant"]> & { revokedAtMs?: number | null; sessionId?: string } = {}): MemberGrant {
  return {
    grant: {
      grantedByUserId: over.grantedByUserId ?? T,
      crewId: over.crewId ?? CREW,
      grantedAtMs: over.grantedAtMs ?? NOW - 30 * MIN,
      expiresAtMs: over.expiresAtMs ?? NOW + 90 * MIN,
    },
    revokedAtMs: over.revokedAtMs ?? null,
    sessionId: over.sessionId ?? S_T,
  };
}

function facts(over: Partial<MemberShareFacts> = {}): MemberShareFacts {
  return {
    held: held(),
    crew: { id: CREW, status: "open" },
    membership: { sessionId: S_T, joinedAt: JOINED },
    session: { id: S_T, status: "active", boardingTime: null },
    hardReturnMs: NOW + 120 * MIN,
    reentry: { ok: true, atMs: null },
    sharingAllowed: true,
    ...over,
  };
}

describe("memberShareState — a share is in force only while EVERY condition holds", () => {
  it("the positive control: a live, scoped grant from a live member is in force, ending at its earliest known end", () => {
    const s = memberShareState(facts(), NOW);
    assert.equal(s.active, true);
    assert.equal(s.reason, "live_scoped_grant");
    assert.equal(s.endsAtMs, NOW + 90 * MIN, "the grant's own expiry is earlier than the hard return");
    const tighter = memberShareState(facts({ hardReturnMs: NOW + 40 * MIN }), NOW);
    assert.equal(tighter.endsAtMs, NOW + 40 * MIN, "a hard return earlier than the grant's expiry is the end");
    const boarding = memberShareState(facts({ session: { id: S_T, status: "active", boardingTime: iso(NOW + 20 * MIN) } }), NOW);
    assert.equal(boarding.endsAtMs, NOW + 20 * MIN, "a scheduled boarding earlier than both is the end");
  });

  it("no grant is never_granted — never 'expired'", () => {
    assert.deepEqual(memberShareState(facts({ held: null }), NOW), { active: false, reason: "no_live_grant:never_granted", endsAtMs: null });
  });

  it("a grant for ANOTHER crew is not a grant for this one", () => {
    assert.equal(memberShareState(facts({ held: held({ crewId: "crew-2" }) }), NOW).active, false);
  });

  it("an unreadable newest grant is not in force (grant_unreadable)", () => {
    const bad = held({ grantedAtMs: Number.NaN });
    assert.deepEqual(memberShareState(facts({ held: bad }), NOW), { active: false, reason: "grant_unreadable", endsAtMs: null });
  });

  const terminators: Array<[string, Partial<MemberShareFacts>, string]> = [
    ["revoked", { held: held({ revokedAtMs: NOW - MIN }) }, "no_live_grant:user_revoked"],
    ["TTL elapsed", { held: held({ expiresAtMs: NOW - MIN }) }, "no_live_grant:ttl_elapsed"],
    ["boarding passed", { session: { id: S_T, status: "active", boardingTime: iso(NOW - MIN) } }, "no_live_grant:boarding"],
    ["session no longer live", { session: { id: S_T, status: "completed", boardingTime: null } }, "no_live_grant:session_expired"],
    ["crew disbanded", { crew: { id: CREW, status: "disbanded" } }, "no_live_grant:crew_dissolved"],
    ["crew closed (no writer today; read as ended)", { crew: { id: CREW, status: "closed" } }, "no_live_grant:crew_dissolved"],
    ["airport re-entry after the grant", { reentry: { ok: true, atMs: NOW - 5 * MIN } }, "no_live_grant:airport_reentry"],
  ];
  for (const [name, over, reason] of terminators) {
    it(`§14.1 terminator — ${name} ends it (${reason})`, () => {
      const s = memberShareState(facts(over), NOW);
      assert.equal(s.active, false);
      assert.equal(s.reason, reason);
      assert.equal(s.endsAtMs, null);
    });
  }

  const failClosed: Array<[string, Partial<MemberShareFacts>, string]> = [
    ["the granter is no longer a member", { membership: null }, "not_a_member"],
    ["the grant came from another session than the membership's", { membership: { sessionId: "session-other", joinedAt: JOINED } }, "session_not_in_crew"],
    ["the membership's join time cannot be read", { membership: { sessionId: S_T, joinedAt: null } }, "membership_unreadable"],
    ["the grant PREDATES the current membership (rejoin / restore never restarts it)", { membership: { sessionId: S_T, joinedAt: iso(NOW - 10 * MIN) } }, "granted_before_membership"],
    ["the granter's session cannot be read", { session: null }, "session_unreadable"],
    ["airport re-entry cannot be verified (2992 absent, off or unreadable)", { reentry: { ok: false } }, "reentry_unverifiable"],
    ["the granter is uncertified", { hardReturnMs: null }, "uncertified"],
    ["the CURRENT certified hard return has passed", { hardReturnMs: NOW - MIN }, "hard_return_passed"],
    ["sharing is paused / off / ghost mode, or unreadable", { sharingAllowed: false }, "sharing_gate_closed"],
  ];
  for (const [name, over, reason] of failClosed) {
    it(`fail-closed — ${name} (${reason})`, () => {
      assert.deepEqual(memberShareState(facts(over), NOW), { active: false, reason, endsAtMs: null });
    });
  }
});

describe("reentryAfter — 2992's checkpoints, read for the AIRPORT_REENTRY terminator", () => {
  const cp = (type: string, at: number | string) => ({ id: `cp-${type}-${at}`, type, observedAt: typeof at === "number" ? iso(at) : at, source: "TRAVELLER", confidence: "MEDIUM" });
  it("the first re-entry at or after the grant; one before it ended an earlier outing", () => {
    const r = reentryAfter({ ok: true, checkpoints: [cp("AIRPORT_REENTRY", NOW - 50 * MIN), cp("LANDSIDE_EXIT", NOW - 40 * MIN), cp("AIRPORT_REENTRY", NOW - 10 * MIN), cp("AIRPORT_REENTRY", NOW - 20 * MIN)] }, NOW - 30 * MIN);
    assert.deepEqual(r, { ok: true, atMs: NOW - 20 * MIN });
    assert.deepEqual(reentryAfter({ ok: true, checkpoints: [cp("AIRPORT_REENTRY", NOW - 50 * MIN)] }, NOW - 30 * MIN), { ok: true, atMs: null });
  });
  it("a re-entry AT the grant instant counts (>=)", () => {
    assert.deepEqual(reentryAfter({ ok: true, checkpoints: [cp("AIRPORT_REENTRY", NOW - 30 * MIN)] }, NOW - 30 * MIN), { ok: true, atMs: NOW - 30 * MIN });
  });
  it("persistence disabled, a failed read, or an unreadable observation are UNVERIFIABLE", () => {
    assert.deepEqual(reentryAfter({ ok: false, reason: "persistence_disabled" }, NOW), { ok: false });
    assert.deepEqual(reentryAfter({ ok: false, reason: "read_failed" }, NOW), { ok: false });
    assert.deepEqual(reentryAfter({ ok: true, checkpoints: [cp("AIRPORT_REENTRY", "not-a-time")] }, NOW), { ok: false });
  });
});

describe("boundedGrantWindow — OQ-2: no invented ceiling, only the crew's life and the certified hard return", () => {
  const crewExp = iso(NOW + 300 * MIN);
  it("omitted = the derived ceiling, min(crew expiry, hard return)", () => {
    assert.deepEqual(boundedGrantWindow({ nowMs: NOW, requestedExpiresAtMs: null, crewExpiresAtIso: crewExp, granterHardReturnMs: NOW + 120 * MIN }), { ok: true, grantedAtMs: NOW, expiresAtMs: NOW + 120 * MIN });
    assert.deepEqual(boundedGrantWindow({ nowMs: NOW, requestedExpiresAtMs: null, crewExpiresAtIso: iso(NOW + 60 * MIN), granterHardReturnMs: NOW + 120 * MIN }), { ok: true, grantedAtMs: NOW, expiresAtMs: NOW + 60 * MIN });
  });
  it("a shorter request is honoured; a longer one is CLAMPED", () => {
    assert.equal((boundedGrantWindow({ nowMs: NOW, requestedExpiresAtMs: NOW + 30 * MIN, crewExpiresAtIso: crewExp, granterHardReturnMs: NOW + 120 * MIN }) as any).expiresAtMs, NOW + 30 * MIN);
    assert.equal((boundedGrantWindow({ nowMs: NOW, requestedExpiresAtMs: NOW + 9_999 * MIN, crewExpiresAtIso: crewExp, granterHardReturnMs: NOW + 120 * MIN }) as any).expiresAtMs, NOW + 120 * MIN);
  });
  it("refused: no time left, a past request, an unreadable crew expiry, an uncertified granter", () => {
    assert.equal(boundedGrantWindow({ nowMs: NOW, requestedExpiresAtMs: null, crewExpiresAtIso: crewExp, granterHardReturnMs: NOW }).ok, false);
    assert.equal(boundedGrantWindow({ nowMs: NOW, requestedExpiresAtMs: NOW - MIN, crewExpiresAtIso: crewExp, granterHardReturnMs: NOW + 120 * MIN }).ok, false);
    assert.equal(boundedGrantWindow({ nowMs: NOW, requestedExpiresAtMs: null, crewExpiresAtIso: "garbage", granterHardReturnMs: NOW + 120 * MIN }).ok, false);
    assert.equal(boundedGrantWindow({ nowMs: NOW, requestedExpiresAtMs: null, crewExpiresAtIso: crewExp, granterHardReturnMs: null }).ok, false);
  });
});

// ── the store, over the fake ──────────────────────────────────────────────────

function grantRow(over: Record<string, any> = {}) {
  return {
    id: over.id ?? `g-${Math.random().toString(36).slice(2, 8)}`,
    crew_id: CREW,
    granted_by_user_id: T,
    session_id: S_T,
    granted_at: iso(NOW - 30 * MIN),
    expires_at: iso(NOW + 90 * MIN),
    revoked_at: null,
    ...over,
  };
}

describe("newestGrantsForCrew — the newest row per member, revoked or not; a failed read is a refusal", () => {
  it("newest-first wins, and a REVOKED newest is read (user_revoked), not skipped to an older live one", async () => {
    const db = makeLayoverDb({
      layover_crew_location_grants: [
        grantRow({ id: "old-live", granted_at: iso(NOW - 50 * MIN) }),
        grantRow({ id: "new-revoked", granted_at: iso(NOW - 20 * MIN), revoked_at: iso(NOW - 10 * MIN) }),
      ],
    });
    const r = await newestGrantsForCrew(db, CREW);
    assert.ok(r.ok);
    const h = r.value.get(T)!;
    assert.equal(h.revokedAtMs, NOW - 10 * MIN);
    assert.equal(h.grant.grantedAtMs, NOW - 20 * MIN);
    assert.equal(h.sessionId, S_T);
  });

  it("an UNREADABLE newest row still supersedes an older readable grant (it is not revived)", async () => {
    const db = makeLayoverDb({
      layover_crew_location_grants: [
        grantRow({ id: "old-live", granted_at: iso(NOW - 50 * MIN) }),
        grantRow({ id: "new-bad", granted_at: iso(NOW - 20 * MIN), expires_at: "not-a-time" }),
      ],
    });
    const r = await newestGrantsForCrew(db, CREW);
    assert.ok(r.ok);
    const s = memberShareState(facts({ held: r.value.get(T)! }), NOW);
    assert.equal(s.active, false);
    assert.equal(s.reason, "grant_unreadable");
  });

  it("an unreadable table is { ok: false }, never an empty map", async () => {
    const db = makeLayoverDb({}, { failures: { "layover_crew_location_grants:select": { message: "boom" } } });
    assert.deepEqual(await newestGrantsForCrew(db, CREW), { ok: false, reason: "read_failed" });
  });

  it("the per-member cap is the read limit shared by the largest crew, so no member's newest grant is ever cut", () => {
    assert.equal(MAX_GRANTS_PER_MEMBER * 12, GRANT_READ_LIMIT);
  });
});

describe("grantCrewLocation — L203: membership is READ before any write", () => {
  const member = (over: Record<string, any> = {}) => ({ crew_id: CREW, user_id: T, session_id: S_T, role: "member", joined_at: JOINED, left_at: null, ...over });
  const input = { crewId: CREW, grantedByUserId: T, sessionId: S_T, grantedAtMs: NOW, expiresAtMs: NOW + 60 * MIN };

  it("a live member, from the crew's session: one row, the window as given", async () => {
    const tables: Record<string, any[]> = { layover_crew_members: [member()], layover_crew_location_grants: [] };
    const r = await grantCrewLocation(makeLayoverDb(tables), input);
    assert.ok(r.ok);
    assert.equal(r.value.alreadyGranted, false);
    assert.equal(tables.layover_crew_location_grants.length, 1);
    const row = tables.layover_crew_location_grants[0];
    assert.deepEqual([row.crew_id, row.granted_by_user_id, row.session_id, row.granted_at, row.expires_at], [CREW, T, S_T, iso(NOW), iso(NOW + 60 * MIN)]);
    for (const k of ["lat", "lng", "latitude", "longitude", "location"]) assert.equal(k in row, false, `the grant row carries ${k}`);
  });

  it("not a member, a member who LEFT, or a member from another session: refused, nothing written", async () => {
    for (const [members, reason] of [
      [[], "not_a_member"],
      [[member({ left_at: iso(NOW - MIN) })], "not_a_member"],
      [[member({ session_id: "session-other" })], "session_not_in_crew"],
    ] as const) {
      const tables: Record<string, any[]> = { layover_crew_members: [...members], layover_crew_location_grants: [] };
      const r = await grantCrewLocation(makeLayoverDb(tables), input);
      assert.deepEqual(r, { ok: false, reason });
      assert.equal(tables.layover_crew_location_grants.length, 0);
    }
  });

  it("an unreadable membership or grant history refuses the grant and writes nothing", async () => {
    for (const fail of ["layover_crew_members:select", "layover_crew_location_grants:select"]) {
      const tables: Record<string, any[]> = { layover_crew_members: [member()], layover_crew_location_grants: [] };
      const r = await grantCrewLocation(makeLayoverDb(tables, { failures: { [fail]: { message: "boom" } } }), input);
      assert.deepEqual(r, { ok: false, reason: "read_failed" }, fail);
      assert.equal(tables.layover_crew_location_grants.length, 0, fail);
    }
  });

  it("a double tap is ONE act of consent: an unrevoked, unexpired newest grant is returned, nothing written", async () => {
    const tables: Record<string, any[]> = { layover_crew_members: [member()], layover_crew_location_grants: [grantRow({ id: "live" })] };
    const r = await grantCrewLocation(makeLayoverDb(tables), input);
    assert.ok(r.ok);
    assert.equal(r.value.alreadyGranted, true);
    assert.equal(r.value.id, "live");
    assert.equal(tables.layover_crew_location_grants.length, 1);
  });

  it("after a revocation or an expiry a NEW row is written (re-granting works)", async () => {
    for (const prior of [grantRow({ revoked_at: iso(NOW - MIN) }), grantRow({ expires_at: iso(NOW - MIN) })]) {
      const tables: Record<string, any[]> = { layover_crew_members: [member()], layover_crew_location_grants: [prior] };
      const r = await grantCrewLocation(makeLayoverDb(tables), input);
      assert.ok(r.ok);
      assert.equal(r.value.alreadyGranted, false);
      assert.equal(tables.layover_crew_location_grants.length, 2);
    }
  });

  it("MAX_GRANTS_PER_MEMBER rows already: refused (too_many_grants), nothing written", async () => {
    const rows = Array.from({ length: MAX_GRANTS_PER_MEMBER }, (_, i) => grantRow({ id: `r${i}`, granted_at: iso(NOW - (i + 2) * MIN), revoked_at: iso(NOW - (i + 1) * MIN) }));
    const tables: Record<string, any[]> = { layover_crew_members: [member()], layover_crew_location_grants: rows };
    assert.deepEqual(await grantCrewLocation(makeLayoverDb(tables), input), { ok: false, reason: "too_many_grants" });
    assert.equal(tables.layover_crew_location_grants.length, MAX_GRANTS_PER_MEMBER);
  });
});

describe("revocation — every unrevoked grant, a count not a failure, an absent store is nothing to revoke", () => {
  it("revokes EVERY unrevoked row the member holds (scoped to a crew, or to all crews), and leaves others' rows alone", async () => {
    const tables: Record<string, any[]> = {
      layover_crew_location_grants: [
        grantRow({ id: "a" }),
        grantRow({ id: "b", granted_at: iso(NOW - 60 * MIN) }),
        grantRow({ id: "c", crew_id: "crew-2" }),
        grantRow({ id: "d", granted_by_user_id: V, session_id: S_V }),
        grantRow({ id: "e", revoked_at: iso(NOW - 2 * MIN) }),
      ],
    };
    const db = makeLayoverDb(tables);
    const scoped = await revokeCrewLocation(db, { userId: T, crewId: CREW }, iso(NOW));
    assert.deepEqual(scoped, { ok: true, value: { revoked: 2, storeAbsent: false } });
    const byId = (id: string) => tables.layover_crew_location_grants.find((r) => r.id === id)!;
    assert.equal(byId("a").revoked_at, iso(NOW));
    assert.equal(byId("b").revoked_at, iso(NOW));
    assert.equal(byId("c").revoked_at, null, "another crew is untouched by a crew-scoped revoke");
    assert.equal(byId("d").revoked_at, null, "another member's grant is untouched");
    assert.equal(byId("e").revoked_at, iso(NOW - 2 * MIN), "an earlier revocation keeps its instant");
    const all = await revokeCrewLocation(db, { userId: T }, iso(NOW + MIN));
    assert.deepEqual(all, { ok: true, value: { revoked: 1, storeAbsent: false } });
    assert.equal(byId("c").revoked_at, iso(NOW + MIN));
  });

  it("a failed write is a failure (the share may still be live); 42P01/PGRST205 is an absent store with nothing in it", async () => {
    const failed = makeLayoverDb({}, { failures: { "layover_crew_location_grants:update": { message: "timeout", code: "57014" } } });
    assert.deepEqual(await revokeCrewLocation(failed, { userId: T }, iso(NOW)), { ok: false, reason: "write_failed" });
    for (const code of ["42P01", "PGRST205"]) {
      const absent = makeLayoverDb({}, { failures: { "layover_crew_location_grants:update": { message: "relation does not exist", code } } });
      assert.deepEqual(await revokeCrewLocation(absent, { userId: T }, iso(NOW)), { ok: true, value: { revoked: 0, storeAbsent: true } });
      assert.deepEqual(await revokeCrewLocationGrantsForCrew(absent, CREW, iso(NOW)), { ok: true, value: { revoked: 0, storeAbsent: true } });
    }
  });

  it("a disbanding crew revokes every member's grant in it, and no other crew's", async () => {
    const tables: Record<string, any[]> = { layover_crew_location_grants: [grantRow({ id: "t" }), grantRow({ id: "v", granted_by_user_id: V, session_id: S_V }), grantRow({ id: "o", crew_id: "crew-2" })] };
    assert.deepEqual(await revokeCrewLocationGrantsForCrew(makeLayoverDb(tables), CREW, iso(NOW)), { ok: true, value: { revoked: 2, storeAbsent: false } });
    assert.deepEqual(tables.layover_crew_location_grants.map((r) => [r.id, r.revoked_at]), [["t", iso(NOW)], ["v", iso(NOW)], ["o", null]]);
  });
});

// ── the composed reads: yourShare and the OQ-1 audience ───────────────────────

function hardReturnRecord(ms: number) {
  return { deadline: { hardReturnTime: new Date(ms) } } as any;
}

function world(opts: {
  sharing?: boolean;
  persistence?: boolean;
  grants?: Record<string, any>[];
  checkpoints?: Record<string, any>[];
  blocks?: Record<string, any>[];
  follows?: Array<[string, string]>;
  prefs?: Record<string, any>[];
  failures?: Record<string, { message: string; code?: string }>;
  throwOn?: string;
} = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: CREW_LOCATION_SHARING_FLAG, enabled: opts.sharing ?? true },
      { flag: "layover_decision_persistence_enabled", enabled: opts.persistence ?? true },
    ],
    layover_crew_location_grants: opts.grants ?? [grantRow()],
    layover_checkpoints: (opts.checkpoints ?? []).map((c) => ({ expires_at: iso(NOW + 600 * MIN), ...c })),
    blocks: opts.blocks ?? [],
    user_follows: (opts.follows ?? [[V, T], [T, V]]).map(([a, b]) => ({ follower_id: a, following_id: b })),
    location_preferences: opts.prefs ?? [],
    trip_crew_location_preferences: [],
  };
  const fake = makeLayoverDb(tables, { failures: opts.failures ?? {} });
  const db = opts.throwOn
    ? { ...fake, from: (t: string) => { if (t === opts.throwOn) throw new Error(`thrown read on ${t}`); return fake.from(t); } }
    : fake;
  return { tables, db: db as any };
}

const members = [
  { userId: V, sessionId: S_V, role: "owner", joinedAt: JOINED },
  { userId: T, sessionId: S_T, role: "member", joinedAt: JOINED },
];
const solved = [
  { userId: V, sessionId: S_V, record: hardReturnRecord(NOW + 150 * MIN) },
  { userId: T, sessionId: S_T, record: hardReturnRecord(NOW + 120 * MIN) },
];
const sessionsById = new Map([
  [S_V, { id: S_V, status: "active", boardingTime: null, tripId: null }],
  [S_T, { id: S_T, status: "active", boardingTime: null, tripId: null }],
]);
const crew = { id: CREW, status: "open" };
const audience = (db: any, over: Record<string, any> = {}) =>
  preciseCrewLocationVisible(db, { viewerId: V, targetId: T, crew, members, solved: solved as any, sessionsById, nowMs: NOW, ...over });

describe("preciseCrewLocationVisible — OQ-1's fail-closed default: same crew, no block either way, a live grant from the target, AND mutual", () => {
  it("the positive control: every gate passes, and the ladder itself says precise", async () => {
    const { db } = world();
    assert.deepEqual(await audience(db), { visible: true, reason: "live_scoped_grant" });
  });

  it("flag OFF (the seed), or the flag row absent: nobody sees anybody, and nothing else is read", async () => {
    for (const w of [world({ sharing: false }), (() => { const x = world(); x.tables.feature_flags = []; return x; })()]) {
      const reads: string[] = [];
      const spy = { ...w.db, from: (t: string) => { reads.push(t); return w.db.from(t); } };
      assert.deepEqual(await audience(spy), { visible: false, reason: "feature_off" });
      assert.deepEqual(reads, ["feature_flags"]);
    }
  });

  it("never to a non-member: a stranger, a target outside the crew, or a crew that is not open", async () => {
    const { db } = world();
    assert.deepEqual(await audience(db, { viewerId: X }), { visible: false, reason: "not_in_a_crew_together" });
    assert.deepEqual(await audience(db, { targetId: X }), { visible: false, reason: "not_in_a_crew_together" });
    assert.deepEqual(await audience(db, { crew: { id: CREW, status: "disbanded" } }), { visible: false, reason: "not_in_a_crew_together" });
  });

  it("a block in EITHER direction hides it", async () => {
    assert.deepEqual(await audience(world({ blocks: [{ blocker_id: V, blocked_id: T }] }).db), { visible: false, reason: "blocked" });
    assert.deepEqual(await audience(world({ blocks: [{ blocker_id: T, blocked_id: V }] }).db), { visible: false, reason: "blocked" });
  });

  it("an UNREADABLE or THROWN block read is not shared — never 'nobody is blocked'", async () => {
    assert.deepEqual(await audience(world({ failures: { "blocks:select": { message: "boom" } } }).db), { visible: false, reason: "blocks_unreadable" });
    assert.deepEqual(await audience(world({ throwOn: "blocks" }).db), { visible: false, reason: "blocks_unreadable" });
  });

  it("D-103: a ONE-WAY follow either way is not mutual; an unread edge is no edge", async () => {
    assert.deepEqual(await audience(world({ follows: [[V, T]] }).db), { visible: false, reason: "not_mutual" });
    assert.deepEqual(await audience(world({ follows: [[T, V]] }).db), { visible: false, reason: "not_mutual" });
    assert.deepEqual(await audience(world({ follows: [] }).db), { visible: false, reason: "not_mutual" });
    assert.deepEqual(await audience(world({ failures: { "user_follows:select": { message: "boom" } } }).db), { visible: false, reason: "follows_unreadable" });
    assert.deepEqual(await audience(world({ throwOn: "user_follows" }).db), { visible: false, reason: "follows_unreadable" });
  });

  it("the grant must be the TARGET's, live, and readable", async () => {
    assert.deepEqual(await audience(world({ grants: [] }).db), { visible: false, reason: "no_live_grant:never_granted" });
    assert.deepEqual(await audience(world({ grants: [grantRow({ granted_by_user_id: V, session_id: S_V })] }).db), { visible: false, reason: "no_live_grant:never_granted" }, "the VIEWER's own grant shows nobody the target");
    assert.deepEqual(await audience(world({ grants: [grantRow({ revoked_at: iso(NOW - MIN) })] }).db), { visible: false, reason: "no_live_grant:user_revoked" });
    assert.deepEqual(await audience(world({ failures: { "layover_crew_location_grants:select": { message: "boom" } } }).db), { visible: false, reason: "location_grants_unreadable" });
  });

  it("airport re-entry: after the grant ends it; persistence OFF (2992 not stored) or an unreadable store is NOT shared", async () => {
    assert.deepEqual(
      await audience(world({ checkpoints: [{ id: "c1", session_id: S_T, checkpoint_type: "AIRPORT_REENTRY", observed_at: iso(NOW - 5 * MIN), source: "TRAVELLER", confidence: "MEDIUM" }] }).db),
      { visible: false, reason: "no_live_grant:airport_reentry" },
    );
    assert.deepEqual(await audience(world({ persistence: false }).db), { visible: false, reason: "reentry_unverifiable" });
    assert.deepEqual(await audience(world({ failures: { "layover_checkpoints:select": { message: "boom" } } }).db), { visible: false, reason: "reentry_unverifiable" });
    assert.deepEqual(await audience(world({ throwOn: "layover_checkpoints" }).db), { visible: false, reason: "reentry_unverifiable" });
  });

  it("the target's own sharing switches: paused, off, or unreadable — not shared", async () => {
    assert.deepEqual(await audience(world({ prefs: [{ user_id: T, location_mode: "city_only", sharing_paused: true }] }).db), { visible: false, reason: "sharing_gate_closed" });
    assert.deepEqual(await audience(world({ prefs: [{ user_id: T, location_mode: "off", sharing_paused: false }] }).db), { visible: false, reason: "sharing_gate_closed" });
    assert.deepEqual(await audience(world({ failures: { "location_preferences:select": { message: "boom" } } }).db), { visible: false, reason: "sharing_gate_closed" });
  });

  it("the target's CURRENT certified hard return bounds it, and an uncertified target is not shared", async () => {
    const { db } = world();
    assert.deepEqual(await audience(db, { solved: [solved[0], { userId: T, sessionId: S_T, record: hardReturnRecord(NOW - MIN) }] }), { visible: false, reason: "hard_return_passed" });
    assert.deepEqual(await audience(db, { solved: [solved[0], { userId: T, sessionId: S_T, record: null }] }), { visible: false, reason: "uncertified" });
  });

  it("a rejoined target's old grant does not restart (granted_before_membership)", async () => {
    const rejoined = [members[0], { ...members[1], joinedAt: iso(NOW - 10 * MIN) }];
    assert.deepEqual(await audience(world().db, { members: rejoined }), { visible: false, reason: "granted_before_membership" });
  });

  it("no path yields visible without the ladder's own `precise`: the ladder refuses a grant scoped to another crew", () => {
    // The composition's last word is locationPrecisionFor; pin that it is the
    // ladder (not this module) that would refuse a mis-scoped grant.
    const v = locationPrecisionFor({ viewerUserId: V, targetUserId: T, sameCrewId: CREW, blocked: false, grant: { grantedByUserId: T, crewId: "crew-2", grantedAtMs: NOW - MIN, expiresAtMs: NOW + MIN }, signals: {}, nowMs: NOW });
    assert.equal(v.precision, "meeting_point");
  });
});

describe("crewOwnLocationShare — `yourShare`: the viewer's OWN share, which the ladder cannot answer", () => {
  const own = (db: any, over: Record<string, any> = {}) =>
    crewOwnLocationShare(db, { viewerId: T, crew, members, solved: solved as any, sessionsById, nowMs: NOW, ...over });

  it("flag OFF: available false, never live, and the grant store is not read", async () => {
    const w = world({ sharing: false, failures: { "layover_crew_location_grants:select": { message: "would be degraded" } } });
    assert.deepEqual(await own(w.db), { yourShare: { available: false, live: false, reason: "feature_off", expiresAt: null }, degradedReasons: [] });
  });

  it("live: the earliest known end is published", async () => {
    assert.deepEqual(await own(world().db), {
      yourShare: { available: true, live: true, reason: "live_scoped_grant", expiresAt: iso(NOW + 90 * MIN) },
      degradedReasons: [],
    });
  });

  it("not live: the reason, and NO expiry (a past end is not a countdown)", async () => {
    assert.deepEqual(await own(world({ grants: [] }).db), { yourShare: { available: true, live: false, reason: "no_live_grant:never_granted", expiresAt: null }, degradedReasons: [] });
    assert.deepEqual(await own(world({ grants: [grantRow({ revoked_at: iso(NOW - MIN) })] }).db), { yourShare: { available: true, live: false, reason: "no_live_grant:user_revoked", expiresAt: null }, degradedReasons: [] });
    assert.deepEqual((await own(world({ persistence: false }).db)).yourShare, { available: true, live: false, reason: "reentry_unverifiable", expiresAt: null });
  });

  it("an unreadable grant table is UNKNOWN (null) with location_grants_unreadable — never 'not sharing'", async () => {
    assert.deepEqual(await own(world({ failures: { "layover_crew_location_grants:select": { message: "boom" } } }).db), { yourShare: null, degradedReasons: ["location_grants_unreadable"] });
  });

  it("the viewer's share is about the VIEWER: a crewmate's live grant does not make the viewer 'sharing'", async () => {
    assert.equal((await own(world().db, { viewerId: V })).yourShare?.live, false);
  });
});
