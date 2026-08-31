/**
 * Global Input Intelligence — InputContext + supporting classification types.
 *
 * Mirrors PGIIA spec §5 (Input Context Registry) and §7 (Assistance Types)
 * EXACTLY. These are the central contract that controls what assistance a
 * field is allowed to request. The backend `POST /input-assistance/suggest`
 * gateway is built to the same union values (§41) — do not diverge without
 * coordinating a `policyVersion` bump (§48).
 *
 * ADDITIVE: this is a brand-new platform spine. No existing field yet consumes
 * it (migration is a later phase). Nothing here changes runtime behavior on its
 * own.
 */

/**
 * §5 — Every meaningful text field must register an InputContext. The registry
 * is the central contract controlling what assistance is allowed.
 */
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

/** Exhaustive, ordered list of every InputContext — for registry validation + tests. */
export const INPUT_CONTEXTS: readonly InputContext[] = [
  'global_search',
  'city_picker',
  'country_picker',
  'neighborhood_picker',
  'place_picker',
  'trip_destination',
  'trip_title',
  'trip_stop_place',
  'event_location',
  'event_title',
  'event_description',
  'plan_title',
  'hidden_gem_name',
  'hidden_gem_location',
  'buddy_service',
  'buddy_service_area',
  'username',
  'display_name',
  'hashtag',
  'caption',
  'comment',
  'telegraph_recipient',
  'telegraph_message',
  'compass_prompt',
  'passport_homebase',
  'language',
  'interest',
  'address',
  'generic_text',
] as const;

/**
 * §7 — Assistance Types. What KIND of help a suggestion represents. A field's
 * policy declares which of these it accepts (`allowedSuggestionTypes`).
 */
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

/**
 * Canonical entity classes the system resolves user text into (spec §11 +
 * "Entity class" resolution table). Referenced by InputFieldPolicy.entityTypes,
 * InputSuggestion.entityType, and SuggestionAction. Kept intentionally distinct
 * from the map/share EntityType unions elsewhere in the app — those are
 * surface-specific; this one is the Input Intelligence canonical set.
 */
export type EntityType =
  | 'city'
  | 'country'
  | 'neighborhood'
  | 'place'
  | 'hidden_gem'
  | 'user'
  | 'trip'
  | 'event'
  | 'plan'
  | 'buddy'
  | 'hashtag'
  | 'language'
  | 'interest';

/**
 * §31 — Freshness / Live Intelligence state carried by a suggestion. Live
 * suggestions remain projections of the Live Intelligence system; if live state
 * is stale/unavailable the label must be removed or shown as last-updated.
 * Never manufacture "busy now"/"available now" (Principle §2, §31).
 */
export interface FreshnessState {
  state: 'live' | 'recent' | 'stale' | 'unavailable';
  /** Human label e.g. "Getting busier", "Recently confirmed". Omit when unavailable. */
  label?: string;
  /** ISO timestamp of the last confirmed update, when known. */
  updatedAt?: string;
}

/**
 * §29 — Privacy classification of the field's content. Drives telemetry
 * (private_message never logs raw text, §44) and projection eligibility.
 */
export type PrivacyClass = 'public' | 'personal' | 'sensitive' | 'private_message';

/**
 * §32 — How the field degrades offline. Live intelligence is NEVER represented
 * as live when offline; that rule is enforced in code, not expressible here.
 */
export type OfflineInputPolicy =
  | 'static_dictionary' // countries / languages / interests — local static list
  | 'cached_entities' // cities / saved / trip-scoped — cached subset
  | 'recent_only' // device-local recents only
  | 'none'; // no offline assistance (degrade to raw text)
