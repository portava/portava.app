/**
 * Canonical place category taxonomy for discovery_places.
 *
 * Maps every raw category/place_type string found in seed data and community
 * submissions to one of 8 canonical Discovery tab categories:
 *   food | beaches | nightlife | activities | events | places | transport | other
 *
 * Usage:
 *   import { toCanonicalCategory, CANONICAL_CATEGORIES } from './placeCategories';
 *   const cat = toCanonicalCategory(row.category, row.place_type);
 */

export const CANONICAL_CATEGORIES = [
  'food',
  'beaches',
  'nightlife',
  'activities',
  'events',
  'places',
  'transport',
  'other',
] as const;

export type CanonicalCategory = typeof CANONICAL_CATEGORIES[number];

// ── Exact-match lookup table ───────────────────────────────────────────────────
// Keys are lowercase raw values (category OR place_type) found in seeded and
// user-submitted rows. Values are canonical Discovery tab identifiers.

const RAW_TO_CANONICAL: Record<string, CanonicalCategory> = {
  // ── food ──────────────────────────────────────────────────────────────────
  food:           'food',
  restaurant:     'food',
  cafe:           'food',
  bistro:         'food',
  bakery:         'food',
  'hawker centre':'food',
  'hawker center':'food',
  'food court':   'food',
  eatery:         'food',
  snack:          'food',
  diner:          'food',
  market:         'food',   // food market (Chatuchak-style treated as food unless shopping context)
  'fast food':    'food',
  'ice cream':    'food',

  // ── beaches ───────────────────────────────────────────────────────────────
  beach:         'beaches',
  beaches:       'beaches',
  'beach club':  'beaches',
  'beach resort':'beaches',
  'surf beach':  'beaches',

  // ── nightlife ─────────────────────────────────────────────────────────────
  nightlife:     'nightlife',
  bar:           'nightlife',
  pub:           'nightlife',
  nightclub:     'nightlife',
  casino:        'nightlife',
  lounge:        'nightlife',
  'cocktail bar':'nightlife',
  'rooftop bar': 'nightlife',
  club:          'nightlife',
  biergarten:    'nightlife',

  // ── activities ────────────────────────────────────────────────────────────
  activities:       'activities',
  activity:         'activities',
  park:             'activities',
  garden:           'activities',
  viewpoint:        'activities',
  'nature reserve': 'activities',
  'natural landmark':'activities',
  volcano:          'activities',
  island:           'activities',
  'water park':     'activities',
  'theme park':     'activities',
  zoo:              'activities',
  aquarium:         'activities',
  marina:           'activities',
  hiking:           'activities',
  sport:            'activities',
  gym:              'activities',
  'fitness centre': 'activities',
  'sports centre':  'activities',
  'swimming pool':  'activities',
  'golf course':    'activities',
  stadium:          'activities',

  // ── events ────────────────────────────────────────────────────────────────
  events:       'events',
  event:        'events',
  museum:       'events',
  gallery:      'events',
  theatre:      'events',
  cinema:       'events',
  'arts centre':'events',
  festival:     'events',
  concert:      'events',
  performance:  'events',
  arena:        'events',
  'concert hall':'events',

  // ── places / landmarks ───────────────────────────────────────────────────
  places:             'places',
  place:              'places',
  attraction:         'places',
  landmark:           'places',
  temple:             'places',
  church:             'places',
  cathedral:          'places',
  mosque:             'places',
  shrine:             'places',
  monument:           'places',
  palace:             'places',
  castle:             'places',
  fort:               'places',
  ruins:              'places',
  'historic district':'places',
  'heritage site':    'places',
  neighborhood:       'places',
  'shopping district':'places',
  'entertainment district':'places',
  mall:               'places',
  shopping:           'places',
  street:             'places',
  square:             'places',

  // ── transport ─────────────────────────────────────────────────────────────
  transport:   'transport',
  transit:     'transport',
  airport:     'transport',
  station:     'transport',
  'bus station':'transport',
  ferry:       'transport',
  metro:       'transport',
  subway:      'transport',
};

/**
 * Map a raw category string and/or place_type string to a canonical Discovery
 * tab category. Checks both fields; if neither matches, returns 'places'.
 *
 * @param rawCategory  The `category` column value (may be null/undefined)
 * @param rawPlaceType The `place_type` column value (may be null/undefined)
 */
export function toCanonicalCategory(
  rawCategory?: string | null,
  rawPlaceType?: string | null,
): CanonicalCategory {
  const normalize = (s?: string | null) =>
    (s ?? '').toLowerCase().trim().replace(/_/g, ' ');

  const cat  = normalize(rawCategory);
  const type = normalize(rawPlaceType);

  // Direct lookup — category field takes precedence
  if (cat  && RAW_TO_CANONICAL[cat])  return RAW_TO_CANONICAL[cat]!;
  if (type && RAW_TO_CANONICAL[type]) return RAW_TO_CANONICAL[type]!;

  // Substring fallbacks for compound/hyphenated strings not in the table
  if (/food|restaurant|cafe|bistro|bakery|eatery|snack|hawker/.test(cat + ' ' + type)) return 'food';
  if (/beach|coast|shore|surf/.test(cat + ' ' + type)) return 'beaches';
  if (/night|club|bar|pub|casino|lounge|cocktail/.test(cat + ' ' + type)) return 'nightlife';
  if (/transport|bus|train|airport|ferry|metro|subway|transit/.test(cat + ' ' + type)) return 'transport';
  if (/museum|gallery|theatre|festival|concert|cinema/.test(cat + ' ' + type)) return 'events';
  if (/park|garden|hik|natur|trail|trek|sport|gym|fitness|pool|aqua|zoo|island/.test(cat + ' ' + type)) return 'activities';

  return 'places';
}

/**
 * Map a Discovery tab category (from the frontend) to the canonical value used
 * in primary_category. They are the same set so this is an identity-with-validation.
 */
export function isValidDiscoveryTab(value: string): boolean {
  return ['for_you', ...CANONICAL_CATEGORIES].includes(value as any);
}
