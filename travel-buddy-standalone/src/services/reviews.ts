import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

export type ReviewEntityType = 'event' | 'trip' | 'rent_buddy_booking' | 'place';

export interface ReviewTag {
  label: string;
  value: string;
}

export const REVIEW_TAGS: ReviewTag[] = [
  { value: 'safe',         label: 'Safe' },
  { value: 'friendly',     label: 'Friendly' },
  { value: 'on_time',      label: 'On Time' },
  { value: 'great_host',   label: 'Great Host' },
  { value: 'well_planned', label: 'Well Planned' },
  { value: 'inclusive',    label: 'Inclusive' },
  { value: 'misleading',   label: 'Misleading' },
  { value: 'disorganized', label: 'Disorganized' },
  { value: 'no_show',      label: 'No Show' },
];

export interface ReviewAuthor {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface Review {
  id: string;
  rating: number;
  body: string | null;
  tags: string[];
  anonymous: boolean;
  createdAt: string;
  reviewer: ReviewAuthor | null;
}

export interface ReviewsResponse {
  reviews: Review[];
  avgRating: number | null;
  total: number;
  page: number;
  limit: number;
}

export interface UserReviewsResponse {
  avgRating: number | null;
  reviewCount: number;
  reviews: Array<Review & { entityType: ReviewEntityType; entityId: string }>;
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await freshToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const api = (path: string) => `${apiBase}/api/${path}`;

export async function createReview(params: {
  entityType: ReviewEntityType;
  entityId: string;
  rating: number;
  body?: string;
  tags?: string[];
  anonymous?: boolean;
}): Promise<Review> {
  const res = await fetch(api('reviews'), {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      entityType: params.entityType,
      entityId:   params.entityId,
      rating:     params.rating,
      body:       params.body,
      tags:       params.tags ?? [],
      anonymous:  params.anonymous ?? false,
    }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw Object.assign(new Error((json as any).message ?? 'Failed to create review'), {
      code: (json as any).error,
    });
  }
  return res.json();
}

export async function getTripReviews(
  tripId: string,
  page = 1,
  limit = 20,
): Promise<ReviewsResponse> {
  const res = await fetch(api(`trips/${tripId}/reviews?page=${page}&limit=${limit}`), {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error('Failed to load trip reviews');
  return res.json();
}

export async function getUserReviews(userId: string, limit = 10): Promise<UserReviewsResponse> {
  const res = await fetch(api(`users/${userId}/reviews?limit=${limit}`), {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error('Failed to load user reviews');
  return res.json();
}

export async function reportReview(reviewId: string, reason: string): Promise<void> {
  const res = await fetch(api(`reviews/${reviewId}/report`), {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error((json as any).message ?? 'Failed to report review');
  }
}

export interface MyReviewResult {
  exists: boolean;
  reviewId: string | null;
  rating?: number;
  body?: string | null;
  tags?: string[];
  anonymous?: boolean;
}

export async function getMyReview(
  entityType: ReviewEntityType,
  entityId: string,
): Promise<MyReviewResult> {
  const params = new URLSearchParams({ entityType, entityId });
  const res = await fetch(api(`reviews/my-review?${params.toString()}`), {
    headers: await authHeaders(),
  });
  if (!res.ok) {
    // Treat errors as "not reviewed" so the UI doesn't block the user
    return { exists: false, reviewId: null };
  }
  return res.json();
}

export interface UpdatedReview {
  id: string;
  rating: number;
  body: string | null;
  tags: string[];
  anonymous: boolean;
  updatedAt: string;
}

export async function updateReview(
  reviewId: string,
  params: {
    rating?: number;
    body?: string | null;
    tags?: string[];
    anonymous?: boolean;
  },
): Promise<UpdatedReview> {
  const res = await fetch(api(`reviews/${reviewId}`), {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw Object.assign(
      new Error((json as any).message ?? 'Failed to update review'),
      { code: (json as any).error },
    );
  }
  return res.json();
}

export async function deleteReview(reviewId: string): Promise<void> {
  const res = await fetch(api(`reviews/${reviewId}`), {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error('Failed to delete review');
}

export async function getPlaceReviews(
  placeId: string,
  page = 1,
  limit = 20,
): Promise<ReviewsResponse> {
  const res = await fetch(api(`places/${placeId}/reviews?page=${page}&limit=${limit}`), {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error('Failed to load place reviews');
  return res.json();
}

// ── Event reviews (uses the legacy event_reviews endpoint in events.ts) ───────

export interface EventReviewsResponse {
  reviews: Review[];
  page: number;
  limit: number;
}

export async function createEventReview(params: {
  eventId: string;
  rating: number;
  body?: string;
  anonymous?: boolean;
}): Promise<Review> {
  const res = await fetch(api(`events/${params.eventId}/reviews`), {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      rating:    params.rating,
      body:      params.body,
      anonymous: params.anonymous ?? false,
    }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw Object.assign(
      new Error((json as any).message ?? 'Failed to create event review'),
      { code: (json as any).error },
    );
  }
  return res.json();
}

export async function getEventReviews(
  eventId: string,
  page = 1,
  limit = 20,
): Promise<EventReviewsResponse> {
  const res = await fetch(api(`events/${eventId}/reviews?page=${page}&limit=${limit}`), {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error('Failed to load event reviews');
  return res.json();
}
