/**
 * census-discovery §103 (DV-83, D-W11X2-47): which query a Discovery page — or a
 * failed read — belongs to.
 *
 * `getDiscoveryPlaces` stamps every page it returns (and caches) and every
 * transport failure it answers with the identity of the query it actually SENT.
 * A screen that keeps rows on screen under "couldn't refresh" compares the two:
 * rows stamped for one query are never kept under the failure of another, even
 * if a cache were ever to hand over the wrong page (§102.11 finding 1 was
 * exactly that: the client cache key left out the age filter, open-now, rating,
 * sort, context and coordinates).
 *
 * The stamp is kept beside the object (a WeakMap), never on it, so no body a
 * consumer reads or compares changes shape. An unstamped object (a test double,
 * the "API not configured" answer) has no identity and is never judged by it.
 * Its own module, so a test that mocks services/discovery still gets the real one.
 */
const stamps = new WeakMap<object, string>();

/**
 * The identity of a GET /discovery query's ROWS: every entry except `page` and the
 * user's own position (`userLat`/`userLng`), the destination normalised, order-free.
 *
 * The user's position is sent for the nearest sort only, to measure distances from.
 * It enters the CACHE key (it changes the answer's distances), but not this identity:
 * the same query's rows, measured from where the user stood a moment ago, are that
 * query's rows not yet refreshed — exactly what the stale line says — not another
 * query's. Every parameter that decides which rows, or their order, stays in.
 */
export function discoveryQueryIdentity(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([k]) => k !== 'page' && k !== 'userLat' && k !== 'userLng')
    .map(([k, v]) => [k, k === 'destination' ? v.toLowerCase().trim() : v] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function stampDiscoveryQuery<T extends object>(o: T, identity: string): T {
  stamps.set(o, identity);
  return o;
}

export function discoveryQueryOf(o: object | null | undefined): string | undefined {
  return o ? stamps.get(o) : undefined;
}

/**
 * True when the rows on screen are known to belong to a DIFFERENT query from the
 * one whose read just failed — so they must not be kept under its stale line.
 * Unknown on either side is not "different": nothing is judged without a stamp.
 */
export function heldForAnotherQuery(held: string | undefined, failed: object): boolean {
  const f = discoveryQueryOf(failed);
  return held !== undefined && f !== undefined && held !== f;
}
