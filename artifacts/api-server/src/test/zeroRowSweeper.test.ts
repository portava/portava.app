/**
 * Zero / partial matched rows reported as a completed sweep —
 * lib/rentBuddyRequestSweeper.ts
 *
 * THE CLASS
 * =========
 * The sweeper SELECTS a set of stale bookings, UPDATEs them by id, and then
 * drives everything else off the READ set: `expiredCount = staleRequests.length`,
 * `autoCompletedCount = pendingConfirm.length`, and one `buddy_booking_events`
 * row plus one push per row it had READ. supabase-js resolves an UPDATE that
 * matched NONE of those ids exactly as it resolves one that matched all of them
 * — `{ data: null, error: null }` — so the write's outcome was not merely
 * unread, it was unreadable. A booking a buddy accepted in the window between
 * the SELECT and the UPDATE (or one another sweeper instance had already taken)
 * therefore produced:
 *
 *   - a `request_expired` row in that booking's own event log, and
 *   - a "your booking expired" push to the traveller,
 *
 * for a booking that was, and stayed, live.
 *
 * WHAT THE FIX DOES
 * =================
 * The status guard from the SELECT is repeated on the UPDATE and the statement
 * is made RETURNING with `.select("id")`. The rows that come back are the rows
 * this pass actually moved; the events, the notifications and the returned
 * counts are all driven from that set instead.
 *
 * THE FAKE
 * ========
 * Rows are real and filters are really applied — `.in`, `.eq`, `.lt`, `.limit`
 * all narrow the match — and an UPDATE resolves to the rows it MATCHED: `[]`
 * when it matched none, and `null` when `.select()` was not chained. A fake
 * that resolved every UPDATE as `{ data: null, error: null }` could not express
 * this defect at all; a fake that echoed the update payload back would report a
 * zero-row update as a full one.
 *
 * WHY THE ASSERTIONS ARE ON THE NOTIFICATION ROWS
 * ===============================================
 * The traveller-facing consequence is the notification, and it is the one the
 * sweeper actually AWAITS. (The sibling `buddy_booking_events` insert in the
 * same loop is written as `void serviceClient.from(...).insert(...)` with no
 * await and no `.then` — and a PostgREST builder only issues its request when
 * it is awaited, so that row is never written by ANY client, fake or real.
 * Asserting on it would have produced a test that is green for a reason that
 * has nothing to do with this fix. Reported separately; not fixed here.)
 *
 * `notifyBookingParty` swallows every error, so "no notification" is a signal a
 * broken notifier would also produce — a vacuous green. Every case below
 * therefore asserts the PRESENCE of the notifications for the bookings that
 * really moved in the SAME run as the absence of the one that did not: the
 * mechanism is proven live by the same assertion block that proves the
 * unaffected booking was left alone.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/zeroRowSweeper.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runBuddyRequestSweep } from "../lib/rentBuddyRequestSweeper.js";

type Row = Record<string, any>;
interface Db {
  tables: Record<string, Row[]>;
  inserts: Array<{ table: string; row: Row }>;
  /**
   * One-shot race hook: runs ONCE, immediately after the next SELECT on that
   * table has resolved and before the caller can issue its UPDATE. This is how
   * the "the row changed between the read and the write" case is produced
   * deterministically — the SELECT must really return the row (otherwise the
   * phase short-circuits and the test proves nothing about the write).
   */
  afterSelect: Record<string, (db: Db) => void>;
}

function makeClient(tables: Record<string, Row[]>): { db: Db; client: any } {
  const db: Db = { tables, inserts: [], afterSelect: {} };
  const src = (t: string) => (db.tables[t] ??= []);

  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let verb: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: any = null;
    let returning = false;
    let single = false;
    let cap: number | null = null;
    const b: any = {
      select() { returning = true; return b; },
      insert(p: any) { verb = "insert"; payload = p; return b; },
      upsert(p: any) { verb = "upsert"; payload = p; return b; },
      update(p: any) { verb = "update"; payload = p; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { preds.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      lt(c: string, v: any) { preds.push((r) => r[c] != null && r[c] < v); return b; },
      gt(c: string, v: any) { preds.push((r) => r[c] != null && r[c] > v); return b; },
      not() { return b; }, or() { return b; }, order() { return b; },
      limit(n: number) { cap = n; return b; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };
    const match = () => {
      const m = src(table).filter((r) => preds.every((p) => p(r)));
      return cap == null ? m : m.slice(0, cap);
    };
    async function run(): Promise<{ data: any; error: any; count?: number }> {
      if (verb === "select") {
        // COPIES, not live references: a read must not hand back an object the
        // race hook below can then mutate under the caller. That would let a
        // test pass at the caller's pre-check rather than at the write.
        const m = match().map((r) => ({ ...r }));
        const out = { data: single ? (m[0] ?? null) : m, error: null, count: m.length };
        const hook = db.afterSelect[table];
        if (hook) { delete db.afterSelect[table]; hook(db); }
        return out;
      }
      if (verb === "insert" || verb === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `gen-${src(table).length + 1}`, ...r }));
        for (const r of rows) { src(table).push(r); db.inserts.push({ table, row: r }); }
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      const m = match();
      // Snapshot BEFORE mutating: RETURNING gives the matched rows, and the
      // count is what the statement touched — 0 when the filters excluded
      // everything, which is the case under test.
      const snapshot = m.map((r) => ({ ...r }));
      if (verb === "update") for (const r of m) Object.assign(r, payload);
      else db.tables[table] = src(table).filter((r) => !m.includes(r));
      return { data: returning ? (single ? (snapshot[0] ?? null) : snapshot) : null, error: null, count: snapshot.length };
    }
    return b;
  }

  return {
    db,
    client: {
      from,
      rpc: async () => ({ data: null, error: null }),
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    },
  };
}

