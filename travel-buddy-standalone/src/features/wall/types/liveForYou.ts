/**
 * liveForYou (client mirror) — the compact, bounded Live For You strip
 * (Wall spec §4 / TABLE 0).
 *
 * Mirrors artifacts/api-server/src/lib/wallProjection.ts. Every item is already
 * privacy-safe and viewer-relevant: NO contributor ids, raw coordinates, exact
 * cohort counts or private-location leakage. The client shows 2–4 items, never
 * a city-wide firehose, and degrades an item to "unknown" once it passes
 * `validUntil` (spec §31 — no stale live labels).
 */

import type { FreshnessState, PublicPlaceRef, WallAction } from './wallProjection.ts';

export type LiveObjectType =
  | 'place_state'
  | 'event_state'
  | 'hidden_gem'
  | 'social_presence'
  | 'buddy'
  | 'trip_signal';

export interface LiveForYouItem {
  /** The live snapshot / claim id — the provenance the "why" surface points at. */
  id: string;
  liveObjectType: LiveObjectType;
  /** The canonical subject (place/zone) this live fact is about. */
  subjectId: string;
  subject?: PublicPlaceRef;
  label: string;
  freshness: FreshnessState;
  /** 0–1; may be null when the source class may not present a confidence badge. */
  confidence?: number | null;
  state: 'live' | 'emerging';
  /**
   * IG §10 conflict state of the claim behind the item (mirror of api-server
   * `LiveForYouItem.conflictState`). 'material' ⇒ `state` is 'emerging' and the
   * strip says "Reports differ" instead of Live now / Emerging. Absent ⇒ none.
   */
  conflictState?: 'none' | 'minor' | 'material';
  observedAt: string;
  /** Freshness horizon — after this the client degrades to unknown (spec §31). */
  validUntil: string;
  action?: WallAction;
}
