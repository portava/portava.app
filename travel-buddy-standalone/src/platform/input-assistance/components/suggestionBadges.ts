/**
 * §20 suggestion display badges — verification, official status, and Hidden Gem
 * protection.
 *
 * §20 lists what a suggestion row may display "where appropriate": name,
 * subtitle, distance, availability, verification/trust context, and Hidden Gem
 * protection / status labels. Three of those had no field on `InputSuggestion`
 * at all, so the row could not have rendered them if it wanted to. Two now do:
 * `verified` / `official` (projected from the same public badges the profile
 * surfaces already show) and `locationPrecision` (projected from the gem
 * search's own `coordsPrecision` vocabulary).
 *
 * This module is the single place that turns those fields into user-facing
 * words, so the row component and the accessibility label cannot drift apart —
 * `EntitySuggestionRow` renders this list AND joins it into the announced
 * label, rather than composing two independent strings.
 *
 * ORDER IS DELIBERATE. `Official` precedes `Verified` because an official
 * account is the stronger claim and only one badge fits on a narrow row before
 * the title ellipsises; the protection badge trails both because it qualifies
 * the entity's location rather than its identity.
 *
 * Pure module — no React, no network, no RN — unit-testable under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';

/** A badge to render on a suggestion row, and to announce to a screen reader. */
export interface SuggestionBadge {
  /** Stable key for `React.key` and for tests. */
  id: 'official' | 'verified' | 'protected' | 'approximate';
  /** The user-facing word. */
  label: string;
}

/**
 * The badges a suggestion row should show, in render order. Empty for every row
 * that carries none of the fields — the common case, and the one that must stay
 * visually identical to the pre-Phase-9 row.
 */
export function suggestionBadges(s: Pick<InputSuggestion, 'verified' | 'official' | 'locationPrecision'>): SuggestionBadge[] {
  const out: SuggestionBadge[] = [];
  if (s.official === true) out.push({ id: 'official', label: 'Official' });
  if (s.verified === true) out.push({ id: 'verified', label: 'Verified' });
  // A gem whose sensitivity denies placement is PROTECTED; one that may carry a
  // centroid is APPROXIMATE. Saying which is the point of §20's "protection /
  // status labels" row — before this, both rendered identically.
  if (s.locationPrecision === 'hidden') out.push({ id: 'protected', label: 'Protected location' });
  else if (s.locationPrecision === 'approximate') out.push({ id: 'approximate', label: 'Approx. location' });
  return out;
}

// ── §28 "Distance where permitted" (census G176) ────────────────────────────

/**
 * The words for a coarse distance band the server projected
 * (`lib/inputAssistance/distanceBand.ts`), or null. The band vocabulary is the
 * app's own approximate-distance buckets (`mapTelemetry.distanceBucket`). A value
 * this build cannot name renders NOTHING: a newer server's band is not a reason
 * to print text this build never reviewed.
 */
export function distanceBandLabel(band: unknown): string | null {
  switch (band) {
    case '<0.5km': return 'Under 500 m';
    case '0.5-1km': return '0.5–1 km';
    case '1-3km': return '1–3 km';
    case '3-10km': return '3–10 km';
    case '10-50km': return '10–50 km';
    case '50km+': return '50+ km';
    default: return null;
  }
}

/** The row's location line: the subtitle, then the distance band, either alone. */
export function rowSubtitle(s: Pick<InputSuggestion, 'subtitle' | 'distanceBand'>): string | null {
  const parts = [s.subtitle && s.subtitle.trim() ? s.subtitle : null, distanceBandLabel(s.distanceBand)].filter(
    (p): p is string => typeof p === 'string',
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}
