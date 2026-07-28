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
