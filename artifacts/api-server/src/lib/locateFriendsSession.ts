/**
 * locateFriendsSession — the server half of Map spec §12 "Locate My Friends".
 *
 * §37 names two things this feature is one careless decision away from becoming:
 *
 *     "Do not build a public real-time people tracker."
 *     "Do not create permanent exact-location sharing."
 *
 * and §12 states the four constraints that keep it from becoming either:
 *
 *     "Opt-in only. Group-scoped. Temporary and auto-expiring.
 *      No public friend tracking."
 *
 * This module exists so those are ARITHMETIC AND SHAPES, not habits:
 *
 *   OPT-IN ONLY      A membership row cannot exist without `opted_in_at` and a
 *                    recorded `consent_source` (both NOT NULL in migration
 *                    2206). There is no "implicit member" state to forget.
 *   GROUP-SCOPED     `group_scope_kind` + `group_scope_id` are required by
 *                    `validateSessionRequest` and NOT NULL in the table. There
 *                    is no global session and no query that takes a viewport.
 *   AUTO-EXPIRING    `ttlMinutes` is REQUIRED and bounded. There is no default,
 *                    no clamp-after-the-fact and no "0 means forever": a
 *                    request without a usable TTL is REJECTED. `expires_at` is
 *                    NOT NULL with a CHECK bounding it to MAX_SESSION_MINUTES,
 *                    so an unbounded row cannot be inserted by any writer.
 *   NO PUBLIC        Every read here takes a `viewerId` and resolves it against
 *   TRACKING         a membership row first. There is no listing function, no
 *                    proximity query, and nothing that answers "which sessions
 *                    exist" — those functions are absent, not guarded.
 *
 * EXPIRY IS A READ-TIME PREDICATE, NOT A SWEEP
 * ============================================
 * `isSessionActive` and `decayStageAt` are consulted on every read. A sweeper
 * that has not run yet, or that has died, therefore cannot cause an expired
 * session to keep serving positions — the worst it can do is leave rows on
 * disk. This is the same posture SafeReturnLiveShareService takes with its
 * "hard expiry check (code-level, before DB status)", and it is the only
 * posture that is safe when the background job is the thing that broke.
 *
 * RELATIONSHIP TO WHAT ALREADY EXISTS
 * ===================================
 * Two temporary-location-share implementations already ship in this server and
 * NEITHER is reusable here, so this is new code that copies their posture
 * rather than a third parallel invention:
 *
 *   • services/tripCrew/TripCrewLocationService.ts is TRIP-scoped: it reads
 *     `trips`/`trip_members` and `trip_crew_location_sessions`, and its unit of
 *     sharing is a standing crew relationship with a per-trip preference row.
 *     §12's session is an ad-hoc group for one event, which is not a trip and
 *     must not create one. What IS reused is its exact block posture —
 *     `fetchBlockedSet`, and null meaning nobody.
 *   • services/safeReturn/SafeReturnLiveShareService.ts is 1:N from ONE sharer
 *     to named emergency contacts, with `can_receive_live_location` as the
 *     gate, and §23 gives Safe Return its own purpose-bound rung. It is not a
 *     symmetric group. What IS reused is its rule that `expires_at` is a hard
 *     cutoff enforced in code before any status column is believed.
 *
 * The precision ladder, estimate states and feature ceilings come from
 * presence/domain/types.ts, which is the authority — nothing here re-declares
 * them. The §24 gate is lib/protectedLocations.ts, reused rather than reworked.
 *
 * PURE-ISH. Everything policy-shaped in this file is a pure function taking an
 * explicit `nowMs`. The handful of functions that touch the database are at the
 * bottom, named `*Repo`-style, and hold no clock of their own.
 */
import {
  FEATURE_PRECISION_CEILING,
  PRECISION_LADDER,
  isLiveState,
  narrowestPrecision,
  precisionRank,
  type LocationPrecision,
  type PresenceEstimateState,
} from "../presence/domain/types.js";
import {
  classifyAgainstProtected,
  type ProtectedZone,
} from "./protectedLocations.js";
import {
  point,
  type MapObject,
  type PrivacyClass,
} from "./mapObjects.js";
import { fetchBlockedSet } from "./blocks.js";

// ── The flag ──────────────────────────────────────────────────────────────────

/**
 * OFF by default (migration 2206 seeds it false). Reads and writes fail SOFT —
 * an explicitly-disabled envelope, never an error — because a location feature
 * that errors loudly invites a client retry loop against a feature nobody
 * turned on.
 *
 * The LEAVE path is deliberately NOT gated by this flag. Revocation must work
 * whatever the capability flag says; a switch that can strand an opted-in
 * member inside a session they cannot leave is worse than the feature being on.
 */
export const LOCATE_FRIENDS_FLAG = "locate_friends_enabled";

// ── §12 "Group-scoped" ────────────────────────────────────────────────────────

/**
 * The scopes a session may be attached to. There is no `global`, no `nearby`
 * and no `public` member, and adding one would be the §37 non-goal in a single
 * commit. The set is closed here AND by a CHECK constraint in 2206.
 */
export const GROUP_SCOPE_KINDS = ["trip", "circle", "event", "plan"] as const;
export type GroupScopeKind = (typeof GROUP_SCOPE_KINDS)[number];

export function isGroupScopeKind(v: unknown): v is GroupScopeKind {
  return typeof v === "string" && (GROUP_SCOPE_KINDS as readonly string[]).includes(v);
}

// ── §12 "Temporary and auto-expiring" ─────────────────────────────────────────

