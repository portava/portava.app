/**
 * discoveryCoverageNotice — what a person is told when a Discovery answer is
 * PARTIAL. census-discovery §80 (lane W10-S1), DV-83, register D-W10-S1-2.
 *
 * THE RULE (the owner question §60.8 Q1, decided)
 * ===============================================
 * A consumer may NOT render a `coverage: "partial"` answer as a complete one.
 * The rows it carries are real and are kept (discarding them is the opposite
 * defect, and they were genuinely served); the person is told, once, that the
 * list may be missing things; and a partial answer with NO rows is never the
 * "nothing found" state, because its emptiness is not evidence of absence.
 *
 * Grounds: `02-DISCOVERY-v2` "retain permitted baseline retrieval and
 * recommendations with HONEST LIMITATIONS"; `11` §9 "A failure must not
 * masquerade as success"; the owner's D11 ruling "A distinguishable response
 * body alone is insufficient if consumers still treat it as successful empty
 * data"; GII §2 "must not present stale data as live".
 *
 * `failedSources` names tables and search buckets (`discovery_places`,
 * `hashtags`, `wishlist_places`). They are for logs and alerts, not people, so
 * they are NOT printed; "surfacing" them means saying that something is
 * missing, which is the only part a person can act on.
 *
 * THE WORDING — taken from the app's existing sentences, not invented
 * ===================================================================
 *  - A SEARCH the person typed (the search screen, its suggestions, the Map's
 *    search sheet): the sentence `MapSearchSheet` and `app/search.tsx` already
 *    shared verbatim, and its no-rows pair from `app/search.tsx`.
 *  - A BROWSE list (Discovery's tabs and sections, the Map's places layer): the
 *    Telegraph search screen's shape — "Some conversations couldn't be searched
 *    just now, so this list may be incomplete." — with the list's own noun, and
 *    for no rows the category tab's own "this is on our side, not your filters".
 *
 * Pure: no React, no network. Consumers import the constants so the wording has
 * one home; `discoveryRefusalConsumers.guard.test.ts` pins the text.
 */

/** A search surface, rows present. */
export const SEARCH_PARTIAL_NOTICE = 'These results are incomplete — part of the search couldn’t be run.';

/** A search surface, no rows. */
export const SEARCH_PARTIAL_EMPTY_TITLE = 'Some of this search could not run.';
export const SEARCH_PARTIAL_EMPTY_BODY =
  'Part of the search failed, so this is not a statement about what exists. Try again in a moment.';

/** A browse list, rows present. `noun` is the list's own plural ("places"). */
export function listPartialNotice(noun: string): string {
  return `Some ${noun} couldn’t be loaded just now, so this list may be incomplete.`;
}

/** A browse list, no rows. */
export function listPartialEmptyTitle(noun: string): string {
  return `Some ${noun} couldn’t be loaded just now`;
}
export const LIST_PARTIAL_EMPTY_BODY = 'This is on our side, not your filters. Try again in a moment.';

interface CoverageLike {
  coverage?: string | null;
}

/** True when the answer is a real but incomplete result. */
export function isPartial(refusal: CoverageLike | null | undefined): boolean {
  return refusal?.coverage === 'partial';
}

/** True when the answer is partial AND carries no rows: never "nothing found". */
export function isPartialEmpty(refusal: CoverageLike | null | undefined, rows: readonly unknown[] | null | undefined): boolean {
  return isPartial(refusal) && (rows?.length ?? 0) === 0;
}

/**
 * A browse list whose REFRESH failed in transport while the last page stays on
 * screen (census-discovery §100, DV-83, register D-W11X2-22). The rows kept are
 * a real earlier answer, so they stay; the person is told they may be out of
 * date rather than shown them as a fresh, complete answer — or losing them to
 * an empty state the failed read never established.
 */
export function listStaleNotice(noun: string): string {
  return `Couldn’t refresh just now, so these ${noun} may be out of date.`;
}
