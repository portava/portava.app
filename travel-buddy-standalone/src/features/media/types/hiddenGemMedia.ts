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

// ── §16 Hidden Gems LENS (GET /media/gems) ────────────────────────────────────
//
// The shapes below mirror artifacts/api-server/src/services/media/
// MediaGemStateService.ts `MediaGemStateItem` / `MediaGemStateProjection` field
// for field. `HiddenGemMediaProjection` above is an OLDER client-side guess at a
// gem payload that no endpoint has ever sent (it reads `title` / `id` /
// `areaLabel`; the server sends `name` / `gemId` / `neighborhood`), so the lens
// is typed against what the server actually serves.

/** One gem as the §16 lens serves it: derived STATE, never a popularity rank. */
export interface HiddenGemLensItem {
  gemId: string;
  /** Present only for a gem `mayDiscloseGemIdentity` allowed the server to name. */
  name: string | null;
  /** Opaque canonical place id — geometry comes from the canonical Map, never here. */
  placeId: string | null;
  category: string | null;
  /** Coarse labels only (§16.2). There is no coordinate field, by construction. */
  neighborhood: string | null;
  city: string | null;
  country: string | null;
  /** The §16 ten-state semantic state, derived at read time server-side. */
  state: HiddenGemState;
  /** Bounded evidence score + band. `save_count` is not an input (§16.2). */
  confidence: { score: number; band: string };
  /** Per-type §16.3 observation counts (evidence, not popularity). */
  contributionCounts: Partial<Record<string, number>>;
  verificationLevel: string | null;
  lastUpdatedAt: string | null;
  /** The gem's own submitted image, when it has one. Null ⇒ the card draws its marker. */
  imageUrl: string | null;
}

/** The whole §16 lens payload. `determined:false` is NOT "no gems here". */
export interface HiddenGemLensProjection {
  generatedAt: string | null;
  city: string | null;
  gems: HiddenGemLensItem[];
  total: number;
  /** False when any server read behind the lens failed. */
  determined: boolean;
  /** Which reads failed: 'gems' (the list itself) or 'gemState' (the aggregates). */
  undetermined: string[];
}