/**
 * The hard ceiling on a session's life: 12 hours.
 *
 * WHY 12 HOURS, AND WHY THAT IS NOT AS LONG AS IT SOUNDS.
 *
 * §12's unit of work is an event or a day out — a festival, a conference, a
 * night that runs late, a group moving through an airport. Twelve hours covers
 * the longest single one of those without ever spanning a night and a following
 * morning, so a session cannot quietly survive a sleep and re-expose someone to
 * a group they joined yesterday. Anything longer stops being "an event" and
 * becomes the standing arrangement §37 forbids; anything much shorter forces
 * repeated re-consent in the middle of the event, which trains people to accept
 * location prompts without reading them.
 *
 * The session length is NOT the exposure window, and that is the substantive
 * part of the justification. §23's decay is enforced per POSITION: a fix is
 * servable at its own precision for 5 minutes, coarsens for 25 more, survives
 * as "last seen" for 30, and is gone at 60 — see DECAY_BOUNDARIES_MS. A member
 * who stops publishing disappears from the session within an hour regardless of
 * how much of the 12 hours remains. So the cap bounds how long an OPT-IN lasts,
 * while the decay bounds how long any LOCATION lasts, and the second is the one
 * that governs disclosure.
 *
 * This equals the client model's `MAX_SESSION_MS`
 * (travel-buddy-standalone/src/features/map/presence/locateFriends.ts). The two
 * are a contract: a session the client can construct must be one the server
 * will accept, or the client's own "unbounded is unconstructible" property is
 * merely local.
 */
export const MAX_SESSION_MINUTES = 12 * 60;

/** A session must actually last some time. There is no zero-length session. */
export const MIN_SESSION_MINUTES = 1;

// ── §52 the feature's ceiling ─────────────────────────────────────────────────

/**
 * DERIVED from the authority's table, never re-declared.
 *
 * presence/domain/types.ts owns `FEATURE_PRECISION_CEILING` and does not (yet)
 * name Locate My Friends. `crew` is the row that governs it: §23 groups Trip
 * Crew and Locate My Friends into the same sentence shape — "approximate or
 * permitted temporary precise" / "temporary group-scoped approximate/precise" —
 * so borrowing `crew` is the ceiling §23 already assigns this audience rather
 * than a new number invented here.
 *
 * A test asserts this is still a member of that table, so if the authority ever
 * splits the row out, the drift is a failing test and not a silent widening.
 */
export const LOCATE_FRIENDS_FEATURE_CEILING: LocationPrecision =
  FEATURE_PRECISION_CEILING.crew;

/**
 * The most a session may EVER be created at, and the default when the creator
 * does not say. `approximate` is §23's UNGRANTED rung for this purpose; a
 * session that wants `precise` has to ask for it explicitly.
 */
export const DEFAULT_SESSION_CEILING: LocationPrecision = "approximate";

/** Ceilings a creator may choose. Narrower than the ladder on purpose. */
export const SELECTABLE_SESSION_CEILINGS: readonly LocationPrecision[] = [
  "presence_only",
  "venue",
  "zone",
  "approximate",
  "nearby",
  "precise",
];

export function isLocationPrecision(v: unknown): v is LocationPrecision {
  return typeof v === "string" && (PRECISION_LADDER as readonly string[]).includes(v);
}

/**
 * The narrowest of any number of rungs. Empty input FAILS CLOSED to `none`, and
 * an unrecognised rung is treated as `none` rather than skipped — a bound we
 * cannot read is not a bound we get to ignore.
 *
 * There is deliberately no widening counterpart, exactly as in the authority.
 */
export function narrowestOfPrecisions(
  ...rungs: readonly (LocationPrecision | string | null | undefined)[]
): LocationPrecision {
  if (rungs.length === 0) return "none";
  let acc: LocationPrecision = "precise";
  for (const r of rungs) {
    const rung: LocationPrecision = isLocationPrecision(r) ? r : "none";
    acc = narrowestPrecision(acc, rung);
  }
  return acc;
}

// ── §12's signal ladder ───────────────────────────────────────────────────────

/** §12's "preferred signal sequence", in the spec's own order. */
export const LOCATE_SIGNAL_RUNGS = [
  "network_location",
  "event_cached_location",
  "device_proximity",
  "peer_relay",
  "last_known",
  "manual_checkpoint",
] as const;
export type LocateSignalRung = (typeof LOCATE_SIGNAL_RUNGS)[number];

export function isLocateSignalRung(v: unknown): v is LocateSignalRung {
  return typeof v === "string" && (LOCATE_SIGNAL_RUNGS as readonly string[]).includes(v);
}

/** Position in §12's chain; 0 is the preferred rung, -1 is unknown. */
export function rungIndex(rung: string | null | undefined): number {
  if (typeof rung !== "string") return -1;
  return (LOCATE_SIGNAL_RUNGS as readonly string[]).indexOf(rung);
}

/**
 * The most precise rung each signal may ever produce, ON THE SERVER'S LADDER.
 *
 * THE TWO LADDERS DISAGREE, AND THIS TABLE RESOLVES IT SERVER-SIDE.
 * The client model ranks §23's `place_level` ABOVE `approximate`; the server's
 * `PRECISION_LADDER` ranks `venue` (2) BELOW `zone` (3) and `approximate` (4).
 * The client records this in `LADDER_DISAGREEMENTS` and resolves it by
 * translating a server `venue` ceiling down to `approximate`.
 *
 * Here the SERVER's ordering is authoritative, so the table is chosen to be
 * monotone NON-INCREASING down §12's chain under `precisionRank` — a peer relay
 * can never outrank a live network fix by reordering — while never exceeding
 * what the client's own rung table permits for the same rung. A test asserts
 * both properties over the whole table rather than trusting this paragraph.
 */
