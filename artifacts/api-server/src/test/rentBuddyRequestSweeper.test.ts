/**
 * Unit tests for rentBuddyRequestSweeper.ts
 *
 * Two hardening guarantees are covered here:
 *
 *   B3 — every phase is independently guarded. A thrown/rejected fetch in
 *        phase 2 (auto-complete) must NOT prevent phase 3 (no-show escalation)
 *        from running. Before phases 2/3 were wrapped in their own try/catch, a
 *        throw in phase 2 bubbled out of runBuddyRequestSweep and skipped
 *        everything after it.
 *
 *   P1 — phase 1 expires unanswered requests past their expires_at, for BOTH
 *        statuses a creation path can write. The fake used to answer phase 1's
 *        `.in("status", …)` query with a hard-coded empty array, so the whole
 *        phase was uncovered: dropping "requested" — the status the CANONICAL
 *        POST /rent-a-buddy/bookings writes, and the exact historical defect
 *        this module exists to fix — left every test in this file green. The
 *        fake now honours the .in()/.lt() filters against a fixture set, and
 *        the statuses under test are derived from AWAITING_BUDDY_STATUSES so
 *        the coverage cannot fall behind the constant.
 *
 *   A2 — a fourth phase expires stale open marketplace rows that nothing else
 *        swept: pending rent_buddy_offers and open rent_buddy_requests past
 *        their own expires_at. A stale row is flipped to `expired`; a fresh row
 *        (expires_at in the future) is left untouched; the whole phase is a
 *        no-op when the Rent-a-Buddy master flag is off.
 *
 * The sweeper is driven with an injected fake Supabase client (the same
 * override runBuddyRequestSweep already accepts for the HTTP route). The fake
 * honours the .eq()/.lt() filters on the marketplace tables so the
 * "fresh row untouched" assertion reflects the real query, not the fixture.
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/rentBuddyRequestSweeper.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AWAITING_BUDDY_STATUSES } from "../lib/rentBuddyBookingStatus.js";
import {
  runBuddyRequestSweep,
  getSweepStatus,
  _resetStatus,
} from "../lib/rentBuddyRequestSweeper.js";

// ── Fixture row shapes ──────────────────────────────────────────────────────────

interface MarketRow {
  id: string;
  status: string;
  expires_at: string;
}

interface BookingRow {
  id: string;
  traveler_id: string;
  buddy_id?: string;
}

/** Phase-1 fixture: an unanswered request with its own status and window. */
interface StaleBookingRow {
  id: string;
  traveler_id: string;
  status: string;
  expires_at: string;
}

interface RecordedUpdate {
  table: string;
  patch: Record<string, unknown>;
  ids: string[] | null;
}

interface FakeClientConfig {
  flagEnabled?: boolean;
  offers?: MarketRow[];
  requests?: MarketRow[];
  // phase-1 unanswered requests (drives the P1 assertions)
  staleBookings?: StaleBookingRow[];
  // phase-3 no-show bookings (drives the B3 "phase 3 still runs" assertion)
  noShows?: BookingRow[];
  // phase-2 fetch behaviour
  throwOnAutoCompleteFetch?: boolean;
}

// ── Fake Supabase client ────────────────────────────────────────────────────────
//
// A minimal chainable builder that resolves via a thenable (awaited as a
// Promise) or via maybeSingle(). It captures the op, the table, the equality /
// less-than filters and any .in(...) id list, and returns data keyed off table
// + status so the four query shapes the sweeper issues are each satisfied.

