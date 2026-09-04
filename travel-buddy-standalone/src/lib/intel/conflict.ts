/**
 * Intelligence Gathering — §10 material-conflict state (client mirror of
 * api-server `lib/intelConflict.ts`), PURE.
 *
 * The server assesses the conflict (two independent sides, distant values,
 * overlapping observation windows) and serves it on every live-claim envelope
 * as `conflictState` plus a counts-only `conflict` block. The client never
 * re-derives it — it only has to do three honest things with it:
 *
 *   1. never render a strong Live label for a 'material' claim (the server has
 *      already capped the band/state; `liveState` in display.ts enforces it
 *      again so a stale or hand-built claim cannot slip through);
 *   2. say "Reports differ" wherever a Live label would have rendered;
 *   3. offer the contradiction-resolution opportunity — a re-ask of the SAME
 *      claim family — but only where a prompt may be shown at all
 *      (useIntelPrompts' pause / Safe-Return / flag suppression is respected).
 *
 * RUNTIME EFFECT: NONE — data + pure functions.
 */
import type { QuickSignalContext } from './contracts.ts';

export const CONFLICT_STATES = ['none', 'minor', 'material'] as const;
export type ConflictState = (typeof CONFLICT_STATES)[number];

/**
 * Mirror of the server's normaliser. NULL / '' / 'none' ⇒ none; the spec's
 * 'contextualized' is the same middle state as 'minor'; anything else that is
 * non-empty reads as MATERIAL — an unrecognised conflict marker must suppress
 * the strong label rather than be ignored (fail-closed for the Live label).
 */
export function normalizeConflictState(raw: unknown): ConflictState {
  if (raw == null) return 'none';
  if (typeof raw !== 'string') return 'material';
  const s = raw.trim().toLowerCase();
  if (s === '' || s === 'none') return 'none';
  if (s === 'minor' || s === 'contextualized') return 'minor';
  return 'material';
}

/** The counts-only block the wire carries next to `conflictState`. */
export interface ConflictBlockDTO {
  state: ConflictState;
  sidesCount: number;
  lastUpdated: string;
}

/** The label that replaces a Live label under a material conflict (spec §10). */
export const CONFLICT_LABEL = 'Reports differ';

/** One-line "why" for the sheet. */
export function conflictExplanation(state: ConflictState): string | null {
  if (state === 'material') {
    return 'Recent reports from independent travelers disagree about this right now, so we’re not showing it as Live until it settles. What you see can help.';
  }
  if (state === 'minor') {
    return 'Reports vary a little here right now — close enough to show, but treat it as a range.';
  }
  return null;
}

/**
 * Which Quick Signal context re-asks a claim FAMILY. The contradiction-
 * resolution prompt must ask the same question the conflict is about (§10
 * "create a contradiction-resolution opportunity"), so only families with a
 * direct §6 context are re-askable; the rest surface the label without a
 * prompt. Mirrors the server's QUICK_SIGNAL_PROMPTS → claim mapping.
 */
export const CONFLICT_REASK_CONTEXT: Readonly<Partial<Record<string, QuickSignalContext>>> = {
  'crowd.level': 'arrival',
  'crowd.trajectory': 'inside',
  'queue.wait': 'entrance',
};

export interface ConflictReask {
  claimType: string;
  context: QuickSignalContext;
  reason: 'conflict';
}

/** The minimal shape the resolver needs from a claim. */
export interface ConflictReaskCandidate {
  claimType: string;
  conflictState?: ConflictState | null;
}

/**
 * The re-ask to offer for a set of served claims, or null. `allowed` is the
 * caller's prompt gate (useIntelPrompts.canPrompt for the venue category) —
 * a paused, Safe-Return or flag-off state yields null regardless of conflict.
 * Deterministic: the first re-askable material claim in served order (the
 * server orders best/current first) wins.
 */
export function resolveConflictReask(
  claims: ReadonlyArray<ConflictReaskCandidate>,
  allowed: boolean,
): ConflictReask | null {
  if (!allowed) return null;
  for (const c of claims) {
    if (normalizeConflictState(c.conflictState) !== 'material') continue;
    const context = CONFLICT_REASK_CONTEXT[c.claimType];
    if (context) return { claimType: c.claimType, context, reason: 'conflict' };
  }
  return null;
}
