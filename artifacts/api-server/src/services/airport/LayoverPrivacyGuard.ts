/**
 * LayoverPrivacyGuard
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §14   "Aggregate presence should be the default; identity and precise
 *          location are progressively disclosed only with user consent."
 *          The L0..L4 ladder (census L127, L128, L130, L131, L132).
 *   §17   Privacy, permissions and data lifecycle (census L158, L166).
 *   §17.1 "Precise crew sharing: separate explicit control, off by default."
 *
 * ── WHAT THIS HEADER USED TO CLAIM, AND WHY IT WAS FALSE ────────────────────
 * It said this module "Enforces Ghost Mode, location mode settings, and meetup
 * privacy rules". Measured 2026-09-08: `isSharingAllowed` and
 * `sanitizeNearbyTraveler` were referenced ONLY from `src/test/airport.test.ts`.
 * The live presence path — `cityPresence` in `routes/airport.ts`, reached from
 * `GET /:id/presence` and from `/overview` — consulted `share_city_status` and
 * nothing else. A traveller who had set `location_mode: "off"`, or paused
 * sharing, or turned ghost mode on for the trip, was still PUBLISHED to every
 * other opted-in traveller in the city, and still shown the others. The
 * settings were stored correctly and then ignored — the same defect class
 * `LocationPermissionService` fixed for Pulse and Discovery in #442.
 *
 * ── THE FAIL-CLOSED RULE THAT GOVERNS EVERY READ BELOW ──────────────────────
 * supabase-js RESOLVES on a database error. `const { data } = await …` with an
 * unbound `error` therefore reads an UNREADABLE preference row as an ABSENT
 * one, and for a sharing gate the shipped default for "absent" is CONSENT.
 * Every read in this file binds `error` and answers a failure with the CLOSED
 * value — not published, not shown, `degraded: true` so the caller can say so.
 * `loadPreferences` (services/location/LocationPermissionService) already does
 * this for `location_preferences`; the ghost-mode read here does it for
 * `trip_crew_location_preferences`.
 *
 * That table's other reader, `TripCrewLocationService.getCrewPreferences`, had
 * the same defect and it is now FIXED: it binds `error` and throws, so an
 * unreadable row no longer reads as "ghost mode off" on the user's own privacy
 * screen. This note is kept rather than deleted because the finding is what
 * made the fix findable.
 *
 * Also: strips exact GPS from all layover outputs; nearby travellers are shown
 * as approximate city/zone only; meetup location is hidden until accepted.
 */

export interface RawRecommendation {
  id?: string;
  recType: string;
  title: string;
  description?: string | null;
  safetyRating: string;
  travelTimeMin: number;
  /** Provenance of travelTimeMin. Absent = not measured (travelTimeSourceFor). */
  travelTimeSource?: TravelTimeSource | null;
  activityTimeMin: number;
  returnBufferMin: number;
  hardReturnTime?: Date | string | null;
  warningReason?: string | null;
  insideAirport: boolean;
  locationLabel?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  // Raw coords — NEVER forwarded to client
  lat?: number | null;
  lng?: number | null;
  planItemId?: string | null;
  placeId?: string | null;
  // Meetup: exact location hidden until accepted
  meetupAccepted?: boolean;
  sortOrder?: number;
}

export interface SafeRecommendation {
  id?: string;
  recType: string;
  title: string;
  description: string | null;
  safetyRating: string;
  safetyLabel: string;
  travelTimeMin: number;
  /**
   * How travelTimeMin was obtained. "category_default" means a per-category
   * constant, not a route — the client must not present it as measured.
   * Always populated; never "measured" on this tree (no producer exists).
   */
  travelTimeSource: TravelTimeSource;
  activityTimeMin: number;
  returnBufferMin: number;
  hardReturnTime: string | null;
  warningReason: string | null;
  insideAirport: boolean;
  // Safe location info — no coords
  locationLabel: string | null;
  city: string | null;
  neighborhood: string | null;
  // Meetup location hidden until accepted
  meetupLocationHidden: boolean;
  meetupLocationReveal: string | null;
  planItemId: string | null;
  placeId: string | null;
  sortOrder: number;
}

import { safetyLabel, travelTimeSourceFor, type TravelTimeSource } from "./LayoverSafetyEngine.js";

