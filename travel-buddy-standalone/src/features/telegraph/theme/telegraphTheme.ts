/**
 * Telegraph §11.1 — the two themes, and the accent discipline.
 *
 * Spec:
 *   §11.1  "Dark-first visual system may be used for the Telegraph concept,
 *           but components must support Portava light/dark themes."
 *   §11.1  "Use restrained teal/cyan as operational emphasis; reserve stronger
 *           attention states for safety and urgent changes."
 *   §11.3  "Do not encode delivery/availability solely by color."
 *
 * WHAT THIS FIXES. `src/theme/telegraphTokens.ts` is a single light palette
 * declared `as const` with no dark variant, and its accent is `color.signal`
 * (vermilion #FF4D2E) — the app-wide primary-action colour, which is therefore
 * NOT reserved for safety. This module adds the missing half: a dark palette,
 * a resolver, and a separation of `operational` (teal/cyan, the ordinary
 * emphasis) from `attention` (vermilion, reserved for safety and urgent
 * change).
 *
 * The pre-existing `TG` export is left exactly as it is, and this palette's
 * light values are the same colours, so a screen that has not yet moved keeps
 * rendering identically. Adoption is per-component.
 */
import { useColorScheme } from 'react-native';
import { color } from '../../../theme/tokens.ts';

export type TelegraphScheme = 'light' | 'dark';

export interface TelegraphPalette {
  scheme: TelegraphScheme;
  /** Screen background. */
  surface: string;
  /** Raised surfaces: header, composer, cards, rail. */
  surfaceRaised: string;
  /** Sent bubble. */
  sentBubble: string;
  sentText: string;
  sentTextMute: string;
  /** Received bubble. */
  recvBubble: string;
  recvBorder: string;
  recvText: string;
  /** Secondary text on this surface. */
  mute: string;
  /** Hairlines and separators. */
  hairline: string;
  /** Subtle chip / pill fill. */
  chipFill: string;
  /**
   * §11.1 "restrained teal/cyan as operational emphasis" — the colour for
   * ordinary Telegraph emphasis: a rail card's active edge, a selected filter,
   * an action affordance.
   */
  operational: string;
  operationalOn: string;
  /**
   * §11.1 "reserve stronger attention states for safety and urgent changes" —
   * NOT used for ordinary emphasis anywhere in this feature.
   */
  attention: string;
  attentionOn: string;
}

/** Teal-ink, already in the app palette, unused by Telegraph until now. */
const TEAL_DEEP = color.deep; // '#0A3D4A'
const TEAL_BRIGHT = '#2E8FA6'; // lighter cyan for dark surfaces

const LIGHT: TelegraphPalette = {
  scheme: 'light',
  surface: '#F7F6F3',
  surfaceRaised: '#FFFFFF',
  sentBubble: '#1A3A2A',
  sentText: '#FFFFFF',
  sentTextMute: 'rgba(255,255,255,0.66)',
  recvBubble: '#FFFFFF',
  recvBorder: 'rgba(0,0,0,0.07)',
  recvText: color.ink,
  mute: color.mute,
  hairline: 'rgba(0,0,0,0.08)',
  chipFill: 'rgba(0,0,0,0.05)',
  operational: TEAL_DEEP,
  operationalOn: '#FFFFFF',
  attention: color.signal,
  attentionOn: '#FFFFFF',
};

const DARK: TelegraphPalette = {
  scheme: 'dark',
  surface: '#0E1512',
  surfaceRaised: '#16201C',
  sentBubble: '#20543D',
  sentText: '#F2FBF6',
  sentTextMute: 'rgba(242,251,246,0.66)',
  recvBubble: '#1D2723',
  recvBorder: 'rgba(255,255,255,0.10)',
  recvText: '#F2F4F2',
  mute: '#A8B0AB',
  hairline: 'rgba(255,255,255,0.12)',
  chipFill: 'rgba(255,255,255,0.08)',
  operational: TEAL_BRIGHT,
  operationalOn: '#07100E',
  attention: color.signal,
  attentionOn: '#FFFFFF',
};

export const TELEGRAPH_PALETTES: Readonly<Record<TelegraphScheme, TelegraphPalette>> = {
  light: LIGHT,
  dark: DARK,
};

/** Pure resolver — a null/unknown scheme resolves to light, never to nothing. */
export function telegraphPalette(scheme: TelegraphScheme | null | undefined): TelegraphPalette {
  return scheme === 'dark' ? DARK : LIGHT;
}

/** The palette for the device's current appearance. */
export function useTelegraphPalette(): TelegraphPalette {
  const scheme = useColorScheme();
  return telegraphPalette(scheme === 'dark' ? 'dark' : 'light');
}

/**
 * §11.3, made mechanical: a status may not be carried by colour alone. Every
 * Telegraph status the rail renders must supply a word (and, where it helps, a
 * shape), so this helper returns the LABEL and the caller uses the colour only
 * as reinforcement.
 */
export function statusLabelFor(
  band: 'HAPPENING_NOW' | 'STARTING_SOON' | 'TODAY' | 'UPCOMING' | 'ACTIVE_TRIP' | 'UNRESOLVED' | 'PAST',
): string {
  switch (band) {
    case 'HAPPENING_NOW':
      return 'Happening now';
    case 'STARTING_SOON':
      return 'Starting soon';
    case 'TODAY':
      return 'Today';
    case 'UPCOMING':
      return 'Upcoming';
    case 'ACTIVE_TRIP':
      return 'Active trip';
    case 'UNRESOLVED':
      return 'Want to do';
    case 'PAST':
      return 'Past';
    default:
      return 'Shared';
  }
}
