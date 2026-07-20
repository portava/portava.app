/**
 * CompassRecommendationEngine — Phase 7 formal recommendation engine.
 *
 * Single candidate-ranking authority. Every recommendation surface (feed,
 * sections, discovery, chat search tools) sources its candidate ORDER from
 * this system — the model never ranks or invents candidates.
 *
 * Two independent signals per candidate:
 *
 *   Compass Match   — PERSONAL FIT (0–100). How well this candidate fits the
 *                     viewing user: interests, city, language, social style,
 *                     safety preference, budget, distance, open-now status,
 *                     feedback history (category weights) and Phase 6
 *                     memory-derived preferences. Contains NO popularity or
 *                     trust signals.
 *
 *   Community Score — POPULARITY (0–100). How well the community rates this
 *                     candidate: quality/rating, saved count, attendance,
 *                     author trust, minus report/spam signals. Contains NO
 *                     viewer-specific signals — the same item scores the same
 *                     for every user.
 *
 * Ranking factors:
 *   Each candidate carries a grounded list of RankingFactor entries — one per
 *   signal that actually contributed. "Why this?" explanations are generated
 *   ONLY from these factors, so every explanation is provably grounded in the
 *   ranking computation (never model-invented).
 *
 *   Privacy rule: safety/moderation signals (risk, reports, spam) NEVER
 *   appear as user-facing factors.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile } from "./types.js";

// ── Ranking factors ───────────────────────────────────────────────────────────

export interface RankingFactor {
  /** Machine key, e.g. "interest_match". */
  key: string;
  /** Human-readable label shown in the "Why this?" sheet. */
  label: string;
  /** Normalised contribution 0–1 (how strongly this factor fired). */
  weight: number;
  /** Optional grounding detail, e.g. the matched tags or city. */
  detail?: string;
}

export interface CandidateAnnotation {
  compassMatch: number;
  communityScore: number;
  factors: RankingFactor[];
  /** Bounded finalScore bonus from memory-derived preferences (0–5). */
  memoryBoost: number;
}

// ── Community Score (popularity — viewer-independent) ─────────────────────────

function log01(value: number, saturation: number): number {
  if (value <= 0) return 0;
  return Math.min(1, Math.log2(value + 1) / Math.log2(saturation + 1));
}

/**
 * Compute the Community Score for an item: pure popularity/quality/trust.
 * Deterministic per item — never reads the viewer's profile.
 */
export function computeCommunityScore(item: CompassItem): number {
  const quality = typeof item.qualityScore === "number"
    ? Math.max(0, Math.min(10, item.qualityScore)) / 10
    : 0.5; // neutral when unknown
  const saved      = log01(Number(item.savedCount ?? 0), 100);
  const attendance = log01(Number(item.currentAttendees ?? 0), 50);
  const trust = item.authorTrustScore != null
    ? Math.max(0, Math.min(100, item.authorTrustScore)) / 100
    : 0.4; // slightly conservative neutral

  let score =
    quality    * 45 +
    saved      * 25 +
    attendance * 15 +
    trust      * 15;

  // Community-negative signals
  const reports = Number(item.reportCount ?? 0);
  if (reports > 0)  score -= Math.min(15, reports * 3);
  if (item.isSpam)  score -= 15;

  return Math.round(Math.max(0, Math.min(100, score)));
}

// ── Compass Match (personal fit — popularity-independent) ─────────────────────

interface MatchWeights {
  interest: number; city: number; language: number; social: number;
  safety: number; budget: number; distance: number; openNow: number;
  history: number; memory: number; availability: number; time: number;
}

const MATCH_WEIGHTS: MatchWeights = {
  interest:     26,
  city:         14,
  language:      8,
  social:        6,
  safety:        5,
  budget:        8,
  distance:      8,
  openNow:       4,
  history:      10, // feedback category weights (prior outcomes)
  memory:        7, // Phase 6 memory-derived preferences
  availability:  2, // event has space / buddy accepting
  time:          2, // event starts soon-ish (temporal relevance)
};

function lower(list: string[] | undefined | null): string[] {
  return (list ?? []).map((s) => String(s).toLowerCase());
}

