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

// ── The freshness curve (spec §9) ────────────────────────────────────────────
/**
 *   freshness(age, ttl) = max(0, 1 - (age / ttl)^1.5)
 *
 * Not linear, on purpose: the 1.5 exponent keeps a claim near full weight for
 * the first part of its life (a 15-minute-old crowd report is nearly as good as
 * a fresh one) and then lets it fall away faster as it approaches the TTL. The
 * pre-I1 aggregator used `1 - age/ttl`, which halves the weight of a claim at
 * half its TTL; the spec's curve leaves it at ~0.65 there and reaches zero at
 * exactly the TTL, where isStale() also flips.
 */
export const FRESHNESS_CURVE_EXPONENT = 1.5;

/**
 * Version tag of the curve above. Stamped into every persisted snapshot version
 * through lib/intelProjection.PROJECTION_ALGORITHM_VERSION so a replay can
 * tell a curve change from an input change ("linear" was the pre-I1 curve).
 */
export const FRESHNESS_CURVE_VERSION = "pow1.5";

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

/** The same curve over an already-computed age/ttl ratio (>= 1 means expired). */
export function freshnessFromRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  const r = ratio < 0 ? 0 : ratio;
  const v = 1 - Math.pow(r, FRESHNESS_CURVE_EXPONENT);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ── Table 16: which observations may EXTEND a family's freshness ─────────────
/**
 * Before I1 the aggregator moved a claim's freshness clock to its NEWEST fresh
 * observation, whatever that observation was — so a hearsay tip, a sponsored
 * post, or the same person tapping again kept any claim family alive. Table 16
 * column 3 says otherwise, per family:
 *
 *   Queue                 New qualified observation only
 *   Crowd level           Independent reconfirmation
 *   Trajectory            New time-separated observation
 *   Crowd mix / music     Independent confirmation
 *   Transit disruption    Official or 2 qualified reports
 *   Price / access policy Transaction or official update
 *
 * These rules decide only whether an observation may EXTEND the clock. They
 * do not decide whether it counts toward the cohort, the value plurality, or
 * the privacy gate — those stay as they are. A refused extender is still a
 * person who reported something; it just does not make an old claim young.
 *
 * "Qualified" means a source class that may back a live observation at all:
 * firsthand (verified or not) or a signed official statement. Hearsay,
 * sponsored, imported, historical and predicted sources never extend anything
 * (Table 8: none of them may support a current operational claim alone).
 */
export type ClaimFamily =
  | "queue"
  | "crowd_level"
  | "trajectory"
  | "crowd_mix_music"
  | "transit_disruption"
  | "price_access_policy"
  | "unlisted";

/**
 * Registry claim types → Table-16 family. Types Table 16 does not name are
 * mapped to the family whose rule matches their Table-6 minimum evidence:
 * service.wait / access.walk_in / inventory.status / event.status /
 * closure.state are all "firsthand or official" operational facts, i.e. the
 * Queue rule (new qualified observation); crowd.direction is a crowd-level
 * fact; vibe.state is a subjective descriptor like crowd.mix. Anything else
 * is "unlisted" and gets the default rule below.
 */
export const CLAIM_FAMILY_BY_TYPE: Readonly<Record<string, ClaimFamily>> = {
  "queue.wait": "queue",
  "service.wait": "queue",
  "access.walk_in": "queue",
  "inventory.status": "queue",
  "event.status": "queue",
  "closure.state": "queue",
  "crowd.level": "crowd_level",
  "crowd.direction": "crowd_level",
  "experience.next_move": "crowd_level",
  "crowd.trajectory": "trajectory",
  "crowd.mix": "crowd_mix_music",
  "music.current": "crowd_mix_music",
  "vibe.state": "crowd_mix_music",
  "transit.condition": "transit_disruption",
  "access.reservation": "price_access_policy",
  "access.dress": "price_access_policy",
  "price.cover": "price_access_policy",
};

export function claimFamilyOf(claimType: string): ClaimFamily {
  return CLAIM_FAMILY_BY_TYPE[claimType] ?? "unlisted";
}

