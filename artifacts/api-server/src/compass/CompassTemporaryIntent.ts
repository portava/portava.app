/**
 * CompassTemporaryIntent — the §13 TemporaryIntent addend to Compass ranking.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE
 * ==========================================
 * Map spec §13, first sentence: "Intent Mode represents temporary context, not a
 * permanent preference rewrite." Table 9 draws the pipeline as
 *
 *     UserPreferences + TemporaryIntent + CurrentContext + TripContext
 *       + LiveWorld  →  Discovery Candidates  →  Compass Ranking
 *
 * Note the `+`. The temporary intent is a SEPARATE addend to ranking, alongside
 * the stored profile — never merged into it, never written back. This module is
 * the server half of the client's features/map/intent/intentModel.ts: the client
 * builds an `IntentRankingContext` and sends it on the wire; this parses it back,
 * RE-CHECKS its expiry fail-closed (a client clock cannot keep a stale mood
 * alive), and turns it into a bounded scoring boost. It reads no profile and
 * writes nothing, so it CANNOT rewrite a preference — the §13 failure is
 * structurally out of reach.
 *
 * WHAT THIS IS NOT
 * ================
 * Pure functions over plain data. No DB, no network, no clock of its own — `now`
 * is passed in so expiry behaviour at the boundary is testable. The boost it
 * produces re-ranks candidates that have ALREADY cleared Safety / Eligibility /
 * Privacy (scoreItem runs after those gates), so intent can reorder what a user
 * may see but can never widen it — the k-anonymity and privacy gates are
 * untouched.
 */
import type { CompassItem, CompassItemType } from "./types.js";

/**
 * The nine primary intents, in §13's own order. Kept character-for-character in
 * step with MAP_INTENT_KINDS in
 * travel-buddy-standalone/src/features/map/intent/intentModel.ts — the server
 * cannot import the React Native module, so the vocabulary is restated and a
 * test pins the two lists equal. A drift is a dropped intent, which is silent,
 * so it is made loud by the pin.
 */
export const MAP_INTENT_KINDS = [
  "bored",
  "eat",
  "party",
  "explore",
  "meet_people",
  "date_night",
  "chill",
  "local",
  "surprise_me",
] as const;

export type MapIntentKind = (typeof MAP_INTENT_KINDS)[number];

/** Display labels, verbatim from §13 (matches the client's MAP_INTENT_LABELS). */
export const MAP_INTENT_LABELS: Record<MapIntentKind, string> = {
  bored: "I'm Bored",
  eat: "Eat",
  party: "Party",
  explore: "Explore",
  meet_people: "Meet People",
  date_night: "Date Night",
  chill: "Chill",
  local: "Local",
  surprise_me: "Surprise Me",
};

export function isMapIntentKind(v: unknown): v is MapIntentKind {
  return typeof v === "string" && (MAP_INTENT_KINDS as readonly string[]).includes(v);
}

/**
 * The resolved, live temporary intent as ranking sees it. `energy` and `novelty`
 * are the two §13 sliders, each clamped to [0, 1] with 0.5 the neutral midpoint.
 */
export interface TemporaryIntentContext {
  kind: MapIntentKind;
  energy: number;
  novelty: number;
  /** ISO instant the intent stops counting. Null ⇒ no client-declared horizon. */
  expiresAt: string | null;
}

/** The wire shape a client sends (the flattened IntentRankingContext fields). */
export interface RawTemporaryIntent {
  intent?: string;
  intentEnergy?: number;
  intentNovelty?: number;
  intentExpiresAt?: string;
}

const NEUTRAL = 0.5;

