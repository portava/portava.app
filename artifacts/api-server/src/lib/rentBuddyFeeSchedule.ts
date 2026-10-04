/**
 * rent_buddy_fee_rules — the ONE place the platform take rate is resolved.
 *
 * ── WHY THIS MODULE EXISTS (defect M1 / M10) ────────────────────────────────
 * The same commission was expressed as three disagreeing constants:
 *
 *   per-level 25/22/15/12/12   rent_buddy_fee_rules            (the schedule)
 *   22 %                       DEFAULT_PLATFORM_FEE_PERCENT    (ledger literal)
 *   22 %                       defaultFeePercent               (dashboard literal)
 *   15 %                       platformFeePct = 0.15           (earnings summary,
 *                                                               level-blind)
 *
 * So a `new` buddy was quoted 15 %, ledgered at 25 % and dashboarded at 22 %.
 * `08_Portava_Revenue_Model.md` §2.3 states the resolution direction and it is
 * not a judgement call: **`rent_buddy_fee_rules` is the schedule of record
 * because it is the only one an operator can change without a deploy.** The
 * literals are drift. This module is the single reader; the literals are gone.
 *
 * ── THE RATE IS BASIS POINTS, AND THAT IS NOT COSMETIC (3520) ───────────────
 * Owner decision, 2026-10-04:
 *
 *   "Set the Rent-a-Buddy commission to a flat 10% across Buddy levels. Store
 *    it in basis points (1000); allow market overrides only when separately
 *    approved."
 *
 * The storage column was `integer` PERCENT, which cannot express 10.5 % at all
 * — so the override half of that decision was unrepresentable in the column it
 * would have to live in. `3520_rent_buddy_commission_basis_points.sql` adds
 * `platform_fee_basis_points` (10 % == 1000) and converts existing rows
 * faithfully (25 % -> 2500). This module reads ONLY that column.
 * `platform_fee_percent` survives as a rounded legacy mirror because it is NOT
 * NULL and cannot be dropped additively; computing money from it would
 * reintroduce the defect, so nothing here reads it and a test asserts that.
 *
 * ── THE MECHANISM STAYS; ONLY THE DATA IS UNIFORM ───────────────────────────
 * The decision allows market overrides *when separately approved*, so the
 * resolver is NOT replaced by a constant. What makes "no override is approved
 * today" structural rather than aspirational is a pair of refusals:
 *
 *   • the database CHECK `rbfr_flat_rate_unless_approved` — a row may hold a
 *     rate other than 1000 only if it also holds a non-empty
 *     `commission_override_approval`, and no route can write that column; and
 *   • `resolveFeeSchedule` below, which refuses a row presenting an unapproved
 *     off-flat rate even on a database that has not run 3520.
 *
 * Two layers, because the constraint protects the table and the resolver
 * protects the price.
 *
 * ── WHY IT DOES NOT FALL BACK TO A NUMBER ───────────────────────────────────
 * The deleted literals were not defaults, they were guesses wearing a default's
 * clothes. `22` made three different failures indistinguishable from a
 * deliberate operator decision:
 *
 *   • the fee table is unreadable (outage, permissions, renamed column)
 *   • the buddy's level has no row  — `'standard'` is settable by the admin
 *     route and has never had a fee row (`08` §2.5)
 *   • an operator genuinely set 22 %
 *
 * That is `.agents/memory/unseeded-feature-flag-gates.md` applied to pricing:
 * *the absence of a row is indistinguishable from a deliberate value.* A
 * booking priced on a guess is a wrong number written into a money record and
 * shown to a buddy, with nothing anywhere reporting it.
 *
 * So the resolver returns a THREE-STATE result — `resolved` / `no_such_level` /
 * `read_failed` — and every caller must decide what to do with the two failure
 * states. There is no arm that yields a percentage nobody configured. 3520
 * extends that to the storage change itself: against a database where 3520 has
 * not run, the explicit select of `platform_fee_basis_points` fails and this
 * returns `read_failed`. A missing column reads as "I do not know the rate",
 * never as "the rate is zero".
 *
 * ── THIS MODULE MOVES NO MONEY ──────────────────────────────────────────────
 * It reads a schedule. `pay-deposit` / `pay-full` still return 503, the ledger
 * row is still an estimate, and no payout exists. See `09_Payment_Architecture.md`
 * §1.3.
 */
