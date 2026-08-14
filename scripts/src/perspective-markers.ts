/**
 * perspective-markers.ts
 *
 * SINGLE SOURCE OF TRUTH for the tree-specific ("perspective-divergent")
 * relative-path markers rejected by findPerspectiveViolations in
 * scripts/src/cross-tree-paths.test.ts.
 *
 * HISTORY — WHY ONE DIRECTION REMAINS. This file used to describe a two-tree
 * world: artifacts/travel-buddy (the monorepo tree) and travel-buddy-standalone,
 * kept in step by scripts/sync-standalone.sh, which refused to copy
 * perspective-divergent files using two bash regexes (MONO_PERSPECTIVE_RE /
 * SA_PERSPECTIVE_RE) that a parity test asserted matched these arrays. The
 * monorepo tree was archived (see the archive commit's PR) and the sync script
 * retired with it, so both the second array and the bash parity test are gone.
 *
 * The surviving direction is NOT vestigial, and it is the one that matters
 * after an archival: the hazard now is someone restoring a file out of the
 * archived tree — from git history or a stored .patch bundle — and dropping it
 * into travel-buddy-standalone. Such a file carries monorepo-perspective
 * relative paths that resolve OUTSIDE the workspace and fail with ENOENT at run
 * time. That is exactly what these markers catch.
 *
 * Matching convention: each marker is matched ANCHORED ON THE OPENING
 * QUOTE/BACKTICK (['"`] immediately before the marker) so that
 * '../../pnpm-lock.yaml' does not match inside '../../../../pnpm-lock.yaml'.
 */

/**
 * Monorepo-perspective paths — forbidden inside travel-buddy-standalone.
 *
 * These are the shapes a file living at artifacts/travel-buddy/src/services
 * used to write to reach the standalone tree or the root lockfile. Nothing in
 * the surviving tree should ever contain them; if one appears, the file came
 * from the archived tree.
 */
export const MONOREPO_PERSPECTIVE_MARKERS: readonly string[] = [
  '../../../../travel-buddy-standalone/',
  '../../../../pnpm-lock.yaml',
];

/** Escape a literal string for embedding in a RegExp. */
export function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the guard RegExp for a marker: opening quote/backtick + the escaped
 * marker string.
 */
export function markerToRegExp(marker: string): RegExp {
  return new RegExp("['\"`]" + escapeForRegExp(marker));
}