export const RUNG_PRECISION_CEILING = {
  /** §12 rung 1. The only rung that may be a coordinate, and only briefly. */
  network_location: "precise",
  /** §12 rung 2 + §28 cached event map. A cached fix is an area, not a point. */
  event_cached_location: "approximate",
  /** §12 rung 3. Radio proximity is a bucket; it never becomes a coordinate. */
  device_proximity: "approximate",
  /** §12 rung 4. Second-hand evidence: someone else saw them. */
  peer_relay: "zone",
  /** §12 rung 5. A remembered position, not a current one. */
  last_known: "zone",
  /** §12 rung 6. The pin is the checkpoint, not the person. */
  manual_checkpoint: "venue",
} as const satisfies Record<LocateSignalRung, LocationPrecision>;

/** The §10 estimate state each rung produces at full freshness. */
export const RUNG_ESTIMATE_STATE = {
  network_location: "precise",
  event_cached_location: "recent",
  device_proximity: "nearby",
  peer_relay: "relayed",
  last_known: "last_known",
  manual_checkpoint: "inferred",
} as const satisfies Record<LocateSignalRung, PresenceEstimateState>;

// ── §23 decay, server-side ────────────────────────────────────────────────────

/**
 * §23: "Temporary location should decay automatically:
 *       Precise → Approximate → Last known → Expired."
 *
 * Four named stages, in the spec's order. `last_known` is not a fifth precision
 * rung — it is `approximate` geometry with the freshness removed, which is why
 * the ceiling table and the state table are separate. Conflating "how precise"
 * with "how current" is exactly how a stale pin becomes a live one, the failure
 * `PresenceEstimate` splits `confidence` from `freshness` to avoid.
 */
export const DECAY_STAGES = ["precise", "approximate", "last_known", "expired"] as const;
export type DecayStage = (typeof DECAY_STAGES)[number];

/**
 * Intervals measured from the OBSERVATION, mirroring the client model's
 * `DECAY_INTERVALS_MS` exactly. The two sides must agree or a client will draw
 * a rung the server did not serve.
 *
 *   0      → 5 min    precise
 *   5 min  → 30 min   approximate
 *   30 min → 60 min   last known
 *   60 min →          expired
 */
export const DECAY_INTERVALS_MS = {
  preciseHoldMs: 5 * 60_000,
  approximateHoldMs: 25 * 60_000,
  lastKnownHoldMs: 30 * 60_000,
} as const;

/** Cumulative upper bound (exclusive) of each non-terminal stage. */
export const DECAY_BOUNDARIES_MS = {
  precise: DECAY_INTERVALS_MS.preciseHoldMs,
  approximate: DECAY_INTERVALS_MS.preciseHoldMs + DECAY_INTERVALS_MS.approximateHoldMs,
  last_known:
    DECAY_INTERVALS_MS.preciseHoldMs +
    DECAY_INTERVALS_MS.approximateHoldMs +
    DECAY_INTERVALS_MS.lastKnownHoldMs,
} as const;

/** A position is worth storing for exactly as long as it can still be served. */
export const POSITION_TTL_MS = DECAY_BOUNDARIES_MS.last_known;

/** The ceiling each stage imposes. Non-increasing down the stage order. */
export const DECAY_STAGE_CEILING = {
  precise: "precise",
  approximate: "approximate",
  last_known: "approximate",
  expired: "none",
} as const satisfies Record<DecayStage, LocationPrecision>;

/**
 * Which stage an observation of the given age sits in.
 *
 * A non-finite age is `expired`: if we cannot say how old a fix is, we do not
 * get to present it at all (§37: "Do not let stale claims remain visually
 * live"). A negative age — a device clock ahead of ours — is clamped to 0,
 * which is safe because stage 0's ceiling raises nothing on its own.
 */
export function decayStageAt(elapsedMs: number): DecayStage {
  if (!Number.isFinite(elapsedMs)) return "expired";
  const e = elapsedMs < 0 ? 0 : elapsedMs;
  if (e < DECAY_BOUNDARIES_MS.precise) return "precise";
  if (e < DECAY_BOUNDARIES_MS.approximate) return "approximate";
  if (e < DECAY_BOUNDARIES_MS.last_known) return "last_known";
  return "expired";
}

/**
 * The §10 state to present, given the rung that answered and how old it is.
 *
 * THE RULE, STATED ONCE: a position may be presented as LIVE only inside the
 * five-minute `precise` stage. Past that the reading is `recent`, then
 * `last_known`, then `unknown`. §7 puts the 5-30 minute band at "recent", and a
 * `nearby`/`relayed` label — both of which `isLiveState` treats as current — on
 * a twenty-minute-old radio hit would be a stale claim wearing a live badge.
 *
 * A test asserts over the full rung x stage cross-product that
 * `isLiveState(state)` implies `stage === "precise"`.
 */
export function estimateStateFor(
  rung: LocateSignalRung,
  stage: DecayStage,
): PresenceEstimateState {
  if (stage === "expired") return "unknown";
  if (stage === "last_known") return "last_known";
  if (stage === "approximate") return "recent";
  return RUNG_ESTIMATE_STATE[rung];
}

// ── Geometry exposure ─────────────────────────────────────────────────────────

/**
 * What each rung is allowed to look like on the wire.
 *
 * `precise` is the ONLY rung that yields a coordinate. Everything from `nearby`
 * down yields a RING — a snapped centre plus an honest radius — and `venue` and
 * below yield no geometry at all. A rounded point is not a ring: it still says
 * "the person is here, ±rounding", and a client is free to draw it as a dot.
 * Emitting a different SHAPE is what makes the rung unmistakable downstream.
 */
export const RING_RADIUS_METERS = {
  none: null,
  presence_only: null,
  venue: null,
  zone: 1000,
  approximate: 500,
  nearby: 150,
  precise: null,
} as const satisfies Record<LocationPrecision, number | null>;

export interface GeoPoint { lat: number; lng: number }

export interface PositionRing {
  /** Snapped to a grid of side `radiusMeters`. Never the observed point. */
  center: GeoPoint;
  radiusMeters: number;
}

