/**
 * RankingConfig — reads ranking_config values from the database with a
 * short in-memory TTL cache (60 seconds).
 *
 * All ranking services call `getRankingConfig()` or the typed constant
 * helpers (e.g. `getWeights()`) rather than hard-coding magic numbers.
 *
 * Pattern mirrors src/compass/flags.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const CACHE_TTL_MS = 60_000; // 60 seconds

interface CacheEntry {
  config: Record<string, number>;
  cachedAt: number;
}

let _cache: CacheEntry | null = null;

/** Invalidate the in-memory cache (useful in tests after config writes). */
export function invalidateRankingConfigCache(): void {
  _cache = null;
}

/** Load all ranking_config rows and return as a Record<key, value>. */
async function loadConfig(
  db: SupabaseClient,
): Promise<Record<string, number>> {
  try {
    const { data } = await db
      .from("ranking_config")
      .select("key, value")
      .like("key", "ranking.%");
    const out: Record<string, number> = {};
    for (const row of (data as any[]) ?? []) {
      out[row.key] = Number(row.value);
    }
    return out;
  } catch {
    return {};
  }
}

/** Return all ranking_config values, using the cache when fresh. */
export async function getRankingConfig(
  db: SupabaseClient,
): Promise<Record<string, number>> {
  if (_cache && Date.now() - _cache.cachedAt < CACHE_TTL_MS) {
    return _cache.config;
  }
  const config = await loadConfig(db);
  _cache = { config, cachedAt: Date.now() };
  return config;
}

/** Return a single config value, or `defaultValue` if missing. */
export async function getConfigValue(
  db: SupabaseClient,
  key: string,
  defaultValue: number,
): Promise<number> {
  const config = await getRankingConfig(db);
  return config[key] ?? defaultValue;
}

// ─── Typed helpers ────────────────────────────────────────────────────────────
// Each group reads all ranking_config rows once (cached) and returns a strongly
// typed object so callers never reference raw string keys.

export interface RankingWeights {
  relevance: number;
  freshness: number;
  quality: number;
  activity: number;
  engagement: number;
  exploration: number;
  underexposure: number;
}

/** Score weights for the ranking formula. Values are 0-100 percentages. */
export async function getWeights(db: SupabaseClient): Promise<RankingWeights> {
  const c = await getRankingConfig(db);
  return {
    relevance: c["ranking.weights.relevance"] ?? 35,
    freshness: c["ranking.weights.freshness"] ?? 20,
    quality: c["ranking.weights.quality"] ?? 15,
    activity: c["ranking.weights.activity"] ?? 10,
    engagement: c["ranking.weights.engagement"] ?? 10,
    exploration: c["ranking.weights.exploration"] ?? 5,
    underexposure: c["ranking.weights.underexposure"] ?? 5,
  };
}

export interface RankingPenalties {
  repetition: number;
  fatigue: number;
  negativeFeedback: number;
}

/** Score penalties subtracted from a candidate's final score. */
export async function getPenalties(
  db: SupabaseClient,
): Promise<RankingPenalties> {
  const c = await getRankingConfig(db);
  return {
    repetition: c["ranking.penalties.repetition"] ?? 10,
    fatigue: c["ranking.penalties.fatigue"] ?? 8,
    negativeFeedback: c["ranking.penalties.negativeFeedback"] ?? 15,
  };
}

export interface FeedShares {
  relevance: number;
  activeCreator: number;
  underexposed: number;
  newUser: number;
  exploration: number;
}

/** Percentage of feed slots allocated to each content pool. */
export async function getFeedShares(db: SupabaseClient): Promise<FeedShares> {
  const c = await getRankingConfig(db);
  return {
    relevance: c["ranking.shares.relevance"] ?? 52,
    activeCreator: c["ranking.shares.activeCreator"] ?? 15,
    underexposed: c["ranking.shares.underexposed"] ?? 15,
    newUser: c["ranking.shares.newUser"] ?? 13,
    exploration: c["ranking.shares.exploration"] ?? 5,
  };
}

export interface ActivityParams {
  maxBoost: number;
  decayHalfLifeDays: number;
  capScore: number;
}

/** Parameters for the creator activity score boost calculation. */
export async function getActivityParams(
  db: SupabaseClient,
): Promise<ActivityParams> {
  const c = await getRankingConfig(db);
  return {
    maxBoost: c["ranking.activity.maxBoost"] ?? 10,
    decayHalfLifeDays: c["ranking.activity.decayHalfLifeDays"] ?? 14,
    capScore: c["ranking.activity.capScore"] ?? 100,
  };
}
