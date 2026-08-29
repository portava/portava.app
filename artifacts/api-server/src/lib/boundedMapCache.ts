/**
 * Bound an in-process Map cache: drop what has expired, then cap what remains.
 *
 * WHY THIS EXISTS (2026-08-28)
 * ----------------------------
 * Three Maps in routes/discovery.ts had no size bound and no sweeper, and their
 * expiry was checked ONLY on read (`isFresh` at the L1 hit, the TTL comparison
 * at the Compass hit). An entry that is never requested again is therefore never
 * freed: the process holds it until restart. Memory grows monotonically with the
 * number of distinct keys the process has ever seen, not with the number of
 * useful ones.
 *
 * That is worst for the per-user cache. `_compassCandidateCache` is keyed
 * `userId:destination:radius:sortBy` and stores a `DiscoveryPlace[]`, so it
 * grows with users x destinations — the exact quantity that goes up at launch.
 * A cache whose failure mode arrives with success is worth bounding before the
 * success does.
 *
 * WHAT THIS DELIBERATELY IS NOT
 * -----------------------------
 * Not an LRU. True LRU needs recency tracked on every read, and these call sites
 * read far more often than they write; paying a Map delete+reinsert per hit to
 * bound a cache that is already TTL-governed is the wrong trade. Eviction here
 * is oldest-write-first, which for a TTL cache is very close to LRU and costs
 * nothing on the read path.
 *
 * Not a replacement for the TTL checks at the call sites. Those decide whether a
 * HIT is fresh enough to serve. This decides how much the process may retain.
 * Both are needed: dropping the read-side check would serve stale data, and
 * dropping this would retain everything forever.
 */

export interface BoundResult {
  /** Entries removed because they were older than the TTL. */
  expired: number;
  /** Entries removed, oldest first, purely to get back under `max`. */
  evicted: number;
  /** Size after pruning. */
  size: number;
}

export interface BoundOptions<V> {
  /** Hard ceiling on retained entries. */
  max: number;
  /** Age at which an entry is dead regardless of demand. */
  ttlMs: number;
  /** Reads the entry's write time (epoch ms). */
  timestampOf: (value: V) => number;
  /** Injectable clock, for tests. */
  now?: number;
}

/**
 * Prune `map` in place.
 *
 * Order matters: expired entries go FIRST, so a cache full of dead entries
 * evicts nothing live. Reversing it would discard useful entries to make room
 * for ones about to be dropped anyway.
 *
 * Safe to call on every write. It is O(n) only when the map is over `max` or
 * holds expired entries; the common case walks the map once and removes nothing.
 */
export function pruneAndBound<V>(map: Map<string, V>, opts: BoundOptions<V>): BoundResult {
  const now = opts.now ?? Date.now();
  let expired = 0;
  let evicted = 0;

  if (opts.ttlMs > 0) {
    for (const [key, value] of map) {
      if (now - opts.timestampOf(value) >= opts.ttlMs) {
        map.delete(key);
        expired += 1;
      }
    }
  }

  if (map.size > opts.max) {
    // Sort by write time so the oldest go first. Map iteration order is
    // insertion order, which is NOT write order once a key has been overwritten
    // in place — an updated entry keeps its original position. Sorting on the
    // stored timestamp is therefore the only correct ordering here.
    const byAge = [...map.entries()].sort(
      (a, b) => opts.timestampOf(a[1]) - opts.timestampOf(b[1]),
    );
    const surplus = map.size - opts.max;
    for (let i = 0; i < surplus; i += 1) {
      map.delete(byAge[i]![0]);
      evicted += 1;
    }
  }

  return { expired, evicted, size: map.size };
}
