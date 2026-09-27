/**
 * creatorRuleEvaluation — turning a PUBLISHED rule version's parameters into
 * the figures an earning is booked with. PURE. Decides no percentage.
 *
 * census-discovery DV-58 (`07` §10 "rules are versioned"), DV-60 ("historical
 * recalculation is possible"), `07` §8 ("No payout formula hard-coding … Actual
 * percentages must remain configurable"), `09` §7 ("Payout policy should be
 * versioned and configurable").
 *
 * ── WHAT IS CONFIGURABLE, AND WHAT IS NOT DECIDED HERE ──────────────────────
 * A version's `params` (2920's `creator_rule_versions.params`) carry the
 * percentages, as integer PARTS PER MILLION of the gross:
 *
 *   { "creator_share_ppm": <0..1000000>, "platform_fee_ppm": <0..1000000> }
 *
 * and nothing else is read. 2920 seeds every lineage with `{}` — no
 * percentage has been decided — and this module REFUSES `{}`
 * (`rule_params_incomplete`) rather than defaulting. So on every database
 * this tree can reach, no earning can be computed from a rule until an owner
 * publishes a version carrying both numbers. The harness suites publish
 * TEST-ONLY versions in fixtures; no migration seeds one.
 *
 * Two things a rule needs that `07`/`09` leave to the owner are REFUSED rather
 * than chosen:
 *
 *   • MULTI-PARTY SPLITS. `07` §7: "record contributions before deciding payout
 *     weights." An attribution whose weight is not exactly 1 is one party of
 *     several, and how the gross divides among them is the undecided rule. A
 *     weight < 1 is refused (`multi_party_split_undecided`); nothing is
 *     prorated by a formula nobody wrote.
 *   • ROUNDING beyond "never distribute more than was produced". Both figures
 *     are FLOORED, so share + fee ≤ gross always, and the remainder stays
 *     undistributed rather than being handed to either party. A params object
 *     naming any other rounding is refused.
 */
import type { CreatorEarningInput, RevenueSource } from "./creatorLedgerEntries.js";

export const PPM = 1_000_000;

export interface CreatorRuleParams {
  creator_share_ppm: number;
  platform_fee_ppm: number;
  rounding?: "floor";
}

export type RuleEvaluationRefusal =
  | "rule_params_incomplete"
  | "rule_params_invalid"
  | "rule_distributes_more_than_gross"
  | "multi_party_split_undecided"
  | "negative_input";

export type RuleEvaluation =
  | { ok: true; value: CreatorEarningInput & { ruleParams: CreatorRuleParams } }
  | { ok: false; reason: RuleEvaluationRefusal; detail: string };

const refuse = (reason: RuleEvaluationRefusal, detail: string): RuleEvaluation => ({ ok: false, reason, detail });

const isPpm = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= PPM;

/** Read a version's params. Refuses anything that is not exactly the documented shape. */
export function readCreatorRuleParams(params: unknown): { ok: true; value: CreatorRuleParams } | { ok: false; reason: RuleEvaluationRefusal; detail: string } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, reason: "rule_params_incomplete", detail: "params is not an object" };
  }
  const p = params as Record<string, unknown>;
  if (!("creator_share_ppm" in p) || !("platform_fee_ppm" in p)) {
    return {
      ok: false,
      reason: "rule_params_incomplete",
      detail: "no percentage has been published for this version (07 §8: they must be configured, never defaulted)",
    };
  }
  if (!isPpm(p["creator_share_ppm"]) || !isPpm(p["platform_fee_ppm"])) {
    return { ok: false, reason: "rule_params_invalid", detail: "creator_share_ppm and platform_fee_ppm must be integers in 0..1000000" };
  }
  if (p["rounding"] !== undefined && p["rounding"] !== "floor") {
    return { ok: false, reason: "rule_params_invalid", detail: `rounding ${JSON.stringify(p["rounding"])} is not supported; only floor never over-distributes` };
  }
  const share = p["creator_share_ppm"] as number;
  const fee = p["platform_fee_ppm"] as number;
  if (share + fee > PPM) {
    return { ok: false, reason: "rule_params_invalid", detail: `creator_share_ppm + platform_fee_ppm = ${share + fee} > ${PPM}` };
  }
  return { ok: true, value: { creator_share_ppm: share, platform_fee_ppm: fee, rounding: "floor" } };
}

/**
 * The figures one attribution's earning is booked with, under one published
 * version. Integer arithmetic throughout (`09` §8 minor units), BigInt for the
 * product so a large gross cannot lose precision.
 */
export function evaluateCreatorRule(
  params: unknown,
  input: { grossRevenueMinor: number; weight: number; revenueSource?: RevenueSource | null; currency?: string },
): RuleEvaluation {
  const read = readCreatorRuleParams(params);
  if (!read.ok) return read;
  const gross = input.grossRevenueMinor;
  if (!Number.isInteger(gross) || gross < 0) return refuse("negative_input", `grossRevenueMinor=${gross}`);
  if (input.weight !== 1) {
    return refuse(
      "multi_party_split_undecided",
      `weight=${input.weight}: this attribution is one party of several, and how a conversion divides among its parties is the rule 07 §7 leaves undecided`,
    );
  }
  const g = BigInt(gross);
  const creatorShareMinor = Number((g * BigInt(read.value.creator_share_ppm)) / BigInt(PPM));
  const platformFeeMinor = Number((g * BigInt(read.value.platform_fee_ppm)) / BigInt(PPM));
  if (creatorShareMinor + platformFeeMinor > gross) {
    // Unreachable with floor and share+fee ≤ 1e6; asserted rather than assumed.
    return refuse("rule_distributes_more_than_gross", `${creatorShareMinor} + ${platformFeeMinor} > ${gross}`);
  }
  return {
    ok: true,
    value: {
      grossRevenueMinor: gross,
      creatorShareMinor,
      platformFeeMinor,
      revenueSource: input.revenueSource ?? null,
      currency: input.currency,
      ruleParams: read.value,
    },
  };
}
