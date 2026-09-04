/**
 * liveTruth — the live-truth display layer (Map spec §7, §9, §22).
 *
 * WHAT THIS IS
 * ============
 * The single place that turns a `MapObject`'s four truth axes — ACTIVITY,
 * TREND, CERTAINTY and FRESHNESS — into the words, arrows and affordances the
 * renderer shows. Spec §7 is the rule this module exists to enforce:
 *
 *     "The UI must distinguish observation, confidence, trend and freshness
 *      rather than collapsing them into one label."
 *
 * so every axis gets its own function and its own vocabulary. Nothing here
 * merges two axes into a single verdict, and nothing here upgrades one axis
 * using another (a very busy place is not thereby a confirmed one).
 *
 * WHAT THIS IS NOT
 * ================
 * Pure functions over the projected object. This module scores no confidence,
 * computes no freshness band, and performs no I/O — spec §19: "The mobile
 * client should not independently reconstruct Portava intelligence rules."
 * Bands arrive already decided on the wire (`lib/confidenceScore.ts`,
 * `lib/freshnessPolicy.ts` server-side); we only relabel them.
 *
 * The relative-time arithmetic IS done here, because "how long ago was this
 * timestamp" is presentation, not intelligence — it changes every minute the
 * screen is open and cannot be baked into a payload.
 *
 * THE THREE STANDING RULES
 * ========================
 * §37  "Do not let stale claims remain visually live."
 *          -> `shouldPulse` fails closed on every missing axis.
 * §37  "Do not make predictions look like observations."
 *          -> forecast kinds never pulse and never take contribution prompts.
 * §22  "Rewards ... must never increase factual confidence merely because the
 *       contribution was paid."
 *          -> nothing in the contribution model carries a reward, a payment,
 *             or any field a reward could be attached to.
 */

import {
  ACTIVITY_LABELS,
  ACTIVITY_LEVELS,
  CONFIDENCE_LABELS,
  CONFIDENCE_STATES,
  TREND_LABELS,
  isForecastKind,
  mayRenderAsLive,
  type ActivityLevel,
  type ConfidenceState,
  type FreshnessState,
  type MapObject,
  type MapObjectKind,
  type MapProvenanceLine,
  type TrendState,
} from '../../../types/mapObjects.ts';

// ── Time arithmetic ────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function nowMs(now?: Date | number | null): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

/**
 * Milliseconds since `iso`, or null when the timestamp is missing/unparseable.
 *
 * Clock skew is clamped to 0: a timestamp in the future is treated as "right
 * now" rather than producing a negative age. Clamping toward the PRESENT is
 * safe here only because every caller then rounds the age UP to at least one
 * minute — so a skewed clock can never make a claim look fresher than the band
 * the server already assigned it.
 */
export function ageMsOf(iso: string | null | undefined, now?: Date | number): number | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const age = nowMs(now) - t;
  return age < 0 ? 0 : age;
}

/**
 * The §7 relative-time vocabulary: `'2m ago'`, `'8m ago'`,
 * `'Last confirmed 1h ago'`, `'Historical'`.
 *
 * Sub-minute ages round UP to `'1m ago'` rather than gaining a "just now"
 * string of their own. Rounding up overstates staleness by <60s, which is the
 * fail-safe direction — the opposite rounding would let a claim read fresher
 * than it is.
 */
export function relativeObservedLabel(
  observedAt: string | null | undefined,
  now?: Date | number,
): string | null {
  const age = ageMsOf(observedAt, now);
  if (age == null) return null;
  if (age < HOUR_MS) {
    const minutes = Math.max(1, Math.floor(age / MINUTE_MS));
    return `${minutes}m ago`;
  }
  if (age < DAY_MS) {
    const hours = Math.floor(age / HOUR_MS);
    return `Last confirmed ${hours}h ago`;
  }
  return 'Historical';
}

// ── §7 · Freshness ─────────────────────────────────────────────────────────────

