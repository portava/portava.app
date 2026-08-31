/**
 * Global Input Intelligence — the canonical InputSuggestion object + the
 * request/response projection contract.
 *
 * Mirrors PGIIA spec §8 (Canonical Suggestion Object) and §41 (API Contract)
 * EXACTLY. The backend gateway returns this UI-ready projection (§42) — it must
 * NOT expose raw trust vectors or hidden policy decisions. The parallel
 * `POST /input-assistance/suggest` build targets these same shapes.
 */
import type {
  AssistanceType,
  EntityType,
  FreshnessState,
  InputContext,
} from './inputContext.ts';
import type { SuggestionAction } from './suggestionAction.ts';

/**
 * §8 `destination?: SearchDestination` — where a tappable suggestion resolves.
 * A UI-ready projection: a router path plus (optionally) the canonical entity
 * identity, so the client never has to reconstruct routing from internals.
 * Aligns with the existing `searchNav.resolveRoute` destinationRoute contract.
 */
export interface SearchDestination {
  /** Expo Router path (already client-normalised where the server can). */
  route?: string | null;
  entityType?: EntityType;
  entityId?: string;
}

/**
 * §8 — the single canonical suggestion object every surface consumes. One
 * shape for entities, completions, actions, corrections, validations,
 * disambiguations, and AI suggestions.
 */
export interface InputSuggestion {
  id: string;
  type: AssistanceType;
  context: InputContext;

  label: string;
  subtitle?: string;
  /** Text to place into the field when accepted (§8, §22 never silently). */
  replacementText?: string;

  entityType?: EntityType;
  entityId?: string;
  canonicalUri?: string;

  action?: SuggestionAction;
  structuredValue?: unknown;

  /** 0..1 — drives §19 progressive disambiguation tiers. */
  confidence?: number;
  freshness?: FreshnessState;

  source:
    | 'canonical'
    | 'recent'
    | 'memory'
    | 'live_intelligence'
    | 'provider'
    | 'local'
    | 'ai';

  /** "Why this is suggested" (§28) — human-readable, optional. */
  reason?: string;
  destination?: SearchDestination;
  policyVersion: string;
}

/**
 * §41 — request body for the canonical suggest endpoint. `sessionContext`
 * carries the bounded, permitted task context (§16) — never persistent prefs.
 */
export interface SuggestRequest {
  context: InputContext;
  fieldId: string;
  text: string;
  limit?: number;
  sessionContext?: InputSessionContext;
}

/**
 * §16 / §41 — bounded task/session context shared between fields in the same
 * task. Deliberately narrow: only IDs the server may use to bias ranking. Must
 * not silently change unrelated persistent preferences (§16).
 */
export interface InputSessionContext {
  tripId?: string;
  cityId?: string;
  countryId?: string;
  eventId?: string;
  /** Coarse location for geographic ranking (§15). */
  lat?: number;
  lng?: number;
  /** IANA timezone for temporal intent parsing ("tonight" etc., §18). */
  tz?: string;
  /** §23 — candidate trip/event window (ISO), so the gateway can explain a date
   *  conflict with the viewer's existing plans. A NEW entity has no id yet to look
   *  its window up by, so the window is passed explicitly. Optional + additive. */
  startDate?: string;
  endDate?: string;
  /** Current app surface, for context-aware zero-state (§14, §56). */
  surface?: string;
}

/**
 * §41 / §42 — the UI-ready projection returned by the gateway. `requestId`
 * lets the client's sequence guard correlate responses (§33 race safety).
 */
export interface SuggestResponse {
  requestId: string;
  policyVersion: string;
  suggestions: InputSuggestion[];
}

/**
 * Client-side outcome of a suggest call. Never throws — degrades to
 * `{ ok: false }` so a 404 (backend not deployed yet) or a network failure
 * yields "no suggestions", never a crash (§38 failure fallback ladder). The
 * `aborted` flag lets the hook's sequence guard ignore superseded requests.
 */
export type SuggestResult =
  | { ok: true; requestId: string; policyVersion: string; suggestions: InputSuggestion[] }
  | { ok: false; aborted: boolean; unavailable: boolean; error: string };