function overlap(a: string[], b: string[]): string[] {
  const bs = new Set(b);
  return [...new Set(a)].filter((x) => bs.has(x));
}

export interface CompassMatchResult {
  score: number;
  factors: RankingFactor[];
  /** 0–1 memory affinity (used for the bounded finalScore boost). */
  memoryAffinity: number;
}

/**
 * Compute the Compass Match (personal fit) for one candidate.
 *
 * @param item        Sanitized candidate item
 * @param profile     Viewer's Compass profile
 * @param memoryTags  Lower-case preference tokens derived from the viewer's
 *                    long-term Compass memories (Phase 6)
 */
export function computeCompassMatch(
  item: CompassItem,
  profile: CompassProfile,
  memoryTags: Set<string> = new Set(),
): CompassMatchResult {
  const w = MATCH_WEIGHTS;
  const factors: RankingFactor[] = [];
  let score = 0;

  const tags = lower(item.interestTags);

  // Interests / travel style
  const styles = lower(profile.travelStyles);
  const interestHits = overlap(tags, styles);
  if (interestHits.length > 0 && styles.length > 0) {
    const ratio = Math.min(1, interestHits.length / Math.min(3, styles.length));
    score += ratio * w.interest;
    factors.push({
      key: "interest_match",
      label: "Matches your interests",
      weight: ratio,
      detail: interestHits.slice(0, 3).join(", "),
    });
  }

  // City / location
  const itemCity = item.city ? String(item.city).toLowerCase() : null;
  if (itemCity) {
    if (profile.currentCity && profile.currentCity.toLowerCase() === itemCity) {
      score += w.city;
      factors.push({ key: "city_match", label: "In your current city", weight: 1, detail: item.city });
    } else if (lower(profile.preferredCities).includes(itemCity)) {
      score += w.city * 0.5;
      factors.push({ key: "city_match", label: "In a city you prefer", weight: 0.5, detail: item.city });
    }
  }

  // Distance (closer = better; saturates at 25km)
  const distanceKm = typeof item.distanceKm === "number" ? (item.distanceKm as number) : null;
  if (distanceKm != null && distanceKm >= 0) {
    const ratio = Math.max(0, 1 - distanceKm / 25);
    if (ratio > 0) {
      score += ratio * w.distance;
      factors.push({
        key: "distance",
        label: "Close to you",
        weight: ratio,
        detail: distanceKm < 1 ? "under 1 km away" : `about ${Math.round(distanceKm)} km away`,
      });
    }
  }

  // Language
  const langs = lower(profile.preferredLanguages);
  if (item.languageCode && langs.includes(String(item.languageCode).toLowerCase())) {
    score += w.language;
    factors.push({ key: "language_match", label: "In a language you speak", weight: 1, detail: String(item.languageCode) });
  } else if (!item.languageCode || langs.length === 0) {
    score += w.language * 0.5; // neutral
  }

  // Social style
  if (item.groupType && profile.socialStyle &&
      String(item.groupType).toLowerCase() === profile.socialStyle.toLowerCase()) {
    score += w.social;
    factors.push({ key: "social_style", label: "Fits your social style", weight: 1, detail: profile.socialStyle });
  } else if (!item.groupType || !profile.socialStyle) {
    score += w.social * 0.5;
  }

  // Safety preference
  const tier = item.safetyTier ? String(item.safetyTier) : null;
  if (tier && tier === profile.safetyPreference) {
    score += w.safety;
    factors.push({ key: "safety_fit", label: "Matches your safety preference", weight: 1 });
  } else if (!tier) {
    score += w.safety * 0.5;
  }

  // Budget style
  const budget = profile.budgetStyle ? profile.budgetStyle.toLowerCase() : null;
  if (budget) {
    const budgetTags = new Set(["budget", "free", "cheap"]);
    const luxuryTags = new Set(["luxury", "premium", "exclusive"]);
    const hasBudgetTag = tags.some((t) => budgetTags.has(t));
    const hasLuxuryTag = tags.some((t) => luxuryTags.has(t));
    if (budget === "budget" && hasBudgetTag) {
      score += w.budget;
      factors.push({ key: "budget_fit", label: "Fits your budget style", weight: 1, detail: "budget-friendly" });
    } else if (budget === "luxury" && hasLuxuryTag) {
      score += w.budget;
      factors.push({ key: "budget_fit", label: "Fits your budget style", weight: 1, detail: "premium pick" });
    } else if (!hasBudgetTag && !hasLuxuryTag) {
      score += w.budget * 0.5; // no budget signal on item — neutral
    }
  } else {
    score += w.budget * 0.5;
  }

  // Open-now status (discovery places carry isOpenNow via adapter semantics)
  const openNow = (item as Record<string, unknown>).isOpenNow;
  if (openNow === true) {
    score += w.openNow;
    factors.push({ key: "open_now", label: "Open right now", weight: 1 });
  } else if (openNow == null) {
    score += w.openNow * 0.5;
  }

  // Availability (event capacity / buddy accepting)
  if (item.type === "event" && typeof item.capacity === "number" && typeof item.currentAttendees === "number") {
    const free = item.capacity - item.currentAttendees;
    if (free > 0) {
      score += w.availability;
      factors.push({ key: "availability", label: "Still has space", weight: 1, detail: `${free} spots left` });
    }
  } else if (item.type === "buddy" && item.buddyStatus === "active") {
    score += w.availability;
    factors.push({ key: "availability", label: "Available to book now", weight: 1 });
  } else {
    score += w.availability * 0.5;
  }

  // Time relevance — events starting within 48h are more actionable
  const startsAt = (item as Record<string, unknown>).eventStartsAt as string | undefined;
  if (item.type === "event" && startsAt) {
    const hours = (new Date(startsAt).getTime() - Date.now()) / 3_600_000;
    if (hours >= 0 && hours <= 48) {
      const ratio = 1 - hours / 48;
      score += ratio * w.time;
      factors.push({
        key: "time_relevance",
        label: "Happening soon",
        weight: ratio,
        detail: hours <= 12 ? "within the next 12 hours" : "within 2 days",
      });
    }
  }

  // History / prior outcomes — feedback-derived category weights (−10..+10)
  const weights = profile.categoryWeights;
  if (weights && Object.keys(weights).length > 0) {
    let delta = weights[item.type ?? ""] ?? 0;
    for (const tag of tags) delta += weights[tag] ?? 0;
    const clamped = Math.max(-10, Math.min(10, delta));
    if (clamped !== 0) {
      score += (clamped / 10) * w.history;
      if (clamped > 0) {
        factors.push({
          key: "history",
          label: "You've liked similar picks before",
          weight: clamped / 10,
        });
      }
    }
  }

  // Phase 6 memory-derived preferences
  let memoryAffinity = 0;
  if (memoryTags.size > 0 && tags.length > 0) {
    const memHits = tags.filter((t) => memoryTags.has(t));
    if (memHits.length > 0) {
      memoryAffinity = Math.min(1, memHits.length / 2);
      score += memoryAffinity * w.memory;
      factors.push({
        key: "memory_preference",
        label: "Based on what you've told Compass",
        weight: memoryAffinity,
        detail: memHits.slice(0, 3).join(", "),
      });
    }
  }

  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    factors,
    memoryAffinity,
  };
}

