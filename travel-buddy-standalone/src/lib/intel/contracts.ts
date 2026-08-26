/**
 * Intelligence Gathering — client-side capture contract (Phase 1 / IG-03).
 *
 * This is the CLIENT mirror of the api-server's `lib/quickSignal.ts` +
 * `lib/intelContracts.ts`. It carries only what the capture UI needs: the §6
 * prompt copy + option lists, the venue prompt sets, the visibility and exit
 * vocabularies, and the feature-flag names. It deliberately holds NO
 * option→claim mapping — the server owns that (`mapQuickSignal`). The composer
 * sends a structured `{ context, option }` (or a direct `{ claimType, value }`
 * for the four Phase-1 claim types); the server maps the option to canonical
 * vocabulary and rejects anything outside the Phase-1 cut, fail-closed.
 *
 * RUNTIME EFFECT: NONE on its own — pure data + pure guards. Every surface that
 * reads it is gated on `INTEL_FLAGS.quickSignal` (and its dependants), which are
 * seeded OFF. With the flags off the UI is inert and nothing is ever sent.
 *
 * SAFETY INVARIANT (spec Appendix-A): `unsafe_density` is a specialist-only
 * safety claim and is NEVER an ordinary Quick Signal option. It does not appear
 * in any option list here, and `isSpecialistOnlyCrowd()` is the client-side
 * defence-in-depth check that mirrors the server's `SPECIALIST_ONLY_CROWD_LEVELS`.
 */

// ── Feature flags (mirror of api-server INTEL_FLAGS) ─────────────────────────
// String literals only — the client flag store (`useFeatureFlags`) is keyed by
// plain strings and has no typed registry. Fail-soft: an unknown/absent flag
// reads as `false`, so an unseeded flag hides its entry point.
export const INTEL_FLAGS = {
  quickSignal: 'intel_capture_quick_signal',
  claimProjectionCrowd: 'intel_claim_projection_crowd',
  liveLabelCrowd: 'intel_live_label_crowd',
  trailFollowup: 'intel_trail_followup',
  movementPrediction: 'intel_movement_prediction',
  missions: 'intel_missions',
} as const;
export type IntelFlag = (typeof INTEL_FLAGS)[keyof typeof INTEL_FLAGS];

// ── Quick Signal contexts (§6) ───────────────────────────────────────────────
export const QUICK_SIGNAL_CONTEXTS = ['arrival', 'inside', 'entrance', 'exit', 'movement'] as const;
export type QuickSignalContext = (typeof QUICK_SIGNAL_CONTEXTS)[number];

export interface QuickSignalPrompt {
  prompt: string;
  options: readonly string[];
}

/**
 * The prompt copy + option strings the composer shows per context (§6), byte-for
 * byte the same lists the server maps in `QUICK_SIGNAL_PROMPTS`. `movement` has
 * no fixed options — it is a free destination pick handled by the Trail sheet.
 */
export const QUICK_SIGNAL_PROMPTS: Record<QuickSignalContext, QuickSignalPrompt> = {
  arrival: { prompt: 'How is it right now?', options: ['dead', 'quiet', 'good energy', 'busy', 'packed'] },
  inside: { prompt: 'What is changing?', options: ['building', 'stable', 'peaking', 'declining'] },
  entrance: { prompt: 'How long is the line?', options: ['none', '<10', '10-20', '20-40', '40+'] },
  exit: { prompt: 'Why are you leaving?', options: ['planned', 'declining', 'too crowded', 'denied', 'slow', 'unsafe', 'better option'] },
  movement: { prompt: 'Where next?', options: [] },
};

/** The exit reasons, surfaced by the Trail exit sheet. Alias of the exit options. */
export const EXIT_REASONS = QUICK_SIGNAL_PROMPTS.exit.options;

// ── Independent-group signal (§privacy V1) ───────────────────────────────────
/**
 * The "who are you here with?" answer — a byte-for-byte mirror of the api-server
 * `PARTY_SIZE_BUCKETS`. Asked ONCE per capture, and only when the observation is
 * label-eligible (the crowd/queue/access signals). From it the server derives a
 * privacy-safe, ephemeral `group_key`: "just me" makes the actor its own
 * independent group; a shared Trip Crew is one group; "with others" but no shared
 * crew contributes confidence only, never a new group. The client never derives
 * or sends `group_key` — it sends only this raw bucket, and an OMITTED answer is
 * fail-closed server-side (null group_key, zero credit toward the ≥5-group floor).
 * The observer's active Trip Crew is resolved server-side, so the client sends no
 * `partyId` in V1.
 */
