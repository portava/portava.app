/**
 * §50 — the field inventory. "Inventory every current text field and classify
 * it", recording per field: screen/route, component file, fieldId, InputContext,
 * current implementation, desired mode, entity types, provider/API, zero-state,
 * offline behaviour, privacy class, validation, known issues, migration status.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * Three source files already cited this table as an EXISTING artifact —
 * `social/socialFields.ts`, `search/searchFields.ts` and
 * `creation/creationFields.ts` each say a fieldId "matches the id used in the
 * client audit's §50 field table". A repo-wide search for that table returned
 * only those three references to it. The document was cited, never written, and
 * the citation was load-bearing: it is the reason a reader believes the fieldIds
 * are canonical rather than invented at the call site.
 *
 * ── WHAT IT DOES NOT DUPLICATE, AND WHY ──────────────────────────────────────
 *
 * Four of §50's fifteen attributes are ALREADY declared, per context, in
 * `INPUT_CONTEXT_REGISTRY`: desired mode, entity types, offline policy and
 * privacy class. Copying them here would create a second source of truth that
 * silently rots — exactly the defect `inputPolicyContractParity` exists to catch
 * between client and server. So each record below stores only what the registry
 * CANNOT know (where the field is mounted, what implements it today, which
 * provider it calls, what validates it, what is known to be wrong with it), and
 * {@link fieldInventoryRow} merges the registry's half in at read time. A
 * complete §50 row is the merge, and it cannot disagree with the registry
 * because it is not a copy of it.
 *
 * ── THE FINDING THIS TABLE MAKES VISIBLE ─────────────────────────────────────
 *
 * Of the 24 fieldIds the platform registers, 8 are mounted on a screen. The
 * other 16 are registered by a `register*Fields()` call and reached by nothing:
 * a policy exists, a fieldId exists, and no user can type into it. That is not
 * an accusation — the migration is deliberately staged (§50/§51) — but before
 * this file the ratio was not written down anywhere, and a verdict about "the
 * geographic pickers" read as a statement about the product when it was a
 * statement about eleven unmounted registrations.
 *
 * Pure module — no React, no network — unit-testable under node:test.
 */
import type { InputContext, AssistanceType, EntityType, OfflineInputPolicy, PrivacyClass } from '../types/inputContext.ts';
import type { InputAssistanceMode } from '../types/fieldPolicy.ts';
import { INPUT_CONTEXT_REGISTRY } from './inputContexts.ts';

/**
 * How far a field has travelled along the §50/§51 migration.
 *
 *  - `mounted`               a screen renders it and the gateway serves it.
 *  - `registered_unmounted`  a policy is registered under this fieldId and no
 *                            screen references it. The platform is ready; the
 *                            surface has not been migrated.
 */
export type FieldMigrationStatus = 'mounted' | 'registered_unmounted';

/** The half of a §50 row that the context registry cannot derive. */
export interface FieldInventoryRecord {
  fieldId: string;
  context: InputContext;
  /**
   * The app route the field appears on, or `null` when nothing mounts it.
   * Expo-router path as the user reaches it, not a file path.
   */
  screenRoute: string | null;
  /**
   * Repo-relative path of the file that MOUNTS the field, or — for an unmounted
   * field — the file that registers its policy. Asserted to exist on disk by
   * `fieldInventory.test.ts`, so a rename that orphans a row goes red.
   */
  componentFile: string;
  /** What actually serves this field today, in one line. */
  currentImplementation: string;
  /** The external provider/API behind it, or `null` for Portava-canonical only. */
  provider: string | null;
  /** What the field offers at zero characters (§14). */
  zeroState: string;
  /** What validates the field today (§23), or `null`. */
  validation: string | null;
  /** Known defects/limitations. Empty array means none recorded. */
  knownIssues: string[];
  migrationStatus: FieldMigrationStatus;
}

/** A complete §50 row: the recorded half merged with the registry's half. */
export interface FieldInventoryRow extends FieldInventoryRecord {
  desiredMode: InputAssistanceMode;
  entityTypes: EntityType[];
  allowedSuggestionTypes: AssistanceType[];
  offlinePolicy: OfflineInputPolicy;
  privacyClass: PrivacyClass;
  zeroStateAssistance: boolean;
}

