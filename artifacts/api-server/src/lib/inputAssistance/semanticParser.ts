/**
 * Deterministic Semantic Query Parser (Phase 6 — Semantic Intent, spec §18/§19).
 *
 * Turns a natural-language query into a STRUCTURED `ParsedIntent`:
 *
 *   "rooftop bar near my hotel tonight"
 *     → category=rooftop_bar, relationship=near, anchor=current_hotel, temporal=tonight
 *   "food then somewhere busy"
 *     → stage_1=food, stage_2={busy}, sequence=true
 *
 * DETERMINISM IS A HARD CONSTRAINT (§2, §18). This is a rule + dictionary parser
 * — NO model call in the hot path. A deterministic parser is predictable, cannot
 * hallucinate an intent the user did not express, and produces the same
 * structured value for the same text every time. (An LLM shadow classifier
 * already exists — CompassIntentClassifier — but it is kept OUT of this path
 * precisely because it can hallucinate and is non-deterministic; see
 * semanticIntent.ts for the note on why productionizing it here is declined.)
 *
 * The parser REUSES the existing pocket parsers rather than reimplementing them:
 *   - `parseTimeIntent` (routes/discoverySearchHelpers) for the tonight /
 *     tomorrow / this-weekend / next-week windows (tz-aware),
 * and ADDS the operators §18 requires that those pockets lacked: the extended
 * temporal operators (tomorrow morning / Friday after dinner / in 2h / on
 * arrival), the geographic anchor + relationship operators (near my hotel /
 * between us / along the way / near our meeting point / close to airport), the
 * experience qualifiers (quiet/social/luxury/cheap/local/hidden/busy/romantic/
 * high-energy), and the sequence operators (then/after/before/next).
 *
 * Everything here is PURE (no I/O). Resolving a parsed place anchor or an
 * add-to-trip destination to a canonical entity is done by the async
 * orchestrator (semanticIntent.ts) so this module stays trivially testable and
 * side-effect-free.
 */
import { parseTimeIntent } from '../../routes/discoverySearchHelpers';

// ── Public shape ──────────────────────────────────────────────────────────────

/** Experience qualifiers §18 recognizes (canonical slugs). */
export type ExperienceQualifier =
  | 'quiet'
  | 'social'
  | 'luxury'
  | 'cheap'
  | 'local'
  | 'hidden'
  | 'busy'
  | 'romantic'
  | 'high_energy';

/** §18 geographic/relationship operator classes (how the subject relates to an anchor). */
export type Relationship = 'near' | 'between' | 'along' | 'with_crew' | 'followed';

/**
 * The object a `near`/`close-to` relationship points at. Symbolic anchors
 * (current_location / current_hotel / meeting_point / airport) are resolved
 * CLIENT-side to the live coordinate; a `place` anchor carries free text the
 * orchestrator resolves against the canonical city registry.
 */
export type Anchor =
  | { kind: 'current_location' }
  | { kind: 'current_hotel' }
  | { kind: 'meeting_point' }
  | { kind: 'airport' }
  | { kind: 'place'; text: string };

/** A normalized temporal window (§18 temporal operators). */
export interface TemporalIntent {
  /** tonight | tomorrow | tomorrow_morning | this_weekend | next_week | weekday | in_hours | on_arrival */
  type: string;
  label: string;
  /** ISO 8601 UTC lower bound, or null when the window is not yet knowable (on_arrival). */
  startsAfter: string | null;
  /** ISO 8601 UTC upper bound (exclusive), or null. */
  startsBefore: string | null;
  /** True when the time is symbolic and resolved later (e.g. "when we arrive"). */
  deferred?: boolean;
}

/** One stage of a sequenced query ("food" → "somewhere busy"). */
export interface StageIntent {
  /** 1-based position in the sequence. */
  index: number;
  raw: string;
  category?: string;
  experienceQualifiers: ExperienceQualifier[];
  /** The residual search subject after operators are removed. */
  residualText: string;
}

export type OperatorClass =
  | 'category'
  | 'experience'
  | 'temporal'
  | 'relationship'
  | 'anchor'
  | 'sequence';