export const PARTY_SIZE_BUCKETS = ['just_me', 'one_other', 'two_to_four', 'five_plus'] as const;
export type PartySizeBucket = (typeof PARTY_SIZE_BUCKETS)[number];

/** The prompt copy shown above the party-size pills. */
export const PARTY_SIZE_PROMPT = 'Who are you here with?';

/** The traveler-facing label for each bucket (the §group-signal ruling copy). */
export const PARTY_SIZE_LABELS: Record<PartySizeBucket, string> = {
  just_me: 'Just me',
  one_other: '1 other person',
  two_to_four: '2–4 others',
  five_plus: '5+ others',
};

export interface PartySizeOption {
  value: PartySizeBucket;
  label: string;
}

/** Ordered value→label options for the picker (smallest party first). */
export const PARTY_SIZE_OPTIONS: readonly PartySizeOption[] = PARTY_SIZE_BUCKETS.map((value) => ({
  value,
  label: PARTY_SIZE_LABELS[value],
}));

// ── Venue-specific prompt sets (§6) ──────────────────────────────────────────
export const VENUE_CATEGORIES = ['nightlife', 'restaurant', 'event', 'transit', 'hotel'] as const;
export type VenueCategory = (typeof VENUE_CATEGORIES)[number];

/** Human labels for a venue category (for headers / pickers). */
export const VENUE_LABELS: Record<VenueCategory, string> = {
  nightlife: 'Nightlife',
  restaurant: 'Restaurant',
  event: 'Event',
  transit: 'Transit',
  hotel: 'Hotel',
};

/**
 * The §6 topic labels per venue, split into the arrival/inside set and the
 * exit/follow-up set. These are TOPIC labels (what a venue tends to be asked
 * about), not claim options — mirror of the server's `VENUE_PROMPTS`. The
 * composer surfaces them so the full §6 design is visible; only the topics that
 * map to a Phase-1 claim type are wired to submit (see `VENUE_QUESTION_SETS`).
 */
export const VENUE_PROMPTS: Record<VenueCategory, { arrivalInside: readonly string[]; exitFollowup: readonly string[] }> = {
  nightlife: { arrivalInside: ['energy', 'line', 'music', 'crowd mix', 'cover', 'walk-in', 'dress'], exitFollowup: ['worth it', 'stayed', 'why leave', 'where next', 'entry success'] },
  restaurant: { arrivalInside: ['wait', 'tables', 'sold-out items', 'noise', 'service pace'], exitFollowup: ['actual wait', 'bill accuracy', 'reservation need'] },
  event: { arrivalInside: ['entry', 'start status', 'capacity', 'schedule', 'water/access'], exitFollowup: ['exit congestion', 'transport', 'after-event move'] },
  transit: { arrivalInside: ['operational', 'queue', 'platform/pickup', 'fare'], exitFollowup: ['actual journey', 'delay', 'correct entrance/exit'] },
  hotel: { arrivalInside: ['check-in wait', 'construction', 'pool', 'breakfast', 'pickup'], exitFollowup: ['expectation match', 'operational correction'] },
};

/**
 * A single prompt question the UI can render + submit.
 *  - kind 'context' → submits `{ context, option }` (server maps to a claim).
 *  - kind 'walkIn'  → submits the direct Phase-1 claim `access.walk_in`.
 * `phase1` marks whether the server currently accepts this write; non-Phase-1
 * topics are presented (spec §6) but not wired to submit until capture expands.
 */
export interface PromptQuestion {
  id: string;
  /** §6 topic label this question realises (for the venue sheet header). */
  topic: string;
  /** The question copy shown above the option pills. */
  prompt: string;
  kind: 'context' | 'walkIn';
  context?: QuickSignalContext;
  options: readonly string[];
  phase1: boolean;
}

