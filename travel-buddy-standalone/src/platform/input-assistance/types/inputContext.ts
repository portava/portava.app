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
  | 'interest'
  // ── 2026-09-21 — the five the AUTHORITY can serve that this side could not
  // name. `GET /input-assistance/policies` returns `entityTypes` straight from
  // the server registry, and four of these appear in what it serves today:
  // `activity` (plan_title, buddy_service), `circle`/`post`/`stamp`
  // (global_search). Without them a fetched policy carries members outside
  // this union. `vibe` is declared there and served in no context yet; it is
  // included so the union is the authority's whole set rather than the subset
  // that happens to be in use, which would drift again on the next server
  // change.
  | 'activity'
  | 'circle'
  | 'post'
  | 'stamp'
  | 'vibe';

/**
 * §8/§31 — Freshness / Live Intelligence state carried by a suggestion.
 *
 * The server (the P9 LiveSuggestionService) attaches this ONLY when a real,
 * gated live claim backs the entity; it is ABSENT otherwise (the common,
 * pre-launch case). The shape mirrors the server contract
 * (api-server lib/inputAssistance/types.ts `FreshnessState`) VERBATIM so the SDK
 * stays a PURE renderer: the client echoes `label` and `updatedAtLabel` exactly
 * as sent and NEVER synthesizes a live label from `state` or anything else
 * (Principle §2 / §31 anti-fabrication). If `stale`/`unavailable`, the state
 * label is removed and at most the last-updated age is shown — never "busy now".
 */
export interface FreshnessState {
  /**
   * Live-state band. `fresh`/`recently_confirmed` carry a real, current claim;
   * `stale`/`unavailable` never present as live (label dropped, last-updated only).
   */
  state: 'fresh' | 'recently_confirmed' | 'stale' | 'unavailable';
  /** Server-formatted "Updated 4m ago" age. Absent when not servable. */
  updatedAtLabel?: string;
  /** Server current-state/trend label ("Getting busier"). Only from real live data. */
  label?: string;
}

/**
 * §29 — Privacy classification of the field's content. Drives telemetry
 * (private_message never logs raw text, §44) and projection eligibility.
 */
/**
 * §6 `privacyClass` — the field's privacy posture.
 *
 * THIS UNION IS THE SERVER'S, VERBATIM (`lib/inputAssistance/types.ts`), and it
 * did not used to be. The client declared a DIFFERENT four-member taxonomy
 * (`public | personal | sensitive | private_message`) of which only two members
 * were shared with the server's five, so the two sides could not be compared at
 * all — and this value is not decorative on either of them:
 *
 *   - it decides whether a field's suggestions may enter the shared suggestion
 *     cache (`services/suggestionCache.ts`);
 *   - it decides whether a selection payload carrying the user's raw typed text
 *     may be SENT (`services/selectBody.ts`);
 *   - it derives the field's telemetry policy (`contexts/inputPolicies.ts`);
 *   - and, on the server, it is a fail-closed gate on the selection-memory
 *     write (`lib/inputAssistance/personalization.ts`).
 *
 * With two vocabularies a server policy change could not reach any of them.
 * `test/inputPolicyContractParity.test.ts` now pins the two registries value
 * for value, and where the two sides disagreed the STRICTER classification won
 * on both — `hidden_gem_name` and `comment` were `public` here while the server
 * called them sensitive/viewer-scoped, which is the direction that leaks.
 */
export type PrivacyClass =
  | 'public'
  | 'viewer_scoped'
  | 'owner_only'
  | 'sensitive_location'
  | 'private_message';

/**
 * §32 — How the field degrades offline. Live intelligence is NEVER represented
 * as live when offline; that rule is enforced in code, not expressible here.
 *
 * ── 2026-09-21: THIS UNION IS NOW THE SERVER'S, MEMBER FOR MEMBER ───────────
 *
 * It used to be `static_dictionary | cached_entities | recent_only | none`.
 * `inputPolicyContractParity.test.ts` had recorded that the two sides differed
 * on 26 of 29 contexts and excused it: the client's was "a different,
 * device-side vocabulary", so pinning it "would freeze that debt instead of
 * describing it".
 *
 * Measured rather than assumed, that excuse did not hold. Of the 29:
 *   •  7 were a pure RENAME (`cached_entities` ⇄ `cached_local`, and the three
 *      `static_dictionary` contexts, which already agreed);
 *   • 12 were this side COLLAPSING a distinction the authority draws — `none`
 *      standing in for both `server_required` (the field IS assisted, but only
 *      with a network) and `unavailable` (never assisted at all);
 *   • 10 were a GENUINE disagreement, and 9 of those ran the same way: this
 *      side claimed it could serve suggestions offline (`cached_entities` /
 *      `recent_only`) for a field the authority marks `server_required` —
 *      place_picker, trip_stop_place, event_location, hidden_gem_location,
 *      buddy_service_area, address, hashtag, telegraph_recipient,
 *      telegraph_message. global_search was the only one running the other
 *      way (`recent_only` here, `cached_local` there).
 *
 * So it was one taxonomy with a renamed member, a lost distinction, and nine
 * over-claims — not a second vocabulary. NOTHING on this side branches on the
 * field today (it is declared, carried into `InputFieldPolicy`, and described
 * in `fieldInventory.ts`, and read by no branch), so none of that was ever
 * live. That is the same "latent only because nothing consumes it" shape as
 * the `allowPersonalization` and `privacyClass` findings, and the same reason
 * to fix it while it is still cheap: G340's `GET /input-assistance/policies`
 * now SERVES this field, so the next reader gets the authority's value whether
 * or not this union can name it.
 */
export type OfflineInputPolicy =
  | 'static_dictionary' // countries / languages / interests — local static list
  | 'cached_local' // cities / saved / trip-scoped — cached subset (was `cached_entities`)
  | 'recent_only' // device-local recents only
  | 'server_required' // assisted, but only with a network — no offline surface
  | 'unavailable'; // not assisted at all, offline or on
