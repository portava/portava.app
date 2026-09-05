/**
 * MediaActionResolver (§15/§41/§43) — the media action rail.
 *
 * Given a media item (a `posts` row) and a viewer, resolve the eligible,
 * context-appropriate set of real-world actions (§15) into RESOLVABLE actions:
 * each action maps to an EXISTING canonical endpoint (never a re-implementation
 * of it), and is offered ONLY when the viewer passes the SAME authorization /
 * eligibility gate as that target endpoint (§47). The rail is therefore never a
 * way to bypass a target action's permission — dropping any per-action gate can
 * only ever REMOVE an action, never grant access the endpoint itself would deny.
 *
 * INVARIANTS (enforced, not hoped for):
 *   • The media item is run through the SHARED media-eligibility gate first; a
 *     viewer who cannot see the item gets NO action set (the route answers
 *     not_found), so the rail cannot surface actions on hidden content.
 *   • Each action's `target` is an existing endpoint. "Add to Trip" / "Do This
 *     Experience" resolve to the trip-plan-item endpoint and are offered only
 *     when the viewer actually has a plan-editable trip (canEditPlan — the exact
 *     gate that endpoint enforces). "Meet Here" respects the new-event kill
 *     switch. "Ask Compass" / "Create Plan" are offered only when Compass is on.
 *   • NO dead actions: a place-bound action is present only when the media
 *     resolves to that entity; a trip-bound action only when the trip resolves
 *     and the viewer may see it.
 *   • COARSE only — an action carries opaque entity ids + coarse labels, never a
 *     coordinate. Current/live framing is never fabricated here (that lives in
 *     the live-claim read consumed by Compass / the place projection).
 *   • The place ref and its label run through the SAME location/gem choke point
 *     as every other media surface (lib/mediaLocationVisibility, via
 *     MediaProjectionService.disclosureForRow), so the owner's
 *     `location_privacy_mode` and a hosting gem's ceiling bind here too.
 *   • A gem ref is emitted ONLY for a gem the viewer is entitled to be told
 *     about (HiddenGemPrivacyGuard.mayDiscloseGemIdentity). Naming a gem here
 *     binds it to an ordinary post's canonical place, so a protected /
 *     reveal-gated gem gets no ref at all — not its id, not its name.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { canEditPlan, isAcceptedTripMember } from "../../lib/http.js";
import { isKillSwitchEngaged } from "../../lib/featureFlags.js";
import { isCompassEnabled } from "../../compass/flags.js";
import {
  disclosureForRow,
  loadEligibleCandidates,
  loadProjectionGemContext,
  type ViewerResolved,
} from "./MediaProjectionService.js";
import { resolveExperience } from "./MediaExperienceResolver.js";
import { mayDiscloseGemIdentity } from "../hiddenGems/HiddenGemPrivacyGuard.js";
import type { MediaCandidateRow } from "../../lib/media/mediaProjection.js";

// ── Entity refs the media resolves to ─────────────────────────────────────────

export type MediaEntityKind = "media" | "place" | "trip" | "gem";

export interface MediaEntityRef {
  kind: MediaEntityKind;
  id: string;
  /** Coarse label only (place name / city) — NEVER a coordinate. */
  label: string | null;
}

export interface ResolvedMediaEntities {
  mediaId: string;
  /** Canonical place id (places.id) the media is bound to, or null. */
  placeId: string | null;
  /** Hidden-gem id when the media's canonical place is a hidden gem, else null. */
  gemId: string | null;
  /** Trip id the media is attached to AND the viewer may see, else null. */
  tripId: string | null;
  city: string | null;
  refs: MediaEntityRef[];
}

// ── Action shapes ─────────────────────────────────────────────────────────────

export type MediaActionId =
  | "show_on_map"
  | "see_nearby"
  | "find_similar"
  | "ask_compass"
  | "create_plan"
  | "save"
  | "add_to_trip"
  | "do_this_experience"
  | "view_experience"
  | "meet_here"
  | "i_want_this"
  | "share_telegraph"
  | "report";

