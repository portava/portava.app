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
//
// WHY THIS LIST GREW. Until the serve log existed (migration 2950 +
// lib/inputAssistance/telemetry.ts) this list was DECLARATIVE ONLY — census G33
// records that `telemetryPolicy` is enforced on the client and read by nothing
// on the server. It named five of the fourteen §44 event names, which was
// harmless while nothing consulted it.
//
// It is now load-bearing: POST /input-assistance/telemetry REFUSES an event a
// field's policy does not declare. Left at five, that gate would have silently
// discarded nine of the funnel arms SmartInput actually emits — the ignored
// arm, the edited arm, the validation impression and both §19/§10 acceptance
// events — which is the defect this build exists to close, reintroduced one
// layer down. So a standard field now declares the funnel it participates in.
//
// `downstream_task_completed` and `action_completed` are deliberately INCLUDED:
// both are emitted by a feature screen rather than by SmartInput, and a policy
// that refused them would make the outcome arm unreachable before its caller is
// ever written.
//
// The NARROW list below (METADATA_ONLY_TELEMETRY) is what a private-message
// field gets, and it is unchanged. That contrast is the point of the mechanism.
const STANDARD_TELEMETRY: InputTelemetryPolicy = {
  logRawText: false,
  events: [
    'input_opened',
    'query_length_changed',
    'suggestion_request_started',
    'suggestion_request_completed',
    'suggestion_rendered',
    'suggestion_selected',
    'suggestion_dismissed',
    'raw_search_submitted',
    'manual_value_kept',
    'validation_shown',
    'correction_accepted',
    'disambiguation_selected',
    'action_completed',
    'downstream_task_completed',
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
    // §10: `validation` carries the "emoji/symbols cannot be tagged" answer so
    // an unsupported tag body is stated rather than silently producing nothing.
    allowedSuggestionTypes: ['entity', 'completion', 'validation'],
    entityTypes: ['hashtag'],
    minChars: 1,
  }),
  caption: policy('caption', {
    mode: 'free_text_assisted',
    allowedSuggestionTypes: ['entity', 'ai_suggestion', 'validation'],
    entityTypes: ['hashtag', 'user', 'place'],
    allowAI: true,
    minChars: 1,
  }),
  comment: policy('comment', {
    mode: 'free_text_assisted',
    allowedSuggestionTypes: ['entity', 'validation'],
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

// ── §48 parity: the privacy classes this registry RAISES (census G31) ─────────
//
// Eight contexts were classed `public` here while the client registry — whose
// copy of this member gates the shared suggestion cache, the select payload and
// the derived telemetry policy — classed them personal or sensitive. The two
// sides ran on different four- and five-member vocabularies, so nothing had
// ever compared them; when they were compared, 14 of 29 disagreed. The rule
// applied was STRICTER-SIDE-WINS in both directions, never looser, and these
// are the eight where the client was the stricter one.
//
// APPLIED AS A TABLE RATHER THAN EDITED INTO THE SEEDS ABOVE, for two reasons
// worth stating because the shape looks unusual:
//
//   1. It is the whole of the raise, auditable in one place against the client
//      registry it mirrors, instead of eight `privacyClass:` lines scattered
//      through 300 lines of unrelated policy.
//   2. Every line number above keeps pointing at what it pointed at. A dozen
//      rows of `docs/architecture/census-input-intelligence.md` cite this file
//      by line, and inserting eight lines through the middle of it would have
//      silently repointed all of them — the exact defect §12.4 of that document
//      records ("five pointers into useInputAssistance.ts were already wrong …
//      a citation that resolves is not a citation that is right").
//
// `artifacts/api-server/src/test/inputPolicyContractParity.test.ts` asserts the
// RESULT — this registry and the client's must agree, context for context — so
// this table cannot drift from the thing it exists to match.
const PRIVACY_CLASS_PARITY_RAISES: Partial<Record<InputContext, PrivacyClass>> = {
  trip_title: 'viewer_scoped',
  plan_title: 'viewer_scoped',
  compass_prompt: 'viewer_scoped',
  passport_homebase: 'viewer_scoped',
  language: 'viewer_scoped',
  interest: 'viewer_scoped',
  generic_text: 'viewer_scoped',
  address: 'sensitive_location',
};

for (const [context, privacyClass] of Object.entries(PRIVACY_CLASS_PARITY_RAISES)) {
  const entry = REGISTRY[context as InputContext];
  if (entry) entry.privacyClass = privacyClass as PrivacyClass;
}
