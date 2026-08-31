/**
 * InputContext registry + field-policy engine (Phase 1, code-first).
 *
 * Maps each InputContext (§5) to a default InputFieldPolicy (§6): the mode,
 * the allowed suggestion/entity types, the personalization/live/memory/AI
 * gates, min chars, max suggestions, debounce, offline + privacy class, and the
 * telemetry policy.
 *
 * CODE-FIRST is deliberate for Phase 1 (per the platform decision): the
 * registry is versioned by POLICY_VERSION so the server can ship policy updates
 * without a client release (§48), and a later phase can back it with a DB table
 * (migration lane 2220+) for a policy-version audit or telemetry — only if
 * genuinely needed. No DB object is introduced here.
 *
 * The policy is the gate the gateway enforces BEFORE candidate generation and
 * BEFORE projection: a context only ever produces the suggestion/entity types
 * its policy allows (e.g. city_picker never emits ai_suggestion; compass_prompt
 * does). Feature teams add a field by registering a policy, not by building a
 * second autocomplete engine (§52).
 */
import type {
  InputContext,
  InputFieldPolicy,
  AssistanceType,
  EntityType,
  InputMode,
  PrivacyClass,
  OfflineInputPolicy,
  InputTelemetryPolicy,
} from './types';

/**
 * Versioned independently of app releases (§48). Bump when the shape or
 * semantics of the registry change in a way clients must be aware of.
 */
export const POLICY_VERSION = 'input-2026-08';

// The §44 events every field participates in unless it opts to log less.
const STANDARD_TELEMETRY: InputTelemetryPolicy = {
  logRawText: false,
  events: [
    'input_opened',
    'suggestion_request_completed',
    'suggestion_rendered',
    'suggestion_selected',
    'raw_search_submitted',
  ],
};

// Private-message fields prefer metadata-only events — never the raw text (§44).
const METADATA_ONLY_TELEMETRY: InputTelemetryPolicy = {
  logRawText: false,
  events: ['suggestion_request_completed', 'suggestion_selected', 'action_completed'],
};

interface PolicySeed {
  mode: InputMode;
  allowedSuggestionTypes: AssistanceType[];
  entityTypes?: EntityType[];
  allowPersonalization?: boolean;
  allowLiveContext?: boolean;
  allowMemoryContext?: boolean;
  allowAI?: boolean;
  minChars?: number;
  maxSuggestions?: number;
  debounceMs?: number;
  offlinePolicy?: OfflineInputPolicy;
  privacyClass?: PrivacyClass;
  telemetryPolicy?: InputTelemetryPolicy;
}

function policy(context: InputContext, seed: PolicySeed): InputFieldPolicy {
  return {
    fieldId: context, // default field id; a caller may pass a more specific one
    context,
    mode: seed.mode,
    allowedSuggestionTypes: seed.allowedSuggestionTypes,
    entityTypes: seed.entityTypes ?? [],
    allowPersonalization: seed.allowPersonalization ?? false,
    allowLiveContext: seed.allowLiveContext ?? false,
    allowMemoryContext: seed.allowMemoryContext ?? false,
    allowAI: seed.allowAI ?? false,
    minChars: seed.minChars ?? 2,
    maxSuggestions: seed.maxSuggestions ?? 8,
    // §33 recommended debounce 100–150ms.
    debounceMs: seed.debounceMs ?? 120,
    offlinePolicy: seed.offlinePolicy ?? 'server_required',
    privacyClass: seed.privacyClass ?? 'public',
    telemetryPolicy: seed.telemetryPolicy ?? STANDARD_TELEMETRY,
  };
}

// ── The registry ──────────────────────────────────────────────────────────────