const MOUNTED: FieldMigrationStatus = 'mounted';
const UNMOUNTED: FieldMigrationStatus = 'registered_unmounted';

/**
 * Every fieldId the platform registers, in registration order (search, social,
 * creation, compass, geographic) with the one field a screen registers itself
 * (`wall.session_intent`) last.
 */
export const FIELD_INVENTORY: readonly FieldInventoryRecord[] = [
  {
    fieldId: 'discovery.search',
    context: 'global_search',
    screenRoute: '/search',
    componentFile: 'travel-buddy-standalone/src/hooks/useGlobalSearchSuggestions.ts',
    currentImplementation:
      'useGlobalSearchSuggestions merges the gateway list with the legacy useSearchSuggestions rows and maps them to grouped rows via search/globalSearch.ts.',
    provider: null,
    zeroState: 'The gateway serves §35 selection recents; below minChars the screen shows its own recent-query list.',
    validation: null,
    knownIssues: [
      'The grouped-row bridge renders entity and "SEARCH FOR" rows only; an action row is lifted separately by smartActions and anything else is dropped silently.',
    ],
    migrationStatus: MOUNTED,
  },
  {
    fieldId: 'wall.session_intent',
    context: 'global_search',
    screenRoute: '/(tabs) — Wall header pill',
    componentFile: 'travel-buddy-standalone/src/features/wall/components/WallHeader.tsx',
    currentImplementation: 'SmartInput, the only mount of the SDK primitive itself, registered inline at module load.',
    provider: null,
    zeroState: 'Gateway zero-character recents (global_search allows personalization).',
    validation: null,
    knownIssues: [],
    migrationStatus: MOUNTED,
  },
  {
    fieldId: 'telegraph.recipient',
    context: 'telegraph_recipient',
    screenRoute: '/telegraph/new',
    componentFile: 'travel-buddy-standalone/src/hooks/useTelegraphRecipients.ts',
    currentImplementation: 'useTelegraphRecipients maps gateway user rows to recipients; minChars is overridden to 0 for the zero-state.',
    provider: null,
    zeroState: 'Recent conversations / Trip Crew / followed, served by the gateway at zero characters (§14).',
    validation: null,
    knownIssues: [
      'privacyClass is `viewer_scoped`; before Phase 9 the shared suggestion cache stored these person lists under the typed query like any public field.',
    ],
    migrationStatus: MOUNTED,
  },
  {
    fieldId: 'trip.destination',
    context: 'trip_destination',
    screenRoute: '/trip/new, /trip/edit',
    componentFile: 'travel-buddy-standalone/src/components/selectors/GlobalPlacePicker.tsx',
    currentImplementation: 'GlobalPlacePicker consumes the gateway additively alongside its existing provider search and records the canonical pick.',
    provider: 'Google Places / Nominatim via the picker’s existing search, alongside the canonical registry',
    zeroState: 'Viewer city + active/upcoming Trip destinations (§14/§53 zeroCharGeoDefaults).',
    validation: null,
    knownIssues: [],
    migrationStatus: MOUNTED,
  },
  {
    fieldId: 'trip.title',
    context: 'trip_title',
    screenRoute: '/trip/new',
    componentFile: 'travel-buddy-standalone/app/trip/new.tsx',
    currentImplementation: 'useCreationAssistance for duplicate/validation overlays, plus useAiWritingAssist for the opt-in §22 title proposals.',
    provider: null,
    zeroState: 'None — a creation title has nothing to suggest before the first keystroke.',
    validation: 'Duplicate-trip and date-conflict checks (§23) produced server-side by lib/inputAssistance/creation.ts.',
    knownIssues: ['The AI half is inert on every deployment: compass_ai_writing_enabled is unseeded, and isFlagEnabled is fail-closed.'],
    migrationStatus: MOUNTED,
  },
  {
    fieldId: 'gem.name',
    context: 'hidden_gem_name',
    screenRoute: '/gems/submit',
    componentFile: 'travel-buddy-standalone/app/gems/submit.tsx',
    currentImplementation: 'useCreationAssistance duplicate detection against existing gems and places.',
    provider: null,
    zeroState: 'None.',
    validation: 'Duplicate-entity detection (§23/§55).',
    knownIssues: [],
    migrationStatus: MOUNTED,
  },
  {
    fieldId: 'event.title',
    context: 'event_title',
    screenRoute: '/events/create',
    componentFile: 'travel-buddy-standalone/app/events/create/index.tsx',
    currentImplementation: 'useCreationAssistance duplicate detection against existing events.',
    provider: null,
    zeroState: 'None.',
    validation: 'Duplicate-entity detection (§23/§55).',
    knownIssues: [],
    migrationStatus: MOUNTED,
  },
  {
    fieldId: 'compass.prompt',
    context: 'compass_prompt',
    screenRoute: '/(tabs)/ai',
    componentFile: 'travel-buddy-standalone/app/(tabs)/ai.tsx',
    currentImplementation: 'useAiWritingAssist; the deterministic §56 starters always resolve, the model continuation is flag-gated.',
    provider: 'OpenAI via the existing Compass model path (gpt-5-mini)',
    zeroState: 'Deterministic §56 prompt starters (surface/Trip-aware, no model call).',
    validation: null,
    knownIssues: ['The model half is inert on every deployment: compass_ai_writing_enabled is unseeded.'],
    migrationStatus: MOUNTED,
  },
  {
    fieldId: 'plan.title',
    context: 'plan_title',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/creation/creationFields.ts',
    currentImplementation: 'Registered only. No plan-creation screen references the fieldId.',
    provider: null,
    zeroState: 'None.',
    validation: 'Declared by the creation lane; unreachable while unmounted.',
    knownIssues: ['Registered and unmounted: every creation-assistance verdict about plan titles is vacuous today.'],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'compass.commandbar',
    context: 'compass_prompt',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/compass/compassFields.ts',
    currentImplementation: 'Registered only. The Trip-surface Concierge command bar does not consume the SDK.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: ['Registered and unmounted.'],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'map.askCompass',
    context: 'compass_prompt',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/compass/compassFields.ts',
    currentImplementation: 'Registered only. The map’s "Ask Compass" bar does not consume the SDK.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: ['Registered and unmounted.'],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'post.caption',
    context: 'caption',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/compass/compassFields.ts',
    currentImplementation: 'Registered only. No caption composer consumes the SDK; captions use components/MentionInput.tsx.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: [
      'Registered and unmounted. This is the field whose client/server allowPersonalization disagreement would have transmitted raw caption text; it is latent precisely because nothing mounts it.',
    ],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'event.description',
    context: 'event_description',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/compass/compassFields.ts',
    currentImplementation: 'Registered only. The event description composer does not consume the SDK.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: ['Registered and unmounted.'],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'trip.stop.place',
    context: 'trip_stop_place',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts',
    currentImplementation: 'Registered at boot by registerGeographicFields(), but no screen declares this context, so nothing resolves the policy.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: ['Registered and unmounted: the registrar now runs at boot, but no surface declares this context.'],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'event.location',
    context: 'event_location',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts',
    currentImplementation: 'Registered at boot by registerGeographicFields(), but no screen declares this context, so nothing resolves the policy.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: ['Registered and unmounted: the registrar now runs at boot, but no surface declares this context.'],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'gem.location',
    context: 'hidden_gem_location',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts',
    currentImplementation: 'Registered at boot by registerGeographicFields(), but no screen declares this context, so nothing resolves the policy.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: [
      'Registered and unmounted. Its privacyClass is `sensitive_location`, so it is the one unmounted field whose migration carries a privacy obligation rather than only a UX one.',
    ],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'passport.homebase',
    context: 'passport_homebase',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts',
    currentImplementation: 'Registered at boot by registerGeographicFields(), but no screen declares this context, so nothing resolves the policy.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: ['Registered and unmounted: the registrar now runs at boot, but no surface declares this context.'],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'meetup.location',
    context: 'place_picker',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts',
    currentImplementation: 'Registered at boot by registerGeographicFields(), but no screen declares this context, so nothing resolves the policy.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: ['Registered and unmounted: the registrar now runs at boot, but no surface declares this context.'],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'buddy.service_area',
    context: 'buddy_service_area',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts',
    currentImplementation: 'Registered at boot by registerGeographicFields(), but no screen declares this context, so nothing resolves the policy.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: ['Registered and unmounted: the registrar now runs at boot, but no surface declares this context.'],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'geo.city',
    context: 'city_picker',
    screenRoute: '/(tabs) — Discovery destination bar',
    componentFile: 'travel-buddy-standalone/src/components/discovery/DestinationBar.tsx',
    currentImplementation:
      'DestinationBar declares assistContext="city_picker" and GEO_FIELD_IDS.cityPicker on its GlobalPlacePicker, and app/_layout.tsx calls registerGeographicFields() once at boot, so the picker resolves the registered policy rather than a descriptor default.',
    provider: null,
    zeroState: 'Gateway zero-character recents (city_picker allows personalization and zero-state assistance).',
    validation: null,
    knownIssues: [
      'Wired but not yet observed end to end: no pick made in this surface has been seen landing in input_selection_history and coming back as a recent on a running deployment.',
    ],
    migrationStatus: MOUNTED,
  },
  {
    fieldId: 'geo.country',
    context: 'country_picker',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts',
    currentImplementation: 'Registered at boot by registerGeographicFields(), but no screen declares this context, so nothing resolves the policy.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: [
      'Registered and unmounted. Its offlinePolicy is `static_dictionary` and the client ships no country list, so an offline country picker would return nothing — but nothing can reach it to find out.',
    ],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'geo.neighborhood',
    context: 'neighborhood_picker',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts',
    currentImplementation: 'Registered at boot by registerGeographicFields(), but no screen declares this context, so nothing resolves the policy.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: ['Registered and unmounted: the registrar now runs at boot, but no surface declares this context.'],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'geo.place',
    context: 'place_picker',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts',
    currentImplementation: 'Registered at boot by registerGeographicFields(), but no screen declares this context, so nothing resolves the policy.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: [
      'Registered and unmounted. None of §16’s four place-picker sources (nearby, place recents, Trip places, saved places) exists on either side.',
    ],
    migrationStatus: UNMOUNTED,
  },
  {
    fieldId: 'geo.address',
    context: 'address',
    screenRoute: null,
    componentFile: 'travel-buddy-standalone/src/platform/input-assistance/geographic/geoFields.ts',
    currentImplementation: 'Registered at boot by registerGeographicFields(), but no screen declares this context, so nothing resolves the policy.',
    provider: null,
    zeroState: 'None while unmounted.',
    validation: null,
    knownIssues: ['Registered and unmounted: the registrar now runs at boot, but no surface declares this context.'],
    migrationStatus: UNMOUNTED,
  },
] as const;

