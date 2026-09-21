/**
 * rent_buddy_earnings_ledger — every booking-creation path must write one.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Five routes INSERT into rent_buddy_bookings. The ledger writer was a
 * module-private helper inside rentABuddyMarketplace.ts and so was reachable
 * from only two of them (offer-accept and package-book). The other three —
 * the CANONICAL POST /rent-a-buddy/bookings, rebook, and the spec request —
 * created a booking and no ledger row.
 *
 * GET /rent-a-buddy/me/earnings/ledger reads that table and nothing else. A
 * buddy whose bookings arrived the ordinary way therefore saw
 * `{ ledger: [], total: 0 }` forever, no matter how much work they had done.
 *
 * ── TWO HALVES ──────────────────────────────────────────────────────────────
 * The arithmetic is pinned directly against a recording client, and the
 * CO-LOCATION — that no booking insert exists without a ledger write beside it —
 * is pinned by reading the routers as text. The second half is what stops a
 * sixth creation path from being added later with the same hole; a runtime test
 * can only cover paths someone remembered to write a test for.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyEarningsLedgerCoverage.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEarningsLedgerEntry } from "../lib/rentBuddyEarningsLedger.js";

const ROUTES = join(dirname(fileURLToPath(import.meta.url)), "../routes");

/**
 * The routers that create bookings. Kept explicit rather than globbed so that a
 * NEW router creating bookings is a deliberate edit to this list, reviewed
 * alongside the ledger write it must carry.
 */
const BOOKING_CREATION_ROUTERS = [
  "rentABuddy.ts",
  "rentABuddySpec.ts",
  "rentABuddyMarketplace.ts",
] as const;

/**
 * `.from("rent_buddy_bookings")` followed by `.insert(` with only whitespace,
 * comments and chained builder calls between them. Deliberately narrow: an
 * `.update(` or a `.select(` on the same table is not a creation site.
 */
