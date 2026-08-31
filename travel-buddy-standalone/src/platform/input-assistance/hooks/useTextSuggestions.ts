/**
 * Global Input Intelligence — useTextSuggestions (spec §39, §22, §26).
 *
 * Thin wrapper over `useInputAssistance` for free-text-assisted fields
 * (captions, comments, titles): completions, optional AI suggestions, and
 * @mention/#hashtag entity insertions (§26). AI suggestions are only surfaced
 * when the field's policy allows AI (§22 opt-in) — the shared hook already
 * carries the policy, so this wrapper just narrows the visible types and
 * enforces the AI opt-in at the presentation edge.
 */
import { useMemo } from 'react';
import type { AssistanceType } from '../types/inputContext.ts';
import { useInputAssistance, type UseInputAssistanceOptions, type UseInputAssistanceResult } from './useInputAssistance.ts';

const TEXT_TYPES: AssistanceType[] = ['completion', 'entity', 'ai_suggestion'];

export function useTextSuggestions(opts: UseInputAssistanceOptions): UseInputAssistanceResult {
  const base = useInputAssistance(opts);
  const allowAI = base.policy?.allowAI ?? false;
  const suggestions = useMemo(
    () =>
      base.suggestions.filter(
        (s) => TEXT_TYPES.includes(s.type) && (s.type !== 'ai_suggestion' || allowAI),
      ),
    [base.suggestions, allowAI],
  );
  return { ...base, suggestions };
}
