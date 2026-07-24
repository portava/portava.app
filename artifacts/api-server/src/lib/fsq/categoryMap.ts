/**
 * FSQ category mapping — Compass data (Foursquare OS Places).
 *
 * FSQ OS Places tags each venue with hierarchical category LABELS like
 * "Dining and Drinking > Bar > Cocktail Bar" (top-level ` > ` sub-levels) plus
 * stable category IDs. We map those onto Portava's place taxonomy so FSQ venues
 * slot into the same buckets neighborhood-match / discovery already use, PLUS
 * an `accommodation` bucket (hotels — the thing OSM covers poorly and no free
 * booking API gives us).
 *
 * Mapping is keyword-based over the labels (robust to FSQ taxonomy revisions),
 * most-specific-first: a "Hotel Bar" is accommodation-adjacent but reads as a
 * bar, so nightlife keywords are checked before the generic dining bucket, and
 * lodging before everything. Anything unrecognized → 'other' (kept, not
 * discarded — honest, and still useful as density signal).
 */

export const FSQ_PLACE_CATEGORIES = [
  "accommodation",
  "nightlife",
  "food",
  "culture",
  "shopping",
  "other",
] as const;
export type FsqPlaceCategory = (typeof FSQ_PLACE_CATEGORIES)[number];

// Keyword → category, checked in this order (first hit wins).
const RULES: Array<{ category: FsqPlaceCategory; keywords: string[] }> = [
  {
    category: "accommodation",
    keywords: ["lodging", "hotel", "hostel", "motel", "resort", "bed and breakfast", "b&b", "inn", "guest house", "guesthouse", "vacation rental"],
  },
  {
    category: "nightlife",
    keywords: ["bar", "pub", "nightclub", "night club", "nightlife", "brewery", "brewpub", "cocktail", "lounge", "beer garden", "wine bar", "speakeasy", "distillery", "hookah", "karaoke"],
  },
  {
    category: "culture",
    keywords: ["museum", "art gallery", "gallery", "monument", "landmark", "historic", "theater", "theatre", "performing arts", "opera", "concert hall", "cultural", "temple", "church", "mosque", "shrine", "cathedral", "palace", "castle", "memorial", "exhibit"],
  },
  {
    category: "food",
    keywords: ["restaurant", "café", "cafe", "coffee", "bakery", "diner", "bistro", "eatery", "food", "dining", "steakhouse", "pizzeria", "deli", "breakfast", "brunch", "dessert", "ice cream", "tea room", "food truck", "food court", "snack"],
  },
  {
    category: "shopping",
    keywords: ["retail", "shop", "store", "market", "mall", "boutique", "shopping", "supermarket", "grocery", "department store", "bookstore", "market"],
  },
];

function norm(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

/**
 * Map a venue's FSQ category labels to a Portava category. Labels may be full
 * hierarchical strings ("A > B > C") or leaf names; both work. Returns the
 * most-specific match across all of the venue's labels, or 'other'.
 */
export function mapFsqCategory(labels: string[] | null | undefined): FsqPlaceCategory {
  if (!labels || labels.length === 0) return "other";
  const hay = labels.map(norm).join(" | ");
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      // word-ish boundary so "bar" doesn't match "barber"/"barbecue"
      const re = new RegExp(`(^|[^a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
      if (re.test(hay)) return rule.category;
    }
  }
  return "other";
}

/** The single most representative (leaf) label for display, or null. */
export function primaryLabel(labels: string[] | null | undefined): string | null {
  if (!labels || labels.length === 0) return null;
  // Prefer the deepest segment of the first label (most specific).
  const first = String(labels[0] ?? "");
  const parts = first.split(">").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : (first.trim() || null);
}