export interface MediaActionTarget {
  method: "GET" | "POST" | "DELETE";
  /** Canonical endpoint path (an EXISTING route). `:params` are placeholders the
   *  client fills from `params`. */
  endpoint: string;
  /** Body / path params the client submits to that endpoint. */
  params?: Record<string, unknown>;
}

export interface MediaAction {
  id: MediaActionId;
  label: string;
  /** Outcome-oriented category (§26) — what real-world value the action drives. */
  outcome:
    | "navigate"
    | "compass"
    | "plan"
    | "save"
    | "meet"
    | "want"
    | "share"
    | "moderate"
    | "discover";
  target: MediaActionTarget;
}

export interface MediaActionSet {
  mediaId: string;
  entityRefs: MediaEntityRef[];
  actions: MediaAction[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Shared media resolution (eligibility-gated) ───────────────────────────────

/**
 * Load a single media row for the viewer, THROUGH the shared media-eligibility
 * gate (the same fail-closed distribution gate the feed/projection use). Returns
 * null when the viewer may not see it (blocked / private / restricted / missing).
 * Never throws.
 *
 * Feed-type selection mirrors GET /media/:id: an item by an author the viewer
 * follows (or their own) is eligible under the "following" gate; otherwise only
 * a public item passes the "for_you" gate.
 */
export async function loadEligibleMediaRow(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  mediaId: string,
): Promise<MediaCandidateRow | null> {
  if (!UUID_RE.test(mediaId)) return null;

  let authorId: string | null = null;
  try {
    const { data } = await (sc as any)
      .from("posts")
      .select("author_id")
      .eq("id", mediaId)
      .maybeSingle();
    authorId = (data as any)?.author_id ?? null;
  } catch {
    return null;
  }

  const ownedOrFollowed =
    !!authorId && (authorId === viewer.viewerId || viewer.followedCreatorIds.has(authorId));

  const rows = await loadEligibleCandidates(sc, viewer, {
    feedType: ownedOrFollowed ? "following" : "for_you",
    authorId: ownedOrFollowed ? authorId : null,
    postIds: [mediaId],
    limit: 1,
  });
  return rows[0] ?? null;
}

/** Trip roles that count as "the viewer may see this trip" (read eligibility). */
const TRIP_MEMBER_ROLES = ["owner", "co_host", "member", "viewer"];

/**
 * Resolve the entity refs a media row points at, applying VIEWER eligibility to
 * every ref that carries one. Coarse only — labels never coordinates.
 */
export async function resolveMediaEntities(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  row: MediaCandidateRow,
  _nowMs: number,
): Promise<ResolvedMediaEntities> {
  const mediaId = String((row as any).id);
  const rawPlaceId =
    typeof (row as any).canonical_place_id === "string" ? (row as any).canonical_place_id : null;
  const rawTripId = typeof (row as any).trip_id === "string" ? (row as any).trip_id : null;

  // The SAME location/gem choke point every other media surface runs through
  // (lib/mediaLocationVisibility). The rail's labels are the venue name and the
  // canonical place id, so it honours the owner's `location_privacy_mode` and a
  // hosting gem's ceiling exactly like the World shell does — a place a viewer
  // may not be told about is not a place they may be handed an action for.
  const gemCtx = await loadProjectionGemContext(sc, [row]);
  const disclosure = disclosureForRow(row, viewer.viewerId, gemCtx);
  const city = disclosure.city;
  const placeLabel = disclosure.name ?? disclosure.city;
  const placeId = disclosure.mayDisclosePlaceId ? rawPlaceId : null;

  const refs: MediaEntityRef[] = [{ kind: "media", id: mediaId, label: null }];

  // Place ref (canonical places.id) — coarse label only, and only at a tier that
  // permits disclosing the place itself.
  if (placeId) refs.push({ kind: "place", id: placeId, label: placeLabel });

  // Hidden-gem ref: only when the canonical place is a hidden gem the viewer is
  // ENTITLED to be told about. Naming (or id-exposing) a gem here binds it to an
  // ordinary post's canonical place, which de-anonymizes the gem's location just
  // as surely as handing out its coordinates — so identity disclosure runs
  // through the gem surfaces' own predicate (mayDiscloseGemIdentity, which is
  // the `hidden_gems_public_read` RLS policy plus the owner bypass). A protected
  // / reveal-gated / non-active gem yields NO ref at all: not its id, not its
  // name. FAIL CLOSED — a failed lookup also yields no ref.
  let gemId: string | null = null;
  if (rawPlaceId) {
    try {
      const { data } = await (sc as any)
        .from("hidden_gems")
        .select("id, name, status, sensitivity_level, submitted_by")
        .eq("canonical_place_id", rawPlaceId)
        .maybeSingle();
      const g = data as any;
      if (g && g.id && mayDiscloseGemIdentity(g, viewer.viewerId)) {
        gemId = String(g.id);
        refs.push({ kind: "gem", id: gemId, label: typeof g.name === "string" ? g.name : placeLabel });
      }
    } catch {
      /* non-fatal — no gem ref */
    }
  }

  // Trip ref: only when the viewer may SEE the trip (public, owner, or accepted
  // member). A trip the viewer cannot see is NOT exposed as a ref.
  let tripId: string | null = null;
  if (rawTripId) {
    try {
      const { data: trip } = await (sc as any)
        .from("trips")
        .select("id, title, owner_id, visibility")
        .eq("id", rawTripId)
        .maybeSingle();
      if (trip) {
        const visibility = ((trip as any).visibility as string | null) ?? "members";
        let mayView = visibility === "public" || (trip as any).owner_id === viewer.viewerId;
        if (!mayView) {
          const { data: member } = await (sc as any)
            .from("trip_members")
            .select("role")
            .eq("trip_id", rawTripId)
            .eq("user_id", viewer.viewerId)
            .in("role", TRIP_MEMBER_ROLES)
            .maybeSingle();
          mayView = Boolean(member);
        }
        if (mayView) {
          tripId = rawTripId;
          refs.push({
            kind: "trip",
            id: rawTripId,
            label: typeof (trip as any).title === "string" ? (trip as any).title : null,
          });
        }
      }
    } catch {
      /* non-fatal — no trip ref */
    }
  }

  return { mediaId, placeId, gemId, tripId, city, refs };
}

// ── Plan-editable trips (the SAME gate the trip-plan endpoints enforce) ────────

/**
 * The set of trip ids the viewer may add plan items to, decided by the EXACT
 * gate the target endpoint enforces (`canEditPlan`). This is what makes "Add to
 * Trip" / "Do This Experience" honor §47: the rail asks the same question the
 * endpoint would, so it can never offer an add the endpoint would refuse.
 *
 * Bounded — checks at most `max` candidate trips. Empty on any failure.
 */
export async function loadPlanEditableTripIds(
  sc: SupabaseClient,
  userId: string,
  max = 30,
): Promise<string[]> {
  let candidateTripIds: string[] = [];
  try {
    const { data, error } = await (sc as any)
      .from("trip_members")
      .select("trip_id, role")
      .eq("user_id", userId)
      .neq("role", "invited");
    if (error || !Array.isArray(data)) return [];
    candidateTripIds = (data as any[]).map((r) => String(r.trip_id)).slice(0, max);
  } catch {
    return [];
  }
  if (candidateTripIds.length === 0) return [];

  const editable: string[] = [];
  for (const tripId of candidateTripIds) {
    // canEditPlan is the authoritative per-trip gate the POST plan-item routes
    // call. Using it here (not a looser re-implementation) is the point.
    const ok = await canEditPlan(sc, tripId, userId).catch(() => null);
    if (ok === true) editable.push(tripId);
  }
  return editable;
}

// ── The resolver ──────────────────────────────────────────────────────────────

/**
 * Resolve the eligible action set for a media item + viewer. Returns null when
 * the viewer may not see the item (the route answers not_found). Never throws.
 */
export async function resolveMediaActions(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  mediaId: string,
  nowMs: number,
): Promise<MediaActionSet | null> {
  const row = await loadEligibleMediaRow(sc, viewer, mediaId);
  if (!row) return null;

  const entities = await resolveMediaEntities(sc, viewer, row, nowMs);
  const actions: MediaAction[] = [];

  // ── Always available to a viewer who can see the item ──────────────────────
  // These resolve to endpoints whose only gate is "can see the item", which the
  // eligibility check above already proved.

  // Report / Not Relevant → POST /api/media/:id/report
  actions.push({
    id: "report",
    label: "Report / Not relevant",
    outcome: "moderate",
    target: { method: "POST", endpoint: "/api/media/:id/report", params: { id: mediaId } },
  });

  // Share via Telegraph → POST /api/media/:id/share
  actions.push({
    id: "share_telegraph",
    label: "Share via Telegraph",
    outcome: "share",
    target: { method: "POST", endpoint: "/api/media/:id/share", params: { id: mediaId } },
  });

  // Save (this perspective) → POST /api/media/:id/save
  actions.push({
    id: "save",
    label: "Save",
    outcome: "save",
    target: { method: "POST", endpoint: "/api/media/:id/save", params: { id: mediaId } },
  });

  // I Want This (§15.1) → POST /api/media/:id/intent. An intent SIGNAL, not a
  // like/save/stamp: it records what the viewer wants to do, keyed to the media's
  // resolved entity, and is consumed by discovery/Compass as a want-signal.
  actions.push({
    id: "i_want_this",
    label: "I want this",
    outcome: "want",
    target: {
      method: "POST",
      endpoint: "/api/media/:id/intent",
      params: {
        id: mediaId,
        entityType: entities.tripId ? "trip" : entities.gemId ? "gem" : entities.placeId ? "place" : "media",
        entityId: entities.tripId ?? entities.gemId ?? entities.placeId ?? mediaId,
      },
    },
  });

  // ── Place-bound navigation / discovery (only when a place resolves) ────────
  if (entities.placeId) {
    // Show on Map / Go There → the coarse media place projection (canonical
    // places.id). No coordinates leave the server; the client positions it via
    // the Map gateway it already holds.
    actions.push({
      id: "show_on_map",
      label: "Show on map",
      outcome: "navigate",
      target: { method: "GET", endpoint: "/api/media/places/:placeId", params: { placeId: entities.placeId } },
    });
    // See Nearby → the city media map (perspective counts per place).
    actions.push({
      id: "see_nearby",
      label: "See nearby",
      outcome: "discover",
      target: {
        method: "GET",
        endpoint: "/api/media/map",
        params: entities.city ? { city: entities.city } : {},
      },
    });
    // Find Similar / Cheaper / Quieter / Busier → the city world lens buckets.
    actions.push({
      id: "find_similar",
      label: "Find similar",
      outcome: "discover",
      target: {
        method: "GET",
        endpoint: "/api/media/world",
        params: entities.city ? { city: entities.city } : {},
      },
    });
  }

  // ── Compass (only when Compass is enabled — the same gate /compass/ask uses) ─
  const compassOn = await isCompassEnabled(sc).catch(() => false);
  if (compassOn) {
    // Ask Compass → POST /api/compass/ask carrying the structured media context
    // (built by CompassMediaContext), never a raw string.
    actions.push({
      id: "ask_compass",
      label: "Ask Compass",
      outcome: "compass",
      target: { method: "POST", endpoint: "/api/compass/ask", params: { mediaId } },
    });
    // Create Plan → the same ask path, itinerary intent seeded by the media
    // context ("Build a plan around this", §32). Compass stays propose-only.
    actions.push({
      id: "create_plan",
      label: "Create a plan",
      outcome: "plan",
      target: {
        method: "POST",
        endpoint: "/api/compass/ask",
        params: { mediaId, prompt: "Build a plan around this." },
      },
    });
  }

  // ── Meet Here → POST /api/meetups (respects the new-event kill switch) ─────
  const meetBlocked = await isKillSwitchEngaged(sc, "disable_new_event_creation").catch(() => true);
  if (!meetBlocked) {
    actions.push({
      id: "meet_here",
      label: "Meet here",
      outcome: "meet",
      target: {
        method: "POST",
        endpoint: "/api/meetups",
        params: entities.placeId
          ? { locationName: entities.refs.find((r) => r.kind === "place")?.label ?? entities.city ?? null }
          : { locationName: entities.city ?? null },
      },
    });
  }

  // ── Trip-plan actions — gated by the SAME check the endpoint enforces ──────
  // Add to Trip (§15) / Do This Experience (§15.2) both resolve to the generic
  // trip-plan-item endpoint, whose gate is canEditPlan. Offer them ONLY when the
  // viewer actually has a plan-editable trip. Dropping this gate can only add a
  // dead action — never a privileged one — because the endpoint re-checks.
  const editableTripIds = await loadPlanEditableTripIds(sc, viewer.viewerId);
  if (editableTripIds.length > 0) {
    // Add to Trip → POST /api/trips/:tripId/plan/items (a media/place plan item).
    actions.push({
      id: "add_to_trip",
      label: "Add to trip",
      outcome: "plan",
      target: {
        method: "POST",
        endpoint: "/api/trips/:tripId/plan/items",
        params: {
          editableTripIds,
          sourceType: entities.placeId ? "place" : "media",
          sourceId: entities.placeId ?? mediaId,
          title: entities.refs.find((r) => r.kind === "place")?.label ?? entities.city ?? "Saved place",
          category: "activity",
        },
      },
    });

    // Do This Experience (§15.2): only when the media links to an eligible
    // experience (a trip the viewer may see). Converts that experience into
    // plan items via the SAME trip-plan endpoint.
    if (entities.tripId) {
      actions.push({
        id: "do_this_experience",
        label: "Do this experience",
        outcome: "plan",
        target: {
          method: "POST",
          endpoint: "/api/trips/:tripId/plan/items",
          params: { editableTripIds, sourceExperienceId: entities.tripId },
        },
      });
    }
  }

  // View Experience → the coarse experience projection (read; eligibility already
  // proven when the trip ref was resolved).
  if (entities.tripId) {
    actions.push({
      id: "view_experience",
      label: "View experience",
      outcome: "navigate",
      target: { method: "GET", endpoint: "/api/media/experiences/:experienceId", params: { experienceId: entities.tripId } },
    });
  }

  return { mediaId, entityRefs: entities.refs, actions };
}

// ── Do This Experience (§15.2) ────────────────────────────────────────────────

/** One resolvable stop in the executable plan, keyed to a canonical entity. */
export interface ExperiencePlanStop {
  /** source_type for the trip_plan_items row the endpoint writes. */
  sourceType: "place" | "media" | "trip";
  /** Canonical id (places.id / media id) — never a coordinate. */
  sourceId: string;
  title: string;
  category: string;
}

export interface ExperiencePlanProposal {
  experienceId: string;
  kind: "event" | "trip";
  /** The EXISTING plan-creation endpoint each stop is submitted to (per trip). */
  targetEndpoint: string;
  method: "POST";
  /** Ordered, resolvable stops — the executable plan the user confirms. */
  stops: ExperiencePlanStop[];
  /** Trips the viewer may write the plan into (the target's own gate). */
  eligibleTripIds: string[];
}

/**
 * Convert an eligible experience (a Trail / Trip recap / itinerary the viewer may
 * see) into an executable plan PROPOSAL, additively (§15.2). It does NOT write —
 * Compass stays propose-only — it produces the ordered stops the user's client
 * submits to the EXISTING trip-plan-item endpoint (POST /api/trips/:tripId/plan/
 * items). Two independent gates decide whether a plan can be produced at all:
 *
 *   1. The experience must be VIEWER-ELIGIBLE — resolveExperience returns null
 *      for a private / blocked / non-existent experience, so no plan is produced
 *      for something the viewer cannot see.
 *   2. The viewer must have a plan-editable trip (canEditPlan) to receive it —
 *      `eligibleTripIds` is [] otherwise, so the proposal has nowhere to land.
 *
 * Returns null when the experience is not eligible.
 */
export async function buildDoThisExperiencePlan(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  experienceId: string,
  nowMs: number,
): Promise<ExperiencePlanProposal | null> {
  const exp = await resolveExperience(sc, viewer, experienceId, nowMs);
  if (!exp) return null; // not visible to this viewer → no plan (§47).

  // Build ordered stops from the experience's canonical places. Coarse only: a
  // stop carries the opaque place id + label, never a coordinate — the plan-item
  // endpoint resolves the rest. Fall back to the experience's hero media when it
  // has no distinct place ids so the plan is never empty for a real experience.
  const seen = new Set<string>();
  const stops: ExperiencePlanStop[] = [];
  for (const pid of exp.placeIds) {
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    const label = exp.heroMedia.find((m) => m.placeId === pid)?.placeLabel ?? exp.title ?? "Stop";
    stops.push({ sourceType: "place", sourceId: pid, title: label, category: "activity" });
  }
  if (stops.length === 0) {
    for (const m of exp.heroMedia) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      stops.push({ sourceType: "media", sourceId: m.id, title: m.placeLabel ?? exp.title ?? "Stop", category: "activity" });
    }
  }

  const eligibleTripIds = await loadPlanEditableTripIds(sc, viewer.viewerId);

  return {
    experienceId,
    kind: exp.kind,
    targetEndpoint: "/api/trips/:tripId/plan/items",
    method: "POST",
    stops,
    eligibleTripIds,
  };
}

// ── I Want This (§15.1) — intent signal store ─────────────────────────────────

export const MEDIA_INTENT_KINDS = ["want_to_go", "want_to_do", "want_similar"] as const;
export type MediaIntentKind = (typeof MEDIA_INTENT_KINDS)[number];

export interface RecordMediaIntentResult {
  recorded: boolean;
  reason?: "invalid" | "db_error";
}

/**
 * Record an "I Want This" intent SIGNAL (§15.1) — deliberately NOT a like / save
 * / stamp. It is written to its own table (`media_intent_signals`), keyed to the
 * media and its resolved entity, so discovery/Compass can read it as a
 * want-signal without conflating it with social engagement counts. Idempotent
 * per (user, media). Fail-soft but OBSERVABLE — the DB error is returned, never
 * swallowed.
 */
export async function recordMediaIntent(
  sc: SupabaseClient,
  userId: string,
  mediaId: string,
  entity: { entityType: string; entityId: string },
  intent: MediaIntentKind,
): Promise<RecordMediaIntentResult> {
  if (!UUID_RE.test(mediaId)) return { recorded: false, reason: "invalid" };
  const { error } = await (sc as any)
    .from("media_intent_signals")
    .upsert(
      {
        user_id: userId,
        media_id: mediaId,
        entity_type: entity.entityType,
        entity_id: entity.entityId,
        intent,
      },
      { onConflict: "user_id,media_id" },
    );
  if (error) return { recorded: false, reason: "db_error" };
  return { recorded: true };
}
