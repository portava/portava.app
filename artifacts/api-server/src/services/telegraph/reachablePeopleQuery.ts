/**
 * reachablePeopleQuery — the read layer under §30A.2's projection.
 *
 * All DECISIONS live in `reachablePeople.ts`, which is pure. This file does one
 * thing: it establishes the facts those decisions need, and it refuses to
 * present a failed read as a fact.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * EVERY READ'S `error` IS CHECKED, AND THAT IS THE WHOLE DESIGN
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * A PostgREST rejection RESOLVES. `{ data: null, error }` comes back, `?? []`
 * turns it into an empty list, and the surface answers "nobody is near you"
 * because a table was unreadable. On a presence surface that failure mode is
 * indistinguishable from the truth and therefore never gets reported. So:
 *
 *   • every consent-bearing read below destructures `error` and returns
 *     `{ ok: false, stage }`, which the route turns into a retryable 503;
 *   • `fetchBlockedSet` returning null (block state unknown) refuses the whole
 *     answer rather than publishing people whose block state is unknown;
 *   • a candidate whose relationship read degraded is dropped with a NAMED
 *     refusal, so the response's counts explain the short list.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE CANDIDATE SET IS THE SOCIAL GRAPH, NOT A VIEWPORT
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * §4.6 requires the existing social graph to be separated from discoverable
 * strangers. This surface takes no lat/lng parameter and has no radius: its
 * candidates are the viewer's circle members and accepted trip crew. There is
 * no query here that answers "who is near this point", which is the only version
 * of that separation a later filter change cannot weaken.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * REPEATED REFRESHES (§4.5)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `nowMs` is supplied by the caller, which quantises it (see the route). Two
 * polls inside one quantum therefore produce byte-identical answers: freshness,
 * overlap bands and `generatedAt` all derive from the quantised instant, so
 * polling faster than the quantum yields no new information at all. Combined
 * with a 5 km narrowest bucket, a movement-tracking side channel would need the
 * subject to physically cross a bucket edge.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchBlockedSet } from "../../lib/blocks.js";
import { isKillSwitchEngaged } from "../../lib/featureFlags.js";
import {
  canMessage,
  type MessagePermissionVerdict,
} from "../../lib/messagingPermissions.js";
import {
  effectiveDiscoveryVisibility,
  freshnessBucket,
  type LocationPrefsRow,
} from "../../lib/mapTravelers.js";
import { coarsePointFor, type CoarsePoint } from "../../lib/proximityBuckets.js";
import {
  resolveInvisibleMode,
  type InvisibleModeState,
} from "../../lib/invisibleMode.js";
import {
  isVisibleTo,
  listWindowsForOwners,
  type AvailabilityWindow,
  type ViewerRelationship,
} from "../passport/OpenToPlansService.js";
import {
  orderReachablePeople,
  projectReachablePerson,
  reachableTelemetry,
  type AvailabilityState,
  type FreshnessState,
  type ReachablePersonProjection,
  type ReachableTelemetry,
  type RefusalReason,
} from "./reachablePeople.js";

/** Hard cap on candidates considered in one request. */
export const MAX_CANDIDATES = 24;

/** Cap on the viewer's trip list feeding the shared-trip scan. */
const TRIP_SCAN_CAP = 200;

export type ReachableStage =
  | "blocks"
  | "viewer_prefs"
  | "circles"
  | "trips"
  | "trip_peers"
  | "candidate_prefs"
  | "candidate_privacy"
  | "candidate_profile_privacy"
  | "candidate_presence"
  | "availability"
  | "availability_windows";

export interface ReachableLoadOk {
  readonly ok: true;
  readonly people: ReachablePersonProjection[];
  readonly telemetry: ReachableTelemetry;
  readonly viewerInvisible: InvisibleModeState;
  /** A non-consent read degraded; the list is a floor and says so. */
  readonly degraded: boolean;
}

export interface ReachableLoadRefused {
  readonly ok: false;
  readonly stage: ReachableStage;
  readonly message: string;
}

export type ReachableLoadResult = ReachableLoadOk | ReachableLoadRefused;

