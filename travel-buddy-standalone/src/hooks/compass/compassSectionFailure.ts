/**
 * census-discovery §103 (DV-83, D-W11X2-50): is this Compass section answer a
 * FAILED read rather than Compass's own answer?
 *
 * GET /compass/feed/section answers `fallback: true` in three arms. Compass
 * switched off (`compassEnabled: false`) is an answer, and the picks section
 * hides for it. A section BUILD that failed (`section_build_error`) and a flag
 * table that could not be read (`compass_flags_unreadable`) are not answers:
 * they are failed reads, and they are said, never hidden like "Compass is off".
 *
 * Kept in its own module (not services/compass.ts, not the hook) so a test that
 * mocks either of those still gets the real predicate.
 */
import type { CompassFeedResponse } from '../../services/compass.ts';

export const COMPASS_SECTION_FAILURE_REASONS: ReadonlySet<string> = new Set(['section_build_error', 'compass_flags_unreadable']);

export function isCompassSectionFailure(data: Pick<CompassFeedResponse, 'fallback' | 'fallbackReason'> | null | undefined): boolean {
  return !!data && data.fallback === true && COMPASS_SECTION_FAILURE_REASONS.has(data.fallbackReason ?? '');
}