export function sanitizeRecommendation(rec: RawRecommendation): SafeRecommendation {
  const isMeetup = rec.recType === "meetup";
  // Hide exact meetup location until accepted
  const meetupLocationHidden = isMeetup && !rec.meetupAccepted;

  let hardReturnStr: string | null = null;
  if (rec.hardReturnTime) {
    try {
      hardReturnStr = new Date(rec.hardReturnTime).toISOString();
    } catch { hardReturnStr = null; }
  }

  return {
    id:                   rec.id,
    recType:              rec.recType,
    title:                rec.title,
    description:          rec.description   ?? null,
    safetyRating:         rec.safetyRating,
    safetyLabel:          safetyLabel(rec.safetyRating as any),
    travelTimeMin:        rec.travelTimeMin,
    travelTimeSource:     travelTimeSourceFor(rec),
    activityTimeMin:      rec.activityTimeMin,
    returnBufferMin:      rec.returnBufferMin,
    hardReturnTime:       hardReturnStr,
    warningReason:        rec.warningReason  ?? null,
    insideAirport:        rec.insideAirport,
    locationLabel:        meetupLocationHidden ? null : (rec.locationLabel ?? null),
    city:                 rec.city           ?? null,
    neighborhood:         meetupLocationHidden ? null : (rec.neighborhood ?? null),
    meetupLocationHidden,
    meetupLocationReveal: meetupLocationHidden
      ? "Exact meetup location revealed after invite is accepted."
      : null,
    planItemId:           rec.planItemId ?? null,
    placeId:              rec.placeId    ?? null,
    sortOrder:            rec.sortOrder  ?? 0,
  };
}

/** Strip GPS from Compass answers — replace any coordinate-like patterns. */
export function sanitizeCompassAnswer(text: string): string {
  // Remove patterns like (12.345, 67.890) or coordinates mentioned literally
  return text
    .replace(/\(?\s*-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\s*\)?/g, "[location hidden]")
    .replace(/\b-?\d{1,3}\.\d{4,}\b/g, "[coords hidden]");
}

/** Sanitize nearby traveler — return only city/zone, never exact coords. */
export function sanitizeNearbyTraveler(traveler: {
  userId: string;
  username?: string | null;
  avatarUrl?: string | null;
  city?: string | null;
  country?: string | null;
  // strip anything more precise
  lat?: number | null;
  lng?: number | null;
  neighborhood?: string | null;
}): {
  userId: string;
  username: string | null;
  avatarUrl: string | null;
  approximateLocation: string | null;
} {
  const parts = [traveler.city, traveler.country].filter(Boolean);
  return {
    userId:              traveler.userId,
    username:            traveler.username  ?? null,
    avatarUrl:           traveler.avatarUrl ?? null,
    approximateLocation: parts.length > 0 ? parts.join(", ") : null,
  };
}

