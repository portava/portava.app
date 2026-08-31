/**
 * livePlaceModel — Map spec §8 "Live Place Surface" (+ §9 provenance).
 *
 * WHAT §8 ASKS FOR
 * ================
 *   Hero photo / recent Moment
 *   Place name · type · distance
 *   LIVE STATE   Very Busy · Getting busier · Updated 4 min ago
 *   CROWD / TREND / VIBE
 *   SOCIAL       3 friends here · 12 travelers interested
 *   ACCESS       Queue ~20 min · Open until 1:30 AM · Price $$$
 *   WHY SHOWN    Matches current intent · Crew nearby · Strong live activity
 *   ACTIONS      Go · Save · Ask Compass · Add to Trip · Meet Here · Share
 *
 * THE RULE THIS FILE ENFORCES
 * ===========================
 * Every one of those sections is INDEPENDENTLY OPTIONAL, and a section that is
 * not supported by the inputs resolves to `null` — never to a plausible-looking
 * default. A place with no live claim shows NO LIVE STATE. It does not show
 * "Quiet", because "Quiet" is an observation, and inventing one would make the
 * map assert something nobody observed (§37: "Do not let stale claims remain
 * visually live"; §7: the UI must distinguish observation from absence).
 *
 * So the view model carries `missing: MissingSection[]` — an explicit list of
 * what could not be built and WHY. The sheet renders that as honest silence (or
 * an "Add what you see" contribution prompt, §22), never as a fabricated value.
 *
 * PRIVACY
 * =======
 * §23: "Default public rendering should aggregate social presence." An object
 * whose `privacyClass` does not permit identity (`aggregate_only` or narrower)
 * can never yield an identified-friends count, no matter what the detail
 * payload supplies — `mayRenderIdentity` from the contract is the gate, and the
 * detail is dropped rather than downgraded silently: `social.suppressed` says so.
 *
 * Pure: no I/O, no React, no ambient clock. `now` is always passed in.
 */

import {
  ACTIVITY_LABELS,
  CONFIDENCE_LABELS,
  TREND_LABELS,
  isRenderable,
  mayRenderAsLive,
  mayRenderIdentity,
  type ActivityLevel,
  type ConfidenceState,
  type FreshnessState,
  type MapAction,
  type MapObject,
  type MapObjectKind,
  type MapProvenance,
  type TrendState,
} from '../../../types/mapObjects.ts';

// ── Detail: everything the projection could not put on the envelope ───────────

/**
 * The §8 fields that live outside `MapObject` — fetched with the place detail.
 * EVERY field is optional and `null` means "we asked and there is nothing",
 * which is treated identically to absent: the section simply does not render.
 */
export interface LivePlaceDetail {
  /** §8 "Hero photo / recent Moment". */
  heroPhotoUrl?: string | null;
  /** Whether the hero is a user Moment rather than a place photo. */
  heroIsMoment?: boolean | null;
  /** §8 "Place name · type · distance" — the type half. */
  placeType?: string | null;

  /** §8 VIBE. A qualitative read; there is no default vibe. */
  vibe?: string | null;

  /** §8 SOCIAL. Identified friends — gated by privacyClass. */
  friendsHereCount?: number | null;
  /** §8 SOCIAL. An aggregate; permitted at aggregate_only. */
  travelersInterestedCount?: number | null;

  /** §8 ACCESS. */
  queueMinutes?: number | null;
  openUntil?: string | null;
  /** 1-4, rendered as $ … $$$$. Outside that range is treated as unknown. */
  priceLevel?: number | null;
}

// ── Context: the viewer-relative facts WHY SHOWN is allowed to cite ───────────

export interface LivePlaceContext {
  /** Epoch ms. Required — this module never reads the clock itself. */
  now: number;
  /**
   * The user's current §13 Intent, and whether the ranking layer actually
   * matched THIS place to it. `matched: false` (or no intent at all) means the
   * "Matches current intent" reason may not be emitted.
   */
  intent?: { label: string; matched: boolean } | null;
  /** Crew/circle members near this place, per §11/§12. 0 or absent => no claim. */
  crewNearbyCount?: number | null;
  /** Viewer's locale for number/time formatting. */
  locale?: string;
}

// ── Sections ──────────────────────────────────────────────────────────────────

