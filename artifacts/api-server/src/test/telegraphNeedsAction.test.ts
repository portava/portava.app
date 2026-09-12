/**
 * telegraphNeedsAction — Telegraph §19's "12 unread · 1 needs action", the half
 * that did not exist.
 *
 * census-telegraph T260: unread "is real and carefully built … **'Needs action'
 * has no representation** — nothing distinguishes a message from an unresolved
 * decision." Every field `GET /me/threads` returned was about MESSAGES.
 *
 * ── WHAT THESE TESTS PIN DOWN ────────────────────────────────────────────────
 *  1. "Needs action" means the product is WAITING ON THIS PERSON — a stored
 *     `meetup_invites.status = 'pending'`, or an unconfirmed time option they
 *     have not voted on. Not "unread, but louder", and never an inference from
 *     prose.
 *  2. ONE MEETUP IS ONE ACTION. A poll with five evenings is one decision.
 *  3. ABSENT IS NOT ZERO. An unreadable input omits the field rather than
 *     sending `0`, because `0` on an inbox row is a claim that there is nothing
 *     to do — the exact claim the read just failed to justify.
 *
 * Part 1 drives the policy against `makeLayoverDb` (the table-backed supabase
 * surface that `supabaseContract.test.ts` checks against the REAL client).
 * Part 2 drives the REAL Express route end to end, so "wired" is measured and
 * not asserted: a policy nothing calls would pass Part 1 and fail Part 2.
 *
 * Run: node --import tsx/esm --test src/test/telegraphNeedsAction.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import { resolveNeedsAction, NEEDS_ACTION_MAX_THREADS } from "../domain/telegraph/policies/needsAction.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";

const VIEWER = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER  = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD_A = "00000000-0000-4000-8000-0000000000a1";
const THREAD_B = "00000000-0000-4000-8000-0000000000b1";
const M_ONE = "00000000-0000-4000-8000-0000000000m1";
const M_TWO = "00000000-0000-4000-8000-0000000000m2";
const OPT_1 = "00000000-0000-4000-8000-0000000000o1";
const OPT_2 = "00000000-0000-4000-8000-0000000000o2";

function meetup(id: string, threadId: string, status = "proposed") {
  return { id, chat_thread_id: threadId, status, creator_id: OTHER };
}
function invite(meetupId: string, userId: string, status: string) {
  return { id: `i-${meetupId}-${userId}`, meetup_id: meetupId, user_id: userId, status };
}
function option(id: string, meetupId: string, confirmed = false) {
  return { id, meetup_id: meetupId, proposed_date: "2026-10-01", time_block: "evening", confirmed };
}

function db(tables: Record<string, any[]>, failures?: Record<string, { message: string; code?: string }>) {
  return makeLayoverDb(
    {
      meetups: [],
      meetup_invites: [],
      meetup_time_options: [],
      meetup_time_votes: [],
      ...tables,
    },
    failures ? { failures } : {},
  ) as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — the policy
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveNeedsAction — what counts as an outstanding answer", () => {
  it("a pending RSVP is an action", async () => {
    const r = await resolveNeedsAction(
      db({ meetups: [meetup(M_ONE, THREAD_A)], meetup_invites: [invite(M_ONE, VIEWER, "pending")] }),
      { viewerId: VIEWER, threadIds: [THREAD_A] },
    );
    assert.equal(r.degraded, false);
    assert.deepEqual(r.byThread.get(THREAD_A), { count: 1, reasons: ["rsvp_pending"] });
  });

  it("an answered RSVP is not", async () => {
    for (const status of ["going", "maybe", "declined", "cancelled"]) {
      const r = await resolveNeedsAction(
        db({ meetups: [meetup(M_ONE, THREAD_A)], meetup_invites: [invite(M_ONE, VIEWER, status)] }),
        { viewerId: VIEWER, threadIds: [THREAD_A] },
      );
      assert.equal(r.byThread.size, 0, `status "${status}" was counted as needing action`);
    }
  });

  it("an unconfirmed time option the viewer has not voted on is an action", async () => {
    const r = await resolveNeedsAction(
      db({
        meetups: [meetup(M_ONE, THREAD_A)],
        meetup_invites: [invite(M_ONE, VIEWER, "going")],
        meetup_time_options: [option(OPT_1, M_ONE)],
      }),
      { viewerId: VIEWER, threadIds: [THREAD_A] },
    );
    assert.deepEqual(r.byThread.get(THREAD_A), { count: 1, reasons: ["time_vote_pending"] });
  });

  it("a vote already cast clears it", async () => {
    const r = await resolveNeedsAction(
      db({
        meetups: [meetup(M_ONE, THREAD_A)],
        meetup_invites: [invite(M_ONE, VIEWER, "going")],
        meetup_time_options: [option(OPT_1, M_ONE)],
        meetup_time_votes: [{ id: "v1", option_id: OPT_1, user_id: VIEWER, vote: "yes" }],
      }),
      { viewerId: VIEWER, threadIds: [THREAD_A] },
    );
    assert.equal(r.byThread.size, 0);
  });

  it("someone ELSE's vote does not clear it", async () => {
    const r = await resolveNeedsAction(
      db({
        meetups: [meetup(M_ONE, THREAD_A)],
        meetup_invites: [invite(M_ONE, VIEWER, "going")],
        meetup_time_options: [option(OPT_1, M_ONE)],
        meetup_time_votes: [{ id: "v1", option_id: OPT_1, user_id: OTHER, vote: "yes" }],
      }),
      { viewerId: VIEWER, threadIds: [THREAD_A] },
    );
    assert.deepEqual(r.byThread.get(THREAD_A), { count: 1, reasons: ["time_vote_pending"] });
  });

  it("a CONFIRMED option is settled — the organiser already picked", async () => {
    const r = await resolveNeedsAction(
      db({
        meetups: [meetup(M_ONE, THREAD_A)],
        meetup_invites: [invite(M_ONE, VIEWER, "going")],
        meetup_time_options: [option(OPT_1, M_ONE, true)],
      }),
      { viewerId: VIEWER, threadIds: [THREAD_A] },
    );
    assert.equal(r.byThread.size, 0);
  });

  it("one meetup is one action even when both answers are outstanding", async () => {
    // A poll with five evenings plus an unanswered RSVP is still ONE thing to
    // go and deal with. A count that multiplied would teach people to ignore it.
    const r = await resolveNeedsAction(
      db({
        meetups: [meetup(M_ONE, THREAD_A)],
        meetup_invites: [invite(M_ONE, VIEWER, "pending")],
        meetup_time_options: [option(OPT_1, M_ONE), option(OPT_2, M_ONE)],
      }),
      { viewerId: VIEWER, threadIds: [THREAD_A] },
    );
    const got = r.byThread.get(THREAD_A)!;
    assert.equal(got.count, 1);
    assert.deepEqual(got.reasons, ["rsvp_pending", "time_vote_pending"]);
  });

  it("two meetups in one thread are two actions", async () => {
    const r = await resolveNeedsAction(
      db({
        meetups: [meetup(M_ONE, THREAD_A), meetup(M_TWO, THREAD_A)],
        meetup_invites: [invite(M_ONE, VIEWER, "pending"), invite(M_TWO, VIEWER, "pending")],
      }),
      { viewerId: VIEWER, threadIds: [THREAD_A] },
    );
    assert.equal(r.byThread.get(THREAD_A)!.count, 2);
  });

  it("a non-invitee is not being asked anything", async () => {
    // Absence of a row is absence of a question. Counting it would put a badge
    // on a thread where the viewer has nothing to answer.
    const r = await resolveNeedsAction(
      db({
        meetups: [meetup(M_ONE, THREAD_A)],
        meetup_invites: [invite(M_ONE, OTHER, "pending")],
        meetup_time_options: [option(OPT_1, M_ONE)],
      }),
      { viewerId: VIEWER, threadIds: [THREAD_A] },
    );
    assert.equal(r.byThread.size, 0);
  });

  it("a cancelled meetup is waiting on nobody", async () => {
    const r = await resolveNeedsAction(
      db({
        meetups: [meetup(M_ONE, THREAD_A, "cancelled")],
        meetup_invites: [invite(M_ONE, VIEWER, "pending")],
      }),
      { viewerId: VIEWER, threadIds: [THREAD_A] },
    );
    assert.equal(r.byThread.size, 0);
  });

  it("only the threads asked about come back", async () => {
    const r = await resolveNeedsAction(
      db({
        meetups: [meetup(M_ONE, THREAD_A), meetup(M_TWO, THREAD_B)],
        meetup_invites: [invite(M_ONE, VIEWER, "pending"), invite(M_TWO, VIEWER, "pending")],
      }),
      { viewerId: VIEWER, threadIds: [THREAD_A] },
    );
    assert.equal(r.byThread.has(THREAD_B), false);
    assert.equal(r.byThread.get(THREAD_A)!.count, 1);
  });

  it("no threads, no reads", async () => {
    const r = await resolveNeedsAction(db({}), { viewerId: VIEWER, threadIds: [] });
    assert.equal(r.degraded, false);
    assert.equal(r.byThread.size, 0);
  });

  it("the join is bounded", () => {
    assert.ok(NEEDS_ACTION_MAX_THREADS > 0 && NEEDS_ACTION_MAX_THREADS <= 500);
  });
});

describe("resolveNeedsAction — an unknown count is never reported as zero", () => {
  // supabase-js RESOLVES on a database error, so each of these returns the same
  // `null` an empty table returns. `degraded` is the only thing that tells them
  // apart, and the map must be EMPTY rather than partially filled — a partial
  // map reads as "these threads need nothing", which is the fabrication.
  const DOWN = { message: "connection terminated unexpectedly", code: "57P01" };

  for (const table of ["meetups", "meetup_invites", "meetup_time_options", "meetup_time_votes"]) {
    it(`an unreadable ${table} degrades instead of answering 0`, async () => {
      const r = await resolveNeedsAction(
        db(
          {
            meetups: [meetup(M_ONE, THREAD_A)],
            meetup_invites: [invite(M_ONE, VIEWER, "going")],
            meetup_time_options: [option(OPT_1, M_ONE)],
          },
          { [`${table}:select`]: DOWN },
        ),
        { viewerId: VIEWER, threadIds: [THREAD_A] },
      );
      assert.equal(r.degraded, true, `${table} failed silently`);
      assert.equal(r.byThread.size, 0, `${table} produced a partial map`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — the route. A policy nothing calls is a policy that does nothing.
// ─────────────────────────────────────────────────────────────────────────────

interface RouteState {
  meetups: any[];
  meetup_invites: any[];
  meetup_time_options: any[];
  meetup_time_votes: any[];
  meetupsError?: { message: string; code?: string };
}

function makeRouteClient(state: RouteState) {
  const tables: Record<string, any[]> = {
    feature_flags: [],
    profiles: [
      { id: VIEWER, handle: "viewer", name: "Viewer" },
      { id: OTHER, handle: "other", name: "Other" },
    ],
    message_threads: [
      { id: THREAD_A, thread_type: "trip", trip_id: null, circle_owner_id: null, title: "A",
        status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-01T00:00:00.000Z",
        last_message_at: "2026-03-01T00:00:00.000Z" },
      { id: THREAD_B, thread_type: "trip", trip_id: null, circle_owner_id: null, title: "B",
        status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z",
        last_message_at: "2026-02-01T00:00:00.000Z" },
    ],
    message_thread_members: [
      { thread_id: THREAD_A, user_id: VIEWER, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD_B, user_id: VIEWER, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [],
    message_translations: [],
    meetups: state.meetups,
    meetup_invites: state.meetup_invites,
    meetup_time_options: state.meetup_time_options,
    meetup_time_votes: state.meetup_time_votes,
  };

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    const rowsNow = () => {
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const injected = () =>
      table === "meetups" && state.meetupsError ? state.meetupsError : null;

    const target: any = {
      select() { return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      order() { return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const err = injected();
        return Promise.resolve(err ? { data: null, error: err } : { data: rowsNow()[0] ?? null, error: null });
      },
      single() {
        const err = injected();
        return Promise.resolve(err ? { data: null, error: err } : { data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err, count: null }).then(resolve, reject);
        const rows = rowsNow();
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use(messagingRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _setTestClient(null, false);
  await new Promise<void>((r) => server.close(() => r()));
});

async function inbox(state: Partial<RouteState> = {}) {
  _setTestClient(
    makeRouteClient({
      meetups: [], meetup_invites: [], meetup_time_options: [], meetup_time_votes: [],
      ...state,
    }) as any,
    true,
  );
  const r = await fetch(`${base}/me/threads`, { headers: { authorization: `Bearer ${VIEWER}` } });
  const body = (await r.json().catch(() => null)) as { threads: Array<Record<string, unknown>> };
  return { status: r.status, body };
}

describe("GET /me/threads — the inbox actually carries the count", () => {
  it("a thread with a pending RSVP reports needsActionCount 1 and says why", async () => {
    const r = await inbox({
      meetups: [meetup(M_ONE, THREAD_A)],
      meetup_invites: [invite(M_ONE, VIEWER, "pending")],
    });
    assert.equal(r.status, 200);
    const a = (r.body.threads as any[]).find((t) => t.id === THREAD_A);
    const b = (r.body.threads as any[]).find((t) => t.id === THREAD_B);
    assert.equal(a.needsActionCount, 1);
    assert.deepEqual(a.needsActionReasons, ["rsvp_pending"]);
    assert.equal(b.needsActionCount, 0, "a thread with nothing outstanding reports a real zero");
    assert.deepEqual(b.needsActionReasons, []);
  });

  it("nothing outstanding anywhere is zero everywhere — not absent", async () => {
    const r = await inbox({});
    for (const t of r.body.threads as any[]) {
      assert.equal(t.needsActionCount, 0);
    }
  });

  it("an unreadable input OMITS the field rather than reporting zero", async () => {
    // The distinction the whole design turns on: `0` is a claim that there is
    // nothing to do, and a failed read cannot make that claim.
    const r = await inbox({
      meetups: [meetup(M_ONE, THREAD_A)],
      meetup_invites: [invite(M_ONE, VIEWER, "pending")],
      meetupsError: { message: "connection terminated unexpectedly", code: "57P01" },
    });
    assert.equal(r.status, 200, "the inbox still renders; only the badge is unknown");
    for (const t of r.body.threads as any[]) {
      assert.equal("needsActionCount" in t, false, "an unknown count was sent as a number");
      assert.equal("needsActionReasons" in t, false);
    }
  });

  it("unread and needs-action are independent — no messages, still an action", async () => {
    const r = await inbox({
      meetups: [meetup(M_ONE, THREAD_A)],
      meetup_invites: [invite(M_ONE, VIEWER, "going")],
      meetup_time_options: [option(OPT_1, M_ONE)],
    });
    const a = (r.body.threads as any[]).find((t) => t.id === THREAD_A);
    assert.equal(a.unreadCount, 0, "there are no messages at all in this fixture");
    assert.equal(a.needsActionCount, 1, "…and still something to answer");
    assert.deepEqual(a.needsActionReasons, ["time_vote_pending"]);
  });
});