const BOOKING_INSERT_RE = /\.from\(\s*["']rent_buddy_bookings["']\s*\)\s*(?:\/\/[^\n]*\n|\s)*\.insert\(/g;
const LEDGER_CALL_RE = /createEarningsLedgerEntry\s*\(/g;

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// ── Co-location ──────────────────────────────────────────────────────────────

describe("every rent_buddy_bookings INSERT is accompanied by a ledger write", () => {
  const perFile = BOOKING_CREATION_ROUTERS.map((f) => {
    const src = readFileSync(join(ROUTES, f), "utf8");
    return { f, inserts: count(src, BOOKING_INSERT_RE), ledgers: count(src, LEDGER_CALL_RE) };
  });

  it("finds the five known booking-creation sites, so the scan is not vacuous", () => {
    const total = perFile.reduce((n, r) => n + r.inserts, 0);
    assert.equal(
      total, 5,
      `expected 5 booking-creation sites across ${BOOKING_CREATION_ROUTERS.join(", ")}, ` +
      `found ${total}: ${JSON.stringify(perFile)}. A changed count means a creation ` +
      "path was added or removed — check it writes a ledger row, then update this number.",
    );
  });

  for (const { f, inserts, ledgers } of perFile) {
    it(`${f}: ${inserts} booking insert(s), ${ledgers} ledger write(s)`, () => {
      assert.ok(
        ledgers >= inserts,
        `${f} creates ${inserts} booking(s) but calls createEarningsLedgerEntry ${ledgers} time(s). ` +
        "A booking created without a ledger row is invisible to GET /me/earnings/ledger forever.",
      );
    });
  }
});

// ── The arithmetic ───────────────────────────────────────────────────────────

interface Rec { table: string; op: string; payload: any }

function recordingClient(
  opts: { buddy?: any; feeRule?: any; feeRuleError?: any; rentBuddyEnabled?: boolean } = {},
) {
  const writes: Rec[] = [];
  const table = (t: string) => ({
    _t: t,
    _f: [] as Array<[string, any]>,
    _single: false,
    select() { return this; },
    eq(c: string, v: any) { this._f.push([c, v]); return this; },
    maybeSingle() { this._single = true; return this; },
    upsert(payload: any) { writes.push({ table: this._t, op: "upsert", payload }); return this; },
    async then(res: (v: any) => void) {
      if (this._t === "rent_buddy_profiles") return res({ data: opts.buddy ?? null, error: null });
      if (this._t === "rent_buddy_fee_rules") {
        return res({ data: opts.feeRule ?? null, error: opts.feeRuleError ?? null });
      }
      // The marketplace master switch. Absent row → isFlagEnabled() reads
      // false, which is production's actual state.
      if (this._t === "feature_flags") {
        return res({ data: opts.rentBuddyEnabled ? { enabled: true } : null, error: null });
      }
      return res({ data: null, error: null });
    },
  });
  return { client: { from: (t: string) => table(t) }, writes };
}

const BOOKING = {
  id: "bk-1",
  traveler_id: "traveller-1",
  total_usd: 100,
  deposit_usd: 20,
  cash_balance_usd: 80,
  tip_usd: 10,
};

describe("createEarningsLedgerEntry — the estimated breakdown", () => {
  it("uses the buddy level's fee rule and derives gross/net from it", async () => {
    const { client, writes } = recordingClient({
      buddy: { user_id: "buddy-user-1", buddy_level: "trusted" },
      feeRule: { platform_fee_percent: 15, traveler_service_fee_usd: 3 },
      // Charging travellers is Stage 4 / ruling R1; the amount is only recorded
      // once the marketplace is live. Turned on here so the 3.00 the schedule
      // specifies is the 3.00 the row carries.
      rentBuddyEnabled: true,
    });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");

    const row = writes.find((w) => w.table === "rent_buddy_earnings_ledger")?.payload;
    assert.ok(row, "no ledger row written");
    assert.equal(row.booking_id, "bk-1");
    assert.equal(row.buddy_user_id, "buddy-user-1");
    assert.equal(row.traveler_id, "traveller-1");
    assert.equal(row.platform_fee_percent, 15);
    assert.equal(row.platform_fee_amount, 15);          // 100 * 15%
    assert.equal(row.buddy_gross_amount, 110);          // total + tip
    assert.equal(row.buddy_net_estimated_amount, 95);   // gross - fee
    assert.equal(row.traveler_service_fee_amount, 3);
    assert.equal(row.deposit_amount, 20);
    assert.equal(row.cash_balance_due, 80);
    assert.equal(row.cash_balance_confirmed, false);
    assert.equal(row.is_estimated, true, "no money moves — the row is an estimate");
  });

  // ── The fallback that used to be here is the defect (M1 / M10) ─────────────
  //
  // This test used to assert that a level with no fee row was priced at
  // DEFAULT_PLATFORM_FEE_PERCENT = 22. That is precisely the failure `08` §2.6
  // names: the absence of a row is indistinguishable from a deliberate 22 %,
  // and the buddy's money record is written from a number nobody configured.
  // The literal is gone and the assertion is inverted.

  it("writes NO row when the buddy's level has no fee rule", async () => {
    const { client, writes } = recordingClient({
      buddy: { user_id: "buddy-user-1", buddy_level: "standard" }, // settable by admin, no fee row
      feeRule: null,
    });
    const result = await createEarningsLedgerEntry(client, { ...BOOKING, tip_usd: 0 }, "buddy-prof-1");

    assert.equal(writes.filter((w) => w.table === "rent_buddy_earnings_ledger").length, 0,
      "a booking must not be priced at a guessed take rate");
    assert.deepEqual(
      { status: result.status, reason: (result as any).reason },
      { status: "fee_unresolved", reason: "no_such_level" },
      "the caller must be able to tell 'no fee row' from a successful write",
    );
  });

  it("writes NO row when the fee table cannot be read, and says so distinguishably", async () => {
    const { client, writes } = recordingClient({
      buddy: { user_id: "buddy-user-1", buddy_level: "new" },
      feeRuleError: { message: "permission denied for table rent_buddy_fee_rules" },
    });
    const result = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");

    assert.equal(writes.filter((w) => w.table === "rent_buddy_earnings_ledger").length, 0);
    assert.equal(result.status, "fee_unresolved");
    assert.equal((result as any).reason, "read_failed",
      "an unreadable schedule is not the same answer as an absent row");
  });

  it("keeps the traveller service fee at 0 while rent_buddy_enabled is off", async () => {
    // The production schedule is traveler_service_fee_usd = 0.00 and
    // traveler_service_fee_pct = 5.00 on all five rows. Reading _pct makes the
    // 5 % reachable; the master switch keeps the recorded amount at 0, so this
    // change charges nobody. Stage 4 / R1 decides whether it ever does.
    const { client, writes } = recordingClient({
      buddy: { user_id: "buddy-user-1", buddy_level: "new" },
      feeRule: { platform_fee_percent: 25, traveler_service_fee_usd: 0, traveler_service_fee_pct: 5 },
      rentBuddyEnabled: false,
    });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");

    const row = writes.find((w) => w.table === "rent_buddy_earnings_ledger")?.payload;
    assert.ok(row);
    assert.equal(row.platform_fee_percent, 25);
    assert.equal(row.traveler_service_fee_amount, 0);
  });

  it("reads traveler_service_fee_pct, not just _usd, once the lane is live", async () => {
    const { client, writes } = recordingClient({
      buddy: { user_id: "buddy-user-1", buddy_level: "new" },
      feeRule: { platform_fee_percent: 25, traveler_service_fee_usd: 0, traveler_service_fee_pct: 5 },
      rentBuddyEnabled: true,
    });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");

    const row = writes.find((w) => w.table === "rent_buddy_earnings_ledger")?.payload;
    assert.ok(row);
    // 5 % of the 100.00 booking total. Under the old reader this was 0.00 no
    // matter what an admin set, because only _usd was read and it is 0 on
    // every production row.
    assert.equal(row.traveler_service_fee_amount, 5);
  });

  it("writes nothing when the buddy profile cannot be loaded", async () => {
    const { client, writes } = recordingClient({ buddy: null });
    const result = await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    assert.equal(writes.filter((w) => w.table === "rent_buddy_earnings_ledger").length, 0);
    assert.equal(result.status, "skipped");
  });

  it("is a no-op on missing arguments rather than throwing", async () => {
    const { client, writes } = recordingClient({ buddy: { user_id: "u", buddy_level: "new" } });
    await createEarningsLedgerEntry(client, null, "buddy-prof-1");
    await createEarningsLedgerEntry(client, BOOKING, "");
    assert.equal(writes.length, 0);
  });
});