export const LIVE_PLACE_SECTIONS = [
  'hero',
  'live_state',
  'crowd',
  'social',
  'access',
  'why_shown',
  'actions',
  'provenance',
] as const;
export type LivePlaceSectionId = (typeof LIVE_PLACE_SECTIONS)[number];

/** An absent section, and the reason it is absent. Rendered as silence, not text. */
export interface MissingSection {
  section: LivePlaceSectionId;
  reason: string;
}

/** §8 LIVE STATE — "Very Busy · Getting busier / Updated 4 min ago". */
export interface LiveStateSection {
  /** ACTIVITY_LABELS[activity]. Only present because an activity was observed. */
  activity: ActivityLevel;
  activityLabel: string;
  /** null when the projection reported a level but no direction. */
  trend: TrendState | null;
  trendLabel: string | null;
  /** §7 freshness line, e.g. "Updated 4 min ago" / "Last confirmed 1h ago". */
  updatedLabel: string | null;
  freshness: FreshnessState;
  /** §7 certainty, kept as its own axis. */
  confidence: ConfidenceState | null;
  confidenceLabel: string | null;
  /** Only `live`/`recent` may pulse (§6 pulsing outline, §37). */
  isLive: boolean;
}

/** §8 CROWD / TREND / VIBE — the three-row breakdown under LIVE STATE. */
export interface CrowdSection {
  crowdLabel: string | null;
  trendLabel: string | null;
  vibeLabel: string | null;
}

/** §8 SOCIAL. */
export interface SocialSection {
  /** Identified friends. `null` when privacy forbids identity, even if supplied. */
  friendsHere: number | null;
  friendsHereLabel: string | null;
  /** Aggregate interest; permitted at aggregate_only. */
  travelersInterested: number | null;
  travelersInterestedLabel: string | null;
  /** True when a friends count existed but privacyClass suppressed it (§23). */
  suppressed: boolean;
}

/** §8 ACCESS. */
export interface AccessSection {
  queueLabel: string | null;
  openUntilLabel: string | null;
  priceLabel: string | null;
}

/** §8 WHY SHOWN. Codes so the sheet can style them; text for the human. */
export const WHY_SHOWN_CODES = ['matches_intent', 'crew_nearby', 'strong_live_activity'] as const;
export type WhyShownCode = (typeof WHY_SHOWN_CODES)[number];

export interface WhyShownLine {
  code: WhyShownCode;
  text: string;
}

export interface LivePlaceViewModel {
  id: string;
  kind: MapObjectKind;
  title: string;
  /** §8 "Place name · type · distance" — the type and distance halves. */
  placeType: string | null;
  distanceLabel: string | null;
  subtitle: string | null;

  heroPhotoUrl: string | null;
  heroIsMoment: boolean;

  liveState: LiveStateSection | null;
  crowd: CrowdSection | null;
  social: SocialSection | null;
  access: AccessSection | null;
  whyShown: WhyShownLine[];
  actions: MapAction[];
  /** §9 Why? payload. Absent when the projection supplied no provenance. */
  provenance: MapProvenance | null;

  /** Every section that could not be built, with the reason. Never fabricated. */
  missing: MissingSection[];
}

// ── Formatting helpers (pure) ─────────────────────────────────────────────────

/**
 * §7's freshness column in words. Deliberately NOT a generic "x ago": once a
 * claim stops being presentable as live it must read "Last confirmed …", so a
 * stale number can never be mistaken for a live one (§37).
 */
export function formatUpdatedLabel(
  observedAt: string | null | undefined,
  now: number,
  freshness: FreshnessState,
): string | null {
  if (!observedAt) return null;
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return null;

  const live = mayRenderAsLive(freshness);
  const deltaMs = now - t;
  // A future timestamp is a clock disagreement, not a fresher observation.
  const mins = Math.floor(Math.max(0, deltaMs) / 60_000);

  let span: string;
  if (mins < 1) span = 'just now';
  else if (mins < 60) span = `${mins} min ago`;
  else {
    const hours = Math.floor(mins / 60);
    if (hours < 24) span = `${hours}h ago`;
    else span = `${Math.floor(hours / 24)}d ago`;
  }

  if (live) return span === 'just now' ? 'Updated just now' : `Updated ${span}`;
  if (freshness === 'historical') return `Observed ${span}`;
  return span === 'just now' ? 'Last confirmed just now' : `Last confirmed ${span}`;
}

