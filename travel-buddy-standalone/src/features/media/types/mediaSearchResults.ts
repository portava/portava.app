/**
 * features/media — the §38 search RESULT view-model (census-media §19).
 *
 * Mirrors what `GET /media/search` serves (artifacts/api-server/src/services/
 * media/MediaSearchService.ts `MediaSearchResults`, plus the `events` / `trips`
 * kinds `withCanonicalKinds` folds in): the seven §38 result types — Media,
 * Places, Hidden Gems, Events, Trips, Experiences, People.
 *
 * `undetermined` names lists the server could NOT read on this request; such a
 * list is empty because nobody looked, not because nothing matched, and the
 * screen says so. `unsupported` is the server's own statement of what search
 * cannot answer ("find places that look like this").
 *
 * Pure type module — no runtime imports.
 */
import type { FreshnessClass, MediaProjection } from './media.ts';
import type { MediaExperienceProjection } from './mediaExperience.ts';

export interface SearchPlaceResult {
  placeId: string;
  label: string | null;
  neighborhood: string | null;
  city: string | null;
  country: string | null;
  perspectiveCount: number;
  freshPerspectiveCount: number;
  freshness: FreshnessClass | null;
}

export interface SearchPersonResult {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  verified: boolean;
  isOfficial: boolean;
  perspectiveCount: number;
}

export interface SearchGemResult {
  gemId: string;
  name: string | null;
  placeId: string;
}

/** An Event or Trip found by what it IS (its title), through its own gate. */
export interface SearchCanonicalResult {
  id: string;
  kind: 'event' | 'trip';
  title: string | null;
  startedAt: string | null;
  expectedEndAt: string | null;
  placeIds: string[];
  perspectiveCount: number;
  freshness: FreshnessClass | null;
}

export interface MediaSearchResultsView {
  generatedAt: string | null;
  /** The criteria the server actually applied. Empty ⇒ every list is empty. */
  criteriaUsed: string[];
  media: MediaProjection[];
  places: SearchPlaceResult[];
  people: SearchPersonResult[];
  hiddenGems: SearchGemResult[];
  experiences: MediaExperienceProjection[];
  events: SearchCanonicalResult[];
  trips: SearchCanonicalResult[];
  unsupported: string[];
  undetermined: string[];
}
