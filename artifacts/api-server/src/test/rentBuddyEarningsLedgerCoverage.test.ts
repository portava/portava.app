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
import {
  DEFAULT_PLATFORM_FEE_PERCENT,
  createEarningsLedgerEntry,
} from "../lib/rentBuddyEarningsLedger.js";

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

function recordingClient(opts: { buddy?: any; feeRule?: any } = {}) {
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
      if (this._t === "rent_buddy_fee_rules") return res({ data: opts.feeRule ?? null, error: null });
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

  it("falls back to the default platform fee when the level has no rule", async () => {
    const { client, writes } = recordingClient({
      buddy: { user_id: "buddy-user-1", buddy_level: "new" },
      feeRule: null,
    });
    await createEarningsLedgerEntry(client, { ...BOOKING, tip_usd: 0 }, "buddy-prof-1");

    const row = writes.find((w) => w.table === "rent_buddy_earnings_ledger")?.payload;
    assert.ok(row);
    assert.equal(row.platform_fee_percent, DEFAULT_PLATFORM_FEE_PERCENT);
    assert.equal(row.platform_fee_amount, 22);
    assert.equal(row.buddy_net_estimated_amount, 78);
  });

  it("writes nothing when the buddy profile cannot be loaded", async () => {
    const { client, writes } = recordingClient({ buddy: null });
    await createEarningsLedgerEntry(client, BOOKING, "buddy-prof-1");
    assert.equal(writes.filter((w) => w.table === "rent_buddy_earnings_ledger").length, 0);
  });

  it("is a no-op on missing arguments rather than throwing", async () => {
    const { client, writes } = recordingClient({ buddy: { user_id: "u", buddy_level: "new" } });
    await createEarningsLedgerEntry(client, null, "buddy-prof-1");
    await createEarningsLedgerEntry(client, BOOKING, "");
    assert.equal(writes.length, 0);
  });
});
