/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; the round-17 verifier's B12): a rollback-path layer the server
 * answered with one page of several.
 *
 * The NOW map's rollback path (the gateway failed, was refused, or its flag is off) reads each pin layer from its own
 * endpoint and draws the page it gets. A buddy search answers `total` beside its page; GET /events answers `truncated`
 * when its list is not whole, and a page as long as the server's `limit` may be one of several. The mark is kept BESIDE
 * the projected array (a WeakSet, as `gemListCut` keeps the gem list's), so the fetchers' shape is unchanged and the
 * hook asks `layerPageCut(objects)` when it decides whether the map is whole.
 */
const CUT = new WeakSet<object>();

/** Mark `objects` as a page of several. Returns it, for chaining. */
export function markLayerPageCut<T extends object>(objects: T): T {
  CUT.add(objects);
  return objects;
}

/** Whether `objects` is a page of several — never "this is the whole layer". */
export function layerPageCut(objects: object | null | undefined): boolean {
  return objects != null && CUT.has(objects);
}

/** A buddy search page is cut when the server counted more buddies than it sent. */
export function buddyPageCut(data: { buddies: readonly unknown[]; total?: number | null }): boolean {
  return typeof data.total === 'number' && data.total > data.buddies.length;
}

/** An events page is cut when the server said so, or when it filled the server's page limit (there may be more). */
export function eventsPageCut(data: { events: readonly unknown[]; limit?: number | null; truncated?: boolean }): boolean {
  return data.truncated === true || (typeof data.limit === 'number' && data.limit > 0 && data.events.length >= data.limit);
}
