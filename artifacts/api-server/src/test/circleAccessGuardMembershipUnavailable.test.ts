/**
 * "We could not look" must not be served as "you are not on this trip".
 *
 * node:test + node:assert (NOT vitest). Judge by EXIT CODE.
 *
 * lib/circleAccessGuard.ts's membership check was ERROR-INERT, which is a
 * different defect from an unchecked read and is why the unchecked-read checker
 * could not see it. The error WAS observed and then folded into the same value
 * an empty read produces:
 *
 *     if (error || !data) return false;                    // trip
 *     if (rsvpResult.error || !rsvpResult.data) return false;   // event
 *     if (attendeeResult.error || !attendeeResult.data) return false;
 *
 * `false` was also the answer for a genuine non-member, so a database blip
 * became the assertion `viewer_not_member` / `target_not_member` — a statement
 * about who the user IS, made at a moment when nothing had been established.
 * routes/circle.ts had already fixed its own copy of this rule by throwing
 * CircleAccessUnavailableError (503 degraded_unavailable); this file could
 * return the third state instead of throwing, because every caller here already
 * returns a CircleAccessResult and this file already spells that state
 * `reason: "unavailable"`.
 *
 * The batch paths carried the same defect in the shape a batch takes: the
 * membership reads bound only `data`, so an unreadable INCLUSION table read as
 * "no rows" and EVERY viewer/target in the batch came back a non-member.
 *
 * Two of these assertions are not about labelling. `circle_presence` with the
 * error unbound fell THROUGH to `{ allowed: true, presenceRow: null }` — a
 * caller was told the target is a sharing member who has not published yet,
 * which had not been read. And the precision case below (a readable RSVP of
 * 'cant_go' alongside a failed event_attendees read) guards the opposite
 * failure: the fix must not launder verdicts we genuinely hold into
 * "unavailable".
 *
 * HAND-REVERT PROOF: restoring `if (error || !data) return false;` and dropping
 * the `error` binding from the batch reads makes the unavailable cases below
 * fail (they report viewer_not_member / target_not_member / target_sharing_off,
 * and the circle_presence case reports allowed:true). Recorded in the commit.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/circleAccessGuardMembershipUnavailable.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canViewCirclePresence,
  canViewCirclePresenceBatch,
  canBeSeenByViewersBatch,
} from "../lib/circleAccessGuard.js";

const DB_ERROR = { message: "connection reset by peer", code: "08006" };
const VIEWER = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TRIP = "trip-1";
const EVENT = "event-1";

/** `errorTables` resolve with an error, exactly as PostgREST failures surface. */
function db(opts: { errorTables?: string[]; rows?: Record<string, any[]> } = {}) {
  const failing = new Set(opts.errorTables ?? []);
  const rows = opts.rows ?? {};
  function builder(table: string) {
    const isErr = failing.has(table);
    const settle = (single: boolean) =>
      isErr
        ? Promise.resolve({ data: null, error: DB_ERROR, count: null })
        : Promise.resolve(
            single
              ? { data: (rows[table] ?? [])[0] ?? null, error: null }
              : { data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length },
          );
    const b: any = {
      select: () => b, eq: () => b, in: () => b, or: () => b, is: () => b,
      neq: () => b, gte: () => b, lte: () => b, order: () => b, limit: () => b,
      maybeSingle: () => settle(true),
      single: () => settle(true),
      then: (r: any) => settle(false).then(r),
    };
    return b;
  }
  return { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) } as any;
}

/** A healthy trip where viewer and target are both accepted members and sharing is on. */
const HEALTHY_TRIP_ROWS = {
  trip_members: [VIEWER, TARGET, OTHER].map((id) => ({ user_id: id, role: "member", status: "accepted" })),
  circle_visibility_settings: [
    {
      user_id: TARGET,
      global_enabled: true,
      visibility_mode: "status_only",
      trip_sharing_default: null,
      event_sharing_default: null,
      is_paused: false,
      consent_version: "v1",
      consented_at: "2026-01-01T00:00:00Z",
    },
  ],
};

