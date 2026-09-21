/**
 * rent_buddy_earnings_ledger — "no balance depends on mutable totals" (`09` §11).
 *
 * ── THE VIOLATION ───────────────────────────────────────────────────────────
 * `docs/architecture/09_Payment_Architecture.md:71-105` (§1.3) states the shape
 * and then draws the consequence: the table is ONE MUTABLE SUMMARY ROW PER
 * BOOKING, `UNIQUE (booking_id)`, written by a single upsert on that conflict
 * target — and *"It records money as collected that was never collected."*
 * `in_app_amount_collected: Number(booking.deposit_usd ?? 0)`, while
 * `pay-deposit` / `pay-full` return 503 and no money exists. For
 * `payment_mode = 'full_in_app'`, `deposit_usd` IS the whole total, so a booking
 * booked its entire value as collected at the moment it was made.
 *
 * ── THE FIX, AND WHY IT IS ADDITIVE ─────────────────────────────────────────
 * `rent_buddy_earnings_ledger` has live rows in production and
 * `GET /rent-a-buddy/me/earnings/ledger` reads it. Reshaping it would either
 * lose those rows' meaning or break the read. So the summary row STAYS, with
 * exactly the meaning it has always had (`is_estimated: true`) — and stops being
 * the source of any balance. Migration 2901 adds
 * `rent_buddy_earnings_entries`: append-only, signed, minor-unit, double-entry,
 * rule-versioned, attributed. Every money figure on the summary row is now
 * DERIVED by folding those entries, so the row is a projection of an
 * append-only truth rather than a total somebody maintains.
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
import { createEarningsLedgerEntry } from "../lib/rentBuddyEarningsLedger.js";
import {
  reconstructBalances,
  unbalancedTransactions,
  type LedgerEntry,
} from "../lib/creatorLedgerEntries.js";

interface Rec { table: string; op: string; payload: any; options?: any }

function recordingClient(
  opts: { buddy?: any; feeRule?: any; feeRuleError?: any; rentBuddyEnabled?: boolean; entriesError?: any } = {},
) {
  const writes: Rec[] = [];
  const table = (t: string) => ({
    _t: t,
    select() { return this; },
    eq() { return this; },
    maybeSingle() { return this; },
    upsert(payload: any, options?: any) { writes.push({ table: this._t, op: "upsert", payload, options }); return this; },
    async then(res: (v: any) => void) {
      if (this._t === "rent_buddy_profiles") return res({ data: opts.buddy ?? null, error: null });
      if (this._t === "rent_buddy_fee_rules") return res({ data: opts.feeRule ?? null, error: opts.feeRuleError ?? null });
      if (this._t === "feature_flags") return res({ data: opts.rentBuddyEnabled ? { enabled: true } : null, error: null });
      if (this._t === "rent_buddy_earnings_entries") return res({ data: null, error: opts.entriesError ?? null });
      return res({ data: null, error: null });
    },
  });
  return { client: { from: (t: string) => table(t) }, writes };
}

const BOOKING = {
  id: "bk-1", traveler_id: "traveller-1",
  total_usd: 100, deposit_usd: 20, cash_balance_usd: 80, tip_usd: 10,
};
const BUDDY = { user_id: "buddy-user-1", buddy_level: "trusted" };
const FEE = { platform_fee_percent: 15, traveler_service_fee_usd: 3 };

const summary = (w: Rec[]) => w.find((x) => x.table === "rent_buddy_earnings_ledger")?.payload;
const entryWrite = (w: Rec[]) => w.find((x) => x.table === "rent_buddy_earnings_entries");
const entryRows = (w: Rec[]): any[] => {
  const p = entryWrite(w)?.payload;
  return Array.isArray(p) ? p : p ? [p] : [];
};

// ═══════════════════════════════════════════════════════════════════════════
describe("the append-only entries are written beside the summary row", () => {
  it("writes entries for every priced component", async () => {
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");

    const rows = entryRows(writes);
    assert.ok(rows.length > 0, "no append-only entries written — the balance still has no immutable source");
    const reasons = new Set(rows.map((r) => r.entry_reason));
    assert.deepEqual([...reasons].sort(), ["booking_gross", "platform_fee", "tip", "traveler_service_fee"]);
  });

  it("appends — it never upserts onto a mutable conflict target", async () => {
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    const w = entryWrite(writes);
    assert.ok(w, "no entries write");
    assert.equal(w!.options?.ignoreDuplicates, true,
      "a replay must DO NOTHING, never overwrite: the entries table is append-only");
    assert.equal(w!.options?.onConflict, "idempotency_key",
      "`09` §7.2: uniqueness is a database index, not an application check");
  });

  it("writes entries in MINOR UNITS with an explicit currency", async () => {
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    for (const r of entryRows(writes)) {
      assert.equal(Number.isInteger(r.amount_minor), true, `${r.entry_reason} is not an integer minor amount`);
      assert.equal(r.currency, "USD", "`09` §3: no amount is stored without its currency");
      assert.notEqual(r.amount_minor, 0);
    }
  });

  it("writes a BALANCED double-entry set — a fictitious figure has no counterpart", async () => {
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    const asEntries = entryRows(writes).map((r) => ({
      transactionKey: r.transaction_key, currency: r.currency,
      amountMinor: r.amount_minor, account: r.account,
    })) as unknown as LedgerEntry[];
    assert.deepEqual(unbalancedTransactions(asEntries), []);
  });

  it("stamps cause, beneficiary, rule version and idempotency key on every entry", async () => {
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    const keys = new Set<string>();
    for (const r of entryRows(writes)) {
      assert.equal(r.attribution_kind, "booking");
      assert.equal(r.attribution_id, "bk-1");
      assert.ok(String(r.rule_version).length > 0);
      assert.ok(String(r.idempotency_key).length > 0);
      keys.add(r.idempotency_key);
      if (r.account === "buddy_payable") assert.equal(r.beneficiary_user_id, "buddy-user-1");
    }
    assert.equal(keys.size, entryRows(writes).length, "idempotency keys must be unique per entry");
  });

  it("ships provider 'none' — no processor is installed (`09` §1.1)", async () => {
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    for (const r of entryRows(writes)) {
      assert.equal(r.provider, "none");
      assert.equal(r.external_ref, null);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the summary row is DERIVED from the entries", () => {
  it("reproduces the arithmetic the ledger has always produced", async () => {
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    const row = summary(writes);
    assert.ok(row);
    assert.equal(row.platform_fee_percent, 15);
    assert.equal(row.platform_fee_amount, 15);
    assert.equal(row.buddy_gross_amount, 110);
    assert.equal(row.buddy_net_estimated_amount, 95);
    assert.equal(row.traveler_service_fee_amount, 3);
    assert.equal(row.is_estimated, true);
  });

  it("derives net from the ENTRY FOLD, not from a second arithmetic path", async () => {
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    const rows = entryRows(writes);
    const balances = reconstructBalances(rows.map((r) => ({
      account: r.account, amountMinor: r.amount_minor,
    })) as unknown as LedgerEntry[]);
    const row = summary(writes);
    assert.equal(row.buddy_net_estimated_amount, balances.buddy_payable / 100,
      "`09` §1.3.3: three call sites computing net three ways is the defect; there must be ONE");
    assert.equal(row.platform_fee_amount + row.traveler_service_fee_amount,
      balances.platform_revenue / 100);
  });

  it("STOPS recording money as collected that was never collected (§1.3.1 / M5)", async () => {
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    const row = summary(writes);
    assert.equal(row.in_app_amount_collected, 0,
      "pay-deposit and pay-full return 503; nothing was collected, so 0 is the only honest figure");
    assert.equal(row.deposit_amount, 20, "the deposit DUE is a booking fact and is still recorded");
  });

  it("books nothing as collected even for a full_in_app booking — the worst case", async () => {
    // payment_mode = 'full_in_app' sets deposit_usd = total_usd
    // (routes/rentABuddy.ts derives the split), so the old writer recorded the
    // ENTIRE booking value as in-app collected at the moment of booking.
    const fullInApp = { ...BOOKING, deposit_usd: 100, cash_balance_usd: 0 };
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    await createEarningsLedgerEntry(client, fullInApp, "buddy-prof-1");
    assert.equal(summary(writes).in_app_amount_collected, 0);
  });

  it("emits no entry that asserts settlement, in any booking shape", async () => {
    for (const b of [BOOKING, { ...BOOKING, deposit_usd: 100, cash_balance_usd: 0 }, { ...BOOKING, tip_usd: 0 }]) {
      const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
      await createEarningsLedgerEntry(client, b, "buddy-prof-1");
      for (const r of entryRows(writes)) {
        assert.ok(!["collection", "capture", "payout", "settlement"].includes(r.entry_reason));
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("refusals — the summary row is never written without its entries", () => {
  it("writes NEITHER when the take rate cannot be resolved", async () => {
    const { client, writes } = recordingClient({ buddy: { ...BUDDY, buddy_level: "standard" }, feeRule: null });
    const r = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    assert.equal(r.status, "fee_unresolved");
    assert.equal(writes.filter((w) => w.table === "rent_buddy_earnings_ledger").length, 0);
    assert.equal(writes.filter((w) => w.table === "rent_buddy_earnings_entries").length, 0);
  });

  it("writes NEITHER when the entry set cannot be built", async () => {
    // A negative total is not a bookable earning. The builder refuses; nothing
    // may be written on the strength of a figure it rejected.
    const { client, writes } = recordingClient({ buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true });
    const r = await createEarningsLedgerEntry(client, { ...BOOKING, total_usd: -5 }, "buddy-prof-1");
    assert.equal(r.status, "entries_refused");
    assert.equal(writes.filter((w) => w.table === "rent_buddy_earnings_ledger").length, 0);
    assert.equal(writes.filter((w) => w.table === "rent_buddy_earnings_entries").length, 0);
  });

  it("does NOT write the summary row when the entries write fails", async () => {
    // The entries are the truth; the summary is their projection. A projection
    // written from entries that are not there is exactly the old defect.
    const { client, writes } = recordingClient({
      buddy: BUDDY, feeRule: FEE, rentBuddyEnabled: true,
      entriesError: { message: "permission denied for table rent_buddy_earnings_entries" },
    });
    const r = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    assert.equal(r.status, "entries_write_failed");
    assert.equal(writes.filter((w) => w.table === "rent_buddy_earnings_ledger").length, 0);
  });

  it("still writes nothing when the buddy profile cannot be loaded", async () => {
    const { client, writes } = recordingClient({ buddy: null });
    const r = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    assert.equal(r.status, "skipped");
    assert.equal(writes.length, 0);
  });
});
