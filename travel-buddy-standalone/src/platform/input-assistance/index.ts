/**
 * Global Input Intelligence — public SDK surface (spec §39).
 *
 * The one import site for consumers: `import { SmartInput, registerField, ... }
 * from '@/src/platform/input-assistance'`. Screens should depend on this
 * barrel, not on individual files, so the internal layout can evolve.
 *
 * PHASE 1 (this changeset): types, registry/policy spine, the shared
 * assistance hook + wrappers, and the SmartInput / overlay primitives. NO
 * existing screen consumes this yet — migration is later phases. Nothing here
 * changes existing runtime behavior.
 */

// ── types ────────────────────────────────────────────────────────────────────
export type {
  InputContext,
  AssistanceType,
  EntityType,
  FreshnessState,
  PrivacyClass,
  OfflineInputPolicy,
} from './types/inputContext.ts';
export { INPUT_CONTEXTS } from './types/inputContext.ts';

export type {
  InputFieldPolicy,
  InputAssistanceMode,
  ValidationRule,
  InputTelemetryPolicy,
  InputTelemetryEventName,
} from './types/fieldPolicy.ts';

export type {
  InputSuggestion,
  SuggestRequest,
  SuggestResponse,
  SuggestResult,
  SearchDestination,
  InputSessionContext,
  WritingDraft,
} from './types/inputSuggestion.ts';
export type { SuggestionAction, SuggestionActionType } from './types/suggestionAction.ts';

// ── contexts / registry ──────────────────────────────────────────────────────
export {
  INPUT_CONTEXT_REGISTRY,
  INPUT_POLICY_VERSION,
  getContextDescriptor,
  type InputContextDescriptor,
} from './contexts/inputContexts.ts';
export {
  buildDefaultPolicy,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_SUGGESTIONS,
} from './contexts/inputPolicies.ts';
export {
  registerField,
  registerPolicy,
  isFieldRegistered,
  resolveFieldPolicy,
  unregisterField,
  registeredFieldIds,
} from './contexts/fieldRegistry.ts';

// ── hooks ────────────────────────────────────────────────────────────────────
export {
  useInputAssistance,
  type UseInputAssistanceOptions,
  type UseInputAssistanceResult,
} from './hooks/useInputAssistance.ts';
export { useAutocomplete } from './hooks/useAutocomplete.ts';
export { useEntitySuggestions } from './hooks/useEntitySuggestions.ts';
export { useTextSuggestions } from './hooks/useTextSuggestions.ts';
export {
  useInputValidation,
  type UseInputValidationResult,
  type ValidationStatus,
} from './hooks/useInputValidation.ts';

// ── services ─────────────────────────────────────────────────────────────────
export { requestSuggestions } from './services/inputAssistance.ts';
export { buildSuggestBody } from './services/suggestBody.ts';
export { SuggestionCache, sharedSuggestionCache } from './services/suggestionCache.ts';
export { createSequenceGuard, type SequenceGuard } from './services/raceGuard.ts';
export {
  dedupeSuggestions,
  capSuggestions,
  finalizeSuggestions,
} from './services/suggestionRanking.ts';
export {
  foldForMatch,
  normalizeDisplay,
  resolveLocalAlias,
  isFoldedPrefix,
  matchesGeographicQuery,
} from './services/queryNormalization.ts';
export {
  resolveSuggestion,
  type ResolvedEntity,
} from './services/entityResolution.ts';
export {
  recordSelection,
  getRecentSelections,
  clearRecentSelections,
  type RecentSelection,
} from './services/suggestionHistory.ts';
export {
  emitInputEvent,
  setTelemetrySink,
  resetTelemetrySink,
  type InputTelemetryEvent,
  type TelemetrySink,
} from './services/inputTelemetry.ts';

// ── components ───────────────────────────────────────────────────────────────
export { SmartInput, type SmartInputProps } from './components/SmartInput.tsx';
export { SuggestionOverlay, type SuggestionOverlayProps } from './components/SuggestionOverlay.tsx';
export { SuggestionList, type SuggestionListProps } from './components/SuggestionList.tsx';
export {
  SuggestionGroup,
  groupSuggestions,
  type SuggestionGroupProps,
  type SuggestionSection,
} from './components/SuggestionGroup.tsx';
export { SuggestionChip, type SuggestionChipProps } from './components/SuggestionChip.tsx';
export { EntitySuggestionRow, type EntitySuggestionRowProps } from './components/EntitySuggestionRow.tsx';
export { ActionSuggestionRow, type ActionSuggestionRowProps } from './components/ActionSuggestionRow.tsx';
export { AiSuggestionRow, type AiSuggestionRowProps } from './components/AiSuggestionRow.tsx';
export { CorrectionBanner, type CorrectionBannerProps } from './components/CorrectionBanner.tsx';
export { DisambiguationSheet, type DisambiguationSheetProps } from './components/DisambiguationSheet.tsx';
export { EntityIcon, AssistanceTypeIcon } from './components/entityIcon.tsx';

