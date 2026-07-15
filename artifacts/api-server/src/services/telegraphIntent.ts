/**
 * Telegraph intent detection — classifies chat messages for planning signals.
 *
 * Lightweight keyword + pattern matching. Below the confidence threshold
 * returns null so no suggestion card is emitted.
 *
 * Intent types (stable string enum used across backend + DB):
 *   find_place | suggest_activity | create_meetup | add_to_plan |
 *   time_poll | availability_match | nightlife | food |
 *   attraction | beach | transport | general_plan |
 *   layover_activity | layover_food | layover_meetup
 */

export type IntentType =
  | 'find_place'
  | 'suggest_activity'
  | 'create_meetup'
  | 'add_to_plan'
  | 'time_poll'
  | 'availability_match'
  | 'nightlife'
  | 'food'
  | 'attraction'
  | 'beach'
  | 'transport'
  | 'general_plan'
  | 'layover_activity'
  | 'layover_food'
  | 'layover_meetup';

export interface IntentResult {
  intent: IntentType;
  confidence: number; // 0–1
  rawText: string;
}

const THRESHOLD = 0.45;

// Pattern map: each entry has patterns (all lowercased) and a base confidence.
const PATTERNS: Array<{
  intent: IntentType;
  patterns: RegExp[];
  confidence: number;
}> = [
  {
    intent: 'create_meetup',
    confidence: 0.85,
    patterns: [
      /\bmeet\s*up\b/i,
      /\blet'?s\s+meet\b/i,
      /\bwanna\s+meet\b/i,
      /\bwant\s+to\s+meet\b/i,
      /\bget\s+together\b/i,
      /\bcatch\s+up\b/i,
      /\bhang\s+out\b/i,
    ],
  },
  {
    intent: 'time_poll',
    confidence: 0.8,
    patterns: [
      /\bwhen\s+(are|is|can|would)\s+(you|everyone|we)\b/i,
      /\bwhat\s+time\s+(works|is\s+good)\b/i,
      /\bpoll\b/i,
      /\bvote\s+on\s+(a\s+)?time\b/i,
      /\bfree\s+on\b/i,
      /\bavailable\s+(on|this|next)\b/i,
    ],
  },
  {
    intent: 'availability_match',
    confidence: 0.75,
    patterns: [
      /\bwhen\s+are\s+you\s+free\b/i,
      /\bare\s+you\s+free\b/i,
      /\bcheck\s+availability\b/i,
      /\bwhat\s+days\s+(work|are\s+good)\b/i,
      /\bschedule\b/i,
    ],
  },
  {
    intent: 'add_to_plan',
    confidence: 0.8,
    patterns: [
      /\badd\s+(this|it|that)\s+to\s+(the\s+)?plan\b/i,
      /\bput\s+(this|it)\s+in\s+(the\s+)?itinerary\b/i,
      /\badd\s+to\s+(our\s+)?trip\b/i,
      /\bbook\s+(this|it)\b/i,
      /\bshould\s+we\s+add\b/i,
    ],
  },
  {
    intent: 'food',
    confidence: 0.65,
    patterns: [
      /\bwhere\s+(should|can)\s+we\s+eat\b/i,
      /\bgood\s+(restaurants?|food|places?\s+to\s+eat)\b/i,
      /\bwhat'?s\s+(good\s+to\s+eat|good\s+food)\b/i,
      /\bhungry\b/i,
      /\blunch|dinner|breakfast|brunch\b/i,
      /\bfood\s+recommendations?\b/i,
      /\bwhere\s+to\s+eat\b/i,
    ],
  },
  {
    intent: 'nightlife',
    confidence: 0.65,
    patterns: [
      /\bbar\s*hopping\b/i,
      /\bnight\s*life\b/i,
      /\bwhere\s+(to\s+)?drink\b/i,
      /\bbar\s+recommendations?\b/i,
      /\bgood\s+bars?\b/i,
      /\bclub\s*(bing|s)?\b/i,
      /\bcocktail\b/i,
      /\bpub\s*crawl\b/i,
    ],
  },
  {
    intent: 'beach',
    confidence: 0.65,
    patterns: [
      /\bbeach\s+day\b/i,
      /\bgo\s+to\s+the\s+beach\b/i,
      /\bbeach\s+recommendations?\b/i,
      /\bbest\s+beach(es)?\b/i,
      /\bswimming\b/i,
      /\bsnorkel\b/i,
      /\bisland\s+hopping\b/i,
    ],
  },
  {
    intent: 'attraction',
    confidence: 0.6,
    patterns: [
      /\bwhat\s+(should|can)\s+we\s+do\b/i,
      /\bthings?\s+to\s+do\b/i,
      /\bwhat\s+to\s+see\b/i,
      /\bsightsee\b/i,
      /\bmuseums?\b/i,
      /\btemples?\b/i,
      /\blandmarks?\b/i,
      /\bshould\s+we\s+visit\b/i,
    ],
  },
  {
    intent: 'transport',
    confidence: 0.6,
    patterns: [
      /\bhow\s+do\s+we\s+get\b/i,
      /\bget\s+there\b/i,
      /\brides?\s+to\b/i,
      /\bbook\s+a?\s*(taxi|uber|grab|bus|train|flight)\b/i,
      /\btransport(ation)?\b/i,
      /\bhow\s+far\s+is\b/i,
    ],
  },
  // ── Layover intents ──────────────────────────────────────────────────────────
  {
    intent: 'layover_activity',
    confidence: 0.9,
    patterns: [
      /\blayover\b/i,
      /\bstopover\b/i,
      /\bconnecting\s+flight\b/i,
      /\bhours?\s+(at|in)\s+the\s+airport\b/i,
      /\bcan\s+i\s+leave\s+the\s+airport\b/i,
      /\bwhat\s+can\s+i\s+do\s+(at|in|during)\s+(the\s+)?airport\b/i,
      /\bairport\s+layover\b/i,
      /\btransit\s+(visa|time)\b/i,
    ],
  },
  {
    intent: 'layover_food',
    confidence: 0.85,
    patterns: [
      /\beat\s+(at|near|around)\s+the\s+airport\b/i,
      /\bgood\s+(food|restaurant|dining)\s+at\s+the\s+airport\b/i,
      /\blayover\s+(food|lunch|dinner|breakfast)\b/i,
      /\bairport\s+(restaurant|food|eat)\b/i,
    ],
  },
  {
    intent: 'layover_meetup',
    confidence: 0.85,
    patterns: [
      /\bmeet\s+(at|near)\s+the\s+airport\b/i,
      /\blayover\s+meetup\b/i,
      /\bconnect\s+(at|near|during)\s+(my\s+)?layover\b/i,
      /\bcatch\s+up\s+(at|near)\s+the\s+airport\b/i,
    ],
  },

  {
    intent: 'find_place',
    confidence: 0.6,
    patterns: [
      /\bwhere\s+(is|are|can\s+I\s+find)\b/i,
      /\bgood\s+place\s+to\b/i,
      /\brecommend\s+a\s+place\b/i,
      /\bsuggestions?\s+(for|near)\b/i,
      /\bwhere\s+should\s+we\s+go\b/i,
    ],
  },
  {
    intent: 'suggest_activity',
    confidence: 0.55,
    patterns: [
      /\bany\s+(ideas?|suggestions?|recommendations?)\b/i,
      /\bwhat\s+do\s+you\s+recommend\b/i,
      /\bsomething\s+(fun|to\s+do|cool)\b/i,
      /\bideas?\s+for\b/i,
    ],
  },
  {
    intent: 'general_plan',
    confidence: 0.5,
    patterns: [
      /\bplan\s+(for|the|our|this)\b/i,
      /\bitinerary\b/i,
      /\bwhat'?s\s+the\s+plan\b/i,
      /\bwhat\s+are\s+we\s+doing\b/i,
    ],
  },
];

/**
 * Classify a message body. Returns the best intent above the threshold,
 * or null if no strong signal is found.
 */
export function detectIntent(body: string): IntentResult | null {
  if (!body || body.trim().length < 6) return null;

  let best: IntentResult | null = null;

  for (const entry of PATTERNS) {
    for (const re of entry.patterns) {
      if (re.test(body)) {
        const candidate: IntentResult = {
          intent: entry.intent,
          confidence: entry.confidence,
          rawText: body.trim(),
        };
        if (!best || candidate.confidence > best.confidence) {
          best = candidate;
        }
        break; // one pattern match per intent entry is enough
      }
    }
  }

  if (!best || best.confidence < THRESHOLD) return null;
  return best;
}