const Q_ARRIVAL: PromptQuestion = { id: 'arrival', topic: 'energy', prompt: QUICK_SIGNAL_PROMPTS.arrival.prompt, kind: 'context', context: 'arrival', options: QUICK_SIGNAL_PROMPTS.arrival.options, phase1: true };
const Q_INSIDE: PromptQuestion = { id: 'inside', topic: 'trajectory', prompt: QUICK_SIGNAL_PROMPTS.inside.prompt, kind: 'context', context: 'inside', options: QUICK_SIGNAL_PROMPTS.inside.options, phase1: true };
const Q_ENTRANCE: PromptQuestion = { id: 'entrance', topic: 'line', prompt: QUICK_SIGNAL_PROMPTS.entrance.prompt, kind: 'context', context: 'entrance', options: QUICK_SIGNAL_PROMPTS.entrance.options, phase1: true };
const Q_WALKIN: PromptQuestion = { id: 'walkin', topic: 'walk-in', prompt: 'Walking in without a booking?', kind: 'walkIn', options: ['accepted', 'turned away'], phase1: true };
const Q_EXIT: PromptQuestion = { id: 'exit', topic: 'why leave', prompt: QUICK_SIGNAL_PROMPTS.exit.prompt, kind: 'context', context: 'exit', options: QUICK_SIGNAL_PROMPTS.exit.options, phase1: false };

/**
 * Per-venue arrival + exit/follow-up question sets (§6). Every arrival question
 * is a Phase-1-backed claim so it submits today; the exit set feeds the Trail
 * follow-up path (flag `intel_trail_followup`) and is presented but not written
 * until IG-06 lands. The remaining §6 topics for the venue are surfaced as
 * read-only "planned" chips from `VENUE_PROMPTS` by the sheet itself.
 */
export const VENUE_QUESTION_SETS: Record<VenueCategory, { arrival: PromptQuestion[]; exit: PromptQuestion[] }> = {
  nightlife: { arrival: [Q_ARRIVAL, Q_INSIDE, Q_ENTRANCE, Q_WALKIN], exit: [Q_EXIT] },
  restaurant: { arrival: [Q_ENTRANCE, Q_WALKIN, Q_ARRIVAL], exit: [Q_EXIT] },
  event: { arrival: [Q_ARRIVAL, Q_ENTRANCE, Q_INSIDE], exit: [Q_EXIT] },
  transit: { arrival: [Q_ENTRANCE, Q_ARRIVAL], exit: [Q_EXIT] },
  hotel: { arrival: [Q_ENTRANCE, Q_ARRIVAL], exit: [Q_EXIT] },
};

