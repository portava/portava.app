/**
 * Travel Buddy — design tokens
 * Editorial / passport visual direction. One bold device (the stamp),
 * everything else quiet so imagery leads.
 */
import type { TextStyle } from 'react-native';

export const color = {
  ink: '#11110F', // near-black text + immersive surfaces
  paper: '#FAF9F6', // base background
  paperRaised: '#FFFFFF', // cards on paper
  signal: '#FF4D2E', // vermilion — primary action + live pulse only
  signalDim: '#E5391C',
  deep: '#0A3D4A', // teal-ink — destination accents
  haze: '#E8E5DE', // dividers, card edges
  mute: '#6B6862', // secondary text
  faint: '#9C988F', // tertiary text, placeholders
  scrimTop: 'rgba(17,17,15,0)',
  scrimBottom: 'rgba(17,17,15,0.78)',
  onInk: '#FAF9F6', // text on dark/immersive
  onInkMute: 'rgba(250,249,246,0.72)',
  success: '#2E7D5B',
  warn: '#C8851A',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

/**
 * Type roles:
 *  - display: condensed grotesque feel, tight, big editorial titles
 *  - body: humanist sans for reading
 *  - stamp: monospace for tags, distances, dates, costs (passport-stamp device)
 *
 * Using system fonts now so the shell runs with zero font-loading.
 * Swap `display`/`stamp` for loaded faces later (e.g. Archivo, IBM Plex Mono).
 */
export const font = {
  display: undefined as string | undefined, // system bold, condensed via letterSpacing
  body: undefined as string | undefined,
  stamp: 'Courier' as string, // monospace, available on iOS/Android
} as const;

export const type = {
  hero: { fontSize: 30, lineHeight: 32, fontWeight: '800', letterSpacing: -0.8 },
  title: { fontSize: 22, lineHeight: 26, fontWeight: '800', letterSpacing: -0.5 },
  heading: { fontSize: 18, lineHeight: 23, fontWeight: '700', letterSpacing: -0.3 },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  stamp: { fontSize: 11, lineHeight: 13, fontWeight: '700', letterSpacing: 0.5 },
} satisfies Record<string, TextStyle>;

export const shadow = {
  card: {
    shadowColor: '#11110F',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  float: {
    shadowColor: '#11110F',
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
} as const;

/** Normalized sizing tokens for the design-layer pass. */
export const icon = { sm: 14, md: 18, lg: 22, xl: 26 } as const;

/** Standard image aspect ratios for cards. */
export const aspect = { wide: 16 / 9, card: 4 / 3, square: 1, portrait: 3 / 4 } as const;

/** Layout constraints. */
export const layout = {
  maxWidth: 720,        // desktop/tablet content cap
  hitSlop: { top: 6, bottom: 6, left: 6, right: 6 },
  pressedOpacity: 0.85,
} as const;
