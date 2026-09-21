/**
 * Global Input Intelligence — the InputFieldPolicy contract.
 *
 * Mirrors PGIIA spec §6 (Field Policy Contract) EXACTLY. "The field owns
 * behavior; the Input Intelligence platform owns suggestion intelligence"
 * (§2). A field is added to the platform by registering a policy and consuming
 * shared primitives — never by building a second architecture (§52).
 */
import type {
  AssistanceType,
  EntityType,
  InputContext,
  OfflineInputPolicy,
  PrivacyClass,
} from './inputContext.ts';

/**
 * §6 — assistance mode. Determines how aggressively the field assists and which
 * primitive it renders through (SmartInput selects behavior from this).
 *   - no_assistance      : plain text, no suggestions (e.g. display_name).
 *   - canonical_picker   : must resolve to a canonical entity (city/place/homebase).
 *   - search             : mixed-entity typeahead that can also submit a query.
 *   - free_text_assisted : free text with optional mentions/hashtags/completions.
 *   - action_assisted    : typing surfaces actions, not text (telegraph §54).
 *   - ai_assisted        : opt-in AI prompts/continuation (compass §56).
 */
export type InputAssistanceMode =
  | 'no_assistance'
  | 'canonical_picker'
  | 'search'
  | 'free_text_assisted'
  | 'action_assisted'
  | 'ai_assisted';

/**
 * §23 / validation table — a non-blocking validation the field may run while
 * typing. `kind` is the semantic check; the resolver that answers it is wired
 * per-phase (Phase 5 for duplicate/username). Non-blocking by contract.
 */
export interface ValidationRule {
  id: string;
  kind:
    | 'required'
    | 'max_length'
    | 'min_length'
    | 'username_available'
    | 'duplicate_entity'
    | 'city_country_match'
    | 'date_conflict'
    | 'address_resolvable'
    | 'hashtag_format';
  /** Optional override message; otherwise a default is derived per kind. */
  message?: string;
  /** Kind-specific parameters (e.g. { max: 24 } for max_length). */
  params?: Record<string, unknown>;
}

/**
 * §44 — per-field telemetry policy.
 *
 * THIS SHAPE IS THE SERVER'S (`lib/inputAssistance/types.ts#InputTelemetryPolicy`),
 * and it did not used to be. Census G33 recorded that the two sides declared
 * DIFFERENT SHAPES for this member — this side named its raw-text gate
 * `capture`-something and allowed an `'all'` sentinel in `events`, neither of
 * which existed on the server — so the "implemented verbatim … matches
 * byte-for-byte" claim was false for it, and a server policy change to it could
 * not reach the client.
 *
 * Two names for one gate is not a cosmetic divergence: it is why nothing could
 * compare the two registries on the member that decides whether the user's raw
 * typed text is allowed into an analytics event. `events` is likewise an
 * explicit list on both sides now — the old `'all'` sentinel had no server
 * counterpart, so a server policy that NARROWED a field's vocabulary had no
 * way to be expressed here.
 *
 * `test/inputPolicyContractParity.test.ts` pins both members, context for
 * context, so the shapes cannot drift apart again.
 */
export interface InputTelemetryPolicy {
  /** MUST be false for private-message and sensitive fields (§44). */
  logRawText: boolean;
  /** The declared §44 event vocabulary this field participates in. */
  events: InputTelemetryEventName[];
}

/** §44 — the named telemetry event taxonomy. */
export type InputTelemetryEventName =
  | 'input_opened'
  | 'query_length_changed'
  | 'suggestion_request_started'
  | 'suggestion_request_completed'
  | 'suggestion_rendered'
  | 'suggestion_selected'
  | 'suggestion_dismissed'
  | 'raw_search_submitted'
  | 'manual_value_kept'
  | 'validation_shown'
  | 'correction_accepted'
  | 'disambiguation_selected'
  | 'action_completed'
  | 'downstream_task_completed';

/**
 * §6 — the field policy contract. Registered against a `fieldId` in the
 * fieldRegistry. Versioned independently of app releases (§48) via
 * `policyVersion` on responses.
 */
export interface InputFieldPolicy {
  fieldId: string;
  context: InputContext;

  mode: InputAssistanceMode;

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
