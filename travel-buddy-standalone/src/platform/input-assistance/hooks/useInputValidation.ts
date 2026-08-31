/**
 * Global Input Intelligence — useInputValidation (spec §23, §39).
 *
 * Non-blocking validation + correction while typing. Per the validation table
 * (§23): username unavailable → immediate non-blocking state + alternatives;
 * duplicate Place/Gem → show probable existing entity before allowing creation;
 * city/country mismatch → suggest canonical correction. Validation must NEVER
 * block the field (§2 preserve user control).
 *
 * Phase 1 surfaces server-driven `validation` + `correction` suggestions from
 * the shared assistance stream and exposes them as a single validation state.
 * Client-side rule resolvers (per `policy.validationRules`) are wired in a later
 * phase (5: Creation) — the extension point is marked below. The hook already
 * degrades gracefully: no endpoint → `idle`, never an error.
 */
import { useMemo } from 'react';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { useInputAssistance, type UseInputAssistanceOptions } from './useInputAssistance.ts';

export type ValidationStatus = 'idle' | 'checking' | 'valid' | 'warning' | 'invalid';

export interface UseInputValidationResult {
  status: ValidationStatus;
  /** Human-readable message for the current state, when any. */
  message?: string;
  /** A correction suggestion ("Did you mean Phu Quoc?") when present (§23). */
  correction?: InputSuggestion;
  /** A likely-duplicate / disambiguation entity to prefer over creation (§20, §55). */
  duplicate?: InputSuggestion;
}

export function useInputValidation(opts: UseInputAssistanceOptions): UseInputValidationResult {
  const base = useInputAssistance(opts);

  return useMemo<UseInputValidationResult>(() => {
    if (base.loading) return { status: 'checking' };

    const correction = base.suggestions.find((s) => s.type === 'correction');
    const validation = base.suggestions.find((s) => s.type === 'validation');
    const duplicate = base.suggestions.find((s) => s.type === 'disambiguation');

    // A validation suggestion whose confidence is low (or that carries no
    // replacement) is a "warning"; one that blocks (e.g. taken username) is
    // surfaced as "invalid". The server projection sets confidence/reason.
    if (validation) {
      const invalid = (validation.confidence ?? 0) >= 0.9;
      return {
        status: invalid ? 'invalid' : 'warning',
        message: validation.reason ?? validation.subtitle ?? validation.label,
        correction,
        duplicate,
      };
    }
    if (correction) {
      return { status: 'warning', message: correction.label, correction, duplicate };
    }
    if (duplicate) {
      return { status: 'warning', message: duplicate.subtitle ?? duplicate.label, duplicate };
    }

    // Phase 5 extension point: run policy.validationRules with client resolvers
    // (username availability, duplicate detection) here and fold their results
    // into this state. Until then, "no signal" == idle (never blocks the field).
    return { status: 'idle' };
  }, [base.loading, base.suggestions]);
}
