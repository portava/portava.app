/**
 * features/media — perspective + place-current-view types (spec §12/§13/§14).
 *
 * A "perspective" is a permitted visual contribution showing an aspect of a
 * place or experience (Street / Entrance / Rooftop / …). It is explicitly NOT
 * an analytics "view" (§12). Perspective grouping is resolved server-side; the
 * client only renders the groups it is handed.
 *
 * Pure type module — no runtime imports.
 */
import type { ConfidenceState, MediaProjection } from './media.ts';

/** Trend of activity at a place / zone (§13, §17, §20). */
export type ActivityTrend = 'rising' | 'steady' | 'falling';

/**
 * A perspective group for an entity, e.g. Nightclub → Entrance · Queue · Street
 * · Main Room · Stage · Bar · VIP · Outside (spec entity→perspective table).
 * `key` is a stable slug; `label` is the display string.
 */
export interface PerspectiveGroup {
  key: string;
  label: string;
  /** Fresh perspective count in this group (§12 "24 fresh perspectives"). */
  count: number;
  /** Optional cover for the group tile. */
  cover?: MediaProjection | null;
}

/**
 * The "current picture" summary for a place/experience (§13).
 * Strength maps to copy like "Strong current picture".
 */
export interface CurrentPicture {
  strength: ConfidenceState;
  /** ISO timestamp of the most recent perspective feeding the picture. */
  updatedAt: string | null;
  /** Minutes since the most recent perspective (for "Updated 2m ago"). */
  ageMinutes: number | null;
  perspectiveCount: number;
  contributorCount: number;
  /** Independent sources — corroboration signal (§12/§18). */
  sourceCount: number;
  trend: ActivityTrend;
}

/** Place Current View projection (§13). */
export interface PlaceCurrentView {
  placeId: string;
  placeName: string;
  /** Short human state, e.g. "Getting busier" (§13). */
  stateLabel: string | null;
  currentPicture: CurrentPicture;
  groups: PerspectiveGroup[];
  heroMedia: MediaProjection[];
  /** Neighborhood / city label for the header. */
  areaName?: string | null;
}
