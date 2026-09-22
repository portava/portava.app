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
  inputPolicyVersion,
  getContextDescriptor,
  conservativeDescriptor,
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
// ── §48 / G340 — the policy authority ────────────────────────────────────────
export {
  PolicyStore,
  sharedPolicyStore,
  DEFAULT_MAX_AGE_MS,
  type PolicySnapshot,
  type PolicyReadResult,
  type PolicyMissReason,
} from './services/policyStore.ts';
export {
  CONSERVATIVE_POLICY,
  conservativePolicyFor,
  sanitizeServedPolicy,
  offlineSurfaceAllowed,
  UNREACHABLE_MIN_CHARS,
  type ServedContextPolicy,
} from './contexts/policyFallback.ts';
export {
  installInputPolicySync,
  refreshInputPolicies,
} from './services/installInputPolicySync.ts';
export {
  refreshPolicies,
  applyAccountChange,
  type PolicySyncDeps,
  type PolicyRefreshOutcome,
} from './services/policySync.ts';
export { fetchInputPolicies, type PolicyFetchResult } from './services/policyClient.ts';
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
// §32/§34 — the LOCAL tiers. `localZeroState` replays this session's explicit
// accepts (G216); `installLocalRecents` makes that memory survive a restart
// (G199) by binding AsyncStorage to the port in `localRecentsStore.ts`;
// `offlineLocalRows` is the shipped-artifact tier the authority's
// `static_dictionary` / `cached_local` surfaces open onto (G197/G198/G212).
export {
  localZeroState,
  recordLocalSelection,
  mayRetainLocally,
  clearLocalZeroState,
  clearLocalRecents,
  attachLocalRecents,
  detachLocalRecents,
  type LocalZeroStatePolicy,
} from './services/localZeroState.ts';
export { installLocalRecents } from './services/installLocalRecents.ts';
export {
  LOCAL_RECENTS_STORAGE_KEY,
  LOCAL_RECENTS_MAX_AGE_MS,
  type LocalRecentsStorage,
} from './services/localRecentsStore.ts';
export {
  offlineLocalRows,
  localDictionaryFor,
  type LocalDictionaryPolicy,
  type LocalDictionarySource,
} from './services/localDictionary.ts';
export { COUNTRY_DICTIONARY } from './data/countries.ts';
export { CITY_INDEX } from './data/cities.ts';
export { LANGUAGE_DICTIONARY } from './data/languages.ts';
export { INTEREST_DICTIONARY } from './data/interests.ts';
export type { LocalDictionaryEntry } from './data/types.ts';
// Phase 8 (Personalization, §35/§15/§14) — explicit-selection recorder. The pure
// predicate + body builder + fail-soft core (selectBody.ts, node:test-safe) and
// the RN fire-and-forget wiring (selectionRecorder.ts).
export {
  selectionFromSuggestion,
  buildSelectBody,
  recordSelectionWith,
  type SelectRequest,
  type SelectDeps,
  type RecordResult,
} from './services/selectBody.ts';
export {
  recordExplicitSelection,
  recordSuggestionSelection,
} from './services/selectionRecorder.ts';
export {
  emitInputEvent,
  setTelemetrySink,
  resetTelemetrySink,
  type InputTelemetryEvent,
  type TelemetrySink,
} from './services/inputTelemetry.ts';
// §44 TRANSPORT. The batcher is pure and node-testable; the transport is the
// fetch/token wiring. NEITHER is installed by default — starting background
// network traffic is an application decision, and the file that makes it
// (app/_layout.tsx) is outside this layer. One line at bootstrap attaches it:
//   setTelemetrySink(installInputTelemetryTransport().sink)
// Until then the §44 events are still produced and dropped (census G263).
export {
  createTelemetryBatcher,
  newTelemetrySessionId,
  type TelemetryBatch,
  type TelemetryBatcher,
  type TelemetryPoster,
  type WireTelemetryEvent,
} from './services/telemetryBatcher.ts';
export { installInputTelemetryTransport } from './services/telemetryTransport.ts';

// ── components ───────────────────────────────────────────────────────────────
export { SmartInput, type SmartInputProps } from './components/SmartInput.tsx';
export { SuggestionOverlay, type SuggestionOverlayProps } from './components/SuggestionOverlay.tsx';
// §32/§27 — the degraded sentence, exported because a surface that renders its
// own overlay (a bottom sheet, a picker) must be able to say the same three
// things rather than inventing a fourth.
export {
  degradedNotice,
  type DegradedNotice,
  type DegradedNoticeKind,
  type DegradedNoticeParams,
} from './components/degradedNotice.ts';
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
  startersFromSuggestions,
  isCompassPromptContext,
  type CompassStarter,
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

// ── voice intake (census-wall W71) ────────────────────────────────────────────
// W71: "Voice input and typo normalization use the same global engine." The
// typo half is proven at the Wall; this is the voice half's provider-independent
// seam — a transcript becomes the SAME request typed text becomes, through the
// SAME gateway entry point. NO speech-to-text provider is bound: the port's
// default reports unavailable and never fabricates a transcript. A device build
// installs one at bootstrap with `installTranscriptionPort(...)`.
export {
  VOICE_INTAKE_STATES,
  MIN_TRANSCRIPT_CONFIDENCE,
  type TranscriptionResult,
  type VoiceIntakeState,
  type VoiceRefusalReason,
  type VoiceUnavailableReason,
} from './voice/types.ts';
export {
  NO_TRANSCRIPTION_PROVIDER,
  installTranscriptionPort,
  clearTranscriptionPort,
  installedTranscriptionPort,
  resolveTranscriptionPort,
  isVoiceInputAvailable,
  type AudioCapturePort,
  type CapturedAudio,
  type TranscriptionPort,
  type TranscriptionRequest,
  type TranscriptionOutcome,
} from './voice/transcriptionPort.ts';
export {
  assistanceRequestFor,
  voiceIntakeRequest,
  submitVoiceIntake,
  voiceIntakeFromCapture,
  type SuggestSubmitter,
  type VoiceIntakeOptions,
  type VoiceIntakeOutcome,
  type VoiceIntakeDeps,
  type VoiceSubmission,
} from './voice/voiceIntake.ts';
