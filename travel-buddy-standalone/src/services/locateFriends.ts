/**
 * locateFriends service — the client half of Map spec §12 "Locate My Friends".
 *
 * It talks to exactly the four endpoints the server exposes and no others:
 *
 *   POST   /api/locate-friends/sessions                  start or opt in
 *   POST   /api/locate-friends/sessions/:id/position     publish at a rung
 *   GET    /api/locate-friends/sessions/:id              read the group
 *   DELETE /api/locate-friends/sessions/:id/membership   leave, immediately
 *
 * There is no "list my sessions" and no viewport query here for the same reason
 * there is none on the server: §37's "do not build a public real-time people
 * tracker" is kept by the absence of the call, not by a guard on it.
 *
 * FOUR RULES THIS MODULE EXISTS TO HOLD
 * =====================================
 *
 * 1. `unavailable` IS ONE STATE, AND IT IS TERMINAL.
 *    The server answers not-found, not-a-member, expired and unreadable with a
 *    single opaque `{ status: "unavailable" }` so the endpoint cannot be used to
 *    enumerate which groups are out. This client does not try to reconstruct the
 *    difference, and — just as important — does NOT retry on it. A retry loop
 *    against an opaque status is how a read endpoint becomes an existence
 *    oracle even when every individual answer is opaque: the OBSERVER learns
 *    from the timing and the count. So `unavailable` stops the sync dead.
 *    A flag-disabled envelope (`enabled: false`) collapses into the same state:
 *    that fact is global, not per-session, so it leaks nothing and is carried
 *    separately on `enabled` purely so the UI can say "not available" honestly.
 *
 * 2. THE LADDER DECIDES WHAT IS ASKED FOR, NOT THE CALLER.
 *    `precisionToPublish` runs the rung's own ceiling through `effectiveClass`
 *    — §23 decay, then §23's purpose ceiling, then the grant, then the session's
 *    agreed ceiling. The device NEVER states a precision of its own choosing,
 *    and a coordinate leaves this module only at `precise_temporary`. The server
 *    narrows again on receipt (`positionRowFor`); this side simply must not ASK
 *    for more than §23 permits for `locate_my_friends`.
 *
 * 3. LEAVING IS UNCONDITIONAL.
 *    `leaveLocateFriendsSession` consults no flag, no capability, no cached
 *    enabled-state and no session status. It mirrors the server route, which is
 *    deliberately not flag-gated: a capability switch that can strand an
 *    opted-in member inside a session they cannot leave is worse than the
 *    feature being on.
 *
 * 4. A FAILED READ NEVER EMPTIES THE GROUP.
 *    Transport failure is not `unavailable`. `LocateFriendsSync` keeps the last
 *    good members, raises `stale`, and keeps polling — the same way the map
 *    treats cached data. Blanking the list on a dropped packet would tell the
 *    viewer their friends had vanished.
 *
 * All privacy judgement lives in features/map/presence/*. Nothing here
 * re-derives a ceiling, a decay stage or an identity rule.
 */
import {
  PROXIMITY_BUCKETS,
  PROXIMITY_BUCKET_RANGE,
  RUNG_POLICY,
  LOCATE_FRIENDS_PURPOSE,
  LOCATE_SIGNAL_RUNGS,
  createLocateSession,
  isRungSupported,
  mayRenderIdentity,
  rangeFor,
  rungIndex,
  type CreateSessionResult,
  type DistanceRange,
  type GeoPoint,
  type LocateMemberState,
  type LocateSession,
  type LocateSignal,
  type LocateSignalRung,
  type ProximityBucket,
  type ResolvedPosition,
} from '../features/map/presence/locateFriends.ts';
import {
  CURRENT_STACK_CAPABILITIES,
  DECAY_BOUNDARIES_MS,
  DECAY_STAGE_FRESHNESS,
  DECAY_STAGES,
  ESTIMATE_STATES,
  PRECISION_LADDER,
  ceilingForPurpose,
  ceilingFromServerPrecision,
  effectiveClass,
  narrowestPrecision,
  precisionRank,
  type DecayStage,
  type LocationPrecision,
  type PrecisionGrant,
  type PresenceCapabilities,
  type PresenceEstimateState,
  type PrivacyClass,
} from '../features/map/presence/presenceLadder.ts';
import {
  eventCachedSignal,
  type EventCheckInCache,
} from '../features/map/presence/eventCachedLocation.ts';

// ── Cadence ───────────────────────────────────────────────────────────────────

/**
 * How often the group is re-read. 20 s.
 *
 * §23's decay gives a position a 5-minute `precise` stage, a 30-minute
 * `approximate` stage and a 60-minute horizon past which it is gone. 20 s is
 * 1/15th of the shortest of those, so a member can never appear in the wrong
 * decay stage for more than one tick — the boundary a display line actually
 * turns on ("Live location" → "Last seen 4m ago") is never more than 20 s late.
 * It is also roughly one §12 proximity bucket at walking pace (the `nearby`
 * bucket is 15-40 m; 1.4 m/s crosses 25 m in ~18 s), so "Nearby ~15-40m" does
 * not survive its own subject walking out of it.
 *
 * Cost: 3 reads/minute against the server's 120/minute budget for this route.
 */