/**
 * The coarse word used when there is no usable `observedAt`. These are the
 * §7 column entries that carry no number.
 *
 * `unknown` deliberately does NOT fall back to `'Historical'`: "historical"
 * asserts that an observation happened and has since aged out, which is a
 * claim the projection did not make. `'Unknown'` asserts nothing.
 */
const COARSE_FRESHNESS_LABEL: Record<FreshnessState, string> = {
  live: 'Live',
  recent: 'Recently',
  aging: 'Recently',
  stale: 'Historical',
  historical: 'Historical',
  unknown: 'Unknown',
};

/**
 * Spec §7's Freshness column.
 *
 * - `live`      -> `'Live'`. The live band is a state, not an age; it does not
 *                  degrade into "3m ago" while it is still live.
 * - `recent` /
 *   `aging`     -> the relative age (`'2m ago'`, `'8m ago'`,
 *                  `'Last confirmed 1h ago'`), or `'Recently'` with no timestamp.
 * - `stale`     -> `'Last confirmed Nh ago'` when we know when; `'Historical'`
 *                  otherwise. Never a bare `'Nm ago'`, which reads current.
 * - `historical`-> `'Historical'`.
 * - `unknown` /
 *   absent      -> `'Unknown'` — the fail-closed rung (§37).
 */
export function freshnessLabel(
  freshness: FreshnessState | null | undefined,
  observedAt?: string | null,
  now?: Date | number,
): string {
  if (freshness == null) return COARSE_FRESHNESS_LABEL.unknown;
  if (freshness === 'live') return 'Live';
  if (freshness === 'historical' || freshness === 'unknown') {
    return COARSE_FRESHNESS_LABEL[freshness];
  }

  const relative = relativeObservedLabel(observedAt, now);
  if (relative == null) return COARSE_FRESHNESS_LABEL[freshness];

  if (freshness === 'stale') {
    // A stale claim must never render as a bare "12m ago" — that phrasing reads
    // as current. Anything under an hour is re-phrased as "last confirmed".
    if (relative.endsWith('m ago')) return `Last confirmed ${relative.replace(' ago', '')} ago`;
    return relative;
  }
  return relative;
}

// ── §7 · Certainty ─────────────────────────────────────────────────────────────

/** Rank within CONFIDENCE_STATES; -1 for an absent/unrecognised band. */
export function confidenceRank(confidence: ConfidenceState | null | undefined): number {
  if (confidence == null) return -1;
  return CONFIDENCE_STATES.indexOf(confidence);
}

/**
 * Spec §7's Certainty column, straight from the contract's `CONFIDENCE_LABELS`.
 * An absent band is `'Unconfirmed'` — the weakest reading, never a blank that a
 * caller might render as "fine".
 */
export function confidenceLabel(confidence: ConfidenceState | null | undefined): string {
  return confidence == null ? CONFIDENCE_LABELS.unverified : CONFIDENCE_LABELS[confidence];
}

// ── §7 · Activity and Trend ────────────────────────────────────────────────────

/** Spec §7's Activity column. `null` when the projection observed no level. */
export function activityLabel(activity: ActivityLevel | null | undefined): string | null {
  return activity == null ? null : ACTIVITY_LABELS[activity];
}

/** Spec §7's Trend column. `null` when the projection observed no direction. */
export function trendLabel(trend: TrendState | null | undefined): string | null {
  return trend == null ? null : TREND_LABELS[trend];
}

const TREND_ARROWS: Record<TrendState, '↑' | '→' | '↓'> = {
  increasing_quickly: '↑',
  getting_busier: '↑',
  stable: '→',
  cooling: '↓',
  getting_quieter: '↓',
  rapidly_dispersing: '↓',
};

/**
 * The §8 arrow glyph for a trend.
 *
 * Returns `null` for an absent trend rather than `'→'`: a missing direction is
 * "we don't know", while `'→'` asserts "stable", which is a real observation
 * we were not given.
 */
