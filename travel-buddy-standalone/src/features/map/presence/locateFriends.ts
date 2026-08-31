/**
 * locateFriends — spec §12 "Locate My Friends".
 *
 * WHAT §12 ASKS FOR
 * =================
 *     "Locate My Friends is a specialized temporary group/event map. It should
 *      support networked and degraded/offline operation, approximate location
 *      and explicit checkpoints."
 *
 *     Preferred signal sequence
 *       1. Normal network location
 *       2. Event-local cached location
 *       3. Local device proximity
 *       4. Peer relay / checkpoint
 *       5. Last-known location
 *       6. Manual checkpoint
 *
 *     "Opt-in only. Group-scoped. Temporary and auto-expiring.
 *      No public friend tracking."
 *
 *     "UI may display states such as Nearby ~40-80m, Last seen 3m ago, or
 *      Checkpoint: Food Court."
 *
 * HOW THIS MODULE ENFORCES IT
 * ===========================
 * The four constraints are structural, not documented:
 *
 *   OPT-IN ONLY      `resolveMember` returns the `none` rung for any member not
 *                    in `optedInMemberIds`. There is no path that renders a
 *                    member who did not opt in.
 *   GROUP-SCOPED     `groupId` is a required, non-empty field validated by the
 *                    only constructor. A session with no group cannot exist.
 *   AUTO-EXPIRING    `expiresAt` is a required `number` on the validated input,
 *                    bounded by `MAX_SESSION_MS`, and `LocateSession` has a
 *                    PRIVATE constructor — so an unbounded session is not
 *                    constructible, from this module or any other.
 *   NO PUBLIC        Nothing here takes a viewer outside the session. Every
 *   TRACKING         read is `(session, member)`; there is no global query.
 *
 * THE FALLBACK CHAIN
 * ==================
 * The six rungs are an ORDERED ladder whose privacy ceiling is monotone
 * NON-INCREASING as it descends. A peer-relay estimate is not precise, and the
 * type system is not what stops it from claiming to be — the rung table is:
 * every rung's ceiling is applied through `narrowestPrivacyClass`, so descending
 * the chain can only coarsen. `resolvePosition` reports WHICH rung answered so
 * the UI can show §28's degraded-mode indicator honestly instead of presenting
 * a 40-minute-old peer relay as a live dot.
 *
 * PURITY
 * ======
 * No storage, no network, no React, no clock of its own. Every time-dependent
 * function takes `now` explicitly.
 */

import {
  applyCeiling,
  decay,
  isGrantLive,
  mayRenderIdentity,
  narrowestOf,
  narrowestPrivacyClass,
  precisionRank,
  type DecayStage,
  type FreshnessState,
  type PrecisionGrant,
  type PresenceCapabilities,
  type PresenceEstimateState,
  type PresencePurpose,
  type PrivacyClass,
} from './presenceLadder.ts';
import { coarsenForFriend } from '../../../hooks/mapEntityFilters.ts';
import {
  KIND_DEFAULT_PRIORITY,
  point,
  type MapObject,
  type MapObjectKind,
} from '../../../types/mapObjects.ts';

/** Locate My Friends is one §23 purpose and never borrows another's ceiling. */
export const LOCATE_FRIENDS_PURPOSE: PresencePurpose = 'locate_my_friends';

// ── The §12 signal ladder ─────────────────────────────────────────────────────

/** §12's "preferred signal sequence", in the spec's own order. */
export const LOCATE_SIGNAL_RUNGS = [
  'network_location',
  'event_cached_location',
  'device_proximity',
  'peer_relay',
  'last_known',
  'manual_checkpoint',
] as const;
export type LocateSignalRung = (typeof LOCATE_SIGNAL_RUNGS)[number];

/** Position in the chain; 0 is the preferred rung. -1 for an unknown rung. */
export function rungIndex(rung: string | null | undefined): number {
  if (typeof rung !== 'string') return -1;
  return (LOCATE_SIGNAL_RUNGS as readonly string[]).indexOf(rung);
}

/** Coarse proximity bucket. MIRRORS the server's `RawPresenceObservation.proximity`. */
export const PROXIMITY_BUCKETS = ['very_close', 'nearby', 'within_area', 'weak'] as const;
export type ProximityBucket = (typeof PROXIMITY_BUCKETS)[number];

export interface DistanceRange {
  minMeters: number;
  /** `null` means "at least minMeters, upper bound not asserted". */
  maxMeters: number | null;
}

