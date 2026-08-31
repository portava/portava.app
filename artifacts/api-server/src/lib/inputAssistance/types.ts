/**
 * Global Input Intelligence Architecture — canonical types (Phase 1, backend).
 *
 * This file is the SOURCE OF TRUTH for the typed-input control plane contract.
 * Implemented verbatim from the developer spec so the parallel client SDK
 * (Global Input Intelligence SDK) matches byte-for-byte:
 *
 *   §5  InputContext registry
 *   §6  InputFieldPolicy contract
 *   §7  AssistanceType
 *   §8  InputSuggestion (canonical suggestion object)
 *   §43 SuggestionAction (routing / action resolution)
 *
 * Phase-1 scope is the registry + policy + gateway + projection SKELETON that
 * WRAPS existing candidate generation (discoverySearch / canonicalLocations /
 * the resolvers). The following are DELIBERATELY DEFERRED to later phases and
 * must NOT be built here:
 *   - Full semantic parsing (§18) and the sequence/anchor operators.
 *   - AI-assisted writing (§22) — only static, opt-in prompt starters exist now.
 *   - The unified QueryNormalizer diacritic/trigram DB work (§10).
 *   - The per-field ValidationService (§23).
 *   - Personalization/selection memory (§35).
 *   - The LiveSuggestionService zone rollup + label formatters (§9 live phase).
 * Where a field below is a Phase-1 placeholder for deferred work it is marked.
 */

// ── §5 Input Context Registry ─────────────────────────────────────────────────
//
// Every meaningful text field registers exactly one of these. The registry
// (see policyRegistry.ts) is the central contract controlling what assistance
// is allowed for each.

export type InputContext =
  | 'global_search'
  | 'city_picker'
  | 'country_picker'
  | 'neighborhood_picker'
  | 'place_picker'
  | 'trip_destination'
  | 'trip_title'
  | 'trip_stop_place'
  | 'event_location'
  | 'event_title'
  | 'event_description'
  | 'plan_title'
  | 'hidden_gem_name'
  | 'hidden_gem_location'
  | 'buddy_service'
  | 'buddy_service_area'
  | 'username'
  | 'display_name'
  | 'hashtag'
  | 'caption'
  | 'comment'
  | 'telegraph_recipient'
  | 'telegraph_message'
  | 'compass_prompt'
  | 'passport_homebase'
  | 'language'
  | 'interest'
  | 'address'
  | 'generic_text';

// ── Entity classes ────────────────────────────────────────────────────────────
//
// Canonical Portava entity classes a suggestion can resolve to. These map 1:1
// onto the existing cross-entity search types in routes/discoverySearch.ts (see
// entityMap.ts), so the gateway can delegate candidate generation without
// inventing a second taxonomy.

export type EntityType =
  | 'city'
  | 'country'
  | 'neighborhood'
  | 'place'
  | 'hidden_gem'
  | 'user'
  | 'buddy'
  | 'trip'
  | 'event'
  | 'plan'
  | 'circle'
  | 'post'
  | 'hashtag'
  | 'stamp'
  | 'activity'
  | 'language'
  | 'interest'
  | 'vibe';

// ── §7 Assistance Types ───────────────────────────────────────────────────────

export type AssistanceType =
  | 'entity'
  | 'completion'
  | 'recent'
  | 'personalized'
  | 'structured_value'
  | 'action'
  | 'correction'
  | 'validation'
  | 'disambiguation'
  | 'ai_suggestion';

// ── §6 Field Policy mode ──────────────────────────────────────────────────────

export type InputMode =
  | 'no_assistance'
  | 'canonical_picker'
  | 'search'
  | 'free_text_assisted'
  | 'action_assisted'
  | 'ai_assisted';

// ── §8 Freshness (live projection state) ──────────────────────────────────────
//
// A projection of the Live Intelligence system's state, never fabricated
// (§31 anti-fabrication: never manufacture "busy now"/"available now"). Phase 1
// does not wire the LiveSuggestionService, so the projection NEVER sets this —
// a live label is only ever emitted when live state is genuinely servable.
// Shape mirrors the servable envelope from lib/liveClaimRead so the later
// LiveSuggestionService can populate it without a contract change.

export interface FreshnessState {
  /** Whether live state is servable at all. When false the client shows no live label. */
  state: 'fresh' | 'recently_confirmed' | 'stale' | 'unavailable';
  /** Human-readable "Updated 4m ago" style label. Absent when not servable. */
  updatedAtLabel?: string;
  /** Optional trend/value label ("Getting busier"). Only set from real live data. */
  label?: string;
}

// ── Privacy / offline classification ─────────────────────────────────────────

export type PrivacyClass =
  | 'public'
  | 'viewer_scoped'
  | 'owner_only'
  | 'sensitive_location'
  | 'private_message';

// §32/§34: how a field degrades when offline. Descriptive in Phase 1 — the
// client SDK owns actual offline behavior; the server just declares the intent.
export type OfflineInputPolicy =
  | 'static_dictionary'
  | 'cached_local'
  | 'recent_only'
  | 'server_required'
  | 'unavailable';