export interface ParsedIntent {
  /** The user's ORIGINAL text, preserved verbatim (§2 — never silently replaced). */
  raw: string;
  /** Primary residual subject (stage 1 for a sequence; the whole otherwise). */
  residualText: string;

  category?: string;
  experienceQualifiers: ExperienceQualifier[];
  relationship?: Relationship;
  anchor?: Anchor;
  temporal?: TemporalIntent;

  /** §18: true when the query describes an ordered sequence of stages. */
  sequence: boolean;
  /** stage_1, stage_2, … Always present; length ≥ 2 iff `sequence`. */
  stages: StageIntent[];

  /** 0..1 — how confidently the text became structure. Feeds the §19 bands. */
  confidence: number;
  /** Which operator classes fired (union across stages). */
  matchedOperators: OperatorClass[];
}

/** A recognized §21 smart action ("add Bangkok to my trip"). */
export type SmartAction = { kind: 'add_to_trip'; destinationText: string };

// ── Tunables ──────────────────────────────────────────────────────────────────

/**
 * §19 confidence bands. A parse must reach at least MEDIUM to produce a
 * structured suggestion; LOW/VERY_LOW preserve the raw query (§2 — never
 * auto-replace). With the additive weights below this means a bare category
 * keyword alone (weak) never overrides the raw search — it takes a category PLUS
 * a modifier (experience / anchor / time / sequence), a clear intent signal.
 */
export const SEMANTIC_MIN_CONFIDENCE = 0.6;
const HIGH_CONFIDENCE = 0.85;
const LOW_CONFIDENCE = 0.35;

// ── Dictionaries (order matters: multiword phrases MUST precede their parts) ────

// category slug ← trigger phrases. Longest/most-specific first so "rooftop bar"
// beats a bare "bar", "coffee shop" beats "shop", etc.
const CATEGORY_RULES: Array<{ re: RegExp; category: string }> = [
  { re: /\brooftop\s+bars?\b/, category: 'rooftop_bar' },
  { re: /\bsky\s?bars?\b/, category: 'rooftop_bar' },
  { re: /\bcocktail\s+bars?\b/, category: 'cocktail_bar' },
  { re: /\bwine\s+bars?\b/, category: 'wine_bar' },
  { re: /\bsports\s+bars?\b/, category: 'sports_bar' },
  { re: /\bbeach\s+clubs?\b/, category: 'beach_club' },
  { re: /\bnight\s?clubs?\b/, category: 'nightclub' },
  { re: /\bcoffee\s+shops?\b/, category: 'cafe' },
  { re: /\bstreet\s+food\b/, category: 'street_food' },
  { re: /\bfine\s+dining\b/, category: 'restaurant' },
  { re: /\bfood\s+courts?\b/, category: 'food_court' },
  { re: /\blive\s+music\b/, category: 'live_music' },
  { re: /\brooftops?\b/, category: 'rooftop_bar' },
  { re: /\brestaurants?\b/, category: 'restaurant' },
  { re: /\b(?:food|eat|dinner|lunch|brunch|breakfast|somewhere\s+to\s+eat)\b/, category: 'food' },
  { re: /\bcaf[eé]s?\b/, category: 'cafe' },
  { re: /\bcoffee\b/, category: 'cafe' },
  { re: /\b(?:bars?|drinks?|cocktails?|pub)\b/, category: 'bar' },
  { re: /\b(?:clubs?|clubbing|dancing)\b/, category: 'nightclub' },
  { re: /\bbeach(?:es)?\b/, category: 'beach' },
  { re: /\bmuseums?\b/, category: 'museum' },
  { re: /\bparks?\b/, category: 'park' },
  { re: /\bmarkets?\b/, category: 'market' },
  { re: /\bspas?\b/, category: 'spa' },
  { re: /\bviewpoints?\b/, category: 'viewpoint' },
  { re: /\bnightlife\b/, category: 'nightlife' },
];