export function isFinitePoint(p: GeoPoint | null | undefined): p is GeoPoint {
  return (
    !!p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

const METERS_PER_DEG_LAT = 111_320;

/**
 * Snap a coordinate onto a grid of side `radiusMeters` and return the cell
 * centre plus that radius.
 *
 * The emitted centre is a property of the CELL, not of the observation, so two
 * fixes inside one cell produce byte-identical output and no amount of polling
 * narrows the position within the cell. The true point lies at most
 * `radius/sqrt(2)` from the centre, so the advertised radius is an honest
 * superset rather than a claim we cannot support.
 *
 * Returns null for a rung that may not carry geometry at all.
 */
export function coarsenToRing(
  p: GeoPoint,
  precision: LocationPrecision,
): PositionRing | null {
  const radiusMeters = RING_RADIUS_METERS[precision];
  if (radiusMeters == null || !isFinitePoint(p)) return null;
  const snap = (v: number, step: number) => (Math.floor(v / step) + 0.5) * step;

  const latStep = radiusMeters / METERS_PER_DEG_LAT;
  const centerLat = snap(p.lat, latStep);

  // The longitude step is derived from the SNAPPED latitude, never from the
  // observation's own. Using the raw latitude would make the longitude grid a
  // function of the exact position, so two fixes metres apart inside one cell
  // would land on different centres — and a client polling that difference
  // could narrow the position back down inside the ring. Deriving it from the
  // cell means every point in a cell produces byte-identical output.
  //
  // Near the poles metres-per-degree-longitude collapses; the clamp keeps the
  // step finite rather than producing a NaN centre.
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const lngStep = radiusMeters / (METERS_PER_DEG_LAT * Math.max(0.01, Math.abs(cosLat)));

  return {
    center: {
      lat: Number(centerLat.toFixed(6)),
      lng: Number(snap(p.lng, lngStep).toFixed(6)),
    },
    radiusMeters,
  };
}

export interface ExposedGeometry {
  /** Present ONLY at `precise`. */
  position: GeoPoint | null;
  /** Present from `nearby` down to `zone`. */
  ring: PositionRing | null;
}

export const NO_GEOMETRY: ExposedGeometry = Object.freeze({ position: null, ring: null });

/**
 * The single gate every coordinate leaves through.
 *
 * There is no other path in this module that copies a stored lat/lng into a
 * response, which is what makes "a member at approximate yields a ring" a
 * property of the code rather than a convention.
 */
export function exposeGeometry(
  p: GeoPoint | null | undefined,
  precision: LocationPrecision,
): ExposedGeometry {
  if (!isFinitePoint(p)) return NO_GEOMETRY;
  if (precision === "precise") return { position: { lat: p.lat, lng: p.lng }, ring: null };
  const ring = coarsenToRing(p, precision);
  return ring ? { position: null, ring } : NO_GEOMETRY;
}

// ── §24 protected zones ───────────────────────────────────────────────────────

/**
 * A §24 protection floor, expressed on the SERVER's precision ladder.
 *
 * lib/protectedLocations.ts speaks §23's `PrivacyClass`; this module speaks
 * `LocationPrecision`. The translation is conservative in the one place the two
 * ladders disagree: §23's `approximate` becomes `zone` (the wider ring) rather
 * than the server's `approximate`, so a protected-zone floor can never be
 * looser than the policy that produced it.
 */
export const PRIVACY_CLASS_AS_PRECISION_CEILING = {
  none: "none",
  aggregate_only: "presence_only",
  approximate: "zone",
  place_level: "venue",
  precise_temporary: "precise",
} as const satisfies Record<PrivacyClass, LocationPrecision>;

export function precisionCeilingFromPrivacyClass(
  cls: PrivacyClass | string | null | undefined,
): LocationPrecision {
  if (typeof cls !== "string") return "none";
  const hit = (PRIVACY_CLASS_AS_PRECISION_CEILING as Record<string, LocationPrecision>)[cls];
  return hit ?? "none";
}

/**
 * Run §24 over one member's observed point.
 *
 * The classification runs against the RAW coordinate — it has to, or a zone
 * could not tell whether the member is inside it — and happens strictly before
 * anything is serialized, which is §24's "before data reaches the client".
 *
 * Returns the precision ceiling §24 imposes. `crew_member` is deliberately not
 * escalated to suppression by protectedLocations.ts (it is relationship-gated
 * by this very module), so a coarsen-class zone coarsens and a suppress-class
 * zone withholds.
 */
export function protectionCeiling(
  p: GeoPoint | null | undefined,
  zones: readonly ProtectedZone[] | null,
): LocationPrecision {
  // An unreadable policy is NOT an absent policy — the caller passes null and
  // gets nothing, matching routes/mapProjection.ts's loadProtectedZones.
  if (zones === null) return "none";
  if (!isFinitePoint(p)) return "presence_only";
  const probe: MapObject = {
    id: "locate-friends-probe",
    kind: "crew_member",
    geometry: point(p.lat, p.lng),
    title: "member",
    privacyClass: "precise_temporary",
    renderingPriority: 0,
  };
  const decision = classifyAgainstProtected(probe, zones);
  if (decision.action === "suppress") return "none";
  if (decision.action === "coarsen") {
    return narrowestOfPrecisions(
      "zone",
      precisionCeilingFromPrivacyClass(decision.privacyFloor ?? "approximate"),
    );
  }
  return "precise";
}

// ── Session validation ────────────────────────────────────────────────────────

export interface SessionRequest {
  groupScopeKind: unknown;
  groupScopeId: unknown;
  ttlMinutes: unknown;
  ceiling?: unknown;
  label?: unknown;
}

export type SessionRejection =
  | "missing_group_scope_kind"
  | "missing_group_scope_id"
  | "missing_ttl"
  | "ttl_below_minimum"
  | "ttl_exceeds_maximum"
  | "invalid_ceiling";

export interface ValidatedSession {
  groupScopeKind: GroupScopeKind;
  groupScopeId: string;
  ttlMinutes: number;
  ceiling: LocationPrecision;
  label: string | null;
  startedAtMs: number;
  expiresAtMs: number;
}

export type ValidateResult =
  | { ok: true; value: ValidatedSession }
  | { ok: false; reason: SessionRejection };

/**
 * The ONLY way to turn a request into something insertable.
 *
 * `ttlMinutes` is REQUIRED. It is not defaulted, not inferred from a "session
 * type", and not clamped into range after the fact — an absent, non-numeric,
 * zero, negative, non-integer or over-long TTL is a REJECTION. That is the
 * whole of §12's "temporary and auto-expiring" at this layer, and it is the one
 * rule in this file that must never grow a convenience default: a default TTL
 * is how "temporary" becomes "whatever the last caller happened to send".
 *
 * Returns a result rather than throwing, so a caller cannot swallow the
 * rejection in a catch and proceed with a half-built session.
 */
export function validateSessionRequest(
  input: SessionRequest | null | undefined,
  nowMs: number,
): ValidateResult {
  if (!input || typeof input !== "object") return { ok: false, reason: "missing_group_scope_kind" };

  if (!isGroupScopeKind(input.groupScopeKind)) {
    return { ok: false, reason: "missing_group_scope_kind" };
  }
  if (typeof input.groupScopeId !== "string" || input.groupScopeId.trim() === "") {
    return { ok: false, reason: "missing_group_scope_id" };
  }

  const ttl = input.ttlMinutes;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || !Number.isInteger(ttl)) {
    return { ok: false, reason: "missing_ttl" };
  }
  if (ttl < MIN_SESSION_MINUTES) return { ok: false, reason: "ttl_below_minimum" };
  if (ttl > MAX_SESSION_MINUTES) return { ok: false, reason: "ttl_exceeds_maximum" };

  let ceiling: LocationPrecision = DEFAULT_SESSION_CEILING;
  if (input.ceiling !== undefined && input.ceiling !== null) {
    if (!isLocationPrecision(input.ceiling) || !SELECTABLE_SESSION_CEILINGS.includes(input.ceiling)) {
      return { ok: false, reason: "invalid_ceiling" };
    }
    ceiling = input.ceiling;
  }

  if (!Number.isFinite(nowMs)) return { ok: false, reason: "missing_ttl" };

  const label =
    typeof input.label === "string" && input.label.trim() !== ""
      ? input.label.trim().slice(0, 80)
      : null;

  return {
    ok: true,
    value: {
      groupScopeKind: input.groupScopeKind,
      groupScopeId: input.groupScopeId.trim(),
      ttlMinutes: ttl,
      ceiling,
      label,
      startedAtMs: nowMs,
      expiresAtMs: nowMs + ttl * 60_000,
    },
  };
}

// ── Session rows ──────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  group_scope_kind: string;
  group_scope_id: string;
  created_by: string;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  ceiling: string;
  label: string | null;
}

