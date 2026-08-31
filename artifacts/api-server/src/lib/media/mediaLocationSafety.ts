/**
 * mediaLocationSafety — the one gate that guarantees a Media v2 projection never
 * emits precise media location.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The World shell (§4.1/§13/§21) is about "what is happening at places", NOT a
 * map of pins. Media rows in this codebase DO carry precise coordinates — a
 * `posts` row has `location_lat` / `location_lng` (see FEED_POST_COLUMNS in
 * routes/mediaFeed.ts), an `events` row has `location_lat` / `location_lng`.
 * Those columns are used INTERNALLY for ranking / distance, but the World-first
 * projections must expose only coarse labels: place / neighborhood / city, plus
 * the opaque canonical placeId. Fine-grained coarsening of the raw media object
 * is a sibling security slice (Media P1b); THIS module is the projection-layer
 * backstop that proves a shaped projection is coarse.
 *
 * Two independent defenses build on this file:
 *   1. The projectors in lib/media/mediaProjection.ts WHITELIST fields — they
 *      never copy a coordinate column into their output. `findPreciseLocation`
 *      is the executable proof of that (mediaWorldProjection.test.ts feeds a row
 *      that HAS coordinates and asserts the projection has none — mutate the
 *      projector to copy a coord and the assertion goes red).
 *   2. `scrubPreciseLocation` is a fail-closed boundary scrub the routes apply to
 *      the fully-assembled response as defense-in-depth: if any future edit ever
 *      reintroduces a coordinate key, it is removed before the bytes leave the
 *      server (and counted, so the removal is observable rather than silent).
 *
 * The detector is deliberately conservative: it matches on KEY NAME only, so it
 * cannot be fooled by a coordinate smuggled under an innocent-looking value, and
 * it never inspects values (a `city` label that happens to be numeric is fine).
 */

/**
 * Exact key names (compared case-insensitively, after stripping non-alphanumerics)
 * that denote a precise geographic coordinate. Coarse labels — city, country,
 * neighborhood, district, placeLabel, placeId, region, timezone — are NOT here
 * and pass freely.
 */
const PRECISE_LOCATION_EXACT_KEYS: ReadonlySet<string> = new Set([
  "lat",
  "lng",
  "lon",
  "long",
  "latitude",
  "longitude",
  "coord",
  "coords",
  "coordinate",
  "coordinates",
  "geo",
  "geom",
  "geometry",
  "geohash",
  "geopoint",
  "geojson",
  "point",
  "gps",
  "gpslat",
  "gpslng",
  "locationlat",
  "locationlng",
  "exactlat",
  "exactlng",
  "preciselat",
  "preciselng",
  "exactlocation",
  "preciselocation",
  "exactcoordinates",
]);

/** Normalize a key for comparison: lowercase, strip `_`, `-`, spaces. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Does this key name denote a precise coordinate? Exact-set membership, plus the
 * structural suffixes/substrings that catch `location_lat`, `venue_longitude`,
 * `foo_lat`, `bar_lng`, etc. without tripping on coarse names.
 */
export function isPreciseLocationKey(key: string): boolean {
  const k = normalizeKey(key);
  if (!k) return false;
  if (PRECISE_LOCATION_EXACT_KEYS.has(k)) return true;
  // `...latitude` / `...longitude` anywhere in the (normalized) key.
  if (k.includes("latitude") || k.includes("longitude")) return true;
  // trailing coordinate token: `<prefix>lat` / `<prefix>lng` / `<prefix>lon`.
  // Guarded so coarse words that merely END in these letters do not match:
  // there are none in the projection vocabulary, but the suffix form is the
  // one that catches `location_lat` → normalized `locationlat` is already in the
  // exact set; this covers arbitrary future prefixes like `capture_lat`.
  if (/(?:^|[a-z0-9])(?:lat|lng|lon)$/.test(k) && k.length <= 20) {
    // Exclude coarse look-alikes explicitly (none today, but keep the guard honest).
    return true;
  }
  return false;
}

export interface PreciseLocationLeak {
  path: string;
  key: string;
}

/**
 * Deep-scan any JSON-serializable value for precise-location KEYS. Returns the
 * list of offending paths (empty === clean). Arrays are traversed by index;
 * objects by key. Cyclic structures are guarded against.
 */
export function findPreciseLocation(value: unknown, basePath = "$"): PreciseLocationLeak[] {
  const leaks: PreciseLocationLeak[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
      node.forEach((el, i) => walk(el, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (isPreciseLocationKey(key)) {
        leaks.push({ path: childPath, key });
      }
      walk(child, childPath);
    }
  };

  walk(value, basePath);
  return leaks;
}

/** True when the value carries NO precise-location key anywhere. */
export function isLocationSafe(value: unknown): boolean {
  return findPreciseLocation(value).length === 0;
}

export interface ScrubResult<T> {
  value: T;
  /** How many precise-location keys were removed. 0 in the healthy case. */
  removed: number;
}

/**
 * Fail-closed boundary scrub: return a deep copy of `value` with every
 * precise-location key removed, and a count of what was removed. Applied by the
 * routes to the fully-assembled response as defense-in-depth. In the healthy
 * case (projectors already coarse) `removed` is 0 and the value is unchanged in
 * substance.
 *
 * NOTE: this is NOT the mutation-proof target — the projectors are. The scrub is
 * a second line so a regression cannot leak coordinates to a client even if the
 * projector test were somehow bypassed.
 */
export function scrubPreciseLocation<T>(value: T): ScrubResult<T> {
  let removed = 0;
  const seen = new WeakSet<object>();

  const scrub = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node as object)) return node;
    seen.add(node as object);

    if (Array.isArray(node)) {
      return node.map(scrub);
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (isPreciseLocationKey(key)) {
        removed += 1;
        continue;
      }
      out[key] = scrub(child);
    }
    return out;
  };

  return { value: scrub(value) as T, removed };
}
