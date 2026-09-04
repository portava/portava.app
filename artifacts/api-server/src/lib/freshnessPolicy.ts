/**
 * freshnessPolicy — how long a claim of a given kind may be treated as "live".
 *
 * Reads public.freshness_policies (migration 2102) through a 30s in-memory
 * cache and answers three questions: getPolicy (the raw TTL), isStale (has a
 * claim aged past its TTL) and expiresAt (when it will).
 *
 * FAIL-CLOSED
 * ===========
 * An UNKNOWN claim_type — no policy row, or the table unreadable — is treated
 * as STALE, and expiresAt returns null (no live label). A claim we have no
 * policy for is never presented as live.
 *
 * Follows the featureFlags.ts conventions: the service client is injected as
 * the first argument (`sc: any`), and typing is intentionally loose at the
 * boundary.
 */
import { logger } from "./logger.js";

/**
 * Version tag of the freshness curve the projection applies to (age, ttl).
 * Stamped into every persisted snapshot version through
 * lib/intelProjection.PROJECTION_ALGORITHM_VERSION so a replay can tell a
 * curve change from an input change. "linear" is the pre-I1 `1 - age/ttl`.
 */
export const FRESHNESS_CURVE_VERSION = "linear";

/**
 * The freshness component of the confidence score for a claim `ageSeconds`
 * old under a `ttlSeconds` policy. Pure. Fail-closed: a non-finite or
 * non-positive TTL, or a non-finite age, scores 0 (never fresh); a negative
 * age (clock skew already clamped upstream) is treated as 0.
 */
export function freshnessScore(ageSeconds: number, ttlSeconds: number): number {
  if (!Number.isFinite(ageSeconds) || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return 0;
  const age = ageSeconds < 0 ? 0 : ageSeconds;
  return freshnessFromRatio(age / ttlSeconds);
}

/** The same curve over an already-computed age/ttl ratio. */
export function freshnessFromRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  const r = ratio < 0 ? 0 : ratio;
  const v = 1 - r;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface FreshnessPolicy {
  claimType: string;
  ttlSeconds: number;
  note: string | null;
}

export interface SeedFreshnessPolicy {
  claim_type: string;
  ttl_seconds: number;
  note: string;
}

/**
 * The single source of truth for the seed. Migration 2102's INSERT mirrors this
 * list exactly. Owner-tunable defaults from the blueprint.
 */
export const SEED_FRESHNESS_POLICIES: readonly SeedFreshnessPolicy[] = [
  { claim_type: "crowd",      ttl_seconds: 900,      note: "How busy a place is — 15 minutes." },
  { claim_type: "vibe",       ttl_seconds: 1800,     note: "Atmosphere / feel — 30 minutes." },
  { claim_type: "price",      ttl_seconds: 172800,   note: "Pricing — 48 hours." },
  { claim_type: "structural", ttl_seconds: 15552000, note: "Hours / existence — 180 days, effectively static." },
];

// ── claim_type -> policy, with a short TTL cache ──────────────────────────────
// The table is tiny and effectively static; a full-table load cached for 30s
// keeps this to at most two reads a minute. 30s mirrors the flag-cache window
// in lib/discoveryServeLog.ts.
const CACHE_TTL_MS = 30_000;
let _cache: { map: Map<string, FreshnessPolicy>; at: number } | null = null;

/** Invalidate the policy cache. Exported for tests. */
export function invalidateFreshnessPolicyCache(): void {
  _cache = null;
}

async function loadPolicies(sc: any): Promise<Map<string, FreshnessPolicy>> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.map;
  try {
    const { data, error } = await sc.from("freshness_policies").select("claim_type, ttl_seconds, note");
    if (error || !data) {
      // Fail-closed: do not cache a failure. Every lookup returns null (=> stale)
      // until the next successful load.
      logger.warn({ err: error }, "freshnessPolicy: freshness_policies load failed");
      return new Map();
    }
    const map = new Map<string, FreshnessPolicy>();
    for (const row of data as Array<{ claim_type: string; ttl_seconds: number; note: string | null }>) {
      map.set(row.claim_type, {
        claimType: row.claim_type,
        ttlSeconds: Number(row.ttl_seconds),
        note: row.note ?? null,
      });
    }
    _cache = { map, at: Date.now() };
    return map;
  } catch (err) {
    logger.warn({ err }, "freshnessPolicy: freshness_policies load threw");
    return new Map();
  }
}

/** Coerce a timestamp-ish value to epoch milliseconds. */
function toMs(t: string | number | Date): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  return new Date(t).getTime();
}

/**
 * The freshness policy for a claim_type, or null if none is configured (or the
 * table is unreadable).
 */
export async function getPolicy(sc: any, claimType: string): Promise<FreshnessPolicy | null> {
  if (!claimType) return null;
  const map = await loadPolicies(sc);
  return map.get(claimType) ?? null;
}

/**
 * Has a claim of this kind, observed at `observedAt`, aged past its TTL as of
 * `now` (default: current time)?
 *
 * Unknown claim_type => STALE (true), fail-closed. The boundary is inclusive:
 * at exactly ttl_seconds elapsed the claim is stale.
 */
export async function isStale(
  sc: any,
  claimType: string,
  observedAt: string | number | Date,
  now: string | number | Date = Date.now(),
): Promise<boolean> {
  const policy = await getPolicy(sc, claimType);
  if (!policy) return true; // no policy => never live
  const ageSeconds = (toMs(now) - toMs(observedAt)) / 1000;
  return ageSeconds >= policy.ttlSeconds;
}

/**
 * When a claim of this kind, observed at `observedAt`, expires — as an ISO
 * string. Returns null for an unknown claim_type (no live label), fail-closed.
 */
export async function expiresAt(
  sc: any,
  claimType: string,
  observedAt: string | number | Date,
): Promise<string | null> {
  const policy = await getPolicy(sc, claimType);
  if (!policy) return null;
  return new Date(toMs(observedAt) + policy.ttlSeconds * 1000).toISOString();
}