/** Index for O(1) lookup. */
const BY_ID = new Map<string, FieldInventoryRecord>(FIELD_INVENTORY.map((r) => [r.fieldId, r]));

/**
 * The complete §50 row for a fieldId: the recorded half merged with the four
 * attributes the context registry owns. Returns `null` for a fieldId this
 * inventory does not record — which is what `fieldInventory.test.ts` refuses to
 * allow for any registered field.
 */
export function fieldInventoryRow(fieldId: string): FieldInventoryRow | null {
  const rec = BY_ID.get(fieldId);
  if (!rec) return null;
  const d = INPUT_CONTEXT_REGISTRY[rec.context];
  return {
    ...rec,
    desiredMode: d.defaultMode,
    entityTypes: d.entityTypes,
    allowedSuggestionTypes: d.allowedSuggestionTypes,
    offlinePolicy: d.offlinePolicy,
    privacyClass: d.privacyClass,
    zeroStateAssistance: d.zeroStateAssistance,
  };
}

/** Every recorded fieldId, in table order. */
export function inventoriedFieldIds(): string[] {
  return FIELD_INVENTORY.map((r) => r.fieldId);
}

/** The fieldIds a screen actually mounts. */
export function mountedFieldIds(): string[] {
  return FIELD_INVENTORY.filter((r) => r.migrationStatus === 'mounted').map((r) => r.fieldId);
}
