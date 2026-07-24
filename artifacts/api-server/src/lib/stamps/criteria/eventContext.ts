/**
 * Event → criteria context — Stamp Wave 3 follow-up.
 *
 * Events carry a free-text `category` (≤60 chars) plus a `tags TEXT[]` array.
 * The criteria engine's event-category stamps (foodie_explorer, music_lover,
 * outdoor_adventurer) key off boolean context metrics. This maps the event's
 * human-authored category + tags onto those booleans with keyword matching, so
 * the RSVP trigger can hand the engine ground truth about THIS event.
 *
 * Deliberately permissive: a single event can match multiple buckets (a
 * "food & live music festival" is both food and music), and matching an
 * unrelated event to none is correct — those stamps simply don't apply.
 *
 * Pure + synchronous → unit-testable without a DB.
 */

export interface EventCategoryContext {
  event_category_food: boolean;
  event_category_music: boolean;
  event_category_outdoor: boolean;
}

const KEYWORDS: Record<keyof EventCategoryContext, string[]> = {
  event_category_food: [
    "food", "foodie", "dining", "dinner", "brunch", "lunch", "restaurant",
    "culinary", "cuisine", "tasting", "wine", "beer", "cocktail", "coffee",
    "cafe", "bakery", "bbq", "barbecue", "streetfood", "supper", "drinks",
  ],
  event_category_music: [
    "music", "concert", "gig", "band", "dj", "festival", "live music",
    "rave", "club night", "karaoke", "jazz", "rock", "hiphop", "hip hop",
    "edm", "orchestra", "acoustic", "rap", "singer", "opera",
  ],
  event_category_outdoor: [
    "outdoor", "hike", "hiking", "trek", "trekking", "camp", "camping",
    "beach", "surf", "kayak", "climb", "climbing", "trail", "nature",
    "mountain", "cycling", "biking", "run", "running", "picnic", "park",
    "diving", "snorkel", "adventure",
  ],
};

function normalizeTokens(category: string | null | undefined, tags: unknown): string {
  const parts: string[] = [];
  if (typeof category === "string") parts.push(category);
  if (Array.isArray(tags)) {
    for (const t of tags) if (typeof t === "string") parts.push(t);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Derive the food/music/outdoor booleans for an event row. Accepts anything
 * with `category` and/or `tags`; missing fields are treated as empty.
 */
export function eventCategoryContext(
  ev: { category?: string | null; tags?: unknown } | null | undefined,
): EventCategoryContext {
  const hay = normalizeTokens(ev?.category, ev?.tags);
  const match = (keys: string[]) => keys.some((k) => hay.includes(k));
  return {
    event_category_food: match(KEYWORDS.event_category_food),
    event_category_music: match(KEYWORDS.event_category_music),
    event_category_outdoor: match(KEYWORDS.event_category_outdoor),
  };
}

/** The event-category criteria stamps this context can unlock (scoping helper). */
export const EVENT_CATEGORY_STAMP_SLUGS = [
  "foodie_explorer",
  "music_lover",
  "outdoor_adventurer",
  "event_regular",
] as const;
