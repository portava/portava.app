/**
 * presenceLadder — spec §23's LocationVisibility ladder, as enforceable code.
 *
 * WHY THIS MODULE EXISTS
 * ======================
 * §37 names two things Portava must never become:
 *
 *     "Do not build a public real-time people tracker."
 *     "Do not create permanent exact-location sharing."
 *
 * A comment cannot enforce either. This module turns §23 into arithmetic on an
 * ORDERED ladder where the only combinator NARROWS, so the unsafe states are
 * unrepresentable rather than merely unlikely:
 *
 *   - There is no `widen`. Every combination routes through the contract's
 *     `narrowestPrivacyClass`, so adding a constraint can only tighten.
 *   - Every purpose has a ceiling, and a purpose the table does not know
 *     FAILS CLOSED to `none` rather than defaulting to whatever was requested.
 *   - Elapsed time can only lower precision (`decay` is monotonic, proven by a
 *     property test over the full ladder × time cross-product).
 *   - Elevation above a purpose's ungranted ceiling requires an explicit,
 *     opted-in, group-scoped, unexpired grant. Absent any one of those four,
 *     the elevation does not happen.
 *
 * WHAT THIS IS NOT
 * ================
 * Pure data + pure functions. No storage, no network, no React, no clock of its
 * own — every time-dependent function takes `now`/`elapsed` explicitly so
 * boundary behaviour is testable rather than flaky.
 *
 * This module DECIDES A CEILING. It never sharpens a coordinate, and nothing
 * downstream of it may either (see `mapObjects.ts`, "COORDINATE CONTRACT").
 *
 * RELATIONSHIP TO THE SERVER'S PRESENCE DOMAIN (Phase-0, §52)
 * ==========================================================
 * `artifacts/api-server/src/presence/domain/types.ts` already owns a precision
 * ladder. The app and the API server are separate packages with no shared
 * build, so — exactly as `src/types/mapObjects.ts` does for the map contract —
 * the server's constants are MIRRORED here, never re-invented, and the
 * translation between the two ladders is explicit and conservative.
 *
 * The two ladders genuinely DISAGREE about one pair of rungs; see
 * `LADDER_DISAGREEMENTS` below. That disagreement is resolved here in the safe
 * direction and is flagged rather than papered over.
 */

import {
  PRIVACY_CLASSES,
  precisionRank,
  narrowestPrivacyClass,
  mayRenderIdentity,
  type PrivacyClass,
  type FreshnessState,
} from '../../../types/mapObjects.ts';
// Type-only: erased at runtime, so this file stays loadable in node:test even
// though services/map.ts pulls in the network layer.
import type { LocationVisibility as StoredLocationVisibility } from '../../../services/map.ts';

export {
  PRIVACY_CLASSES,
  precisionRank,
  narrowestPrivacyClass,
  mayRenderIdentity,
};
export type { PrivacyClass, FreshnessState };

// ── §23's enum, expressed against the contract ────────────────────────────────

/**
 * Spec §23, verbatim:
 *
 *     enum LocationVisibility { NONE, AGGREGATE_ONLY, APPROXIMATE,
 *                               PLACE_LEVEL, PRECISE_TEMPORARY }
 *
 * The contract's `PrivacyClass` is this enum in the codebase's own casing, so
 * this table is the 1:1 bridge from the spec's identifiers to the wire values.
 * It exists so a reader can check the implementation against §23 by eye, and so
 * spec-shaped input (config, docs, server enums) has exactly one way in.
 */
export const LOCATION_VISIBILITY = {
  NONE: 'none',
  AGGREGATE_ONLY: 'aggregate_only',
  APPROXIMATE: 'approximate',
  PLACE_LEVEL: 'place_level',
  PRECISE_TEMPORARY: 'precise_temporary',
} as const satisfies Record<string, PrivacyClass>;

export type SpecLocationVisibility = keyof typeof LOCATION_VISIBILITY;

/** Parse a §23 enum identifier. Anything unrecognised FAILS CLOSED to `none`. */
export function privacyClassFromVisibility(
  visibility: string | null | undefined,
): PrivacyClass {
  if (typeof visibility !== 'string') return 'none';
  const hit = (LOCATION_VISIBILITY as Record<string, PrivacyClass>)[visibility];
  return hit ?? 'none';
}

