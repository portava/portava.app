/**
 * gemStateDisplay — the client-side presentation layer for Hidden Gem
 * Intelligence (Media v2 Phase 8, §16 / §16.2 / §16.3 / §46.1).
 *
 * PURE + DETERMINISTIC. This module maps the backend's semantic signals — the
 * ten-state `gemState`, the numeric+band `gemConfidence`, and the nine
 * structured contribution types — onto the calm, PROTECTIVE display language
 * the spec mandates. It reads no database, clock, env, or network, so the whole
 * mapping is unit-testable and free of the forbidden hype vocabulary.
 *
 * Hard rules baked in here (so a diff shows any regression):
 *
 *   • §16.2 / §46.1 — NEVER popularity-first. No Viral / Trending / Hot /
 *     vanity-counter language anywhere. `assertNoHypeLanguage` + the exported
 *     `FORBIDDEN_HYPE_WORDS` set let a test pin this to every label we ship.
 *
 *   • §16.2 — a fragile / overcrowded gem is treated PROTECTIVELY. The
 *     `overcrowding_risk` state carries a "consider another time" note and a
 *     calming (not enticing) tone — never "packed", "buzzing", or a headcount.
 *
 *   • Confidence is a CALM evidence indicator ("Strong signal" / "Emerging"),
 *     not a popularity or vanity metric. It is derived from the backend band,
 *     never from save/visit counts (those never reach the client here).
 *
 *   • Degrade: a missing `gemState` / `gemConfidence` (older payload) maps to
 *     `null`, so callers render exactly as they do today and never throw.
 */

// ── The ten-state semantic enum (§16), mirrored from the backend contract ─────
// (artifacts/api-server/src/lib/hiddenGemState.ts HIDDEN_GEM_STATES). Kept in
// sync by the exhaustive-coverage test, which fails if a state is added or
// dropped without a matching label + treatment.

export const GEM_STATES = [
  'recently_confirmed',
  'still_hidden',
  'quiet_now',
  'getting_discovered',
  'seasonal',
  'hard_to_find',
  'access_changed',
  'temporarily_unavailable',
  'overcrowding_risk',
  'no_longer_hidden',
] as const;

export type GemState = (typeof GEM_STATES)[number];

// ── The nine structured contribution types (§16.3) ───────────────────────────

export const GEM_CONTRIBUTION_TYPES = [
  'still_here',
  'still_worth_it',
  'access_changed',
  'closed',
  'too_crowded',
  'seasonal',
  'harder_to_reach',
  'better_entrance',
  'no_longer_hidden',
] as const;

export type GemContributionType = (typeof GEM_CONTRIBUTION_TYPES)[number];

// ── Confidence bands, mirrored from lib/intelContracts.ts CONFIDENCE_BANDS ────

export const GEM_CONFIDENCE_BANDS = [
  'unverified',
  'provisional',
  'likely_current',
  'live',
  'strong',
] as const;

export type GemConfidenceBand = (typeof GEM_CONFIDENCE_BANDS)[number];

export interface GemConfidence {
  score: number;
  band: string;
}

// ── Tone → a calm, protective semantic role (never a hype colour) ─────────────
// Callers map a tone to a concrete colour. Tones are deliberately gentle:
// `protective` is the fragile/overcrowded signal and must read as "care", not
// "alarm" or "excitement".

export type GemTone = 'confirmed' | 'hidden' | 'calm' | 'aware' | 'caution' | 'protective';

export interface GemStateTreatment {
  state: GemState;
  /** Human, calm, protective label. Free of hype vocabulary (asserted). */
  label: string;
  tone: GemTone;
  /** Ionicons glyph name — a discovery/geometric marker per §46.1. */
  icon: string;
  /**
   * True when the state describes a fragile/overloaded/degraded gem that must
   * be surfaced protectively (never as an enticement).
   */
  protective: boolean;
  /** Optional one-line protective guidance (e.g. the §16.2 quieter-time nudge). */
  note?: string;
}

