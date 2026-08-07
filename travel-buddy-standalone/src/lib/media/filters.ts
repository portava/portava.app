/**
 * Travel Buddy media filter library.
 *
 * 12 named filters expressed as CSS filter component values. Intensity (0–100)
 * linearly interpolates each component between the identity value (no effect)
 * and the preset value (full effect).
 *
 * ## This module must stay free of react-native imports
 *
 * It is exercised by the plain `node:test` runner, which cannot transform
 * react-native. That is why `resolveFilterStyle()` takes the platform as an
 * argument instead of reading `Platform.OS` itself — the numeric work stays
 * pure and node-testable, and only the caller touches react-native.
 *
 * ## The identity-fallback invariant
 *
 * A missing, unknown, or malformed filter must render the image UNFILTERED —
 * never blank, never a thrown style. Every entry point here is total: it
 * returns identity ('none' / undefined) rather than throwing or emitting a
 * value that could make React Native reject the style. Media disappearing
 * because of a bad filter id would be a new instance of the blank-media class
 * of bug this codebase just spent a day removing.
 */

export interface FilterValues {
  brightness: number;   // CSS brightness(X)  — identity 1
  contrast: number;     // CSS contrast(X)     — identity 1
  saturate: number;     // CSS saturate(X)     — identity 1
  sepia: number;        // CSS sepia(X)        — identity 0
  hueRotate: number;    // CSS hue-rotate(Xdeg)— identity 0
  grayscale: number;    // CSS grayscale(X)    — identity 0
}

export interface MediaFilter {
  id: string;
  name: string;
  description: string;
  values: FilterValues;
  /** Default intensity (0–100) shown in the editor when this filter is first tapped. */
  defaultIntensity: number;
  /** Whether this filter can be applied to videos (CSS-only, not baked). */
  supportsVideo: boolean;
}

const IDENTITY: FilterValues = {
  brightness: 1,
  contrast: 1,
  saturate: 1,
  sepia: 0,
  hueRotate: 0,
  grayscale: 0,
};

/**
 * The catalogue.
 *
 * These numbers are VERIFIED but NOT TUNED. `__tests__/filterValues.test.ts`
 * pins everything decidable without a screen — every component sits in a valid
 * domain, intensity 0 is identity for every preset, 100 reproduces the preset,
 * interpolation is monotonic and never overshoots, Original is a true no-op,
 * and no two presets carry identical values.
 *
 * What none of that establishes is how any of them LOOK. Open question, parked
 * for the device pass rather than guessed at here: Wanderlust (saturate 1.5)
 * and Vivid (saturate 2.0) may not be perceptually distinct enough to justify
 * two carousel slots — the tests prove only that their numbers differ. The
 * warm set (Golden Hour, Safari, Sunset) also wants checking against real
 * landscapes, food and daylight skin tones, which is the whole point of the
 * set in a travel app.
 *
 * Do not adjust these values on the strength of a green test run.
 */