const PAST   = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const T1 = "11111111-0000-0000-0000-000000000001";
const T2 = "22222222-0000-0000-0000-000000000002";
const T3 = "33333333-0000-0000-0000-000000000003";

/** Booking ids the sweep told someone about, for one notification event type. */
const notifiedFor = (db: Db, eventType: string) =>
  db.inserts
    .filter((i) => i.table === "notifications" && i.row.event_type === eventType)
    .map((i) => i.row.source_id as string);

// ── Phase 1: expiring unanswered requests ───────────────────────────────────

describe("runBuddyRequestSweep — request expiry", () => {
  it("counts and notifies ONLY the bookings the update really expired", async () => {
    // All three are stale and all three are returned by the SELECT — so the
    // read set is {b1,b2,b3} and the id list the UPDATE carries is all three.
    // b2 is then accepted by its buddy in the window before the write. The
    // write-side status guard drops it; without one, the sweeper would stomp a
    // live scheduled booking to `expired`. Either way the read set is NOT the
    // set that changed, which is what the counts and pushes must follow.
    const { db, client } = makeClient({
      feature_flags: [],
      rent_buddy_bookings: [
        { id: "b1", traveler_id: T1, status: "requested", expires_at: PAST },
        { id: "b2", traveler_id: T2, status: "requested", expires_at: PAST },
        { id: "b3", traveler_id: T3, status: "pending",   expires_at: PAST },
      ],
      notifications: [],
    });
    db.afterSelect.rent_buddy_bookings = (d) => {
      d.tables.rent_buddy_bookings.find((b) => b.id === "b2")!.status = "scheduled";
    };

    const r = await runBuddyRequestSweep(client);

    assert.equal(r.ok, true);
    assert.equal(r.expired, 2, "the read set was 3; only b1 and b3 were actually expired");
    assert.deepEqual(
      [...new Set(notifiedFor(db, "rent_buddy.booking_expired"))].sort(),
      ["b1", "b3"],
      "b2 is live — its traveller must not be told it expired, and b1/b3's travellers must still be told",
    );
    // And the accepted booking survives the sweep rather than being stomped.
    assert.equal(db.tables.rent_buddy_bookings.find((b) => b.id === "b2")!.status, "scheduled");
  });

  it("reports 0 and tells nobody when the update matches nothing", async () => {
    const { db, client } = makeClient({
      feature_flags: [],
      rent_buddy_bookings: [
        { id: "b1", traveler_id: T1, status: "requested", expires_at: PAST },
      ],
      notifications: [],
    });
    // The SELECT really returns b1 — so the sweeper really builds its id list
    // and really issues the UPDATE. The buddy accepts in that window, so the
    // UPDATE matches zero rows and resolves `{ data: [], error: null }`.
    db.afterSelect.rent_buddy_bookings = (d) => {
      d.tables.rent_buddy_bookings[0]!.status = "scheduled";
    };

    const r = await runBuddyRequestSweep(client);

    assert.equal(r.expired, 0, "the update matched no row — nothing expired");
    assert.deepEqual(
      notifiedFor(db, "rent_buddy.booking_expired"),
      [],
      "a sweep that expired nothing may not tell anybody their booking expired",
    );
    assert.equal(db.tables.rent_buddy_bookings[0]!.status, "scheduled", "the accepted booking survives the sweep");
  });

  it("a clean pass still expires and reports every stale request", async () => {
    const { db, client } = makeClient({
      feature_flags: [],
      rent_buddy_bookings: [
        { id: "b1", traveler_id: T1, status: "requested", expires_at: PAST },
        { id: "b2", traveler_id: T2, status: "pending",   expires_at: PAST },
        { id: "b9", traveler_id: T3, status: "requested", expires_at: FUTURE },
      ],
      notifications: [],
    });

    const r = await runBuddyRequestSweep(client);

    assert.equal(r.expired, 2);
    assert.deepEqual([...new Set(notifiedFor(db, "rent_buddy.booking_expired"))].sort(), ["b1", "b2"]);
    assert.equal(db.tables.rent_buddy_bookings.find((b) => b.id === "b9")!.status, "requested");
  });
});

