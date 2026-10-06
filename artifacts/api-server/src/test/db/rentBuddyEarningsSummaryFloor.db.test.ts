/**
 * rentBuddyEarningsSummaryFloor.db.test.ts — 3603, EXECUTED against PostgreSQL.
 *
 * 3603 makes `rb_buddy_earnings_summary(uuid, numeric)` FLOOR the per-booking
 * platform fee — the rule the checkout's commission uses (lane B:
 * commissionMinor = floor(service × bps / 10000)) and the rule
 * lib/rentBuddyFeeSchedule.ts#applyBasisPoints now uses for the estimate. The
 * static half (the file's text) is in rentBuddyCommissionBasisPoints.test.ts;
 * this is the half only PostgreSQL can decide:
 *
 *   Q1  the INSTALLED body floors the fee and no longer ROUNDs it
 *   Q2  over 2,000 completed bookings ($0.01 … $20.00) the summary's
 *       totalPlatformFeesUsd equals the sum of applyBasisPoints at 1000 bps and
 *       at 1050 bps, cent for cent — the SQL path, the TypeScript fold and the
 *       charge agree
 *   Q3  a booking whose fee is a fraction of a cent above a whole cent ($0.35)
 *       reports $0.03, not the $0.04 3530 / 2330 reported
 *
 * Controlled data on the throwaway harness only, all inside one transaction
 * that is rolled back: no production claim, nothing left behind.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, exec, scalar } from "./localDb.ts";
import { applyBasisPoints } from "../../lib/rentBuddyFeeSchedule.js";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";
const FN = "public.rb_buddy_earnings_summary(uuid,numeric)";

/** Seed one buddy with completed bookings at `cents` (inside the caller's transaction) and return the SQL. */
function seedSql(buddyUser: string, traveler: string, buddyProfile: string, cents: string): string {
  return [
    `INSERT INTO auth.users (id, email) VALUES ('${buddyUser}', 'q3603_b_${buddyUser.slice(0, 8)}@local.test'), ('${traveler}', 'q3603_t_${traveler.slice(0, 8)}@local.test');`,
    `INSERT INTO public.profiles (id, handle, name) VALUES ('${buddyUser}', 'q3603_b_${buddyUser.slice(0, 8)}', 'q3603 buddy'), ('${traveler}', 'q3603_t_${traveler.slice(0, 8)}', 'q3603 traveller');`,
    `INSERT INTO public.rent_buddy_profiles (id, user_id, city) VALUES ('${buddyProfile}', '${buddyUser}', 'SYNTHETIC-3603');`,
    `INSERT INTO public.rent_buddy_bookings (id, buddy_id, traveler_id, booking_date, duration_h, city, category, status, total_usd, completed_at)`,
    `  SELECT gen_random_uuid(), '${buddyProfile}', '${traveler}', current_date, 1, 'SYNTHETIC-3603', 'local_guide', 'completed', (c / 100.0)::numeric(10,2), now()`,
    `    FROM ${cents} AS g(c);`,
  ].join("\n");
}

/** Run the seed and the given SELECTs in one transaction, roll it back, and return the SELECTs' output. */
function summarise(cents: string, selects: (buddyProfile: string) => string[]): string[] {
  const buddyUser = randomUUID();
  const traveler = randomUUID();
  const buddyProfile = randomUUID();
  return exec(["BEGIN;", seedSql(buddyUser, traveler, buddyProfile, cents), ...selects(buddyProfile), "ROLLBACK;"].join("\n"));
}

/** The TypeScript estimate for the same bookings, summed in whole cents. */
function tsFeesCents(from: number, to: number, bps: number): number {
  let sum = 0;
  for (let c = from; c <= to; c++) sum += Math.round(applyBasisPoints(c / 100, bps)! * 100);
  return sum;
}

describe("3603 rb_buddy_earnings_summary floors the commission on a real database", { skip: SKIP }, () => {
  before(() => {
    assert.ok(scalar(`SELECT to_regprocedure('${FN}')::text`), "rb_buddy_earnings_summary exists on this database");
  });

  it("Q1 the installed body floors the per-booking fee and no longer rounds it", () => {
    const body = scalar(`SELECT pg_get_functiondef(to_regprocedure('${FN}'))`) ?? "";
    assert.match(body, /FLOOR\(COALESCE\(b\.total_usd, 0\)::numeric \* COALESCE\(p_platform_fee_pct, 0\) \* 100\) \/ 100/,
      "3603 is not the installed definition");
    assert.doesNotMatch(body, /ROUND\(COALESCE\(b\.total_usd/, "3530's / 2330's half-away rounding is still installed");
  });

  it("Q2 over 2,000 bookings the SQL fee total equals the TypeScript estimate at 1000 and 1050 bps, cent for cent", () => {
    const out = summarise("generate_series(1, 2000)", (bp) => [
      `SELECT round((public.rb_buddy_earnings_summary('${bp}', 0.1) ->> 'totalPlatformFeesUsd')::numeric * 100)::bigint;`,
      `SELECT round((public.rb_buddy_earnings_summary('${bp}', 0.105) ->> 'totalPlatformFeesUsd')::numeric * 100)::bigint;`,
    ]);
    const [at1000, at1050] = out.slice(-2).map(Number);
    assert.equal(at1000, tsFeesCents(1, 2000, 1000), "SQL and applyBasisPoints disagree at 1000 bps");
    assert.equal(at1050, tsFeesCents(1, 2000, 1050), "SQL and applyBasisPoints disagree at 1050 bps");
    // The control: half-up (3530's rule) would have charged more on this set,
    // so equality above is not an accident of the amounts chosen.
    let halfUp = 0;
    for (let c = 1; c <= 2000; c++) halfUp += Math.floor((c * 1000 + 5000) / 10000);
    assert.ok(halfUp > at1000, `half-up totals ${halfUp} cents against the floor's ${at1000}`);
  });

  it("Q3 a $0.35 booking reports a $0.03 fee and a $0.32 net, as the checkout takes", () => {
    const out = summarise("(VALUES (35))", (bp) => [
      `SELECT (public.rb_buddy_earnings_summary('${bp}', 0.1) ->> 'totalPlatformFeesUsd')::numeric;`,
      `SELECT (public.rb_buddy_earnings_summary('${bp}', 0.1) -> 'monthlyBreakdown' -> 0 ->> 'totalUsd')::numeric;`,
    ]);
    const [fee, net] = out.slice(-2).map(Number);
    assert.equal(fee, 0.03);
    assert.equal(net, 0.32);
  });
});
