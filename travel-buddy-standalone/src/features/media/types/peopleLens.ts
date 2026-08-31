/**
 * features/media — People lens projection types (spec §27).
 *
 * The People lens is EXPLICITLY social: it prioritizes followed users, Trip
 * Crew, Shared Moment participants, and relevant creators. The §43 /media/people
 * projection groups eligible perspectives BY contributor (server-side), so the
 * client renders per-person sections rather than a flat feed — creator identity
 * is visible but the lens still leads with the perspectives, not vanity metrics
 * (§46). Uploading media never implies a precise live location (§27).
 *
 * Pure type module — no runtime imports.
 */
import type { FreshnessClass, MediaContributor, MediaProjection } from './media.ts';

/** One contributor's group of perspectives in the People lens. */
export interface PeopleLensGroup {
  contributor: MediaContributor;
  perspectiveCount: number;
  freshness: FreshnessClass;
  /** Newest-first sample of that person's eligible perspectives. */
  media: MediaProjection[];
}

/** The full People lens projection (GET /media/people, §43). */
export interface PeopleLensProjection {
  people: PeopleLensGroup[];
  generatedAt: string | null;
}
