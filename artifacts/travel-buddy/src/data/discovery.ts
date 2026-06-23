/**
 * PROVISIONAL discovery seed for Cebu (Pass 1).
 * Hand-seeded. Every item carries source/status/verified. NOT verified truth.
 * UI must show soft labels ("Starter city notes", "Popular with travelers").
 * Replace later via real place data + attribution.
 *
 * USER IDs IN THIS FILE
 * ---------------------
 * `submittedBy.id` and `user.id` must be real `profiles.id` UUIDs (uuid v4) from
 * Supabase once discovery is backed by a real API query.  Until then:
 *
 *   - Entries whose contributor IS in the cebu.ts seed world (u_1, u_2, u_3…)
 *     keep their short seed ID — HighlightRing will fire but gracefully return
 *     nothing for non-existent highlights.
 *   - Entries whose contributor has NO matching seed profile omit `id` entirely
 *     (undefined).  HighlightRing skips the fetch and renders a plain avatar.
 *
 * When the discovery screen is refactored to fetch from Supabase, replace every
 * `id` value here with the real UUID returned by the API (profiles.id column).
 * @dev-only seed data — do not ship to production without a real data source.
 */
import type { Interest } from '../types/models';

export type DiscoverySource = 'seed' | 'traveler' | 'compass';
export type DiscoveryStatus = 'provisional' | 'sourced' | 'verified';

export interface DiscoveryItem {
  id: string;
  name: string;
  category: Interest | 'hidden_gem' | 'experience';
  neighborhood: string;
  city: string;
  blurb: string;            // "why it's special" / short note
  imageUrl?: string;
  submittedBy?: { name: string; avatarUrl: string; id?: string };
  savedCount?: number;
  source: DiscoverySource;
  status: DiscoveryStatus;
  verified: boolean;
}

const SEED = { source: 'seed' as const, status: 'provisional' as const, verified: false };

/** Top Compass pick — provisional, must use cautious wording in UI. */
export const compassPick: DiscoveryItem = {
  id: 'cp1', name: 'LIV Superclub', category: 'nightlife',
  neighborhood: 'IT Park', city: 'Cebu City',
  blurb: 'Often associated with Cebu’s nightlife scene.',
  savedCount: 0, ...SEED,
};

/** Two side cards beside the Compass pick. */
export const forYouSide: DiscoveryItem[] = [
  {
    id: 'sn1', name: 'Colon Street', category: 'culture',
    neighborhood: 'Downtown', city: 'Cebu City',
    blurb: 'Often associated with heritage travel — among the oldest streets in the country.',
    ...SEED,
  },
  {
    id: 'pw1', name: 'Kawasan Falls', category: 'adventure',
    neighborhood: 'Badian', city: 'Cebu',
    blurb: 'A popular travel theme: turquoise falls and canyoneering.',
    savedCount: 521, source: 'traveler', status: 'provisional', verified: false,
  },
];

/** Featured experiences — horizontal cards. */
export const featuredExperiences: DiscoveryItem[] = [
  { id: 'fx1', name: 'Lechon Crawl', category: 'food', neighborhood: 'Cebu City', city: 'Cebu', blurb: 'Often associated with the city’s lechon spots.', ...SEED },
  { id: 'fx2', name: 'Rooftop Bars', category: 'nightlife', neighborhood: 'IT Park', city: 'Cebu', blurb: 'Popular travel theme: skyline views after dark.', ...SEED },
  { id: 'fx3', name: 'Island Hopping', category: 'beach', neighborhood: 'Mactan & Olango', city: 'Cebu', blurb: 'A popular theme for beaches near Cebu.', ...SEED },
  { id: 'fx4', name: 'Cultural Spots', category: 'culture', neighborhood: 'Cebu City', city: 'Cebu', blurb: 'Often associated with history and churches.', ...SEED },
  { id: 'fx5', name: 'Spa & Wellness', category: 'wellness', neighborhood: 'Lahug', city: 'Cebu', blurb: 'A popular theme for relaxation and recharge.', ...SEED },
];

export const DISCOVERY_CATEGORIES = [
  'All', 'Food', 'Nightlife', 'Beach', 'Culture', 'Shopping', 'Wellness', 'Hidden Gems', 'More',
] as const;

/* ── Pass 2 seed: gems, neighborhoods, traveler picks, saved ── */

const TRAVELER = (name: string, avatarUrl: string, id?: string) => ({ name, avatarUrl, id });

