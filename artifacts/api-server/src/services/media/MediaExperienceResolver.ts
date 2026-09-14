/**
 * MediaExperienceResolver (§23/§41) — resolves an experience (a canonical Event
 * or a Trip) into a coarse MediaExperienceProjection.
 *
 * VIEWER ELIGIBILITY FIRST. An experience the viewer may not see resolves to
 * null and the route answers with a well-formed "not available" projection —
 * private events and private trips are excluded, blocks are honored. Event
 * eligibility reuses routes/events.checkEventEligibility (the same age / trust /
 * verified / block / ban gate the event routes use); it is NEVER re-implemented.
 *
 * The hero media is drawn through the SHARED eligibility gate + coarse projector,
 * so an experience projection carries NO precise coordinate and NO fabricated
 * live label (current state, if any, comes only from the gated live-claim read).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkEventEligibility } from "../../routes/events.js";
import {
  type MediaCandidateRow,
  type MediaProjection,
} from "../../lib/media/mediaProjection.js";
import {
  loadEligibleCandidates,
  projectCandidatesProtected,
  readCurrentState,
  type CurrentState,
  type ViewerResolved,
} from "./MediaProjectionService.js";
import { aggregateFreshness, type FreshnessState } from "../../lib/media/mediaFreshness.js";

/**
 * §23.1 EXPERIENCE CHAINS — "Dinner → Rooftop → Nightclub".
 *
 * A chain is an ORDERED multi-place experience, and the only honest evidence
 * Media holds for an order is WHEN each place was photographed. So a stop's
 * position is the FIRST observed perspective at that place inside the
 * experience, `derivedFrom` says exactly that on the object, and nothing here
 * infers a route, a traveller's path or an intention.
 *
 * WHAT IS NOT A STOP: a place with no perspective (an itinerary entry is not an
 * observation), and a place whose id the lib/mediaLocationVisibility choke point
 * withheld — the chain is built from the PROJECTED media, so a coarsened item
 * contributes no stop rather than a named one. One place is not a chain
 * (`isChain` false), and an empty experience gets an empty chain rather than a
 * fabricated one.
 */
export interface ExperienceChainStop {
  /** Canonical places.id — opaque, never a coordinate. */
  placeId: string;
  /** Coarse label, post-disclosure. */
  label: string | null;
  /** ISO — the first observed perspective at this stop. This is the ORDER KEY. */
  firstPerspectiveAt: string;
  /** ISO — the last observed perspective at this stop. */
  lastPerspectiveAt: string;
  perspectiveCount: number;
}