export function trendArrow(trend: TrendState | null | undefined): '↑' | '→' | '↓' | null {
  return trend == null ? null : TREND_ARROWS[trend];
}

// ── §37 · Pulse eligibility ────────────────────────────────────────────────────

/** The two bands strong enough to earn a live treatment. */
const PULSE_CONFIDENCE: readonly ConfidenceState[] = ['live', 'strong'];

/** The subset of a MapObject `shouldPulse` needs. */
export type PulseCandidate = Pick<
  MapObject,
  'kind' | 'freshness' | 'confidence' | 'expiresAt'
>;

/**
 * Whether an object may render with the pulsing "live" treatment (§6: "Pulsing
 * outline — meaningful recent change").
 *
 * Four gates, all fail-closed, because §37 forbids stale claims that still look
 * live and predictions that look like observations:
 *   1. freshness is `live` or `recent` (`mayRenderAsLive`);
 *   2. confidence is `live` or `strong` — a fresh but UNVERIFIED report is a
 *      rumour, and a rumour must not pulse;
 *   3. the object is not a forecast kind;
 *   4. `expiresAt` has not passed.
 *
 * Note that (1) and (2) are independently necessary. Neither a stale-but-
 * confirmed claim nor a live-but-unconfirmed one pulses.
 */
export function shouldPulse(
  obj: PulseCandidate | null | undefined,
  now?: Date | number,
): boolean {
  if (!obj) return false;
  if (isForecastKind(obj.kind)) return false;
  if (!mayRenderAsLive(obj.freshness)) return false;
  if (obj.confidence == null || !PULSE_CONFIDENCE.includes(obj.confidence)) return false;
  if (typeof obj.expiresAt === 'string' && obj.expiresAt.trim() !== '') {
    const expiry = Date.parse(obj.expiresAt);
    if (Number.isFinite(expiry) && expiry <= nowMs(now)) return false;
  }
  return true;
}

// ── §9 · Provenance ("WHY PORTAVA SAYS THIS") ──────────────────────────────────

/** The §9 panel heading, in the spec's own words. */
export const WHY_PANEL_TITLE = 'WHY PORTAVA SAYS THIS';

/** Shown when an object carries nothing that could justify a live claim. */
export const NO_EVIDENCE_LINE = 'No supporting evidence has been recorded yet';

/** At most this many bullets; §9's own example shows five. */
const MAX_WHY_LINES = 6;

/**
 * The strongest verb a given certainty band may use about a signal.
 *
 * `Observed` asserts Portava saw it. `Reported` asserts only that somebody said
 * so. Below `likely_current` we have not earned the first word — this is the
 * mechanism that stops a synthesized line from out-claiming `obj.confidence`.
 */
function evidenceVerb(confidence: ConfidenceState | null | undefined): 'Observed' | 'Reported' {
  return confidenceRank(confidence) >= confidenceRank('likely_current') ? 'Observed' : 'Reported';
}

/**
 * How to describe a pile of source references without overstating it.
 * The counts are facts the object carries; the adjectives are deliberately
 * quantity words ("One", "Several", "Multiple independent"), never quality
 * words ("reliable", "trusted"), which would be a certainty claim.
 */
function sourceCountText(count: number, fresh: boolean): string {
  const when = fresh ? 'recent' : 'earlier';
  if (count === 1) return `One ${when} traveler report`;
  if (count < 5) return `Several ${when} traveler reports`;
  return `Multiple independent ${when} traveler reports`;
}

/**
 * Build the §9 Why? panel body for an object.
 *
 * Server-supplied lines win outright: `provenance.lines` is the claim system's
 * own account of its evidence, and this layer has no standing to rewrite it.
 *
 * With no server lines we SYNTHESIZE from what the object literally carries —
 * source refs, aggregation count, activity, trend, freshness, forecast-ness,
 * privacy class. Every branch below is gated on a field being present, so a
 * bare object produces a bare (or empty-stated) panel rather than a plausible
 * one. Inventing "Active event nearby" because it reads well is exactly the
 * failure §9 exists to prevent.
 */