import { isFlagEnabled } from "./featureFlags.js";

/** The schedule of record. One row per `buddy_level`. */
export const FEE_SCHEDULE_TABLE = "rent_buddy_fee_rules";

/**
 * The flat commission, in basis points. 1000 == 10 %.
 *
 * Owner decision 2026-10-04. This is not a fallback and is never substituted
 * for a rate that could not be read — it is the value the schedule is asserted
 * to hold, and the value an off-flat row is measured against when deciding
 * whether it carries the approval the decision requires.
 */
export const FLAT_COMMISSION_BASIS_POINTS = 1000;

/** Basis points are hundredths of a percent, so a whole rate is 10 000 of them. */
export const BASIS_POINTS_PER_UNIT = 10000;

/** A fee-schedule row, normalised and range-checked. */
export interface FeeScheduleRule {
  buddyLevel: string;
  /** Portava's commission, in basis points of the booking total. 0–10000. */
  platformFeeBasisPoints: number;
  /** Flat traveller-side service fee in USD. 0 on every production row today. */
  travelerServiceFeeUsd: number;
  /** Traveller-side service fee as a percentage of the booking total. 0–100. */
  travelerServiceFeePct: number;
  /**
   * The separate approval that lets this row depart from
   * `FLAT_COMMISSION_BASIS_POINTS`. `null` on every row today, which is what
   * "no market override is approved" looks like in data.
   */
  commissionOverrideApproval: string | null;
}

/**
 * Three states, deliberately not two.
 *
 *  `resolved`      — a row exists and yields a usable rate.
 *  `no_such_level` — the table was read successfully and holds no row for this
 *                    level. The buddy's level is not in the schedule; that is a
 *                    configuration hole (`08` §2.5), not a 22 % default.
 *  `read_failed`   — the schedule could not be established at all: the query
 *                    errored (including "this database has not run 3520, so
 *                    there is no basis-point column"), or a row came back that
 *                    cannot be read as a rate — null, non-integer, out of
 *                    range, or an off-flat rate with no recorded approval.
 *                    "We do not know" is a distinct answer from "there is
 *                    nothing there".
 */
export type FeeScheduleResolution =
  | { status: "resolved"; buddyLevel: string; rule: FeeScheduleRule }
  | { status: "no_such_level"; buddyLevel: string }
  | { status: "read_failed"; buddyLevel: string; message: string };

/** The level a profile with no `buddy_level` set is treated as. Matches the column default. */
export const DEFAULT_BUDDY_LEVEL = "new";

// ── The rounding rule, in one place ─────────────────────────────────────────

/**
 * THE ROUNDING RULE. Stated once, implemented once, used by every site in this
 * tree that turns a rate into money.
 *
 *   fee_cents = floor((total_cents × basis_points + 5000) / 10000)
 *
 * i.e. **half-up on the cent, computed entirely in integer cents.** No
 * floating-point multiplication of a dollar amount by a rate happens anywhere.
 *
 * WHY INTEGERS AND NOT `total * bps / 10000`. The obvious spelling is wrong at
 * the boundary, and silently. $0.35 at 1000 basis points is $0.035, which must
 * round to $0.04; `0.35 * 0.1` is 0.034999999999999996 in IEEE 754, so
 * `Math.round(0.35 * 0.1 * 100) / 100` yields **$0.03**. One cent, on the half,
 * against the buddy, on an unbounded number of bookings — and it recurs: $1.45,
 * $10.35, $21.15, $21.95 and 2 500 more amounts under $2 000 land the same way.
 * The integer form gives 0.04 because `35 × 1000 + 5000 = 40000` and
 * `40000 / 10000 = 4` exactly.
 * `src/test/rentBuddyCommissionBasisPoints.test.ts` pins the case AND the
 * control, so the claim that the old spelling was wrong is itself tested.
 *
 * WHY HALF-UP AND NOT BANKER'S ROUNDING. The SQL aggregation path
 * (`rb_buddy_earnings_summary`, migration 2330) computes the same fee as
 * `ROUND(total_usd::numeric * rate, 2)`, and PostgreSQL's `ROUND` on `numeric`
 * rounds halves AWAY FROM ZERO. Every amount here is non-negative (booking
 * totals and tips; `buildBookingEntries` refuses a negative input), so away
 * from zero and up are the same rule, and the two paths agree cent for cent.
 * Choosing anything else would make the SQL summary and the per-booking ledger
 * disagree by a cent on exactly the amounts a user is most likely to notice.
 *
 * MAGNITUDE. `total_usd` is `numeric(10,2)`, so `total_cents` ≤ 1e10 and
 * `total_cents × 10000` ≤ 1e14 — well inside `Number.MAX_SAFE_INTEGER` (≈9e15),
 * so the integer arithmetic is exact.
 *
 * @returns the amount in USD, or `null` when the inputs cannot be priced.
 *          `null` is NOT zero: see below.
 */
