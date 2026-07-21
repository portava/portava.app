/**
 * Shared Discovery types for the Travel Buddy mobile app.
 *
 * DiscoveryEventPost mirrors the server-side shape returned by
 * GET /api/discovery/feed in the `posts` array.
 */

export interface DiscoveryEventPost {
  id: string;
  authorId: string;
  content: string;
  mediaUrls: string[];
  venueName: string | null;
  locationCity: string | null;
  publicLat: number | null;
  publicLng: number | null;
  createdAt: string;
  likeCount: number;
  commentCount: number;
  linkedEventId: string | null;
  linkedEventTitle: string | null;
  venueLabel: string | null;
  sourceKind: 'event_link' | 'venue_category';
}
