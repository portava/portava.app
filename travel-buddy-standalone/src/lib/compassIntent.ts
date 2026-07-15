/**
 * Deterministic search intent parser — no AI, no network.
 *
 * Takes a raw query string and returns a structured intent object using
 * word-boundary keyword matching. Used to boost/filter search results
 * and surface the "Compass understood" summary pill.
 */

export interface SearchIntent {
  timeSignal?: 'tonight' | 'tomorrow' | 'this_weekend';
  category?: 'nightlife' | 'food' | 'beach' | 'adventure' | 'culture';
  locationHint?: string;
  social?: 'solo' | 'group' | 'crew';
  safetyBoost?: boolean;
}

// Representative city list — used for location-hint extraction.
// Word-boundary matching prevents partial false positives (e.g. "bar" in "Barcelona").
const KNOWN_CITIES: string[] = [
  'cebu', 'manila', 'davao', 'makati', 'palawan', 'boracay',
  'bali', 'bangkok', 'chiang mai', 'phuket', 'hong kong', 'singapore',
  'tokyo', 'osaka', 'kyoto', 'seoul', 'busan', 'taipei',
  'paris', 'london', 'berlin', 'amsterdam', 'rome', 'barcelona',
  'lisbon', 'madrid', 'vienna', 'prague', 'budapest', 'athens',
  'dubai', 'istanbul', 'cairo', 'nairobi', 'cape town', 'marrakech',
  'new york', 'los angeles', 'miami', 'chicago', 'toronto', 'vancouver',
  'sydney', 'melbourne', 'auckland',
];

function wb(pattern: string): RegExp {
  return new RegExp(`\\b${pattern}\\b`, 'i');
}

/**
 * Parse a raw search query into a structured intent object.
 * Returns an empty object when the query is blank or under 2 chars.
 * Pure function — no side effects, no network calls.
 */
export function parseSearchIntent(query: string): SearchIntent {
  if (!query || query.trim().length < 2) return {};
  const q = query.trim();
  const intent: SearchIntent = {};

  // ── Time signals ────────────────────────────────────────────────────────
  if (wb('tonight').test(q)) {
    intent.timeSignal = 'tonight';
  } else if (wb('tomorrow').test(q)) {
    intent.timeSignal = 'tomorrow';
  } else if (/\bthis\s+weekend\b|\bweekend\b/i.test(q)) {
    intent.timeSignal = 'this_weekend';
  }

  // ── Category signals ─────────────────────────────────────────────────────
  // Nightlife is tested first so "bar" doesn't bleed into food category.
  if (/\b(nightlife|bars?|clubs?|party|parties|clubbing|lounge|pub)\b/i.test(q)) {
    intent.category = 'nightlife';
  } else if (/\b(food|eat|eats|restaurant|cafe|dining|brunch|dinner|lunch|cuisine|street food)\b/i.test(q)) {
    intent.category = 'food';
  } else if (/\b(beach|beaches|ocean|coast|island|islands|snorkel|swim|sea)\b/i.test(q)) {
    intent.category = 'beach';
  } else if (/\b(hiking?|trekking?|trek|climb(?:ing)?|surf(?:ing)?|diving?|adventure|outdoor|nature|kayaking?|biking?|rafting?)\b/i.test(q)) {
    intent.category = 'adventure';
  } else if (/\b(museum|gallery|galleries|temple|churches?|culture|cultural|art|historic|history|landmark|heritage)\b/i.test(q)) {
    intent.category = 'culture';
  }

  // ── Social signals ───────────────────────────────────────────────────────
  if (/\b(solo|alone|by myself|just me|traveling alone)\b/i.test(q)) {
    intent.social = 'solo';
  } else if (/\b(crew|squad|group trip)\b/i.test(q)) {
    intent.social = 'crew';
  } else if (/\b(group|with friends|friends)\b/i.test(q)) {
    intent.social = 'group';
  }

  // ── Safety boost ─────────────────────────────────────────────────────────
  if (/\b(safe|safety|secure|verified|trusted)\b/i.test(q)) {
    intent.safetyBoost = true;
  }

  // ── Location hint ────────────────────────────────────────────────────────
  // Scan the known city list. Multi-word cities are checked before single-word
  // entries to avoid early single-word matches (e.g. "new" before "new york").
  const lower = q.toLowerCase();
  const sorted = [...KNOWN_CITIES].sort((a, b) => b.length - a.length);
  for (const city of sorted) {
    // Require word boundaries on each word of the city name to avoid false
    // positives (e.g. "in" should not match "singapore" → "in").
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(q)) {
      intent.locationHint = city
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      break;
    }
  }

  return intent;
}

/**
 * Returns a short, human-readable summary of the detected intent or null
 * when no meaningful signal was found.
 *
 * Example outputs:
 *   "nightlife tonight in Cebu"
 *   "beach · solo"
 *   "food this weekend"
 */
export function intentSummary(intent: SearchIntent): string | null {
  const parts: string[] = [];

  if (intent.category)    parts.push(intent.category.replace('_', ' '));
  if (intent.timeSignal)  parts.push(intent.timeSignal.replace(/_/g, ' '));
  if (intent.locationHint) parts.push(`in ${intent.locationHint}`);
  if (intent.social)      parts.push(`· ${intent.social}`);
  if (intent.safetyBoost) parts.push('· verified');

  return parts.length > 0 ? parts.join(' ') : null;
}