// experience qualifier ← trigger phrases. Multiword first.
const EXPERIENCE_RULES: Array<{ re: RegExp; qualifier: ExperienceQualifier }> = [
  { re: /\bhigh[\s-]?energy\b/, qualifier: 'high_energy' },
  { re: /\boff\s+the\s+beaten\s+path\b/, qualifier: 'hidden' },
  { re: /\bhidden\s+gems?\b/, qualifier: 'hidden' },
  { re: /\bdate\s+night\b/, qualifier: 'romantic' },
  { re: /\blow[\s-]?key\b/, qualifier: 'quiet' },
  { re: /\bhigh[\s-]?end\b/, qualifier: 'luxury' },
  { re: /\b(?:quiet|chill|calm|mellow|peaceful|relaxed|laid[\s-]?back)\b/, qualifier: 'quiet' },
  { re: /\b(?:social|lively|sociable|buzzing)\b/, qualifier: 'social' },
  { re: /\b(?:luxury|luxurious|upscale|fancy|posh|classy|swanky)\b/, qualifier: 'luxury' },
  { re: /\b(?:cheap|budget|affordable|inexpensive|low[\s-]?cost)\b/, qualifier: 'cheap' },
  { re: /\b(?:local|authentic|traditional)\b/, qualifier: 'local' },
  { re: /\b(?:hidden|secret|undiscovered|under[\s-]?the[\s-]?radar)\b/, qualifier: 'hidden' },
  { re: /\b(?:busy|packed|crowded|bustling|happening|hopping)\b/, qualifier: 'busy' },
  { re: /\b(?:romantic|intimate|cozy|cosy)\b/, qualifier: 'romantic' },
  { re: /\b(?:energetic|wild|party|pumping|rowdy)\b/, qualifier: 'high_energy' },
];

// Fillers dropped from a residual subject so "somewhere to eat" → "" not "somewhere".
const FILLER_RE =
  /\b(?:some|somewhere|someplace|a|an|the|to|for|go|going|find|show|me|us|i|we|want|wanna|looking|look|need|nice|good|cool|great|place|places|spot|spots|option|options|get|grab|do|where|near|around|any|please)\b/g;

// ── Local clock (mirrors parseTimeIntent's tz-offset math) ─────────────────────

interface LocalClock {
  localNow: Date;
  localMidnight: number;
  toUtc: (localMs: number) => string;
}

function localClock(tz?: string | null): LocalClock {
  const now = new Date();
  let tzOffsetMs = 0;
  if (tz) {
    try {
      const fmt = (zone: string) => now.toLocaleString('en-US', { timeZone: zone, hour12: false });
      tzOffsetMs = new Date(fmt(tz)).getTime() - new Date(fmt('UTC')).getTime();
    } catch {
      tzOffsetMs = 0;
    }
  }
  const localNow = new Date(now.getTime() + tzOffsetMs);
  const localMidnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  const toUtc = (localMs: number) => new Date(localMs - tzOffsetMs).toISOString();
  return { localNow, localMidnight, toUtc };
}

const HOUR = 3600_000;

// time-of-day → [startHour, endHour] within a local day.
const TIME_OF_DAY: Array<{ re: RegExp; window: [number, number]; word: string }> = [
  { re: /\bafter\s+dinner\b/, window: [20, 24], word: 'after dinner' },
  { re: /\bafter\s+lunch\b/, window: [13, 16], word: 'after lunch' },
  { re: /\bfor\s+lunch\b/, window: [12, 15], word: 'for lunch' },
  { re: /\bfor\s+dinner\b/, window: [18, 22], word: 'for dinner' },
  { re: /\bfor\s+brunch\b/, window: [10, 14], word: 'for brunch' },
  { re: /\bbrunch\b/, window: [10, 14], word: 'brunch' },
  { re: /\bmorning\b/, window: [6, 12], word: 'morning' },
  { re: /\bafternoon\b/, window: [12, 17], word: 'afternoon' },
  { re: /\bevening\b/, window: [18, 24], word: 'evening' },
  { re: /\bnight\b/, window: [20, 24], word: 'night' },
];

const WEEKDAYS: Array<{ re: RegExp; dow: number; name: string }> = [
  { re: /\b(?:monday|mon)\b/, dow: 1, name: 'Monday' },
  { re: /\b(?:tuesday|tues|tue)\b/, dow: 2, name: 'Tuesday' },
  { re: /\b(?:wednesday|weds|wed)\b/, dow: 3, name: 'Wednesday' },
  { re: /\b(?:thursday|thurs|thur|thu)\b/, dow: 4, name: 'Thursday' },
  { re: /\b(?:friday|fri)\b/, dow: 5, name: 'Friday' },
  { re: /\b(?:saturday|sat)\b/, dow: 6, name: 'Saturday' },
  { re: /\b(?:sunday|sun)\b/, dow: 0, name: 'Sunday' },
];

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, couple: 2, few: 3,
};

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function collapse(s: string): string {
  return s.replace(/\s{2,}/g, ' ').trim();
}

