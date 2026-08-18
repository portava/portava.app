/**
 * communityPlaceSubmission — what must be true before a community place is sent.
 *
 * Extracted from SubmitPlaceSheet.handleSubmit rather than left inline because
 * the rules are worth testing exhaustively and the component cannot carry that:
 * this tree's renderer (React 19 + RNTL v14) commits only one press-derived
 * state update per test file, so five submit attempts need five files. The rule
 * lives here, the wiring keeps one component test.
 */

export interface CommunityPlaceDraft {
  /** Typed by the user on the sheet. */
  name: string;
  /**
   * NOT typed on the sheet — passed in as a prop from Discovery's current
   * destination (`app/(tabs)/discovery.tsx` renders `city={destination}`).
   */
  city: string;
}

/**
 * Returns the message to show, or null when the draft may be submitted.
 *
 * Name is checked first. For a user who has typed nothing, the name is the
 * field in front of them and is the more useful thing to be told about; the
 * city is not even an input on this sheet.
 *
 * The city check is newer than the rest of this sheet. While Discovery fell
 * back to a hardcoded 'Paris' the destination could never be empty, so nothing
 * needed to check it. Removing that fallback — so the screen honestly reports
 * "no city known" — made an empty destination reachable, and the server keys
 * community places by city, so an empty one is unroutable. Empty is more honest
 * than "Paris" and is still not something to persist.
 */
export function validateCommunityPlace(draft: CommunityPlaceDraft): string | null {
  if (!draft.name.trim()) return 'Place name is required.';
  if (!draft.city.trim()) {
    // Names the thing to tap, because the city is not a field on this sheet —
    // a bare "city is required" would send the user hunting for an input that
    // does not exist.
    return 'Pick a destination first — tap the city name at the top of Discover.';
  }
  return null;
}