/** The narrowest of any number of bounds. Empty input FAILS CLOSED to `none`. */
export function narrowestOf(...classes: readonly PrivacyClass[]): PrivacyClass {
  if (classes.length === 0) return 'none';
  return classes.reduce((a, b) => narrowestPrivacyClass(a, b));
}

// ── Mirror of the server's §52 precision ladder ───────────────────────────────

/**
 * MIRROR of `artifacts/api-server/src/presence/domain/types.ts`
 * `PRECISION_LADDER`. Ordered least → most revealing; the order is load-bearing
 * on both sides. Kept as a copy for the same reason `mapObjects.ts` is a copy:
 * the two packages have no shared build.
 */
export const PRECISION_LADDER = [
  'none',
  'presence_only',
  'venue',
  'zone',
  'approximate',
  'nearby',
  'precise',
] as const;
export type LocationPrecision = (typeof PRECISION_LADDER)[number];

/**
 * The server calls this `precisionRank`. That name is already taken in this
 * file by the map contract's rank over `PrivacyClass`, and the two operate on
 * DIFFERENT ladders — silently overloading one name across two orderings is
 * precisely how a precision leak gets written. Hence the explicit prefix.
 */
export function serverPrecisionRank(p: LocationPrecision): number {
  return PRECISION_LADDER.indexOf(p);
}

/** MIRROR of the server's `narrowestPrecision`. No widening counterpart exists. */
export function narrowestPrecision(
  requested: LocationPrecision,
  allowedByPolicy: LocationPrecision,
): LocationPrecision {
  return serverPrecisionRank(requested) <= serverPrecisionRank(allowedByPolicy)
    ? requested
    : allowedByPolicy;
}

/** MIRROR of the server's `FEATURE_PRECISION_CEILING` (§52). */
export const FEATURE_PRECISION_CEILING = {
  crowd_intelligence: 'presence_only',
  bump: 'zone',
  crew: 'precise',
  proof_of_presence: 'presence_only',
} as const satisfies Record<string, LocationPrecision>;

/** MIRROR of the server's §10 estimate states. */
export const ESTIMATE_STATES = [
  'precise',
  'nearby',
  'relayed',
  'recent',
  'inferred',
  'predicted',
  'last_known',
  'unknown',
] as const;
export type PresenceEstimateState = (typeof ESTIMATE_STATES)[number];

const LIVE_ESTIMATE_STATES: ReadonlySet<PresenceEstimateState> = new Set([
  'precise',
  'nearby',
  'relayed',
]);

/** MIRROR of the server's `isLiveState`: may this be shown as a CURRENT position? */
export function isLiveState(s: PresenceEstimateState): boolean {
  return LIVE_ESTIMATE_STATES.has(s);
}

/** MIRROR of the server's `PresenceCapabilities` (§71). */
export interface PresenceCapabilities {
  bleScan: boolean;
  bleAdvertise: boolean;
  backgroundBle: boolean;
  backgroundLocation: boolean;
  uwb: boolean;
  localPeer: boolean;
}

/**
 * MIRROR of the server's `CURRENT_STACK_CAPABILITIES` (verified 2026-08-28).
 * BLE is entirely absent from today's Portava stack, which is why §12's
 * "local device proximity" and "peer relay" rungs are currently unreachable —
 * see `unsupportedRungs()` in `locateFriends.ts`. Nothing here assumes a radio.
 */
export const CURRENT_STACK_CAPABILITIES: PresenceCapabilities = {
  bleScan: false,
  bleAdvertise: false,
  backgroundBle: false,
  backgroundLocation: true,
  uwb: false,
  localPeer: false,
};

// ── Translating the server's ladder into §23's ────────────────────────────────

/**
 * What each server rung MEANS in §23 vocabulary, ignoring rung order. This is
 * the semantic reading, and is the right table when you are LABELLING an
 * estimate the server already produced.
 */
export const PRECISION_SEMANTIC_EQUIVALENT = {
  none: 'none',
  presence_only: 'aggregate_only',
  venue: 'place_level',
  zone: 'approximate',
  approximate: 'approximate',
  nearby: 'approximate',
  precise: 'precise_temporary',
} as const satisfies Record<LocationPrecision, PrivacyClass>;