// §23 placeholder — the per-field ValidationService is deferred. The policy can
// carry declared rules now so the contract is stable; nothing enforces them yet.
export interface ValidationRule {
  id: string;
  kind: string;
  message?: string;
}

// §44 telemetry policy. Phase 1 declares intent (esp. never log raw private
// message text) but does not persist events — the gateway reuses existing
// fire-and-forget analytics infra when telemetry is wired in a later phase.
export interface InputTelemetryPolicy {
  /** MUST be false for private-message fields (§44) — never log raw text. */
  logRawText: boolean;
  /** Declared §44 event vocabulary this field participates in. */
  events: string[];
}

// ── §6 Field Policy Contract ──────────────────────────────────────────────────

export interface InputFieldPolicy {
  fieldId: string;
  context: InputContext;

  mode: InputMode;

  allowedSuggestionTypes: AssistanceType[];
  entityTypes?: EntityType[];

  allowPersonalization: boolean;
  allowLiveContext: boolean;
  allowMemoryContext: boolean;
  allowAI: boolean;

  minChars: number;
  maxSuggestions: number;
  debounceMs: number;

  offlinePolicy: OfflineInputPolicy;
  privacyClass: PrivacyClass;
  validationRules?: ValidationRule[];
  telemetryPolicy: InputTelemetryPolicy;
}

// ── §43 Routing and Action Resolution ─────────────────────────────────────────
//
// Every tappable suggestion resolves through this canonical action/destination
// contract. All action suggestions use the same authorization gate as the
// target action itself (§47) — the gateway only PROPOSES actions; execution
// stays behind the target endpoint's own auth.

export type SuggestionAction =
  | { type: 'open_entity'; entityType: EntityType; entityId: string }
  | { type: 'replace_text'; text: string }
  | { type: 'set_structured_value'; value: unknown }
  | { type: 'submit_search'; query: string }
  | { type: 'add_to_trip'; entityId: string }
  | { type: 'share_entity'; entityType: EntityType; entityId: string }
  | { type: 'drop_pin' }
  | { type: 'open_compass'; context: unknown };

/**
 * A canonical destination a suggestion routes to when it is not an inline
 * action. `route` reuses the existing SearchResult.destinationRoute contract
 * (e.g. "/city/da-nang", "/passport/alice") so the client's router is unchanged.
 */
export interface SearchDestination {
  route: string;
  entityType?: EntityType;
  entityId?: string;
}

// ── §8 Canonical Suggestion Object ────────────────────────────────────────────
//
// The UI-ready projection. Per §42 this exposes NO raw trust vectors, private
// ranking features, or hidden policy decisions — the projection layer
// (projection.ts) deliberately copies only these fields out of the internal
// SearchResult and drops metadata such as owner ids, like counts, and coords.

export interface InputSuggestion {
  id: string;
  type: AssistanceType;
  context: InputContext;

  label: string;
  subtitle?: string;
  replacementText?: string;

  entityType?: EntityType;
  entityId?: string;
  canonicalUri?: string;

  action?: SuggestionAction;
  structuredValue?: unknown;

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

  reason?: string;
  destination?: SearchDestination;
  policyVersion: string;
}

// ── §41 API request / response envelopes ──────────────────────────────────────

export interface SuggestSessionContext {
  tripId?: string;
  cityId?: string;
}

// ── §23/§55 creation draft (Phase 5) ──────────────────────────────────────────
//
// Additive request context describing the entity the client is CREATING. Every
// field is optional and only the creation contexts read it; all other contexts
// ignore it, so the contract stays backward-compatible.
export interface CreationDraft {
  /** The entity NAME being created (when the typed field is not itself the name). */
  name?: string;
  city?: string | null;
  country?: string | null;
  category?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** ISO dates for Trip creation date-conflict checks (§23). */
  startDate?: string | null;
  endDate?: string | null;
  address?: string | null;
}

export interface SuggestRequest {
  context: InputContext;
  fieldId?: string;
  text?: string;
  limit?: number;
  sessionContext?: SuggestSessionContext;
  /** Optional viewer geo — forwarded only when the client has permission. */
  lat?: number;
  lng?: number;
  city?: string;
  /** §18 optional IANA timezone for semantic temporal-window normalization. */
  tz?: string;
  /** §23/§55 creation draft — read only by creation contexts. */
  draft?: CreationDraft;
  /**
   * §22 per-request OPT-IN for AI-assisted writing. The client sets this only
   * when the user explicitly invokes AI assistance (e.g. taps "AI assist").
   * When absent/false the field still returns its deterministic assistance but
   * NO model-generated `ai_suggestion` — AI writing is never on by default.
   */
  aiAssist?: boolean;
}

export interface SuggestResponse {
  requestId: string;
  policyVersion: string;
  context: InputContext;
  fieldId?: string;
  suggestions: InputSuggestion[];
}
