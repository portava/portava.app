/**
 * Live-output envelope — Phase 0 roadmap item 4.
 *
 * The five-column provenance/quality envelope that 2120_canonical_events
 * declares: source_count, freshness_seconds, confidence, privacy_eligible,
 * expires_at. This module COMPOSES the deterministic columns from the source
 * registry (2121) and the freshness policies (2122). It deliberately does NOT
 * compute the two columns that encode owner decisions:
 *
 *   - confidence       — how sources / verification combine into a 0..1 score is
 *                        a product decision (roadmap item 5: verification methods
 *                        + contradiction resolution). This module never invents a
 *                        formula; the caller passes a score or leaves it null.
 *   - privacy_eligible — whether an output may be shown is a privacy decision
 *                        (roadmap item 6 k-anonymity, item 7 consent ledger).
 *                        Fail-closed here: eligible only when the caller passes
 *                        exactly `true`; anything else is false.
 *
 * Deterministic columns:
 *   - source_count      — distinct count of the non-empty source keys supplied
 *                         (null when none are known).
 *   - freshness_seconds — age of the freshest contributing observation, in whole
 *                         seconds (now - observedAt), floored at 0.
 *   - expires_at        — from freshnessPolicy.expiresAt (2122), fail-closed to
 *                         null on an unknown claim_type.
 */
import { expiresAt as policyExpiresAt } from "./freshnessPolicy.js";

/** The five-column envelope, in the column names 2120 uses. */
export interface LiveEnvelope {
  source_count: number | null;
  freshness_seconds: number | null;
  confidence: number | null;
  privacy_eligible: boolean;
  expires_at: string | null;
}

export interface LiveEnvelopeInputs {
  /** The claim_type, keyed into freshness_policies (2122). */
  claimType: string;
  /** When the freshest contributing observation was made. */
  observedAt: string | number | Date;
  /** Source keys/ids that contributed; distinct non-empty entries are counted. */
  sourceKeys?: readonly (string | null | undefined)[];
  /**
   * OWNER-DECISION SEAM (item 5): a 0..1 score from a product-defined scorer.
   * Never invented here. Default null (no confidence asserted).
   */
  confidence?: number | null;
  /**
   * OWNER-DECISION SEAM (items 6/7): fail-closed. Eligible only when === true.
   */
  privacyEligible?: boolean | null;
  /** Defaults to the current time. */
  now?: string | number | Date;
}

function toMs(t: string | number | Date): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  return new Date(t).getTime();
}

/** Distinct count of non-empty source keys, or null when none are known. */
export function countSources(
  sourceKeys?: readonly (string | null | undefined)[],
): number | null {
  if (!sourceKeys) return null;
  const set = new Set<string>();
  for (const k of sourceKeys) {
    if (typeof k === "string" && k.trim() !== "") set.add(k);
  }
  return set.size === 0 ? null : set.size;
}

/** Age of an observation in whole seconds as of `now`, floored at 0. */
export function freshnessSeconds(
  observedAt: string | number | Date,
  now: string | number | Date = Date.now(),
): number | null {
  const o = toMs(observedAt);
  const n = toMs(now);
  if (!Number.isFinite(o) || !Number.isFinite(n)) return null;
  const secs = Math.floor((n - o) / 1000);
  return secs < 0 ? 0 : secs;
}

/**
 * Compose the live-output envelope. Deterministic columns are derived here;
 * confidence + privacy_eligible are the caller's (owner-decision) inputs.
 */
export async function computeLiveEnvelope(
  sc: any,
  inputs: LiveEnvelopeInputs,
): Promise<LiveEnvelope> {
  const expires_at = await policyExpiresAt(sc, inputs.claimType, inputs.observedAt);
  return {
    source_count: countSources(inputs.sourceKeys),
    freshness_seconds: freshnessSeconds(inputs.observedAt, inputs.now),
    confidence: inputs.confidence ?? null,
    privacy_eligible: inputs.privacyEligible === true, // fail-closed
    expires_at,
  };
}

/**
 * Is an output still live as of `now`? Live iff it carries an expiry in the
 * future. No expiry (unknown claim_type) => not live, fail-closed.
 */
export function isEnvelopeLive(
  envelope: Pick<LiveEnvelope, "expires_at">,
  now: string | number | Date = Date.now(),
): boolean {
  if (!envelope.expires_at) return false;
  return toMs(now) < toMs(envelope.expires_at);
}

/**
 * Map the envelope onto the camelCase fields CanonicalEventInput carries, so a
 * producer (roadmap item 10) can spread it onto an event it records.
 */
export function toCanonicalEnvelopeFields(envelope: LiveEnvelope): {
  sourceCount: number | null;
  freshnessSeconds: number | null;
  confidence: number | null;
  privacyEligible: boolean;
  expiresAt: string | null;
} {
  return {
    sourceCount: envelope.source_count,
    freshnessSeconds: envelope.freshness_seconds,
    confidence: envelope.confidence,
    privacyEligible: envelope.privacy_eligible,
    expiresAt: envelope.expires_at,
  };
}