/**
 * The two ladders disagree, and the disagreement is recorded rather than hidden.
 *
 * The server ranks `venue` (2) BELOW `zone` (3) — reading a zone as a smaller,
 * more revealing unit than a whole venue. §23 ranks `PLACE_LEVEL` ABOVE
 * `APPROXIMATE` — reading a named place as more revealing than an area. Both
 * readings are defensible; they cannot both be applied at once.
 *
 * Until the server's ladder and §23 are reconciled by a deliberate decision,
 * anything that arrives from the server as a POLICY CEILING is translated
 * through `PRECISION_AS_CEILING` below, which resolves the conflict in the only
 * direction that cannot leak: whichever reading is narrower wins.
 */
export const LADDER_DISAGREEMENTS: readonly string[] = [
  "server PRECISION_LADDER ranks 'venue' below 'zone'; spec §23 ranks 'place_level' above 'approximate'. " +
    "A server 'venue' ceiling is therefore translated conservatively to 'approximate', not 'place_level'.",
  "server exports precisionRank() over LocationPrecision; the map contract exports precisionRank() over PrivacyClass. " +
    'Mirrored here as serverPrecisionRank() so the two orderings can never be confused at a call site.',
];

/**
 * Translate a server-supplied POLICY CEILING into a §23 rung.
 *
 * Conservative by construction: monotone non-decreasing along the server's own
 * ladder AND never above `PRECISION_SEMANTIC_EQUIVALENT`. The `venue → approximate`
 * entry is the one place those two requirements pull apart, and safety wins —
 * see `LADDER_DISAGREEMENTS`.
 *
 * Unknown input FAILS CLOSED to `none`.
 */
export const PRECISION_AS_CEILING = {
  none: 'none',
  presence_only: 'aggregate_only',
  venue: 'approximate',
  zone: 'approximate',
  approximate: 'approximate',
  nearby: 'approximate',
  precise: 'precise_temporary',
} as const satisfies Record<LocationPrecision, PrivacyClass>;

export function ceilingFromServerPrecision(
  p: LocationPrecision | string | null | undefined,
): PrivacyClass {
  if (typeof p !== 'string') return 'none';
  const hit = (PRECISION_AS_CEILING as Record<string, PrivacyClass>)[p];
  return hit ?? 'none';
}

// ── The viewer's own stored location-privacy preference ───────────────────────

/**
 * `services/map.ts` persists the viewer's preference in a THIRD vocabulary
 * (`LocationVisibility` = city_only | neighborhood | venue_tagged |
 * exact_hidden | no_location). That vocabulary predates §23 and is a stored
 * user preference, not a ladder — so it is mapped in, never redefined.
 *
 * `exact_hidden` means "we hold an exact fix that must not be exposed", which
 * is `approximate`, NOT `place_level`.
 */
export const STORED_VISIBILITY_AS_PRIVACY_CLASS = {
  no_location: 'none',
  city_only: 'aggregate_only',
  neighborhood: 'approximate',
  exact_hidden: 'approximate',
  venue_tagged: 'place_level',
} as const satisfies Record<StoredLocationVisibility, PrivacyClass>;

/** Unknown / null stored visibility FAILS CLOSED to `none`. */
export function privacyClassFromStoredVisibility(
  v: StoredLocationVisibility | string | null | undefined,
): PrivacyClass {
  if (typeof v !== 'string') return 'none';
  const hit = (STORED_VISIBILITY_AS_PRIVACY_CLASS as Record<string, PrivacyClass>)[v];
  return hit ?? 'none';
}

/** `services/map.ts` LocationMode, as a ceiling. Unknown FAILS CLOSED to `none`. */
export const LOCATION_MODE_CEILING = {
  off: 'none',
  city_only: 'aggregate_only',
  nearby: 'approximate',
  live_during_activity: 'place_level',
  trusted_circle_live: 'precise_temporary',
} as const satisfies Record<string, PrivacyClass>;

/**
 * The ceiling implied by the viewer's own stored privacy settings.
 * `sharingPaused` is absolute: a paused user shares nothing, whatever else the
 * record says.
 */
export function ceilingFromLocationPrivacy(prefs: {
  locationMode?: string | null;
  sharingPaused?: boolean | null;
} | null | undefined): PrivacyClass {
  if (!prefs) return 'none';
  if (prefs.sharingPaused === true) return 'none';
  if (typeof prefs.locationMode !== 'string') return 'none';
  const hit = (LOCATION_MODE_CEILING as Record<string, PrivacyClass>)[prefs.locationMode];
  return hit ?? 'none';
}

// ── §23's five purposes ───────────────────────────────────────────────────────