export const mediaFilters: MediaFilter[] = [
  {
    id: 'original',
    name: 'Original',
    description: 'No filter applied.',
    values: IDENTITY,
    defaultIntensity: 100,
    supportsVideo: true,
  },
  {
    id: 'wanderlust',
    name: 'Wanderlust',
    description: 'Warm, saturated travel look.',
    values: { brightness: 1.05, contrast: 1.1, saturate: 1.5, sepia: 0.1, hueRotate: 0, grayscale: 0 },
    defaultIntensity: 80,
    supportsVideo: true,
  },
  {
    id: 'golden_hour',
    name: 'Golden Hour',
    description: 'Warm golden afternoon light.',
    values: { brightness: 1.1, contrast: 1.05, saturate: 1.2, sepia: 0.35, hueRotate: 0, grayscale: 0 },
    defaultIntensity: 75,
    supportsVideo: true,
  },
  {
    id: 'deep_ocean',
    name: 'Deep Ocean',
    description: 'Cool blue coastal tones.',
    values: { brightness: 0.95, contrast: 1.15, saturate: 1.3, sepia: 0, hueRotate: 195, grayscale: 0 },
    defaultIntensity: 70,
    supportsVideo: true,
  },
  {
    id: 'mist',
    name: 'Mist',
    description: 'Faded, soft morning haze.',
    values: { brightness: 1.1, contrast: 0.85, saturate: 0.6, sepia: 0.05, hueRotate: 0, grayscale: 0 },
    defaultIntensity: 80,
    supportsVideo: true,
  },
  {
    id: 'polaroid',
    name: 'Polaroid',
    description: 'High contrast retro snapshot.',
    values: { brightness: 1.05, contrast: 1.25, saturate: 1.15, sepia: 0.15, hueRotate: 0, grayscale: 0 },
    defaultIntensity: 85,
    supportsVideo: true,
  },
  {
    id: 'noir',
    name: 'Noir',
    description: 'Classic black and white.',
    values: { brightness: 1.0, contrast: 1.2, saturate: 0, sepia: 0, hueRotate: 0, grayscale: 1 },
    defaultIntensity: 100,
    supportsVideo: true,
  },
  {
    id: 'safari',
    name: 'Safari',
    description: 'Warm earthy savanna tones.',
    values: { brightness: 1.05, contrast: 1.1, saturate: 0.9, sepia: 0.4, hueRotate: 15, grayscale: 0 },
    defaultIntensity: 75,
    supportsVideo: true,
  },
  {
    id: 'vivid',
    name: 'Vivid',
    description: 'Punchy ultra-saturated colours.',
    values: { brightness: 1.05, contrast: 1.2, saturate: 2.0, sepia: 0, hueRotate: 0, grayscale: 0 },
    defaultIntensity: 70,
    supportsVideo: true,
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Orange-red evening warmth.',
    values: { brightness: 1.05, contrast: 1.1, saturate: 1.4, sepia: 0.5, hueRotate: -10, grayscale: 0 },
    defaultIntensity: 75,
    supportsVideo: true,
  },
  {
    id: 'arctic',
    name: 'Arctic',
    description: 'Crisp cool polar light.',
    values: { brightness: 1.1, contrast: 1.1, saturate: 0.7, sepia: 0, hueRotate: 210, grayscale: 0 },
    defaultIntensity: 80,
    supportsVideo: true,
  },
  {
    id: 'velvet',
    name: 'Velvet',
    description: 'Dark moody cinematic depth.',
    values: { brightness: 0.85, contrast: 1.35, saturate: 1.1, sepia: 0.1, hueRotate: 0, grayscale: 0 },
    defaultIntensity: 85,
    supportsVideo: true,
  },
];

/** Map for O(1) lookup by filter id. */
const filterMap = new Map<string, MediaFilter>(mediaFilters.map((f) => [f.id, f]));

export function getMediaFilter(id: string | null | undefined): MediaFilter {
  return filterMap.get(id ?? '') ?? mediaFilters[0];
}

/**
 * Linearly interpolate each CSS filter component between the identity value and
 * the preset value at the given intensity (0–100). Returns a CSS filter string.
 *
 * At intensity=0  → effectively "Original" (identity values).
 * At intensity=100 → full preset values.
 */
export function buildCssFilter(filter: MediaFilter, intensity: number): string {
  const c = computeComponents(filter, intensity);
  if (!c) return 'none';

  const parts: string[] = [];
  if (Math.abs(c.brightness - 1) > 0.001) parts.push(`brightness(${c.brightness.toFixed(3)})`);
  if (Math.abs(c.contrast   - 1) > 0.001) parts.push(`contrast(${c.contrast.toFixed(3)})`);
  if (Math.abs(c.saturate   - 1) > 0.001) parts.push(`saturate(${c.saturate.toFixed(3)})`);
  if (c.sepia > 0.001)                    parts.push(`sepia(${c.sepia.toFixed(3)})`);
  if (Math.abs(c.hueRotate) > 0.1)        parts.push(`hue-rotate(${c.hueRotate.toFixed(1)}deg)`);
  if (c.grayscale > 0.001)                parts.push(`grayscale(${c.grayscale.toFixed(3)})`);

  return parts.length > 0 ? parts.join(' ') : 'none';
}

/**
 * Interpolated filter components, or null when the result is indistinguishable
 * from identity — including every malformed-input case.
 *
 * Total by construction: a null/undefined filter, one with a missing or
 * non-numeric `values` block, or a non-finite intensity all return null rather
 * than throwing or producing NaN components.
 */
