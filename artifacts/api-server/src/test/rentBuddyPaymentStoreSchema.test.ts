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
    for (const c of ["user_id", "provider", "recipient_ref", "country", "settlement_currency", "onboarding", "charges_enabled", "payouts_enabled", "requirements_due", "provider_updated_at", "updated_at"]) assert.ok(cols.has(c), c);
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