/** Check if GPS sharing context is safe to include (ghost mode / location off). */
export function isSharingAllowed(opts: {
  locationMode: string;
  sharingPaused: boolean;
  ghostMode?: boolean;
}): boolean {
  if (opts.sharingPaused) return false;
  if (opts.ghostMode) return false;
  if (opts.locationMode === "off") return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 presence ladder and §17 sharing gate
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { loadPreferences } from "../location/LocationPermissionService.js";

const privacyLogger = rootLogger.child({ service: "LayoverPrivacyGuard" });

/**
 * Spec §14 visibility levels, weakest disclosure first.
 *
 *   L0_AGGREGATE            "14 travelers connecting here" — a count, nothing else.
 *   L1_INTENT               "5 open to food" — an opt-in intent bucket, still no identity.
 *   L2_DISCOVERY            profiles visible under policy.
 *   L3_CREW                 a formed crew: shared thread / meeting point.
 *   L4_TEMPORARY_LOCATION   explicit, scoped, auto-expiring precise location.
 *
 * Ordered, because "the highest level this viewer may see" has to be a single
 * comparable value; `presenceLevelAtMost` is the only way to compare them, so a
 * caller cannot accidentally compare the strings.
 */
export const PRESENCE_LEVELS = [
  "L0_AGGREGATE",
  "L1_INTENT",
  "L2_DISCOVERY",
  "L3_CREW",
  "L4_TEMPORARY_LOCATION",
] as const;
export type PresenceLevel = (typeof PRESENCE_LEVELS)[number];

export function presenceLevelRank(level: PresenceLevel): number {
  return PRESENCE_LEVELS.indexOf(level);
}

/** Is `level` no more disclosing than `ceiling`? */
export function presenceLevelAtMost(level: PresenceLevel, ceiling: PresenceLevel): boolean {
  return presenceLevelRank(level) <= presenceLevelRank(ceiling);
}

/**
 * Why a sharing gate refused. Every value is a fact about the traveller's own
 * stored settings except `preferences_unreadable` / `ghost_mode_unreadable`,
 * which are facts about this server's ability to read them — kept separate so a
 * caller never tells a traveller "you turned this off" when it does not know.
 */
export type SharingDenialReason =
  | "sharing_paused"
  | "location_mode_off"
  | "ghost_mode"
  | "preferences_unreadable"
  | "ghost_mode_unreadable";

export interface SharingGateResult {
  /** May this traveller's layover presence be published, and may they see others? */
  allowed: boolean;
  reasons: SharingDenialReason[];
  /** TRUE when at least one input is the CLOSED fallback, not the stored value. */
  degraded: boolean;
  locationMode: string;
  sharingPaused: boolean;
  ghostMode: boolean;
}

/**
 * Ghost mode for the trip this layover belongs to, read FAIL-CLOSED.
 *
 * No global ghost-mode store exists on this tree: `user_location_privacy` is
 * the pre-0032 name of `location_preferences` and has no reader or writer, and
 * `location_preferences` has no ghost column. The only real ghost-mode switch a
 * traveller can throw is per-trip (`trip_crew_location_preferences.
 * ghost_mode_enabled`, written by `PATCH /trips/:id/crew-location/preferences`).
 * A layover with no `trip_id` therefore has no ghost-mode input at all, and this
 * returns `false` WITHOUT reading — absence of a switch is not a switch set to
 * off, and inventing a global one would be fabricating a setting.
 *
 * A read that FAILS returns `ghostMode: true`: closed means "hidden".
 */
export async function readTripGhostMode(
  db: SupabaseClient,
  tripId: string | null | undefined,
  userId: string,
): Promise<{ ghostMode: boolean; degraded: boolean }> {
  if (!tripId) return { ghostMode: false, degraded: false };
  const { data, error } = await db
    .from("trip_crew_location_preferences")
    .select("ghost_mode_enabled")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    privacyLogger.warn(
      { err: error, tripId, userId },
      "trip_crew_location_preferences unreadable — ghost mode assumed ON (closed); this traveller is not published",
    );
    return { ghostMode: true, degraded: true };
  }
  return { ghostMode: Boolean((data as any)?.ghost_mode_enabled), degraded: false };
}

/**
 * The §17 gate: may this traveller's layover be shared, in either direction?
 *
 * Combines the two stores that actually hold the traveller's choices:
 *   `location_preferences`               (location_mode, sharing_paused)
 *   `trip_crew_location_preferences`     (ghost_mode_enabled, per trip)
 * and folds them through `isSharingAllowed`, which is the primitive this
 * module has exported all along and which — until now — nothing live called.
 *
 * The session's own `share_city_status` is NOT read here: it is a separate,
 * per-session opt-in and the caller composes the two (`disclosePresence`). One
 * off switch is enough to deny; requiring the gate to know about the session
 * would make it impossible to explain WHICH switch refused.
 */
export async function evaluateSharingGate(
  db: SupabaseClient,
  ctx: { userId: string; tripId?: string | null },
): Promise<SharingGateResult> {
  const [prefs, ghost] = await Promise.all([
    loadPreferences(db, ctx.userId),
    readTripGhostMode(db, ctx.tripId ?? null, ctx.userId),
  ]);

  const allowed = isSharingAllowed({
    locationMode: prefs.locationMode,
    sharingPaused: prefs.sharingPaused,
    ghostMode: ghost.ghostMode,
  });

  const reasons: SharingDenialReason[] = [];
  if (prefs.sharingPaused) reasons.push("sharing_paused");
  if (prefs.locationMode === "off") reasons.push("location_mode_off");
  if (ghost.ghostMode) reasons.push("ghost_mode");
  if (prefs.degraded) reasons.push("preferences_unreadable");
  if (ghost.degraded) reasons.push("ghost_mode_unreadable");

  return {
    allowed,
    reasons,
    degraded: prefs.degraded || ghost.degraded,
    locationMode: prefs.locationMode,
    sharingPaused: prefs.sharingPaused,
    ghostMode: ghost.ghostMode,
  };
}