/** §8 "· distance". Metres under a kilometre; never a fake precision. */
export function formatDistanceLabel(distanceKm: number | null | undefined): string | null {
  if (distanceKm == null || !Number.isFinite(distanceKm) || distanceKm < 0) return null;
  if (distanceKm < 1) {
    const m = Math.round(distanceKm * 1000);
    if (m < 10) return 'Right here';
    return `${m} m away`;
  }
  if (distanceKm < 10) return `${distanceKm.toFixed(1)} km away`;
  return `${Math.round(distanceKm)} km away`;
}

/** §8 "Price $$$". Anything outside 1-4 is unknown, not clamped. */
export function formatPriceLabel(priceLevel: number | null | undefined): string | null {
  if (priceLevel == null || !Number.isInteger(priceLevel)) return null;
  if (priceLevel < 1 || priceLevel > 4) return null;
  return '$'.repeat(priceLevel);
}

/** §8 "Queue ~20 min". */
export function formatQueueLabel(queueMinutes: number | null | undefined): string | null {
  if (queueMinutes == null || !Number.isFinite(queueMinutes) || queueMinutes < 0) return null;
  if (queueMinutes < 1) return 'No queue';
  return `Queue ~${Math.round(queueMinutes)} min`;
}

// ── WHY SHOWN (§8) ────────────────────────────────────────────────────────────

/**
 * §8's WHY SHOWN block. Emits ONLY reasons the inputs actually support:
 *
 *  - "Matches current intent" needs an intent AND a ranking-layer match. The
 *    client does not decide what matches (§19: "The mobile client should not
 *    independently reconstruct Portava intelligence rules") — it is told.
 *  - "Crew nearby" needs at least one crew member near this place.
 *  - "Strong live activity" needs all three of: a busy-or-above ACTIVITY, a
 *    strong CERTAINTY band, and a FRESHNESS that may still render as live.
 *    Any one of those missing and the claim is not supported — a busy reading
 *    from an hour ago is not "strong live activity".
 *
 * An empty array is a legitimate result: the place is shown, and Portava has
 * nothing honest to say about why. The sheet then omits the block entirely.
 */
export function whyShownLines(
  obj: MapObject,
  ctx: LivePlaceContext,
): WhyShownLine[] {
  const lines: WhyShownLine[] = [];

  const intent = ctx.intent;
  if (intent && intent.matched === true && typeof intent.label === 'string' && intent.label.trim() !== '') {
    lines.push({ code: 'matches_intent', text: `Matches current intent · ${intent.label.trim()}` });
  }

  const crew = ctx.crewNearbyCount ?? 0;
  if (Number.isFinite(crew) && crew > 0) {
    lines.push({
      code: 'crew_nearby',
      text: crew === 1 ? 'Crew nearby' : `Crew nearby · ${crew} members`,
    });
  }

  if (hasStrongLiveActivity(obj)) {
    lines.push({ code: 'strong_live_activity', text: 'Strong live activity' });
  }

  return lines;
}

const BUSY_ENOUGH: readonly ActivityLevel[] = ['busy', 'very_busy', 'peak'];
const STRONG_ENOUGH: readonly ConfidenceState[] = ['live', 'strong'];

/** All three axes of §7 must agree before "strong live activity" is honest. */
export function hasStrongLiveActivity(obj: MapObject): boolean {
  if (!obj.activity || !BUSY_ENOUGH.includes(obj.activity)) return false;
  if (!obj.confidence || !STRONG_ENOUGH.includes(obj.confidence)) return false;
  return mayRenderAsLive(obj.freshness);
}

// ── Actions (§8, §25) ─────────────────────────────────────────────────────────

/** §8's ACTIONS row, in the order the spec prints it. */
export const LIVE_PLACE_ACTION_ORDER: readonly MapAction[] = [
  'navigate',
  'save',
  'ask_compass',
  'add_to_trip',
  'meet_here',
  'share',
  'contribute',
  'report',
  'view',
  'join',
  'follow',
  'book',
  'message',
  'block',
  'create_checkpoint',
];