export const hiddenGems: DiscoveryItem[] = [
  { id: 'hg1', name: 'The Backspace Cafe', category: 'hidden_gem', neighborhood: 'Lahug, Cebu City', city: 'Cebu', blurb: 'Cozy cafe with great coffee and quiet vibes.', submittedBy: TRAVELER('Anna', 'https://i.pravatar.cc/120?img=5', 'u_1'), ...SEED },
  { id: 'hg2', name: 'Sirao Garden', category: 'hidden_gem', neighborhood: 'Sirao, Cebu', city: 'Cebu', blurb: 'Flower garden with mountain views.', submittedBy: TRAVELER('Mark', 'https://i.pravatar.cc/120?img=12'), ...SEED },
  { id: 'hg3', name: 'Sugbo Mercado', category: 'hidden_gem', neighborhood: 'IT Park, Cebu City', city: 'Cebu', blurb: 'Food market with local vendors and live music.', submittedBy: TRAVELER('Jessa', 'https://i.pravatar.cc/120?img=9'), ...SEED },
  { id: 'hg4', name: 'Tamagas Falls', category: 'hidden_gem', neighborhood: 'Alegria, Cebu', city: 'Cebu', blurb: 'Hidden waterfall and natural lagoon.', submittedBy: TRAVELER('Carlo', 'https://i.pravatar.cc/120?img=15', 'u_3'), ...SEED },
  { id: 'hg5', name: 'Speakeasy Cebu', category: 'hidden_gem', neighborhood: 'Capitol Site', city: 'Cebu', blurb: 'Hidden bar with craft cocktails.', submittedBy: TRAVELER('Vince', 'https://i.pravatar.cc/120?img=33', 'u_2'), ...SEED },
];

export interface NeighborhoodVibe {
  id: string;
  vibe: string;            // "Best for Nightlife"
  area: string;            // "IT Park"
  tags: string[];
  blurb: string;
  source: DiscoverySource;
  status: DiscoveryStatus;
  verified: boolean;
}

export const neighborhoods: NeighborhoodVibe[] = [
  { id: 'nb1', vibe: 'Best for Nightlife', area: 'IT Park', tags: ['nightlife', 'food'], blurb: 'Often associated with bars, late food, and rooftop spots.', ...SEED },
  { id: 'nb2', vibe: 'Best for Food', area: 'Lahug', tags: ['food', 'cafes'], blurb: 'A popular travel theme: cafes and local eats.', ...SEED },
  { id: 'nb3', vibe: 'Best for Beach', area: 'Mactan Island', tags: ['beach', 'resorts'], blurb: 'Often associated with beaches and island hopping.', ...SEED },
  { id: 'nb4', vibe: 'Best for Culture', area: 'Cebu City', tags: ['culture', 'history'], blurb: 'A popular theme for heritage and churches.', ...SEED },
  { id: 'nb5', vibe: 'Best for Relaxation', area: 'Busay', tags: ['quiet', 'views'], blurb: 'Often associated with quiet stays and mountain views.', ...SEED },
];

export interface TravelerPick {
  id: string;
  user: { name: string; avatarUrl: string; id?: string };
  place: string;
  note: string;
  city: string;
  rating?: number;
  tag: string;
  timeAgo: string;
  source: DiscoverySource;
  status: DiscoveryStatus;
  verified: boolean;
}

export const travelerPicks: TravelerPick[] = [
  { id: 'tp1', user: TRAVELER('Leo', 'https://i.pravatar.cc/120?img=8'), place: 'The Distillery Cebu', note: 'Great cocktails and vibes!', city: 'Cebu City', rating: 4.6, tag: 'Nightlife', timeAgo: '2h ago', source: 'traveler', status: 'provisional', verified: false },
  { id: 'tp2', user: TRAVELER('Mia', 'https://i.pravatar.cc/120?img=20'), place: 'Casa Verde Cebu', note: 'Amazing Spanish food!', city: 'Cebu City', rating: 4.7, tag: 'Food', timeAgo: '5h ago', source: 'traveler', status: 'provisional', verified: false },
  { id: 'tp3', user: TRAVELER('Josh', 'https://i.pravatar.cc/120?img=14'), place: 'Virgin Island', note: 'Crystal clear waters.', city: 'Bantayan', rating: 4.8, tag: 'Beach', timeAgo: '1d ago', source: 'traveler', status: 'provisional', verified: false },
];

export interface SavedDiscoveryItem {
  id: string;
  name: string;
  type: string;            // Restaurant / Island / Cafe
  neighborhood: string;
}

export const savedIdeas: SavedDiscoveryItem[] = [
  { id: 'sv1', name: 'Cebu Lechon House', type: 'Restaurant', neighborhood: 'Lahug' },
  { id: 'sv2', name: 'Sumilon Island', type: 'Island', neighborhood: 'Oslob' },
  { id: 'sv3', name: 'La Vie Parisienne', type: 'Cafe', neighborhood: 'Cebu City' },
];
