/**
 * loginBackgrounds.ts
 *
 * Travel/city/nightlife background images for the login screen.
 * All entries are Unsplash travel photography in portrait orientation.
 *
 * Format: { uri: string } — CDN URL or local require()
 */

export interface LoginBackground {
  uri: string;
}

export const LOGIN_BACKGROUNDS: LoginBackground[] = [
  // Tokyo neon city streets at night
  { uri: 'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=800&h=1400' },
  // Tropical beach with turquoise water
  { uri: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=800&h=1400' },
  // Santorini white rooftops and sea views
  { uri: 'https://images.unsplash.com/photo-1516483638261-f4dbaf036963?auto=format&fit=crop&w=800&h=1400' },
  // Alpine mountain landscape at sunrise
  { uri: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=800&h=1400' },
  // Narrow European cobblestone alley
  { uri: 'https://images.unsplash.com/photo-1523906834658-6b0e951f5d27?auto=format&fit=crop&w=800&h=1400' },
  // Desert dunes at golden hour
  { uri: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?auto=format&fit=crop&w=800&h=1400' },
];

/** How long each image stays fully visible before the crossfade begins (ms). */
export const BG_DISPLAY_DURATION_MS = 9000;

/** Duration of the crossfade transition between images (ms). */
export const BG_FADE_DURATION_MS = 1500;