// ── Temporal extraction (§18) ──────────────────────────────────────────────────

/**
 * Extract ONE temporal operator and normalize it to a UTC window where possible.
 * Checks the extended operators FIRST (so "tomorrow morning" is not swallowed by
 * the bare "tomorrow" rule), then delegates the classic four to the reused
 * `parseTimeIntent`.
 */
export function extractTemporal(
  text: string,
  tz?: string | null,
): { intent: TemporalIntent | null; stripped: string } {
  let work = text;

  // "when we arrive" / "on arrival" — symbolic, resolved on arrival (no window).
  const arrivalRe = /\b(?:when\s+(?:we|i)\s+(?:arrive|get\s+there|land|get\s+in)|on\s+arrival|once\s+we\s+arrive|after\s+we\s+land)\b/;
  if (arrivalRe.test(work)) {
    return {
      intent: { type: 'on_arrival', label: 'When you arrive', startsAfter: null, startsBefore: null, deferred: true },
      stripped: collapse(work.replace(arrivalRe, ' ')),
    };
  }

  // "in two hours" / "in 2h" — relative offset from now.
  const inHoursRe = /\bin\s+(\d{1,2}|a|an|one|two|three|four|five|six|couple|few)\s*(?:hours?|hrs?|h)\b/;
  const mHours = work.match(inHoursRe);
  if (mHours) {
    const token = mHours[1]!.toLowerCase();
    const n = /^\d+$/.test(token) ? parseInt(token, 10) : (NUMBER_WORDS[token] ?? 1);
    const nowMs = Date.now();
    return {
      intent: {
        type: 'in_hours',
        label: `In ${n} ${n === 1 ? 'hour' : 'hours'}`,
        startsAfter: new Date(nowMs + n * HOUR).toISOString(),
        // A 1-hour arrival window around the target time.
        startsBefore: new Date(nowMs + (n + 1) * HOUR).toISOString(),
      },
      stripped: collapse(work.replace(inHoursRe, ' ')),
    };
  }

  const clock = localClock(tz);

  // "tomorrow morning|afternoon|evening|night".
  const tomTod = work.match(/\btomorrow\s+(morning|afternoon|evening|night)\b/);
  if (tomTod) {
    const tod = TIME_OF_DAY.find((t) => t.word === tomTod[1]!.toLowerCase());
    const [s, e] = tod ? tod.window : [0, 24];
    const base = clock.localMidnight + 24 * HOUR;
    return {
      intent: {
        type: 'tomorrow_morning',
        label: `Tomorrow ${tomTod[1]!.toLowerCase()}`,
        startsAfter: clock.toUtc(base + s * HOUR),
        startsBefore: clock.toUtc(base + e * HOUR),
      },
      stripped: collapse(work.replace(/\btomorrow\s+(?:morning|afternoon|evening|night)\b/, ' ')),
    };
  }

  // Weekday (+ optional time-of-day): "Friday after dinner", "Saturday night".
  for (const wd of WEEKDAYS) {
    if (!wd.re.test(work)) continue;
    let stripped = work.replace(wd.re, ' ');
    let s = 0;
    let e = 24;
    let todWord = '';
    for (const tod of TIME_OF_DAY) {
      if (tod.re.test(stripped)) {
        [s, e] = tod.window;
        todWord = tod.word;
        stripped = stripped.replace(tod.re, ' ');
        break;
      }
    }
    const dowNow = clock.localNow.getUTCDay();
    const daysUntil = (wd.dow - dowNow + 7) % 7; // 0 = today
    const base = clock.localMidnight + daysUntil * 24 * HOUR;
    return {
      intent: {
        type: 'weekday',
        label: todWord ? `${wd.name} ${todWord}` : wd.name,
        startsAfter: clock.toUtc(base + s * HOUR),
        startsBefore: clock.toUtc(base + e * HOUR),
      },
      stripped: collapse(stripped),
    };
  }

  // Classic four (tonight / tomorrow / this weekend / next week) — reuse the
  // existing tz-aware window parser rather than reimplement its date math.
  const base = parseTimeIntent(work, tz);
  if (base.intent) {
    return {
      intent: {
        type: base.intent.type,
        label: base.intent.label,
        startsAfter: base.intent.startsAfter,
        startsBefore: base.intent.startsBefore,
      },
      stripped: collapse(base.strippedQuery),
    };
  }

  return { intent: null, stripped: work };
}