export function buildWhyLines(
  obj: MapObject | null | undefined,
  now?: Date | number,
): MapProvenanceLine[] {
  if (!obj) return [{ text: NO_EVIDENCE_LINE }];

  const supplied = obj.provenance?.lines;
  if (Array.isArray(supplied) && supplied.length > 0) {
    return supplied
      .filter((line) => line && typeof line.text === 'string' && line.text.trim() !== '')
      .map((line) => (line.ref ? { text: line.text, ref: line.ref } : { text: line.text }));
  }

  const lines: MapProvenanceLine[] = [];
  const fresh = mayRenderAsLive(obj.freshness);
  const verb = evidenceVerb(obj.confidence);

  // A forecast says so FIRST, before any number that might read as measured.
  if (isForecastKind(obj.kind)) {
    lines.push({ text: 'Predicted from past patterns, not observed' });
  }

  const refs = Array.isArray(obj.sourceRefs) ? obj.sourceRefs.filter(Boolean) : [];
  if (refs.length > 0) {
    const text = sourceCountText(refs.length, fresh);
    lines.push(refs.length === 1 ? { text, ref: refs[0] } : { text });
  }

  if (typeof obj.count === 'number' && obj.count > 1) {
    lines.push({ text: `Aggregated from ${obj.count} nearby objects` });
  }

  const activity = activityLabel(obj.activity);
  if (activity) lines.push({ text: `${verb} activity: ${activity}` });

  const trend = trendLabel(obj.trend);
  if (trend) lines.push({ text: `${verb} trend: ${trend}` });

  // Freshness is its own evidence line (§7 keeps it a separate axis). It is not
  // the same statement as the panel's "Updated N minutes ago" row, which
  // describes when the EVIDENCE was last touched rather than how current the
  // STATE is.
  if (obj.freshness === 'live') {
    lines.push({ text: 'Currently live' });
  } else {
    const relative = relativeObservedLabel(obj.observedAt, now);
    if (relative) lines.push({ text: relative === 'Historical' ? 'Historical observation' : relative });
    else if (obj.freshness != null && obj.freshness !== 'unknown') {
      lines.push({ text: COARSE_FRESHNESS_LABEL[obj.freshness] });
    }
  }

  if (obj.privacyClass === 'aggregate_only') {
    lines.push({ text: 'Aggregated so no individual is identifiable' });
  }

  if (lines.length === 0) return [{ text: NO_EVIDENCE_LINE }];
  return lines.slice(0, MAX_WHY_LINES);
}

/**
 * The §9 "Updated 6 minutes ago" row. Reads `provenance.updatedAt` (when the
 * evidence was last touched) and falls back to `observedAt`. Returns null when
 * neither exists — the row is then omitted rather than filled with a guess.
 */
