/**
 * contextThread (client mirror) — the compact bridge from a social object to
 * Portava's surrounding functions (Wall spec §8/§9).
 *
 * Mirrors artifacts/api-server/src/lib/wallProjection.ts. The §9 eligibility
 * gate runs SERVER-SIDE: a projection only carries a `contextThread` when the
 * server decided it earned the space. The client never re-derives the gate; it
 * only renders what arrived, and renders it quieter than the post (spec §35).
 */

import type { FreshnessState, WallAction } from './wallProjection.ts';

export type ContextThreadKind =
  | 'live_place'
  | 'trip_relevance'
  | 'hidden_gem'
  | 'social_presence'
  | 'buddy'
  | 'map'
  | 'memory'
  | 'compass';

export interface ContextThread {
  kind: ContextThreadKind;
  label: string;
  freshness?: FreshnessState;
  /** 0–1 confidence in the contextual fact. */
  confidence?: number;
  /** Short human-readable "why" (spec §8). Never asserts inference as fact (§21). */
  reason?: string;
  action?: WallAction;
}
