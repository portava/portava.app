/**
 * Intelligence Gathering — Qualified Impact Unit, shadow calculation (IG-10,
 * spec §23 Monetization coupling).
 *
 *   qiu = base_outcome · evidence · freshness · scoped_trust · originality
 *         · scarcity · outcome · integrity
 *   if integrity == 0 OR the claim expired before the action:  qiu = 0
 *
 * SHADOW ONLY. This computes a contributor's qualified impact for internal
 * accounting and evaluation. It NEVER moves money: "no view-only cash guarantee,
 * no fixed rate per post and no future liability for shadow-mode QIU" (spec §23).
 * Any cash payout is a separate switch (intel_qiu_cash_pool) behind an explicit
 * funding source, ledger version and commercial-use permission — none of which
 * exist here. Pure; fail-closed to 0 on any non-finite input.
 */

export interface QiuInputs {
  baseOutcome: number;
  evidence: number;
  freshness: number;
  scopedTrust: number;
  originality: number;
  scarcity: number;
  outcome: number;
  integrity: number;             // 0 ⇒ qiu is 0 (integrity gate)
  claimExpiredBeforeAction: boolean; // true ⇒ qiu is 0 (a claim that lapsed cannot earn)
}

const FACTORS: (keyof QiuInputs)[] = [
  "baseOutcome", "evidence", "freshness", "scopedTrust",
  "originality", "scarcity", "outcome", "integrity",
];

/**
 * The shadow QIU. Returns 0 when integrity is 0, when the claim expired before
 * the action, or when any factor is non-finite/negative (fail-closed — a QIU
 * that cannot be trusted is 0, never a guess).
 */
export function computeQiu(i: QiuInputs): number {
  if (i.claimExpiredBeforeAction) return 0;
  if (!(i.integrity > 0)) return 0; // covers integrity == 0 and any invalid integrity
  let product = 1;
  for (const k of FACTORS) {
    const v = i[k] as number;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
    product *= v;
  }
  return product;
}