export function applyBasisPoints(amountUsd: number, basisPoints: number): number | null {
  // A fee computed from an unreadable amount is money invented from a failed
  // read. This used to `return 0`, which is the same defect the deleted 22 %
  // literal was: a figure that looks like a deliberate zero. Callers must
  // refuse on null; they must not substitute a number.
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > BASIS_POINTS_PER_UNIT) {
    return null;
  }

  const amountMinor = Math.round(amount * 100);
  if (!Number.isSafeInteger(amountMinor)) return null;

  const scaled = amountMinor * basisPoints;
  if (!Number.isSafeInteger(scaled)) return null;

  const feeMinor = Math.floor((scaled + BASIS_POINTS_PER_UNIT / 2) / BASIS_POINTS_PER_UNIT);
  return feeMinor / 100;
}

/** Round a USD amount to the cent under the same half-up rule. */
export function roundUsd(amountUsd: number): number | null {
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount)) return null;
  return Math.sign(amount) * Math.floor(Math.abs(amount) * 100 + 0.5) / 100;
}

/**
 * A rate as a decimal fraction, for the one consumer that cannot take basis
 * points: `rb_buddy_earnings_summary(uuid, numeric)` (migration 2330), whose
 * signature is already applied and takes the rate as a fraction.
 *
 * `bps / 10000` for an integer `bps` ≤ 10000 has at most four decimal places,
 * and the shortest round-trip JSON form of the nearest double to such a value
 * IS that decimal — so PostgreSQL parses an exact `numeric`, not an
 * approximation. The rounding then happens in SQL under the same half-away rule
 * documented on `applyBasisPoints`.
 */
export function basisPointsAsRateFraction(basisPoints: number): number {
  return basisPoints / BASIS_POINTS_PER_UNIT;
}

/**
 * The rate as a percentage, for DISPLAY and for the legacy mirror column only.
 * May be fractional (1050 -> 10.5). Never use it to compute money: that is what
 * `applyBasisPoints` is for, and routing a fee through a percentage is how the
 * integer-percent column became unable to express the decision in the first
 * place.
 */
export function basisPointsToPercent(basisPoints: number): number {
  return basisPoints / 100;
}

/** A percentage back to basis points, for the admin editor's input only. */
export function percentToBasisPoints(percent: number): number | null {
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  // A percentage with more than two decimal places is finer than a basis point
  // and is REFUSED rather than rounded: rounding it would store a rate the
  // operator did not type. The tolerance absorbs IEEE 754 noise only — 10.5
  // scales to 1050.0000000000002 and must be accepted, while 10.005 scales to
  // 1000.5 and must not.
  const scaled = n * 100;
  const bps = Math.round(scaled);
  return Math.abs(scaled - bps) < 1e-6 ? bps : null;
}

// ── Row normalisation ───────────────────────────────────────────────────────

/** A rate is usable only if it is a whole number of basis points within 0–10000. */
function asBasisPoints(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  // Integer, not merely finite: a fractional basis point is a tenth of a cent
  // on a $1 booking and cannot have been written deliberately. Treating it as
  // usable would quietly round a rate nobody chose.
  if (!Number.isInteger(n) || n < 0 || n > BASIS_POINTS_PER_UNIT) return null;
  return n;
}