export interface MembershipRow {
  session_id: string;
  user_id: string;
  opted_in_at: string;
  consent_source: string;
  left_at: string | null;
}

export interface PositionRow {
  session_id: string;
  user_id: string;
  rung: string;
  precision: string;
  lat: number | null;
  lng: number | null;
  proximity_bucket: string | null;
  checkpoint_label: string | null;
  observed_at: string;
  expires_at: string;
}

function toMs(t: string | null | undefined): number | null {
  if (typeof t !== "string" || t === "") return null;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Is this session serving anything right now?
 *
 * FAIL-CLOSED at every step: a missing row, an unparseable `expires_at`, an
 * unparseable clock and an `ended_at` in the past all answer false. There is no
 * status column in the answer on purpose — a `status = 'active'` that a dead
 * sweeper never updated is precisely the lie this function exists to ignore.
 */
export function isSessionActive(
  row: SessionRow | null | undefined,
  nowMs: number,
): boolean {
  if (!row) return false;
  if (!Number.isFinite(nowMs)) return false;
  const expires = toMs(row.expires_at);
  if (expires === null) return false;
  if (nowMs >= expires) return false;
  const started = toMs(row.started_at);
  if (started !== null && nowMs < started) return false;
  const ended = toMs(row.ended_at);
  if (ended !== null && nowMs >= ended) return false;
  return true;
}

/** A membership is live only while it exists and has not been left. */
export function isMembershipLive(
  row: MembershipRow | null | undefined,
  nowMs: number,
): boolean {
  if (!row) return false;
  if (!Number.isFinite(nowMs)) return false;
  if (typeof row.opted_in_at !== "string" || row.opted_in_at === "") return false;
  const left = toMs(row.left_at);
  if (left !== null && nowMs >= left) return false;
  return true;
}

// ── The member view (the client's shape) ──────────────────────────────────────

export interface MemberView {
  memberId: string;
  /** Null whenever the rung forbids rendering an identity (§23). */
  displayName: string | null;
  precision: LocationPrecision;
  estimateState: PresenceEstimateState;
  decayStage: DecayStage;
  /** Which §12 rung answered, or null when nothing did. */
  rung: LocateSignalRung | null;
  /** True when a rung below the preferred one answered, or nothing did. */
  degraded: boolean;
  /** True only inside the 5-minute precise stage. */
  live: boolean;
  position: GeoPoint | null;
  ring: PositionRing | null;
  proximityBucket: string | null;
  checkpointLabel: string | null;
  /** Age of the answering observation, seconds. Null when nothing answered. */
  ageSeconds: number | null;
}

/** The shape for "this member is in the session but has nothing to show". */
export function notSharing(memberId: string): MemberView {
  return {
    memberId,
    displayName: null,
    precision: "none",
    estimateState: "unknown",
    decayStage: "expired",
    rung: null,
    degraded: true,
    live: false,
    position: null,
    ring: null,
    proximityBucket: null,
    checkpointLabel: null,
    ageSeconds: null,
  };
}

/** §23 — an identity may be attached only from `approximate` up. */
export function mayRenderIdentity(precision: LocationPrecision): boolean {
  return precisionRank(precision) >= precisionRank("approximate");
}

export interface ProjectMemberInput {
  memberId: string;
  displayName: string | null;
  position: PositionRow | null;
  sessionCeiling: LocationPrecision;
  zones: readonly ProtectedZone[] | null;
  nowMs: number;
}

/**
 * One stored position → one client-shaped member state.
 *
 * The precision is the narrowest of FIVE independent bounds, and every one of
 * them can only tighten:
 *
 *   1. what the writer stored (already narrowed at write time),
 *   2. the feature ceiling (§52),
 *   3. the session's own ceiling (what the group agreed to),
 *   4. the answering rung's ceiling (§12's chain),
 *   5. the §23 decay stage for the observation's age,
 *   6. the §24 protected-zone floor for where the member actually is.
 *
 * A member whose precision lands on `none` is returned as `notSharing` — the
 * same shape as a member with no signal at all, so a reader cannot distinguish
 * "suppressed" from "not reachable" and therefore cannot leak the difference.
 */
export function projectMember(input: ProjectMemberInput): MemberView {
  const { memberId, position, sessionCeiling, zones, nowMs } = input;
  if (!position || !isLocateSignalRung(position.rung)) return notSharing(memberId);

  const observedMs = toMs(position.observed_at);
  if (observedMs === null || !Number.isFinite(nowMs)) return notSharing(memberId);

  const elapsed = nowMs - observedMs;
  const stage = decayStageAt(elapsed);
  if (stage === "expired") return notSharing(memberId);

  const rawPoint: GeoPoint | null =
    position.lat != null && position.lng != null
      ? { lat: Number(position.lat), lng: Number(position.lng) }
      : null;

  const precision = narrowestOfPrecisions(
    position.precision,
    LOCATE_FRIENDS_FEATURE_CEILING,
    sessionCeiling,
    RUNG_PRECISION_CEILING[position.rung],
    DECAY_STAGE_CEILING[stage],
    // §24 only constrains a member we actually have a coordinate for; with no
    // coordinate there is nothing a zone could be asked about.
    rawPoint ? protectionCeiling(rawPoint, zones) : "precise",
  );

  if (precision === "none") return notSharing(memberId);

  const geometry = exposeGeometry(rawPoint, precision);
  const state = estimateStateFor(position.rung, stage);
  const identity = mayRenderIdentity(precision);

  return {
    memberId,
    displayName: identity ? input.displayName : null,
    precision,
    estimateState: state,
    decayStage: stage,
    rung: position.rung,
    degraded: rungIndex(position.rung) > 0 || stage !== "precise",
    live: isLiveState(state),
    position: geometry.position,
    ring: geometry.ring,
    proximityBucket: position.proximity_bucket ?? null,
    checkpointLabel:
      precisionRank(precision) >= precisionRank("venue") ? position.checkpoint_label ?? null : null,
    ageSeconds: Math.max(0, Math.round(elapsed / 1000)),
  };
}

// ── Write-side precision ──────────────────────────────────────────────────────

export interface PositionSubmission {
  rung: LocateSignalRung;
  requestedPrecision: LocationPrecision;
  lat: number | null;
  lng: number | null;
  proximityBucket: string | null;
  checkpointLabel: string | null;
  observedAtMs: number;
}

/**
 * The precision a submission is STORED at.
 *
 * `narrowestPrecision` folded over what was asked for, §52's feature ceiling,
 * the session's ceiling and §12's rung ceiling. Because the only combinator
 * narrows, storage can only ever tighten — a client cannot widen its own
 * exposure by asking, and neither can a future caller of this function.
 */
export function storedPrecisionFor(
  submission: Pick<PositionSubmission, "rung" | "requestedPrecision">,
  sessionCeiling: LocationPrecision,
): LocationPrecision {
  return narrowestOfPrecisions(
    submission.requestedPrecision,
    LOCATE_FRIENDS_FEATURE_CEILING,
    sessionCeiling,
    isLocateSignalRung(submission.rung) ? RUNG_PRECISION_CEILING[submission.rung] : "none",
  );
}

/**
 * What is actually persisted for a submission.
 *
 * A coordinate is dropped at write time for any rung below `precise`. Storing
 * a raw fix "just in case the ceiling is raised later" is how a session becomes
 * a location history: the ceiling can be raised, the stored point cannot be
 * un-stored, and §37's "no permanent exact-location sharing" would then depend
 * on a query rather than on the data.
 */
export function positionRowFor(
  sessionId: string,
  userId: string,
  submission: PositionSubmission,
  sessionCeiling: LocationPrecision,
  sessionExpiresAtMs: number,
): PositionRow {
  const precision = storedPrecisionFor(submission, sessionCeiling);
  // `typeof === "number"` before the finiteness check, deliberately: `Number(null)`
  // is 0, so coercing first would turn a submission with NO coordinate into a
  // stored fix at 0,0 — a fabricated position off the coast of Ghana, presented
  // at the `precise` rung.
  const keepPoint =
    precision === "precise" &&
    typeof submission.lat === "number" &&
    typeof submission.lng === "number" &&
    isFinitePoint({ lat: submission.lat, lng: submission.lng });

  // A stored position never outlives the session, and never outlives its own
  // decay window. Both are hard bounds; the earlier one wins.
  const ttlEnd = Math.min(submission.observedAtMs + POSITION_TTL_MS, sessionExpiresAtMs);

  return {
    session_id: sessionId,
    user_id: userId,
    rung: submission.rung,
    precision,
    lat: keepPoint ? Number(submission.lat) : null,
    lng: keepPoint ? Number(submission.lng) : null,
    proximity_bucket: submission.proximityBucket,
    checkpoint_label: submission.checkpointLabel,
    observed_at: new Date(submission.observedAtMs).toISOString(),
    expires_at: new Date(ttlEnd).toISOString(),
  };
}

// ── Database access ───────────────────────────────────────────────────────────
//
// Everything below takes an injected client and an explicit `nowMs`. Nothing
// below decides policy; the functions above do, and these only move rows.

type Db = {
  from: (table: string) => any;
};

export const SESSIONS_TABLE = "locate_friends_sessions";
export const MEMBERS_TABLE = "locate_friends_members";
export const POSITIONS_TABLE = "locate_friends_positions";
export const AUDIT_TABLE = "locate_friends_audit";

export const AUDIT_EVENTS = [
  "session_started",
  "member_joined",
  "member_left",
  "position_written",
  "session_ended",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

/**
 * §12's safety story is "someone consented, to a specific group, for a specific
 * window", and that is only checkable if every membership and every position
 * write is attributable. This is that record.
 *
 * IT CARRIES NO COORDINATE, AND THAT IS THE DESIGN. An audit row per position
 * write that included the position would be a movement history — the tracker
 * §37 forbids, built accidentally out of the mechanism meant to prevent it. So
 * the row records WHO wrote, to WHICH session, at WHAT rung and precision, and
 * WHEN. That answers every accountability question ("was this member opted in
 * when they published at precise?") without answering the one question the
 * feature must never be able to answer later ("where were they at 11pm?").
 *
 * Non-fatal by contract: the error is returned to the caller for logging, never
 * thrown, because an audit write must not be able to fail a leave.
 */
export async function writeAudit(
  db: Db,
  row: {
    event: AuditEvent;
    sessionId: string;
    actorId: string;
    rung?: string | null;
    precision?: string | null;
    nowMs: number;
  },
): Promise<{ ok: boolean; error?: unknown }> {
  const { error } = await db.from(AUDIT_TABLE).insert({
    event: row.event,
    session_id: row.sessionId,
    actor_id: row.actorId,
    rung: row.rung ?? null,
    precision: row.precision ?? null,
    at: new Date(row.nowMs).toISOString(),
  });
  return error ? { ok: false, error } : { ok: true };
}

export async function loadSession(
  db: Db,
  sessionId: string,
): Promise<{ row: SessionRow | null; unreadable: boolean }> {
  const { data, error } = await db
    .from(SESSIONS_TABLE)
    .select("id, group_scope_kind, group_scope_id, created_by, started_at, expires_at, ended_at, ceiling, label")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) return { row: null, unreadable: true };
  return { row: (data as SessionRow | null) ?? null, unreadable: false };
}

/**
 * Resolve the caller's membership.
 *
 * Three outcomes, and `unreadable` is NOT folded into `not_member` on purpose:
 * the caller must be able to answer a read error with an empty envelope rather
 * than with a 403 that tells a real member they were removed.
 */
export async function loadMembership(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<{ row: MembershipRow | null; unreadable: boolean }> {
  const { data, error } = await db
    .from(MEMBERS_TABLE)
    .select("session_id, user_id, opted_in_at, consent_source, left_at")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { row: null, unreadable: true };
  return { row: (data as MembershipRow | null) ?? null, unreadable: false };
}

/**
 * §24 policy rows.
 *
 * Mirrors routes/mapProjection.ts's loader deliberately rather than importing
 * it: that one is a module-private function behind a 30s cache owned by the
 * projection route, and reaching into another route's cache to make a privacy
 * decision would couple two surfaces' failure modes. The contract is the part
 * that matters and it is identical — a read ERROR returns null, and null means
 * "policy unknown", which the caller must answer with nothing.
 */
export async function loadProtectedZones(db: Db): Promise<ProtectedZone[] | null> {
  const { data, error } = await db
    .from("protected_zones")
    .select("id, category, action, privacy_floor, shape, center_lat, center_lng, radius_meters, ring, jurisdiction, policy_ref")
    .eq("active", true);
  if (error || !Array.isArray(data)) return null;

  const zones: ProtectedZone[] = [];
  for (const row of data as any[]) {
    const base = {
      id: String(row.id),
      category: String(row.category),
      action: row.action ?? undefined,
      privacyFloor: row.privacy_floor ?? undefined,
      jurisdiction: row.jurisdiction ?? undefined,
      policyRef: row.policy_ref ?? undefined,
    };
    if (row.shape === "circle") {
      zones.push({
        ...base,
        shape: "circle",
        center: { lat: Number(row.center_lat), lng: Number(row.center_lng) },
        radiusMeters: Number(row.radius_meters),
      } as ProtectedZone);
    } else {
      // A malformed ring stays in the list: classifyAgainstProtected treats
      // unparseable geometry as SUPPRESS. Dropping it would turn a broken
      // policy into no policy.
      zones.push({ ...base, shape: "polygon", ring: row.ring } as ProtectedZone);
    }
  }
  return zones;
}

// ── The read ──────────────────────────────────────────────────────────────────

export type ReadStatus = "ok" | "not_found" | "not_member" | "expired" | "unreadable";

export interface SessionSummary {
  id: string;
  groupScopeKind: string;
  groupScopeId: string;
  expiresAt: string;
  secondsRemaining: number;
  ceiling: LocationPrecision;
  label: string | null;
}

export interface ReadResult {
  status: ReadStatus;
  session: SessionSummary | null;
  members: MemberView[];
}

const EMPTY_READ: ReadResult = Object.freeze({
  status: "not_found" as ReadStatus,
  session: null,
  members: [],
});

/**
 * Read one session as one of its members.
 *
 * The gates run in this order and every one of them fails closed:
 *
 *   1. the session must exist and be readable,
 *   2. it must be ACTIVE AT `nowMs` — checked here, on this request, with no
 *      reference to any status column and no dependence on a sweep having run,
 *   3. the viewer must hold a live membership row,
 *   4. the block set must be readable; null means nobody (fetchBlockedSet's
 *      documented contract, and the same choice TripCrewLocationService makes),
 *   5. the §24 policy must be readable; null means nobody,
 *   6. each member is projected through `projectMember`, which applies the
 *      decay and the ceilings.
 *
 * There is no branch that returns members without passing all six.
 */
export async function readSessionForViewer(
  db: Db,
  sessionId: string,
  viewerId: string,
  nowMs: number,
): Promise<ReadResult> {
  const { row: session, unreadable } = await loadSession(db, sessionId);
  if (unreadable) return { ...EMPTY_READ, status: "unreadable" };
  if (!session) return { ...EMPTY_READ, status: "not_found" };

  // (2) EXPIRY ON READ. Deliberately before the membership check so an expired
  // session looks the same to a member and a stranger.
  if (!isSessionActive(session, nowMs)) {
    return { ...EMPTY_READ, status: "expired" };
  }

  const { row: membership, unreadable: mUnreadable } = await loadMembership(db, sessionId, viewerId);
  if (mUnreadable) return { ...EMPTY_READ, status: "unreadable" };
  if (!isMembershipLive(membership, nowMs)) {
    return { ...EMPTY_READ, status: "not_member" };
  }

  const blocked = await fetchBlockedSet(db as any, viewerId);
  if (blocked === null) {
    // Documented contract: null is "cannot tell", and cannot-tell is nobody.
    return { status: "ok", session: summarize(session, nowMs), members: [] };
  }

  const zones = await loadProtectedZones(db);

  const { data: memberRows, error: membersError } = await db
    .from(MEMBERS_TABLE)
    .select("session_id, user_id, opted_in_at, consent_source, left_at")
    .eq("session_id", sessionId)
    .is("left_at", null);
  if (membersError) return { ...EMPTY_READ, status: "unreadable" };

  const otherIds = ((memberRows as MembershipRow[]) ?? [])
    .filter((r) => isMembershipLive(r, nowMs))
    .map((r) => r.user_id)
    .filter((id) => id !== viewerId && !blocked.has(id));

  if (otherIds.length === 0) {
    return { status: "ok", session: summarize(session, nowMs), members: [] };
  }

  const { data: positionRows, error: positionsError } = await db
    .from(POSITIONS_TABLE)
    .select("session_id, user_id, rung, precision, lat, lng, proximity_bucket, checkpoint_label, observed_at, expires_at")
    .eq("session_id", sessionId)
    .in("user_id", otherIds);
  if (positionsError) return { ...EMPTY_READ, status: "unreadable" };

  const positions = new Map<string, PositionRow>();
  for (const r of ((positionRows as PositionRow[]) ?? [])) positions.set(r.user_id, r);

  const { data: profileRows } = await db
    .from("profiles")
    .select("id, display_name")
    .in("id", otherIds);
  const names = new Map<string, string | null>();
  for (const p of ((profileRows as any[]) ?? [])) names.set(p.id, p.display_name ?? null);

  const sessionCeiling: LocationPrecision = isLocationPrecision(session.ceiling)
    ? session.ceiling
    : "none";

  const members = otherIds.map((id) =>
    projectMember({
      memberId: id,
      displayName: names.get(id) ?? null,
      position: positions.get(id) ?? null,
      sessionCeiling,
      zones,
      nowMs,
    }),
  );

  return { status: "ok", session: summarize(session, nowMs), members };
}

function summarize(row: SessionRow, nowMs: number): SessionSummary {
  const expires = toMs(row.expires_at) ?? nowMs;
  return {
    id: row.id,
    groupScopeKind: row.group_scope_kind,
    groupScopeId: row.group_scope_id,
    expiresAt: row.expires_at,
    secondsRemaining: Math.max(0, Math.floor((expires - nowMs) / 1000)),
    ceiling: isLocationPrecision(row.ceiling) ? row.ceiling : "none",
    label: row.label ?? null,
  };
}

// ── Leaving ───────────────────────────────────────────────────────────────────

export type LeaveOutcome = "left" | "not_member" | "error";

/**
 * Leave, and stop being visible NOW.
 *
 * Two writes, in this order and for this reason:
 *
 *   1. DELETE the stored position. Exposure stops because the row a reader
 *      would have projected no longer exists — not because a later sweep will
 *      get to it, and not because a flag was flipped that some cache still
 *      disagrees with.
 *   2. Stamp `left_at`, which closes the membership for every future read.
 *
 * If the position delete fails, `left_at` is still stamped and the outcome is
 * still a successful leave: the read path filters on `left_at` independently,
 * so the member is invisible either way. The reverse order would leave a window
 * where the membership was closed but the position was still readable by a
 * concurrent request, which is the window this order exists to close.
 */
export async function leaveSession(
  db: Db,
  sessionId: string,
  userId: string,
  nowMs: number,
): Promise<{ outcome: LeaveOutcome; positionDeleteError?: unknown }> {
  const { row, unreadable } = await loadMembership(db, sessionId, userId);
  if (unreadable) return { outcome: "error" };
  if (!row) return { outcome: "not_member" };

  const { error: delError } = await db
    .from(POSITIONS_TABLE)
    .delete()
    .eq("session_id", sessionId)
    .eq("user_id", userId);

  const { error: updError } = await db
    .from(MEMBERS_TABLE)
    .update({ left_at: new Date(nowMs).toISOString() })
    .eq("session_id", sessionId)
    .eq("user_id", userId);

  if (updError) return { outcome: "error", positionDeleteError: delError ?? undefined };
  return { outcome: "left", positionDeleteError: delError ?? undefined };
}
