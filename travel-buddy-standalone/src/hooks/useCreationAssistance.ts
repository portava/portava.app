/**
 * useCreationAssistance — Phase 5 (Creation) creation-flow wiring (§20, §23, §55).
 *
 * Sources inline creation intelligence for a Hidden Gem / Event / Place / Trip /
 * Plan creation field from the P1 gateway (a creation `InputContext` via
 * `useInputAssistance`) and projects it into the two NON-BLOCKING overlays the
 * `CreationAssist` component renders:
 *   - `duplicates`  — likely-existing Gem/Place/Event candidates so the user can
 *     confirm the intended entity rather than mint a duplicate (§20/§55).
 *   - `validation`  — a single §23 validation/correction (duplicate warning,
 *     city-country mismatch, date conflict, unresolved address, invalid
 *     hashtag/handle) for the shared `CorrectionBanner`.
 *
 * DEGRADE GRACEFULLY (§38): the P5 dedup/validation endpoint ships in a PARALLEL
 * backend PR and may not be deployed yet. When it is absent (404/offline) the
 * gateway reports `unavailable` and returns nothing → `duplicates: []`,
 * `validation: null`. The creation flow then behaves exactly as today: no notice,
 * no dedup, and it NEVER throws. It also never blocks or changes submit.
 */
import { useMemo } from 'react';
import { useInputAssistance } from '../platform/input-assistance/hooks/useInputAssistance.ts';
import {
  mapDuplicateCandidates,
  duplicateKindsForContext,
  type CreationEntityKind,
  type DuplicateCandidate,
} from '../platform/input-assistance/creation/duplicateDetection.ts';
import {
  mapCreationValidation,
  type CreationValidationView,
} from '../platform/input-assistance/creation/creationValidation.ts';
import { registerCreationFields } from '../platform/input-assistance/creation/creationFields.ts';
import type { InputContext } from '../platform/input-assistance/types/inputContext.ts';
import type { InputSessionContext } from '../platform/input-assistance/types/inputSuggestion.ts';

// Register the creation fields' policies once at module load (idempotent, §5/§52).
registerCreationFields();

export interface UseCreationAssistanceOpts {
  /** The creation InputContext (e.g. 'hidden_gem_name', 'event_title'). */
  context: InputContext;
  /** The registered fieldId (e.g. 'gem.name'). Used for policy + cache + telemetry. */
  fieldId: string;
  /** Current field text (the name/title being typed). */
  text: string;
  /**
   * Entity kinds to accept as duplicates. Defaults to the context's set
   * (gem → Gem/Place, event → Event/Place). Pass to narrow/override.
   */
  allowedKinds?: readonly CreationEntityKind[];
  /** Bounded task/session context forwarded to the gateway (§16, §41). */
  sessionContext?: InputSessionContext;
  /** Max duplicate candidates to surface (default 5). */
  limit?: number;
  /** Master switch — false clears results and stops all fetching. */
  enabled?: boolean;
}

export interface CreationAssistanceResult {
  /** Likely-existing candidates (§20/§55). Empty when none / unavailable. */
  duplicates: DuplicateCandidate[];
  /** The §23 validation/correction to surface, or null (degrade → no banner). */
  validation: CreationValidationView | null;
  loading: boolean;
  /** True when the creation endpoint is unavailable (404/offline) — degrade silently. */
  unavailable: boolean;
}

export function useCreationAssistance(opts: UseCreationAssistanceOpts): CreationAssistanceResult {
  const { context, fieldId, text, allowedKinds, sessionContext, limit, enabled = true } = opts;

  const gateway = useInputAssistance({
    fieldId,
    context,
    text,
    sessionContext,
    enabled,
  });

  const kinds = allowedKinds ?? duplicateKindsForContext(context);

  const duplicates = useMemo(
    () => mapDuplicateCandidates(gateway.suggestions, { allowedKinds: kinds, limit }),
    [gateway.suggestions, kinds, limit],
  );

  const validation = useMemo(
    () => mapCreationValidation(gateway.suggestions),
    [gateway.suggestions],
  );

  return {
    duplicates,
    validation,
    loading: gateway.loading,
    unavailable: gateway.unavailable,
  };
}