/** A percentage is usable only if it is a finite number within 0–100. */
function asPercent(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/** A money amount is usable only if it is a finite, non-negative number. */
function asUsd(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** An approval is a non-empty string or it is absent. Whitespace is absent. */
function asApproval(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/** The columns the schedule of record is read through. */
export const FEE_SCHEDULE_COLUMNS =
  "buddy_level, platform_fee_basis_points, commission_override_approval, " +
  "traveler_service_fee_usd, traveler_service_fee_pct";

/**
 * Resolve the fee schedule for one buddy level.
 *
 * @param svc        a service-role Supabase client (or a test fake)
 * @param buddyLevel `rent_buddy_profiles.buddy_level`; null/empty is treated as
 *                   the column default `'new'`, which HAS a row in the schedule.
 */
export async function resolveFeeSchedule(
  svc: any,
  buddyLevel: string | null | undefined,
): Promise<FeeScheduleResolution> {
  const level = (buddyLevel ?? "").trim() || DEFAULT_BUDDY_LEVEL;

  if (!svc) {
    return { status: "read_failed", buddyLevel: level, message: "no database client available" };
  }

  let data: any;
  let error: any;
  try {
    // supabase-js RESOLVES on a DB error rather than throwing; the try/catch is
    // for a fake/partial client that throws on a missing builder method, not
    // for the DB error itself, which is read off `error` below.
    ({ data, error } = await svc
      .from(FEE_SCHEDULE_TABLE)
      .select(FEE_SCHEDULE_COLUMNS)
      .eq("buddy_level", level)
      .maybeSingle());
  } catch (err: any) {
    return {
      status: "read_failed",
      buddyLevel: level,
      message: `${FEE_SCHEDULE_TABLE} read threw: ${err?.message ?? String(err)}`,
    };
  }

  if (error) {
    return {
      status: "read_failed",
      buddyLevel: level,
      // A database that has not run 3520 lands here (42703: column
      // platform_fee_basis_points does not exist). That is the intended
      // outcome — see the module header's deploy-ordering note.
      message: `${FEE_SCHEDULE_TABLE} read failed: ${error.message ?? String(error)}`,
    };
  }

  if (!data) return { status: "no_such_level", buddyLevel: level };

  const platformFeeBasisPoints = asBasisPoints(data.platform_fee_basis_points);
  if (platformFeeBasisPoints === null) {
    // The row is there but it does not carry a take rate. That is NOT
    // "no such level" — the level exists and the schedule is broken. Treating
    // it as absent would let a malformed row read as a deliberate omission.
    return {
      status: "read_failed",
      buddyLevel: level,
      message:
        `${FEE_SCHEDULE_TABLE} row for '${level}' has an unusable ` +
        `platform_fee_basis_points (${JSON.stringify(data.platform_fee_basis_points)}); ` +
        `expected a whole number of basis points in 0–${BASIS_POINTS_PER_UNIT}`,
    };
  }

  const commissionOverrideApproval = asApproval(data.commission_override_approval);

  // The second half of "market overrides only when separately approved". The
  // database CHECK (3520) makes such a row unwritable; this makes it unusable
  // even where the CHECK is absent — an un-migrated database, a restored dump,
  // a hand-edited row. An off-flat rate with nothing recording who approved it
  // is a price no decision stands behind, so it is not a price.
  if (
    platformFeeBasisPoints !== FLAT_COMMISSION_BASIS_POINTS &&
    commissionOverrideApproval === null
  ) {
    return {
      status: "read_failed",
      buddyLevel: level,
      message:
        `${FEE_SCHEDULE_TABLE} row for '${level}' carries ` +
        `${platformFeeBasisPoints} basis points, which is not the approved flat ` +
        `rate of ${FLAT_COMMISSION_BASIS_POINTS}, and records no ` +
        "commission_override_approval — a market override is permitted only " +
        "when separately approved (owner decision 2026-10-04)",
    };
  }

  const travelerServiceFeeUsd = asUsd(data.traveler_service_fee_usd);
  const travelerServiceFeePct = asPercent(data.traveler_service_fee_pct) ?? 0;
  if (travelerServiceFeeUsd === null) {
    return {
      status: "read_failed",
      buddyLevel: level,
      message:
        `${FEE_SCHEDULE_TABLE} row for '${level}' has an unusable ` +
        `traveler_service_fee_usd (${JSON.stringify(data.traveler_service_fee_usd)})`,
    };
  }

  return {
    status: "resolved",
    buddyLevel: level,
    rule: {
      buddyLevel: level,
      platformFeeBasisPoints,
      travelerServiceFeeUsd,
      travelerServiceFeePct,
      commissionOverrideApproval,
    },
  };
}

/**
 * Portava's commission on a booking total, rounded to the cent by the single
 * rule on `applyBasisPoints`.
 *
 * `null` means the amount could not be priced — an unreadable total, not a
 * zero fee. Callers refuse; they do not substitute 0. `09` §1.3.
 *
 * NOTE WHAT THE BASE IS: the booking total, never total + tip. "No commission
 * on tips" is structural and lives in `buildBookingEntries`, whose `tip`
 * transaction has exactly two legs — traveller receivable and buddy payable —
 * and no platform leg at all. This function is the other half of that
 * confirmation: it is never handed a tip.
 */
export function platformFeeUsdFor(totalUsd: number, rule: FeeScheduleRule): number | null {
  return applyBasisPoints(totalUsd, rule.platformFeeBasisPoints);
}

/**
 * The traveller-side service fee the schedule specifies for a booking — the
 * MISMATCH half of defect M4.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * The ledger read `traveler_service_fee_usd` and nothing anywhere read
 * `traveler_service_fee_pct`. Every production row carries `_usd = 0.00` and
 * `_pct = 5.00`, so the ledger's traveller fee was structurally 0 on every row
 * that has ever existed, and the 5 % an admin can set through
 * `PATCH /rent-a-buddy/admin/fee-rules` was a number nothing could act on
 * (`08` §2.4). An admin-set value that the ledger cannot see is not a setting;
 * it is a decoy.
 *
 * ── THE FIX, AND ITS LIMIT ──────────────────────────────────────────────────
 * Both columns are now read, and both are additive: the flat USD amount plus
 * the percentage of the booking total. That is what the admin screen already
 * presents them as (two independent fields, either settable), so this is the
 * only reading under which an admin-set value is the value the ledger reads.
 *
 * This function computes the SCHEDULE amount. It does not decide whether the
 * traveller is charged: see `travelerServiceFeeIsChargeable`. Whether the
 * traveller-side fee exists as a revenue line at all is ruling **R1**, unmade
 * (`08` §2.4, §7; `12` §4 Stage 2), and charging is Stage 4.
 *
 * `traveler_service_fee_pct` is `numeric(5,2)`, which CAN express a fractional
 * rate, so it is not part of the basis-point conversion. It is still routed
 * through the one rounding rule, via its basis-point equivalent, so the
 * traveller fee and the commission cannot round differently.
 */
export function travelerServiceFeeUsdFor(totalUsd: number, rule: FeeScheduleRule): number | null {
  const flat = roundUsd(rule.travelerServiceFeeUsd);
  if (flat === null) return null;

  const pctBasisPoints = percentToBasisPoints(rule.travelerServiceFeePct);
  if (pctBasisPoints === null) return null;

  const variable = applyBasisPoints(totalUsd, pctBasisPoints);
  if (variable === null) return null;

  return roundUsd(flat + variable);
}

/**
 * Whether a traveller service fee may be recorded against a booking at all.
 *
 * Today this is the Rent-a-Buddy master switch, which is seeded FALSE and is
 * FALSE in production — so the recorded amount is 0 on every row, exactly as it
 * is today, and this change starts charging nobody. What changes is that the
 * amount is now DERIVED rather than structurally unreachable: an operator who
 * sets `_pct` or `_usd` gets that value once the lane is live, instead of
 * silently getting 0 forever.
 *
 * ⚠ STAGE 4 / R1: this gate is the marketplace switch, not a revenue-line
 * decision. Before `rent_buddy_enabled` is ever flipped on, R1 must be ruled
 * and this predicate must be replaced by the gate that ruling names. Flipping
 * the master switch with this as written would begin recording a traveller
 * service fee on ledger rows without that ruling having been made.
 */
export async function travelerServiceFeeIsChargeable(svc: any): Promise<boolean> {
  return await isFlagEnabled(svc, "rent_buddy_enabled");
}

/**
 * A one-line, log-safe description of a non-resolved outcome. Kept here so the
 * ledger writer and the dashboard describe the same failure the same way.
 */
export function describeFeeScheduleFailure(
  res: Exclude<FeeScheduleResolution, { status: "resolved" }>,
): string {
  return res.status === "no_such_level"
    ? `no ${FEE_SCHEDULE_TABLE} row for buddy_level '${res.buddyLevel}' — the take rate is not configured for this level`
    : res.message;
}
