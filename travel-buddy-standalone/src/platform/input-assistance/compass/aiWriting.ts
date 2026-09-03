/**
 * Global Input Intelligence — Phase 7 (Compass + AI): the AI-assisted writing
 * projection (spec §22, §8, §2/§9).
 *
 * The backend gateway returns an AI-writing row as an `InputSuggestion` with
 * `type:'ai_suggestion'`, `source:'ai'`, and an editable `replace_text` action —
 * a PROPOSAL, never a committed value. This module maps those rows into the
 * client's `AiWritingProposal` view-model that the UI renders as an OPT-IN,
 * tap-to-insert affordance.
 *
 * HARD INVARIANTS mirrored here (do not weaken):
 *   §22  A proposal is NEVER auto-applied and NEVER auto-submitted. There is
 *        deliberately NO `autoApply`/`commit` field on `AiWritingProposal` — the
 *        only path from a proposal to the field is the consumer calling
 *        `onInsert` in response to a user tap, into an EDITABLE field.
 *   §8   Provenance-marked: every proposal carries `provenance:'ai'`, sourced
 *        from `source:'ai'`. A row that is not `ai_suggestion`/`source:'ai'` is
 *        NOT lifted (returns null) — canonical rows never masquerade as AI.
 *   §2/§9 SECONDARY to canonical: `orderCanonicalFirst` keeps AI rows AFTER every
 *        canonical suggestion, so a real entity/completion always outranks AI.
 *   §38  Degrade: no AI rows (flag off / 404 / empty) ⇒ `[]`, never a throw.
 *
 * Pure module (no React, no network) — unit-testable under node:test.
 */
import type { InputContext } from '../types/inputContext.ts';
import type { InputSuggestion } from '../types/inputSuggestion.ts';

/**
 * §22 allowed-use writing contexts — the client mirror of the backend's
 * `AI_WRITING_CONTEXTS`. `compass_prompt` is intentionally NOT in this set: it
 * is an AI-TEXT context handled by the compass-prompt surface (continuation),
 * and it also carries deterministic starters produced without the AI flag.
 */
export const AI_WRITING_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'caption',
  'event_title',
  'event_description',
  'trip_title',
  'plan_title',
]);

/** True when the context is one of the §22 allowed-use writing fields. */
export function isAiWritingContext(context: InputContext): boolean {
  return AI_WRITING_CONTEXTS.has(context);
}

/** True when the context can carry an AI text proposal (writing fields + compass). */
export function isAiTextContext(context: InputContext): boolean {
  return isAiWritingContext(context) || context === 'compass_prompt';
}

/**
 * The UI view-model for one opt-in AI writing proposal (§22). Intentionally has
 * NO "apply automatically" field — `insertText` is placed into the field ONLY
 * when the consumer handles a user tap. `provenance` is fixed to 'ai' so the row
 * is always shown as AI-suggested.
 */
export interface AiWritingProposal {
  id: string;
  /** The suggested text to DISPLAY (what the model proposed). */
  text: string;
  /** The text to place into the editable field when the user taps (§22). */
  insertText: string;
  /** §8 provenance — always 'ai' for these proposals. */
  provenance: 'ai';
  /** "Why this is suggested" (§28), e.g. "AI-suggested draft". */
  reason?: string;
  /** Deliberately-low confidence carried through from the gateway (§9). */
  confidence?: number;
  /** §56 coarse structured refs a compass_prompt proposal carries, if any. */
  structuredValue?: unknown;
  /** The originating suggestion — for telemetry / the §43 action the consumer dispatches. */
  suggestion: InputSuggestion;
}

/** Extract the editable insertion text for an ai_suggestion, or '' when absent. */
function insertTextOf(s: InputSuggestion): string {
  if (typeof s.replacementText === 'string' && s.replacementText.trim().length > 0) {
    return s.replacementText;
  }
  const a = s.action;
  if (a && a.type === 'replace_text' && typeof a.text === 'string' && a.text.trim().length > 0) {
    return a.text;
  }
  if (typeof s.label === 'string' && s.label.trim().length > 0) return s.label;
  return '';
}

/**
 * Map one suggestion to an `AiWritingProposal`, or null when it is not a
 * provenance-marked AI writing row (`type:'ai_suggestion'` AND `source:'ai'`) or
 * carries no insertable text. A null result is DROPPED by `mapAiWritingSuggestions`
 * — a canonical row is never surfaced as an AI proposal, and an AI row with
 * nothing to insert is never a dead affordance.
 */
export function toAiWritingProposal(s: InputSuggestion | null | undefined): AiWritingProposal | null {
  if (!s || s.type !== 'ai_suggestion' || s.source !== 'ai') return null;
  const insertText = insertTextOf(s);
  if (!insertText) return null;
  return {
    id: s.id,
    text: s.label ?? insertText,
    insertText,
    provenance: 'ai',
    reason: s.reason,
    confidence: s.confidence,
    structuredValue: s.structuredValue,
    suggestion: s,
  };
}

/**
 * Map a gateway suggestion list to the opt-in AI writing proposals only. Non-AI
 * rows are dropped. Tolerant of a nullish list; never throws. Empty in ⇒ empty
 * out (the §38 degrade path: nothing extra renders when the flag is off).
 */
export function mapAiWritingSuggestions(
  suggestions: InputSuggestion[] | null | undefined,
): AiWritingProposal[] {
  const out: AiWritingProposal[] = [];
  for (const s of suggestions ?? []) {
    const p = toAiWritingProposal(s);
    if (p) out.push(p);
  }
  return out;
}

/** True when a suggestion is a provenance-marked AI row (§8). */
export function isAiSuggestion(s: InputSuggestion): boolean {
  return s.type === 'ai_suggestion' && s.source === 'ai';
}

/**
 * Split a mixed list into canonical (everything that is not an AI row) and AI
 * rows, preserving the server order within each partition.
 */
export function partitionCanonicalAndAi(
  suggestions: InputSuggestion[] | null | undefined,
): { canonical: InputSuggestion[]; ai: InputSuggestion[] } {
  const canonical: InputSuggestion[] = [];
  const ai: InputSuggestion[] = [];
  for (const s of suggestions ?? []) {
    (isAiSuggestion(s) ? ai : canonical).push(s);
  }
  return { canonical, ai };
}

/**
 * Return the list with every canonical suggestion BEFORE every AI suggestion
 * (§2/§9 — AI is secondary). The server already sorts AI last; this is the
 * client-side belt-and-suspenders guarantee, stable within each partition.
 */
export function orderCanonicalFirst(
  suggestions: InputSuggestion[] | null | undefined,
): InputSuggestion[] {
  const { canonical, ai } = partitionCanonicalAndAi(suggestions);
  return [...canonical, ...ai];
}