export interface ExperienceChain {
  /** Ordered ascending by `firstPerspectiveAt`. */
  stops: ExperienceChainStop[];
  /** True only with two or more distinct disclosable places. */
  isChain: boolean;
  /** How the order was obtained. A constant, so the claim travels with the data. */
  derivedFrom: "observed_capture_times";
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Derive the §23.1 chain from already-projected, already-eligible media. PURE —
 * no DB, no clock. Newest-first or oldest-first input makes no difference: the
 * order comes from the capture times, not from the page order.
 */
export function buildExperienceChain(media: readonly MediaProjection[]): ExperienceChain {
  const byPlace = new Map<string, { label: string | null; times: number[] }>();
  for (const m of media) {
    if (!m.placeId) continue; // withheld by the disclosure choke point ⇒ not a stop
    const t = new Date(m.capturedAt).getTime();
    if (!Number.isFinite(t)) continue;
    const entry = byPlace.get(m.placeId) ?? { label: null, times: [] };
    if (entry.label === null && m.placeLabel) entry.label = m.placeLabel;
    entry.times.push(t);
    byPlace.set(m.placeId, entry);
  }

  const stops: ExperienceChainStop[] = [];
  for (const [placeId, entry] of byPlace.entries()) {
    const sorted = [...entry.times].sort((a, b) => a - b);
    stops.push({
      placeId,
      label: entry.label,
      firstPerspectiveAt: new Date(sorted[0]).toISOString(),
      lastPerspectiveAt: new Date(sorted[sorted.length - 1]).toISOString(),
      perspectiveCount: sorted.length,
    });
  }
  stops.sort((a, b) => Date.parse(a.firstPerspectiveAt) - Date.parse(b.firstPerspectiveAt));

  return {
    stops,
    isChain: stops.length >= 2,
    derivedFrom: "observed_capture_times",
    startedAt: stops.length > 0 ? stops[0].firstPerspectiveAt : null,
    endedAt: stops.length > 0 ? stops[stops.length - 1].lastPerspectiveAt : null,
  };
}

export interface MediaExperienceProjection {
  id: string;
  kind: "event" | "trip";
  title: string | null;
  placeIds: string[];
  eventId?: string;
  tripId?: string;
  startedAt: string | null;
  expectedEndAt: string | null;
  currentState: CurrentState;
  perspectiveCount: number;
  contributorCount: number;
  freshness: FreshnessState;
  /** §23.1 — the ordered multi-place chain, or an empty one. Never fabricated. */
  chain: ExperienceChain;
  heroMedia: MediaProjection[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles that count as trip membership (mirrors mediaEligibility.ACCEPTED_TRIP_ROLES). */
const TRIP_MEMBER_ROLES = ["owner", "co_host", "member", "viewer"];

/**
 * Resolve an experience id into a projection, or null when the viewer may not
 * see it (private / blocked / ineligible) or it does not exist. Never throws.
 */
export async function resolveExperience(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  experienceId: string,
  nowMs: number,
): Promise<MediaExperienceProjection | null> {
  if (!UUID_RE.test(experienceId)) return null;

  // Try Event first, then Trip. Both are uuids; an id that is neither → null.
  const asEvent = await resolveEvent(sc, viewer, experienceId, nowMs).catch(() => null);
  if (asEvent) return asEvent;
  const asTrip = await resolveTrip(sc, viewer, experienceId, nowMs).catch(() => null);
  return asTrip;
}

async function resolveEvent(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  eventId: string,
  nowMs: number,
): Promise<MediaExperienceProjection | null> {
  let ev: any = null;
  try {
    const { data } = await (sc as any).from("events").select("*").eq("id", eventId).maybeSingle();
    ev = data ?? null;
  } catch {
    return null;
  }
  if (!ev) return null;

  // Visibility: only surface public events, unless the viewer is the host or an
  // accepted participant. This is a conservative subset of canViewEvent that
  // never widens access — fail-closed for anything non-public.
  const visibility = (ev.visibility as string | null) ?? "public";
  let mayView = visibility === "public" || ev.host_id === viewer.viewerId;
  if (!mayView) {
    try {
      const [{ data: rsvp }, { data: role }] = await Promise.all([
        (sc as any)
          .from("event_rsvps")
          .select("status")
          .eq("event_id", eventId)
          .eq("user_id", viewer.viewerId)
          .in("status", ["going", "maybe"])
          .maybeSingle(),
        (sc as any)
          .from("event_roles")
          .select("role")
          .eq("event_id", eventId)
          .eq("user_id", viewer.viewerId)
          .in("role", ["co_host", "moderator"])
          .maybeSingle(),
      ]);
      mayView = Boolean(rsvp) || Boolean(role);
    } catch {
      mayView = false;
    }
  }
  if (!mayView) return null;

  // Age / trust / verified / block / ban gate (shared with the event routes).
  const elig = await checkEventEligibility(sc, ev, viewer.viewerId).catch(() => ({ ok: false }) as any);
  if (!elig.ok) return null;

  // Hero media: posts explicitly linked to the event (post_event_links), run
  // through the shared eligibility gate + coarse projector.
  let linkedPostIds: string[] = [];
  try {
    const { data } = await (sc as any)
      .from("post_event_links")
      .select("post_id")
      .eq("event_id", eventId)
      .limit(200);
    linkedPostIds = ((data as any[]) ?? []).map((r) => String(r.post_id)).filter(Boolean);
  } catch {
    linkedPostIds = [];
  }

  let media: MediaProjection[] = [];
  if (linkedPostIds.length > 0) {
    const candidates = await loadEligibleCandidates(sc, viewer, {
      feedType: "for_you",
      postIds: linkedPostIds,
      limit: 200,
    });
    media = await projectCandidatesProtected(sc, viewer, candidates as MediaCandidateRow[], nowMs);
  }

  const placeIds = typeof ev.place_id === "string" && ev.place_id ? [ev.place_id] : [];
  // Current state only if the event's place resolves to a canonical uuid place.
  const canonicalPlace = UUID_RE.test(String(ev.place_id ?? "")) ? String(ev.place_id) : null;
  const currentState = await readCurrentState(sc, canonicalPlace, nowMs);

  const contributors = new Set(media.map((m) => m.contributor?.id).filter(Boolean));
  return {
    id: eventId,
    kind: "event",
    title: typeof ev.title === "string" ? ev.title : null,
    placeIds,
    eventId,
    startedAt: ev.start_at ?? ev.starts_at ?? ev.start_time ?? null,
    expectedEndAt: ev.end_at ?? ev.ends_at ?? ev.end_time ?? null,
    currentState,
    perspectiveCount: media.length,
    contributorCount: contributors.size,
    freshness: aggregateFreshness(media.map((m) => m.capturedAt), nowMs),
    // Built from the FULL projected set, not the hero slice: a chain truncated
    // to the first 24 items would drop the end of the night.
    chain: buildExperienceChain(media),
    heroMedia: media.slice(0, 24),
  };
}

async function resolveTrip(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  tripId: string,
  nowMs: number,
): Promise<MediaExperienceProjection | null> {
  let trip: any = null;
  try {
    const { data } = await (sc as any)
      .from("trips")
      .select("id, title, owner_id, visibility, start_date, end_date")
      .eq("id", tripId)
      .maybeSingle();
    trip = data ?? null;
  } catch {
    return null;
  }
  if (!trip) return null;

  const visibility = (trip.visibility as string | null) ?? "members";
  let mayView = visibility === "public" || trip.owner_id === viewer.viewerId;
  if (!mayView) {
    try {
      const { data: member } = await (sc as any)
        .from("trip_members")
        .select("role")
        .eq("trip_id", tripId)
        .eq("user_id", viewer.viewerId)
        .in("role", TRIP_MEMBER_ROLES)
        .maybeSingle();
      mayView = Boolean(member);
    } catch {
      mayView = false;
    }
  }
  if (!mayView) return null;

  // Hero media: the viewer's-eligible posts attached to this trip.
  const candidates = await loadEligibleCandidates(sc, viewer, {
    feedType: "for_you",
    tripId,
    limit: 200,
  });
  const media = await projectCandidatesProtected(sc, viewer, candidates as MediaCandidateRow[], nowMs);

  const placeIds = Array.from(new Set(media.map((m) => m.placeId).filter((x): x is string => Boolean(x))));
  const contributors = new Set(media.map((m) => m.contributor?.id).filter(Boolean));
  return {
    id: tripId,
    kind: "trip",
    title: typeof trip.title === "string" ? trip.title : null,
    placeIds,
    tripId,
    startedAt: trip.start_date ?? null,
    expectedEndAt: trip.end_date ?? null,
    currentState: { live: false, claims: [], crowdLabel: null },
    perspectiveCount: media.length,
    contributorCount: contributors.size,
    freshness: aggregateFreshness(media.map((m) => m.capturedAt), nowMs),
    chain: buildExperienceChain(media),
    heroMedia: media.slice(0, 24),
  };
}
