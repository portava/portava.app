/**
 * Global Input Intelligence — useAutocomplete (spec §39).
 *
 * Thin wrapper over `useInputAssistance` for fields that want mixed
 * entity + query-completion typeahead (search boxes, pickers). Filters the
 * stream to the assistance types autocomplete cares about and otherwise defers
 * entirely to the shared hook (debounce/cancel/sequence/SWR live there).
 */
import { useMemo } from 'react';
import type { AssistanceType } from '../types/inputContext.ts';
import { useInputAssistance, type UseInputAssistanceOptions, type UseInputAssistanceResult } from './useInputAssistance.ts';

const AUTOCOMPLETE_TYPES: AssistanceType[] = ['entity', 'completion', 'recent', 'personalized'];

export function useAutocomplete(opts: UseInputAssistanceOptions): UseInputAssistanceResult {
  const base = useInputAssistance(opts);
  const suggestions = useMemo(
    () => base.suggestions.filter((s) => AUTOCOMPLETE_TYPES.includes(s.type)),
    [base.suggestions],
  );
  return { ...base, suggestions };
}