// ── Phase 2: auto-completing bookings past the dispute window ───────────────

describe("runBuddyRequestSweep — auto-completion", () => {
  it("counts and notifies ONLY the bookings the update really completed", async () => {
    // Both are past their dispute window and both come back from the SELECT.
    // c2 is then DISPUTED before the write lands. Auto-completing a booking
    // out of an open dispute is what the write-side guard prevents; telling
    // both of its parties that it completed is what this pins.
    const { db, client } = makeClient({
      feature_flags: [],
      rent_buddy_bookings: [
        { id: "c1", traveler_id: T1, buddy_id: "bp1", status: "completed_pending_traveler_confirmation", dispute_window_expires_at: PAST },
        { id: "c2", traveler_id: T2, buddy_id: "bp1", status: "completed_pending_traveler_confirmation", dispute_window_expires_at: PAST },
      ],
      rent_buddy_profiles: [{ id: "bp1", user_id: "u-buddy" }],
      notifications: [],
    });
    // Phase 1 SELECTs this table first (and matches nothing here), so the hook
    // re-arms itself once and fires on PHASE 2's select — after it has returned
    // both rows, and before phase 2's update. Firing it on phase 1's select
    // instead would let phase 2's own read-side filter exclude c2, and the test
    // would pass without ever exercising the write.
    let selects = 0;
    const raceHook = (d: Db) => {
      selects += 1;
      if (selects === 1) { d.afterSelect.rent_buddy_bookings = raceHook; return; }
      d.tables.rent_buddy_bookings.find((b) => b.id === "c2")!.status = "disputed";
    };
    db.afterSelect.rent_buddy_bookings = raceHook;

    const r = await runBuddyRequestSweep(client);

    assert.equal(r.autoCompleted, 1, "the read set was 2; only c1 was actually completed");
    assert.deepEqual(
      [...new Set(notifiedFor(db, "rent_buddy.booking_completed"))],
      ["c1"],
      "c2 is in dispute — neither party may be told it completed",
    );
    assert.equal(db.tables.rent_buddy_bookings.find((b) => b.id === "c2")!.status, "disputed");
  });
});

// ── Phase 4: marketplace offer/request expiry ──────────────────────────────

describe("runBuddyRequestSweep — marketplace expiry counts", () => {
  it("returns the number of rows expired, not the number selected", async () => {
    const { db, client } = makeClient({
      feature_flags: [{ flag: "rent_buddy_enabled", enabled: true }],
      rent_buddy_bookings: [],
      rent_buddy_offers: [
        { id: "o1", status: "pending", expires_at: PAST },
        { id: "o2", status: "pending", expires_at: PAST },
      ],
      rent_buddy_requests: [],
    });

    const r = await runBuddyRequestSweep(client);

    assert.equal(r.offersExpired, 2);
    assert.equal(r.requestsExpired, 0);
    assert.equal(db.tables.rent_buddy_offers.every((o) => o.status === "expired"), true);
  });

  it("does not count an offer another sweeper instance already expired", async () => {
    // Two instances of the sweep overlap: o2 is expired by the other one
    // between this pass's SELECT and its UPDATE. The count feeds the sweep
    // status and the scheduler's "drained N" log line, so reporting the read
    // set there makes an overlapping pass look twice as productive as the work
    // it did — and makes a backlog that is not draining look like one that is.
    const { db, client } = makeClient({
      feature_flags: [{ flag: "rent_buddy_enabled", enabled: true }],
      rent_buddy_bookings: [],
      rent_buddy_offers: [
        { id: "o1", status: "pending", expires_at: PAST },
        { id: "o2", status: "pending", expires_at: PAST },
      ],
      rent_buddy_requests: [],
    });
    db.afterSelect.rent_buddy_offers = (d) => {
      d.tables.rent_buddy_offers.find((o) => o.id === "o2")!.status = "expired";
    };

    const r = await runBuddyRequestSweep(client);

    assert.equal(r.offersExpired, 1, "the read set was 2; this pass expired one");
  });
});
