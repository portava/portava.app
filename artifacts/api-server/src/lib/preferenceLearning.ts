/**
 * Telegraph Preference Learning Engine
 *
 * Scoring formula:
 *   interest_match + behavior_affinity + trip_context_fit
 *   - avoid_penalty - dismissed_recently_penalty
 *
 * Explicit preferences always override inferred signals.
 * Recency decay: events older than 30 days have half weight.
 */

export type TravelPace = "relaxed" | "balanced" | "packed";
export type GroupStyle = "solo" | "small" | "group" | "mixed";
export type ActivityTime = "morning" | "afternoon" | "evening" | "late_night";
export type FeedbackSignal =
  | "save"
  | "add_to_plan"
  | "more_like_this"
  | "less_like_this"
  | "not_for_me"
  | "dismiss"
  | "view"
  | "share";

export interface ExplicitPreferences {
  interests: string[];
  foodPreferences: string[];
  nightlifePreferences: string[];
  pace: TravelPace;
  groupStyle: GroupStyle;
  preferredActivityTimes: ActivityTime[];
  avoidList: string[];
}

export interface InferredPreferences {
  categoryAffinities: Record<string, number>;  // category -> score -1..1
  dismissedCategories: string[];
  savedCategories: string[];
  addedToPlanCategories: string[];
}

export interface UserPreferenceProfile {
  userId: string;
  explicit: ExplicitPreferences;
  inferred: InferredPreferences;
  lastUpdatedAt: string;
}

export interface PreferenceEvent {
  id?: string;
  userId: string;
  recommendationId: string;
  category: string;
  signal: FeedbackSignal;
  createdAt?: string;
  tripId?: string | null;
}

const SIGNAL_WEIGHT: Record<FeedbackSignal, number> = {
  save:           0.8,
  add_to_plan:    1.0,
  more_like_this: 0.6,
  view:           0.1,
  share:          0.5,
  less_like_this: -0.6,
  not_for_me:     -1.0,
  dismiss:        -0.3,
};

const DECAY_HALF_LIFE_DAYS = 30;

function recencyWeight(createdAt: string): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}

/**
 * Apply a new preference event to update the inferred profile.
 * Returns updated InferredPreferences (pure function, no side effects).
 */
export function applyEvent(
  inferred: InferredPreferences,
  event: PreferenceEvent,
): InferredPreferences {
  const { category, signal, createdAt } = event;
  const weight = (SIGNAL_WEIGHT[signal] ?? 0) * recencyWeight(createdAt ?? new Date().toISOString());
  const current = inferred.categoryAffinities[category] ?? 0;
  const updated = Math.max(-1, Math.min(1, current + weight * 0.2));

  const newAffinities = { ...inferred.categoryAffinities, [category]: updated };

  const dismissed = signal === "not_for_me" || signal === "less_like_this"
    ? Array.from(new Set([...inferred.dismissedCategories, category]))
    : inferred.dismissedCategories;

  const saved = signal === "save"
    ? Array.from(new Set([...inferred.savedCategories, category]))
    : inferred.savedCategories;

  const added = signal === "add_to_plan"
    ? Array.from(new Set([...inferred.addedToPlanCategories, category]))
    : inferred.addedToPlanCategories;

  return {
    categoryAffinities: newAffinities,
    dismissedCategories: dismissed,
    savedCategories: saved,
    addedToPlanCategories: added,
  };
}

/**
 * Score a recommendation candidate against a user's preference profile.
 * Higher is better. Range: -2 .. 3
 */
export function scoreRecommendation(
  category: string,
  explicit: ExplicitPreferences | null | undefined,
  inferred: InferredPreferences | null | undefined,
): number {
  // Defensive: treat any missing/partial profile as empty defaults so this
  // function never throws, even if a profile was created with `{}`.
  const interests:    string[]              = explicit?.interests            ?? [];
  const foodPrefs:    string[]              = explicit?.foodPreferences       ?? [];
  const nightPrefs:   string[]              = explicit?.nightlifePreferences  ?? [];
  const avoidList:    string[]              = explicit?.avoidList             ?? [];
  const affinities:   Record<string,number> = inferred?.categoryAffinities   ?? {};
  const dismissed:    string[]              = inferred?.dismissedCategories   ?? [];

  let score = 0;

  // Explicit interest match (strongest signal — overrides inferred)
  if (interests.includes(category)) score += 1.5;
  if (foodPrefs.some((f) => category.includes(f))) score += 0.5;
  if (nightPrefs.some((n) => category.includes(n))) score += 0.5;

  // Behavior affinity from learning engine
  score += affinities[category] ?? 0;

  // Avoid penalty (explicit trumps everything)
  if (avoidList.some((a) => category.toLowerCase().includes(a.toLowerCase()))) {
    score -= 2;
  }

  // Dismissed penalty (inferred)
  if (dismissed.includes(category)) score -= 0.8;

  return score;
}

export function defaultExplicit(): ExplicitPreferences {
  return {
    interests: [],
    foodPreferences: [],
    nightlifePreferences: [],
    pace: "balanced",
    groupStyle: "mixed",
    preferredActivityTimes: [],
    avoidList: [],
  };
}

export function defaultInferred(): InferredPreferences {
  return {
    categoryAffinities: {},
    dismissedCategories: [],
    savedCategories: [],
    addedToPlanCategories: [],
  };
}