export const LIVE_PLACE_ACTION_LABELS: Record<MapAction, string> = {
  navigate: 'Go',
  save: 'Save',
  ask_compass: 'Ask Compass',
  add_to_trip: 'Add to Trip',
  meet_here: 'Meet Here',
  share: 'Share',
  contribute: 'Add what you see',
  report: 'Report',
  view: 'View',
  join: 'Join',
  follow: 'Follow',
  book: 'Book',
  message: 'Message',
  block: 'Block',
  create_checkpoint: 'Create checkpoint',
};

/**
 * The actions this object declares, de-duplicated and ordered per §8. These are
 * CAPABILITY HINTS only — the contract is explicit that every action
 * re-authorizes server-side, so nothing here is a permission decision. An
 * object with no `interaction` offers no actions rather than a guessed default
 * set: guessing would render a "Meet Here" button for a place that cannot host
 * a meeting point.
 */
export function orderedActions(obj: MapObject): MapAction[] {
  const declared = obj.interaction?.actions;
  if (!Array.isArray(declared) || declared.length === 0) return [];
  const wanted = new Set(declared);
  return LIVE_PLACE_ACTION_ORDER.filter((a) => wanted.has(a));
}

// ── The view model ────────────────────────────────────────────────────────────

/**
 * Build the §8 view model. Returns `null` for an object that must not render at
 * all (`isRenderable` — no geometry, no title, or `privacyClass: 'none'`).
 */
