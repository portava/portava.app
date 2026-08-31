/**
 * features/media — My World (owner library) projection types (spec §29/§30).
 *
 * The owner's own library and personal experience history, organized into
 * buckets (All · Posts · Postcards · Memories · Trips · Tagged · Hidden Gems)
 * plus owner-only operational buckets (Drafts · Archived · Processing). Passport
 * remains the primary Postcard surface — this lens does not duplicate the full
 * Passport media product (§29).
 *
 * Pure type module — no runtime imports.
 */
import type { MediaProjection } from './media.ts';

/** One collection of the owner's media (§30). */
export interface MyWorldBucket {
  /** Stable key, e.g. 'all' | 'posts' | 'trips' | 'drafts' | 'gems'. */
  key: string;
  label: string;
  /** True for operational buckets only the owner may see (drafts/archived/processing). */
  ownerOnly: boolean;
  /** Total items in the bucket (may exceed `media.length`, which is a bounded sample). */
  count: number;
  media: MediaProjection[];
}

/** The full My World projection (GET /media/me, §43). */
export interface MyWorldLibrary {
  buckets: MyWorldBucket[];
  generatedAt: string | null;
}