export const LOCATE_FRIENDS_READ_INTERVAL_MS = 20_000;

/**
 * How often this device publishes its own position. 30 s.
 *
 * Chosen against the SAME decay window from the other side: the `precise` stage
 * is 5 minutes, so a 30 s cadence means ten consecutive publishes may fail
 * before the viewer's own position leaves `precise` for their friends. One
 * dropped write is therefore never visible, which is what makes it safe to
 * treat a failed publish as a no-op rather than something to retry immediately.
 *
 * It is deliberately NOT faster: at 30 s the server stores 2 rows/minute
 * against its 30/minute cap, and — the reason that cap exists — a sequence of
 * points 30 s apart is too coarse to reconstruct a route from. §37 forbids a
 * real-time tracker; a publish cadence fine enough to draw a line through is
 * how that gets built by accident.
 */
export const LOCATE_FRIENDS_PUBLISH_INTERVAL_MS = 30_000;

/**
 * The oldest observation worth sending. Mirrors the server's `POSITION_TTL_MS`
 * (= §23's 60-minute horizon): past it the server refuses the write, so sending
 * it is a guaranteed-wasted request that also looks like retry noise.
 */
export const OBSERVATION_HORIZON_MS = DECAY_BOUNDARIES_MS.last_known;

// ── Transport ─────────────────────────────────────────────────────────────────

/**
 * Everything this module needs from the outside world, injectable in full.
 *
 * The real implementations are resolved LAZILY (`defaultTransport`) rather than
 * imported at module scope, so importing this file costs nothing and pulls in
 * no Supabase / SecureStore / React Native surface. That is what lets the tests
 * exercise the whole module with a plain function for `fetch` and no network.
 */
export interface LocateFriendsTransport {
  fetch: typeof fetch;
  /** A current access token, or null when the viewer is not signed in. */
  token: () => Promise<string | null>;
  /** API origin. Empty string means "not configured here". */
  baseUrl: string;
}

let _cachedDefaults: { token: () => Promise<string | null> } | null = null;

async function defaultTransport(): Promise<LocateFriendsTransport> {
  if (!_cachedDefaults) {
    const mod = await import('./apiToken.ts');
    _cachedDefaults = { token: () => mod.freshToken() };
  }
  return {
    fetch: globalThis.fetch,
    token: _cachedDefaults.token,
    baseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? '',
  };
}

async function resolveTransport(
  partial?: Partial<LocateFriendsTransport> | null,
): Promise<LocateFriendsTransport> {
  if (partial?.fetch && partial.token && partial.baseUrl !== undefined) {
    return partial as LocateFriendsTransport;
  }
  const base = await defaultTransport();
  return { ...base, ...(partial ?? {}) };
}

export type LocateFriendsResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

interface CallOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  transport?: Partial<LocateFriendsTransport> | null;
  signal?: AbortSignal;
}

async function call<T>(opts: CallOptions): Promise<LocateFriendsResult<T>> {
  const t = await resolveTransport(opts.transport);
  if (!t.baseUrl) return { ok: false, error: 'API is not configured' };
  const token = await t.token();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await t.fetch(`${t.baseUrl}/api/locate-friends${opts.path}`, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}) as any);
      return {
        ok: false,
        error: (detail as any)?.message ?? `Request failed (${res.status})`,
      };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, error: 'aborted' };
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

// ── Ladder translation ────────────────────────────────────────────────────────

/**
 * §23's vocabulary → the server's `LocationPrecision` ladder, for REQUESTS.
 *
 * The inverse direction already exists as `ceilingFromServerPrecision`, and the
 * two disagree about `venue` on purpose (see `LADDER_DISAGREEMENTS`). This table
 * is used only to name what we are willing to expose, and every entry is the
 * narrowest server rung that still carries the §23 meaning — `place_level` maps
 * to `venue`, which the SERVER ranks below `approximate`, so a round trip
 * through both tables can only tighten.
 */
export const REQUESTED_PRECISION_FOR_CLASS = {
  none: 'none',
  aggregate_only: 'presence_only',
  approximate: 'approximate',
  place_level: 'venue',
  precise_temporary: 'precise',
} as const satisfies Record<PrivacyClass, LocationPrecision>;

/** The most precise rung each §12 rung may ever ask the server for. */
const RUNG_REQUEST_CEILING: Record<LocateSignalRung, LocationPrecision> = {
  network_location: 'precise',
  event_cached_location: 'approximate',
  device_proximity: 'approximate',
  peer_relay: 'zone',
  last_known: 'zone',
  manual_checkpoint: 'venue',
};

export interface PublishDecisionInput {
  rung: LocateSignalRung;
  /** Epoch ms of the observation. */
  observedAt: number;
  position?: GeoPoint | null;
  proximity?: ProximityBucket | null;
  checkpointLabel?: string | null;
  /** The ceiling the group agreed to, in §23 vocabulary. */
  sessionCeiling?: PrivacyClass;
  /** The viewer's own grant. Absent ⇒ §23's ungranted `approximate`. */
  grant?: PrecisionGrant | null;
  /** Device capabilities. An unsupported rung is refused, not downgraded. */
  capabilities?: PresenceCapabilities;
  now: number;
}

export type PublishRefusal =
  | 'unknown_rung'
  | 'rung_unavailable'
  | 'observation_in_future'
  | 'observation_too_old'
  | 'ceiling_none';