// The mapping. Every label below is intentionally descriptive and calm — it
// tells the traveller the gem's living status without ever ranking it by
// popularity. §46.1 gem/geometric markers (diamond, sparkles) lead the calm
// states; care icons (time, people, information) lead the fragile ones.
const TREATMENTS: Record<GemState, GemStateTreatment> = {
  recently_confirmed: {
    state: 'recently_confirmed',
    label: 'Recently confirmed',
    tone: 'confirmed',
    icon: 'checkmark-circle-outline',
    protective: false,
  },
  still_hidden: {
    state: 'still_hidden',
    label: 'Still hidden',
    tone: 'hidden',
    icon: 'diamond-outline',
    protective: false,
  },
  quiet_now: {
    state: 'quiet_now',
    label: 'Quiet right now',
    tone: 'calm',
    icon: 'leaf-outline',
    protective: false,
  },
  getting_discovered: {
    state: 'getting_discovered',
    label: 'Getting discovered',
    tone: 'aware',
    icon: 'eye-outline',
    // Awareness, framed protectively: the gem is becoming known, so it is worth
    // treating gently — not "it's blowing up, go now".
    protective: true,
    note: 'More people are finding this — visit gently.',
  },
  seasonal: {
    state: 'seasonal',
    label: 'Seasonal',
    tone: 'caution',
    icon: 'partly-sunny-outline',
    protective: false,
    note: 'Best at certain times of year — check before you go.',
  },
  hard_to_find: {
    state: 'hard_to_find',
    label: 'Hard to find',
    tone: 'caution',
    icon: 'trail-sign-outline',
    protective: false,
    note: 'Takes some effort to reach — plan your route.',
  },
  access_changed: {
    state: 'access_changed',
    label: 'Access changed',
    tone: 'caution',
    icon: 'information-circle-outline',
    protective: false,
    note: 'How you get here has changed recently — double-check access.',
  },
  temporarily_unavailable: {
    state: 'temporarily_unavailable',
    label: 'Temporarily unavailable',
    tone: 'caution',
    icon: 'time-outline',
    protective: false,
    note: 'Reported closed for now — check before making the trip.',
  },
  overcrowding_risk: {
    state: 'overcrowding_risk',
    // §16.2: protective framing for a fragile, overloaded place. NOT an
    // enticement, NOT a headcount, NOT "packed"/"buzzing".
    label: 'Busy right now',
    tone: 'protective',
    icon: 'people-outline',
    protective: true,
    note: 'This small spot is getting busy — consider another time.',
  },
  no_longer_hidden: {
    state: 'no_longer_hidden',
    label: 'No longer hidden',
    tone: 'aware',
    icon: 'earth-outline',
    protective: true,
    note: 'Widely known now — enjoy it with care.',
  },
};

// ── Public: state → treatment (degrade-safe) ──────────────────────────────────

export function isGemState(v: unknown): v is GemState {
  return typeof v === 'string' && (GEM_STATES as readonly string[]).includes(v);
}

/**
 * Map a gemState to its display treatment. Returns `null` for an absent or
 * unrecognised state (older payloads / forward-compat), so a caller renders as
 * it does today and never throws (§ degrade rule).
 */
export function gemStateTreatment(state: string | null | undefined): GemStateTreatment | null {
  if (!isGemState(state)) return null;
  return TREATMENTS[state];
}

/** Just the label, degrade-safe. */
export function gemStateLabel(state: string | null | undefined): string | null {
  return gemStateTreatment(state)?.label ?? null;
}

// ── Public: confidence → calm indicator (degrade-safe) ────────────────────────

export type GemConfidenceTone = 'strong' | 'good' | 'emerging' | 'faint';

export interface GemConfidenceIndicator {
  /** Calm evidence phrase — never a popularity/vanity metric. */
  label: string;
  tone: GemConfidenceTone;
  band: GemConfidenceBand;
}

const CONFIDENCE_INDICATORS: Record<GemConfidenceBand, GemConfidenceIndicator> = {
  strong:         { label: 'Strong signal',   tone: 'strong',   band: 'strong' },
  live:           { label: 'Well confirmed',  tone: 'good',     band: 'live' },
  likely_current: { label: 'Likely current',  tone: 'good',     band: 'likely_current' },
  provisional:    { label: 'Emerging',        tone: 'emerging', band: 'provisional' },
  unverified:     { label: 'Unconfirmed',     tone: 'faint',    band: 'unverified' },
};

function isConfidenceBand(v: unknown): v is GemConfidenceBand {
  return typeof v === 'string' && (GEM_CONFIDENCE_BANDS as readonly string[]).includes(v);
}

/**
 * Map a gemConfidence ({ score, band }) to a calm indicator. Prefers the
 * backend's band; falls back to deriving a band from the numeric score if the
 * band is absent/unknown (so a partial payload still reads sensibly). Returns
 * `null` when neither is usable (degrade).
 */
export function gemConfidenceIndicator(
  confidence: GemConfidence | null | undefined,
): GemConfidenceIndicator | null {
  if (!confidence) return null;
  if (isConfidenceBand(confidence.band)) return CONFIDENCE_INDICATORS[confidence.band];
  const s = confidence.score;
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) return null;
  // Band floors mirror lib/intelContracts.ts CONFIDENCE_BAND_FLOOR.
  const band: GemConfidenceBand =
    s >= 0.9 ? 'strong' :
    s >= 0.75 ? 'live' :
    s >= 0.55 ? 'likely_current' :
    s >= 0.35 ? 'provisional' :
    'unverified';
  return CONFIDENCE_INDICATORS[band];
}

// ── Public: the nine structured contribution actions (§16.3) ──────────────────
// Each is framed as an OBSERVATION the visitor is sharing — never a command
// that flips the gem's state (the backend enforces the corroboration threshold).

export type GemContributionTone = 'positive' | 'neutral' | 'caution';

