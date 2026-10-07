/**
 * Every column the production payment store names exists in the schema it will
 * run against: migration 3931 for the slice's own tables, the 2026-08-19
 * baseline (+ 2212's country_code) for rent_buddy_bookings / rent_buddy_profiles.
 * PostgREST rejects an unknown column with 42703 and fails the WHOLE
 * statement; this suite is the static half of that check (there is no local
 * PostgreSQL; CI's live-DB tier applies 3931 for real).
 *
 * It also holds the migration's load-bearing constraints in place, so editing
 * them away is a red test, not a silent change: test mode only, components sum
 * to the amount, commission only from the service, no client grant, no DELETE.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyPaymentStoreSchema.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOKING_COLUMNS, PAYMENT_COLUMNS, PAYOUT_COLUMNS, RECIPIENT_COLUMNS, REFUND_COLUMNS,
  T_EVENTS, T_PAYMENTS, T_PAYOUTS, T_RECIPIENTS, T_REFUNDS,
  earliestStartInstant, paymentRow, payoutRow, refundRow,
} from "../services/payments/bookingPayments/supabaseStore.js";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, "../migrations/3931_rent_buddy_payments.sql"), "utf8");
const baseline = readFileSync(join(here, "../../baseline/20260819_baseline_structure.sql"), "utf8");
const m2212 = readFileSync(join(here, "../migrations/2212_rent_buddy_country_snapshot.sql"), "utf8");

/** Column names of `CREATE TABLE [IF NOT EXISTS] public.<table> ( … );` in `sql`. */
function columnsOf(sql: string, table: string): Set<string> {
  const re = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?public\\.${table} \\(([\\s\\S]*?)\\n\\);`);
  const m = re.exec(sql);
  assert.ok(m, `CREATE TABLE public.${table} not found`);
  const cols = new Set<string>();
  for (const line of m![1]!.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("--") || /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(t)) continue;
    const name = /^([a-z_][a-z0-9_]*)\s/.exec(t)?.[1];
    if (name) cols.add(name);
  }
  return cols;
}

const list = (s: string): string[] => s.split(",").map((c) => c.trim()).filter(Boolean);

describe("every column the store names exists", () => {
  it("rent_buddy_bookings / rent_buddy_profiles columns exist in the baseline (country_code via 2212)", () => {
    const booking = columnsOf(baseline, "rent_buddy_bookings");
    if (/ADD COLUMN IF NOT EXISTS country_code/.test(m2212)) booking.add("country_code");
    for (const c of list(BOOKING_COLUMNS)) assert.ok(booking.has(c), `rent_buddy_bookings.${c}`);
    assert.ok(booking.has("payment_status"), "the one booking column the slice writes");
    assert.ok(columnsOf(baseline, "rent_buddy_profiles").has("user_id"));
  });

  for (const [table, select, row] of [
    [T_RECIPIENTS, RECIPIENT_COLUMNS, null],
    [T_PAYMENTS, PAYMENT_COLUMNS, paymentRow],
    [T_REFUNDS, REFUND_COLUMNS, refundRow],
    [T_PAYOUTS, PAYOUT_COLUMNS, payoutRow],
  ] as const) {
    it(`${table}: every selected column, and every column a write produces, is in 3931`, () => {
      const cols = columnsOf(migration, table);
      for (const c of list(select)) assert.ok(cols.has(c), `${table}.${c} (select)`);
      if (row) {
        // A FULL record exercises every key the mapper can write.
        const full = new Proxy({}, { get: (_t, p) => (p === "amount" ? { amountMinor: 1, currency: "USD" } : p === "components" ? { serviceMinor: 1, payerFeeMinor: 0, tipMinor: 0, taxMinor: 0 } : p === "platformFee" ? { commissionMinor: 0, payerFeeMinor: 0, taxMinor: 0 } : p === "taxCalculationRefs" || p === "bookingPaymentIds" ? [] : "x") });
        for (const c of Object.keys((row as (p: object) => Record<string, unknown>)(full))) assert.ok(cols.has(c), `${table}.${c} (write)`);
      }
    });
  }

  it("payment_webhook_events has the columns the store writes and reads", () => {
    const cols = columnsOf(migration, T_EVENTS);
    for (const c of ["provider", "provider_event_id", "endpoint", "event_type", "occurred_at", "processed_at", "outcome"]) assert.ok(cols.has(c), c);
  });

  it("the recipient upsert writes only 3931 columns", () => {
    const cols = columnsOf(migration, T_RECIPIENTS);
    for (const c of ["party_id", "provider", "recipient_ref", "country", "settlement_currency", "onboarding", "charges_enabled", "payouts_enabled", "requirements_due", "provider_updated_at", "updated_at"]) assert.ok(cols.has(c), c);
  });
});

describe("3931's load-bearing constraints are present", () => {
  it("test mode only: livemode is CHECKed false on every provider-mirroring table", () => {
    for (const n of ["rbpr_test_mode_only", "rbmp_test_mode_only", "rbbp_test_mode_only"]) assert.match(migration, new RegExp(`CONSTRAINT ${n} CHECK \\(livemode = false\\)`), n);
  });
  it("components sum to the amount; commission only from the service; refunded <= captured", () => {
    assert.match(migration, /rbbp_components_sum CHECK \(service_minor \+ payer_fee_minor \+ tip_minor \+ tax_minor = amount_minor\)/);
    assert.match(migration, /rbbp_commission_from_service_only CHECK \(commission_minor <= service_minor\)/);
    assert.match(migration, /rbbp_refunded_bounded CHECK \(amount_refunded_minor BETWEEN 0 AND amount_captured_minor\)/);
  });
  it("no client grant, and no DELETE even for service_role", () => {
    assert.match(migration, /REVOKE ALL ON public\.%I FROM anon/);
    assert.match(migration, /REVOKE ALL ON public\.%I FROM authenticated/);
    assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON public\.%I TO service_role/);
    assert.doesNotMatch(migration, /GRANT[^;]*DELETE/);
  });
  it("a refund must STATE whether the platform fee is refunded (no default)", () => {
    assert.match(migration, /refund_platform_fee\s+boolean\s+NOT NULL,/);
  });
  it("no deposit column exists anywhere in the slice's tables", () => {
    assert.doesNotMatch(migration.replace(/--.*$/gm, ""), /deposit/i);
  });
});

describe("earliestStartInstant: 'before the service begins' only when true in every zone", () => {
  it("is the local start read as UTC minus 14 hours", () => {
    assert.equal(earliestStartInstant("2026-08-20", "15:00:00"), "2026-08-20T01:00:00.000Z");
    assert.equal(earliestStartInstant("2026-08-20", "09:30"), "2026-08-19T19:30:00.000Z");
  });
  it("is null when either part is missing or malformed (the refund then goes to support)", () => {
    assert.equal(earliestStartInstant("2026-08-20", null), null);
    assert.equal(earliestStartInstant(null, "10:00"), null);
    assert.equal(earliestStartInstant("20-08-2026", "10:00"), null);
  });
});

// ── The column checks can SEE this store (check:write-path-columns, 2026-10-07) ──
// CI's live-DB tier went red on #640 at 79edb99019: every `.from(T_PAYMENTS)`-style
// call was a "dynamic table name" (29 sites), so neither check:write-path-columns
// (live schema) nor check:schema-references (baseline + migrations) checked one
// column of the five 3931 tables. The row builders assembled rows key by key,
// which the extractor cannot read either. The cases below run THE SAME extractor
// the two guards run, over this one file.
import { extractSchemaReferences } from "../scripts/lib/schemaReferenceExtract.js";

const API_ROOT = join(here, "../..");
const STORE_FILE = join(here, "../services/payments/bookingPayments/supabaseStore.ts");

describe("supabaseStore.ts is not a blind spot to the column checks", () => {
  const { sites, skipped } = extractSchemaReferences(API_ROOT, [STORE_FILE]);

  it("every .from() is a literal and every payload / select list resolves: zero skipped, zero partial", () => {
    assert.deepEqual(skipped.map((s) => `${s.line} ${s.method} ${s.reason}`), []);
    assert.deepEqual(sites.filter((s) => s.unresolved).map((s) => `${s.line} ${s.method}`), []);
  });

  it("the literals name exactly the five 3931 tables (the T_* names) plus the three the store reads", () => {
    const tables = new Set(sites.map((s) => s.table));
    assert.deepEqual([...tables].sort(), [T_EVENTS, T_PAYMENTS, T_PAYOUTS, T_RECIPIENTS, T_REFUNDS, "payment_parties", "rent_buddy_bookings", "rent_buddy_profiles"].sort());
  });

  it("every column a 3931 write or read names, as the extractor sees it, is a 3931 column", () => {
    for (const s of sites) {
      if (![T_EVENTS, T_PAYMENTS, T_PAYOUTS, T_RECIPIENTS, T_REFUNDS].includes(s.table)) continue;
      const cols = columnsOf(migration, s.table);
      for (const c of s.columns) assert.ok(cols.has(c), `${s.table}.${c} (${s.method}, supabaseStore.ts:${s.line})`);
    }
  });

  // What the extractor reads must be what the builder WRITES. A key added to a
  // row outside its one literal would be written to the database and never
  // checked; this is the case that catches it.
  const FULL = new Proxy({}, { get: (_t, p) => (p === "amount" ? { amountMinor: 1, currency: "USD" } : p === "components" ? { serviceMinor: 1, payerFeeMinor: 0, tipMinor: 0, taxMinor: 0 } : p === "platformFee" ? { commissionMinor: 0, payerFeeMinor: 0, taxMinor: 0 } : p === "taxCalculationRefs" || p === "bookingPaymentIds" ? [] : "x") });
  for (const [table, built] of [
    [T_PAYMENTS, Object.keys(paymentRow(FULL))],
    [T_REFUNDS, Object.keys(refundRow(FULL, "2026-10-07T00:00:00.000Z"))],
    [T_PAYOUTS, Object.keys(payoutRow(FULL))],
  ] as const) {
    it(`${table}: the insert the extractor checks names every key the builder can write`, () => {
      const insert = sites.find((s) => s.table === table && s.method === "insert");
      assert.ok(insert, `${table} insert site`);
      assert.deepEqual([...insert!.columns].sort(), [...built].sort());
    });
  }
});

describe("the row builders write only what a patch names", () => {
  it("absent keys are not written; null is a value and is written", () => {
    assert.deepEqual(paymentRow({ state: "succeeded", updatedAt: "2026-10-07T00:00:00.000Z", failureReason: null }), {
      state: "succeeded", updated_at: "2026-10-07T00:00:00.000Z", failure_reason: null,
    });
    assert.deepEqual(payoutRow({ state: "held", holdReason: null }), { state: "held", hold_reason: null });
    assert.deepEqual(refundRow({ state: "pending" }), { state: "pending" });
  });
  it("a refund UPDATE carries its own updated_at stamp; an insert does not invent one", () => {
    assert.deepEqual(refundRow({ state: "succeeded" }, "2026-10-07T01:02:03.000Z"), { state: "succeeded", updated_at: "2026-10-07T01:02:03.000Z" });
    assert.equal("updated_at" in refundRow({ id: "r1", state: "requested" }), false);
  });
});