/**
 * §14 (presence spec): "RSSI is noisy, so a transport reports a BUCKET, never a
 * decimal metre reading it cannot justify." These are those buckets in metres.
 */
export const PROXIMITY_BUCKET_RANGE = {
  very_close: { minMeters: 0, maxMeters: 15 },
  nearby: { minMeters: 15, maxMeters: 40 },
  within_area: { minMeters: 40, maxMeters: 80 },
  weak: { minMeters: 80, maxMeters: 200 },
} as const satisfies Record<ProximityBucket, DistanceRange>;

export interface RungPolicy {
  /** The most precise §23 rung this signal may EVER produce. */
  readonly ceiling: PrivacyClass;
  /** The server's §10 estimate-state vocabulary for this rung. */
  readonly estimateState: PresenceEstimateState;
  /** Capability required for this rung to be reachable at all on a device. */
  readonly requires: keyof PresenceCapabilities | null;
  /** Why this rung sits where it sits. */
  readonly rationale: string;
}

/**
 * The ladder, with its ceilings. The ceilings are monotone NON-INCREASING down
 * the chain — a property the tests assert over the whole table rather than
 * trusting this comment.
 *
 * `manual_checkpoint` is `approximate` rather than `place_level` on purpose. A
 * checkpoint names a MEETING POINT ("Food Court"), and the pin the map draws is
 * the checkpoint's own published location, not a fix on the member. The member
 * is attached to it by label. Granting it `place_level` would let the last and
 * weakest rung outrank rungs above it, which is exactly the inversion the chain
 * exists to prevent.
 */
export const RUNG_POLICY = {
  network_location: {
    ceiling: 'precise_temporary',
    estimateState: 'precise',
    requires: 'backgroundLocation',
    rationale: '§12 rung 1. A live network fix is the only rung that may be precise, and only temporarily.',
  },
  event_cached_location: {
    ceiling: 'place_level',
    estimateState: 'recent',
    requires: null,
    rationale: '§12 rung 2 + §28 "Cache event map and meeting points". A cached fix names a venue, not a point.',
  },
  device_proximity: {
    ceiling: 'approximate',
    estimateState: 'nearby',
    requires: 'bleScan',
    rationale: '§12 rung 3. Radio proximity is a bucket, never a coordinate.',
  },
  peer_relay: {
    ceiling: 'approximate',
    estimateState: 'relayed',
    requires: 'localPeer',
    rationale: '§12 rung 4. Someone else saw them; second-hand evidence is never precise.',
  },
  last_known: {
    ceiling: 'approximate',
    estimateState: 'last_known',
    requires: null,
    rationale: '§12 rung 5 + §28 "Cache Crew last-known state". A remembered position, not a current one.',
  },
  manual_checkpoint: {
    ceiling: 'approximate',
    estimateState: 'inferred',
    requires: null,
    rationale: '§12 rung 6. A declared meeting point. The pin is the checkpoint, not the person.',
  },
} as const satisfies Record<LocateSignalRung, RungPolicy>;

/**
 * Which rungs this device cannot supply at all.
 *
 * On the stack verified 2026-08-28 (`CURRENT_STACK_CAPABILITIES`) BLE is
 * entirely absent, so rungs 3 and 4 are unreachable and the chain drops
 * straight from the cached fix to last-known. §66/§28 require the product to
 * SAY what is unavailable rather than silently doing nothing, which is what
 * this function exists to feed.
 */
export function unsupportedRungs(
  capabilities: PresenceCapabilities,
): LocateSignalRung[] {
  const out: LocateSignalRung[] = [];
  for (const rung of LOCATE_SIGNAL_RUNGS) {
    const req = RUNG_POLICY[rung].requires;
    if (req !== null && capabilities[req] !== true) out.push(rung);
  }
  return out;
}

export function isRungSupported(
  rung: LocateSignalRung,
  capabilities: PresenceCapabilities,
): boolean {
  const req = RUNG_POLICY[rung].requires;
  return req === null || capabilities[req] === true;
}

// ── Signals ───────────────────────────────────────────────────────────────────

export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * One observation offered to the chain. A signal is EVIDENCE, never a
 * conclusion — the same split the server's presence domain makes between
 * `PresenceObservation` and `PresenceEstimate`.
 */