export function updatedAtLabel(
  obj: MapObject | null | undefined,
  now?: Date | number,
): string | null {
  if (!obj) return null;
  const iso = obj.provenance?.updatedAt ?? obj.observedAt;
  const age = ageMsOf(iso, now);
  if (age == null) return null;
  if (age < MINUTE_MS) return 'Updated just now';
  if (age < HOUR_MS) {
    const m = Math.floor(age / MINUTE_MS);
    return `Updated ${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (age < DAY_MS) {
    const h = Math.floor(age / HOUR_MS);
    return `Updated ${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(age / DAY_MS);
  return `Updated ${d} day${d === 1 ? '' : 's'} ago`;
}

/** Everything the §9 sheet renders, resolved in one pure call. */
export interface WhyPanelModel {
  title: string;
  lines: MapProvenanceLine[];
  /** "Updated 6 minutes ago", or null when no timestamp exists. */
  updated: string | null;
  confidence: ConfidenceState;
  /** "Confidence: Strong signal" */
  confidenceText: string;
}

export function buildWhyPanel(
  obj: MapObject | null | undefined,
  now?: Date | number,
): WhyPanelModel {
  const confidence = obj?.provenance?.confidence ?? obj?.confidence ?? 'unverified';
  return {
    title: WHY_PANEL_TITLE,
    lines: buildWhyLines(obj, now),
    updated: updatedAtLabel(obj, now),
    confidence,
    confidenceText: `Confidence: ${confidenceLabel(confidence)}`,
  };
}

// ── §22 · Contributions ────────────────────────────────────────────────────────

/**
 * The eight prompts spec §22 enumerates, in the spec's order.
 * `media` is §22's "Current photo/video".
 */
export const CONTRIBUTION_KINDS = [
  'crowd_level',
  'queue',
  'entry_access',
  'vibe',
  'event_status',
  'closure',
  'crowd_direction',
  'media',
] as const;

export type MapContributionKind = (typeof CONTRIBUTION_KINDS)[number];

export const CONTRIBUTION_PROMPT_LABELS: Record<MapContributionKind, string> = {
  crowd_level: 'How busy is it?',
  queue: 'How long is the queue?',
  entry_access: 'How is entry right now?',
  vibe: 'What is the vibe?',
  event_status: 'Has it started?',
  closure: 'Is it open?',
  crowd_direction: 'Which way is the crowd moving?',
  media: 'Show what it looks like',
};

// Option vocabularies. Crowd level reuses the contract's ACTIVITY_LEVELS so a
// contributed level and a projected level are the same value on the wire.

export const QUEUE_LEVELS = ['none', 'under_5m', '5_15m', '15_30m', 'over_30m'] as const;
export type QueueLevel = (typeof QUEUE_LEVELS)[number];
export const QUEUE_LABELS: Record<QueueLevel, string> = {
  none: 'No queue',
  under_5m: 'Under 5 min',
  '5_15m': '5-15 min',
  '15_30m': '15-30 min',
  over_30m: '30+ min',
};

export const ENTRY_ACCESS_STATES = [
  'walk_straight_in',
  'line_at_door',
  'guest_list_only',
  'at_capacity',
  'entry_closed',
] as const;
export type EntryAccessState = (typeof ENTRY_ACCESS_STATES)[number];
export const ENTRY_ACCESS_LABELS: Record<EntryAccessState, string> = {
  walk_straight_in: 'Walk straight in',
  line_at_door: 'Line at the door',
  guest_list_only: 'Guest list only',
  at_capacity: 'At capacity',
  entry_closed: 'Entry closed',
};

export const VIBE_STATES = ['dead', 'chill', 'social', 'high_energy', 'going_off'] as const;
export type VibeState = (typeof VIBE_STATES)[number];
export const VIBE_LABELS: Record<VibeState, string> = {
  dead: 'Dead',
  chill: 'Chill',
  social: 'Social',
  high_energy: 'High energy',
  going_off: 'Going off',
};

export const EVENT_STATUS_STATES = [
  'not_started',
  'starting_soon',
  'under_way',
  'winding_down',
  'ended',
  'cancelled',
] as const;
export type EventStatusState = (typeof EVENT_STATUS_STATES)[number];
export const EVENT_STATUS_LABELS: Record<EventStatusState, string> = {
  not_started: 'Not started',
  starting_soon: 'Starting soon',
  under_way: 'Under way',
  winding_down: 'Winding down',
  ended: 'Ended',
  cancelled: 'Cancelled',
};

export const CLOSURE_STATES = [
  'open',
  'temporarily_closed',
  'closed_for_private_event',
  'permanently_closed',
] as const;
export type ClosureState = (typeof CLOSURE_STATES)[number];
export const CLOSURE_LABELS: Record<ClosureState, string> = {
  open: 'Open',
  temporarily_closed: 'Temporarily closed',
  closed_for_private_event: 'Closed — private event',
  permanently_closed: 'Permanently closed',
};

export const CROWD_DIRECTIONS = ['arriving', 'dispersing', 'passing_through', 'holding'] as const;
export type CrowdDirection = (typeof CROWD_DIRECTIONS)[number];
export const CROWD_DIRECTION_LABELS: Record<CrowdDirection, string> = {
  arriving: 'People arriving',
  dispersing: 'People leaving',
  passing_through: 'Moving through',
  holding: 'Staying put',
};

/**
 * §22's "Current photo/video" asset types.
 *
 * A VOCABULARY OF ASSET TYPES, NOT OF CLAIM VALUES. The other seven prompts'
 * options are propositions — "busy", "at capacity", "closed" — each of which
 * becomes a claim the projection can confirm, contradict and expire. `photo`
 * and `video` are neither: they say what KIND of artifact was captured, not
 * what is true of the place. Media mints no claim type here or on the server,
 * and this array must never be treated as one.
 */
export const MEDIA_KINDS = ['photo', 'video'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const MEDIA_LABELS: Record<MediaKind, string> = {
  photo: 'Photo',
  video: 'Video',
};

/** One selectable answer in the capture sheet. */
export interface ContributionOption {
  value: string;
  label: string;
}

function optionsFrom<K extends string>(
  values: readonly K[],
  labels: Record<K, string>,
): ContributionOption[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

/** Every enumerated answer, keyed by prompt. Drives the one-tap option rows. */
export const CONTRIBUTION_OPTIONS: Record<MapContributionKind, ContributionOption[]> = {
  crowd_level: optionsFrom(ACTIVITY_LEVELS, ACTIVITY_LABELS),
  queue: optionsFrom(QUEUE_LEVELS, QUEUE_LABELS),
  entry_access: optionsFrom(ENTRY_ACCESS_STATES, ENTRY_ACCESS_LABELS),
  vibe: optionsFrom(VIBE_STATES, VIBE_LABELS),
  event_status: optionsFrom(EVENT_STATUS_STATES, EVENT_STATUS_LABELS),
  closure: optionsFrom(CLOSURE_STATES, CLOSURE_LABELS),
  crowd_direction: optionsFrom(CROWD_DIRECTIONS, CROWD_DIRECTION_LABELS),
  media: optionsFrom(MEDIA_KINDS, MEDIA_LABELS),
};

// The §22 payload. Note what is absent: no rating, no score, no star, no reward
// field, no payment reference. "Contributions are observations, not immediate
// truth" (§22) and "Do not let paid businesses buy factual confidence" (§37) —
// a reward cannot influence a claim it has no way to travel with.

export interface MapContributionBase {
  /** The map object this observation is about. */
  objectId: string;
  /** Its kind, so the server can re-check the prompt was legal for it. */
  objectKind: MapObjectKind;
  /**
   * Client capture time, ISO. ADVISORY ONLY — the claim system stamps its own
   * authoritative time; a client clock cannot be allowed to set freshness.
   */
  observedAt: string;
}

export type MapContribution =
  | (MapContributionBase & { kind: 'crowd_level'; value: ActivityLevel })
  | (MapContributionBase & { kind: 'queue'; value: QueueLevel })
  | (MapContributionBase & { kind: 'entry_access'; value: EntryAccessState })
  | (MapContributionBase & { kind: 'vibe'; value: VibeState })
  | (MapContributionBase & { kind: 'event_status'; value: EventStatusState })
  | (MapContributionBase & { kind: 'closure'; value: ClosureState })
  | (MapContributionBase & { kind: 'crowd_direction'; value: CrowdDirection })
  // The media member carries two fields the other seven do not, and both are
  // REQUIRED — see `createContribution` for why neither is optional here.
  | (MapContributionBase & {
      kind: 'media';
      value: MediaKind;
      /**
       * A reference to an object already uploaded through the app's media
       * path, NOT a device URI. The server proves the reference is ours and
       * this contributor's before it stores anything, so a `file://` path is
       * refused rather than stored.
       */
      mediaUri: string;
      /**
       * The observation this artifact supports. §21 orders Observation before
       * Evidence and `intel_evidence.observation_id` is NOT NULL, so a photo
       * can only ever be attached to an observation that ALREADY exists.
       */
      observationId: string;
    });

/**
 * Which prompts each object kind can legally take.
 *
 * These are semantic rules, not a UI convenience list — a prompt that cannot
 * describe the object produces junk evidence, and junk evidence is what the
 * whole §21 pipeline is built to keep out. Notably:
 *
 *   - `activity_zone` / `social_zone` / `crowd_flow` are AREAS, not premises.
 *     They cannot close, have no door and no queue. A zone takes only the
 *     aggregate prompts (level, direction, and for a social zone the vibe).
 *   - `event` cannot take `closure` — an event that is off is `cancelled`,
 *     which `event_status` already expresses, and two ways to say the same
 *     thing would produce contradicting claims about one fact.
 *   - `event` takes `queue` / `entry_access` only when it is VENUE-BOUND; see
 *     `isVenueBound` below.
 *   - `prediction` takes nothing: you cannot observe a forecast (§37).
 *   - `safety_notice` takes nothing: safety state is owned by the Safety system
 *     (§20) and outranks activity ranking (§24). It is not crowd-editable from
 *     a map prompt.
 *   - `crew_member`, `buddy_zone` and `memory` describe people, service
 *     availability and personal history — none of them are public observations
 *     of a physical state.
 */
const KIND_PROMPTS: Record<MapObjectKind, readonly MapContributionKind[]> = {
  place: ['crowd_level', 'queue', 'entry_access', 'vibe', 'closure', 'media'],
  hidden_gem: ['crowd_level', 'queue', 'entry_access', 'vibe', 'closure', 'media'],
  trip_stop: ['crowd_level', 'queue', 'entry_access', 'vibe', 'closure', 'media'],
  // A saved place is a venue the viewer chose; the same public observations a
  // place takes apply to it.
  saved_place: ['crowd_level', 'queue', 'entry_access', 'vibe', 'closure', 'media'],
  // `queue` / `entry_access` are filtered back out for non-venue-bound events.
  event: ['crowd_level', 'queue', 'entry_access', 'vibe', 'event_status', 'crowd_direction', 'media'],
  activity_zone: ['crowd_level', 'crowd_direction'],
  social_zone: ['crowd_level', 'vibe', 'crowd_direction'],
  crowd_flow: ['crowd_direction'],
  meeting_point: ['crowd_level', 'entry_access', 'media'],
  crew_member: [],
  buddy_zone: [],
  safety_notice: [],
  memory: [],
  prediction: [],
};

/** Prompts that only make sense at a single fixed premises with a door. */
const VENUE_BOUND_ONLY: readonly MapContributionKind[] = ['queue', 'entry_access'];

/**
 * Whether an event is bound to one venue.
 *
 * A Point event happens at an address — one door, one queue. A Polygon or
 * LineString event is a festival footprint, a parade route or a district
 * takeover: it has many entrances or none, so "the queue" names nothing.
 * Geometry is the only venue signal the projection actually gives us, and it is
 * a real one, so it is what the rule reads.
 */
export function isVenueBound(obj: Pick<MapObject, 'kind' | 'geometry'>): boolean {
  if (obj.kind !== 'event') return true;
  return obj.geometry?.type === 'Point';
}

/** The subset of a MapObject the contribution rules read. */
export type ContributionCandidate = Pick<
  MapObject,
  'kind' | 'geometry' | 'privacyClass' | 'interaction'
>;

/**
 * The §22 prompts applicable to this object, in spec order.
 *
 * Returns `[]` — not a default set — whenever contribution is inapplicable, so
 * a caller that forgets to check still renders nothing rather than the wrong
 * thing.
 */
export function contributionPromptsFor(
  obj: ContributionCandidate | null | undefined,
): MapContributionKind[] {
  if (!obj) return [];
  // `none` is the "not visible to this viewer" rung — nothing to observe.
  if (obj.privacyClass === 'none') return [];
  // An explicit server-side `contributable: false` is a gate, and it wins.
  // `undefined` means "the projection didn't say", which falls through to the
  // kind rules rather than being read as permission.
  if (obj.interaction?.contributable === false) return [];
  if (isForecastKind(obj.kind)) return [];

  const base = KIND_PROMPTS[obj.kind] ?? [];
  const venueBound = isVenueBound(obj);
  const allowed = venueBound ? base : base.filter((k) => !VENUE_BOUND_ONLY.includes(k));
  // Re-project onto CONTRIBUTION_KINDS so the returned order is always §22's.
  return CONTRIBUTION_KINDS.filter((k) => allowed.includes(k));
}

/** Whether one specific prompt is legal for this object. */
export function isContributionAllowed(
  obj: ContributionCandidate | null | undefined,
  kind: MapContributionKind,
): boolean {
  return contributionPromptsFor(obj).includes(kind);
}

/** Whether a value is one of the enumerated answers for a prompt. */
export function isValidContributionValue(kind: MapContributionKind, value: string): boolean {
  return CONTRIBUTION_OPTIONS[kind].some((o) => o.value === value);
}

/**
 * Build a §22 observation payload, or return null when the prompt is not legal
 * for this object or the value is not one of its enumerated answers.
 *
 * Constructing through this function is what keeps the per-kind rules from
 * being a UI-only convention: an ineligible contribution cannot be built at
 * all, so it cannot be submitted by a caller that skipped the prompt list.
 * (The server re-authorizes regardless — a client-only gate is not a gate.)
 */
export function createContribution(
  obj: (ContributionCandidate & Pick<MapObject, 'id'>) | null | undefined,
  kind: MapContributionKind,
  value: string,
  opts?: { now?: Date | number; mediaUri?: string; observationId?: string },
): MapContribution | null {
  if (!obj || !obj.id) return null;
  if (!isContributionAllowed(obj, kind)) return null;
  if (!isValidContributionValue(kind, value)) return null;

  const base: MapContributionBase = {
    objectId: obj.id,
    objectKind: obj.kind,
    observedAt: new Date(nowMs(opts?.now)).toISOString(),
  };

  if (kind === 'media') {
    // A media contribution without an asset is not an observation of anything.
    const mediaUri = opts?.mediaUri;
    if (typeof mediaUri !== 'string' || mediaUri.trim() === '') return null;
    // ...and one without an observation is not a §22 contribution at all.
    //
    // §21 orders Observation -> Evidence, and the server refuses a bare photo
    // with the ruling as the reason ("a photo is evidence, not a claim"). That
    // refusal is the authority; this check is the same rule made STRUCTURAL on
    // the client, so a caller that skipped the observation cannot even build
    // the payload to send. It is the media twin of the per-kind rules above:
    // an ineligible contribution is not constructible, so it is not sendable.
    const observationId = opts?.observationId;
    if (typeof observationId !== 'string' || observationId.trim() === '') return null;
    return { ...base, kind: 'media', value: value as MediaKind, mediaUri, observationId };
  }

  return { ...base, kind, value } as MapContribution;
}

/**
 * §22: "Contributions are observations, not immediate truth." The capture sheet
 * must say so on screen — a user who thinks they are rating a place will report
 * how they felt about it rather than what is in front of them.
 */
export const CONTRIBUTION_FRAMING =
  'This is an observation of right now — not a rating.';

/**
 * §22 / §37: rewards may drive participation and must never be presented as
 * making a claim more true.
 */
export const CONTRIBUTION_REWARD_NOTICE =
  'Contributing earns recognition. It never raises how confident Portava is in a claim.';
