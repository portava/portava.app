/**
 * tripMapSources — compose a {@link TripMapSource} from its owning systems
 * (Map spec §11, §19, §20, §23).
 *
 * WHY THIS MODULE EXISTS
 * ======================
 * `tripMapModel.tripToMapObjects()` projects a fully-formed `TripMapSource`
 * onto the map, but it does NOT know where the pieces come from — §20 says the
 * canonical facts stay owned by Places, Trips, Presence, Safety, Compass and
 * the Route Plan. This module is the seam that reads each owning system's
 * public-safe DTO and assembles the projection input, WITHOUT reconstructing
 * any intelligence rule (§19) and without ever sharpening a privacy boundary.
 *
 * PURITY
 * ======
 * Everything here is pure: DTOs in, a `TripMapSource` (+ coarse crew labels)
 * out. It imports service TYPES only (erased at runtime), so it pulls in no
 * network client and runs in `node:test` without the react-native/supabase
 * transform wall. The app layer calls the real services and hands their
 * results in.
 *
 * THE TWO COORDINATE-LESS SOURCES (§23 ruling)
 * ============================================
 * Two owning systems deliberately withhold coordinates, and this module NEVER
 * invents them:
 *
 *  - CREW. `getCrewMap` returns an AREA LABEL per member and no position. §23:
 *    "Trip Crew: approximate or permitted temporary precise" — but the server
 *    declined precision here, so crew is surfaced as COARSE AREA LABELS ONLY
 *    (`crewAreas`), a companion output with no geometry. `source.crew` (which
 *    requires coordinates) is therefore left empty: a crew ring is drawn only
 *    when a system that legitimately holds permitted coordinates supplies them,
 *    never fabricated from an area label.
 *  - MEETUPS. Meetups carry a text `locationName` and no lat/lng by privacy
 *    design, so a standalone meetup cannot become a positioned pin. A meeting
 *    point becomes geographic only once it is placed into the plan as a
 *    `meeting_point` item carrying a public-safe coordinate — which is exactly
 *    what {@link partitionPlanItems} reads.
 */

import {
  acceptProposal,
  nextStopOf,
  type OptimizeProposal,
  type SafeReturnContext,
  type TripCompassAlternative,
  type TripLodging,
  type TripMapSource,
  type TripMeetingPoint,
  type TripSavedIdea,
  type TripStop,
  type TripStopStatus,
} from './tripMapModel.ts';
import type { TripPlanItem } from '../../../types/models.ts';
import type { BookmarkedPlace } from '../../../services/discoveryBookmarks.ts';
import type { CrewMemberCard, CrewStatusLabel } from '../../../services/tripCrewLocation.ts';
import type { FullRoutePlan } from '../../../services/routePlan.ts';
import type { SafeReturnSession } from '../../../services/safeReturn.ts';
import type { CompassRecommendation } from '../../../services/compass.ts';

// ── Crew: coarse area labels only (§23) ─────────────────────────────────────────

/**
 * A crew member surfaced as a COARSE AREA LABEL.
 *
 * There is deliberately no `lat`/`lng` field: this is the whole point of the
 * §23 ruling. A `TripCrewArea` can be rendered as text ("Mai · Riverside") but
 * can never be placed on the map canvas, because the type carries no geometry
 * to place it with.
 */
export interface TripCrewArea {
  userId: string;
  name: string | null;
  /** e.g. "Riverside", "City only". May be null when the server sent none. */
  areaLabel: string | null;
  statusLabel: CrewStatusLabel;
  /** True when the member is running a Safe Return session (§11, §24). */
  safeReturnActive: boolean;
}

/** Crew statuses that represent no shared presence at all — never surfaced. */
const HIDDEN_CREW_STATUSES: ReadonlySet<CrewStatusLabel> = new Set<CrewStatusLabel>([
  'not_shared',
  'location_hidden',
]);

/**
 * Map crew cards to coarse area labels. Members who share nothing, or who have
 * ghost mode on, are dropped. NO coordinates are ever produced — the return
 * type cannot express one.
 */
export function composeCrewAreas(crew: readonly CrewMemberCard[] | undefined): TripCrewArea[] {
  const out: TripCrewArea[] = [];
  for (const c of crew ?? []) {
    if (c.ghostMode) continue;
    if (HIDDEN_CREW_STATUSES.has(c.statusLabel)) continue;
    out.push({
      userId: c.userId,
      name: c.name,
      areaLabel: c.areaLabel,
      statusLabel: c.statusLabel,
      safeReturnActive: c.safeReturnActive === true,
    });
  }
  return out;
}

