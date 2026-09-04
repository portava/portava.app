/**
 * Reading Expo Router search params without manufacturing `any`.
 *
 * ## The defect this exists to prevent
 *
 * The idiom every screen reached for was:
 *
 *     const x = Array.isArray(params.x) ? params.x[0] : (params.x ?? null);
 *
 * It looks careful and it is not. When `params.x` is `string | undefined` —
 * which is what `useLocalSearchParams<{ x?: string }>()` gives you —
 * `Array.isArray()` narrows it to an array type in the true branch, and
 * indexing that comes back **`any`**. The whole expression is therefore `any`,
 * and every contract downstream of it silently stops being checked.
 *
 * That is not theoretical. On 2026-09-04 the map screen published
 * `entry: mode ?? 'direct'` into §35's `map_opened`, where the field is typed
 * `MapEntryPoint` and 'direct' is not a member. It compiled, shipped, and every
 * production path emitted an invalid entry point, because `mode` had been
 * laundered to `any` by exactly this idiom.
 *
 * Proven per-site with probe/control pairs under `--incremental false`: seven
 * call sites across two screens were `any`; the two that passed the raw param
 * to a typed helper (`parseCoord`, `parseZoom`) were fine. The difference is
 * only ever whether the array branch is entered through a typed signature.
 *
 * ## The invariant
 *
 * ROUTE PARAM NORMALIZATION MUST NEVER WIDEN A TYPED ROUTER PARAM TO `any`.
 *
 * `firstParam` takes `string | string[] | undefined` explicitly, so the array
 * branch is typed rather than inferred, and returns `string | null`. Callers
 * that need a different empty value say so (`?? ''`).
 *
 * NORMALIZATION IS NOT PARSING. This module hands back the string a URL
 * actually carried. Turning that into a number, an enum member or an id is the
 * caller's job, and must keep validating — `firstParam` makes a value's type
 * honest, it does not make the value trustworthy.
 */

/**
 * First value of a search param, preserving the runtime shape Expo Router can
 * actually deliver: a repeated param (`?a=1&a=2`) arrives as an array.
 *
 * Returns `null` for absent, empty-array and empty-string-absent cases so a
 * caller never has to distinguish "missing" from "missing differently".
 */
export function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