// ── Visibility (§Trail visibility picker) ────────────────────────────────────
export const VISIBILITIES = ['public', 'followers', 'crew', 'invite_only', 'delayed', 'aggregate_only', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** Default for every write — the spec's "no public location sharing by default". */
export const DEFAULT_VISIBILITY: Visibility = 'private';

export interface VisibilityMeta {
  label: string;
  description: string;
}

export const VISIBILITY_META: Record<Visibility, VisibilityMeta> = {
  public: { label: 'Public', description: 'Anyone can see this movement.' },
  followers: { label: 'Followers', description: 'Only people who follow you.' },
  crew: { label: 'Crew', description: 'Only your current trip crew.' },
  invite_only: { label: 'Invite only', description: 'Only people you invite to this trail.' },
  delayed: { label: 'Delayed', description: 'Shared publicly, but only after a delay.' },
  aggregate_only: { label: 'Aggregate only', description: 'Counted toward crowd trends, never shown as you.' },
  private: { label: 'Private', description: 'Kept to yourself — the default. Nothing is shared.' },
};

/** The order the Trail visibility picker lists options (private first / safest). */
export const TRAIL_VISIBILITY_ORDER: readonly Visibility[] = ['private', 'aggregate_only', 'crew', 'followers', 'invite_only', 'delayed', 'public'];

// ── Crowd levels + specialist-only guard (§Appendix-A) ───────────────────────
/** The ordinary crowd vocabulary a Quick Signal may carry. */
export const CROWD_LEVELS = ['dead', 'quiet', 'moderate', 'busy', 'packed'] as const;
export type CrowdLevel = (typeof CROWD_LEVELS)[number] | 'unsafe_density';

/** Specialist-only crowd levels — never an ordinary Quick Signal option. */
export const SPECIALIST_ONLY_CROWD_LEVELS: readonly string[] = ['unsafe_density'];

/** Defence-in-depth: refuse to ever present or emit a specialist-only level. */
export function isSpecialistOnlyCrowd(level: string): boolean {
  return SPECIALIST_ONLY_CROWD_LEVELS.includes(level);
}

// ── Confidence bands (mirror of api-server CONFIDENCE_BANDS) ──────────────────
export const CONFIDENCE_BANDS = ['unverified', 'provisional', 'likely_current', 'live', 'strong'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const CONFIDENCE_BAND_FLOOR: Record<ConfidenceBand, number> = {
  unverified: 0,
  provisional: 0.35,
  likely_current: 0.55,
  live: 0.75,
  strong: 0.9,
};

/** Bands at or above this are shown as a live state; below degrade to typical/unknown. */
export const MIN_BAND_FOR_LIVE_STATE: ConfidenceBand = 'likely_current';

// ── Source classes (epistemic standing) + labels ─────────────────────────────
// Mirror of the api-server SOURCE_CLASS_LABELS. The bare `crowdLevel` the read
// path returns today carries no source class, so the client treats a live crowd
// value as `firsthand_unverified` (community, no presence proof) unless a richer
// claim supplies one.
export type SourceClass =
  | 'verified_firsthand'
  | 'firsthand_unverified'
  | 'official_signed'
  | 'sponsored'
  | 'imported_owned'
  | 'historical_pattern'
  | 'portava_prediction'
  | 'hearsay';

export const SOURCE_CLASS_LABELS: Record<SourceClass, string> = {
  verified_firsthand: 'Live from verified visitor',
  firsthand_unverified: 'Traveler report — unverified',
  official_signed: 'Official update',
  sponsored: 'Sponsored',
  imported_owned: 'Imported source',
  historical_pattern: 'Typical pattern',
  portava_prediction: 'Portava prediction',
  hearsay: 'Unverified tip',
};

/** Classes that may never be presented as a current (live) observation. */
export const NON_OBSERVATION_SOURCE_CLASSES: readonly SourceClass[] = ['historical_pattern', 'portava_prediction'];

export function mayRenderAsLive(cls: SourceClass): boolean {
  return !NON_OBSERVATION_SOURCE_CLASSES.includes(cls);
}

// ── Confirmation stance (§confirm) ───────────────────────────────────────────
export const CONFIRM_STANCES = ['agree', 'disagree', 'unsure'] as const;
export type ConfirmStance = (typeof CONFIRM_STANCES)[number];

// ── Correction: option → canonical value (mirror of server mapQuickSignal) ───
// The /claims/:id/correct route accepts a DIRECT `{ claimType, value }`, not a
// (context, option) pair, so the correction UI maps the chosen option to the
// canonical value_json here. Kept byte-identical to the api-server maps; the
// server still validates every value (`validateClaimValue`), so this is a
// convenience, never the source of truth.
const ARRIVAL_TO_CROWD: Record<string, string> = {
  dead: 'dead', quiet: 'quiet', 'good energy': 'moderate', busy: 'busy', packed: 'packed',
};
const INSIDE_TO_TRAJECTORY: Record<string, string> = {
  building: 'building', stable: 'stable', peaking: 'peaking', declining: 'declining',
};
const ENTRANCE_TO_QUEUE: Record<string, { minMinutes: number; maxMinutes: number | null }> = {
  none: { minMinutes: 0, maxMinutes: 0 },
  '<10': { minMinutes: 0, maxMinutes: 10 },
  '10-20': { minMinutes: 10, maxMinutes: 20 },
  '20-40': { minMinutes: 20, maxMinutes: 40 },
  '40+': { minMinutes: 40, maxMinutes: null },
};

/** The option list a correction offers for a claim type, or null if unsupported. */
export function correctionOptionsFor(claimType: string): readonly string[] | null {
  switch (claimType) {
    case 'crowd.level': return QUICK_SIGNAL_PROMPTS.arrival.options;
    case 'crowd.trajectory': return QUICK_SIGNAL_PROMPTS.inside.options;
    case 'queue.wait': return QUICK_SIGNAL_PROMPTS.entrance.options;
    case 'access.walk_in': return ['accepted', 'turned away'];
    default: return null;
  }
}

/** Map a chosen correction option to the canonical value_json, or null. */
export function optionToClaimValue(claimType: string, option: string): Record<string, unknown> | null {
  switch (claimType) {
    case 'crowd.level': {
      const level = ARRIVAL_TO_CROWD[option];
      if (!level || isSpecialistOnlyCrowd(level)) return null;
      return { level };
    }
    case 'crowd.trajectory': {
      const trajectory = INSIDE_TO_TRAJECTORY[option];
      return trajectory ? { trajectory } : null;
    }
    case 'queue.wait': {
      const wait = ENTRANCE_TO_QUEUE[option];
      return wait ? { ...wait } : null;
    }
    case 'access.walk_in':
      return option === 'accepted' ? { accepted: true } : option === 'turned away' ? { accepted: false } : null;
    default:
      return null;
  }
}
