/**
 * A revocation that did not happen must not be recorded as one.
 *
 * node:test + node:assert (NOT vitest). Judge by EXIT CODE.
 *
 * THE DEFECT. revokeAccessForMember is called when a member is removed from a
 * trip; it strips them from `allowed_member_ids` on every active live-share
 * session so they stop receiving crew locations. Its read of those sessions
 * ignored `.error`, and supabase-js RESOLVES on a database error, so `data` was
 * null both when the trip had no active shares AND when the table could not be
 * read. The loop then iterated nothing and the function fell through to logging
 * `access_revoked`.
 *
 * The consequence is physical, not cosmetic: the removed member KEEPS RECEIVING
 * LIVE LOCATIONS, and the audit trail asserts their access was taken away. The
 * caller (routes/trips.ts member-removal) invokes this fire-and-forget with a
 * `.catch(log)`, so silence there was total.
 *
 * The write had the same hole: a failed UPDATE left the member in the array.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/liveShareRevocationFailClosed.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { revokeAccessForMember } from "../services/tripCrew/TripCrewLiveShareService.js";

const TRIP = "11111111-1111-4111-8111-111111111111";
const REMOVED = "22222222-2222-4222-8222-222222222222";
const KEPT = "33333333-3333-4333-8333-333333333333";

const DB_ERROR = { message: "connection reset by peer", code: "08006" };

type Ev = { event_type: string; metadata: any };

/**
 * `sessionReadError` fails the SELECT on sessions; `sessionUpdateError` fails
 * the UPDATE. Events are captured so a test can assert what the audit trail
 * actually claims.
 */
function makeDb(opts: {
  sessions?: any[];
  sessionReadError?: boolean;
  sessionUpdateError?: boolean;
}) {
  const { sessions = [], sessionReadError = false, sessionUpdateError = false } = opts;
  const events: Ev[] = [];
  const rows = sessions.map((s) => ({ ...s }));

  function builder(table: string) {
    let mode: "select" | "update" | "insert" = "select";
    let patch: any = null;
    let idFilter: string | null = null;
    const b: any = {
      select: () => { mode = "select"; return b; },
      update: (d: any) => { mode = "update"; patch = d; return b; },
      insert: (d: any) => {
        mode = "insert";
        if (table === "trip_crew_location_events") events.push({ event_type: d.event_type, metadata: d.metadata });
        return Promise.resolve({ data: null, error: null });
      },
      eq: (col: string, v: any) => { if (col === "id") idFilter = v; return b; },
      then: (resolve: any) => {
        if (table === "trip_crew_location_sessions" && mode === "select") {
          return Promise.resolve(
            sessionReadError ? { data: null, error: DB_ERROR } : { data: rows, error: null },
          ).then(resolve);
        }
        if (table === "trip_crew_location_sessions" && mode === "update") {
          if (sessionUpdateError) return Promise.resolve({ data: null, error: DB_ERROR }).then(resolve);
          const row = rows.find((r) => r.id === idFilter);
          if (row && patch) Object.assign(row, patch);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  }
  return { db: { from: (t: string) => builder(t) } as any, events, rows };
}

describe("revokeAccessForMember fails closed", () => {
  it("HEALTHY PATH: the removed member is stripped and access_revoked is logged", async () => {
    const { db, events, rows } = makeDb({
      sessions: [{ id: "s1", allowed_member_ids: [KEPT, REMOVED] }],
    });
    await revokeAccessForMember(db, TRIP, REMOVED);
    assert.deepEqual(rows[0]!.allowed_member_ids, [KEPT], "the removed member must be stripped");
    assert.ok(events.some((e) => e.event_type === "access_revoked"), "a successful revocation is recorded");
  });

  it("an unreadable sessions table THROWS and does not claim access_revoked", async () => {
    const { db, events } = makeDb({ sessionReadError: true });
    await assert.rejects(
      () => revokeAccessForMember(db, TRIP, REMOVED),
      /could not read active live-share sessions/,
      "a failed read must surface, not be swallowed into a silent success",
    );
    assert.ok(
      !events.some((e) => e.event_type === "access_revoked"),
      "the audit trail must NOT assert access was revoked when nothing was read",
    );
    assert.ok(
      events.some((e) => e.event_type === "access_revoke_failed"),
      "and it must record the failed attempt — the member is already gone from trip_members, so nothing else would say their access may still stand",
    );
  });

  it("a failed session UPDATE throws and names the sessions that still grant access", async () => {
    const { db, events, rows } = makeDb({
      sessions: [{ id: "s1", allowed_member_ids: [KEPT, REMOVED] }],
      sessionUpdateError: true,
    });
    await assert.rejects(
      () => revokeAccessForMember(db, TRIP, REMOVED),
      /still grant access/,
      "an update that failed left the member in allowed_member_ids",
    );
    assert.ok(rows[0]!.allowed_member_ids.includes(REMOVED), "the fixture proves the member really was not stripped");
    assert.ok(!events.some((e) => e.event_type === "access_revoked"));
    const failed = events.find((e) => e.event_type === "access_revoke_failed");
    assert.ok(failed, "the failure is recorded");
    assert.deepEqual(failed!.metadata.failedSessionIds, ["s1"], "and it names which session still grants access");
  });

  it("a trip with genuinely no active sessions still succeeds — fail-closed is not blanket failure", async () => {
    const { db, events } = makeDb({ sessions: [] });
    await revokeAccessForMember(db, TRIP, REMOVED);
    assert.ok(
      events.some((e) => e.event_type === "access_revoked"),
      "no sessions to strip is a real, successful revocation and must not be turned into an error",
    );
  });

  it("a session that never named the member is left untouched", async () => {
    const { db, rows } = makeDb({ sessions: [{ id: "s1", allowed_member_ids: [KEPT] }] });
    await revokeAccessForMember(db, TRIP, REMOVED);
    assert.deepEqual(rows[0]!.allowed_member_ids, [KEPT]);
  });

  it("the fix is in the source, not only in these expectations", () => {
    const src = readFileSync(
      new URL("../services/tripCrew/TripCrewLiveShareService.ts", import.meta.url),
      "utf8",
    );
    assert.match(src, /error: readError/, "the sessions read must bind its error");
    assert.match(src, /error: updateError/, "the session update must bind its error");
    assert.match(src, /access_revoke_failed/, "a failed revocation must be recordable in the audit trail");
  });
});
