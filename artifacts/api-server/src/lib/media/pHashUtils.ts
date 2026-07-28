/**
 * pHashUtils — perceptual hash (difference-hash) utilities.
 *
 * A 64-bit difference hash is encoded as a 16-character lowercase hex string.
 * Two images are near-duplicates when their Hamming distance (number of
 * differing bits) is ≤ HAMMING_THRESHOLD.
 *
 * These utilities are purely computational — no I/O, no side effects — so they
 * can be called from any context (upload path, background worker, tests).
 */

/** Maximum Hamming distance that still counts as a near-duplicate. */
export const HAMMING_THRESHOLD = 8;

/**
 * Bit-count lookup table for a nibble (0–15).
 * Pre-computed so hammingDistance() never calls Math.* in a hot loop.
 */
const NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/**
 * Hamming distance between two 16-hex-char pHash strings (64-bit hashes).
 * Returns the number of differing bits (0 – 64).
 *
 * Throws when either argument is not a 16-character hex string, so callers
 * must guard with a null/length check before calling.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) {
    throw new Error(`pHash strings must be 16 hex chars; got "${a}" and "${b}"`);
  }
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += NIBBLE_POPCOUNT[xor];
  }
  return dist;
}

/**
 * Returns true when two pHash strings are within the near-duplicate threshold.
 * Returns false rather than throwing when either hash is null/undefined/wrong-
 * length — fail-soft so a bad hash in the DB never crashes the worker.
 */
export function areDuplicates(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== 16 || b.length !== 16) return false;
  try {
    return hammingDistance(a, b) <= HAMMING_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Union-Find (Disjoint Set Union) for grouping near-duplicate pHash strings.
 * Accepts an array of { id, phash } items and returns an array of clusters,
 * where each cluster is an array of item ids.
 *
 * Two items are merged into the same cluster when areDuplicates(a.phash, b.phash).
 * Time complexity: O(n²) on the number of items — callers should keep n small
 * (≤ 1 000 per bucket) by pre-filtering on bucket_key.
 */
export function clusterByPhash<T extends { id: string; phash: string }>(
  items: T[],
): string[][] {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path halving
      x = parent[x];
    }
    return x;
  }

  function union(x: number, y: number): void {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (areDuplicates(items[i].phash, items[j].phash)) {
        union(i, j);
      }
    }
  }

  // Collect clusters: root → list of ids.
  const clusters = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const group = clusters.get(root) ?? [];
    group.push(items[i].id);
    clusters.set(root, group);
  }

  return [...clusters.values()];
}