// ── Geographic / relationship extraction (§18) ─────────────────────────────────

/**
 * Extract the relationship operator (near/between/along/with-crew/followed) and
 * the anchor (current_location/current_hotel/meeting_point/airport/place).
 * Combined "proximity + explicit anchor" phrases are matched first so
 * "near my hotel" resolves the hotel anchor rather than a stray place capture.
 */
export function extractGeo(
  text: string,
): { relationship?: Relationship; anchor?: Anchor; stripped: string } {
  let work = text;
  let relationship: Relationship | undefined;
  let anchor: Anchor | undefined;
  const strip = (re: RegExp) => {
    work = collapse(work.replace(re, ' '));
  };

  // 1. proximity + explicit symbolic anchor.
  const HOTEL = /\b(?:near|close\s+to|next\s+to|by|around)\s+(?:my|our|the)\s+(?:hotel|accommodation|airbnb|hostel|guest\s?house|room|stay)\b/;
  const AIRPORT = /\b(?:near|close\s+to|next\s+to|by|around)\s+(?:the\s+|our\s+|a\s+)?airport\b/;
  const MEETING = /\b(?:near|close\s+to|by|around)\s+(?:our|the|a)\s+meeting\s+(?:point|spot|place)\b/;
  const HERE = /\b(?:near|around|close\s+to)\s+(?:me|here|my\s+location|where\s+i\s+am)\b/;
  const combined: Array<{ re: RegExp; anchor: Anchor }> = [
    { re: HOTEL, anchor: { kind: 'current_hotel' } },
    { re: AIRPORT, anchor: { kind: 'airport' } },
    { re: MEETING, anchor: { kind: 'meeting_point' } },
    { re: HERE, anchor: { kind: 'current_location' } },
  ];
  for (const c of combined) {
    if (c.re.test(work)) {
      relationship = relationship ?? 'near';
      anchor = anchor ?? c.anchor;
      strip(c.re);
    }
  }

  // 2. bare proximity keywords ("nearby", "near me" already covered).
  if (/\bnearby\b/.test(work)) {
    relationship = relationship ?? 'near';
    anchor = anchor ?? { kind: 'current_location' };
    strip(/\bnearby\b/);
  }

  // 3. relationship-only operators.
  if (!relationship && /\bbetween\s+us\b|\bhalfway\b|\bmidway\b|\bbetween\s+me\s+and\b/.test(work)) {
    relationship = 'between';
    strip(/\bbetween\s+us\b|\bhalfway\b|\bmidway\b|\bbetween\s+me\s+and\b/);
  }
  if (!relationship && /\balong\s+the\s+way\b|\bon\s+the\s+way\b|\balong\s+our\s+route\b/.test(work)) {
    relationship = 'along';
    strip(/\balong\s+the\s+way\b|\bon\s+the\s+way\b|\balong\s+our\s+route\b/);
  }
  if (!relationship && /\bwith\s+(?:my\s+|the\s+)?(?:trip\s+)?crew\b|\bwith\s+my\s+(?:friends|group|people|travel\s+buddies)\b/.test(work)) {
    relationship = 'with_crew';
    strip(/\bwith\s+(?:my\s+|the\s+)?(?:trip\s+)?crew\b|\bwith\s+my\s+(?:friends|group|people|travel\s+buddies)\b/);
  }
  if (!relationship && /\b(?:people|places|spots)\s+i\s+follow\b|\bwho\s+i\s+follow\b|\bpeople\s+i(?:'m| am)?\s+following\b/.test(work)) {
    relationship = 'followed';
    strip(/\b(?:people|places|spots)\s+i\s+follow\b|\bwho\s+i\s+follow\b|\bpeople\s+i(?:'m| am)?\s+following\b/);
  }

  // 4. standalone explicit anchor without a proximity word ("my hotel bar").
  if (!anchor && /\b(?:my|our|the)\s+(?:hotel|accommodation|airbnb|hostel|room)\b/.test(work)) {
    anchor = { kind: 'current_hotel' };
    strip(/\b(?:my|our|the)\s+(?:hotel|accommodation|airbnb|hostel|room)\b/);
  }
  if (!anchor && /\b(?:our|the)\s+meeting\s+(?:point|spot|place)\b/.test(work)) {
    anchor = { kind: 'meeting_point' };
    strip(/\b(?:our|the)\s+meeting\s+(?:point|spot|place)\b/);
  }

  // 5. generic "near <place text>" — free text the orchestrator resolves to a
  //    canonical city. Lowest priority; only when no anchor was found.
  if (!anchor) {
    const m = work.match(/\b(?:near|close\s+to|next\s+to|around)\s+([a-z][a-z' -]{1,40}?)(?:\s*$|,)/);
    if (m && m[1]) {
      const placeText = collapse(m[1]);
      if (placeText.length >= 2) {
        relationship = relationship ?? 'near';
        anchor = { kind: 'place', text: placeText };
        strip(/\b(?:near|close\s+to|next\s+to|around)\s+[a-z][a-z' -]{1,40}?(?:\s*$|,)/);
      }
    }
  }

  return { relationship, anchor, stripped: work };
}

// ── Category + experience extraction (per stage) ───────────────────────────────

export function extractCategoryExperience(text: string): {
  category?: string;
  experienceQualifiers: ExperienceQualifier[];
  residualText: string;
} {
  let work = ` ${text.toLowerCase()} `;
  const qualifiers: ExperienceQualifier[] = [];

  for (const rule of EXPERIENCE_RULES) {
    if (rule.re.test(work)) {
      if (!qualifiers.includes(rule.qualifier)) qualifiers.push(rule.qualifier);
      work = work.replace(new RegExp(rule.re.source, 'g'), ' ');
    }
  }

  let category: string | undefined;
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(work)) {
      category = rule.category;
      work = work.replace(new RegExp(rule.re.source, 'g'), ' ');
      break;
    }
  }

  const residualText = collapse(work.replace(FILLER_RE, ' '));
  return { category, experienceQualifiers: qualifiers, residualText };
}

// ── Sequence splitting (§18) ───────────────────────────────────────────────────

// then / and then / after that / next / before / followed by. Bare "after" is
// intentionally NOT a splitter — the temporal pass already consumed "after
// dinner" etc., and a lone "after" is too ambiguous to split on deterministically.
const SEQUENCE_SPLIT_RE = /\b(?:and\s+then|then|after\s+that|afterwards?|followed\s+by|next|before)\b/g;

export function splitSequence(text: string): string[] {
  const parts = text
    .split(SEQUENCE_SPLIT_RE)
    .map((p) => collapse(p))
    .filter((p) => p.length > 0);
  return parts;
}

// ── Confidence ─────────────────────────────────────────────────────────────────

function scoreConfidence(input: {
  hasCategory: boolean;
  qualifierCount: number;
  hasRelationship: boolean;
  hasAnchor: boolean;
  hasTemporal: boolean;
  sequence: boolean;
}): number {
  let s = 0;
  if (input.hasCategory) s += 0.45;
  s += Math.min(input.qualifierCount, 2) * 0.18;
  if (input.hasRelationship) s += 0.18;
  if (input.hasAnchor) s += 0.22;
  if (input.hasTemporal) s += 0.2;
  if (input.sequence) s += 0.4;
  return Math.max(0, Math.min(1, s));
}

// ── Main parse ─────────────────────────────────────────────────────────────────

/**
 * Parse natural-language text into a structured `ParsedIntent`. Pure and
 * deterministic. `opts.tz` (IANA zone) makes temporal windows local; without it
 * windows are computed in UTC (still valid, just offset).
 */
export function parseSemanticIntent(text: string, opts: { tz?: string | null } = {}): ParsedIntent {
  const raw = (text ?? '').trim();
  const lower = raw.toLowerCase();

  // 1. temporal (whole query).
  const temp = extractTemporal(lower, opts.tz);
  // 2. geographic relationship + anchor (whole query).
  const geo = extractGeo(temp.stripped);
  // 3. sequence split on the residual.
  const segments = splitSequence(geo.stripped);
  const sequence = segments.length >= 2;
  const stageTexts = segments.length > 0 ? segments : [geo.stripped];

  // 4. per-stage category + experience.
  const stages: StageIntent[] = stageTexts.map((segText, i) => {
    const ce = extractCategoryExperience(segText);
    return {
      index: i + 1,
      raw: segText,
      category: ce.category,
      experienceQualifiers: ce.experienceQualifiers,
      residualText: ce.residualText,
    };
  });

  const primary = stages[0]!;

  // Union of signals across stages (a busy stage-2 still counts toward intent).
  const anyCategory = stages.some((s) => s.category != null);
  const qualifierUnion = new Set<ExperienceQualifier>();
  for (const s of stages) for (const q of s.experienceQualifiers) qualifierUnion.add(q);

  const matchedOperators: OperatorClass[] = [];
  if (anyCategory) matchedOperators.push('category');
  if (qualifierUnion.size > 0) matchedOperators.push('experience');
  if (temp.intent) matchedOperators.push('temporal');
  if (geo.relationship) matchedOperators.push('relationship');
  if (geo.anchor) matchedOperators.push('anchor');
  if (sequence) matchedOperators.push('sequence');

  const confidence = scoreConfidence({
    hasCategory: anyCategory,
    qualifierCount: qualifierUnion.size,
    hasRelationship: geo.relationship != null,
    hasAnchor: geo.anchor != null,
    hasTemporal: temp.intent != null,
    sequence,
  });

  const parsed: ParsedIntent = {
    raw,
    residualText: primary.residualText,
    experienceQualifiers: primary.experienceQualifiers,
    sequence,
    stages,
    confidence,
    matchedOperators,
  };
  if (primary.category) parsed.category = primary.category;
  if (geo.relationship) parsed.relationship = geo.relationship;
  if (geo.anchor) parsed.anchor = geo.anchor;
  if (temp.intent) parsed.temporal = temp.intent;
  return parsed;
}

// ── §19 band + projection gate ─────────────────────────────────────────────────

export function confidenceBand(confidence: number): 'high' | 'medium' | 'low' | 'very_low' {
  if (confidence >= HIGH_CONFIDENCE) return 'high';
  if (confidence >= SEMANTIC_MIN_CONFIDENCE) return 'medium';
  if (confidence >= LOW_CONFIDENCE) return 'low';
  return 'very_low';
}

/**
 * §2/§19 GATE: may this parse produce a STRUCTURED suggestion, or must the raw
 * query be preserved untouched? Only a MEDIUM+ parse (≥ SEMANTIC_MIN_CONFIDENCE)
 * augments; LOW/VERY_LOW ⇒ preserve raw, never auto-replace. Forcing this to
 * true unconditionally is the mutation the raw-preserved tests catch.
 */
export function shouldProjectStructured(parsed: ParsedIntent): boolean {
  return parsed.confidence >= SEMANTIC_MIN_CONFIDENCE;
}

// ── §21 smart action recognition ───────────────────────────────────────────────

const ADD_TO_TRIP_RES: RegExp[] = [
  /\badd\s+(.+?)\s+to\s+(?:my|the|our)\s+trip\b/i,
  /\badd\s+(.+?)\s+to\s+trip\b/i,
  /\badd\s+destination\s+(.+)$/i,
];

/**
 * Recognize a §21 smart action phrase. Deterministic; returns null when nothing
 * matches. The destination text is resolved to a canonical entity by the
 * orchestrator, and the resulting action is PROPOSE-ONLY — it executes behind
 * the target endpoint's own authorization (§47).
 */
export function parseSmartAction(text: string): SmartAction | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  for (const re of ADD_TO_TRIP_RES) {
    const m = raw.match(re);
    if (m && m[1]) {
      const destinationText = collapse(m[1].replace(/["']/g, ''));
      if (destinationText.length >= 2 && destinationText.length <= 80) {
        return { kind: 'add_to_trip', destinationText };
      }
    }
  }
  return null;
}
