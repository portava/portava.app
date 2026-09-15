/**
 * census L294 — "C2. Never swallow a schema/data error into plausible empty
 * operational state **without structured logging and degraded confidence**."
 *
 * This site was found by the §20 SWEEP, not by reading. `layoverSurfaceErrorBinding`
 * asserts that every supabase error in the surface is bound and looked at; the
 * disposition sweep run beside it asked a second question — is it LOGGED or
 * PASSED ON? — and out of 84 reads it named exactly one that was neither:
 *
 *     // SafeReturnLiveShareService.expireShare
 *     if (error || !data) return null;
 *
 * That is `if (error || !data) return null` again: the identical shape §19.2
 * removed from every writer in `LayoverSessionService`, surviving one directory
 * over because nobody had swept for the shape rather than for the keyword.
 *
 * WHAT IT COSTS. `expireShare` is called by `lib/safeReturnScheduler.ts` for
 * every live share past its `expires_at`. Its `null` meant three different
 * things at once:
 *
 *   1. the row was already expired or already stopped — normal, and the
 *      overwhelmingly common case (PostgREST answers a zero-row `.single()`
 *      UPDATE with `PGRST116`, which arrives as an `error`);
 *   2. the UPDATE did not complete;
 *   3. something threw.
 *
 * (2) is the one that matters. A live share the expiry sweep failed to close is
 * a person's LOCATION STILL BEING SHARED past the moment they agreed to, and
 * the scheduler logged nothing because it was handed the same `null` it gets
 * from case (1) a thousand times an hour. A privacy window that fails open is
 * the one failure on this surface that a traveller cannot see and cannot undo.
 *
 * `SafeReturnService.settleMutation` already draws exactly this distinction, in
 * the same product, for the same PostgREST behaviour. `expireShare` and
 * `stopShare` predate it.
 *
 * Run: node --import tsx/esm --test src/services/safeReturn/__tests__/safeReturnLiveShareExpiryHonesty.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expireShareSettled, stopShareSettled } from "../SafeReturnLiveShareService.js";

/**
 * The minimum of the supabase builder these two functions use:
 * `.from().update().eq().eq().lt().select().single()` and `.from().insert()`.
 */
function fakeDb(onUpdate: { data: any; error: any }) {
  const inserts: any[] = [];
  const builder: any = {
    update() { return builder; },
    eq() { return builder; },
    lt() { return builder; },
    select() { return builder; },
    then(resolve: any) { return Promise.resolve(onUpdate).then(resolve); },
    single() { return Promise.resolve(onUpdate); },
    insert(row: any) { inserts.push(row); return Promise.resolve({ error: null }); },
  };
  return { inserts, db: { from() { return builder; } } as any };
}

const SHARE_ROW = {
  id: "share-1",
  session_id: "sess-1",
  user_id: "user-1",
  status: "expired",
  expires_at: "2026-09-14T10:00:00.000Z",
  created_at: "2026-09-14T09:00:00.000Z",
};

const NO_ROWS = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" };
const OUTAGE = { code: "57P01", message: "terminating connection due to administrator command" };

describe("expireShareSettled — a share that would not close is not a share that was already closed", () => {
  it("a matched row expires, and says so", async () => {
    const { db } = fakeDb({ data: SHARE_ROW, error: null });
    const r = await expireShareSettled(db, "share-1");
    assert.equal(r.outcome, "ok");
    assert.ok(r.outcome === "ok" && r.share.id === "share-1");
  });

  it("PGRST116 is NO MATCH — already expired or already stopped, and not an outage", async () => {
    const { db } = fakeDb({ data: null, error: NO_ROWS });
    const r = await expireShareSettled(db, "share-1");
    assert.equal(r.outcome, "no_match",
      "the common case must stay quiet, or the alarm below stops meaning anything");
  });

  it("any OTHER error is UNAVAILABLE — the share's state is unknown and it may still be live", async () => {
    const { db } = fakeDb({ data: null, error: OUTAGE });
    const r = await expireShareSettled(db, "share-1");
    assert.equal(r.outcome, "unavailable",
      "a location still being shared past its expiry is not 'nothing to do'");
    assert.ok(r.outcome === "unavailable" && /57P01|administrator/.test(r.reason),
      `the reason must carry the database's own words, got ${JSON.stringify(r)}`);
  });

  it("a clean read that returns no row at all is NO MATCH, not unavailable", async () => {
    const { db } = fakeDb({ data: null, error: null });
    const r = await expireShareSettled(db, "share-1");
    assert.equal(r.outcome, "no_match");
  });

  it("the three outcomes are distinct — this is the whole point", async () => {
    const outcomes = await Promise.all([
      expireShareSettled(fakeDb({ data: SHARE_ROW, error: null }).db, "s"),
      expireShareSettled(fakeDb({ data: null, error: NO_ROWS }).db, "s"),
      expireShareSettled(fakeDb({ data: null, error: OUTAGE }).db, "s"),
    ]);
    assert.deepEqual(outcomes.map((o) => o.outcome), ["ok", "no_match", "unavailable"]);
  });
});

describe("stopShareSettled — the same distinction on the path a person presses", () => {
  it("an outage is UNAVAILABLE, not 'that share does not exist'", async () => {
    const { db } = fakeDb({ data: null, error: OUTAGE });
    const r = await stopShareSettled(db, "share-1", "user-1");
    assert.equal(r.outcome, "unavailable",
      "telling someone their location sharing is off when the write failed is the worst reading of this null");
  });

  it("PGRST116 stays NO MATCH", async () => {
    const { db } = fakeDb({ data: null, error: NO_ROWS });
    const r = await stopShareSettled(db, "share-1", "user-1");
    assert.equal(r.outcome, "no_match");
  });

  it("a matched row stops", async () => {
    const { db } = fakeDb({ data: { ...SHARE_ROW, status: "stopped" }, error: null });
    const r = await stopShareSettled(db, "share-1", "user-1");
    assert.equal(r.outcome, "ok");
  });
});

describe("the old projections keep their exact shape — lib/safeReturnScheduler.ts binds them", () => {
  it("expireShare still answers a share or null", async () => {
    const { expireShare, stopShare } = await import("../SafeReturnLiveShareService.js");
    const ok = await expireShare(fakeDb({ data: SHARE_ROW, error: null }).db, "share-1");
    assert.ok(ok && typeof ok === "object" && "id" in ok);
    const none = await expireShare(fakeDb({ data: null, error: NO_ROWS }).db, "share-1");
    assert.equal(none, null);
    const down = await expireShare(fakeDb({ data: null, error: OUTAGE }).db, "share-1");
    assert.equal(down, null, "the projection is lossy on purpose; the settled form is where the truth is");
    const stopped = await stopShare(fakeDb({ data: SHARE_ROW, error: null }).db, "share-1", "user-1");
    assert.ok(stopped && "id" in stopped);
  });
});
