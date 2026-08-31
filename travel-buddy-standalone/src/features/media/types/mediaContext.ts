/**
 * features/media — World/NOW dashboard + navigation types (spec §3/§4.1/§20/§47).
 *
 * The 6-lens primary navigation and the NOW dashboard projection. The default
 * Media page is a visual dashboard of the world, NOT a list of creator posts
 * (§4.1, §46.2).
 *
 * Pure type module — no runtime imports.
 */
import type { FreshnessClass, MediaProjection } from './media.ts';
import type { ActivityTrend } from './perspective.ts';

// ── 6-lens primary navigation (§3) ────────────────────────────────────────────
export type MediaLens =
  | 'now'
  | 'places'
  | 'experiences'
  | 'gems'
  | 'people'
  | 'my_world';

// ── Presentation modes per lens (§5 table) ────────────────────────────────────
export type PresentationMode =
  | 'overview'
  | 'visual'
  | 'map'
  | 'time'
  | 'grid'
  | 'timeline';

// ── City visual state (§4.1, §20) ─────────────────────────────────────────────
// An Thuong ↑ Building · Beach Festival ● Peak · Riverside ↑ Starting …
export type CityZoneState =
  | 'starting'
  | 'building'
  | 'peak'
  | 'moderate'
  | 'quiet'
  | 'winding_down';

export interface CityVisualZone {
  id: string;
  name: string;
  /**
   * Qualitative activity state. OPTIONAL / nullable on purpose: the §43 world
   * projection only carries a state when a gated Live Intelligence claim exists
   * for the zone. With no live claim the server emits none, and the client must
   * NOT fabricate one (§46 "no fake-live treatment", §46.2). A null state renders
   * as a neutral row (name + perspective count + freshness) with no pulse chip.
   */
  state?: CityZoneState | null;
  trend?: ActivityTrend | null;
  /** Fresh perspective count in this zone (drives no vanity counter — optional). */
  perspectiveCount?: number | null;
  freshness?: FreshnessClass | null;
}

// ── "For You Now" strip (§4.1) ────────────────────────────────────────────────
// Nightlife · 18 fresh perspectives / Hidden Gems · 6 recently confirmed
export type ForYouNowKind =
  | 'fresh_perspectives'
  | 'recently_confirmed'
  | 'changing'
  | 'seasonal';

export interface ForYouNowItem {
  id: string;
  category: string; // e.g. "Nightlife", "Food", "Hidden Gems"
  count: number;
  kind: ForYouNowKind;
  /** Lens to open when tapped (defaults resolved by the screen). */
  lens?: MediaLens | null;
  entityId?: string | null;
}

// ── "Changing Now" cards (§4.1, §20, §22) ─────────────────────────────────────
export interface ChangingNowItem {
  id: string;
  title: string;
  subtitle?: string | null;
  /**
   * Nullable for the same reason as CityVisualZone.state — a "changing now" card
   * only carries a qualitative state when the gated live path served a crowd
   * claim. Absent → the card shows no fabricated state chip (§46/§46.2).
   */
  state?: CityZoneState | null;
  trend?: ActivityTrend | null;
  freshness: FreshnessClass;
  /** Short human freshness label, e.g. "Updated 4m ago" — never fake-live. */
  freshnessLabel?: string | null;
  /** Pre-computed why-this explanation (§47). */
  whyThis?: string | null;
  heroMedia?: MediaProjection[];
  placeId?: string | null;
}

// ── The full NOW / World projection (GET /media/world, §43) ───────────────────
export interface MediaCity {
  id: string | null;
  name: string;
  timezone?: string | null;
}

export interface MediaWorldProjection {
  city: MediaCity | null;
  cityVisualState: CityVisualZone[];
  forYouNow: ForYouNowItem[];
  changingNow: ChangingNowItem[];
  /** ISO timestamp the projection was computed (drives "as of" labeling, §39). */
  generatedAt: string | null;
}