export type PublishDecision =
  | { publish: false; reason: PublishRefusal }
  | {
      publish: true;
      rung: LocateSignalRung;
      /** What §23 permits right now, before the server narrows further. */
      privacyClass: PrivacyClass;
      /** What we will ASK the server to store. Never above `privacyClass`. */
      precision: LocationPrecision;
      observedAt: number;
      lat: number | null;
      lng: number | null;
      proximityBucket: ProximityBucket | null;
      checkpointLabel: string | null;
    };

function isFiniteGeoPoint(p: GeoPoint | null | undefined): p is GeoPoint {
  return (
    !!p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

/**
 * Decide what — if anything — this device may publish.
 *
 * This is the whole of rule 2, as one pure function, so it can be tested over
 * the full rung x grant cross-product without a socket. Every bound it applies
 * comes from `features/map/presence`; nothing is recomputed here:
 *
 *   requested   = `RUNG_POLICY[rung].ceiling`   the rung's own §12 ceiling
 *   then        = `effectiveClass(...)`         §23 decay, then §23's purpose
 *                                               ceiling, the grant, and the
 *                                               session's agreed ceiling
 *   then        = `narrowestPrecision(...)`     against the rung's server-ladder
 *                                               ceiling, so translating between
 *                                               the two ladders cannot widen
 *
 * A COORDINATE LEAVES ONLY AT `precise_temporary`. Below that the point is
 * dropped rather than rounded: a rounded point still says "the person is here,
 * ±rounding", and letting the server coarsen a raw fix we were not entitled to
 * send makes the server the only thing standing between the device and the leak.
 * §12's lower rungs carry a bucket and a checkpoint label instead, which is what
 * they are actually evidence of.
 */
export function precisionToPublish(input: PublishDecisionInput): PublishDecision {
  const rung = input.rung;
  if (!(LOCATE_SIGNAL_RUNGS as readonly string[]).includes(rung)) {
    return { publish: false, reason: 'unknown_rung' };
  }

  const caps = input.capabilities ?? CURRENT_STACK_CAPABILITIES;
  if (!isRungSupported(rung, caps)) {
    return { publish: false, reason: 'rung_unavailable' };
  }

  const now = input.now;
  const observedAt = input.observedAt;
  if (!Number.isFinite(now) || !Number.isFinite(observedAt)) {
    return { publish: false, reason: 'observation_too_old' };
  }
  // A device clock ahead of the server buys an artificially long decay window,
  // which is the one direction skew is worth exploiting. The server refuses it
  // outright past its own tolerance; we never send it in the first place.
  if (observedAt > now) return { publish: false, reason: 'observation_in_future' };
  const elapsed = now - observedAt;
  if (elapsed >= OBSERVATION_HORIZON_MS) {
    return { publish: false, reason: 'observation_too_old' };
  }

  const sessionCeiling: PrivacyClass = input.sessionCeiling ?? 'approximate';
  const decided = effectiveClass(
    RUNG_POLICY[rung].ceiling,
    elapsed,
    LOCATE_FRIENDS_PURPOSE,
    input.grant ?? null,
    { now, additionalBounds: [sessionCeiling] },
  );
  const cls = decided.privacyClass;
  if (cls === 'none') return { publish: false, reason: 'ceiling_none' };

  const precision = narrowestPrecision(
    REQUESTED_PRECISION_FOR_CLASS[cls],
    RUNG_REQUEST_CEILING[rung],
  );
  if (precision === 'none') return { publish: false, reason: 'ceiling_none' };

  const mayCarryCoordinate = cls === 'precise_temporary' && precision === 'precise';
  const point = isFiniteGeoPoint(input.position) ? input.position : null;

  // A distance assertion is still a location assertion; below `approximate`
  // there is no rung to make one on.
  const mayCarryBucket = precisionRank(cls) >= precisionRank('approximate');
  const bucket =
    mayCarryBucket && input.proximity && PROXIMITY_BUCKETS.includes(input.proximity)
      ? input.proximity
      : null;

  const label =
    typeof input.checkpointLabel === 'string' && input.checkpointLabel.trim() !== ''
      ? input.checkpointLabel.trim().slice(0, 60)
      : null;

  return {
    publish: true,
    rung,
    privacyClass: cls,
    precision,
    observedAt,
    lat: mayCarryCoordinate && point ? point.lat : null,
    lng: mayCarryCoordinate && point ? point.lng : null,
    proximityBucket: bucket,
    checkpointLabel: label,
  };
}

// ── Wire shapes ───────────────────────────────────────────────────────────────

export interface LocateFriendsSessionSummary {
  id: string;
  groupScopeKind: string;
  groupScopeId: string;
  expiresAt: string;
  secondsRemaining: number;
  ceiling: LocationPrecision;
  label: string | null;
}

/** The server's `MemberView`, defensively parsed. */
export interface LocateFriendsMemberSnapshot {
  memberId: string;
  displayName: string | null;
  precision: LocationPrecision;
  estimateState: PresenceEstimateState;
  decayStage: DecayStage;
  rung: LocateSignalRung | null;
  degraded: boolean;
  live: boolean;
  position: GeoPoint | null;
  ring: { center: GeoPoint; radiusMeters: number } | null;
  proximityBucket: ProximityBucket | null;
  checkpointLabel: string | null;
  ageSeconds: number | null;
}

/**
 * `ok` or `unavailable`. There is no third read status and there must not be —
 * see rule 1. `enabled` is the GLOBAL capability flag, which says nothing about
 * any particular session and therefore cannot be used to probe for one.
 */
export type LocateFriendsReadStatus = 'ok' | 'unavailable';

export interface LocateFriendsReadEnvelope {
  enabled: boolean;
  status: LocateFriendsReadStatus;
  session: LocateFriendsSessionSummary | null;
  members: LocateFriendsMemberSnapshot[];
  generatedAt: string;
}

function oneOf<T extends string>(
  values: readonly T[],
  v: unknown,
  fallback: T,
): T {
  return typeof v === 'string' && (values as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

function parsePoint(v: any): GeoPoint | null {
  if (!v || !Number.isFinite(v.lat) || !Number.isFinite(v.lng)) return null;
  return { lat: Number(v.lat), lng: Number(v.lng) };
}

function parseMember(raw: any): LocateFriendsMemberSnapshot | null {
  if (!raw || typeof raw.memberId !== 'string' || raw.memberId === '') return null;
  const precision = oneOf(PRECISION_LADDER, raw.precision, 'none');
  const rung: LocateSignalRung | null = (LOCATE_SIGNAL_RUNGS as readonly string[]).includes(
    raw.rung,
  )
    ? (raw.rung as LocateSignalRung)
    : null;
  const ring = raw.ring && parsePoint(raw.ring.center) && Number.isFinite(raw.ring.radiusMeters)
    ? { center: parsePoint(raw.ring.center)!, radiusMeters: Number(raw.ring.radiusMeters) }
    : null;
  return {
    memberId: raw.memberId,
    // Unparseable identity is no identity. The server has already nulled this
    // whenever the rung forbids it; this is the second, cheaper gate.
    displayName:
      typeof raw.displayName === 'string' && mayRenderIdentity(ceilingFromServerPrecision(precision))
        ? raw.displayName
        : null,
    precision,
    estimateState: oneOf(ESTIMATE_STATES, raw.estimateState, 'unknown'),
    decayStage: oneOf(DECAY_STAGES, raw.decayStage, 'expired'),
    rung,
    // Anything we could not read is degraded. Fail-closed: the §28 indicator
    // showing when it need not have is harmless; the reverse is a stale claim
    // wearing a live badge.
    degraded: raw.degraded !== false,
    live: raw.live === true,
    position: parsePoint(raw.position),
    ring,
    proximityBucket: (PROXIMITY_BUCKETS as readonly string[]).includes(raw.proximityBucket)
      ? (raw.proximityBucket as ProximityBucket)
      : null,
    checkpointLabel: typeof raw.checkpointLabel === 'string' ? raw.checkpointLabel : null,
    ageSeconds: Number.isFinite(raw.ageSeconds) ? Number(raw.ageSeconds) : null,
  };
}

function parseSession(raw: any): LocateFriendsSessionSummary | null {
  if (!raw || typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.expiresAt !== 'string') return null;
  return {
    id: raw.id,
    groupScopeKind: typeof raw.groupScopeKind === 'string' ? raw.groupScopeKind : '',
    groupScopeId: typeof raw.groupScopeId === 'string' ? raw.groupScopeId : '',
    expiresAt: raw.expiresAt,
    secondsRemaining: Number.isFinite(raw.secondsRemaining)
      ? Math.max(0, Math.floor(Number(raw.secondsRemaining)))
      : 0,
    ceiling: oneOf(PRECISION_LADDER, raw.ceiling, 'none'),
    label: typeof raw.label === 'string' ? raw.label : null,
  };
}

/** The single unavailable envelope. Every "we cannot show you this" is this. */
function unavailableEnvelope(enabled: boolean): LocateFriendsReadEnvelope {
  return {
    enabled,
    status: 'unavailable',
    session: null,
    members: [],
    generatedAt: new Date().toISOString(),
  };
}

// ── The four calls ────────────────────────────────────────────────────────────

export interface StartSessionInput {
  groupScopeKind: 'trip' | 'circle' | 'event' | 'plan';
  groupScopeId: string;
  /** §12 "temporary and auto-expiring": REQUIRED, with no default anywhere. */
  ttlMinutes: number;
  /**
   * The ceiling to request, in §23 vocabulary. It is passed through
   * `ceilingForPurpose` before it goes on the wire, so a caller cannot ask for
   * more than §23 allows `locate_my_friends` — with no grant that is
   * `approximate` no matter what is passed here.
   */
  requestedCeiling?: PrivacyClass;
  grant?: PrecisionGrant | null;
  label?: string | null;
  now?: number;
}

export interface StartSessionOutcome {
  enabled: boolean;
  joined: boolean;
  session: LocateFriendsSessionSummary | null;
  /** The §23 class actually requested, after the purpose ceiling was applied. */
  requestedClass: PrivacyClass;
}

/**
 * Start the group's session, or opt into the one it already has.
 *
 * This is the only place a session is created, and `ttlMinutes` has no default
 * on either side of the wire: a caller that forgets it gets a rejection, not a
 * guess. The ceiling is narrowed here rather than trusted from the caller.
 */
export async function startLocateFriendsSession(
  input: StartSessionInput,
  transport?: Partial<LocateFriendsTransport> | null,
): Promise<LocateFriendsResult<StartSessionOutcome>> {
  const now = input.now ?? Date.now();
  const requestedClass = ceilingForPurpose(
    LOCATE_FRIENDS_PURPOSE,
    input.grant ?? null,
    now,
  );
  const bounded: PrivacyClass =
    input.requestedCeiling &&
    precisionRank(input.requestedCeiling) < precisionRank(requestedClass)
      ? input.requestedCeiling
      : requestedClass;

  const res = await call<any>({
    method: 'POST',
    path: '/sessions',
    transport,
    body: {
      groupScopeKind: input.groupScopeKind,
      groupScopeId: input.groupScopeId,
      ttlMinutes: input.ttlMinutes,
      ceiling: REQUESTED_PRECISION_FOR_CLASS[bounded],
      ...(input.label ? { label: input.label } : {}),
    },
  });
  if (!res.ok) return res;

  return {
    ok: true,
    data: {
      enabled: res.data?.enabled === true,
      joined: res.data?.joined === true,
      session: parseSession(res.data?.session),
      requestedClass: bounded,
    },
  };
}

export interface PublishOutcome {
  enabled: boolean;
  stored: boolean;
  /** What the SERVER decided to store. Null when nothing was sent. */
  storedPrecision: LocationPrecision | null;
  /** Why nothing was sent, when nothing was. */
  refusal: PublishRefusal | null;
  decision: PublishDecision;
}

export interface PublishPositionInput extends Omit<PublishDecisionInput, 'now'> {
  sessionId: string;
  now?: number;
}

/**
 * Publish this device's position at whatever rung §12's chain is answering on.
 *
 * A refusal is NOT an error: "the ladder says this device may not say that
 * right now" is a normal, expected outcome that the poller must not treat as a
 * failure to retry. Only transport failures come back `ok: false`.
 */
export async function publishLocateFriendsPosition(
  input: PublishPositionInput,
  transport?: Partial<LocateFriendsTransport> | null,
): Promise<LocateFriendsResult<PublishOutcome>> {
  const now = input.now ?? Date.now();
  const decision = precisionToPublish({ ...input, now });
  if (!decision.publish) {
    return {
      ok: true,
      data: {
        enabled: true,
        stored: false,
        storedPrecision: null,
        refusal: decision.reason,
        decision,
      },
    };
  }

  const res = await call<any>({
    method: 'POST',
    path: `/sessions/${encodeURIComponent(input.sessionId)}/position`,
    transport,
    body: {
      rung: decision.rung,
      precision: decision.precision,
      lat: decision.lat,
      lng: decision.lng,
      proximityBucket: decision.proximityBucket,
      checkpointLabel: decision.checkpointLabel,
      observedAt: decision.observedAt,
    },
  });
  if (!res.ok) return res;

  return {
    ok: true,
    data: {
      enabled: res.data?.enabled === true,
      stored: res.data?.stored === true,
      storedPrecision: (PRECISION_LADDER as readonly string[]).includes(res.data?.storedPrecision)
        ? (res.data.storedPrecision as LocationPrecision)
        : null,
      refusal: null,
      decision,
    },
  };
}

/** What a §25 "Create checkpoint" needs to name the point it is dropping. */
export interface ManualCheckpointInput {
  sessionId: string;
  /** The human name of the spot — "Food Court". Trimmed and capped by the ladder. */
  label: string;
  /** Clock, epoch ms. Defaults to now; the observation IS the moment of the press. */
  now?: number;
}

/**
 * §25 "Create checkpoint" — §12's rung 6, `manual_checkpoint`.
 *
 * A checkpoint is not a sensor reading, it is a DECLARATION: the member says
 * which named spot they are at, and the group's map attaches them to it. That
 * is why this is the last and weakest rung of §12's chain and why its ceiling
 * is `approximate` — "the pin is the checkpoint, not the person".
 *
 * THE LABEL IS THE PIN, AND THE PRESSED POINT IS NEVER SENT. No `position` is
 * passed below, deliberately, and it is not an oversight `precisionToPublish`
 * would have covered anyway (it drops coordinates below `precise_temporary`):
 * a long-press can land anywhere on the map, so the point under the finger is
 * not evidence of where the DEVICE is. Sending it as this member's position
 * would be an assertion the gesture never made. The label is what the user
 * actually asserted, so the label is what travels.
 *
 * Returns the same `PublishOutcome` as any other publish, so a ladder refusal
 * stays `ok: true` with `stored: false` and only transport failure is `ok: false`.
 */
export async function publishManualCheckpoint(
  input: ManualCheckpointInput,
  transport?: Partial<LocateFriendsTransport> | null,
): Promise<LocateFriendsResult<PublishOutcome>> {
  const now = input.now ?? Date.now();
  return publishLocateFriendsPosition(
    {
      sessionId: input.sessionId,
      rung: 'manual_checkpoint',
      observedAt: now,
      checkpointLabel: input.label,
      now,
    },
    transport,
  );
}

/** What a §12 rung-2 "Event-local cached location" publish needs. */
export interface EventCachedLocationInput {
  sessionId: string;
  /** A cache built by `cacheEventCheckInLocation`; carries its own explicit consent + TTL. */
  cache: EventCheckInCache | null;
  /** The ceiling the group agreed to, in §23 vocabulary. */
  sessionCeiling?: PrivacyClass;
  grant?: PrecisionGrant | null;
  capabilities?: PresenceCapabilities;
  now?: number;
}

/**
 * §12 rung 2, "Event-local cached location" — the degraded-mode producer.
 *
 * A member's last-known fix, cached at event check-in, republished as the
 * `event_cached_location` rung when a live network fix is not available. It
 * goes through the SAME `publishLocateFriendsPosition` path as every other
 * rung, so the rung's `approximate` ceiling and §23 decay coarsen it there —
 * the raw coordinate is dropped and the venue label is what the group sees.
 *
 * Two ways it declines to publish, both `ok: true` with `stored: false` (a
 * decline is not a transport error and must not be retried as one):
 *   - the cache is expired or unconsented (`eventCachedSignal` returns null),
 *   - the ladder refuses the resulting signal (e.g. horizon exceeded).
 */
export async function publishEventCachedLocation(
  input: EventCachedLocationInput,
  transport?: Partial<LocateFriendsTransport> | null,
): Promise<LocateFriendsResult<PublishOutcome>> {
  const now = input.now ?? Date.now();
  const signal = eventCachedSignal(input.cache, now);
  if (!signal) {
    const decision: PublishDecision = { publish: false, reason: 'observation_too_old' };
    return {
      ok: true,
      data: { enabled: true, stored: false, storedPrecision: null, refusal: 'observation_too_old', decision },
    };
  }
  return publishLocateFriendsPosition(
    {
      sessionId: input.sessionId,
      rung: 'event_cached_location',
      observedAt: signal.observedAt,
      position: signal.position ?? null,
      checkpointLabel: signal.checkpointLabel ?? null,
      sessionCeiling: input.sessionCeiling,
      grant: input.grant ?? null,
      capabilities: input.capabilities,
      now,
    },
    transport,
  );
}

/**
 * Read the group.
 *
 * Every non-`ok` answer — including a flag-disabled envelope and a body we
 * could not parse — collapses into the ONE `unavailable` state. There is
 * nothing here that distinguishes them, and adding something would rebuild the
 * existence oracle the server's opaque status exists to prevent.
 */
export async function readLocateFriendsSession(
  sessionId: string,
  transport?: Partial<LocateFriendsTransport> | null,
  signal?: AbortSignal,
): Promise<LocateFriendsResult<LocateFriendsReadEnvelope>> {
  const res = await call<any>({
    method: 'GET',
    path: `/sessions/${encodeURIComponent(sessionId)}`,
    transport,
    signal,
  });
  // A transport failure is NOT `unavailable` — see rule 4. It stays an error so
  // the caller can keep what it already had.
  if (!res.ok) return res;

  const enabled = res.data?.enabled === true;
  if (!enabled || res.data?.status !== 'ok') {
    return { ok: true, data: unavailableEnvelope(enabled) };
  }

  const session = parseSession(res.data.session);
  if (!session) return { ok: true, data: unavailableEnvelope(true) };

  const members = (Array.isArray(res.data.members) ? res.data.members : [])
    .map(parseMember)
    .filter((m: LocateFriendsMemberSnapshot | null): m is LocateFriendsMemberSnapshot => m !== null);

  return {
    ok: true,
    data: {
      enabled: true,
      status: 'ok',
      session,
      members,
      generatedAt:
        typeof res.data.generatedAt === 'string'
          ? res.data.generatedAt
          : new Date().toISOString(),
    },
  };
}

/**
 * Leave. Immediately, and unconditionally.
 *
 * NOTHING gates this call: no feature flag, no capability check, no cached
 * enabled-state, no session status, not even a local "are we in a session"
 * test. It mirrors the server route, which is the only handler in the feature
 * that does not consult `locate_friends_enabled`, for the reason stated there:
 * revocation must keep working precisely when everything else is being switched
 * off. If you are ever tempted to add a condition to this function, that is the
 * bug.
 */
export async function leaveLocateFriendsSession(
  sessionId: string,
  transport?: Partial<LocateFriendsTransport> | null,
): Promise<LocateFriendsResult<{ left: boolean }>> {
  const res = await call<any>({
    method: 'DELETE',
    path: `/sessions/${encodeURIComponent(sessionId)}/membership`,
    transport,
  });
  if (!res.ok) return res;
  return { ok: true, data: { left: res.data?.left === true || res.data?.ok === true } };
}

// ── Server snapshot → the client's member model ───────────────────────────────

/**
 * Translate one server-projected member into the shape the presence model and
 * the panel already speak, WITHOUT re-deriving any of it (§19).
 *
 * The precision comes back through `ceilingFromServerPrecision`, which is the
 * conservative side of the two ladders' disagreement — a server `venue` becomes
 * `approximate`, never `place_level`. Identity follows `mayRenderIdentity` on
 * the translated class, so a name the server sent can still be dropped here but
 * never added.
 */
export function memberSnapshotToState(
  snapshot: LocateFriendsMemberSnapshot,
): LocateMemberState {
  const cls = ceilingFromServerPrecision(snapshot.precision);
  const identityVisible = mayRenderIdentity(cls);

  const rawRange: DistanceRange | null = snapshot.proximityBucket
    ? PROXIMITY_BUCKET_RANGE[snapshot.proximityBucket]
    : null;

  // The ring's centre is a snapped grid point the server chose, never the
  // observed fix, so it is safe to carry as the drawable position — and
  // `positionCoarsened` says so rather than letting a reader assume otherwise.
  const position = snapshot.position ?? snapshot.ring?.center ?? null;

  const resolved: ResolvedPosition = {
    rung: snapshot.rung,
    degraded: snapshot.degraded || rungIndex(snapshot.rung) > 0,
    offline: snapshot.rung === null,
    privacyClass: cls,
    freshness: DECAY_STAGE_FRESHNESS[snapshot.decayStage],
    estimateState: snapshot.estimateState,
    decayStage: snapshot.decayStage,
    position: cls === 'none' ? null : position,
    positionCoarsened:
      position !== null && precisionRank(cls) < precisionRank('place_level'),
    distanceRange: rangeFor(cls, rawRange),
    proximity: snapshot.proximityBucket,
    checkpointId: null,
    checkpointLabel: snapshot.checkpointLabel,
    // The wire carries seconds; the model's field is milliseconds.
    ageMs: snapshot.ageSeconds == null ? null : Math.max(0, snapshot.ageSeconds * 1000),
    attempted: snapshot.rung ? [snapshot.rung] : [],
  };

  return {
    memberId: snapshot.memberId,
    displayName: identityVisible ? snapshot.displayName : null,
    avatarUrl: null,
    identityVisible,
    resolved,
    degraded: resolved.degraded,
  };
}

/**
 * Build the validated `LocateSession` the panel renders from, out of the
 * server's summary.
 *
 * `createLocateSession` is still the only constructor, so everything §12
 * requires of a session — a group, a bounded expiry, at least one opted-in
 * member — is enforced on this path too rather than assumed because the server
 * said so. The viewer's own id is required because the server deliberately
 * excludes the viewer from `members`, so without it the opted-in set could be
 * empty for a perfectly valid solo session.
 */
export function toLocateSession(
  envelope: {
    session: LocateFriendsSessionSummary | null;
    members: readonly { memberId: string }[];
    /** The read's own timestamp, when there is one. Falls back to `now`. */
    generatedAt?: string;
    /** When the read is stale, `lastReadAt` anchors the session instead. */
    lastReadAt?: number | null;
  },
  viewerMemberId: string,
  now: number,
): CreateSessionResult {
  const summary = envelope.session;
  if (!summary) return { ok: false, reason: 'missing_session_id' };
  const expiresAt = Date.parse(summary.expiresAt);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'missing_expiry' };

  const generatedAt = envelope.generatedAt
    ? Date.parse(envelope.generatedAt)
    : (envelope.lastReadAt ?? Number.NaN);
  const anchor = Number.isFinite(generatedAt) ? Math.min(generatedAt as number, now) : now;

  return createLocateSession({
    sessionId: summary.id,
    groupId: summary.groupScopeId || summary.id,
    optedInMemberIds: [viewerMemberId, ...envelope.members.map((m) => m.memberId)],
    startedAt: anchor,
    expiresAt,
    grantedClass: ceilingFromServerPrecision(summary.ceiling),
    label: summary.label,
  });
}

// ── The sync ──────────────────────────────────────────────────────────────────

export interface LocateFriendsLiveState {
  /**
   * `idle` before the first read; `ok` once one succeeded; `unavailable` is
   * TERMINAL — the sync has stopped and will not poll again.
   */
  status: 'idle' | 'ok' | 'unavailable';
  enabled: boolean;
  session: LocateFriendsSessionSummary | null;
  members: LocateFriendsMemberSnapshot[];
  /** Epoch ms of the last SUCCESSFUL read. Null until one lands. */
  lastReadAt: number | null;
  /** True when the most recent read failed. Members below are the cached set. */
  stale: boolean;
  /** Consecutive failed reads. Reset by any success. */
  consecutiveFailures: number;
  /** The last transport error, for a diagnostic line. Never a status. */
  lastError: string | null;
  /** True when any member is answering below the preferred rung. */
  degraded: boolean;
}

export const IDLE_LIVE_STATE: LocateFriendsLiveState = Object.freeze({
  status: 'idle',
  enabled: false,
  session: null,
  members: [],
  lastReadAt: null,
  stale: false,
  consecutiveFailures: 0,
  lastError: null,
  degraded: false,
}) as LocateFriendsLiveState;

export interface LocateFriendsSyncOptions {
  sessionId: string;
  /** Called after every state change. */
  onChange: (state: LocateFriendsLiveState) => void;
  /** Sample this device's position for the publish tick. Omit to read only. */
  sampleSignal?: () => LocateSignal | null | Promise<LocateSignal | null>;
  grant?: PrecisionGrant | null;
  capabilities?: PresenceCapabilities;
  transport?: Partial<LocateFriendsTransport> | null;
  readIntervalMs?: number;
  publishIntervalMs?: number;
  /** Injectable clock/timers, so the cadence is testable without waiting. */
  now?: () => number;
  setIntervalImpl?: (fn: () => void, ms: number) => any;
  clearIntervalImpl?: (handle: any) => void;
}

export interface LocateFriendsSync {
  start(): void;
  /** Idempotent. Clears BOTH timers and refuses every later tick. */
  stop(): void;
  isRunning(): boolean;
  state(): LocateFriendsLiveState;
  /** Read once, now. Safe to call before `start`. */
  refresh(): Promise<void>;
  /** Publish once, now. */
  publishOnce(): Promise<PublishOutcome | null>;
  /**
   * Leave the session and stop the sync. Unconditional — it does not consult
   * `enabled`, `status`, or anything else. See `leaveLocateFriendsSession`.
   */
  leave(): Promise<LocateFriendsResult<{ left: boolean }>>;
}

/**
 * A read poll + a publish poll over one session, with a lifecycle.
 *
 * THE LEAK THIS IS SHAPED TO PREVENT: an interval that outlives the screen and
 * keeps publishing somebody's location after they closed it. `stop()` clears
 * both handles AND flips `running`, so a tick already in flight when stop is
 * called cannot write its result back or schedule anything further. The same
 * flag makes `unavailable` and an ended session terminal without a second
 * mechanism.
 */
export function createLocateFriendsSync(
  options: LocateFriendsSyncOptions,
): LocateFriendsSync {
  const now = options.now ?? (() => Date.now());
  const setIntervalImpl = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = options.clearIntervalImpl ?? ((h) => clearInterval(h));
  const readMs = options.readIntervalMs ?? LOCATE_FRIENDS_READ_INTERVAL_MS;
  const publishMs = options.publishIntervalMs ?? LOCATE_FRIENDS_PUBLISH_INTERVAL_MS;

  let running = false;
  let readHandle: any = null;
  let publishHandle: any = null;
  let state: LocateFriendsLiveState = { ...IDLE_LIVE_STATE, members: [] };

  function emit(next: Partial<LocateFriendsLiveState>): void {
    state = { ...state, ...next };
    options.onChange(state);
  }

  function stop(): void {
    running = false;
    if (readHandle !== null) {
      clearIntervalImpl(readHandle);
      readHandle = null;
    }
    if (publishHandle !== null) {
      clearIntervalImpl(publishHandle);
      publishHandle = null;
    }
  }

  async function refresh(): Promise<void> {
    const res = await readLocateFriendsSession(options.sessionId, options.transport);

    if (!res.ok) {
      // RULE 4. The members already on screen stay on screen; the panel is told
      // they are stale. Emptying the list here would say "your friends left".
      if (res.error === 'aborted') return;
      emit({
        stale: true,
        consecutiveFailures: state.consecutiveFailures + 1,
        lastError: res.error,
      });
      return;
    }

    if (res.data.status !== 'ok') {
      // RULE 1. One state, and it is the end of the road — no retry, no
      // backoff schedule, nothing an observer could count.
      stop();
      emit({
        status: 'unavailable',
        enabled: res.data.enabled,
        session: null,
        members: [],
        stale: false,
        consecutiveFailures: 0,
        lastError: null,
        degraded: false,
      });
      return;
    }

    const members = res.data.members;
    emit({
      status: 'ok',
      enabled: true,
      session: res.data.session,
      members,
      lastReadAt: now(),
      stale: false,
      consecutiveFailures: 0,
      lastError: null,
      degraded: members.some((m) => m.degraded || !m.live),
    });

    // §12 "temporary and auto-expiring": when the clock runs out, so does the
    // poll. Nothing is scheduled past the session's own expiry.
    if (res.data.session && res.data.session.secondsRemaining <= 0) stop();
  }

  async function publishOnce(): Promise<PublishOutcome | null> {
    if (!options.sampleSignal) return null;
    const signal = await options.sampleSignal();
    if (!signal) return null;
    // The screen may have gone away while the sampler was awaiting a fix.
    if (!running) return null;

    const res = await publishLocateFriendsPosition(
      {
        sessionId: options.sessionId,
        rung: signal.rung,
        observedAt: signal.observedAt,
        position: signal.position ?? null,
        proximity: signal.proximity ?? null,
        checkpointLabel: signal.checkpointLabel ?? null,
        sessionCeiling: state.session
          ? ceilingFromServerPrecision(state.session.ceiling)
          : 'approximate',
        grant: options.grant ?? null,
        capabilities: options.capabilities,
        now: now(),
      },
      options.transport,
    );
    return res.ok ? res.data : null;
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      void refresh();
      readHandle = setIntervalImpl(() => {
        if (!running) return;
        void refresh();
      }, readMs);
      if (options.sampleSignal) {
        void publishOnce();
        publishHandle = setIntervalImpl(() => {
          if (!running) return;
          void publishOnce();
        }, publishMs);
      }
    },
    stop,
    isRunning: () => running,
    state: () => state,
    refresh,
    publishOnce,
    async leave() {
      // Order matters: stop first so no tick can publish a position between the
      // DELETE landing and the caller unmounting.
      stop();
      const res = await leaveLocateFriendsSession(options.sessionId, options.transport);
      emit({ status: 'unavailable', session: null, members: [], stale: false });
      return res;
    },
  };
}

export type { LocateSession, LocateMemberState, LocateSignal, LocateSignalRung };
