/**
 * features/media — city visual-pulse presentation logic (spec §4.1/§20/§46).
 *
 * Maps a CityZoneState + trend to the display glyph and label used by the
 * NOW dashboard:  An Thuong ↑ Building · Beach Festival ● Peak …
 *
 * Deliberately renders a *state* label and a subtle trend arrow — never a
 * fabricated "live now" treatment (§46 "Subtle current-state pulses; no
 * fake-live treatment"; §46.2 anti-patterns).
 *
 * Pure, framework-free — no react-native imports.
 */
import type { CityZoneState } from '../types/mediaContext.ts';
import type { ActivityTrend } from '../types/perspective.ts';

/** Human label for a zone state. */
const STATE_LABELS: Record<CityZoneState, string> = {
  starting: 'Starting',
  building: 'Building',
  peak: 'Peak',
  moderate: 'Moderate',
  quiet: 'Quiet',
  winding_down: 'Winding down',
};

/**
 * The glyph shown before the label (§4.1 uses ↑ for directional/building and
 * ● for steady/peak states). This is a semantic classification, not decoration:
 *  - 'arrow-up'   → activity is on the way up (building / starting / rising)
 *  - 'arrow-down' → activity is easing (winding_down / falling)
 *  - 'dot'        → a held state (peak / moderate / quiet)
 */
export type ZoneGlyph = 'arrow-up' | 'arrow-down' | 'dot';

export function zoneStateLabel(state: CityZoneState): string {
  return STATE_LABELS[state] ?? 'Moderate';
}

export function zoneGlyph(state: CityZoneState, trend: ActivityTrend): ZoneGlyph {
  // Trend is the stronger signal when present and directional.
  if (trend === 'rising') return 'arrow-up';
  if (trend === 'falling') return 'arrow-down';
  // Steady trend: fall back to the state's own directionality.
  if (state === 'starting' || state === 'building') return 'arrow-up';
  if (state === 'winding_down') return 'arrow-down';
  return 'dot';
}

/** Unicode rendering of the glyph, for text-only contexts / accessibility copy. */
export function zoneGlyphChar(glyph: ZoneGlyph): string {
  switch (glyph) {
    case 'arrow-up':
      return '↑';
    case 'arrow-down':
      return '↓';
    case 'dot':
      return '●';
  }
}

/**
 * Full one-line display string for a zone, e.g. "Building ↑" / "Peak ●".
 * The label leads and the glyph trails, matching §20's "An Thuong  Building ↑".
 */
export function zonePulseLine(state: CityZoneState, trend: ActivityTrend): string {
  return `${zoneStateLabel(state)} ${zoneGlyphChar(zoneGlyph(state, trend))}`;
}

/**
 * Intensity 0..1 used only to size the SUBTLE state pulse (opacity / bar width).
 * Not a vanity metric and not derived from views/likes — it is a coarse mapping
 * of the qualitative state so the UI can differentiate visually (§46).
 */
export function zoneIntensity(state: CityZoneState): number {
  switch (state) {
    case 'peak':
      return 1;
    case 'building':
      return 0.75;
    case 'moderate':
      return 0.55;
    case 'starting':
      return 0.4;
    case 'winding_down':
      return 0.3;
    case 'quiet':
      return 0.2;
    default:
      return 0.5;
  }
}
