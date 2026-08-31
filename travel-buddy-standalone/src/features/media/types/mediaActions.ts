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
  | 'report';

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
  | 'discover';

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
