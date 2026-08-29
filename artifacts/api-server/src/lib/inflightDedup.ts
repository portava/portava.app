/**
 * Collapse concurrent identical async work onto ONE in-flight promise.
 *
 * WHY THIS EXISTS (2026-08-28)
 * ----------------------------
 * `routes/discovery.ts` already had this pattern, hand-rolled, for Nominatim
 * (`_geocodePending`) with an explicit note about its 1 req/s fair-use policy.
 * It did NOT have it for Overpass, whose four call sites each issued their own
 * HTTP request — and `GET /discovery/counts` fans out over seven categories, so
 * two simultaneous requests for one city meant fourteen Overpass calls where
 * seven would do.
 *
 * That gap mattered because the dependency is rate-limited and the deployment
 * has already been throttled by it. `queryOverpass` returns `[]` on a non-ok
 * response, so being throttled does not raise — it silently empties the feed.
 * Concurrency is what turns a cold cache into that state, and concurrency is
 * what launch adds.
 *
 * WHAT THIS IS NOT
 * ----------------
 * NOT a cache. The entry is removed the moment the promise settles, so it can
 * never serve a stale result — whatever TTL cache sits above it stays the only
 * thing deciding how long a value may be reused. Retaining settled promises
 * here would quietly convert it into a cache with no expiry, which is the most
 * likely way for this file to be mis-modified later.
 *
 * Rejections are shared and then cleared: every concurrent caller sees the same
 * failure (they were making the same call, so they would each have failed
 * anyway), and the NEXT caller starts a fresh attempt rather than inheriting it.
 */

export interface InflightDedup<T> {
  /**
   * Run `fn` for `key`, or join the run already in flight for that key.
   * The returned promise settles exactly as `fn`'s does.
   */
  run(key: string, fn: () => Promise<T>): Promise<T>;
  /** Number of calls currently in flight. For assertions and diagnostics. */
  readonly size: number;
}

export function createInflightDedup<T>(): InflightDedup<T> {
  const pending = new Map<string, Promise<T>>();

  return {
    run(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = pending.get(key);
      if (existing) return existing;

      // `fn()` is invoked exactly once per key per in-flight window. The
      // .finally runs on BOTH settle paths, so a rejection cannot strand the
      // key and block every later caller.
      const p = fn().finally(() => {
        pending.delete(key);
      });

      pending.set(key, p);
      return p;
    },
    get size() {
      return pending.size;
    },
  };
}