export interface ReachableLoadOptions {
  readonly viewerId: string;
  /** Quantised epoch ms. Supplied, never read from the clock in here. */
  readonly nowMs: number;
  readonly maxCandidates?: number;
  /**
   * Injected for tests. Defaults to `canMessage` — the canonical resolver named
   * in §30A.1's evidence. This module never resolves a relationship itself.
   */
  readonly resolveRelationship?: (
    db: SupabaseClient,
    viewerId: string,
    personId: string,
  ) => Promise<MessagePermissionVerdict>;
}

interface QuickStatusRow {
  user_id: string;
  status: string;
  expires_at: string;
}

/** quick_availability_status → the projection's availability vocabulary. */
const QUICK_STATUS_STATE = new Map<string, AvailabilityState>([
  ["free_now", "available_now"],
  ["free_tonight", "available_later"],
  ["open_to_plans", "available_later"],
  ["busy", "unavailable"],
]);

function windowFor(row: QuickStatusRow | undefined, nowMs: number):
  | { startMs: number; endMs: number }
  | null {
  if (!row) return null;
  const endMs = Date.parse(row.expires_at);
  if (!Number.isFinite(endMs) || endMs <= nowMs) return null;
  return { startMs: nowMs, endMs };
}

function freshnessOf(lastKnownAt: string | null, nowMs: number): FreshnessState {
  return freshnessBucket(lastKnownAt, nowMs) ?? "stale";
}

/** The §7 viewer relationship an availability window's audience policy is tested against. */
function viewerRelationshipFrom(verdict: MessagePermissionVerdict): ViewerRelationship {
  const ctx = verdict.relationship_context;
  if (ctx.sharedCircle) return "crew";
  if (ctx.recipientFollowsSender) return "follower";
  if (ctx.senderFollowsRecipient) return "following";
  return "public";
}

/**
 * The strongest availability signal a person has PUBLISHED to this viewer.
 *
 * Two sources, and both are affirmative opt-ins:
 *
 *   availability_windows  §4/§31's audience-policy model. `isVisibleTo` is the
 *                         authority — explicit source only, unexpired, and the
 *                         window's own visibility must admit this viewer. Gated
 *                         by `open_to_plans_windows_enabled`, which is seeded
 *                         OFF, so in production this source is empty.
 *   quick status          the live surface: `user_availability.open_to_meet`
 *                         (DEFAULT false) is the opt-in to appear on a people
 *                         surface at all, and an UNEXPIRED
 *                         `quick_availability_status` row is the window.
 *
 * With neither, nothing is published. There is no inferred availability here:
 * §4.1's `CHECK (source='explicit' OR visibility='private')` makes an inferred
 * PUBLIC window unrepresentable in the table, and this reader does not
 * reintroduce one by guessing from presence.
 */
function availabilityFor(opts: {
  windows: AvailabilityWindow[] | undefined;
  viewerRelationship: ViewerRelationship;
  openToMeet: boolean;
  quick: QuickStatusRow | undefined;
  nowMs: number;
}): {
  published: boolean;
  state: AvailabilityState;
  intents: string[];
  window: { startMs: number; endMs: number } | null;
  publishedUntil: string | null;
} {
  const visible = (opts.windows ?? []).filter((w) =>
    isVisibleTo(w, opts.viewerRelationship, opts.nowMs),
  );
  if (visible.length > 0) {
    const soonest = visible.reduce((a, b) =>
      Date.parse(a.endAt) <= Date.parse(b.endAt) ? a : b,
    );
    const startMs = Date.parse(soonest.startAt);
    const endMs = Date.parse(soonest.endAt);
    const started = Number.isFinite(startMs) && startMs <= opts.nowMs;
    return {
      published: true,
      state: started ? "available_now" : "available_later",
      intents: [...soonest.intents],
      window:
        Number.isFinite(startMs) && Number.isFinite(endMs)
          ? { startMs: Math.max(startMs, opts.nowMs), endMs }
          : null,
      publishedUntil: soonest.endAt,
    };
  }

  const window = windowFor(opts.quick, opts.nowMs);
  if (!opts.openToMeet || !opts.quick || !window) {
    return { published: false, state: "unknown", intents: [], window: null, publishedUntil: null };
  }
  const state = QUICK_STATUS_STATE.get(opts.quick.status) ?? "unknown";
  if (state === "unknown") {
    return { published: false, state: "unknown", intents: [], window: null, publishedUntil: null };
  }
  return {
    published: true,
    state,
    intents: [],
    window,
    publishedUntil: opts.quick.expires_at,
  };
}