// ── Candidate annotation (used by the pipeline) ───────────────────────────────

/**
 * Annotate one gate-cleared candidate with Compass Match, Community Score and
 * grounded ranking factors. Pure — never throws, never touches the DB.
 */
export function annotateCandidate(
  item: CompassItem,
  profile: CompassProfile,
  memoryTags: Set<string> = new Set(),
): CandidateAnnotation {
  try {
    const communityScore = computeCommunityScore(item);
    const match = computeCompassMatch(item, profile, memoryTags);

    const factors = [...match.factors];
    // Community factor is grounded in the Community Score itself — shown only
    // when the community signal is genuinely strong.
    if (communityScore >= 70) {
      factors.push({
        key: "community_popular",
        label: "Popular with other travelers",
        weight: communityScore / 100,
      });
    }

    return {
      compassMatch: match.score,
      communityScore,
      factors,
      memoryBoost: Math.round(match.memoryAffinity * 5 * 100) / 100,
    };
  } catch {
    return { compassMatch: 0, communityScore: 0, factors: [], memoryBoost: 0 };
  }
}

// ── Memory-derived preference tags (Phase 6 → Phase 7 bridge) ─────────────────

const MEMORY_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "they", "them", "their",
  "user", "likes", "like", "loves", "love", "prefers", "prefer", "wants",
  "want", "enjoys", "enjoy", "always", "never", "when", "into", "very",
  "really", "avoid", "avoids", "does", "not", "has", "have", "will",
  "travel", "traveling", "travelling", "trip", "trips", "places", "place",
]);

