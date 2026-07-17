/**
 * perspective-markers.ts
 *
 * SINGLE SOURCE OF TRUTH for the tree-specific ("perspective-divergent")
 * relative-path markers that are:
 *   1. rejected by findPerspectiveViolations in scripts/src/cross-tree-paths.test.ts
 *      (the guard test), and
 *   2. refused at copy time by scripts/sync-standalone.sh
 *      (MONO_PERSPECTIVE_RE / SA_PERSPECTIVE_RE).
 *
 * The TypeScript guard builds its FORBIDDEN table directly from these arrays.
 * The bash script cannot import this file, so a parity test in
 * cross-tree-paths.test.ts parses the bash regexes and asserts they expand to
 * exactly these marker strings. Adding a marker here without updating the bash
 * regexes (or vice versa) fails that test.
 *
 * Matching convention (both consumers): each marker is matched ANCHORED ON THE
 * OPENING QUOTE/BACKTICK (['"`] immediately before the marker) so that
 * '../../pnpm-lock.yaml' does not match inside '../../../../pnpm-lock.yaml'.
 */

/**
 * Monorepo-perspective paths — forbidden inside the standalone tree.
 * (Reaching the standalone tree / root lockfile from artifacts/travel-buddy/src/services.)
 */
export const MONOREPO_PERSPECTIVE_MARKERS: readonly string[] = [
  '../../../../travel-buddy-standalone/',
  '../../../../pnpm-lock.yaml',
];

/**
 * Standalone-perspective paths — forbidden inside the monorepo tree.
 * (Reaching the monorepo tree / own lockfile / root lockfile from
 * travel-buddy-standalone/src/services.)
 */
export const STANDALONE_PERSPECTIVE_MARKERS: readonly string[] = [
  '../../../artifacts/travel-buddy/',
  '../../pnpm-lock.yaml',
  '../../../pnpm-lock.yaml',
];

/** Escape a literal string for embedding in a RegExp. */
export function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the guard RegExp for a marker: opening quote/backtick + the escaped
 * marker string (same anchoring trick as the bash regexes).
 */
export function markerToRegExp(marker: string): RegExp {
  return new RegExp("['\"`]" + escapeForRegExp(marker));
}
