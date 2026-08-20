/**
 * liveEnvelope — computes the parts of canonical_events' five-column
 * provenance envelope (source_count, freshness_seconds, confidence,
 * privacy_eligible, expires_at — see migration 2100) that are derivable from
 * what's built so far: the source registry (2101) and freshness policy (2102).
 *
 * WHAT THIS COMPUTES, AND WHY ONLY THIS MUCH
 * ============================================
 * sourceCount, freshnessSeconds and expiresAt are mechanical: how many of the
 * caller's claimed sources are actually known to the registry, how old the
 * observation is, and when its claim_type's TTL says it expires. None of that
 * requires a product decision.
 *
 * confidence and privacyEligible are NOT computed here. They are always null,
 * on purpose:
 *   - confidence needs the Claim/Observation/Verification/Contradiction
 *     machinery (roadmap item 5, migration 2106) — a scoring model over
 *     multiple independently-verified observations that doesn't exist yet.
 *     Deriving a number now (e.g. from source_count alone) would be exactly
 *     the kind of invented heuristic the roadmap says not to guess.
 *   - privacyEligible needs the sensitive-zone registry (roadmap item 6,
 *     migration 2104) and the consent ledger (roadmap item 7, migration 2103
 *     consent_grants) — neither exists yet, and "eligible" is a compliance
 *     claim, not a default a library should assert on their behalf.
 * A null on either column means "not yet computed" — distinct from an
 * eventual false. Callers must not treat null as true.
 *
 * Follows the featureFlags.ts conventions: the service client is injected as
 * the first argument (`sc: any`), and typing is intentionally loose at the
 * boundary.
 */
import { resolveSourceId } from "./sourceRegistry.js";
import { expiresAt as freshnessExpiresAt } from "./freshnessPolicy.js";

export interface LiveEnvelopeInput {
  claimType: string;
  observedAt: string | number | Date;
  /** Provider/source key strings backing this observation (sourceRegistry keys). */
  sourceKeys?: readonly (string | null | undefined)[];
  now?: string | number | Date;
}

export interface LiveEnvelope {
  sourceCount: number;
  freshnessSeconds: number;
  /** Always null today — see the module header. Never invent a value here. */
  confidence: null;
  /** Always null today — see the module header. Never invent a value here. */
  privacyEligible: null;
  expiresAt: string | null;
}

function toMs(t: string | number | Date): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  return new Date(t).getTime();
}

/**
 * Count the distinct, registry-known sources behind a claim. A key that does
 * not resolve to a real `sources` row (sourceRegistry's fail-closed
 * resolveSourceId) does not count — an unmapped string is not evidence of a
 * source, it's an unknown string.
 */
export async function computeSourceCount(
  sc: any,
  sourceKeys: readonly (string | null | undefined)[] | undefined,
): Promise<number> {
  if (!sourceKeys || sourceKeys.length === 0) return 0;
  const ids = await Promise.all(sourceKeys.map((key) => resolveSourceId(sc, key)));
  return new Set(ids.filter((id): id is string => id !== null)).size;
}

/**
 * Elapsed seconds between `observedAt` and `now` (default: current time).
 * Never negative — a clock-skewed future `observedAt` clamps to 0 rather than
 * reporting a claim as fresher than "just now".
 */
export function computeFreshnessSeconds(
  observedAt: string | number | Date,
  now: string | number | Date = Date.now(),
): number {
  const seconds = (toMs(now) - toMs(observedAt)) / 1000;
  return Math.max(0, Math.round(seconds));
}

/**
 * The three envelope fields computable today from 2101 (source registry) and
 * 2102 (freshness policy). confidence and privacyEligible are always null —
 * see the module header for why.
 */
export async function computeLiveEnvelope(sc: any, input: LiveEnvelopeInput): Promise<LiveEnvelope> {
  const [sourceCount, expires] = await Promise.all([
    computeSourceCount(sc, input.sourceKeys),
    freshnessExpiresAt(sc, input.claimType, input.observedAt),
  ]);
  return {
    sourceCount,
    freshnessSeconds: computeFreshnessSeconds(input.observedAt, input.now),
    confidence: null,
    privacyEligible: null,
    expiresAt: expires,
  };
}