export interface LocateSignal {
  rung: LocateSignalRung;
  /** Epoch ms the observation was made. Drives §23 decay. */
  observedAt: number;
  /** Whatever precision the SOURCE already decided to expose. Never sharpened. */
  position?: GeoPoint | null;
  /** Coarse bucket, when the rung produced one instead of a coordinate. */
  proximity?: ProximityBucket | null;
  /** An explicit range, when the source could justify one. */
  distanceRange?: DistanceRange | null;
  checkpointId?: string | null;
  /** Human label for a checkpoint, e.g. "Food Court". */
  checkpointLabel?: string | null;
  /** A ceiling the source itself imposed. Combined, never overridden. */
  sourceClass?: PrivacyClass | null;
}

function isFinitePoint(p: GeoPoint | null | undefined): p is GeoPoint {
  return (
    !!p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

function isUsableSignal(s: LocateSignal | null | undefined): s is LocateSignal {
  if (!s) return false;
  if (rungIndex(s.rung) < 0) return false;
  if (!Number.isFinite(s.observedAt)) return false;
  const hasPoint = isFinitePoint(s.position ?? null);
  const hasProximity =
    typeof s.proximity === 'string' &&
    (PROXIMITY_BUCKETS as readonly string[]).includes(s.proximity);
  const hasRange =
    !!s.distanceRange && Number.isFinite(s.distanceRange.minMeters);
  const hasCheckpoint =
    typeof s.checkpointLabel === 'string' && s.checkpointLabel.trim() !== '';
  // A signal that carries no evidence of any kind answers nothing.
  return hasPoint || hasProximity || hasRange || hasCheckpoint;
}

// ── Resolution ────────────────────────────────────────────────────────────────

export interface ResolvePositionOptions {
  /**
   * A further ceiling from outside the chain — the session's granted class, the
   * viewer's own privacy preference, a §24 protected-zone suppression.
   */
  ceiling?: PrivacyClass;
  /**
   * Stable key used to coarsen a coordinate deterministically when the
   * effective rung is below `place_level`. WITHOUT it, a sub-place-level result
   * returns NO position at all — fail-closed, because the alternative is
   * emitting an un-coarsened coordinate at a rung that forbids one.
   */
  subjectKey?: string | null;
  /** Device capabilities; unsupported rungs are skipped. */
  capabilities?: PresenceCapabilities | null;
}

export interface ResolvedPosition {
  /** Which rung answered. `null` when nothing did. */
  rung: LocateSignalRung | null;
  /** True when a rung BELOW the preferred one answered, or nothing did. */
  degraded: boolean;
  /** True when no rung answered at all — §28 offline state. */
  offline: boolean;
  privacyClass: PrivacyClass;
  freshness: FreshnessState;
  estimateState: PresenceEstimateState;
  decayStage: DecayStage;
  /** Only ever present when `privacyClass` permits geometry. */
  position: GeoPoint | null;
  /** True when `position` went through deterministic coarsening. */
  positionCoarsened: boolean;
  distanceRange: DistanceRange | null;
  proximity: ProximityBucket | null;
  checkpointId: string | null;
  checkpointLabel: string | null;
  /** Age of the answering observation in ms. `null` when nothing answered. */
  ageMs: number | null;
  /** Rungs that were tried and produced nothing, in order. */
  attempted: LocateSignalRung[];
}

/** The state for "we have nothing" — the fail-closed default, not an error. */
export const NO_POSITION: ResolvedPosition = Object.freeze({
  rung: null,
  degraded: true,
  offline: true,
  privacyClass: 'none',
  freshness: 'unknown',
  estimateState: 'unknown',
  decayStage: 'expired',
  position: null,
  positionCoarsened: false,
  distanceRange: null,
  proximity: null,
  checkpointId: null,
  checkpointLabel: null,
  ageMs: null,
  attempted: Object.freeze([]) as unknown as LocateSignalRung[],
});

/**
 * Walk §12's chain and return the first rung that can answer.
 *
 * Rungs are tried in the SPEC's order, not the array's — a caller cannot
 * promote a peer relay above a network fix by reordering its input.
 *
 * As it descends, the effective class is the narrowest of: the rung's ceiling,
 * whatever the source itself declared, the §23 decay stage for the observation's
 * age, and any caller-supplied ceiling. Every one of those can only tighten.
 *
 * A rung that decays all the way to `none` does not answer — the chain
 * continues to the next rung, which is exactly the behaviour §12's ladder is
 * for.
 */
export function resolvePosition(
  signals: readonly LocateSignal[] | null | undefined,
  now: number,
  options: ResolvePositionOptions = {},
): ResolvedPosition {
  const list = Array.isArray(signals) ? signals.filter(isUsableSignal) : [];
  const attempted: LocateSignalRung[] = [];
  const clock = Number.isFinite(now) ? now : Number.NaN;
  const outerCeiling = options.ceiling ?? 'precise_temporary';
  const caps = options.capabilities ?? null;

  for (const rung of LOCATE_SIGNAL_RUNGS) {
    if (caps && !isRungSupported(rung, caps)) continue;
    const candidates = list.filter((s) => s.rung === rung);
    if (candidates.length === 0) continue;
    attempted.push(rung);

    // Freshest observation wins within a rung.
    const signal = candidates.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
    const policy = RUNG_POLICY[rung];
    const elapsed = Number.isFinite(clock) ? clock - signal.observedAt : Number.NaN;

    const decayed = decay(policy.ceiling, elapsed);
    const cls = narrowestOf(
      decayed.privacyClass,
      signal.sourceClass ?? 'precise_temporary',
      outerCeiling,
    );
    if (cls === 'none') continue; // this rung has nothing left to give

    const range = rangeForSignal(signal);
    const resolved: ResolvedPosition = {
      rung,
      degraded: rungIndex(rung) > 0,
      offline: false,
      privacyClass: cls,
      freshness: decayed.freshness,
      estimateState: policy.estimateState,
      decayStage: decayed.stage,
      position: exposePosition(signal.position ?? null, cls, options.subjectKey ?? null),
      positionCoarsened:
        isFinitePoint(signal.position ?? null) &&
        precisionRank(cls) < precisionRank('place_level'),
      distanceRange: rangeFor(cls, range),
      proximity: signal.proximity ?? null,
      checkpointId: signal.checkpointId ?? null,
      checkpointLabel: signal.checkpointLabel ?? null,
      ageMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : null,
      attempted,
    };
    return resolved;
  }

  return { ...NO_POSITION, attempted };
}

function rangeForSignal(signal: LocateSignal): DistanceRange | null {
  if (signal.distanceRange && Number.isFinite(signal.distanceRange.minMeters)) {
    return signal.distanceRange;
  }
  if (signal.proximity && PROXIMITY_BUCKET_RANGE[signal.proximity]) {
    return PROXIMITY_BUCKET_RANGE[signal.proximity];
  }
  return null;
}

/**
 * A coordinate may leave this module only at `place_level` or above, and only
 * un-coarsened at `precise_temporary`.
 *
 * Below `place_level` the coordinate is passed through `coarsenForFriend`, the
 * same deterministic ±~1 km jitter the map already uses for friend markers, so
 * the ring is stable between renders without ever being a real fix. With no
 * `subjectKey` to seed that jitter, the position is DROPPED — an un-coarsened
 * coordinate at an approximate rung is the exact leak §23 forbids, and dropping
 * is the only safe answer.
 */
function exposePosition(
  position: GeoPoint | null,
  cls: PrivacyClass,
  subjectKey: string | null,
): GeoPoint | null {
  if (!isFinitePoint(position)) return null;
  if (precisionRank(cls) < precisionRank('approximate')) return null;
  if (precisionRank(cls) >= precisionRank('place_level')) return position;
  if (!subjectKey) return null;
  return coarsenForFriend(subjectKey, position.lat, position.lng);
}

/** The coarse ladder an `approximate` reading may be reported on, in metres. */
export const APPROXIMATE_DISTANCE_LADDER = [0, 40, 80, 150, 300, 600, 1200] as const;

/**
 * Snap a range to what the class is allowed to assert.
 *
 * `precise_temporary` → 10 m granularity, never a bare metre reading.
 * `approximate`       → snapped OUTWARD onto the coarse ladder, giving §12's
 *                       "~40-80m" shape.
 * `place_level`/below → no distance at all; a venue is named, not measured.
 */
export function rangeFor(
  cls: PrivacyClass,
  range: DistanceRange | null,
): DistanceRange | null {
  if (!range || !Number.isFinite(range.minMeters)) return null;
  if (precisionRank(cls) < precisionRank('approximate')) return null;
  if (precisionRank(cls) > precisionRank('approximate')) {
    // place_level and precise_temporary. place_level names a venue instead.
    if (cls === 'place_level') return null;
    const lo = Math.max(0, Math.floor(range.minMeters / 10) * 10);
    const rawHi = range.maxMeters;
    const hi =
      rawHi != null && Number.isFinite(rawHi)
        ? Math.max(lo + 10, Math.ceil(rawHi / 10) * 10)
        : null;
    return { minMeters: lo, maxMeters: hi };
  }
  const ladder: readonly number[] = APPROXIMATE_DISTANCE_LADDER;
  const min = Math.max(0, range.minMeters);
  let lo: number = ladder[0];
  for (const step of ladder) if (step <= min) lo = step;
  const rawHi = range.maxMeters;
  if (rawHi == null || !Number.isFinite(rawHi)) return { minMeters: lo, maxMeters: null };
  const max = Math.max(min, rawHi);
  let hi: number | null = null;
  for (const step of ladder) {
    if (step >= max) {
      hi = step;
      break;
    }
  }
  // Past the top of the ladder: keep the (already snapped-down) lower bound and
  // assert no upper bound at all. Snapping the LOWER bound up here would report
  // the member as further away than the evidence supports.
  if (hi === null) return { minMeters: lo, maxMeters: null };
  if (hi === lo) {
    const next = ladder[ladder.indexOf(lo) + 1];
    hi = next ?? null;
  }
  return { minMeters: lo, maxMeters: hi };
}

// ── The session ───────────────────────────────────────────────────────────────

/** §12 "Temporary and auto-expiring": no session may outlive this. 12 hours. */
export const MAX_SESSION_MS = 12 * 60 * 60_000;
/** A session must actually last some time to exist at all. */
export const MIN_SESSION_MS = 1;

export interface LocateSessionInput {
  sessionId: string;
  /** §12 "Group-scoped". Required and non-empty. */
  groupId: string;
  /** §12 "Opt-in only". Only these members are ever resolved. */
  optedInMemberIds: readonly string[];
  startedAt: number;
  /** §12 "Temporary and auto-expiring". REQUIRED — there is no default. */
  expiresAt: number;
  /** The ceiling the group agreed to. Defaults to §23's ungranted rung. */
  grantedClass?: PrivacyClass;
  /** Set when the session was ended explicitly (§12's Leave/End control). */
  endedAt?: number | null;
  /** Human label for the event/group, for the panel header. */
  label?: string | null;
}

export type SessionRejection =
  | 'missing_session_id'
  | 'missing_group_id'
  | 'no_opted_in_members'
  | 'invalid_start'
  | 'missing_expiry'
  | 'expiry_not_after_start'
  | 'expiry_exceeds_maximum'
  | 'invalid_ended_at';

export type CreateSessionResult =
  | { ok: true; session: LocateSession }
  | { ok: false; reason: SessionRejection };

/**
 * A validated Locate My Friends session.
 *
 * The constructor is PRIVATE. `createLocateSession` is the only way to obtain
 * one, and it rejects every session §12 forbids — in particular any session
 * without a finite `expiresAt` inside `MAX_SESSION_MS`. That is what makes
 * "temporary and auto-expiring" a property of the type rather than a habit:
 * an unbounded session is not merely discouraged, it cannot be constructed, and
 * no object literal elsewhere in the codebase can be passed off as one.
 */
export class LocateSession {
  readonly sessionId: string;
  readonly groupId: string;
  readonly optedInMemberIds: readonly string[];
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly grantedClass: PrivacyClass;
  readonly endedAt: number | null;
  readonly label: string | null;

  private constructor(input: Required<Omit<LocateSessionInput, 'label' | 'endedAt'>> & {
    endedAt: number | null;
    label: string | null;
  }) {
    this.sessionId = input.sessionId;
    this.groupId = input.groupId;
    this.optedInMemberIds = Object.freeze([...input.optedInMemberIds]);
    this.startedAt = input.startedAt;
    this.expiresAt = input.expiresAt;
    this.grantedClass = input.grantedClass;
    this.endedAt = input.endedAt;
    this.label = input.label;
    Object.freeze(this);
  }

  /** @internal Only `createLocateSession` may call this. */
  static __create(
    input: Required<Omit<LocateSessionInput, 'label' | 'endedAt'>> & {
      endedAt: number | null;
      label: string | null;
    },
  ): LocateSession {
    return new LocateSession(input);
  }
}

/**
 * The only constructor. Returns a result rather than throwing so callers must
 * handle rejection explicitly instead of letting an invalid session escape via
 * an unhandled promise or a swallowed catch.
 */
export function createLocateSession(
  input: LocateSessionInput,
): CreateSessionResult {
  if (typeof input?.sessionId !== 'string' || input.sessionId.trim() === '') {
    return { ok: false, reason: 'missing_session_id' };
  }
  if (typeof input.groupId !== 'string' || input.groupId.trim() === '') {
    return { ok: false, reason: 'missing_group_id' };
  }
  const members = Array.isArray(input.optedInMemberIds)
    ? input.optedInMemberIds.filter((id) => typeof id === 'string' && id.trim() !== '')
    : [];
  if (members.length === 0) return { ok: false, reason: 'no_opted_in_members' };
  if (!Number.isFinite(input.startedAt)) return { ok: false, reason: 'invalid_start' };
  if (typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt)) {
    return { ok: false, reason: 'missing_expiry' };
  }
  if (input.expiresAt - input.startedAt < MIN_SESSION_MS) {
    return { ok: false, reason: 'expiry_not_after_start' };
  }
  if (input.expiresAt - input.startedAt > MAX_SESSION_MS) {
    return { ok: false, reason: 'expiry_exceeds_maximum' };
  }
  const endedAt = input.endedAt ?? null;
  if (endedAt !== null && !Number.isFinite(endedAt)) {
    return { ok: false, reason: 'invalid_ended_at' };
  }

  return {
    ok: true,
    session: LocateSession.__create({
      sessionId: input.sessionId,
      groupId: input.groupId,
      optedInMemberIds: members,
      startedAt: input.startedAt,
      expiresAt: input.expiresAt,
      grantedClass: input.grantedClass ?? 'approximate',
      endedAt,
      label: input.label ?? null,
    }),
  };
}

/**
 * §12's explicit Leave/End control, as a pure transform.
 *
 * Ending SHORTENS the expiry (`Math.min`) and stamps `endedAt`. There is no
 * path that lengthens a session — extending is a new session with a fresh
 * opt-in, which is what "temporary" has to mean to be worth anything.
 */
export function endLocateSession(session: LocateSession, at: number): LocateSession {
  const stamp = Number.isFinite(at) ? at : session.startedAt;
  const clamped = Math.max(
    session.startedAt + MIN_SESSION_MS,
    Math.min(stamp, session.expiresAt),
  );
  const result = createLocateSession({
    sessionId: session.sessionId,
    groupId: session.groupId,
    optedInMemberIds: session.optedInMemberIds,
    startedAt: session.startedAt,
    expiresAt: clamped,
    grantedClass: session.grantedClass,
    endedAt: stamp,
    label: session.label,
  });
  // Unreachable: every field came from an already-validated session and the
  // expiry was clamped into the valid window. Kept total rather than throwing.
  return result.ok ? result.session : session;
}

/** A member leaves without ending the session for everyone else. */
export function removeMember(session: LocateSession, memberId: string): LocateSession {
  const remaining = session.optedInMemberIds.filter((id) => id !== memberId);
  if (remaining.length === 0) return endLocateSession(session, session.startedAt);
  const result = createLocateSession({
    sessionId: session.sessionId,
    groupId: session.groupId,
    optedInMemberIds: remaining,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    grantedClass: session.grantedClass,
    endedAt: session.endedAt,
    label: session.label,
  });
  return result.ok ? result.session : session;
}

export function isActive(session: LocateSession | null | undefined, now: number): boolean {
  if (!session) return false;
  if (!Number.isFinite(now)) return false;
  if (session.endedAt !== null && now >= session.endedAt) return false;
  return now >= session.startedAt && now < session.expiresAt;
}

export function remainingMs(
  session: LocateSession | null | undefined,
  now: number,
): number {
  if (!isActive(session, now)) return 0;
  return Math.max(0, session!.expiresAt - now);
}

export function isOptedIn(
  session: LocateSession | null | undefined,
  memberId: string,
): boolean {
  if (!session) return false;
  return session.optedInMemberIds.includes(memberId);
}

// ── Members ───────────────────────────────────────────────────────────────────

export interface LocateMemberInput {
  memberId: string;
  displayName: string;
  avatarUrl?: string | null;
  signals?: readonly LocateSignal[];
  /** The member's own grant. Absent ⇒ the session's ungranted ceiling applies. */
  grant?: PrecisionGrant | null;
}

export interface LocateMemberState {
  memberId: string;
  /** `null` whenever §23 forbids rendering an identity at this rung. */
  displayName: string | null;
  /** `null` whenever §23 forbids rendering an identity at this rung. */
  avatarUrl: string | null;
  /** Whether an avatar may be drawn at all. False ⇒ the map draws a ring. */
  identityVisible: boolean;
  resolved: ResolvedPosition;
  /** True when a rung below the preferred one answered, or nothing did. */
  degraded: boolean;
}

export interface ResolveMemberOptions {
  /** Device capabilities; unsupported rungs are skipped. §66/§28. */
  capabilities?: PresenceCapabilities | null;
  /** Any further ceiling in force (viewer preference, §24 suppression). */
  additionalBounds?: readonly PrivacyClass[];
}

/**
 * The one blessed read path for a group member.
 *
 * Three gates, in order, before any signal is even looked at:
 *   1. the session must be active (`isActive`),
 *   2. the member must have opted in (`isOptedIn`),
 *   3. the ceiling is §23's for `locate_my_friends`, raised above
 *      `approximate` only by a live, scoped, unexpired grant.
 *
 * Failing any of them yields `NO_POSITION` with no identity — the same shape a
 * member with no signal gets, so a caller cannot tell "not permitted" from
 * "not reachable" and therefore cannot leak the difference.
 */
export function resolveMember(
  session: LocateSession | null | undefined,
  member: LocateMemberInput,
  now: number,
  options: ResolveMemberOptions = {},
): LocateMemberState {
  const denied: LocateMemberState = {
    memberId: member?.memberId ?? '',
    displayName: null,
    avatarUrl: null,
    identityVisible: false,
    resolved: NO_POSITION,
    degraded: true,
  };
  if (!member || typeof member.memberId !== 'string' || member.memberId === '') return denied;
  if (!isActive(session, now)) return denied;
  if (!isOptedIn(session, member.memberId)) return denied;

  const grant = member.grant ?? null;
  const scopedGrant =
    grant && isGrantLive(grant, now) && grant.scopeId === session!.groupId ? grant : null;

  const ceiling = applyCeiling('precise_temporary', LOCATE_FRIENDS_PURPOSE, scopedGrant, {
    now,
    additionalBounds: [session!.grantedClass, ...(options.additionalBounds ?? [])],
  });

  const resolved = resolvePosition(member.signals ?? [], now, {
    ceiling,
    subjectKey: member.memberId,
    capabilities: options.capabilities ?? null,
  });

  const identityVisible = mayRenderIdentity(resolved.privacyClass);
  return {
    memberId: member.memberId,
    displayName: identityVisible ? member.displayName : null,
    avatarUrl: identityVisible ? member.avatarUrl ?? null : null,
    identityVisible,
    resolved,
    degraded: resolved.degraded,
  };
}

// ── §12 display states ────────────────────────────────────────────────────────

/**
 * The display vocabulary §12 asks for, plus the states it implies:
 *
 *     "Nearby ~40-80m"        → nearby_range
 *     "Last seen 3m ago"      → last_seen
 *     "Checkpoint: Food Court"→ checkpoint
 */
export const DISPLAY_STATE_KINDS = [
  'live',
  'nearby_range',
  'at_place',
  'checkpoint',
  'last_seen',
  'in_area',
  'not_sharing',
] as const;
export type DisplayStateKind = (typeof DISPLAY_STATE_KINDS)[number];

export interface MemberDisplayState {
  kind: DisplayStateKind;
  /** The line the panel prints. */
  text: string;
  /** The distance actually asserted, if any — already snapped to the rung. */
  distance: DistanceRange | null;
  /** Whether the map may draw an avatar. False ⇒ ring (§6, §23). */
  identityVisible: boolean;
  /** True when a lower rung answered; drives the §28 degraded indicator. */
  degraded: boolean;
}

function formatMeters(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

export function formatRange(range: DistanceRange): string {
  const { minMeters, maxMeters } = range;
  if (maxMeters == null) return `${formatMeters(minMeters)}+`;
  if (maxMeters < 1000) return `${Math.round(minMeters)}-${Math.round(maxMeters)}m`;
  return `${formatMeters(minMeters)}-${formatMeters(maxMeters)}`;
}

/** "just now" / "3m ago" / "2h ago" / "4d ago". */
export function formatAge(ageMs: number | null): string {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return 'a while ago';
  if (ageMs < 60_000) return 'just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * §12's display line for one member.
 *
 * The invariant this function exists to hold: it NEVER emits a distance more
 * precise than the member's current rung allows. Every distance it prints came
 * out of `rangeFor`, which drops the range entirely below `approximate` and
 * snaps it onto `APPROXIMATE_DISTANCE_LADDER` at `approximate`. There is no
 * branch that reads a raw metre value off the signal.
 */
export function describeMember(state: LocateMemberState): MemberDisplayState {
  const r = state.resolved;
  const base = { identityVisible: state.identityVisible, degraded: r.degraded };

  if (r.rung === null || r.privacyClass === 'none') {
    return { kind: 'not_sharing', text: 'Not sharing', distance: null, ...base };
  }
  if (precisionRank(r.privacyClass) < precisionRank('approximate')) {
    // aggregate_only: presence without identity or geometry (§23's default).
    return { kind: 'in_area', text: 'Somewhere in the area', distance: null, ...base };
  }
  if (r.rung === 'manual_checkpoint' || (r.rung === 'peer_relay' && r.checkpointLabel)) {
    const label = r.checkpointLabel ?? 'Checkpoint';
    return { kind: 'checkpoint', text: `Checkpoint: ${label}`, distance: null, ...base };
  }
  if (r.rung === 'last_known' || r.decayStage === 'last_known') {
    return { kind: 'last_seen', text: `Last seen ${formatAge(r.ageMs)}`, distance: null, ...base };
  }
  if (r.distanceRange) {
    return {
      kind: 'nearby_range',
      text: `Nearby ~${formatRange(r.distanceRange)}`,
      distance: r.distanceRange,
      ...base,
    };
  }
  if (r.checkpointLabel) {
    return { kind: 'at_place', text: `At ${r.checkpointLabel}`, distance: null, ...base };
  }
  if (r.privacyClass === 'precise_temporary' && r.decayStage === 'precise') {
    return { kind: 'live', text: 'Live location', distance: null, ...base };
  }
  if (r.freshness === 'live' || r.freshness === 'recent') {
    // A current fix with nothing more specific to say about it. Deliberately
    // NOT a distance: the rung produced no range, so none is invented.
    return { kind: 'live', text: 'Sharing location', distance: null, ...base };
  }
  return {
    kind: 'last_seen',
    text: `Last seen ${formatAge(r.ageMs)}`,
    distance: null,
    ...base,
  };
}

/** "Ends in 42m" / "Ends in 2h 5m" / "Ended". */
export function describeSessionRemaining(
  session: LocateSession | null | undefined,
  now: number,
): string {
  if (!isActive(session, now)) return 'Ended';
  const ms = remainingMs(session, now);
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `Ends in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `Ends in ${hours}h` : `Ends in ${hours}h ${rest}m`;
}

// ── Projection into the §18 map-object contract ───────────────────────────────

const CREW_MEMBER_KIND: MapObjectKind = 'crew_member';
const MEETING_POINT_KIND: MapObjectKind = 'meeting_point';

/**
 * Project a resolved member onto the §18 envelope so the renderer never sees a
 * raw row (§19). Returns `null` when the member has no renderable geometry —
 * which is the common case at `approximate` with no coordinate, and correct:
 * a member with no position is a panel row, not a pin.
 */
export function memberToMapObject(
  state: LocateMemberState,
): MapObject<LocateMemberState> | null {
  const r = state.resolved;
  if (!r.position || r.privacyClass === 'none') return null;
  const display = describeMember(state);
  return {
    id: `crew:${state.memberId}`,
    kind: CREW_MEMBER_KIND,
    geometry: point(r.position.lat, r.position.lng),
    title: state.displayName ?? 'Group member',
    subtitle: display.text,
    freshness: r.freshness,
    privacyClass: r.privacyClass,
    renderingPriority: KIND_DEFAULT_PRIORITY[CREW_MEMBER_KIND],
    payload: state,
  };
}

export interface Checkpoint {
  id: string;
  label: string;
  position: GeoPoint;
  createdAt: number;
  createdByMemberId?: string | null;
}

/**
 * A checkpoint is a MEETING POINT the group published on purpose, so it is
 * `place_level` and carries no §23 decay: it is a place, not a person.
 */
export function checkpointToMapObject(
  checkpoint: Checkpoint,
): MapObject<Checkpoint> | null {
  if (!isFinitePoint(checkpoint?.position)) return null;
  if (typeof checkpoint.label !== 'string' || checkpoint.label.trim() === '') return null;
  return {
    id: `checkpoint:${checkpoint.id}`,
    kind: MEETING_POINT_KIND,
    geometry: point(checkpoint.position.lat, checkpoint.position.lng),
    title: checkpoint.label,
    subtitle: 'Meeting point',
    privacyClass: 'place_level',
    renderingPriority: KIND_DEFAULT_PRIORITY[MEETING_POINT_KIND],
    interaction: { actions: ['navigate', 'share', 'meet_here'] },
    payload: checkpoint,
  };
}

export { mayRenderIdentity, narrowestPrivacyClass, precisionRank };