/**
 * The five audiences §23 enumerates, in the spec's own order:
 *
 *     Public stranger:      aggregate only.
 *     Shared Moment:        place-level or delayed.
 *     Trip Crew:            approximate or permitted temporary precise.
 *     Locate My Friends:    temporary group-scoped approximate/precise.
 *     Safe Return:          purpose-bound precise location.
 */
export const PRESENCE_PURPOSES = [
  'public_stranger',
  'shared_moment',
  'trip_crew',
  'locate_my_friends',
  'safe_return',
] as const;
export type PresencePurpose = (typeof PRESENCE_PURPOSES)[number];

export interface PurposeCeiling {
  /** The most this purpose may EVER reach with no explicit grant in force. */
  readonly ungranted: PrivacyClass;
  /** The most this purpose may reach WITH a live, opted-in, scoped grant. */
  readonly granted: PrivacyClass;
  /** The §23 line this row implements. */
  readonly rule: string;
}

/**
 * §23's table. Two columns, because three of the five purposes are written as
 * "X or permitted Y" — the permission is what separates the columns, and
 * modelling it as one number would either over-share by default or make the
 * permitted case unreachable.
 *
 * `safe_return` is ungranted-`none` deliberately: "purpose-bound precise
 * location" means the precision exists only while a Safe Return is actually
 * running. With no active grant there is no Safe Return, and therefore nothing
 * to render — not a quieter version of the same thing.
 *
 * `public_stranger` has no granted column above `aggregate_only`, and that is
 * not an oversight: §37 forbids a public real-time people tracker, so there is
 * no grant a stranger can hold that raises it.
 */
export const PURPOSE_CEILINGS = {
  public_stranger: {
    ungranted: 'aggregate_only',
    granted: 'aggregate_only',
    rule: '§23 "Public stranger: aggregate only." §37 forbids any grant that raises this.',
  },
  shared_moment: {
    ungranted: 'place_level',
    granted: 'place_level',
    rule: '§23 "Shared Moment: place-level or delayed." Delay is a freshness choice, not extra precision.',
  },
  trip_crew: {
    ungranted: 'approximate',
    granted: 'precise_temporary',
    rule: '§23 "Trip Crew: approximate or permitted temporary precise."',
  },
  locate_my_friends: {
    ungranted: 'approximate',
    granted: 'precise_temporary',
    rule: '§23 "Locate My Friends: temporary group-scoped approximate/precise."',
  },
  safe_return: {
    ungranted: 'none',
    granted: 'precise_temporary',
    rule: '§23 "Safe Return: purpose-bound precise location." No active purpose ⇒ no location.',
  },
} as const satisfies Record<PresencePurpose, PurposeCeiling>;

/** Fail-closed row for any purpose the table does not know. */
export const UNKNOWN_PURPOSE_CEILING: PurposeCeiling = {
  ungranted: 'none',
  granted: 'none',
  rule: 'Unknown purpose. §23 enumerates the audiences exhaustively; anything else gets nothing.',
};

export function purposeCeilingRow(purpose: string | null | undefined): PurposeCeiling {
  if (typeof purpose !== 'string') return UNKNOWN_PURPOSE_CEILING;
  const hit = (PURPOSE_CEILINGS as Record<string, PurposeCeiling>)[purpose];
  return hit ?? UNKNOWN_PURPOSE_CEILING;
}

// ── Grants ────────────────────────────────────────────────────────────────────

/**
 * An explicit permission to exceed a purpose's ungranted ceiling.
 *
 * All four fields are load-bearing and all four are checked. §12: "Opt-in
 * only. Group-scoped. Temporary and auto-expiring." — `optedIn`, `scopeId` and
 * `expiresAt` are those three sentences; `purpose` is §24's "purpose-bound".
 */
export interface PrecisionGrant {
  /** The purpose this grant was given FOR. A grant is not transferable. */
  purpose: PresencePurpose;
  /** Explicit opt-in. Anything but `true` grants nothing. */
  optedIn: boolean;
  /** The group/session this grant is scoped to. Absent ⇒ ungrouped ⇒ nothing. */
  scopeId: string | null;
  /** The rung the subject actually agreed to expose. */
  grantedClass: PrivacyClass;
  /** Mandatory hard stop, epoch ms. §37: no permanent exact-location sharing. */
  expiresAt: number;
}