const REGISTRY: Record<InputContext, InputFieldPolicy> = {
  // Global cross-entity search (§13). Mixed entities + query completions.
  global_search: policy('global_search', {
    mode: 'search',
    allowedSuggestionTypes: ['entity', 'recent', 'completion', 'action'],
    entityTypes: [
      'city', 'country', 'place', 'hidden_gem', 'user', 'buddy', 'trip',
      'event', 'plan', 'circle', 'post', 'hashtag', 'stamp', 'activity',
    ],
    allowPersonalization: true,
    allowLiveContext: true,
    offlinePolicy: 'cached_local',
  }),

  // Geographic canonical pickers (§12) — cities/countries/regions only.
  city_picker: policy('city_picker', {
    mode: 'canonical_picker',
    allowedSuggestionTypes: ['entity', 'recent'],
    entityTypes: ['city', 'country'],
    allowPersonalization: true,
    offlinePolicy: 'cached_local',
  }),
  country_picker: policy('country_picker', {
    mode: 'canonical_picker',
    allowedSuggestionTypes: ['entity', 'recent'],
    entityTypes: ['country'],
    offlinePolicy: 'static_dictionary',
  }),
  neighborhood_picker: policy('neighborhood_picker', {
    mode: 'canonical_picker',
    allowedSuggestionTypes: ['entity', 'recent'],
    entityTypes: ['neighborhood', 'city'],
    offlinePolicy: 'cached_local',
  }),
  place_picker: policy('place_picker', {
    mode: 'canonical_picker',
    // §20/§23: canonical Place first (duplicate detection) + address fallback.
    allowedSuggestionTypes: ['entity', 'recent', 'disambiguation', 'action', 'validation'],
    entityTypes: ['place', 'city'],
    allowPersonalization: true,
    allowLiveContext: true,
  }),

  // Trips (§53).
  trip_destination: policy('trip_destination', {
    mode: 'canonical_picker',
    // §23: city-country correction + trip date-conflict validation.
    allowedSuggestionTypes: ['entity', 'recent', 'validation', 'correction'],
    entityTypes: ['city', 'country'],
    allowPersonalization: true,
    offlinePolicy: 'cached_local',
  }),
  trip_title: policy('trip_title', {
    mode: 'free_text_assisted',
    // §23: a trip title field also surfaces trip date-conflict validation.
    allowedSuggestionTypes: ['ai_suggestion', 'validation'],
    entityTypes: [],
    allowAI: true,
    minChars: 1,
    offlinePolicy: 'unavailable',
  }),
  trip_stop_place: policy('trip_stop_place', {
    mode: 'canonical_picker',
    // §20/§55: surface an existing Place/Gem before duplicating it.
    allowedSuggestionTypes: ['entity', 'recent', 'disambiguation'],
    entityTypes: ['place', 'city', 'hidden_gem'],
    allowPersonalization: true,
    allowLiveContext: true,
  }),

  // Events.
  event_location: policy('event_location', {
    mode: 'canonical_picker',
    // §20/§23: canonical-Place-first + unresolved-address fallback.
    allowedSuggestionTypes: ['entity', 'recent', 'disambiguation', 'action', 'validation'],
    entityTypes: ['place', 'city'],
    allowLiveContext: true,
  }),
  event_title: policy('event_title', {
    mode: 'free_text_assisted',
    // §20: surface a probable existing event before creating a duplicate.
    allowedSuggestionTypes: ['ai_suggestion', 'disambiguation', 'correction'],
    entityTypes: ['event'],
    allowAI: true,
    minChars: 1,
    offlinePolicy: 'unavailable',
  }),
  event_description: policy('event_description', {
    mode: 'ai_assisted',
    allowedSuggestionTypes: ['ai_suggestion'],
    allowAI: true,
    minChars: 1,
    offlinePolicy: 'unavailable',
  }),
  plan_title: policy('plan_title', {
    mode: 'free_text_assisted',
    allowedSuggestionTypes: ['entity', 'ai_suggestion'],
    entityTypes: ['place', 'hidden_gem', 'activity'],
    allowAI: true,
    minChars: 1,
  }),

  // Hidden Gems (§55) — sensitive-location protection handled in the resolver.
  hidden_gem_name: policy('hidden_gem_name', {
    mode: 'free_text_assisted',
    // §20/§23/§55: duplicate-gem disambiguation + validation + city-country.
    allowedSuggestionTypes: ['entity', 'validation', 'disambiguation', 'correction'],
    entityTypes: ['hidden_gem', 'place'],
    privacyClass: 'sensitive_location',
  }),
  hidden_gem_location: policy('hidden_gem_location', {
    mode: 'canonical_picker',
    // §20/§23/§37: existing Place/Gem + address fallback + city-country.
    allowedSuggestionTypes: ['entity', 'action', 'disambiguation', 'validation', 'correction'],
    entityTypes: ['place', 'city', 'hidden_gem'],
    privacyClass: 'sensitive_location',
  }),

  // Rent a Buddy.
  buddy_service: policy('buddy_service', {
    mode: 'search',
    allowedSuggestionTypes: ['entity', 'completion'],
    entityTypes: ['buddy', 'activity', 'interest'],
  }),
  buddy_service_area: policy('buddy_service_area', {
    mode: 'canonical_picker',
    allowedSuggestionTypes: ['entity'],
    entityTypes: ['city', 'neighborhood'],
  }),

  // Identity / social.
  username: policy('username', {
    mode: 'search',
    allowedSuggestionTypes: ['entity', 'validation'],
    entityTypes: ['user'],
    privacyClass: 'viewer_scoped',
  }),
  display_name: policy('display_name', {
    mode: 'search',
    allowedSuggestionTypes: ['entity'],
    entityTypes: ['user'],
    privacyClass: 'viewer_scoped',
  }),
  hashtag: policy('hashtag', {
    mode: 'search',
    allowedSuggestionTypes: ['entity', 'completion'],
    entityTypes: ['hashtag'],
    minChars: 1,
  }),
  caption: policy('caption', {
    mode: 'free_text_assisted',
    allowedSuggestionTypes: ['entity', 'ai_suggestion'],
    entityTypes: ['hashtag', 'user', 'place'],
    allowAI: true,
    minChars: 1,
  }),
  comment: policy('comment', {
    mode: 'free_text_assisted',
    allowedSuggestionTypes: ['entity'],
    entityTypes: ['user', 'hashtag'],
    minChars: 1,
    privacyClass: 'viewer_scoped',
  }),

  // Telegraph (§54).
  telegraph_recipient: policy('telegraph_recipient', {
    mode: 'search',
    allowedSuggestionTypes: ['entity', 'recent'],
    entityTypes: ['user'],
    allowPersonalization: true,
    privacyClass: 'viewer_scoped',
  }),
  telegraph_message: policy('telegraph_message', {
    mode: 'action_assisted',
    allowedSuggestionTypes: ['entity', 'action'],
    entityTypes: ['place', 'trip', 'event', 'user'],
    allowLiveContext: true,
    privacyClass: 'private_message',
    telemetryPolicy: METADATA_ONLY_TELEMETRY,
  }),

  // Compass (§56) — the AI lane. Static opt-in prompt starters in Phase 1.
  compass_prompt: policy('compass_prompt', {
    mode: 'ai_assisted',
    allowedSuggestionTypes: ['ai_suggestion', 'completion', 'entity'],
    entityTypes: ['place', 'hidden_gem', 'city'],
    allowAI: true,
    allowLiveContext: true,
    allowMemoryContext: true,
    minChars: 0,
  }),

  // Passport.
  passport_homebase: policy('passport_homebase', {
    mode: 'canonical_picker',
    allowedSuggestionTypes: ['entity'],
    entityTypes: ['city', 'country'],
    offlinePolicy: 'cached_local',
  }),

  // Controlled dictionaries.
  language: policy('language', {
    mode: 'canonical_picker',
    allowedSuggestionTypes: ['entity'],
    entityTypes: ['language'],
    minChars: 1,
    offlinePolicy: 'static_dictionary',
  }),
  interest: policy('interest', {
    mode: 'canonical_picker',
    allowedSuggestionTypes: ['entity'],
    entityTypes: ['interest'],
    minChars: 1,
    offlinePolicy: 'static_dictionary',
  }),

  // Addresses — provider path is dormant (external_places_enabled OFF); Phase 1
  // resolves to canonical places/cities only.
  address: policy('address', {
    mode: 'canonical_picker',
    // §23/§37: unresolved-address fallbacks (drop pin / nearby / raw).
    allowedSuggestionTypes: ['entity', 'action', 'disambiguation', 'validation'],
    entityTypes: ['place', 'city'],
  }),

  // Catch-all: no aggressive assistance.
  generic_text: policy('generic_text', {
    mode: 'no_assistance',
    allowedSuggestionTypes: [],
    entityTypes: [],
    minChars: 99,
    maxSuggestions: 0,
    offlinePolicy: 'unavailable',
  }),
};

/** All registered contexts (also the §5 union at runtime). */
export const KNOWN_CONTEXTS = Object.keys(REGISTRY) as InputContext[];

export function isKnownContext(value: unknown): value is InputContext {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REGISTRY, value);
}

/**
 * Resolve the default policy for a context. Returns a shallow copy so a caller
 * can override fieldId without mutating the registry. Unknown contexts return
 * null (the caller sends invalid_payload).
 */
export function resolvePolicy(context: InputContext, fieldId?: string): InputFieldPolicy | null {
  const base = REGISTRY[context];
  if (!base) return null;
  return { ...base, fieldId: fieldId && fieldId.length <= 120 ? fieldId : base.fieldId };
}
