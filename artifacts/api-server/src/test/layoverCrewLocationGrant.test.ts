/**
 * The §14 L4 location grant — the precision ladder's missing row source.
 *
 * `locationPrecisionFor` and `evaluateCrewLocationShare` have implemented §14's
 * disclosure rules in full, with an exhaustive sweep in
 * `layoverCrewConstraints.test.ts` asserting that nothing but a live,
 * target-issued, crew-scoped grant yields `precise`. Every caller has had to
 * pass `grant: null`, which the ladder reads as `never_granted` — so its only
 * reachable answers were `none` and `meeting_point`, and census L124/L132 stay
 * N. Migration 3516, `LayoverCrewLocationGrantStore` and two routes give it
 * grants.
 *
 * THIS FILE DOES NOT RE-TEST THE LADDER. That arithmetic is swept elsewhere and
 * a second copy of those assertions would drift. What is tested here is the
 * WIRING, which is where the ladder's guarantee can be lost:
 *
 *   1. NO DURATION IS INVENTED ANYWHERE. §14 L4 says "auto-expiring" and names
 *      no duration. `boundedGrantWindow` derives the ceiling from the crew's
 *      own life and the granter's certified hard return, both of which the
 *      product already computes, and refuses when there is no window rather
 *      than defaulting to one.
 *   2. REVOKED IS NOT THE SAME AS NEVER GRANTED. Both produce the
 *      `meeting_point` rung, so a reader that skipped revoked rows would look
 *      completely correct — and would report `never_granted` about a traveller
 *      who said yes and then took it back. The REASON is asserted, not just
 *      the rung.
 *   3. AN UNREADABLE GRANT TABLE DEGRADES AND SAYS SO. It fails in the safe
 *      direction (nobody reads as sharing), which is exactly why it must not be
 *      silent: the feature would look correct while telling the traveller who
 *      tapped "share my location" nothing.
 *   4. AIRPORT RE-ENTRY IS A NAMED GAP, NOT A SILENT ONE. §14.1 lists it as a
 *      terminator and nothing in this tree records the instant
 *      (`layover_checkpoints`, migration 2992, is absent from the production
 *      schema snapshot). The signal is deliberately never set, and that is
 *      pinned here so it cannot quietly acquire a guessed value.
 *   5. NOTHING PUBLISHES A POSITION. 3516 holds permission; there is no
 *      coordinate in the schema or on the wire.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverCrewLocationGrant.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  boundedGrantWindow,
  crewShareSignalsFor,
} from "../services/layover/LayoverCrewLocationGrantStore.js";

const NOW = Date.parse("2031-03-04T09:15:00.000Z");
const HOUR = 3_600_000;

// ═══════════════════════════════════════════════════════════════════════════
// 1. boundedGrantWindow — the only place a grant's length is decided
// ═══════════════════════════════════════════════════════════════════════════

describe("boundedGrantWindow derives the ceiling and invents no duration", () => {
  const crewIn3h = new Date(NOW + 3 * HOUR).toISOString();

  it("with no requested expiry, the grant runs to the ceiling — the crew or the return, whichever is first", () => {
    const w = boundedGrantWindow({
      nowMs: NOW,
      requestedExpiresAtMs: null,
      crewExpiresAtIso: crewIn3h,
      granterHardReturnMs: NOW + 5 * HOUR,
    });
    assert.ok(w.ok);
    assert.equal(w.expiresAtMs, NOW + 3 * HOUR, "the crew expires first, so the crew bounds it");

    const w2 = boundedGrantWindow({
      nowMs: NOW,
      requestedExpiresAtMs: null,
      crewExpiresAtIso: new Date(NOW + 6 * HOUR).toISOString(),
      granterHardReturnMs: NOW + 2 * HOUR,
    });
    assert.ok(w2.ok);
    assert.equal(w2.expiresAtMs, NOW + 2 * HOUR, "the traveller's own return is earlier, so it bounds it");
  });

  it("a SHORTER request is honoured exactly — a traveller may share for less", () => {
    const w = boundedGrantWindow({
      nowMs: NOW,
      requestedExpiresAtMs: NOW + 30 * 60_000,
      crewExpiresAtIso: crewIn3h,
      granterHardReturnMs: NOW + 5 * HOUR,
    });
    assert.ok(w.ok);
    assert.equal(w.expiresAtMs, NOW + 30 * 60_000);
  });

  it("a LONGER request is clamped to the ceiling, not refused — the traveller did say yes", () => {
    const w = boundedGrantWindow({
      nowMs: NOW,
      requestedExpiresAtMs: NOW + 7 * 24 * HOUR,
      crewExpiresAtIso: crewIn3h,
      granterHardReturnMs: NOW + 5 * HOUR,
    });
    assert.ok(w.ok);
    assert.equal(w.expiresAtMs, NOW + 3 * HOUR);
  });

  /**
   * A grant whose window is empty is refused rather than written. 3516's
   * `expires_at > granted_at` CHECK would refuse it at the database anyway, and
   * `locationPrecisionFor` would report `ttl_elapsed` — blaming the TTL for a
   * write that was never valid. "There is no time left" is a real answer.
   */
  it("refuses when the ceiling has already passed, instead of writing an empty window", () => {
    assert.equal(
      boundedGrantWindow({
        nowMs: NOW,
        requestedExpiresAtMs: null,
        crewExpiresAtIso: new Date(NOW - HOUR).toISOString(),
        granterHardReturnMs: NOW + 5 * HOUR,
      }).ok,
      false,
    );
    assert.equal(
      boundedGrantWindow({
        nowMs: NOW,
        requestedExpiresAtMs: null,
        crewExpiresAtIso: crewIn3h,
        granterHardReturnMs: NOW - 1,
      }).ok,
      false,
    );
    assert.equal(
      boundedGrantWindow({
        nowMs: NOW,
        requestedExpiresAtMs: NOW,
        crewExpiresAtIso: crewIn3h,
        granterHardReturnMs: NOW + 5 * HOUR,
      }).ok,
      false,
      "a request for `now` is a zero-length window, which authorises nothing",
    );
  });

  /**
   * An unreadable crew expiry is not "unbounded", it is unknown; and an
   * uncertified granter has no hard return, which the whole §14.1 apparatus
   * treats as infeasible rather than as unconstrained.
   */
  it("refuses an unreadable crew expiry and an uncertified granter", () => {
    assert.equal(
      boundedGrantWindow({
        nowMs: NOW,
        requestedExpiresAtMs: null,
        crewExpiresAtIso: "not a date",
        granterHardReturnMs: NOW + 5 * HOUR,
      }).ok,
      false,
    );
    assert.equal(
      boundedGrantWindow({
        nowMs: NOW,
        requestedExpiresAtMs: null,
        crewExpiresAtIso: crewIn3h,
        granterHardReturnMs: null,
      }).ok,
      false,
    );
  });

  it("an unparseable requested expiry falls back to the ceiling rather than to NaN", () => {
    const w = boundedGrantWindow({
      nowMs: NOW,
      requestedExpiresAtMs: Date.parse("nonsense"),
      crewExpiresAtIso: crewIn3h,
      granterHardReturnMs: NOW + 5 * HOUR,
    });
    assert.ok(w.ok, "NaN must not propagate into a stored expiry — every terminator comparison against it is false");
    assert.equal(w.expiresAtMs, NOW + 3 * HOUR);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. crewShareSignalsFor — §14.1's five terminators, and the one that is a gap
// ═══════════════════════════════════════════════════════════════════════════

const LIVE = ["active", "returning"] as const;

describe("crewShareSignalsFor derives each terminator from a real instant", () => {
  const dissolvedAt = new Date(NOW - 10 * 60_000).toISOString();

  it("an OPEN crew has no dissolution instant", () => {
    const s = crewShareSignalsFor({
      crewStatus: "open",
      crewUpdatedAt: dissolvedAt,
      granterSessionStatus: "active",
      granterSessionUpdatedAt: dissolvedAt,
      granterBoardingTime: null,
      liveSessionStatuses: LIVE,
      revokedAtMs: null,
    });
    assert.equal(s.crewDissolvedAtMs, undefined);
    assert.equal(s.sessionExpiredAtMs, undefined);
  });

  it("a disbanded or closed crew dissolves at its last write", () => {
    for (const status of ["closed", "disbanded"]) {
      const s = crewShareSignalsFor({
        crewStatus: status,
        crewUpdatedAt: dissolvedAt,
        granterSessionStatus: "active",
        granterSessionUpdatedAt: null,
        granterBoardingTime: null,
        liveSessionStatuses: LIVE,
        revokedAtMs: null,
      });
      assert.equal(s.crewDissolvedAtMs, Date.parse(dissolvedAt), `status ${status}`);
    }
  });

  it("a session that is no longer live expires at its last write", () => {
    const s = crewShareSignalsFor({
      crewStatus: "open",
      crewUpdatedAt: null,
      granterSessionStatus: "expired",
      granterSessionUpdatedAt: dissolvedAt,
      granterBoardingTime: null,
      liveSessionStatuses: LIVE,
      revokedAtMs: null,
    });
    assert.equal(s.sessionExpiredAtMs, Date.parse(dissolvedAt));
  });

  /**
   * A SCHEDULED instant, not an observed boarding event, and that is honest
   * rather than a compromise: the schedule ends the share EARLIER than an
   * observation would, which is the direction a disclosure terminator must err.
   */
  it("boarding comes from the session's scheduled boarding time", () => {
    const boarding = new Date(NOW + 2 * HOUR).toISOString();
    const s = crewShareSignalsFor({
      crewStatus: "open",
      crewUpdatedAt: null,
      granterSessionStatus: "active",
      granterSessionUpdatedAt: null,
      granterBoardingTime: boarding,
      liveSessionStatuses: LIVE,
      revokedAtMs: null,
    });
    assert.equal(s.boardingAtMs, Date.parse(boarding));
  });

  it("revocation is passed through as the instant it happened", () => {
    const s = crewShareSignalsFor({
      crewStatus: "open",
      crewUpdatedAt: null,
      granterSessionStatus: "active",
      granterSessionUpdatedAt: null,
      granterBoardingTime: null,
      liveSessionStatuses: LIVE,
      revokedAtMs: NOW - 60_000,
    });
    assert.equal(s.revokedAtMs, NOW - 60_000);
  });

  /**
   * THE NAMED GAP. §14.1 lists "airport re-entry" as a terminator and nothing
   * in this tree records that instant: the only source would be a checkpoint
   * observation, and `layover_checkpoints` (migration 2992) is absent from the
   * production schema snapshot. `undefined` is the solver's word for "has not
   * happened", which is the truthful thing to pass — any value would be
   * invented. Pinned so it cannot quietly acquire a guess.
   */
  it("airport re-entry is NEVER set, because no instant for it exists in this tree", () => {
    const s = crewShareSignalsFor({
      crewStatus: "disbanded",
      crewUpdatedAt: new Date(NOW).toISOString(),
      granterSessionStatus: "expired",
      granterSessionUpdatedAt: new Date(NOW).toISOString(),
      granterBoardingTime: new Date(NOW).toISOString(),
      liveSessionStatuses: LIVE,
      revokedAtMs: NOW,
    });
    assert.equal(
      s.airportReentryAtMs,
      undefined,
      "a value here would be invented; 2992's layover_checkpoints is the source and it is unapplied",
    );
    // Non-vacuity: every OTHER terminator in the same call IS set, so this is
    // not passing because the function returned an empty object.
    assert.equal(typeof s.crewDissolvedAtMs, "number");
    assert.equal(typeof s.sessionExpiredAtMs, "number");
    assert.equal(typeof s.boardingAtMs, "number");
    assert.equal(typeof s.revokedAtMs, "number");
  });

  it("an unparseable instant is left unset rather than passed on as NaN", () => {
    const s = crewShareSignalsFor({
      crewStatus: "disbanded",
      crewUpdatedAt: "not a date",
      granterSessionStatus: "expired",
      granterSessionUpdatedAt: "also not a date",
      granterBoardingTime: "nor this",
      liveSessionStatuses: LIVE,
      revokedAtMs: null,
    });
    assert.deepEqual(s, {}, "NaN compares false against every terminator test, which would read as a live share");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Over HTTP: the rung a crewmate actually sees
// ═══════════════════════════════════════════════════════════════════════════

let server: http.Server;
let base: string;

const A_TOKEN = "grant-a";
const B_TOKEN = "grant-b";
const USER_A = "user-a";
const USER_B = "user-b";
const SESSION_A = "session-a";
const SESSION_B = "session-b";
const CREW_ID = "crew-1";

type Reply = { status: number; body: any };

function call(
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Reply> {
  return new Promise((done, fail) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          done({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", fail);
    if (payload) r.write(payload);
    r.end();
  });
}

function stage(
  opts: {
    grants?: Record<string, any>[];
    failures?: Record<string, { message: string; code?: string }>;
    crewExpiresInHours?: number;
  } = {},
) {
  const now = Date.now();
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [
      sessionRow({ id: SESSION_A, user_id: USER_A, departure_time: new Date(now + 9 * HOUR).toISOString() }),
      sessionRow({ id: SESSION_B, user_id: USER_B, departure_time: new Date(now + 9 * HOUR).toISOString() }),
    ],
    layover_crews: [
      {
        id: CREW_ID,
        city: "taoyuan",
        airport_ref: "TPE",
        created_by: USER_A,
        created_session_id: SESSION_A,
        title: "Noodles and a nap",
        meeting_point_label: "Terminal 2 food court",
        status: "open",
        max_members: 6,
        expires_at: new Date(now + (opts.crewExpiresInHours ?? 4) * HOUR).toISOString(),
        created_at: new Date(now - 60_000).toISOString(),
        updated_at: new Date(now - 60_000).toISOString(),
      },
    ],
    layover_crew_members: [
      { crew_id: CREW_ID, user_id: USER_A, session_id: SESSION_A, role: "owner", joined_at: new Date(now - 60_000).toISOString(), left_at: null },
      { crew_id: CREW_ID, user_id: USER_B, session_id: SESSION_B, role: "member", joined_at: new Date(now - 30_000).toISOString(), left_at: null },
    ],
    layover_crew_stops: [],
    layover_crew_branch_assignments: [],
    layover_crew_location_grants: opts.grants ?? [],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
    blocks: [],
    profiles: [
      { id: USER_A, handle: "ann", name: "Ann", avatar_url: null },
      { id: USER_B, handle: "bo", name: "Bo", avatar_url: null },
    ],
    location_preferences: [
      { user_id: USER_A, location_mode: "city", sharing_paused: false },
      { user_id: USER_B, location_mode: "city", sharing_paused: false },
    ],
    trips: [],
  };
  _setTestClient(
    makeLayoverDb(tables, {
      users: { [A_TOKEN]: USER_A, [B_TOKEN]: USER_B },
      failures: opts.failures ?? {},
    }),
    true,
  );
  return tables;
}

/** The rung A is shown for B. */
function rungFor(body: any, userId: string): { precision: string; reason: string } {
  const row = (body.locationRungs ?? []).find((r: any) => r.userId === userId);
  assert.ok(row, `no rung published for ${userId}`);
  return row;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", airportRouter);
  await new Promise<void>((done) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      done();
    });
  });
});

after(async () => {
  _setTestClient(null as any, false);
  await new Promise<void>((done) => server.close(() => done()));
});

describe("the ladder's answers are finally reachable from a stored grant", () => {
  it("with no grant, a crewmate is meeting_point and the reason is never_granted", async () => {
    stage();
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const bo = rungFor(res.body, USER_B);
    assert.equal(bo.precision, "meeting_point");
    assert.equal(bo.reason, "no_live_grant:never_granted");
  });

  /**
   * THE RUNG THAT WAS UNREACHABLE. Before 3516 there was no argument a caller
   * could pass that produced `precise` for anybody but the viewer themselves.
   */
  it("B grants, and A sees B as precise with a live scoped grant", async () => {
    stage();
    const granted = await call(B_TOKEN, "POST", `/api/airport/sessions/${SESSION_B}/crew/location-grant`, {});
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    // B's own view of B is `self`, which discloses nothing; A's view of B is
    // the one the grant changed.
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    const bo = rungFor(res.body, USER_B);
    assert.equal(bo.precision, "precise");
    assert.equal(bo.reason, "live_scoped_grant");
  });

  it("the grant is stored bounded by the crew's life, not by what was asked for", async () => {
    const tables = stage({ crewExpiresInHours: 2 });
    const res = await call(B_TOKEN, "POST", `/api/airport/sessions/${SESSION_B}/crew/location-grant`, {
      expiresAt: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(tables.layover_crew_location_grants.length, 1);
    const stored = Date.parse(tables.layover_crew_location_grants[0].expires_at);
    assert.ok(
      stored <= Date.now() + 2 * HOUR + 1000,
      "a week-long grant must be clamped to the crew's own expiry, which is two hours away",
    );
  });

  /**
   * REVOKED IS NOT NEVER-GRANTED. Both are the `meeting_point` rung, which is
   * exactly why the REASON is what this asserts: a reader that skipped revoked
   * rows would pass a rung-only assertion while reporting that a traveller who
   * said yes and took it back had never said anything.
   */
  it("after revoking, the rung drops back and the reason names the revocation", async () => {
    stage();
    await call(B_TOKEN, "POST", `/api/airport/sessions/${SESSION_B}/crew/location-grant`, {});
    const revoked = await call(B_TOKEN, "DELETE", `/api/airport/sessions/${SESSION_B}/crew/location-grant`);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    const bo = rungFor(res.body, USER_B);
    assert.equal(bo.precision, "meeting_point");
    assert.equal(
      bo.reason,
      "no_live_grant:user_revoked",
      "a revoked grant must not be reported as never_granted — only one of those means a traveller said yes",
    );
  });

  it("revocation keeps the row, so the act of consent stays on record", async () => {
    const tables = stage();
    await call(B_TOKEN, "POST", `/api/airport/sessions/${SESSION_B}/crew/location-grant`, {});
    await call(B_TOKEN, "DELETE", `/api/airport/sessions/${SESSION_B}/crew/location-grant`);
    assert.equal(tables.layover_crew_location_grants.length, 1, "revocation sets a column, it does not delete");
    assert.ok(tables.layover_crew_location_grants[0].revoked_at);
  });

  /**
   * Revoking EVERY unrevoked row, not just the newest. Grants accumulate by
   * design, so leaving an older one unrevoked would mean "I revoked" depended
   * on the reader's sort order.
   */
  it("revocation covers every unrevoked grant, not just the newest", async () => {
    const now = Date.now();
    const tables = stage({
      grants: [
        { id: "g-old", crew_id: CREW_ID, granted_by_user_id: USER_B, session_id: SESSION_B, granted_at: new Date(now - 2 * HOUR).toISOString(), expires_at: new Date(now + 3 * HOUR).toISOString(), revoked_at: null, created_at: new Date(now - 2 * HOUR).toISOString() },
        { id: "g-new", crew_id: CREW_ID, granted_by_user_id: USER_B, session_id: SESSION_B, granted_at: new Date(now - HOUR).toISOString(), expires_at: new Date(now + HOUR).toISOString(), revoked_at: null, created_at: new Date(now - HOUR).toISOString() },
      ],
    });
    await call(B_TOKEN, "DELETE", `/api/airport/sessions/${SESSION_B}/crew/location-grant`);
    assert.equal(tables.layover_crew_location_grants.filter((g) => g.revoked_at === null).length, 0);
  });

  /**
   * THE NEWEST GRANT IS THE ONE IN FORCE, not the one with the latest expiry.
   * Taking a maximum over expiries would let a revoked long grant outlive the
   * short one that replaced it.
   */
  it("the newest grant decides, even when an older one would have run longer", async () => {
    const now = Date.now();
    stage({
      grants: [
        { id: "g-long-revoked", crew_id: CREW_ID, granted_by_user_id: USER_B, session_id: SESSION_B, granted_at: new Date(now - 2 * HOUR).toISOString(), expires_at: new Date(now + 3 * HOUR).toISOString(), revoked_at: new Date(now - 90 * 60_000).toISOString(), created_at: new Date(now - 2 * HOUR).toISOString() },
        { id: "g-short-expired", crew_id: CREW_ID, granted_by_user_id: USER_B, session_id: SESSION_B, granted_at: new Date(now - HOUR).toISOString(), expires_at: new Date(now - 30 * 60_000).toISOString(), revoked_at: null, created_at: new Date(now - HOUR).toISOString() },
      ],
    });
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    const bo = rungFor(res.body, USER_B);
    assert.equal(bo.precision, "meeting_point");
    assert.equal(
      bo.reason,
      "no_live_grant:ttl_elapsed",
      "the newest grant expired; the older revoked one with a later expiry must not come back to life",
    );
  });

  it("an expired grant is not live, and says so as ttl_elapsed rather than as absent", async () => {
    const now = Date.now();
    stage({
      grants: [
        { id: "g-gone", crew_id: CREW_ID, granted_by_user_id: USER_B, session_id: SESSION_B, granted_at: new Date(now - 2 * HOUR).toISOString(), expires_at: new Date(now - HOUR).toISOString(), revoked_at: null, created_at: new Date(now - 2 * HOUR).toISOString() },
      ],
    });
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    assert.equal(rungFor(res.body, USER_B).reason, "no_live_grant:ttl_elapsed");
  });

  /**
   * A grant naming a crew its granter was never in. `locationPrecisionFor`
   * refuses a grant scoped to ANOTHER crew, but it cannot tell that a grant
   * names a crew the granter was never a member of — the grant and the viewer's
   * `sameCrewId` would agree. Only the write can answer that, and it does.
   */
  it("a grant from somebody who is not in the crew is refused at the write", async () => {
    const tables = stage();
    tables.layover_crew_members = tables.layover_crew_members.filter((m) => m.user_id !== USER_B);
    const res = await call(B_TOKEN, "POST", `/api/airport/sessions/${SESSION_B}/crew/location-grant`, {});
    assert.notEqual(res.status, 200);
    assert.equal(tables.layover_crew_location_grants.length, 0);
  });

  it("a crew whose time is already gone refuses the grant rather than writing an empty window", async () => {
    const tables = stage({ crewExpiresInHours: -1 });
    const res = await call(B_TOKEN, "POST", `/api/airport/sessions/${SESSION_B}/crew/location-grant`, {});
    // The crew read is itself bounded by `expires_at > now`, so an expired crew
    // may be refused as "not in a crew" OR as "no time left". Either is honest;
    // what must not happen is a grant being written with a window that has
    // already closed, which the table's CHECK would reject anyway.
    assert.notEqual(res.status, 200);
    assert.equal(tables.layover_crew_location_grants.length, 0);
  });

  /**
   * The mirror image, and the reason the case above has to say "already gone".
   *
   * A crew with a fraction of a second left has POSITIVE time left, so the
   * grant is honest and is written. It would be easy to call such a window
   * useless and refuse it, or to round it up to some workable minimum — and
   * either would be this file choosing a duration nobody has chosen. The store
   * has no minimum TTL for the same reason it has no maximum one: the only
   * numbers it may use are the ones the crew and the granter's own deadline
   * supply. So the window is stored exactly as narrow as the crew's life is,
   * and it is the ladder, reading `expiresAtMs` against the clock, that stops
   * disclosing the moment it closes.
   */
  it("a crew with a sliver of time left is granted that sliver, not a rounded-up one", async () => {
    const before = Date.now();
    const tables = stage({ crewExpiresInHours: 0.0001 });
    const res = await call(B_TOKEN, "POST", `/api/airport/sessions/${SESSION_B}/crew/location-grant`, {});
    assert.equal(res.status, 200);
    assert.equal(tables.layover_crew_location_grants.length, 1);
    const row = tables.layover_crew_location_grants[0] as { granted_at: string; expires_at: string };
    const grantedMs = Date.parse(row.granted_at);
    const expiresMs = Date.parse(row.expires_at);
    assert.ok(Number.isFinite(grantedMs) && Number.isFinite(expiresMs), "both instants must be real");
    assert.ok(expiresMs > grantedMs, "the stored window must satisfy the table's positive-window CHECK");
    // 0.0001h is 360ms. The ceiling is the crew's expiry, so the window cannot
    // reach even a second — proving nothing widened it to a round number.
    assert.ok(
      expiresMs - before <= 1_000,
      `the window must end when the crew does, not later; got ${expiresMs - before}ms`,
    );
  });
});

describe("an unreadable grant table degrades, and never silently", () => {
  /**
   * It fails in the SAFE direction — every member reads as `never_granted`, so
   * the rung is `meeting_point` — which is exactly why it must be reported. A
   * feature that quietly becomes "nobody is sharing" looks completely correct
   * while telling the traveller who tapped share nothing at all.
   *
   * And it must NOT refuse the whole crew: the roster and the shared deadline
   * are readable and right, and taking them away over a field that is already
   * failing safe would be the wrong trade. That asymmetry against the
   * itinerary reads (which DO refuse, because an empty plan certifies feasible)
   * is the point of this test.
   */
  it("the crew still loads, the rung is meeting_point, and the degrade is named", async () => {
    stage({ failures: { "layover_crew_location_grants:select": { message: "boom" } } });
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    assert.equal(res.status, 200, "the roster and the deadline are readable; do not take them away");
    assert.equal(rungFor(res.body, USER_B).precision, "meeting_point");
    assert.equal(res.body.degraded, true);
    assert.ok(
      (res.body.degradedReasons ?? []).includes("location_grants_unreadable"),
      "'nobody is sharing' and 'we could not tell' are the same rung and must not be the same answer",
    );
  });

  it("and the undegraded control does not claim the degrade", async () => {
    stage();
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    assert.equal(res.status, 200);
    assert.ok(!(res.body.degradedReasons ?? []).includes("location_grants_unreadable"));
  });
});

describe("the rung is published and a position is not", () => {
  it("no coordinate reaches the wire, under any rung", async () => {
    stage();
    await call(B_TOKEN, "POST", `/api/airport/sessions/${SESSION_B}/crew/location-grant`, {});
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    assert.equal(rungFor(res.body, USER_B).precision, "precise", "the positive control: the rung IS precise");
    const wire = JSON.stringify(res.body);
    for (const key of ["\"lat\"", "\"lng\"", "\"latitude\"", "\"longitude\"", "\"coords\""]) {
      assert.ok(
        !wire.includes(key),
        `${key} reached the crew payload — 3516 stores permission, not position, and nothing here may publish one`,
      );
    }
  });

  it("the viewer's own rung is self, which discloses nothing", async () => {
    stage();
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    const me = rungFor(res.body, USER_A);
    assert.equal(me.precision, "precise");
    assert.equal(me.reason, "self");
  });
});

/**
 * `yourShare`, AND WHY THE RUNG LADDER COULD NOT ANSWER THIS.
 *
 * The test directly above is the reason this block exists. The viewer's own rung
 * is `precise`/`self` whether they have granted anything or not, because a rung
 * says what the viewer may SEE and you may always see yourself. A client reading
 * only the rungs therefore cannot tell a traveller whether the crew can see them
 * right now — so it has to offer both "share" and "stop sharing" and let them
 * guess, which is the one thing this whole feature is supposed to prevent.
 *
 * `yourShare` is judged through `evaluateCrewLocationShare`, which has no self
 * short-circuit, so it answers from the grant and the same five terminators.
 */
describe("the viewer is told whether the crew can see them", () => {
  it("before granting anything, the viewer is not sharing and is told why", async () => {
    stage();
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.yourShare, { live: false, reason: "no_live_grant:never_granted", expiresAt: null });
    // The paired fact: the rung says `precise`/`self` at the same moment, which
    // is exactly the confusion this field exists to remove.
    assert.equal(rungFor(res.body, USER_A).precision, "precise");
  });

  it("after granting, the viewer is sharing and is given the expiry they are bound by", async () => {
    const tables = stage({ crewExpiresInHours: 2 });
    const grant = await call(A_TOKEN, "POST", `/api/airport/sessions/${SESSION_A}/crew/location-grant`, {});
    assert.equal(grant.status, 200);
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    const mine = res.body.yourShare as { live: boolean; reason: string; expiresAt: string | null };
    assert.equal(mine.live, true);
    assert.equal(mine.reason, "live_scoped_grant");
    assert.ok(mine.expiresAt, "a live share must publish the expiry it is bound by");
    // It is the stored row's expiry, not a number computed for the wire.
    const row = tables.layover_crew_location_grants.find(
      (g: { granted_by_user_id: string }) => g.granted_by_user_id === USER_A,
    ) as { expires_at: string };
    assert.equal(Date.parse(mine.expiresAt as string), Date.parse(row.expires_at));
  });

  it("after revoking, the viewer is not sharing and the reason names the revocation", async () => {
    stage({ crewExpiresInHours: 2 });
    await call(A_TOKEN, "POST", `/api/airport/sessions/${SESSION_A}/crew/location-grant`, {});
    await call(A_TOKEN, "DELETE", `/api/airport/sessions/${SESSION_A}/crew/location-grant`);
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    const mine = res.body.yourShare as { live: boolean; reason: string; expiresAt: string | null };
    assert.equal(mine.live, false);
    assert.equal(mine.reason, "no_live_grant:user_revoked");
    // No expiry on a dead grant: a past instant would read as a countdown that
    // has already run out, which is the same number meaning the opposite thing.
    assert.equal(mine.expiresAt, null);
  });

  it("an expired share is reported as elapsed rather than as never granted", async () => {
    const now = Date.now();
    stage({
      grants: [
        { id: "g-mine-old", crew_id: CREW_ID, granted_by_user_id: USER_A, session_id: SESSION_A, granted_at: new Date(now - 2 * HOUR).toISOString(), expires_at: new Date(now - HOUR).toISOString(), revoked_at: null, created_at: new Date(now - 2 * HOUR).toISOString() },
      ],
    });
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    assert.equal((res.body.yourShare as { reason: string }).reason, "no_live_grant:ttl_elapsed");
  });

  it("an unreadable grant table makes this UNKNOWN, never false", async () => {
    stage({ failures: { "layover_crew_location_grants:select": { message: "boom" } } });
    const res = await call(A_TOKEN, "GET", `/api/airport/sessions/${SESSION_A}/crew`);
    assert.equal(res.status, 200);
    // null is the only honest answer here, and it must NOT be `live: false`:
    // telling a traveller they are not sharing when the server cannot tell is a
    // claim about their privacy the server has no basis for, in the direction
    // that would have them share again needlessly.
    assert.equal(res.body.yourShare, null);
    assert.equal(res.body.degraded, true);
    assert.ok((res.body.degradedReasons ?? []).includes("location_grants_unreadable"));
  });
});