/** A grant is live only when opted in, scoped, and not yet expired. */
export function isGrantLive(
  grant: PrecisionGrant | null | undefined,
  now: number,
): boolean {
  if (!grant) return false;
  if (grant.optedIn !== true) return false;
  if (typeof grant.scopeId !== 'string' || grant.scopeId.trim() === '') return false;
  if (!Number.isFinite(grant.expiresAt)) return false;
  if (!Number.isFinite(now)) return false;
  return now < grant.expiresAt;
}

/** A grant applies only to its own purpose, and only while live. */
export function grantApplies(
  grant: PrecisionGrant | null | undefined,
  purpose: string | null | undefined,
  now: number,
): boolean {
  if (!isGrantLive(grant, now)) return false;
  return grant!.purpose === purpose;
}

// ── ceilingForPurpose ─────────────────────────────────────────────────────────

/**
 * The most precise rung `purpose` may reach right now.
 *
 * With no applicable grant this is the purpose's ungranted column. With one, it
 * is the narrower of the purpose's granted column and what the grant actually
 * granted — a grant can never hand out more than §23 allows the purpose, and
 * §23 can never hand out more than the subject agreed to.
 *
 * A purpose the table does not know returns `none` whether or not a grant is
 * supplied. That is the fail-closed rule §37 requires: an unrecognised audience
 * is not a lenient default, it is no audience at all.
 */
export function ceilingForPurpose(
  purpose: PresencePurpose | string | null | undefined,
  grant: PrecisionGrant | null = null,
  // No clock supplied ⇒ NaN ⇒ `isGrantLive` is false ⇒ the ungranted column
  // applies. A caller who forgets the clock gets the SAFE answer, not the
  // permissive one; defaulting to 0 would have made every future-dated grant
  // look live.
  now: number = Number.NaN,
): PrivacyClass {
  const row = purposeCeilingRow(purpose);
  if (row === UNKNOWN_PURPOSE_CEILING) return 'none';
  if (!grantApplies(grant, purpose, now)) return row.ungranted;
  return narrowestOf(row.granted, grant!.grantedClass);
}

// ── applyCeiling ──────────────────────────────────────────────────────────────

export interface ApplyCeilingOptions {
  /** Clock, epoch ms. Required for grant expiry to mean anything. */
  now?: number;
  /**
   * Any further bounds in force — the viewer's stored preference, a
   * server-supplied policy ceiling, a §24 protected-zone suppression, the
   * decay stage. Order is irrelevant; the result is the narrowest of all.
   */
  additionalBounds?: readonly PrivacyClass[];
}

/**
 * §23's whole rule as one function: the effective rung is the NARROWEST of
 * everything that applies.
 *
 * There is deliberately no counterpart that takes a maximum. Combining
 * constraints can only tighten — which is the property the tests assert over
 * the full ladder cross-product, not just the cases anyone thought to write.
 */
export function applyCeiling(
  requested: PrivacyClass,
  purpose: PresencePurpose | string | null | undefined,
  grant: PrecisionGrant | null = null,
  options: ApplyCeilingOptions = {},
): PrivacyClass {
  // An unusable clock is not a reason to be generous — see `ceilingForPurpose`.
  const now = Number.isFinite(options.now) ? (options.now as number) : Number.NaN;
  const bounds: PrivacyClass[] = [
    requested,
    ceilingForPurpose(purpose, grant, now),
  ];
  if (grantApplies(grant, purpose, now)) bounds.push(grant!.grantedClass);
  for (const extra of options.additionalBounds ?? []) bounds.push(extra);
  return narrowestOf(...bounds);
}

// ── §23 decay ─────────────────────────────────────────────────────────────────

/**
 * §23: "Temporary location should decay automatically:
 *       Precise → Approximate → Last known → Expired."
 *
 * Four named stages, in that order. `last_known` is NOT a fifth precision rung —
 * it is the same geographic precision as `approximate` with the freshness
 * removed, which is why the stage carries both a `PrivacyClass` and a
 * `FreshnessState`. Conflating "how precise" with "how current" is how a stale
 * pin becomes a live one (the same failure the server's `PresenceEstimate`
 * splits `confidence` from `freshness` to avoid).
 */
export const DECAY_STAGES = ['precise', 'approximate', 'last_known', 'expired'] as const;
export type DecayStage = (typeof DECAY_STAGES)[number];

