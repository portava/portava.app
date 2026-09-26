/**
 * features/media — media action rail types (spec §14/§15/§15.1/§15.2/§32/§43).
 *
 * A faithful client mirror of the MERGED backend contract (#292):
 *   - GET  /media/:id/actions                    → MediaActionSet
 *   - POST/DELETE /media/:id/intent  ("I Want This", §15.1)
 *   - GET  /media/experiences/:id/plan ("Do This Experience", §15.2)
 *
 * Shapes match artifacts/api-server/src/services/media/MediaActionResolver.ts
 * exactly — the server is the source of truth for eligibility, so the client
 * renders ONLY the actions the server returns and never fabricates a set.
 *
 * Pure type module — no runtime imports.
 */

// ── Action + entity vocab (mirrors MediaActionResolver) ───────────────────────

export type MediaActionId =
  | 'show_on_map'
  | 'see_nearby'
  | 'find_similar'
  | 'ask_compass'
  | 'create_plan'
  | 'save'
  | 'add_to_trip'
  | 'do_this_experience'
  | 'view_experience'
  | 'meet_here'
  | 'i_want_this'
  | 'share_telegraph'
  | 'report'
  // census-media §21 — the §15 / §15.2 / §16.3 / §23.1 actions the server now
  // offers (and three it offered that this client used to hide).
  | 'directions'
  | 'view_event'
  | 'view_passport'
  | 'find_quieter'
  | 'find_cheaper'
  | 'contribute_gem'
  | 'invite_people'
  | 'follow_this_night'
  | 'save_route'
  | 'link_event';

/** Outcome-oriented category (§26) — what real-world value the action drives. */
export type MediaActionOutcome =
  | 'navigate'
  | 'compass'
  | 'plan'
  | 'save'
  | 'meet'
  | 'want'
  | 'share'
  | 'moderate'
  | 'discover'
  | 'contribute';

export type MediaEntityKind = 'media' | 'place' | 'trip' | 'gem';

export interface MediaEntityRef {
  kind: MediaEntityKind;
  id: string;
  /** Coarse label only (place name / city) — NEVER a coordinate. */
  label: string | null;
}

export interface MediaActionTarget {
  method: 'GET' | 'POST' | 'DELETE';
  /** Canonical endpoint path (an EXISTING route). */
  endpoint: string;
  /** Body / path params the server resolved for that endpoint. */
  params: Record<string, unknown>;
}

export interface MediaAction {
  id: MediaActionId | string;
  label: string;
  outcome: MediaActionOutcome | string;
  target: MediaActionTarget;
}

export interface MediaActionSet {
  mediaId: string;
  entityRefs: MediaEntityRef[];
  actions: MediaAction[];
  /** ISO timestamp the set was computed, or null. */
  generatedAt: string | null;
}

// ── "I Want This" intent (§15.1) — a SIGNAL, not a like/save ──────────────────

export type MediaIntentKind = 'want_to_go' | 'want_to_do' | 'want_similar';

// ── "Do This Experience" plan proposal (§15.2) — PROPOSE-ONLY ─────────────────

export interface ExperiencePlanStop {
  sourceType: 'place' | 'media' | 'trip';
  /** Canonical id (places.id / media id) — never a coordinate. */
  sourceId: string;
  title: string;
  category: string;
}

export interface ExperiencePlanProposal {
  experienceId: string;
  kind: 'event' | 'trip';
  /** The EXISTING plan-creation endpoint each stop is submitted to (per trip). */
  targetEndpoint: string;
  method: 'POST';
  /** Ordered, resolvable stops — the executable plan the user confirms. */
  stops: ExperiencePlanStop[];
  /** Trips the viewer may write the plan into (the target's own gate). */
  eligibleTripIds: string[];
  generatedAt: string | null;
}

// ── "Do This Experience" as an EXECUTABLE plan (§15.2, census-media §21) ─────

/** A compiled stop: ordered, timed, keyed to a canonical entity — never a coordinate. */
export interface CompiledPlanStop extends ExperiencePlanStop {
  order: number;
  startsAt: string;
  endsAt: string;
  dwellMinutes: number;
  transitMinutesBefore: number;
  /** 'default' — no route was measured; the plan says so rather than pretending. */
  transitBasis: 'none' | 'default';
}

/** GET /media/experiences/:id/plan?compile=1 — compileExperiencePlan's answer. */
export interface CompiledExperiencePlan {
  source: { kind: 'experience' | 'trail'; id: string; title: string | null };
  /** YYYY-MM-DD the plan is compiled onto. */
  day: string;
  startsAt: string;
  stops: CompiledPlanStop[];
  eligibleTripIds: string[];
  /** Always 'not_verified' today — feasibility is the Trips lane's, and off. */
  feasibility: string;
}

// ── Save Route (§23.1) ───────────────────────────────────────────────────────

/** One chain stop as the rail hands it over: a canonical place id and a title. */
export interface RouteStopRef {
  sourceType: 'place';
  sourceId: string;
  title: string;
}

// ── Link to an event (census-media §21, MD103) ───────────────────────────────

/** An event the author may link their post to — offered by the server, never guessed. */
export interface LinkableEventRef {
  eventId: string;
  title: string | null;
  startsAt: string | null;
}