export function buildLivePlaceView(
  obj: MapObject,
  detail: LivePlaceDetail | null | undefined,
  ctx: LivePlaceContext,
): LivePlaceViewModel | null {
  if (!isRenderable(obj)) return null;

  const d: LivePlaceDetail = detail ?? {};
  const missing: MissingSection[] = [];
  const absent = (section: LivePlaceSectionId, reason: string) => {
    missing.push({ section, reason });
    return null;
  };

  // ── Hero ────────────────────────────────────────────────────────────────
  const heroPhotoUrl =
    typeof d.heroPhotoUrl === 'string' && d.heroPhotoUrl.trim() !== '' ? d.heroPhotoUrl : null;
  if (!heroPhotoUrl) missing.push({ section: 'hero', reason: 'No photo or recent Moment for this place' });

  // ── LIVE STATE ──────────────────────────────────────────────────────────
  // Requires an OBSERVED activity level. Without one there is no live state —
  // not "Quiet". Trend, freshness and confidence are separate §7 axes and each
  // may independently be missing.
  const freshness: FreshnessState = obj.freshness ?? 'unknown';
  let liveState: LiveStateSection | null;
  if (!obj.activity) {
    liveState = absent('live_state', 'No live activity has been observed here');
  } else if (freshness === 'stale' || freshness === 'unknown') {
    // A reading we can no longer stand behind is not a live state. §37: "Do not
    // let stale claims remain visually live." It stays available through the
    // CROWD block's last-known reading, clearly dated, and through §9 Why?.
    liveState = absent(
      'live_state',
      freshness === 'unknown'
        ? 'This reading has no timestamp, so it is not presented as current'
        : 'The last reading here is too old to present as current',
    );
  } else {
    liveState = {
      activity: obj.activity,
      activityLabel: ACTIVITY_LABELS[obj.activity],
      trend: obj.trend ?? null,
      trendLabel: obj.trend ? TREND_LABELS[obj.trend] : null,
      updatedLabel: formatUpdatedLabel(obj.observedAt, ctx.now, freshness),
      freshness,
      confidence: obj.confidence ?? null,
      confidenceLabel: obj.confidence ? CONFIDENCE_LABELS[obj.confidence] : null,
      isLive: mayRenderAsLive(freshness),
    };
  }

  // ── CROWD / TREND / VIBE ────────────────────────────────────────────────
  const crowdLabel = obj.activity ? ACTIVITY_LABELS[obj.activity] : null;
  const crowdTrendLabel = obj.trend ? TREND_LABELS[obj.trend] : null;
  const vibeLabel = typeof d.vibe === 'string' && d.vibe.trim() !== '' ? d.vibe.trim() : null;
  const crowd: CrowdSection | null =
    crowdLabel || crowdTrendLabel || vibeLabel
      ? { crowdLabel, trendLabel: crowdTrendLabel, vibeLabel }
      : absent('crowd', 'No crowd, trend or vibe reading for this place');

  // ── SOCIAL (§23 privacy gate) ───────────────────────────────────────────
  const identityAllowed = mayRenderIdentity(obj.privacyClass);
  const rawFriends = countOrNull(d.friendsHereCount);
  const friendsHere = identityAllowed ? rawFriends : null;
  const suppressed = !identityAllowed && rawFriends != null && rawFriends > 0;
  const travelersInterested = countOrNull(d.travelersInterestedCount);

  const hasFriends = friendsHere != null && friendsHere > 0;
  const hasTravelers = travelersInterested != null && travelersInterested > 0;
  const social: SocialSection | null =
    hasFriends || hasTravelers
      ? {
          friendsHere: hasFriends ? friendsHere : null,
          friendsHereLabel: hasFriends
            ? `${friendsHere} ${friendsHere === 1 ? 'friend' : 'friends'} here`
            : null,
          travelersInterested: hasTravelers ? travelersInterested : null,
          travelersInterestedLabel: hasTravelers
            ? `${travelersInterested} ${travelersInterested === 1 ? 'traveler' : 'travelers'} interested`
            : null,
          suppressed,
        }
      : absent(
          'social',
          suppressed
            ? 'Presence here is shown in aggregate only'
            : 'Nobody you know is here and no interest has been recorded',
        );

  // ── ACCESS ──────────────────────────────────────────────────────────────
  const queueLabel = formatQueueLabel(d.queueMinutes);
  const openUntilLabel =
    typeof d.openUntil === 'string' && d.openUntil.trim() !== '' ? `Open until ${d.openUntil.trim()}` : null;
  const priceLabel = formatPriceLabel(d.priceLevel);
  const access: AccessSection | null =
    queueLabel || openUntilLabel || priceLabel
      ? { queueLabel, openUntilLabel, priceLabel }
      : absent('access', 'No queue, hours or price information for this place');

  // ── WHY SHOWN ───────────────────────────────────────────────────────────
  const whyShown = whyShownLines(obj, ctx);
  if (whyShown.length === 0) {
    missing.push({ section: 'why_shown', reason: 'No supported reason to explain this pick' });
  }

  // ── ACTIONS ─────────────────────────────────────────────────────────────
  const actions = orderedActions(obj);
  if (actions.length === 0) {
    missing.push({ section: 'actions', reason: 'This object declares no actions' });
  }

  // ── §9 provenance ───────────────────────────────────────────────────────
  const provenance =
    obj.provenance && Array.isArray(obj.provenance.lines) && obj.provenance.lines.length > 0
      ? obj.provenance
      : absent('provenance', 'No evidence trail was supplied for this claim');

  return {
    id: obj.id,
    kind: obj.kind,
    title: obj.title,
    placeType: typeof d.placeType === 'string' && d.placeType.trim() !== '' ? d.placeType.trim() : null,
    distanceLabel: formatDistanceLabel(obj.distanceKm),
    subtitle: typeof obj.subtitle === 'string' && obj.subtitle.trim() !== '' ? obj.subtitle : null,
    heroPhotoUrl,
    heroIsMoment: heroPhotoUrl != null && d.heroIsMoment === true,
    liveState,
    crowd,
    social,
    access,
    whyShown,
    actions,
    provenance,
    missing,
  };
}

function countOrNull(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** Did a given section fail to build? Convenience for the sheet. */
export function isSectionMissing(vm: LivePlaceViewModel, section: LivePlaceSectionId): boolean {
  return vm.missing.some((m) => m.section === section);
}

/** The reason a section is missing, for a §22 contribution prompt. */
export function missingReason(
  vm: LivePlaceViewModel,
  section: LivePlaceSectionId,
): string | null {
  return vm.missing.find((m) => m.section === section)?.reason ?? null;
}

/** §8's one-line header under the title: "Bar · 400 m away". */
export function placeMetaLine(vm: LivePlaceViewModel): string | null {
  const parts = [vm.placeType, vm.distanceLabel].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** §8's LIVE STATE headline: "Very Busy · Getting busier". */
export function liveStateHeadline(section: LiveStateSection | null): string | null {
  if (!section) return null;
  return section.trendLabel
    ? `${section.activityLabel} · ${section.trendLabel}`
    : section.activityLabel;
}
