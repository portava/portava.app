/**
 * rent_buddy_earnings_ledger — "no balance depends on mutable totals" (`09` §11).
 *
 * ── THE VIOLATION ───────────────────────────────────────────────────────────
 * `docs/architecture/09_Payment_Architecture.md` §1.3 states the shape and then
 * draws the consequence: the table is ONE MUTABLE SUMMARY ROW PER BOOKING,
 * `UNIQUE (booking_id)` — and *"It records money as collected that was never
 * collected."* Migration 2901 added `rent_buddy_earnings_entries`: append-only,
 * signed, minor-unit, double-entry, rule-versioned, attributed, and the summary
 * row became a projection of those entries.
 *
 * ── WHAT THIS FILE USED TO TEST, AND WHERE THAT WENT (PAY-050 / PAY-055) ────
 * Until migration 3824 the entries were BUILT AND WRITTEN IN JAVASCRIPT by
 * `createEarningsLedgerEntry`, in two statements, and this file asserted their
 * properties against a recording client: priced components, append-not-upsert,
 * minor units and currency, balance, attribution, provider `none`, summary
 * equal to the fold, nothing booked as collected.
 *
 * The writer is one SQL function now (`rb_post_booking_ledger`). Asserting those
 * properties against a recording client would assert them about nothing: there
 * is no JavaScript that produces an entry any more. They are asserted against
 * rows read out of a real PostgreSQL by
 * `src/test/db/rentBuddyLedgerPosting.db.test.ts`, and the last block of this
 * file is a RATCHET that names, for every property this file used to hold, the
 * database test that holds it now — and fails if that test or its assertion is
 * removed. Nothing was dropped; it moved to where the code is.
 *
 * What is left to say about the JAVASCRIPT is the opposite claim, and it is the
 * one asserted here: the writer makes ONE call, touches NO table, computes
 * NOTHING, and when that call does not succeed it writes nothing a second way.
 *
 * ── THE CALLERS, NAMED ──────────────────────────────────────────────────────
 * `createEarningsLedgerEntry` is reached from all five booking-creation sites:
 * POST /rent-a-buddy/bookings, POST /bookings/:id/rebook, POST
 * /rent-a-buddy/requests, offer-accept and package-book (see the module header
 * and `rentBuddyEarningsLedgerCoverage.test.ts`).
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerBookingEntries.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEarningsLedgerEntry } from "../lib/rentBuddyEarningsLedger.js";
import { emptyLedgerDb, fakeLedgerRpc, functionNotFound } from "./helpers/fakeRentBuddyLedgerRpc.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Touch { table: string; op: string }

/**
 * A client that records every table it is asked for and every operation on it.
 * `createEarningsLedgerEntry` must leave `touches` EMPTY: it used to read
 * rent_buddy_profiles, rent_buddy_fee_rules and feature_flags and upsert two
 * tables; it now does none of that.
 */
function watchedClient(rpc?: (fn: string, args: any) => Promise<{ data: any; error: any }>) {
  const touches: Touch[] = [];
  const calls: Array<{ fn: string; args: any }> = [];
  const table = (t: string) => {
    const b: any = { _t: t };
    for (const op of ["select", "insert", "upsert", "update", "delete", "eq", "in", "maybeSingle", "single"]) {
      b[op] = () => { touches.push({ table: t, op }); return b; };
    }
    b.then = (res: (v: any) => void) => res({ data: null, error: null });
    return b;
  };
  const client: any = { from: (t: string) => { touches.push({ table: t, op: "from" }); return table(t); } };
  if (rpc) client.rpc = async (fn: string, args: any) => { calls.push({ fn, args }); return rpc(fn, args); };
  return { client, touches, calls };
}

const BOOKING = {
  id: "bk-1", traveler_id: "traveller-1", buddy_id: "buddy-prof-1", status: "requested",
  total_usd: 100, deposit_usd: 20, cash_balance_usd: 80,
};