/** Source classes that may back a live observation and therefore extend a clock. */
export const QUALIFYING_EXTENSION_SOURCE_CLASSES: readonly string[] = [
  "verified_firsthand",
  "firsthand_unverified",
  "official_signed",
] as const;

export function isQualifyingExtensionSource(sourceClass: string | null | undefined): boolean {
  return typeof sourceClass === "string" && QUALIFYING_EXTENSION_SOURCE_CLASSES.includes(sourceClass);
}

/**
 * Trajectory: "new time-separated observation". Table 6 asks for "two
 * observations over time"; the separation is not quantified in the spec, so
 * this is a v1 default an owner may tune: ten minutes, the same order as the
 * publication delay. Two taps a minute apart are one observation of a trend.
 */
export const TRAJECTORY_MIN_SEPARATION_SECONDS = 600;

/** Presence levels that carry transaction proof (Table 13: P3 = P2 + receipt/booking/entry, P4 = mission). */
const TRANSACTION_PRESENCE_LEVELS: readonly string[] = ["P3", "P4"];

export interface ExtensionCandidate {
  sourceClass: string | null | undefined;
  presenceLevel?: string | null;
  /** The observer; null for an actor-less (official/system) row. */
  actorId: string | null | undefined;
  observedAt: string | number | Date;
  /** The claim's frozen anchor time — the clock this observation would extend. */
  anchorObservedAt: string | number | Date;
  /** The actor who anchored the claim, when known; null when unknown. */
  anchorActorId?: string | null;
  /** Distinct qualified reporters in the fresh cohort, INCLUDING this one (transit's "2 qualified reports"). */
  qualifiedReporters?: number;
}

export type ExtensionRefusal =
  | "not_after_anchor"
  | "unqualified_source"
  | "not_independent"
  | "not_time_separated"
  | "needs_official_or_two_reports"
  | "needs_transaction_or_official";

export type ExtensionDecision =
  | { allowed: true; family: ClaimFamily }
  | { allowed: false; family: ClaimFamily; reason: ExtensionRefusal };

function ms(t: string | number | Date): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  return new Date(t).getTime();
}

/**
 * May this observation extend the freshness clock of a claim of `claimType`?
 * Pure. Fail-closed: anything malformed is refused with a named reason.
 */
export function mayExtendFreshness(claimType: string, c: ExtensionCandidate): ExtensionDecision {
  const family = claimFamilyOf(claimType);
  const at = ms(c.observedAt);
  const anchor = ms(c.anchorObservedAt);
  if (!Number.isFinite(at) || !Number.isFinite(anchor) || at <= anchor) {
    return { allowed: false, family, reason: "not_after_anchor" };
  }
  if (!isQualifyingExtensionSource(c.sourceClass)) {
    return { allowed: false, family, reason: "unqualified_source" };
  }
  const official = c.sourceClass === "official_signed";
  // A different party from the one who anchored the claim. An official
  // statement is by construction a different party from a traveler's tap. An
  // unknown anchor actor cannot be proven equal to anyone, so it does not
  // block; the observation still had to be qualified and after the anchor.
  const independent =
    official ||
    (typeof c.actorId === "string" && c.actorId.length > 0 && (c.anchorActorId == null || c.actorId !== c.anchorActorId));

  switch (family) {
    case "queue":
    case "unlisted":
      return { allowed: true, family };
    case "crowd_level":
    case "crowd_mix_music":
      return independent ? { allowed: true, family } : { allowed: false, family, reason: "not_independent" };
    case "trajectory":
      return at - anchor >= TRAJECTORY_MIN_SEPARATION_SECONDS * 1000
        ? { allowed: true, family }
        : { allowed: false, family, reason: "not_time_separated" };
    case "transit_disruption":
      return official || (c.qualifiedReporters ?? 0) >= 2
        ? { allowed: true, family }
        : { allowed: false, family, reason: "needs_official_or_two_reports" };
    case "price_access_policy":
      return official || (typeof c.presenceLevel === "string" && TRANSACTION_PRESENCE_LEVELS.includes(c.presenceLevel))
        ? { allowed: true, family }
        : { allowed: false, family, reason: "needs_transaction_or_official" };
  }
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