/**
 * Load the viewer's long-term memories and distil them into a set of
 * lower-case preference tokens that can be matched against item tags.
 * Non-fatal: returns an empty set on any error or when db is null.
 */
export async function loadMemoryPreferenceTags(
  db: SupabaseClient | null,
  userId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!db) return out;
  try {
    const { data } = await db
      .from("compass_memories")
      .select("content, category")
      .eq("user_id", userId)
      .eq("scope", "long_term")
      .limit(100);
    for (const row of (data as any[]) ?? []) {
      const text = `${row.category ?? ""} ${row.content ?? ""}`.toLowerCase();
      for (const word of text.split(/[^a-z]+/)) {
        if (word.length >= 4 && !MEMORY_STOPWORDS.has(word)) out.add(word);
      }
    }
  } catch { /* non-fatal */ }
  return out;
}

// ── "Why this?" text generation ───────────────────────────────────────────────

/** Factor keys that must never surface to users (defense-in-depth). */
const SENSITIVE_FACTOR_KEYS = new Set([
  "risk", "report", "spam", "moderation", "safety_downrank", "harassment",
]);

/**
 * Filter a factor list down to what may be shown to users: sensitive keys
 * removed, non-positive weights removed. Used by every surface that returns
 * raw factor payloads (same policy as buildWhyThisText).
 */
export function presentableFactors(factors: RankingFactor[]): RankingFactor[] {
  return (factors ?? []).filter(
    (f) => f && !SENSITIVE_FACTOR_KEYS.has(f.key) && f.weight > 0,
  );
}

/**
 * Build a human-readable "Why this?" sentence grounded in actual ranking
 * factors. Returns null when there are no presentable factors (caller should
 * fall back to the explanation-key template).
 */
export function buildWhyThisText(factors: RankingFactor[]): string | null {
  const presentable = presentableFactors(factors)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  if (presentable.length === 0) return null;

  const parts = presentable.map((f) =>
    f.detail ? `${f.label.toLowerCase()} (${f.detail})` : f.label.toLowerCase(),
  );
  const joined =
    parts.length === 1 ? parts[0]! :
    parts.length === 2 ? `${parts[0]} and ${parts[1]}` :
    `${parts[0]}, ${parts[1]}, and ${parts[2]}`;

  return `Recommended for you: ${joined}.`;
}

// ── Profile normalisation (for callers with partial profiles, e.g. tools) ─────

/** Fill safe defaults so partial profiles never crash the ranking math. */
export function normalizeProfileForRanking(profile: CompassProfile): CompassProfile {
  return {
    ...profile,
    preferredCities:    profile.preferredCities    ?? [],
    preferredLanguages: profile.preferredLanguages ?? [],
    travelStyles:       profile.travelStyles       ?? [],
    socialStyle:        profile.socialStyle        ?? null,
    safetyPreference:   profile.safetyPreference   ?? "standard",
    budgetStyle:        profile.budgetStyle        ?? null,
    currentCity:        profile.currentCity        ?? null,
    categoryWeights:    profile.categoryWeights    ?? null,
    ignoredItemIds:     profile.ignoredItemIds     ?? [],
    blockedUserIds:     profile.blockedUserIds     ?? [],
    blockerUserIds:     profile.blockerUserIds     ?? [],
    mutedUserIds:       profile.mutedUserIds       ?? [],
  };
}