/**
 * Named intervals, measured from the observation. Cumulative boundaries are
 * derived below so the two can never drift apart.
 *
 *   0        → 5 min    precise
 *   5 min    → 30 min   approximate
 *   30 min   → 60 min   last known
 *   60 min   →          expired
 */
export const DECAY_INTERVALS_MS = {
  /** How long a precise temporary fix stays precise. */
  preciseHoldMs: 5 * 60_000,
  /** How long it then stays presentable as an approximate live position. */
  approximateHoldMs: 25 * 60_000,
  /** How long it then survives as a "last seen" record before expiring. */
  lastKnownHoldMs: 30 * 60_000,
} as const;

/** Cumulative upper bound (exclusive) of each non-terminal stage. */
export const DECAY_BOUNDARIES_MS = {
  precise: DECAY_INTERVALS_MS.preciseHoldMs,
  approximate:
    DECAY_INTERVALS_MS.preciseHoldMs + DECAY_INTERVALS_MS.approximateHoldMs,
  last_known:
    DECAY_INTERVALS_MS.preciseHoldMs +
    DECAY_INTERVALS_MS.approximateHoldMs +
    DECAY_INTERVALS_MS.lastKnownHoldMs,
} as const;

/** The ceiling each stage imposes. Non-increasing down the stage order. */
export const DECAY_STAGE_CEILING = {
  precise: 'precise_temporary',
  approximate: 'approximate',
  last_known: 'approximate',
  expired: 'none',
} as const satisfies Record<DecayStage, PrivacyClass>;

/** The freshness each stage carries. `last_known` is explicitly NOT live. */
export const DECAY_STAGE_FRESHNESS = {
  precise: 'live',
  approximate: 'recent',
  last_known: 'stale',
  expired: 'historical',
} as const satisfies Record<DecayStage, FreshnessState>;

/**
 * Which stage an observation of the given age sits in.
 *
 * A non-finite age is treated as `expired`: if we cannot say how old a fix is,
 * we do not get to present it as current (§37: "Do not let stale claims remain
 * visually live"). A negative age — clock skew, a device clock ahead of ours —
 * is clamped to 0, which is safe because stage 0's ceiling is exactly the
 * caller's own input class and therefore raises nothing.
 */
export function decayStageAt(elapsedMs: number): DecayStage {
  if (!Number.isFinite(elapsedMs)) return 'expired';
  const e = elapsedMs < 0 ? 0 : elapsedMs;
  if (e < DECAY_BOUNDARIES_MS.precise) return 'precise';
  if (e < DECAY_BOUNDARIES_MS.approximate) return 'approximate';
  if (e < DECAY_BOUNDARIES_MS.last_known) return 'last_known';
  return 'expired';
}

export interface DecayResult {
  stage: DecayStage;
  /** Never more precise than the class handed in. */
  privacyClass: PrivacyClass;
  freshness: FreshnessState;
  /** The clamped age used, for display ("Last seen 3m ago"). */
  ageMs: number;
}

/**
 * Decay `cls` by `elapsedMs`.
 *
 * The result is `narrowestPrivacyClass(cls, stageCeiling)`, which gives two
 * properties for free and both are tested directly:
 *
 *   1. MONOTONIC — elapsed time can never raise precision, because the stage
 *      ceilings are non-increasing and `narrowest` never widens.
 *   2. BOUNDED   — decay never returns something more precise than its input,
 *      so feeding an already-coarsened class through it is always safe.
 */
export function decay(cls: PrivacyClass, elapsedMs: number): DecayResult {
  const stage = decayStageAt(elapsedMs);
  const ageMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : Number.POSITIVE_INFINITY;
  return {
    stage,
    privacyClass: narrowestPrivacyClass(cls, DECAY_STAGE_CEILING[stage]),
    freshness: DECAY_STAGE_FRESHNESS[stage],
    ageMs,
  };
}

/**
 * Convenience for the common composition: decay first, then apply every
 * standing bound. Written as one function so a caller cannot accidentally
 * apply the ceiling and then forget the decay.
 */
export function effectiveClass(
  requested: PrivacyClass,
  elapsedMs: number,
  purpose: PresencePurpose | string | null | undefined,
  grant: PrecisionGrant | null = null,
  options: ApplyCeilingOptions = {},
): DecayResult {
  const decayed = decay(requested, elapsedMs);
  return {
    ...decayed,
    privacyClass: applyCeiling(decayed.privacyClass, purpose, grant, options),
  };
}