function world() {
  return emptyLedgerDb({
    bookings: { "bk-1": { ...BOOKING } },
    buddyProfiles: { "buddy-prof-1": { user_id: "buddy-user-1", buddy_level: "pro" } },
    feeRules: { pro: 15 },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
describe("the writer is ONE database call — it reads no table, writes no table and computes nothing", () => {
  it("makes exactly one rpc call, for the booking, with the booking_created event", async () => {
    const db = world();
    const { client, touches, calls } = watchedClient(fakeLedgerRpc(db));
    const r = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");

    assert.equal(r.status, "written");
    assert.deepEqual(calls, [{
      fn: "rb_post_booking_ledger",
      args: { p_booking_id: "bk-1", p_event: "booking_created", p_event_key: null, p_args: {} },
    }]);
    assert.deepEqual(touches, [],
      "the writer touched a table itself — the fee read, the entry write and the summary write all belong to the one SQL function");
  });

  it("passes NO money figure to the database: the booking is priced from the stored row, not from the caller", async () => {
    const db = world();
    const { client, calls } = watchedClient(fakeLedgerRpc(db));
    // A caller holding a stale or doctored copy of the booking cannot move the ledger.
    await createEarningsLedgerEntry(client, { ...BOOKING, total_usd: 999999, tip_usd: 500, deposit_usd: 999999 }, "buddy-prof-1");
    const sent = JSON.stringify(calls[0]!.args);
    assert.equal(/999999|500/.test(sent), false, `a figure from the caller's copy reached the call: ${sent}`);
    assert.equal(db.ledger["bk-1"].total_booking_usd, 100, "the stored booking's total is what was ledgered");
  });

  it("derives the payee from the booking row, never from its buddyProfileId argument", async () => {
    const db = world();
    const { client, calls } = watchedClient(fakeLedgerRpc(db));
    await createEarningsLedgerEntry(client, BOOKING, "some-other-profile");
    assert.equal(JSON.stringify(calls[0]!.args).includes("some-other-profile"), false);
    assert.equal(db.ledger["bk-1"].buddy_user_id, "buddy-user-1");
  });

  it("reports the commission the DATABASE resolved, and says when the call was a replay", async () => {
    const db = world();
    const { client } = watchedClient(fakeLedgerRpc(db));
    const first = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    assert.deepEqual(first, { status: "written", bookingId: "bk-1", platformFeePercent: 15, replayed: false });

    const entriesAfterFirst = db.entries.length;
    const second = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    assert.equal(second.status, "written");
    assert.equal(second.status === "written" && second.replayed, true);
    assert.equal(db.entries.length, entriesAfterFirst, "a replay appended entries");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("refusals — when the one call does not succeed, NOTHING is written a second way", () => {
  const cases: Array<{
    name: string;
    rpc?: (fn: string, args: any) => Promise<{ data: any; error: any }>;
    expect: Record<string, unknown>;
  }> = [
    {
      name: "the client has no rpc() at all",
      rpc: undefined,
      expect: { status: "unavailable", error: "ledger_unavailable" },
    },
    {
      name: "the function is not in the schema cache (PGRST202) — migration 3824 is not applied",
      rpc: async (fn) => functionNotFound(fn),
      expect: { status: "unavailable", error: "ledger_unavailable" },
    },
    {
      name: "PostgreSQL says undefined_function (42883)",
      rpc: async () => ({ data: null, error: { code: "42883", message: "function public.rb_post_booking_ledger(uuid, text, text, jsonb) does not exist" } }),
      expect: { status: "unavailable", error: "ledger_unavailable" },
    },
    {
      name: "the call errors — e.g. the fee schedule is unreadable or holds a rate outside 0..100",
      rpc: async () => ({ data: null, error: { code: "22023", message: "fee_config_invalid: platform_fee_percent 150 for level x" } }),
      expect: { status: "failed", error: "ledger_write_failed" },
    },
    {
      name: "the call throws",
      rpc: async () => { throw new Error("socket hang up"); },
      expect: { status: "failed", error: "ledger_write_failed" },
    },
    {
      name: "the function answers nothing",
      rpc: async () => ({ data: null, error: null }),
      expect: { status: "failed", error: "ledger_write_failed" },
    },
    {
      name: "the database refuses by name (a negative total)",
      rpc: async () => ({ data: { ok: false, refusal: "invalid_total", detail: "-5" }, error: null }),
      expect: { status: "refused", refusal: "invalid_total" },
    },
    {
      name: "the database refuses by name (no payee for the booking)",
      rpc: async () => ({ data: { ok: false, refusal: "buddy_not_found", detail: "" }, error: null }),
      expect: { status: "refused", refusal: "buddy_not_found" },
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${JSON.stringify(c.expect)}, one attempt, no table touched`, async () => {
      const { client, touches, calls } = watchedClient(c.rpc);
      const r = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
      for (const [k, v] of Object.entries(c.expect)) assert.equal((r as any)[k], v, `${k} of ${JSON.stringify(r)}`);
      assert.notEqual(r.status, "written");
      assert.deepEqual(touches, [], "a fallback touched a table after the function did not answer");
      assert.ok(calls.length <= 1, `the call was retried ${calls.length} times`);
    });
  }

  it("is a no-op on missing arguments rather than throwing, and makes no call", async () => {
    const { client, touches, calls } = watchedClient(fakeLedgerRpc(world()));
    assert.deepEqual(await createEarningsLedgerEntry(client, null, "buddy-prof-1"), { status: "skipped", reason: "missing_arguments" });
    assert.deepEqual(await createEarningsLedgerEntry(client, BOOKING, ""), { status: "skipped", reason: "missing_arguments" });
    assert.deepEqual(await createEarningsLedgerEntry(client, { ...BOOKING, id: undefined }, "buddy-prof-1"), { status: "skipped", reason: "missing_arguments" });
    assert.deepEqual([touches, calls], [[], []]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The ratchet: every property this file asserted about the JavaScript-built
// entries is asserted about the SQL-written rows by a named database test.
// ═══════════════════════════════════════════════════════════════════════════
describe("each property this file used to assert about the entries is asserted against PostgreSQL now", () => {
  const DB_TEST = "db/rentBuddyLedgerPosting.db.test.ts";
  const src = readFileSync(join(HERE, DB_TEST), "utf8");

  /** The body of the database test whose title starts with `id`. */
  function bodyOf(id: string): string {
    const start = src.indexOf(`test("${id}. `);
    assert.notEqual(start, -1, `${DB_TEST} no longer has a test ${id}`);
    const next = src.indexOf("\n    test(\"", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  const MOVED: Array<{ was: string; now: string; needles: string[] }> = [
    {
      was: "writes entries for every priced component",
      now: "C1",
      needles: ['["booking_gross", "buddy_payable", 12345]', '["platform_fee", "platform_revenue", 1235]'],
    },
    {
      was: "appends — it never upserts onto a mutable conflict target (a replay does nothing)",
      now: "C4",
      needles: ["r.replayed, true", "r.entries_appended, 0", "JSON.stringify([entriesOf(bk), summaryOf(bk)]), before_"],
    },
    {
      was: "uniqueness is a database index, not an application check (concurrent replays)",
      now: "C5",
      needles: ["Array.from({ length: 8 }", "entriesOf(b).length, 4"],
    },
    {
      was: "writes entries in MINOR UNITS with an explicit currency",
      now: "C1",
      needles: ['x.currency, "USD"', "amount_minor"],
    },
    {
      was: "integer arithmetic, rounded once",
      now: "C7",
      needles: ["[10.05, 101]", "[0.04, 0]"],
    },
    {
      was: "writes a BALANCED double-entry set",
      now: "C2",
      needles: ["unbalancedTransactions(bk), 0"],
    },
    {
      was: "stamps cause, beneficiary, rule version and idempotency key on every entry",
      now: "C1",
      needles: ['x.attribution_kind, "booking"', "x.attribution_id, bk", "x.rule_version, RULE_V2", "x.beneficiary_user_id"],
    },
    {
      was: "idempotency keys are the pure model's, entry for entry",
      now: "C3",
      needles: ["buildBookingEntries({", "x.idempotencyKey", "model.entries.map(shape).sort()"],
    },
    {
      was: "ships provider 'none' — no processor is installed",
      now: "C1",
      needles: ['x.provider, "none"', "x.external_ref, null"],
    },
    {
      was: "the summary row is DERIVED from the entry fold, not from a second arithmetic path",
      now: "C1",
      needles: ['assertSummaryIsFold(bk, "C1")'],
    },
    {
      was: "STOPS recording money as collected that was never collected — even for a full_in_app booking",
      now: "C2",
      needles: ["s.in_app_amount_collected, 0", "s.deposit_amount, 123.45", "s.is_estimated, true"],
    },
    {
      was: "emits no entry that asserts settlement",
      now: "C2",
      needles: ['x.entry_reason === "settlement").length, 0'],
    },
    {
      was: "writes NEITHER entries nor summary when the take rate is not usable",
      now: "C8",
      needles: ["fee_config_invalid", "entriesOf(b).length, 0", "summaryOf(b), null"],
    },
    {
      was: "writes NEITHER when the entry set cannot be built (a negative total)",
      now: "C9",
      needles: ['"invalid_total"', "entriesOf(negative).length, 0", "summaryOf(negative), null"],
    },
  ];

  for (const m of MOVED) {
    it(`"${m.was}" → ${m.now}`, () => {
      const body = bodyOf(m.now);
      for (const needle of m.needles) {
        assert.ok(body.includes(needle),
          `${DB_TEST} ${m.now} no longer asserts \`${needle}\` — the property "${m.was}" would be asserted nowhere`);
      }
    });
  }

  it("the summary-is-the-fold helper really compares every money column to the entries", () => {
    const start = src.indexOf("function assertSummaryIsFold(");
    const helper = src.slice(start, src.indexOf("\n}\n", start));
    for (const col of ["total_booking_usd", "tip_usd", "platform_fee_amount", "buddy_gross_amount", "buddy_net_estimated_amount", "in_app_amount_collected", "is_estimated"]) {
      assert.ok(helper.includes(col), `assertSummaryIsFold no longer checks ${col}`);
    }
  });

  it("the database suite cannot pass by skipping: the runner refuses skipped > 0 and globs this directory", () => {
    const runner = readFileSync(join(HERE, "../../scripts/local-db/run-tests.sh"), "utf8");
    assert.match(runner, /src\/test\/db\/\*\.db\.test\.ts/);
    assert.match(runner, /skipped — a skipped database test verified nothing/);
  });
});
