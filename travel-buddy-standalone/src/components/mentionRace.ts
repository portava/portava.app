/**
 * mentionRace — the pure commit-decision for MentionInput's suggestion fetch.
 *
 * MentionInput fetches @/# suggestions with debounce + AbortController (§33). A
 * response may only be applied to the visible list when it is BOTH:
 *   1. not aborted (a newer keystroke cancelled its request), and
 *   2. still current — the active trigger has not moved to a different start
 *      index (the user kept typing / deleted / retriggered elsewhere).
 *
 * Extracted as a pure function so the "an older response can never replace the
 * current one" guarantee is unit-testable without React or the network (the
 * component wires it; node:test tests it directly).
 */
export interface MentionResponseState {
  /** Whether the request that produced this response was aborted. */
  aborted: boolean;
  /** The trigger start index the response was fetched for. */
  responseStartIndex: number;
  /** The currently-active trigger's start index, or null if none is active. */
  activeStartIndex: number | null;
}

/**
 * True when a suggestion response should be committed to the visible list.
 * Aborted responses and responses for a no-longer-active trigger position are
 * dropped (never flashed over newer input).
 */
export function shouldApplyMentionResponse(state: MentionResponseState): boolean {
  if (state.aborted) return false;
  if (state.activeStartIndex == null) return false;
  return state.activeStartIndex === state.responseStartIndex;
}