// ── Plan items → lodging / stops / meeting points ───────────────────────────────

function planStatusToStopStatus(status: TripPlanItem['status']): TripStopStatus {
  switch (status) {
    case 'done':
      return 'arrived';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

/** A plan item is projectable only with a public-safe coordinate. */
function hasSafeCoords(item: Pick<TripPlanItem, 'lat' | 'lng' | 'locationIsPrivate'>): boolean {
  return (
    item.locationIsPrivate !== true &&
    item.lat != null &&
    item.lng != null &&
    Number.isFinite(item.lat) &&
    Number.isFinite(item.lng)
  );
}

export interface PartitionedPlan {
  /** First accommodation item with a safe coordinate becomes the home base. */
  lodging: TripLodging | null;
  stops: TripStop[];
  meetingPoints: TripMeetingPoint[];
  /**
   * Ids that already sit in the plan (item id AND its `sourceId`), so a saved
   * idea that is already scheduled is not offered a second time.
   */
  scheduledIds: Set<string>;
}

/**
 * Split the trip's plan-map items into their §11 roles by category. All three
 * roles draw from ONE authenticated fetch of public-safe coordinates, so the
 * lodging pin, the itinerary and the meeting points can never disagree about a
 * location the way three separate reads could.
 */
export function partitionPlanItems(items: readonly TripPlanItem[] | undefined): PartitionedPlan {
  const scheduledIds = new Set<string>();
  let lodging: TripLodging | null = null;
  const stops: TripStop[] = [];
  const meetingPoints: TripMeetingPoint[] = [];

  const usable = (items ?? []).filter(hasSafeCoords);

  for (const item of usable) {
    scheduledIds.add(item.id);
    if (item.sourceId) scheduledIds.add(item.sourceId);

    const lat = item.lat as number;
    const lng = item.lng as number;

    if (item.category === 'accommodation') {
      // §11 lists lodging first; the earliest-sorted accommodation is home base.
      if (lodging == null) {
        lodging = {
          id: item.id,
          title: item.title,
          lat,
          lng,
          ...(item.locationName != null ? { subtitle: item.locationName } : {}),
        };
      }
      continue;
    }

    if (item.category === 'meeting_point') {
      meetingPoints.push({
        id: item.id,
        title: item.title,
        lat,
        lng,
        ...(item.locationName != null ? { subtitle: item.locationName } : {}),
        ...(item.startsAt != null ? { startsAt: item.startsAt } : {}),
        atStopId: null,
      });
      continue;
    }

    // Everything else is an itinerary stop.
    const stop: TripStop = {
      id: item.id,
      title: item.title,
      lat,
      lng,
      // Canonical ordering — never renumbered here; the array order is what
      // Optimize Today proposes changing.
      orderIndex: item.sortOrder,
      status: planStatusToStopStatus(item.status),
      // A 'fixed' lock is the hard reservation anchor the optimizer may not
      // move; 'flexible'/'optional' stay revisable, so neither is an anchor.
      reservationAt: item.lockType === 'fixed' ? item.startsAt : null,
      eventStartsAt: item.startsAt,
      eventEndsAt: item.endsAt,
      plannedArrivalTime: item.startsAt,
    };
    if (item.locationName != null) stop.subtitle = item.locationName;
    stops.push(stop);
  }

  return { lodging, stops, meetingPoints, scheduledIds };
}

// ── Saved ideas (§11) ────────────────────────────────────────────────────────────

/**
 * Saved places kept for the trip that are NOT already scheduled. Entries with
 * no coordinate are dropped — a saved idea with no known location is a wish,
 * not a pin, and this module never invents a position for it.
 */
export function composeSavedIdeas(
  saved: readonly BookmarkedPlace[] | undefined,
  scheduledIds: ReadonlySet<string> = new Set(),
): TripSavedIdea[] {
  const out: TripSavedIdea[] = [];
  const seen = new Set<string>();
  for (const b of saved ?? []) {
    if (b.lat == null || b.lng == null) continue;
    if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) continue;
    if (scheduledIds.has(b.id)) continue;
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    const idea: TripSavedIdea = {
      id: b.id,
      title: b.name,
      lat: b.lat,
      lng: b.lng,
    };
    const subtitle = b.type ?? b.category;
    if (subtitle) idea.subtitle = subtitle;
    out.push(idea);
  }
  return out;
}

// ── Routes (§11) ─────────────────────────────────────────────────────────────────

/**
 * The active/planned route as ONE line, drawn through the route plan's stops in
 * order. A leg or plan flagged `isApproximated` marks the whole line estimated,
 * so the renderer can style it as a dashed guess rather than a routed path.
 */
export function composeRoutes(plan: FullRoutePlan | null | undefined): TripRouteLine[] {
  if (!plan || !plan.plan) return [];
  const ordered = [...(plan.stops ?? [])]
    .filter(
      (s) =>
        s.structuredLocation &&
        Number.isFinite(s.structuredLocation.lat) &&
        Number.isFinite(s.structuredLocation.lng),
    )
    .sort((a, b) => a.orderIndex - b.orderIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ordered.length < 2) return [];

  const path = ordered.map((s) => ({ lat: s.structuredLocation.lat, lng: s.structuredLocation.lng }));
  const isApproximated =
    plan.plan.isApproximated === true || (plan.legs ?? []).some((l) => l.isApproximated === true);

  return [
    {
      id: plan.plan.id,
      title: plan.plan.title,
      path,
      active: plan.plan.status === 'active',
      isApproximated,
    },
  ];
}

// ── Safe Return context (§11, §24) ───────────────────────────────────────────────

const ACTIVE_SAFE_RETURN: ReadonlySet<SafeReturnSession['status']> = new Set<SafeReturnSession['status']>([
  'pending',
  'active',
]);

/**
 * Safe Return context, anchored to the trip's home base.
 *
 * The Safe Return session itself carries no coordinate (it is a timer + escalation
 * record, §24), so the anchor position is borrowed from lodging — the place the
 * traveler is getting back TO. With no active session, or no lodging coordinate
 * to anchor to, there is nothing to draw and the function returns null rather
 * than inventing a location.
 */
export function composeSafeReturn(
  session: SafeReturnSession | null | undefined,
  lodging: TripLodging | null | undefined,
): SafeReturnContext | null {
  if (!session || !ACTIVE_SAFE_RETURN.has(session.status)) return null;
  if (!lodging || !Number.isFinite(lodging.lat) || !Number.isFinite(lodging.lng)) return null;
  return {
    id: session.id,
    title: 'Safe return',
    lat: lodging.lat,
    lng: lodging.lng,
    subtitle: lodging.title,
    anchor: 'lodging',
    lastDepartureAt: session.timerEndAt,
  };
}

// ── Compass alternatives (§11, §14) ──────────────────────────────────────────────

function coordFrom(data: Record<string, unknown> | undefined, key: string): number | null {
  const v = data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Compass alternatives for the next stop. Compass reasons over structured state
 * (§14) and does not create facts, so only recommendations that already carry a
 * coordinate become alternatives; the rest are Compass's problem to surface
 * elsewhere, not this map's to place blindly.
 */
export function composeCompassAlternatives(
  recommendations: readonly CompassRecommendation[] | undefined,
  forStopId: string | null,
): TripCompassAlternative[] {
  const out: TripCompassAlternative[] = [];
  const seen = new Set<string>();
  for (const rec of recommendations ?? []) {
    const lat = coordFrom(rec.data, 'lat');
    const lng = coordFrom(rec.data, 'lng');
    if (lat == null || lng == null) continue;
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    const alt: TripCompassAlternative = {
      id: rec.id,
      title: rec.title ?? 'Compass pick',
      lat,
      lng,
      forStopId,
    };
    if (rec.reason) alt.subtitle = rec.reason;
    out.push(alt);
  }
  return out;
}

// ── Full composition ─────────────────────────────────────────────────────────────

export interface TripMapComposeInput {
  tripId: string;
  /** Public-safe plan-map items (accommodation / meeting_point / itinerary). */
  planItems?: readonly TripPlanItem[];
  /** Saved places kept for this trip (its wishlist). */
  savedPlaces?: readonly BookmarkedPlace[];
  /** Crew cards — area labels only (§23). */
  crew?: readonly CrewMemberCard[];
  /** The trip's route plan, if one is active/drafted. */
  routePlan?: FullRoutePlan | null;
  /** The viewer's active Safe Return session, if any. */
  safeReturnSession?: SafeReturnSession | null;
  /** Compass recommendations to offer against the next stop. */
  compassRecommendations?: readonly CompassRecommendation[];
  /** Explicit next stop; when omitted it is derived from `now`. */
  nextStopId?: string | null;
  /** ISO clock, used only to pick the next stop when one is not given. */
  now?: string;
}

export interface ComposedTripMap {
  /** The coordinate-bearing projection input for `tripToMapObjects`. */
  source: TripMapSource;
  /** Coarse crew area labels (§23) — no geometry, surfaced as text only. */
  crewAreas: TripCrewArea[];
}

/**
 * Compose every §11 element from its owning system into a single
 * `TripMapSource` (+ coarse crew labels). The result is pure projection input:
 * no writes, no invented coordinates, no sharpened privacy.
 */
export function composeTripMap(input: TripMapComposeInput): ComposedTripMap {
  const { lodging, stops, meetingPoints, scheduledIds } = partitionPlanItems(input.planItems);

  const nextStopId =
    input.nextStopId ??
    (input.now ? (nextStopOf(stops, input.now)?.id ?? null) : null);

  const savedIdeas = composeSavedIdeas(input.savedPlaces, scheduledIds);
  const routes = composeRoutes(input.routePlan);
  const safeReturn = composeSafeReturn(input.safeReturnSession, lodging);
  const compassAlternatives = composeCompassAlternatives(input.compassRecommendations, nextStopId);
  const crewAreas = composeCrewAreas(input.crew);

  const source: TripMapSource = {
    tripId: input.tripId,
    lodging,
    stops,
    nextStopId,
    savedIdeas,
    // §23: crew from getCrewMap carries no coordinates, so no crew ring is
    // drawn here. The coarse labels live in `crewAreas`.
    crew: [],
    meetingPoints,
    routes,
    safeReturn,
    compassAlternatives,
  };

  return { source, crewAreas };
}

// ── Optimize Today persistence (§11, §20) ────────────────────────────────────────

/**
 * The Trips write path an accepted Optimize Today proposal is persisted through.
 * INJECTED so this module stays network-free and testable — the app hands the
 * real `reorderPlanItems` / `createPlanItem` service calls.
 */
export interface OptimizePersistWriters {
  /** Persist the new ordering of the day's EXISTING stops (owner-only server). */
  reorder: (orderedItemIds: string[]) => Promise<void>;
  /**
   * Add one accepted saved-idea insertion to the trip as a real plan item,
   * returning its new id. Optional: without it, insertions are surfaced but not
   * written (the reorder still persists).
   */
  addSavedIdea?: (idea: TripStop) => Promise<string>;
}

export interface OptimizePersistResult {
  /**
   * TRUE only once the reorder was durably written. The UI must not show a
   * proposal as "saved" unless this is true (§11: no silent rewrite; §20: the
   * Trips system owns the itinerary).
   */
  persisted: boolean;
  /** The existing-stop ids, in the order that was persisted. */
  orderedStopIds: string[];
  /** New plan-item ids created for accepted saved-idea insertions. */
  addedInsertionItemIds: string[];
  /** The accepted saved-idea insertions (proposed additions), for the caller. */
  insertions: TripStop[];
  /** Set when the reorder write failed; `persisted` is then false. */
  error?: string;
}

/**
 * Persist an accepted Optimize Today proposal through the Trips write path.
 *
 * The reorder of the day's EXISTING stops is the acceptance and the gate: if it
 * throws, nothing is claimed saved (`persisted:false`). Accepted saved-idea
 * insertions are then added best-effort as real plan items via `addSavedIdea` —
 * a proposed addition the user accepted, added through the canonical Trips path
 * rather than woven into the slot-preserving reorder. `orderedStopIds` excludes
 * the insertions (which have no plan-item id until they are created).
 */
export async function persistOptimizeAcceptance(
  proposal: OptimizeProposal,
  at: string,
  writers: OptimizePersistWriters,
): Promise<OptimizePersistResult> {
  const change = acceptProposal(proposal, at);
  const insertionIds = new Set(proposal.insertions.map((s) => s.id));
  const orderedStopIds = change.orderedStopIds.filter((id) => !insertionIds.has(id));

  try {
    await writers.reorder(orderedStopIds);
  } catch (e) {
    return {
      persisted: false,
      orderedStopIds,
      addedInsertionItemIds: [],
      insertions: change.insertions,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const addedInsertionItemIds: string[] = [];
  if (writers.addSavedIdea) {
    for (const idea of change.insertions) {
      try {
        addedInsertionItemIds.push(await writers.addSavedIdea(idea));
      } catch {
        // The reorder — the acceptance itself — is already durable. A failed
        // add is a missing suggestion, not a lost reorder, so it does not flip
        // `persisted`; the caller re-reads the trip to see what landed.
      }
    }
  }

  return {
    persisted: true,
    orderedStopIds,
    addedInsertionItemIds,
    insertions: change.insertions,
  };
}

// Re-export for callers that only touch the composition layer.
export type { TripRouteLine } from './tripMapModel.ts';
import type { TripRouteLine } from './tripMapModel.ts';
