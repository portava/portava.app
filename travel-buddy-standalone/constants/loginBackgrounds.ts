/**
 * loginBackgrounds.ts
 *
 * Placeholder travel/city/nightlife background images for the login screen.
 *
 * TODO: Replace these with real Portava brand photography.
 *   - Format: { uri: string } — can be a local require() or CDN URL
 *   - Required: portrait orientation, 9:16 ratio, minimum 1080×1920px
 *   - Subjects: travel destinations, nightlife, outdoor adventure, social gatherings
 *   - Mood: warm, aspirational, social — avoid stock-photo clichés
 *   - Example swap: { uri: require('../assets/images/login-bg-1.jpg') }
 *
 * The picsum.photos URLs below are deterministic (same seed = same image)
 * and suitable for development/demo only.
 */

export interface LoginBackground {
  uri: string;
}

export const LOGIN_BACKGROUNDS: LoginBackground[] = [
  { uri: 'https://picsum.photos/seed/portava-city1/800/1400' },
  { uri: 'https://picsum.photos/seed/portava-night2/800/1400' },
  { uri: 'https://picsum.photos/seed/portava-travel3/800/1400' },
  { uri: 'https://picsum.photos/seed/portava-rooftop4/800/1400' },
  { uri: 'https://picsum.photos/seed/portava-social5/800/1400' },
  { uri: 'https://picsum.photos/seed/portava-street6/800/1400' },
];

/** How long each image stays fully visible before the crossfade begins (ms). */
export const BG_DISPLAY_DURATION_MS = 9000;

/** Duration of the crossfade transition between images (ms). */
export const BG_FADE_DURATION_MS = 1500;