function clamp01(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return NEUTRAL;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Parse an intent off the request and, crucially, RE-CHECK its expiry.
 *
 * The client already drops an expired intent through `activeIntent`, but the
 * server cannot trust a client clock: a device set to yesterday would keep a
 * mood alive forever, which is exactly the permanence §13 forbids. So expiry is
 * enforced here too, fail-closed — a horizon that is absent-but-malformed, or
 * already past `now`, yields `null` (no intent), never a live one. A well-formed
 * intent with no `expiresAt` at all is accepted (the horizon is optional on the
 * wire); it simply cannot be expiry-checked, and the client's TTL still governs
 * whether it was sent.
 */
export function parseTemporaryIntent(
  raw: RawTemporaryIntent | null | undefined,
  now: number = Date.now(),
): TemporaryIntentContext | null {
  if (!raw || !isMapIntentKind(raw.intent)) return null;

  const expiresAt =
    typeof raw.intentExpiresAt === "string" && raw.intentExpiresAt.length > 0
      ? raw.intentExpiresAt
      : null;
  if (expiresAt !== null) {
    const ms = Date.parse(expiresAt);
    // Unparseable OR already expired ⇒ fail-closed to "no intent". A stale mood
    // must never reach ranking, whatever the sending clock claimed.
    if (!Number.isFinite(ms) || now >= ms) return null;
  }

  return {
    kind: raw.intent,
    energy: clamp01(raw.intentEnergy),
    novelty: clamp01(raw.intentNovelty),
    expiresAt,
  };
}

// ── Intent → item affinity ──────────────────────────────────────────────────
//
// Each intent names the category/interest keywords and the item types that
// genuinely serve it. These are affinities, not a taxonomy: a substring match
// ("food" in "street food") counts, because item categories are free-ish text.

const INTENT_TAGS: Record<MapIntentKind, readonly string[]> = {
  bored: ["fun", "activity", "entertainment", "game", "show", "arcade", "amusement"],
  eat: ["food", "restaurant", "cafe", "dining", "eat", "brunch", "coffee", "bakery", "street food", "dessert"],
  party: ["nightlife", "club", "bar", "party", "dance", "dj", "pub", "rooftop", "cocktail", "live music"],
  explore: ["explore", "sightseeing", "culture", "landmark", "museum", "art", "nature", "walk", "viewpoint", "temple", "gallery", "market", "heritage"],
  meet_people: ["social", "meetup", "community", "networking", "group", "language exchange", "hangout", "mingle"],
  date_night: ["romantic", "date", "fine dining", "wine", "cocktail", "sunset", "rooftop", "live music", "candlelit"],
  chill: ["relax", "chill", "cafe", "park", "wellness", "spa", "quiet", "nature", "beach", "garden", "tea"],
  local: ["local", "hidden gem", "authentic", "traditional", "neighborhood", "market", "family-run"],
  // surprise_me carries no tag list — it is served by novelty, below.
  surprise_me: [],
};

const INTENT_TYPES: Record<MapIntentKind, readonly CompassItemType[]> = {
  bored: ["event", "post"],
  eat: ["place"],
  party: ["event", "place"],
  explore: ["place", "hidden_gem", "event", "stamp"],
  meet_people: ["user", "buddy", "event", "traveler"],
  date_night: ["place", "event"],
  chill: ["place", "hidden_gem"],
  local: ["hidden_gem", "place"],
  surprise_me: ["hidden_gem"],
};

/** Intents whose whole point is high energy — a high slider amplifies them. */
const HIGH_ENERGY_INTENTS: ReadonlySet<MapIntentKind> = new Set(["party", "bored", "meet_people", "date_night"]);
/** Intents whose whole point is low energy — a LOW slider amplifies them. */
const LOW_ENERGY_INTENTS: ReadonlySet<MapIntentKind> = new Set(["chill", "local"]);

/** Modest [0.75, 1.25] band: energy/novelty reorder within a match, never dominate it. */
function energyMultiplier(kind: MapIntentKind, energy: number): number {
  if (HIGH_ENERGY_INTENTS.has(kind)) return 0.75 + 0.5 * energy;
  if (LOW_ENERGY_INTENTS.has(kind)) return 0.75 + 0.5 * (1 - energy);
  return 1;
}

/** Adventurous (high novelty) favours hidden gems; familiar favours the rest. */
function noveltyMultiplier(item: CompassItem, novelty: number): number {
  return item.type === "hidden_gem" ? 0.75 + 0.5 * novelty : 1;
}

/** Lowercased category + interest tags for one item, empty strings dropped. */
function itemTagsOf(item: CompassItem): string[] {
  const cat = typeof (item as { category?: unknown }).category === "string"
    ? [(item as { category?: string }).category as string]
    : [];
  const tags = Array.isArray(item.interestTags) ? item.interestTags : [];
  return [...cat, ...tags]
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .map((t) => t.toLowerCase());
}

/** Whether any of the item's tags overlaps (either-way substring) the intent's. */
function hasTagOverlap(item: CompassItem, kind: MapIntentKind): boolean {
  const wanted = INTENT_TAGS[kind];
  if (wanted.length === 0) return false;
  for (const t of itemTagsOf(item)) {
    for (const kw of wanted) {
      if (t.includes(kw) || kw.includes(t)) return true;
    }
  }
  return false;
}

/**
 * The graded intent match, in [0, 1]. A tag overlap is a strong match (1); a
 * type-only affinity is a weak one (0.5); surprise_me scores hidden gems 1 and
 * everything else a low baseline. The two sliders then modulate within a modest
 * band. Deterministic — the same item and intent always score the same.
 */
export function intentMatchFraction(item: CompassItem, intent: TemporaryIntentContext): number {
  const kind = intent.kind;
  let base: number;
  if (kind === "surprise_me") {
    base = item.type === "hidden_gem" ? 1 : 0.4;
  } else {
    const tagHit = hasTagOverlap(item, kind);
    const typeHit = (INTENT_TYPES[kind] as readonly string[]).includes(item.type);
    base = tagHit ? 1 : typeHit ? 0.5 : 0;
  }
  const scaled = base * energyMultiplier(kind, intent.energy) * noveltyMultiplier(item, intent.novelty);
  return Math.min(1, Math.max(0, scaled));
}

/**
 * The STRONG-match boolean behind the §14 "Matches current intent" line. A
 * genuine match — a tag overlap, or a hidden gem for surprise_me — not a weak
 * type-only affinity. This is what gets surfaced on a recommendation, so it must
 * be defensible when the user reads "Matches current Party intent".
 */
export function itemMatchesIntent(item: CompassItem, intent: TemporaryIntentContext): boolean {
  if (intent.kind === "surprise_me") return item.type === "hidden_gem";
  return hasTagOverlap(item, intent.kind);
}

/**
 * The maximum ranking boost a fully-matched item earns from the intent addend.
 * 20 — on the order of the interestMatch/cityMatch weights, so a strong intent
 * match can reorder mid-ranked candidates, but sits OUTSIDE the per-type 100
 * budget (like the place-affinity boost) because it is a request-scoped addend,
 * not a stored preference. The final score is still clamped to 100.
 */
export const INTENT_BOOST_MAX = 20;

/** The additive score component for one item under an intent (0…INTENT_BOOST_MAX). */
export function intentBoost(item: CompassItem, intent: TemporaryIntentContext | null | undefined): number {
  if (!intent) return 0;
  return INTENT_BOOST_MAX * intentMatchFraction(item, intent);
}
