/**
 * features/media — §17 Time Architecture client types (Earlier / Now / Typical /
 * Likely-Next).
 *
 * These mirror the merged backend contract served by GET /media/timeline
 * (artifacts/api-server/src/lib/media/mediaTimeBands.ts): four bands, each item
 * carrying a coarse render class (observed / typical / predicted), a hard `live`
 * flag that may be true ONLY for a gated Now observation, and — for a forecast —
 * a confidence in [0,1] plus its display band.
 *
 * The client mapper (services/mediaProjection.ts) re-enforces the truth boundary
 * defensively: a non-observation item is never allowed to keep a `live` flag, and
 * a forecast without confidence is dropped. So these types describe the ALREADY
 * SANITISED view model the rail renders.
 *
 * Pure type module — no runtime imports, safe for node:test.
 */
import type { MediaProjection } from './media.ts';

/** The four §17 bands, in temporal order. */
export type TimeBandKind = 'earlier' | 'now' | 'typical' | 'likelyNext';

/**
 * Coarse render bucket the client keys distinct visual treatments off (§46):
 *   observed  → firsthand media / a gated live observation (teal)
 *   typical   → a historical pattern, derived/inferred (indigo)
 *   predicted → a forecast / likely-next, carries confidence (amber, dashed)
 */
export type TimeBandRenderClass = 'observed' | 'typical' | 'predicted';

/** Display confidence band a forecast carries (backend intelContracts). */
export type TimeConfidenceBand =
  | 'unverified'
  | 'provisional'
  | 'likely_current'
  | 'live'
  | 'strong';

/** One item on a time band — coarse by construction (never a coordinate). */
export interface TimelineBandItem {
  itemKind: 'media' | 'liveClaim' | 'pattern' | 'prediction';
  renderClass: TimeBandRenderClass;
  /** Observed / derivation time (ISO). Null when the payload omitted it. */
  observedAt: string | null;
  /** Coarse human label, e.g. "Typical pattern · busyness". Never a coordinate. */
  label: string | null;
  claimType: string | null;
  /** Forecast confidence in [0,1]; non-null for EVERY surviving prediction (§17). */
  confidence: number | null;
  /** Display confidence band; non-null for every surviving prediction (§17). */
  confidenceBand: TimeConfidenceBand | null;
  /**
   * True ONLY for a gated live observation in the Now band. The mapper forces
   * this false on every non-observation item and on every non-Now band — a
   * prediction / pattern can never reach the rail as live (§46.2).
   */
  live: boolean;
  /** The projected media object for an observed Earlier item; null otherwise. */
  media: MediaProjection | null;
}

/** One of the four §17 bands. */
export interface TimelineBand {
  key: TimeBandKind;
  label: string;
  renderClass: TimeBandRenderClass;
  /** True only for Now, and only when the gated read served a live claim. */
  live: boolean;
  /** True only for Likely-Next. */
  forecast: boolean;
  count: number;
  items: TimelineBandItem[];
}

/** The full §17 four-band projection (GET /media/timeline `bands`). */
export interface TimelineBands {
  earlier: TimelineBand;
  now: TimelineBand;
  typical: TimelineBand;
  likelyNext: TimelineBand;
}

/** The mapped GET /media/timeline projection the client consumes. */
export interface MediaTimelineProjection {
  generatedAt: string | null;
  bands: TimelineBands;
}
