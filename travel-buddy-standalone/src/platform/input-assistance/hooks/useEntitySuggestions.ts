/**
 * Global Input Intelligence — useEntitySuggestions (spec §39, §11).
 *
 * Thin wrapper over `useInputAssistance` for canonical-picker + mention fields
 * that only want resolved ENTITY suggestions (§11 "resolve to canonical
 * entities, not strings"). Disambiguation rows are included since they are the
 * entity-choice surface (§19). Everything else (debounce/cancel/SWR) is the
 * shared hook's job.
 */
import { useMemo } from 'react';
import type { AssistanceType } from '../types/inputContext.ts';
import { useInputAssistance, type UseInputAssistanceOptions, type UseInputAssistanceResult } from './useInputAssistance.ts';

const ENTITY_TYPES: AssistanceType[] = ['entity', 'recent', 'personalized', 'disambiguation'];

export function useEntitySuggestions(opts: UseInputAssistanceOptions): UseInputAssistanceResult {
  const base = useInputAssistance(opts);
  const suggestions = useMemo(
    () => base.suggestions.filter((s) => ENTITY_TYPES.includes(s.type)),
    [base.suggestions],
  );
  return { ...base, suggestions };
}
