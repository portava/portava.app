/**
 * useAiWritingAssist — Phase 7 (Compass + AI) opt-in writing wiring (§22, §56).
 *
 * Sources the gateway's OPT-IN AI writing proposals for a writing field (caption /
 * event title+description / trip+plan title) or the compass prompt (continuation)
 * from the P1 gateway via `useInputAssistance`, and projects them into the
 * provenance-marked, tap-to-insert `AiWritingProposal[]` the `AiWritingAssist`
 * component renders.
 *
 * DOUBLE-GATED OPT-IN (§22):
 *   1. `optedIn` — the user's explicit gesture (e.g. tapping "Suggest with AI").
 *      Only then is `aiAssist:true` sent; before that NO AI request is made.
 *   2. The backend's `compass_ai_writing_enabled` flag (OFF by default) — when it
 *      is off the gateway returns no `ai_suggestion` rows, so `proposals` is `[]`
 *      and the field behaves exactly as before (§38 degrade). Never throws.
 *
 * NOTHING here inserts or submits text — it only produces the proposal list; the
 * user taps a proposal and the screen places its editable text into the field.
 */
import { useMemo } from 'react';
import { useInputAssistance } from '../platform/input-assistance/hooks/useInputAssistance.ts';
import {
  mapAiWritingSuggestions,
  type AiWritingProposal,
} from '../platform/input-assistance/compass/aiWriting.ts';
import { registerCompassFields } from '../platform/input-assistance/compass/compassFields.ts';
import type { InputContext } from '../platform/input-assistance/types/inputContext.ts';
import type {
  InputSessionContext,
  WritingDraft,
} from '../platform/input-assistance/types/inputSuggestion.ts';

// Register the compass + phase-7 writing fields once at module load (idempotent).
registerCompassFields();

export interface UseAiWritingAssistOpts {
  /** The AI-text InputContext (e.g. 'caption', 'trip_title', 'compass_prompt'). */
  context: InputContext;
  /** The registered fieldId (e.g. 'post.caption', 'compass.prompt'). */
  fieldId: string;
  /** Current field text (the seed the model refines / continues). */
  text: string;
  /**
   * The user's explicit opt-in. Until true, NO AI request is made at all — this
   * is the client half of the §22 double gate.
   */
  optedIn: boolean;
  /** Bounded task/session context forwarded to the gateway (§16, §41). */
  sessionContext?: InputSessionContext;
  /** Coarse city-level context for AI writing / compass refs (§29, no coordinates). */
  city?: string | null;
  /** Coarse creation draft for AI writing / compass refs (§29, no coordinates). */
  draft?: WritingDraft;
  /** IANA timezone for temporal phrasing (optional). */
  tz?: string | null;
  /** Extra enable gate (combined with optedIn). Default true. */
  enabled?: boolean;
  /** Minimum trimmed length before requesting (default 1 — the gateway needs q≥1). */
  minChars?: number;
}

export interface AiWritingAssistResult {
  /** Opt-in AI proposals (empty when not opted in / flag off / unavailable). */
  proposals: AiWritingProposal[];
  loading: boolean;
  /** True when the endpoint is unavailable (404/offline) — degrade silently. */
  unavailable: boolean;
}

export function useAiWritingAssist(opts: UseAiWritingAssistOpts): AiWritingAssistResult {
  const {
    context,
    fieldId,
    text,
    optedIn,
    sessionContext,
    city,
    draft,
    tz,
    enabled = true,
    minChars = 1,
  } = opts;

  const active = optedIn && enabled && text.trim().length >= minChars;

  const gateway = useInputAssistance({
    fieldId,
    context,
    text,
    sessionContext,
    // §22 — aiAssist is sent ONLY when the user has actively opted in.
    aiAssist: active ? true : undefined,
    city: active ? city : undefined,
    draft: active ? draft : undefined,
    tz: active ? tz : undefined,
    enabled: active,
  });

  const proposals = useMemo(
    () => mapAiWritingSuggestions(gateway.suggestions),
    [gateway.suggestions],
  );

  return {
    proposals,
    loading: gateway.loading,
    unavailable: gateway.unavailable,
  };
}
