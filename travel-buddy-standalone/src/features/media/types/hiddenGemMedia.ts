/**
 * features/media — hidden-gem media types (spec §16/§16.2/§46.1).
 *
 * Hidden Gems are first-class and require STRONGER protection than normal
 * Places. Ranking is never popularity-first, and paid promotion never raises
 * factual confidence (§16.2). The client uses distinct discovery/protection
 * visual language (§46.1) and avoids Viral/Trending/Hot/counter language.
 *
 * Pure type module — no runtime imports.
 */
import type { FreshnessClass, MediaProjection } from './media.ts';

/** Current gem state (§16). */
export type HiddenGemState =
  | 'recently_confirmed'
  | 'still_hidden'
  | 'quiet_now'
  | 'getting_discovered'
  | 'seasonal'
  | 'hard_to_find'
  | 'access_changed'
  | 'temporarily_unavailable'
  | 'overcrowding_risk'
  | 'no_longer_hidden';

/**
 * Location precision for a gem (§16.2). Exact location may remain hidden until
 * deliberate open; sensitive/fragile sites get approximate area only.
 */
export type GemLocationPrecision = 'hidden' | 'approximate' | 'area' | 'open';

export interface HiddenGemMediaProjection {
  id: string;
  title: string;
  state: HiddenGemState;
  freshness: FreshnessClass;
  /** Approximate area label only, never precise GPS (§16.2, HARD CONSTRAINT). */
  areaLabel: string | null;
  locationPrecision: GemLocationPrecision;
  /** e.g. "Worth the detour", "Quiet right now" (§16 collections). */
  collectionLabel?: string | null;
  confirmationCount: number;
  cover?: MediaProjection | null;
}