function makeClient(cfg: FakeClientConfig = {}): any {
  const {
    flagEnabled = true,
    offers = [],
    requests = [],
    staleBookings = [],
    noShows = [],
    throwOnAutoCompleteFetch = false,
  } = cfg;

  const updates: RecordedUpdate[] = [];
  const flagsQueried: string[] = [];

  return {
    _updates: updates,
    _flagsQueried: flagsQueried,

    from(table: string) {
      let op: "select" | "insert" | "update" | "delete" = "select";
      let patch: Record<string, unknown> = {};
      const eqs: Record<string, unknown> = {};
      const lts: Record<string, unknown> = {};
      let inCol: string | null = null;
      let inVals: string[] = [];
      let didInsert = false;

      // Apply the captured .eq()/.lt() filters to a fixture set, then project to
      // the { id } shape the marketplace selects request. This is what makes a
      // fresh (future expires_at) row fall out of the result on its own.
      const filterMarket = (rows: MarketRow[]): Array<{ id: string }> =>
        rows
          .filter((r) => {
            for (const [c, v] of Object.entries(eqs)) {
              if ((r as any)[c] !== v) return false;
            }
            for (const [c, v] of Object.entries(lts)) {
              if (!((r as any)[c] < (v as any))) return false;
            }
            return true;
          })
          .map((r) => ({ id: r.id }));

      const resolveThen = (): Promise<{ data: any; error: any }> => {
        if (op === "update") {
          updates.push({
            table,
            patch,
            ids: inCol === "id" ? inVals : null,
          });
          return Promise.resolve({ data: null, error: null });
        }
        if (op === "insert" || op === "delete") {
          return Promise.resolve({ data: null, error: null });
        }
        // op === "select"
        if (table === "rent_buddy_bookings") {
          // Phase 1 filters with .in("status", [...]) + .lt("expires_at", now);
          // phases 2/3 use .eq("status"). This used to answer phase 1 with a
          // hard-coded [] — which is why narrowing phase 1's status list changed
          // nothing anywhere in this file. It now applies the real predicates.
          if (inCol === "status") {
            const wanted = inVals;
            const rows = staleBookings.filter((r) => {
              if (!wanted.includes(r.status)) return false;
              for (const [c, v] of Object.entries(lts)) {
                if (!((r as any)[c] < (v as any))) return false;
              }
              return true;
            });
            return Promise.resolve({
              data: rows.map((r) => ({ id: r.id, traveler_id: r.traveler_id, status: r.status })),
              error: null,
            });
          }
          if (eqs["status"] === "completed_pending_traveler_confirmation") {
            if (throwOnAutoCompleteFetch) {
              return Promise.reject(new Error("simulated auto-complete fetch failure"));
            }
            return Promise.resolve({ data: [], error: null });
          }
          if (eqs["status"] === "no_show_pending") {
            return Promise.resolve({ data: noShows, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        }
        if (table === "rent_buddy_offers") {
          return Promise.resolve({ data: filterMarket(offers), error: null });
        }
        if (table === "rent_buddy_requests") {
          return Promise.resolve({ data: filterMarket(requests), error: null });
        }
        return Promise.resolve({ data: [], error: null });
      };

      const resolveMaybeSingle = (): { data: any; error: any } => {
        if (table === "feature_flags") {
          flagsQueried.push(eqs["flag"] as string);
          return { data: { enabled: flagEnabled }, error: null };
        }
        if (table === "buddy_booking_events") {
          // reporter-derivation lookup → missing, falls back to traveler_id
          return { data: null, error: null };
        }
        if (table === "rent_buddy_disputes") {
          // existing-dispute check → none; insert().select().maybeSingle() → new id
          return { data: didInsert ? { id: "dispute-test-1" } : null, error: null };
        }
        return { data: null, error: null };
      };

      const builder: any = {
        select() { if (!didInsert) op = "select"; return builder; },
        insert() { op = "insert"; didInsert = true; return builder; },
        update(p: Record<string, unknown>) { op = "update"; patch = p; return builder; },
        delete() { op = "delete"; return builder; },
        eq(col: string, val: unknown) { eqs[col] = val; return builder; },
        lt(col: string, val: unknown) { lts[col] = val; return builder; },
        gt() { return builder; },
        in(col: string, vals: string[]) { inCol = col; inVals = vals; return builder; },
        not() { return builder; },
        is() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        maybeSingle() { return Promise.resolve(resolveMaybeSingle()); },
        then(onFulfilled: any, onRejected: any) { return resolveThen().then(onFulfilled, onRejected); },
      };
      return builder;
    },
  };
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const idsFor = (client: any, table: string): string[] =>
  client._updates
    .filter((u: RecordedUpdate) => u.table === table)
    .flatMap((u: RecordedUpdate) => u.ids ?? []);

beforeEach(() => {
  _resetStatus();
});

// ══════════════════════════════════════════════════════════════════════════════
// B3: phases are independently guarded — a phase-2 throw must not skip phase 3
// ══════════════════════════════════════════════════════════════════════════════

describe("B3: a throw in the auto-complete phase does not abort later phases", () => {
  it("still escalates a stale no-show when the phase-2 fetch rejects", async () => {
    const client = makeClient({
      throwOnAutoCompleteFetch: true,
      noShows: [{ id: "bk-1", traveler_id: "trav-1", buddy_id: "bp-1" }],
    });

    // RED before the fix: the bare phase-2 await rejects, runBuddyRequestSweep
    // rejects, and phase 3 never runs. GREEN after: it resolves and phase 3 ran.
    const r = await runBuddyRequestSweep(client);

    assert.equal(r.ok, true, "sweep should resolve, not reject, despite the phase-2 throw");
    assert.equal(r.noShowEscalated, 1, "phase 3 must still escalate the stale no-show");

    // Proof phase 3 executed its side effect: the booking was promoted to disputed.
    const disputed = client._updates.find(
      (u: RecordedUpdate) => u.table === "rent_buddy_bookings" && u.patch["status"] === "disputed",
    );
    assert.ok(disputed, "booking should have been promoted to disputed in phase 3");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// A2: stale open offers/requests expire; fresh ones are untouched
// ══════════════════════════════════════════════════════════════════════════════

describe("A2: expires stale open marketplace rows past their window", () => {
  it("flips a stale pending offer to expired and leaves a fresh one untouched", async () => {
    const client = makeClient({
      flagEnabled: true,
      offers: [
        { id: "offer-stale", status: "pending", expires_at: PAST },
        { id: "offer-fresh", status: "pending", expires_at: FUTURE },
      ],
    });

    const r = await runBuddyRequestSweep(client);

    assert.equal(r.offersExpired, 1, "exactly one (stale) offer should expire");
    const expiredOfferIds = idsFor(client, "rent_buddy_offers");
    assert.deepEqual(expiredOfferIds, ["offer-stale"], "only the stale offer id is updated");
    assert.ok(!expiredOfferIds.includes("offer-fresh"), "the fresh offer must not be touched");

    const offerPatch = client._updates.find((u: RecordedUpdate) => u.table === "rent_buddy_offers");
    assert.equal(offerPatch!.patch["status"], "expired", "offer patch sets status=expired");
  });

  it("flips a stale open request to expired and leaves a fresh one untouched", async () => {
    const client = makeClient({
      flagEnabled: true,
      requests: [
        { id: "req-stale", status: "open", expires_at: PAST },
        { id: "req-fresh", status: "open", expires_at: FUTURE },
      ],
    });

    const r = await runBuddyRequestSweep(client);

    assert.equal(r.requestsExpired, 1, "exactly one (stale) request should expire");
    const expiredRequestIds = idsFor(client, "rent_buddy_requests");
    assert.deepEqual(expiredRequestIds, ["req-stale"], "only the stale request id is updated");
    assert.ok(!expiredRequestIds.includes("req-fresh"), "the fresh request must not be touched");

    const reqPatch = client._updates.find((u: RecordedUpdate) => u.table === "rent_buddy_requests");
    assert.equal(reqPatch!.patch["status"], "expired", "request patch sets status=expired");
  });

  it("records the counts in sweep status", async () => {
    const client = makeClient({
      flagEnabled: true,
      offers: [{ id: "offer-stale", status: "pending", expires_at: PAST }],
      requests: [{ id: "req-stale", status: "open", expires_at: PAST }],
    });

    await runBuddyRequestSweep(client);
    // Drive the status recorder the same way the scheduler does.
    const r = await runBuddyRequestSweep(client);
    assert.equal(r.offersExpired, 1);
    assert.equal(r.requestsExpired, 1);

    // getSweepStatus is populated by tickOnce, not runBuddyRequestSweep, but the
    // fields exist and default to 0 — assert the shape is present.
    const s = getSweepStatus();
    assert.equal(typeof s.lastOffersExpired, "number");
    assert.equal(typeof s.lastRequestsExpired, "number");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// A2 gate: phase 4 is a no-op when the master flag is off
// ══════════════════════════════════════════════════════════════════════════════

describe("A2 gate: marketplace expiry is skipped when the RAB master flag is off", () => {
  it("does not query or expire offers/requests when the flag is disabled", async () => {
    const client = makeClient({
      flagEnabled: false,
      offers: [{ id: "offer-stale", status: "pending", expires_at: PAST }],
      requests: [{ id: "req-stale", status: "open", expires_at: PAST }],
    });

    const r = await runBuddyRequestSweep(client);

    assert.equal(r.offersExpired, 0, "no offers expire while the feature is off");
    assert.equal(r.requestsExpired, 0, "no requests expire while the feature is off");
    assert.equal(idsFor(client, "rent_buddy_offers").length, 0, "no offer update issued");
    assert.equal(idsFor(client, "rent_buddy_requests").length, 0, "no request update issued");
    assert.deepEqual(client._flagsQueried, ["rent_buddy_enabled"], "master flag was consulted");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// P1: phase 1 expires unanswered requests — in EVERY status a creation path writes
// ══════════════════════════════════════════════════════════════════════════════

describe("P1: expires unanswered requests past expires_at", () => {
  /**
   * Derived from the constant, not written out. The canonical creation route
   * writes "requested"; the other four write "pending". Hard-coding either here
   * is how phase 1 came to be tested with only the status it did not need to
   * handle — and a fixture that stops matching a filter passes silently.
   */
  for (const status of AWAITING_BUDDY_STATUSES) {
    it(`expires a stale booking in status "${status}"`, async () => {
      const client = makeClient({
        staleBookings: [
          { id: `bk-stale-${status}`, traveler_id: "trav-1", status, expires_at: PAST },
        ],
      });

      const r = await runBuddyRequestSweep(client);

      assert.equal(r.ok, true);
      assert.equal(r.expired, 1, `a stale "${status}" booking must expire`);
      const patch = client._updates.find(
        (u: RecordedUpdate) => u.table === "rent_buddy_bookings" && u.patch["status"] === "expired",
      );
      assert.ok(patch, "phase 1 must write status=expired");
      assert.deepEqual(patch!.ids, [`bk-stale-${status}`]);
    });
  }

  it("leaves a booking whose window has not closed alone", async () => {
    const client = makeClient({
      staleBookings: [
        { id: "bk-fresh", traveler_id: "trav-1", status: AWAITING_BUDDY_STATUSES[0], expires_at: FUTURE },
      ],
    });
    const r = await runBuddyRequestSweep(client);
    assert.equal(r.expired, 0);
    assert.equal(idsFor(client, "rent_buddy_bookings").includes("bk-fresh"), false);
  });

  it("leaves an already-answered booking alone", async () => {
    // "scheduled" is what accept writes; it is not awaiting a response and must
    // never be swept, whatever its expires_at says.
    const client = makeClient({
      staleBookings: [{ id: "bk-scheduled", traveler_id: "trav-1", status: "scheduled", expires_at: PAST }],
    });
    const r = await runBuddyRequestSweep(client);
    assert.equal(r.expired, 0, "an accepted booking must not be expired by the sweeper");
  });

  it("expires a mixed batch in one pass", async () => {
    const client = makeClient({
      staleBookings: [
        ...AWAITING_BUDDY_STATUSES.map((status, i) => ({
          id: `bk-${i}`, traveler_id: "trav-1", status, expires_at: PAST,
        })),
        { id: "bk-fresh", traveler_id: "trav-1", status: AWAITING_BUDDY_STATUSES[0], expires_at: FUTURE },
        { id: "bk-done", traveler_id: "trav-1", status: "completed", expires_at: PAST },
      ],
    });
    const r = await runBuddyRequestSweep(client);
    assert.equal(r.expired, AWAITING_BUDDY_STATUSES.length);
    assert.deepEqual(
      idsFor(client, "rent_buddy_bookings").sort(),
      AWAITING_BUDDY_STATUSES.map((_, i) => `bk-${i}`).sort(),
    );
  });
});