describe("canViewCirclePresence: a failed membership read is not a membership verdict", () => {
  it("an unreadable trip_members answers unavailable, not viewer_not_member", async () => {
    const r = await canViewCirclePresence(db({ errorTables: ["trip_members"] }), VIEWER, TARGET, "trip", TRIP);
    assert.equal(r.allowed, false, "fail-CLOSED is unchanged: the deny stays a deny");
    assert.equal(
      r.reason,
      "unavailable",
      "'viewer_not_member' asserts the viewer is not on the trip; nothing was read that could say so",
    );
  });

  it("an unreadable event_rsvps answers unavailable, not viewer_not_member", async () => {
    const r = await canViewCirclePresence(db({ errorTables: ["event_rsvps"] }), VIEWER, TARGET, "event", EVENT);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "unavailable");
  });

  it("an unreadable event_attendees answers unavailable when the RSVP said going", async () => {
    const r = await canViewCirclePresence(
      db({
        errorTables: ["event_attendees"],
        rows: { event_rsvps: [{ user_id: VIEWER, status: "going" }] },
      }),
      VIEWER, TARGET, "event", EVENT,
    );
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "unavailable", "the attendee row was the one that would have decided");
  });

  it("a readable RSVP that is NOT going still answers viewer_not_member, even with event_attendees down", async () => {
    // The opposite failure to the one above. A verdict we genuinely hold must
    // not be laundered into "unavailable" because an irrelevant read failed:
    // 'cant_go' settles membership whatever event_attendees says.
    const r = await canViewCirclePresence(
      db({
        errorTables: ["event_attendees"],
        rows: { event_rsvps: [{ user_id: VIEWER, status: "cant_go" }] },
      }),
      VIEWER, TARGET, "event", EVENT,
    );
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "viewer_not_member", "this one IS a membership fact, and it was read");
  });

  it("an unreadable circle_visibility_settings answers unavailable, not target_sharing_off", async () => {
    const r = await canViewCirclePresence(
      db({ errorTables: ["circle_visibility_settings"], rows: HEALTHY_TRIP_ROWS }),
      VIEWER, TARGET, "trip", TRIP,
    );
    assert.equal(r.allowed, false);
    assert.equal(
      r.reason,
      "unavailable",
      "'target_sharing_off' describes a choice the target made; their choice was not readable",
    );
  });

  it("an unreadable circle_presence DENIES — it used to fall through to allowed:true", async () => {
    const r = await canViewCirclePresence(
      db({ errorTables: ["circle_presence"], rows: HEALTHY_TRIP_ROWS }),
      VIEWER, TARGET, "trip", TRIP,
    );
    assert.equal(
      r.allowed,
      false,
      "the old code answered allowed:true with presenceRow:null — 'a member who has not published yet', unread",
    );
    assert.equal(r.reason, "unavailable");
  });
});

describe("the batch paths deny the whole batch as unavailable, not as non-members", () => {
  it("canViewCirclePresenceBatch: an unreadable trip_members is not 'nobody is a member'", async () => {
    const out = await canViewCirclePresenceBatch(
      db({ errorTables: ["trip_members"] }), VIEWER, [TARGET, OTHER], "trip", TRIP,
    );
    for (const id of [TARGET, OTHER]) {
      assert.equal(out.get(id)?.allowed, false, `${id} must still be denied`);
      assert.equal(out.get(id)?.reason, "unavailable", `${id} must not be labelled a non-member`);
    }
  });

  it("canViewCirclePresenceBatch: an unreadable event_attendees denies the batch as unavailable", async () => {
    const out = await canViewCirclePresenceBatch(
      db({
        errorTables: ["event_attendees"],
        rows: { event_rsvps: [{ user_id: VIEWER, status: "going" }] },
      }),
      VIEWER, [TARGET, OTHER], "event", EVENT,
    );
    for (const id of [TARGET, OTHER]) {
      assert.equal(out.get(id)?.reason, "unavailable");
    }
  });

  it("canBeSeenByViewersBatch: an unreadable trip_members is not 'no viewer is a member'", async () => {
    const out = await canBeSeenByViewersBatch(
      db({ errorTables: ["trip_members"] }), TARGET, [VIEWER, OTHER], "trip", TRIP,
    );
    for (const id of [VIEWER, OTHER]) {
      assert.equal(out.get(id)?.allowed, false, `${id} must still be denied`);
      assert.equal(out.get(id)?.reason, "unavailable", `${id} must not be labelled a non-member`);
    }
  });
});

describe("the fix is not a blanket 'unavailable'", () => {
  it("a healthy database still reports a genuine non-member as viewer_not_member", async () => {
    const r = await canViewCirclePresence(db({ rows: { trip_members: [] } }), VIEWER, TARGET, "trip", TRIP);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "viewer_not_member", "no read failed, so the verdict must be a real one");
  });

  it("a healthy database still lets an accepted member through to a presence answer", async () => {
    const r = await canViewCirclePresence(db({ rows: HEALTHY_TRIP_ROWS }), VIEWER, TARGET, "trip", TRIP);
    assert.equal(r.allowed, true, "the guard must not have become a denial machine");
    assert.equal(r.reason, undefined);
  });

  it("a healthy batch still reports genuine non-members as non-members", async () => {
    const out = await canViewCirclePresenceBatch(
      db({ rows: { trip_members: [{ user_id: VIEWER, role: "member", status: "accepted" }] } }),
      VIEWER, [TARGET, OTHER], "trip", TRIP,
    );
    for (const id of [TARGET, OTHER]) {
      assert.equal(out.get(id)?.reason, "target_not_member");
    }
  });
});
