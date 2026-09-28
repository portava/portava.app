/**
 * discoveryRankFlags — the six switches for census-discovery §78's scoring
 * designs, and their one cached read. Seeded FALSE by migrations 3450–3454.
 *
 *   discovery_surface_objectives_enabled    3450  DV-09  per-surface family weights
 *   discovery_engagement_integrity_enabled  3451  DV-12  `03` §12 detector on save evidence
 *   discovery_feature_families_enabled      3452  DC-13  negative_feedback + exploration_value
 *                                                        terms; DRS negative-feedback inputs real
 *   discovery_intent_term_enabled           3453  A18    explicit current intent above interests
 *   discovery_trip_match_enabled            3453  DV-18  the `trip_match` producer
 *   discovery_diversity_axes_enabled        3454  DV-54  place, geography, Trail, history axes
 *
 * `*_enabled` ⇒ CAPABILITY: read through the shared `getFlagRow` (the only
 * shared helper that also returns `metadata`), fail-CLOSED — an absent row, a
 * resolved `.error` and a thrown client all read OFF, so an unreadable flag
 * leaves the ranker exactly as it was.
 *
 * Kept apart from lib/discoveryRankDesigns.ts on purpose: DiscoveryRankingService
 * needs one of these flags, and importing the designs module would drag the
 * Trails, Trips, Passport and Trust readers into every DRS consumer.
 */
import { getFlagRow } from "./featureFlags.js"; import { discoveryStopHalt } from "./discoveryStopGate.js";  // census-discovery §97

export const DISCOVERY_SURFACE_OBJECTIVES_FLAG = "discovery_surface_objectives_enabled";
export const DISCOVERY_ENGAGEMENT_INTEGRITY_FLAG = "discovery_engagement_integrity_enabled";
export const DISCOVERY_FEATURE_FAMILIES_FLAG = "discovery_feature_families_enabled";
export const DISCOVERY_INTENT_TERM_FLAG = "discovery_intent_term_enabled";
export const DISCOVERY_TRIP_MATCH_FLAG = "discovery_trip_match_enabled";
export const DISCOVERY_DIVERSITY_AXES_FLAG = "discovery_diversity_axes_enabled";

/** Every §78 flag, in migration order. */
export const RANK_DESIGN_FLAGS = [
  DISCOVERY_SURFACE_OBJECTIVES_FLAG,
  DISCOVERY_ENGAGEMENT_INTEGRITY_FLAG,
  DISCOVERY_FEATURE_FAMILIES_FLAG,
  DISCOVERY_INTENT_TERM_FLAG,
  DISCOVERY_TRIP_MATCH_FLAG,
  DISCOVERY_DIVERSITY_AXES_FLAG,
] as const;

export interface RankDesignFlagState { enabled: boolean; metadata: Record<string, unknown> | null }

export interface RankDesignFlags {
  objectives: RankDesignFlagState;
  integrity: RankDesignFlagState;
  families: RankDesignFlagState;
  intent: RankDesignFlagState;
  tripMatch: RankDesignFlagState;
  diversity: RankDesignFlagState;
}

const OFF: RankDesignFlagState = Object.freeze({ enabled: false, metadata: null }) as RankDesignFlagState;

export const ALL_RANK_DESIGN_FLAGS_OFF: RankDesignFlags = Object.freeze({
  objectives: OFF, integrity: OFF, families: OFF, intent: OFF, tripMatch: OFF, diversity: OFF,
}) as RankDesignFlags;

export function anyRankDesignEnabled(f: RankDesignFlags): boolean {
  return f.objectives.enabled || f.integrity.enabled || f.families.enabled
    || f.intent.enabled || f.tripMatch.enabled || f.diversity.enabled;
}

const TTL_MS = 30_000;
let cache: { client: unknown; at: number; flags: RankDesignFlags } | null = null;

export function invalidateRankDesignFlagCache(): void { cache = null; }

function state(row: { enabled: boolean; metadata: Record<string, unknown> | null } | null): RankDesignFlagState {
  return row && row.enabled === true
    ? { enabled: true, metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : null }
    : OFF;
}

/**
 * The six flags, cached 30 s per client OBJECT (identity-checked, so one
 * test's client never answers for the next). No client ⇒ all off.
 */
export async function loadRankDesignFlags(sc: any, nowMs: number = Date.now()): Promise<RankDesignFlags> {
  if (!sc) return ALL_RANK_DESIGN_FLAGS_OFF;
  if (cache && cache.client === sc && nowMs - cache.at < TTL_MS) return stopped(sc, cache.flags);
  const [objectives, integrity, families, intent, tripMatch, diversity] = await Promise.all([
    getFlagRow(sc, "discovery_surface_objectives_enabled"),
    getFlagRow(sc, "discovery_engagement_integrity_enabled"),
    getFlagRow(sc, "discovery_feature_families_enabled"),
    getFlagRow(sc, "discovery_intent_term_enabled"),
    getFlagRow(sc, "discovery_trip_match_enabled"),
    getFlagRow(sc, "discovery_diversity_axes_enabled"),
  ]);
  const flags: RankDesignFlags = {
    objectives: state(objectives), integrity: state(integrity), families: state(families),
    intent: state(intent), tripMatch: state(tripMatch), diversity: state(diversity),
  };
  cache = { client: sc, at: nowMs, flags };
  return stopped(sc, flags);
}

/** census-discovery §97 (D-W11S-1): while the Discovery stop is engaged every §78 design reads OFF — the flag-off ranker. Consulted only when a flag is ON. */
async function stopped(sc: unknown, flags: RankDesignFlags): Promise<RankDesignFlags> {
  return anyRankDesignEnabled(flags) && (await discoveryStopHalt(sc)) !== null ? ALL_RANK_DESIGN_FLAGS_OFF : flags;
}