/**
 * Load and project the people reachable to `viewerId`.
 *
 * Returns a refusal — never an empty list — when a read the answer depends on
 * failed.
 */
export async function loadReachablePeople(
  db: SupabaseClient,
  opts: ReachableLoadOptions,
): Promise<ReachableLoadResult> {
  const { viewerId, nowMs } = opts;
  const cap = Math.max(1, Math.min(MAX_CANDIDATES, opts.maxCandidates ?? MAX_CANDIDATES));
  const resolveRelationship = opts.resolveRelationship ?? canMessage;

  // 0. The emergency stop, on the SERVE path. Engaged (or unknown) → publish
  //    nothing, and say the surface is off rather than that nobody is there.
  if (await isKillSwitchEngaged(db as any, "disable_location_sharing")) {
    return {
      ok: true,
      people: [],
      telemetry: reachableTelemetry([], [], { viewerInvisible: true, degraded: true }),
      viewerInvisible: { invisible: true, reasons: ["prefs_unreadable"], degraded: true },
      degraded: true,
    };
  }

  // 1. Blocking, first and fail-closed.
  const blockedSet = await fetchBlockedSet(db, viewerId);
  if (blockedSet === null) {
    return { ok: false, stage: "blocks", message: "block state could not be established" };
  }

  // 2. The viewer's own location consent. An unreadable row makes the VIEWER
  //    invisible, which costs them proximity — the safe direction.
  const viewerPrefsQ = await db
    .from("location_preferences")
    .select("user_id, location_mode, sharing_paused, discovery_visibility")
    .eq("user_id", viewerId)
    .maybeSingle();
  const viewerInvisible = resolveInvisibleMode({
    prefs: (viewerPrefsQ.data ?? null) as LocationPrefsRow | null,
    prefsError: viewerPrefsQ.error,
  });
  const viewerVisibility = viewerPrefsQ.error
    ? null
    : effectiveDiscoveryVisibility((viewerPrefsQ.data ?? null) as LocationPrefsRow | null);

  // 3. Candidates: circle members + accepted trip crew. No viewport.
  const circlesQ = await db
    .from("circle_memberships")
    .select("other_id")
    .eq("user_id", viewerId);
  if (circlesQ.error) {
    return { ok: false, stage: "circles", message: circlesQ.error.message };
  }
  const circleIds = new Set<string>(
    (circlesQ.data ?? []).map((r: any) => r.other_id as string).filter(Boolean),
  );

  const tripsQ = await db
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", viewerId)
    .eq("status", "accepted")
    .limit(TRIP_SCAN_CAP);
  if (tripsQ.error) {
    return { ok: false, stage: "trips", message: tripsQ.error.message };
  }
  const tripIds = [...new Set((tripsQ.data ?? []).map((r: any) => r.trip_id as string))].filter(
    Boolean,
  );

  const tripPeerCount = new Map<string, number>();
  if (tripIds.length > 0) {
    const peersQ = await db
      .from("trip_members")
      .select("user_id, trip_id")
      .in("trip_id", tripIds)
      .eq("status", "accepted");
    if (peersQ.error) {
      return { ok: false, stage: "trip_peers", message: peersQ.error.message };
    }
    for (const row of (peersQ.data ?? []) as any[]) {
      const id = row.user_id as string;
      if (!id || id === viewerId) continue;
      tripPeerCount.set(id, (tripPeerCount.get(id) ?? 0) + 1);
    }
  }

  const candidateIds = [...new Set([...circleIds, ...tripPeerCount.keys()])]
    .filter((id) => id !== viewerId && !blockedSet.has(id))
    .sort()
    .slice(0, cap);

  if (candidateIds.length === 0) {
    return {
      ok: true,
      people: [],
      telemetry: reachableTelemetry([], [], {
        viewerInvisible: viewerInvisible.invisible,
        degraded: viewerInvisible.degraded,
      }),
      viewerInvisible,
      degraded: viewerInvisible.degraded,
    };
  }

  // 4. Consent and presence for the candidates, batched. Every error refuses.
  const [prefsQ, upsQ, ppsQ, stateQ, availQ, quickQ] = await Promise.all([
    db
      .from("location_preferences")
      .select("user_id, location_mode, sharing_paused, discovery_visibility")
      .in("user_id", candidateIds),
    db
      .from("user_privacy_settings")
      .select("user_id, allow_location_sharing")
      .in("user_id", candidateIds),
    db
      .from("profile_privacy_settings")
      .select("user_id, allow_profile_discovery")
      .in("user_id", candidateIds),
    db
      .from("user_location_state")
      .select("user_id, lat, lng, last_known_at")
      .in("user_id", candidateIds),
    db
      .from("user_availability")
      .select("user_id, open_to_meet")
      .in("user_id", candidateIds),
    db
      .from("quick_availability_status")
      .select("user_id, status, expires_at")
      .in("user_id", candidateIds),
  ]);

  if (prefsQ.error) return { ok: false, stage: "candidate_prefs", message: prefsQ.error.message };
  if (upsQ.error) return { ok: false, stage: "candidate_privacy", message: upsQ.error.message };
  if (ppsQ.error) {
    return { ok: false, stage: "candidate_profile_privacy", message: ppsQ.error.message };
  }
  if (stateQ.error) {
    return { ok: false, stage: "candidate_presence", message: stateQ.error.message };
  }
  if (availQ.error) return { ok: false, stage: "availability", message: availQ.error.message };
  if (quickQ.error) return { ok: false, stage: "availability", message: quickQ.error.message };

  const windowsByOwner = await listWindowsForOwners(db, candidateIds);
  if (windowsByOwner === null) {
    return {
      ok: false,
      stage: "availability_windows",
      message: "availability windows could not be read",
    };
  }
  const viewerWindowsMap = await listWindowsForOwners(db, [viewerId]);
  if (viewerWindowsMap === null) {
    return {
      ok: false,
      stage: "availability_windows",
      message: "viewer availability windows could not be read",
    };
  }

  const prefsById = new Map<string, LocationPrefsRow>(
    (prefsQ.data ?? []).map((r: any) => [r.user_id as string, r as LocationPrefsRow]),
  );
  const locationSharingOff = new Set<string>(
    (upsQ.data ?? [])
      .filter((r: any) => r.allow_location_sharing === false)
      .map((r: any) => r.user_id as string),
  );
  const discoveryOff = new Set<string>(
    (ppsQ.data ?? [])
      .filter((r: any) => r.allow_profile_discovery === false)
      .map((r: any) => r.user_id as string),
  );
  const stateById = new Map<string, any>(
    (stateQ.data ?? []).map((r: any) => [r.user_id as string, r]),
  );
  const openToMeet = new Set<string>(
    (availQ.data ?? [])
      .filter((r: any) => r.open_to_meet === true)
      .map((r: any) => r.user_id as string),
  );
  const quickById = new Map<string, QuickStatusRow>(
    (quickQ.data ?? []).map((r: any) => [r.user_id as string, r as QuickStatusRow]),
  );

  // 5. The viewer's own coarse point and window.
  const viewerState = await db
    .from("user_location_state")
    .select("lat, lng, last_known_at")
    .eq("user_id", viewerId)
    .maybeSingle();
  // A viewer whose own position is unreadable measures from nowhere: buckets
  // become `unknown` and the surface still answers with availability.
  const viewerFresh = viewerState.error
    ? "stale"
    : freshnessOf((viewerState.data as any)?.last_known_at ?? null, nowMs);
  const viewerPoint: CoarsePoint | null =
    viewerState.error || !viewerVisibility || viewerFresh === "stale"
      ? null
      : coarsePointFor(
          viewerId,
          (viewerState.data as any)?.lat ?? null,
          (viewerState.data as any)?.lng ?? null,
          viewerVisibility,
        );

  const viewerQuick = await db
    .from("quick_availability_status")
    .select("user_id, status, expires_at")
    .eq("user_id", viewerId)
    .maybeSingle();
  const viewerWindow = viewerQuick.error
    ? null
    : windowFor((viewerQuick.data ?? undefined) as QuickStatusRow | undefined, nowMs);
  const viewerWindows = viewerWindowsMap.get(viewerId) ?? [];
  const viewerSelfWindow = viewerWindows
    .filter((w) => isVisibleTo(w, "self", nowMs))
    .map((w) => ({ startMs: Date.parse(w.startAt), endMs: Date.parse(w.endAt) }))
    .find((w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs));
  const viewerIntents = viewerWindows
    .filter((w) => isVisibleTo(w, "self", nowMs))
    .flatMap((w) => w.intents as string[]);

  // 6. Project each candidate.
  const people: ReachablePersonProjection[] = [];
  const refusals: RefusalReason[] = [];
  let degraded = viewerInvisible.degraded || Boolean(viewerState.error) || Boolean(viewerQuick.error);

  for (const personId of candidateIds) {
    const verdict = await resolveRelationship(db, viewerId, personId);
    if (verdict.degraded) degraded = true;

    const prefs = prefsById.get(personId) ?? null;
    // An ABSENT preferences row is the product default (city precision), which
    // mapTravelers already treats as consent; a row we could not READ is not,
    // and step 4 has already refused that case for the whole request.
    const personInvisible = resolveInvisibleMode({ prefs, prefsError: null });
    const visibility = effectiveDiscoveryVisibility(prefs);
    // An ABSENT row is the product default (city precision), the same reading
    // mapTravelers already gives it; a row that could not be READ is a refusal
    // and step 4 has already returned one for the whole request, so there is no
    // third case to guard here.
    const presenceConsent =
      Boolean(visibility) && !locationSharingOff.has(personId) && !discoveryOff.has(personId);

    const st = stateById.get(personId);
    const personFresh = freshnessOf((st?.last_known_at as string | null) ?? null, nowMs);
    const personPoint =
      presenceConsent && visibility && personFresh !== "stale"
        ? coarsePointFor(personId, st?.lat ?? null, st?.lng ?? null, visibility)
        : null;

    const availability = availabilityFor({
      windows: windowsByOwner.get(personId),
      viewerRelationship: viewerRelationshipFrom(verdict),
      openToMeet: openToMeet.has(personId),
      quick: quickById.get(personId),
      nowMs,
    });

    const outcome = projectReachablePerson({
      viewerId,
      personId,
      viewerPoint,
      personPoint,
      relationshipContext: verdict.relationship_context,
      relationshipDegraded: Boolean(verdict.degraded),
      blocked: blockedSet.has(personId) || verdict.reason === "blocked",
      blockStateKnown: verdict.reason !== "unavailable",
      personInvisible,
      viewerInvisible,
      personPresenceConsent: presenceConsent,
      availabilityPublished: availability.published,
      availabilityState: availability.state,
      availabilityIntents: availability.intents,
      availabilityWindow: availability.window,
      viewerWindow: viewerSelfWindow ?? viewerWindow,
      availabilityPublishedUntil: availability.publishedUntil,
      personFreshness: personFresh,
      safety: "clear",
      sharedTrips: tripPeerCount.get(personId) ?? 0,
      sharedCircles: circleIds.has(personId) ? 1 : 0,
      viewerIntents,
    });

    if (outcome.ok) people.push(outcome.person);
    else refusals.push(outcome.refusal);
  }

  const ordered = orderReachablePeople(viewerId, people);
  return {
    ok: true,
    people: ordered,
    telemetry: reachableTelemetry(ordered, refusals, {
      viewerInvisible: viewerInvisible.invisible,
      degraded,
    }),
    viewerInvisible,
    degraded,
  };
}