export interface GemContributionAction {
  type: GemContributionType;
  /** Short button label. */
  label: string;
  /** One-line description of the observation being shared. */
  description: string;
  icon: string;
  tone: GemContributionTone;
}

const CONTRIBUTION_ACTIONS: Record<GemContributionType, GemContributionAction> = {
  still_here: {
    type: 'still_here',
    label: 'Still here',
    description: 'I found this gem right where it should be.',
    icon: 'checkmark-circle-outline',
    tone: 'positive',
  },
  still_worth_it: {
    type: 'still_worth_it',
    label: 'Still worth it',
    description: 'It was worth the detour — glad I came.',
    icon: 'heart-outline',
    tone: 'positive',
  },
  access_changed: {
    type: 'access_changed',
    label: 'Access changed',
    description: 'Getting in or reaching it has changed.',
    icon: 'information-circle-outline',
    tone: 'caution',
  },
  closed: {
    type: 'closed',
    label: 'Closed',
    description: "It was closed or I couldn't get in.",
    icon: 'time-outline',
    tone: 'caution',
  },
  too_crowded: {
    type: 'too_crowded',
    label: 'Too crowded',
    description: 'It was busier than a hidden gem should be.',
    icon: 'people-outline',
    tone: 'caution',
  },
  seasonal: {
    type: 'seasonal',
    label: 'Seasonal',
    description: 'It depends on the season or time of year.',
    icon: 'partly-sunny-outline',
    tone: 'neutral',
  },
  harder_to_reach: {
    type: 'harder_to_reach',
    label: 'Harder to reach',
    description: 'It took more effort to get there than expected.',
    icon: 'trail-sign-outline',
    tone: 'neutral',
  },
  better_entrance: {
    type: 'better_entrance',
    label: 'Better entrance',
    description: 'I found a better way in than the one shown.',
    icon: 'enter-outline',
    tone: 'neutral',
  },
  no_longer_hidden: {
    type: 'no_longer_hidden',
    label: 'No longer hidden',
    description: 'This feels widely known now, not a secret.',
    icon: 'earth-outline',
    tone: 'neutral',
  },
};

/** The nine contribution actions, in a stable display order. */
export const GEM_CONTRIBUTION_ACTIONS: readonly GemContributionAction[] =
  GEM_CONTRIBUTION_TYPES.map((t) => CONTRIBUTION_ACTIONS[t]);

export function isGemContributionType(v: unknown): v is GemContributionType {
  return typeof v === 'string' && (GEM_CONTRIBUTION_TYPES as readonly string[]).includes(v);
}

export function gemContributionAction(
  type: string | null | undefined,
): GemContributionAction | null {
  if (!isGemContributionType(type)) return null;
  return CONTRIBUTION_ACTIONS[type];
}

// ── The forbidden hype vocabulary (§16.2 / §46.1) ─────────────────────────────
// Popularity-first / viral / trending / vanity language is banned from every
// user-facing gem string. This set + `assertNoHypeLanguage` let the test pin it.

export const FORBIDDEN_HYPE_WORDS: readonly string[] = [
  'viral',
  'trending',
  'trend',
  'hot',
  'hottest',
  'popular',
  'popularity',
  'blowing up',
  'blow up',
  'must-see',
  'must see',
  'buzzing',
  'packed',
  'sensation',
  'famous',
  'go now',
  'don\'t miss',
  'dont miss',
];

/**
 * Returns the list of forbidden hype words found in `text` (case-insensitive,
 * word-ish boundaries so "shot" never trips "hot"). Empty ⇒ clean.
 */
export function findHypeLanguage(text: string): string[] {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9']+/g, ' ')} `;
  const hits: string[] = [];
  for (const w of FORBIDDEN_HYPE_WORDS) {
    const needle = w.includes(' ') ? ` ${w} ` : ` ${w} `;
    if (hay.includes(needle)) hits.push(w);
  }
  return hits;
}

/** Throws if `text` contains any forbidden hype vocabulary. */
export function assertNoHypeLanguage(text: string): void {
  const hits = findHypeLanguage(text);
  if (hits.length > 0) {
    throw new Error(`gem copy contains forbidden hype language: ${hits.join(', ')} in "${text}"`);
  }
}

/** Every user-facing string this module can surface — for exhaustive linting. */
export function allGemDisplayStrings(): string[] {
  const out: string[] = [];
  for (const s of GEM_STATES) {
    const t = TREATMENTS[s];
    out.push(t.label);
    if (t.note) out.push(t.note);
  }
  for (const b of GEM_CONFIDENCE_BANDS) {
    out.push(CONFIDENCE_INDICATORS[b].label);
  }
  for (const c of GEM_CONTRIBUTION_TYPES) {
    out.push(CONTRIBUTION_ACTIONS[c].label);
    out.push(CONTRIBUTION_ACTIONS[c].description);
  }
  return out;
}