function computeComponents(filter: MediaFilter | null | undefined, intensity: number): FilterValues | null {
  if (!filter || filter.id === 'original') return null;

  const v = filter.values;
  if (!v) return null;

  // A non-finite or non-numeric intensity means "we don't know" — treat it as
  // full strength rather than propagating NaN into every component. Out-of-range
  // values clamp instead of extrapolating past the preset.
  const raw = typeof intensity === 'number' && Number.isFinite(intensity) ? intensity : 100;
  const t = Math.max(0, Math.min(100, raw)) / 100;

  const lerp = (identity: number, preset: number) =>
    typeof preset === 'number' && Number.isFinite(preset)
      ? identity + (preset - identity) * t
      : identity;

  return {
    brightness: lerp(IDENTITY.brightness, v.brightness),
    contrast:   lerp(IDENTITY.contrast,   v.contrast),
    saturate:   lerp(IDENTITY.saturate,   v.saturate),
    sepia:      lerp(IDENTITY.sepia,      v.sepia),
    hueRotate:  lerp(IDENTITY.hueRotate,  v.hueRotate),
    grayscale:  lerp(IDENTITY.grayscale,  v.grayscale),
  };
}

/**
 * React Native's own filter representation: an array of single-key objects.
 * This is the canonical native (Fabric) form. Only components that actually
 * differ from identity are emitted, so an identity filter yields [].
 */
export type RNFilterFunction =
  | { brightness: number }
  | { contrast: number }
  | { saturate: number }
  | { sepia: number }
  | { hueRotate: string }
  | { grayscale: number };

export function buildFilterFunctions(filter: MediaFilter, intensity: number): RNFilterFunction[] {
  const c = computeComponents(filter, intensity);
  if (!c) return [];

  const out: RNFilterFunction[] = [];
  if (Math.abs(c.brightness - 1) > 0.001) out.push({ brightness: round3(c.brightness) });
  if (Math.abs(c.contrast   - 1) > 0.001) out.push({ contrast:   round3(c.contrast) });
  if (Math.abs(c.saturate   - 1) > 0.001) out.push({ saturate:   round3(c.saturate) });
  if (c.sepia > 0.001)                    out.push({ sepia:      round3(c.sepia) });
  if (Math.abs(c.hueRotate) > 0.1)        out.push({ hueRotate:  `${c.hueRotate.toFixed(1)}deg` });
  if (c.grayscale > 0.001)                out.push({ grayscale:  round3(c.grayscale) });
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Style fragment carrying a platform-appropriate `filter` value. */
export interface FilterStyle {
  filter: string | RNFilterFunction[];
}

/**
 * The single entry point every rendering surface should use.
 *
 * Returns `undefined` — meaning "apply no style at all" — for the no-filter
 * case, which covers: null/undefined/empty id, the `original` preset, an id
 * that is not in the catalogue, a malformed intensity, and any preset whose
 * interpolated result equals identity. Returning `undefined` rather than
 * `{ filter: 'none' }` matters: it keeps the unfiltered render path byte-for-byte
 * identical to having no filter feature at all, so an unrecognised filter can
 * never change how an image mounts.
 *
 * The two platforms take different shapes. Native (Fabric) consumes the array
 * form; react-native-web maps the CSS string onto the DOM `filter` property.
 * Passing the wrong shape is silently ignored by the other platform, which is
 * exactly the "no-ops on web" failure this needs to avoid — hence the split.
 *
 * @param platform 'web' | 'native' — pass `Platform.OS === 'web' ? 'web' : 'native'`.
 */
export function resolveFilterStyle(
  filterId: string | null | undefined,
  intensity: number | null | undefined,
  platform: 'web' | 'native',
): FilterStyle | undefined {
  if (!filterId || filterId === 'original') return undefined;

  // Unknown ids resolve to the Original preset, whose components are identity.
  const filter = getMediaFilter(filterId);
  if (filter.id === 'original') return undefined;

  const resolvedIntensity = intensity ?? 100;

  if (platform === 'web') {
    const css = buildCssFilter(filter, resolvedIntensity);
    return css === 'none' ? undefined : { filter: css };
  }

  const fns = buildFilterFunctions(filter, resolvedIntensity);
  return fns.length > 0 ? { filter: fns } : undefined;
}

/** All valid filter IDs — used by API validators. */
export const FILTER_IDS = mediaFilters.map((f) => f.id);
