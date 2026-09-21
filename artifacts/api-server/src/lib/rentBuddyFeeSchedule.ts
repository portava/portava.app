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
 * states. There is no arm that yields a percentage nobody configured.
 *
 * ── THIS MODULE MOVES NO MONEY ──────────────────────────────────────────────
 * It reads a schedule. `pay-deposit` / `pay-full` still return 503, the ledger
 * row is still an estimate, and no payout exists. See `09_Payment_Architecture.md`
 * §1.3.
 */
import { isFlagEnabled } from "./featureFlags.js";

/** The schedule of record. One row per `buddy_level`. */
export const FEE_SCHEDULE_TABLE = "rent_buddy_fee_rules";

/** A fee-schedule row, normalised and range-checked. */
export interface FeeScheduleRule {
  buddyLevel: string;
  /** Portava's commission, as a percentage of the booking total. 0–100. */
  platformFeePercent: number;
  /** Flat traveller-side service fee in USD. 0 on every production row today. */
  travelerServiceFeeUsd: number;
  /** Traveller-side service fee as a percentage of the booking total. 0–100. */
  travelerServiceFeePct: number;
}

/**
 * Three states, deliberately not two.
 *
 *  `resolved`      — a row exists and yields a usable percentage.
 *  `no_such_level` — the table was read successfully and holds no row for this
 *                    level. The buddy's level is not in the schedule; that is a
 *                    configuration hole (`08` §2.5), not a 22 % default.
 *  `read_failed`   — the schedule could not be established at all: the query
 *                    errored, or a row came back that cannot be read as a fee
 *                    (null / NaN / out of range). "We do not know" is a
 *                    distinct answer from "there is nothing there".
 */
export type FeeScheduleResolution =
  | { status: "resolved"; buddyLevel: string; rule: FeeScheduleRule }
  | { status: "no_such_level"; buddyLevel: string }
  | { status: "read_failed"; buddyLevel: string; message: string };

/** The level a profile with no `buddy_level` set is treated as. Matches the column default. */
export const DEFAULT_BUDDY_LEVEL = "new";

const round2 = (n: number) => Math.round(n * 100) / 100;

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
      .select("buddy_level, platform_fee_percent, traveler_service_fee_usd, traveler_service_fee_pct")
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
      message: `${FEE_SCHEDULE_TABLE} read failed: ${error.message ?? String(error)}`,
    };
  }

  if (!data) return { status: "no_such_level", buddyLevel: level };

  const platformFeePercent = asPercent(data.platform_fee_percent);
  if (platformFeePercent === null) {
    // The row is there but it does not carry a take rate. That is NOT
    // "no such level" — the level exists and the schedule is broken. Treating
    // it as absent would let a malformed row read as a deliberate omission.
    return {
      status: "read_failed",
      buddyLevel: level,
      message:
        `${FEE_SCHEDULE_TABLE} row for '${level}' has an unusable ` +
        `platform_fee_percent (${JSON.stringify(data.platform_fee_percent)}); ` +
        "expected a number in 0–100",
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
    rule: { buddyLevel: level, platformFeePercent, travelerServiceFeeUsd, travelerServiceFeePct },
  };
}

/** Portava's commission on a booking total, rounded to cents. */
export function platformFeeUsdFor(totalUsd: number, rule: FeeScheduleRule): number {
  const total = Number(totalUsd);
  if (!Number.isFinite(total)) return 0;
  return round2(total * rule.platformFeePercent / 100);
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
 */
export function travelerServiceFeeUsdFor(totalUsd: number, rule: FeeScheduleRule): number {
  const total = Number(totalUsd);
  const base = Number.isFinite(total) ? total : 0;
  return round2(rule.travelerServiceFeeUsd + base * rule.travelerServiceFeePct / 100);
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
