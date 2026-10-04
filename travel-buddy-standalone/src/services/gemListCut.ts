/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; sweep): a gem list the server said was cut.
 *
 * GET /hidden-gems sends `truncated: true` when its scan hit the cap or the ranked list was longer than the page
 * (D-W11X2-131). `listGems` answers an array, and four callers use it as one; the mark is kept BESIDE the array (a
 * WeakSet, as the server keeps `nearbyEventsScanCut` beside its rows), so every caller's shape is unchanged and a
 * caller that must say a cut asks `gemListCut(list)`. Its own module, so a test that mocks the gem service still reads
 * the real mark.
 */
const CUT = new WeakSet<object>();

/** Mark `list` as one the server said was cut. Returns it, for chaining. */
export function markGemListCut<T extends object>(list: T): T {
  CUT.add(list);
  return list;
}

/** Whether the server said `list` was cut — never "these are all the gems". */
export function gemListCut(list: object | null | undefined): boolean {
  return list != null && CUT.has(list);
}
