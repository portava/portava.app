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

import type {
  FreshnessState,
  PublicPlaceRef,
  WallAction,
  WallCoverage,
  WallTruthClass,
} from './wallProjection.ts';

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
  /**
   * Sensing §108 truth class, carried from the server. A schedule is
   * `predicted`; an intel observation is `observed`/`corroborated`. The strip
   * renders the two differently so a prediction can never read as an
   * observation. Optional only so an older server response still parses; the
   * renderer treats an absent value as `unknown`, never as observed.
   */
  truthClass?: WallTruthClass;
  /** Sensing §108 coverage bucket. `unknown` ≠ none. */
  coverage?: WallCoverage;
  action?: WallAction;
}