/**
 * Of these candidate travellers, which have consented to being published?
 *
 * `cityPresence` selects other people's sessions by `share_city_status`, which
 * is a per-session flag. It is NOT their location-privacy setting, and until
 * this function existed nothing consulted that setting on the publish side: a
 * traveller who paused sharing, or set location off, was still counted and
 * still named to strangers because a session row somewhere said `true`.
 *
 * ONE query, not N: `location_preferences` is read for the whole candidate set
 * at once. A user with NO row has made no choice and the shipped default
 * (`city_only`, not paused) applies — that is `loadPreferences`' own rule and
 * it is deliberately preserved here, because treating "never opened settings"
 * as a refusal would empty the feature for almost everyone.
 *
 * An UNREADABLE `location_preferences` denies the whole set. That is the only
 * safe answer: the alternative is publishing people whose opt-out this server
 * could not see.
 *
 * Ghost mode is not consulted here. It is per-trip, the candidate sessions'
 * trip ids are not in hand, and a per-candidate trip read would be the N+1
 * this function exists to avoid — see `evaluateSharingGate` for the viewer's
 * own ghost state, which IS checked, and OWNER note below.
 */
export async function publishableUserIds(
  db: SupabaseClient,
  userIds: string[],
): Promise<{ allowed: string[]; denied: string[]; degraded: boolean }> {
  if (userIds.length === 0) return { allowed: [], denied: [], degraded: false };
  const { data, error } = await db
    .from("location_preferences")
    .select("user_id, location_mode, sharing_paused")
    .in("user_id", userIds);
  if (error) {
    privacyLogger.error(
      { err: error, candidates: userIds.length },
      "location_preferences unreadable — no traveller is published; a failed read is not consent",
    );
    return { allowed: [], denied: [...userIds], degraded: true };
  }

  const byUser = new Map<string, { location_mode?: string; sharing_paused?: boolean }>();
  for (const row of (data ?? []) as any[]) byUser.set(row.user_id, row);

  const allowed: string[] = [];
  const denied: string[] = [];
  for (const id of userIds) {
    const row = byUser.get(id);
    // No row = never touched the settings screen = shipped default, which is
    // `city_only` and not paused. A successful read that found nothing is a
    // real answer, not a degradation (LocationPermissionService, DEFAULT_PREFS).
    const ok = isSharingAllowed({
      locationMode: row?.location_mode ?? "city_only",
      sharingPaused: Boolean(row?.sharing_paused),
    });
    (ok ? allowed : denied).push(id);
  }
  return { allowed, denied, degraded: false };
}

export interface PresenceTraveler {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface PresenceDisclosure {
  /** The highest level actually served by this response. */
  level: PresenceLevel;
  sharing: boolean;
  count: number;
  travelers: PresenceTraveler[];
  /** Empty when nothing was withheld. */
  withheld: SharingDenialReason[];
  degraded: boolean;
}

/**
 * §14 progressive disclosure, applied to one presence answer.
 *
 * Three outcomes, and the middle one is the requirement the census scored W:
 *
 *   GATE REFUSES or the session has not opted in
 *       → L0, `sharing: false`, count 0, no travellers. Byte-identical in
 *         shape to what `GET /:id/presence` already returns for a
 *         non-opted-in session, so no client learns a new shape.
 *   GATE ALLOWS and the ladder is ON
 *       → L0: the count, and NOTHING else. This is the spec's "aggregate
 *         presence should be the default".
 *   GATE ALLOWS and the ladder is OFF
 *       → L2: count + up to six profiles. The behaviour shipped today,
 *         byte-for-byte.
 *
 * WHY THE LADDER IS BEHIND A FLAG AND THE GATE IS NOT. The gate applies the
 * traveller's OWN stored setting, which was being ignored — a defect, fixed
 * the way #442 fixed the identical one for Pulse. The ladder changes what the
 * product shows to a traveller who consented to everything it asks about, which
 * on this surface is only ever done behind a flag seeded FALSE
 * (`layover_presence_ladder_enabled`, migration 2740).
 */
export function disclosePresence(input: {
  gate: SharingGateResult;
  sessionOptedIn: boolean;
  ladderEnabled: boolean;
  count: number;
  travelers: PresenceTraveler[];
}): PresenceDisclosure {
  const { gate, sessionOptedIn, ladderEnabled } = input;
  if (!gate.allowed || !sessionOptedIn) {
    return {
      level: "L0_AGGREGATE",
      sharing: false,
      count: 0,
      travelers: [],
      withheld: gate.allowed ? [] : [...gate.reasons],
      degraded: gate.degraded,
    };
  }
  if (ladderEnabled) {
    return {
      level: "L0_AGGREGATE",
      sharing: true,
      count: input.count,
      travelers: [],
      withheld: [],
      degraded: gate.degraded,
    };
  }
  return {
    level: "L2_DISCOVERY",
    sharing: true,
    count: input.count,
    travelers: input.travelers,
    withheld: [],
    degraded: gate.degraded,
  };
}
