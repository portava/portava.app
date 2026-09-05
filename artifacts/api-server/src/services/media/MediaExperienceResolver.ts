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
    heroMedia: media.slice(0, 24),
  };
}
