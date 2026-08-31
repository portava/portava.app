/**
 * features/media — experience projection types (spec §23/§23.1).
 *
 * Media organized around real-world experiences (Sunset at My Khe, Beach
 * Festival, Friday Night An Thuong) and experience chains
 * (Dinner → Rooftop → Nightclub).
 *
 * Pure type module — no runtime imports.
 */
import type { ConfidenceState, FreshnessClass, MediaProjection } from './media.ts';

/** Lifecycle state of a live/temporary experience (§17/§23). */
export type ExperienceState =
  | 'upcoming'
  | 'starting'
  | 'building'
  | 'peak'
  | 'winding_down'
  | 'ended'
  | 'typical';

export interface MediaExperienceProjection {
  id: string;
  title: string;
  placeIds: string[];
  eventId?: string | null;
  tripId?: string | null;
  startedAt?: string | null;
  expectedEndAt?: string | null;
  currentState?: ExperienceState | null;
  perspectiveCount: number;
  contributorCount: number;
  freshness: FreshnessClass;
  confidence?: ConfidenceState | null;
  heroMedia: MediaProjection[];
}

/** A step in an experience chain (§23.1). */
export interface ExperienceChainStep {
  placeId: string | null;
  label: string;
  perspectiveCount: number;
  cover?: MediaProjection | null;
}

/** Dinner → Rooftop → Nightclub (§23.1). */
export interface ExperienceChain {
  id: string;
  title: string;
  steps: ExperienceChainStep[];
  freshness: FreshnessClass;
}