// ── geographic (Phase 2) ──────────────────────────────────────────────────────
export {
  captureCanonicalBinding,
  bindingToSessionContext,
  placeNeedsCanonicalResolution,
  entityTypeForPlace,
  type CanonicalPlaceBinding,
} from './geographic/canonicalBinding.ts';
export {
  hydrateTripDestination,
  prepareTripDestinationForSave,
  type TripDestinationSavePrep,
} from './geographic/tripDestination.ts';
export {
  suggestionToPlace,
  placeToSuggestion,
  assembleGeoZeroState,
  type GeoZeroStateInputs,
  type PlaceToSuggestionOptions,
} from './geographic/geoSuggestions.ts';
export {
  classifyGeoDisambiguation,
  DEFAULT_GEO_THRESHOLDS,
  type GeoConfidenceTier,
  type GeoDisambiguation,
  type GeoDisambiguationThresholds,
} from './geographic/geoDisambiguation.ts';
export {
  registerGeographicFields,
  GEO_FIELD_IDS,
  GEO_FIELD_CONTEXTS,
  type GeoFieldId,
} from './geographic/geoFields.ts';

// ── global search (Phase 3) ───────────────────────────────────────────────────
export {
  mapSuggestionsToGroups,
  getSubmitQuery,
  isResolvableRow,
  QUERY_GROUP_TYPE,
} from './search/globalSearch.ts';
export {
  registerSearchFields,
  SEARCH_FIELD_IDS,
  SEARCH_FIELD_CONTEXTS,
  type SearchFieldId,
} from './search/searchFields.ts';

// ── social identity (Phase 4) ─────────────────────────────────────────────────
export {
  mapRecipientSuggestions,
  suggestionToRecipient,
  type RecipientRow,
} from './social/telegraphRecipients.ts';
export {
  registerSocialFields,
  SOCIAL_FIELD_IDS,
  SOCIAL_FIELD_CONTEXTS,
  type SocialFieldId,
} from './social/socialFields.ts';
export {
  sanitizeUsername,
  usernameSyntaxError,
  isUsernameCheckable,
  interpretAvailability,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_TOO_SHORT_MESSAGE,
  USERNAME_UNAVAILABLE_MESSAGE,
  type UsernameAvailabilityResult,
  type InterpretedAvailability,
} from './social/usernameValidation.ts';

// ── creation (Phase 5) ────────────────────────────────────────────────────────
export {
  suggestionToDuplicate,
  mapDuplicateCandidates,
  hasLikelyDuplicate,
  duplicateKindsForContext,
  GEM_DUPLICATE_KINDS,
  EVENT_DUPLICATE_KINDS,
  PLACE_DUPLICATE_KINDS,
  type CreationEntityKind,
  type DuplicateCandidate,
  type MapDuplicateOptions,
} from './creation/duplicateDetection.ts';
export {
  suggestionToValidation,
  mapCreationValidation,
  kindFromRule,
  type CreationValidationKind,
  type CreationValidationView,
} from './creation/creationValidation.ts';
export {
  registerCreationFields,
  CREATION_FIELD_IDS,
  CREATION_FIELD_CONTEXTS,
  type CreationFieldId,
} from './creation/creationFields.ts';
export { CreationAssist, type CreationAssistProps } from './creation/CreationAssist.tsx';

// ── compass + AI (Phase 7) ────────────────────────────────────────────────────
export {
  AI_WRITING_CONTEXTS,
  isAiWritingContext,
  isAiTextContext,
  isAiSuggestion,
  toAiWritingProposal,
  mapAiWritingSuggestions,
  partitionCanonicalAndAi,
  orderCanonicalFirst,
  type AiWritingProposal,
} from './compass/aiWriting.ts';
export {
  COMPASS_STARTERS,
  buildCompassStarters,
  isCompassPromptContext,
  type CompassStarter,
  type BuildCompassStartersOptions,
} from './compass/compassPrompt.ts';
export {
  registerCompassFields,
  COMPASS_FIELD_IDS,
  COMPASS_FIELD_CONTEXTS,
  AI_WRITING_FIELD_IDS,
  AI_WRITING_FIELD_CONTEXTS,
  type CompassFieldId,
  type AiWritingFieldId,
} from './compass/compassFields.ts';
export { AiWritingAssist, type AiWritingAssistProps } from './compass/AiWritingAssist.tsx';
export { CompassStarters, type CompassStartersProps } from './compass/CompassStarters.tsx';
