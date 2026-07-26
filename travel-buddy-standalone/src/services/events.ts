/**
 * Events service — typed wrappers over /api/events/*.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const BASE = (() => {
  const domain = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  return domain.endsWith('/') ? domain.slice(0, -1) : domain;
})();

/** Converts server-relative /api/... cover URLs to absolute so React Native image loaders work. */
function resolveApiUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/')) return `${BASE}${url}`;
  return url;
}

function normalizeEventSummary(e: EventSummary): EventSummary {
  return e.coverUrl != null ? { ...e, coverUrl: resolveApiUrl(e.coverUrl) } : e;
}

function normalizeEventDetail(e: EventDetail): EventDetail {
  return e.coverUrl != null ? { ...e, coverUrl: resolveApiUrl(e.coverUrl) } : e;
}

export type EventState =
  | 'draft' | 'open' | 'full' | 'waitlist' | 'started' | 'completed' | 'cancelled' | 'archived';

export type EventVisibility = 'public' | 'friends_only' | 'invite_only' | 'circle' | 'trip';

export type EventRsvpStatus = 'going' | 'maybe' | 'interested' | 'cant_go';

export type EventRoleType = 'host' | 'co_host' | 'moderator' | 'banned';

export interface EventAttendeeProfile {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface EventCounts {
  going: number;
  maybe: number;
  interested: number;
  cant_go: number;
}

export interface EventAttendeeState {
  eventId: string;
  userId: string;
  checkedInAt: string | null;
  confirmedAt: string | null;
  noShowAt: string | null;
}

export interface EventSummary {
  id: string;
  hostId: string;
  hostName: string | null;
  hostAvatarUrl: string | null;
  title: string;
  description: string | null;
  locationName: string | null;
  locationLat: number | null;
  locationLng: number | null;
  startsAt: string | null;
  endsAt: string | null;
  coverUrl: string | null;
  coverMediaType: 'image' | 'video' | null;
  /** Who last set the cover image — used by the priority guard to prevent AI images from overwriting user uploads. */
  coverSource?: string | null;
  maxAttendees: number | null;
  ageMin: number | null;
  ageMax: number | null;
  trustScoreMin: number | null;
  verifiedOnly: boolean;
  visibility: EventVisibility;
  state: EventState;
  chatEnabled: boolean;
  chatThreadId: string | null;
  waitlistEnabled: boolean;
  priceType: 'free' | 'external' | null;
  priceUrl: string | null;
  rsvpOptions: EventRsvpStatus[];
  goingCount: number;
  waitlistCount: number;
  category: string | null;
  city: string | null;
  country: string | null;
  rsvpClosed: boolean;
  showExactLocation: boolean;
  isHost: boolean;
  /** Whether the host has opted in to showing the cover image to non-members. */
  showHeaderPublicly?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EventDetail extends EventSummary {
  host: EventAttendeeProfile | null;
  counts: EventCounts;
  waitlistCount: number;
  myRsvp: EventRsvpStatus | null;
  myJoinRequestStatus: 'pending' | 'approved' | 'denied' | null;
  myWaitlistPosition: number | null;
  myWaitlistOfferExpiresAt: string | null;
  myRole: EventRoleType | null;
  myAttendanceState: EventAttendeeState | null;
  goingAttendees: EventAttendeeProfile[];
}

export interface EventListItem extends EventSummary {
  myRsvp: EventRsvpStatus | null;
  myWaitlistPosition?: number | null;
  isSaved?: boolean;
  distanceKm?: number;
}

export interface JoinRequest {
  id: string;
  userId: string;
  status: 'pending' | 'approved' | 'denied';
  message: string | null;
  createdAt: string;
  user: EventAttendeeProfile | null;
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  message?: string;
}

async function freshToken(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    return freshApiToken();
  } catch {
    return null;
  }
}

async function apiCall<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Not authenticated' };

  try {
    const r = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: json.message ?? json.error ?? `HTTP ${r.status}` };
    return { ok: true, data: json as T };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? 'Network error' };
  }
}

// ── Create event ──────────────────────────────────────────────────────────────

export interface CreateEventInput {
  title: string;
  description?: string;
  locationName?: string;
  locationLat?: number;
  locationLng?: number;
  startsAt?: string;
  endsAt?: string;
  coverUrl?: string | null;
  coverMediaType?: 'image' | 'video' | null;
  /** Pixel width of the cover image (stored for OG preview tags). */
  coverImageWidth?: number | null;
  /** Pixel height of the cover image (stored for OG preview tags). */
  coverImageHeight?: number | null;
  maxAttendees?: number | null;
  ageMin?: number | null;
  ageMax?: number | null;
  trustScoreMin?: number | null;
  verifiedOnly?: boolean;
  visibility?: EventVisibility;
  chatEnabled?: boolean;
  waitlistEnabled?: boolean;
  priceType?: 'free' | 'external';
  priceUrl?: string | null;
  rsvpOptions?: EventRsvpStatus[];
  category?: string;
  city?: string;
  country?: string;
  publishNow?: boolean;
  /** Whether non-members can see the event's cover image. */
  showHeaderPublicly?: boolean;
}

export async function createEvent(input: CreateEventInput): Promise<ApiResult<EventSummary>> {
  const r = await apiCall<EventSummary>('/api/events', { method: 'POST', body: JSON.stringify(input) });
  return r.ok ? { ok: true, data: normalizeEventSummary(r.data!) } : r;
}

// ── List events ───────────────────────────────────────────────────────────────

export interface ListEventsParams {
  state?: EventState | 'all';
  city?: string;
  category?: string;
  dateFrom?: string;
  dateTo?: string;
  nearLat?: number;
  nearLng?: number;
  nearRadiusKm?: number;
  free?: boolean;
  verifiedHostOnly?: boolean;
  capacityAvailable?: boolean;
  page?: number;
  limit?: number;
}

export async function listEvents(
  params: ListEventsParams = {},
): Promise<ApiResult<{ events: EventListItem[]; page: number; limit: number }>> {
  const qs = new URLSearchParams();
  if (params.state)           qs.set('state', params.state);
  if (params.city)            qs.set('city', params.city);
  if (params.category)        qs.set('category', params.category);
  if (params.dateFrom)        qs.set('dateFrom', params.dateFrom);
  if (params.dateTo)          qs.set('dateTo', params.dateTo);
  if (params.nearLat != null) qs.set('nearLat', String(params.nearLat));
  if (params.nearLng != null) qs.set('nearLng', String(params.nearLng));
  if (params.nearRadiusKm)        qs.set('nearRadiusKm', String(params.nearRadiusKm));
  if (params.free)                qs.set('free', '1');
  if (params.verifiedHostOnly)    qs.set('verifiedHostOnly', '1');
  if (params.capacityAvailable)   qs.set('capacityAvailable', '1');
  if (params.page)            qs.set('page', String(params.page));
  if (params.limit)           qs.set('limit', String(params.limit));
  const q = qs.toString();
  return apiCall(`/api/events${q ? `?${q}` : ''}`);
}

// ── My events (hosting + attending) ──────────────────────────────────────────

export async function listMyEvents(
  limit = 20,
): Promise<ApiResult<{ events: EventListItem[] }>> {
  return apiCall(`/api/events/me?limit=${limit}`);
}

// ── Get event detail ──────────────────────────────────────────────────────────

export async function getEvent(eventId: string): Promise<ApiResult<EventDetail>> {
  const r = await apiCall<EventDetail>(`/api/events/${eventId}`);
  return r.ok ? { ok: true, data: normalizeEventDetail(r.data!) } : r;
}

// ── Update event ──────────────────────────────────────────────────────────────

export interface UpdateEventInput {
  title?: string;
  description?: string | null;
  locationName?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  coverUrl?: string | null;
  coverMediaType?: 'image' | 'video' | null;
  /** Pixel width of the cover image (stored for OG preview tags). */
  coverImageWidth?: number | null;
  /** Pixel height of the cover image (stored for OG preview tags). */
  coverImageHeight?: number | null;
  maxAttendees?: number | null;
  ageMin?: number | null;
  ageMax?: number | null;
  trustScoreMin?: number | null;
  verifiedOnly?: boolean;
  visibility?: EventVisibility;
  state?: 'draft' | 'open' | 'started' | 'completed' | 'cancelled' | 'archived';
  chatEnabled?: boolean;
  waitlistEnabled?: boolean;
  attendeeCommentsEnabled?: boolean;
  priceType?: 'free' | 'external' | null;
  priceUrl?: string | null;
  category?: string | null;
  city?: string | null;
  country?: string | null;
  /** Whether non-members can see the event's cover image. */
  showHeaderPublicly?: boolean;
}

export async function updateEvent(eventId: string, input: UpdateEventInput): Promise<ApiResult<EventSummary>> {
  const r = await apiCall<EventSummary>(`/api/events/${eventId}`, { method: 'PATCH', body: JSON.stringify(input) });
  return r.ok ? { ok: true, data: normalizeEventSummary(r.data!) } : r;
}

// ── Cancel event ──────────────────────────────────────────────────────────────

export async function cancelEvent(eventId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall<{ ok: boolean }>(`/api/events/${eventId}`, { method: 'DELETE' });
}

// ── RSVP ─────────────────────────────────────────────────────────────────────

export async function rsvpEvent(
  eventId: string,
  status: EventRsvpStatus,
): Promise<ApiResult<{ status: string; eventId: string } | { status: 'waitlisted'; message: string }>> {
  return apiCall(`/api/events/${eventId}/rsvp`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

export async function leaveEvent(eventId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall<{ ok: boolean }>(`/api/events/${eventId}/rsvp`, { method: 'DELETE' });
}

// ── Waitlist ──────────────────────────────────────────────────────────────────

export async function joinWaitlist(eventId: string): Promise<ApiResult<{ position: number }>> {
  return apiCall<{ position: number }>(`/api/events/${eventId}/waitlist`, { method: 'POST' });
}

export async function leaveWaitlist(eventId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall<{ ok: boolean }>(`/api/events/${eventId}/waitlist`, { method: 'DELETE' });
}

export interface WaitlistEntry {
  userId: string;
  position: number;
  offerExpiresAt: string | null;
  user: { handle: string; displayName: string | null; avatarUrl: string | null } | null;
}

export async function getEventWaitlist(
  eventId: string,
): Promise<ApiResult<{ waitlist: WaitlistEntry[] }>> {
  return apiCall<{ waitlist: WaitlistEntry[] }>(`/api/events/${eventId}/waitlist`);
}

// ── Join requests ─────────────────────────────────────────────────────────────

export async function requestToJoinEvent(
  eventId: string,
  message?: string,
): Promise<ApiResult<{ ok: boolean; status: string }>> {
  return apiCall(`/api/events/${eventId}/requests`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

export async function getJoinRequests(
  eventId: string,
): Promise<ApiResult<{ requests: JoinRequest[] }>> {
  return apiCall(`/api/events/${eventId}/requests`);
}

export async function reviewJoinRequest(
  eventId: string,
  userId: string,
  action: 'approve' | 'deny',
): Promise<ApiResult<{ ok: boolean; action: string }>> {
  return apiCall(`/api/events/${eventId}/requests/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ action }),
  });
}

// ── Roles ─────────────────────────────────────────────────────────────────────

export async function assignEventRole(
  eventId: string,
  userId: string,
  role: 'co_host' | 'moderator' | 'banned',
): Promise<ApiResult<{ ok: boolean; userId: string; role: string }>> {
  return apiCall(`/api/events/${eventId}/roles`, {
    method: 'POST',
    body: JSON.stringify({ userId, role }),
  });
}

export async function removeEventRole(
  eventId: string,
  userId: string,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall<{ ok: boolean }>(`/api/events/${eventId}/roles/${userId}`, { method: 'DELETE' });
}

// ── Attendance ────────────────────────────────────────────────────────────────

export async function selfCheckIn(eventId: string): Promise<ApiResult<{ ok: boolean; checkedInAt: string }>> {
  return apiCall(`/api/events/${eventId}/checkin`, { method: 'POST' });
}

export async function confirmAttendance(
  eventId: string,
  userId: string,
): Promise<ApiResult<{ ok: boolean; confirmedAt: string }>> {
  return apiCall(`/api/events/${eventId}/attendance/${userId}`, { method: 'POST' });
}

export async function markNoShow(
  eventId: string,
  userId: string,
): Promise<ApiResult<{ ok: boolean; noShowAt: string }>> {
  return apiCall(`/api/events/${eventId}/noshow/${userId}`, { method: 'POST' });
}

// ── Convert to memory ─────────────────────────────────────────────────────────

export async function convertEventToMemory(
  eventId: string,
): Promise<ApiResult<{ memoryId: string }>> {
  return apiCall(`/api/events/${eventId}/memory`, { method: 'POST' });
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export async function joinEventChat(
  eventId: string,
): Promise<ApiResult<{ threadId: string }>> {
  return apiCall(`/api/events/${eventId}/chat/join`, { method: 'POST' });
}

// ── Post update ───────────────────────────────────────────────────────────────

export async function postEventUpdate(
  eventId: string,
  body: string,
  pinned?: boolean,
): Promise<ApiResult<{ id: string; body: string; pinned: boolean; created_at: string }>> {
  return apiCall(`/api/events/${eventId}/updates`, {
    method: 'POST',
    body: JSON.stringify({ body, pinned }),
  });
}

// ── Waitlist offer acceptance ─────────────────────────────────────────────────

export async function acceptWaitlistOffer(
  eventId: string,
): Promise<ApiResult<{ status: string; eventId: string }>> {
  return apiCall(`/api/events/${eventId}/waitlist/accept`, { method: 'POST' });
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export interface EventReviewer {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface EventReview {
  id: string;
  rating: number;
  body: string | null;
  anonymous: boolean;
  createdAt: string;
  reviewer: EventReviewer | null;
}

export interface SubmitReviewParams {
  rating: number;
  body?: string;
  anonymous?: boolean;
}

export async function submitEventReview(
  eventId: string,
  params: SubmitReviewParams,
): Promise<ApiResult<{ id: string; rating: number; body: string | null; anonymous: boolean; createdAt: string }>> {
  return apiCall(`/api/events/${eventId}/reviews`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function getEventReviews(
  eventId: string,
  page = 1,
): Promise<ApiResult<{ reviews: EventReview[]; page: number; limit: number }>> {
  return apiCall(`/api/events/${eventId}/reviews?page=${page}`);
}

export async function deleteEventReview(
  eventId: string,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/${eventId}/reviews`, { method: 'DELETE' });
}

// ── Drafts ────────────────────────────────────────────────────────────────────

export interface EventDraft {
  id: string;
  title?: string;
  description?: string;
  category?: string;
  vibe?: string;
  startsAt?: string;
  endsAt?: string;
  locationName?: string;
  locationLat?: number;
  locationLng?: number;
  city?: string;
  country?: string;
  maxAttendees?: number;
  ageMin?: number;
  ageMax?: number;
  trustScoreMin?: number;
  verifiedOnly?: boolean;
  visibility?: EventVisibility;
  circleId?: string;
  tripId?: string;
  chatEnabled: boolean;
  waitlistEnabled: boolean;
  priceType?: 'free' | 'external';
  priceUrl?: string;
  coverUrl?: string | null;
  /** Whether non-members can see the event's cover image. */
  showHeaderPublicly?: boolean;
  updatedAt: string;
}

export async function getDraft(draftId: string): Promise<ApiResult<EventDraft>> {
  return apiCall(`/api/events/drafts/${draftId}`);
}

export async function getMyDrafts(): Promise<ApiResult<{ drafts: EventDraft[] }>> {
  return apiCall('/api/events/drafts');
}

export async function createDraft(
  input: Partial<EventDraft>,
): Promise<ApiResult<{ id: string }>> {
  return apiCall('/api/events/drafts', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateDraft(
  draftId: string,
  input: Partial<EventDraft>,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/drafts/${draftId}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function deleteDraft(draftId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/drafts/${draftId}`, { method: 'DELETE' });
}

export async function publishDraft(
  draftId: string,
  overrides?: Partial<EventDraft & { publishNow?: boolean }>,
): Promise<ApiResult<EventSummary>> {
  return apiCall(`/api/events/drafts/${draftId}/publish`, {
    method: 'POST',
    body: JSON.stringify(overrides ?? {}),
  });
}

// ── Save / unsave ─────────────────────────────────────────────────────────────

export async function saveEvent(eventId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/${eventId}/save`, { method: 'POST' });
}

export async function unsaveEvent(eventId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/${eventId}/save`, { method: 'DELETE' });
}

export async function getSavedEvents(
  page = 1,
): Promise<ApiResult<{ events: EventListItem[]; page: number }>> {
  return apiCall(`/api/events/saved?page=${page}`);
}

// ── Share / report ────────────────────────────────────────────────────────────

export async function shareEvent(
  eventId: string,
): Promise<ApiResult<{ shareUrl: string }>> {
  return apiCall(`/api/events/${eventId}/share-link`, { method: 'POST' });
}

export async function reportEvent(
  eventId: string,
  reason: string,
  details?: string,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/${eventId}/report`, {
    method: 'POST',
    body: JSON.stringify({ reason, details }),
  });
}

// ── Following / circle feed ───────────────────────────────────────────────────

export async function listCircleEvents(
  params: { limit?: number; cursor?: string } = {},
): Promise<ApiResult<{ events: EventListItem[]; cursor?: string }>> {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  return apiCall(`/api/events/circles?${q.toString()}`);
}

export async function listFollowingEvents(
  params: { limit?: number; cursor?: string } = {},
): Promise<ApiResult<{ events: EventListItem[]; cursor?: string }>> {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  return apiCall(`/api/events/following?${q.toString()}`);
}

// ── Invites ───────────────────────────────────────────────────────────────────

export interface EventInvite {
  id: string;
  eventId: string;
  status: 'pending' | 'accepted' | 'declined';
  invitedAt: string;
  inviter?: {
    id: string;
    handle?: string;
    displayName?: string;
    avatarUrl?: string;
  };
  event?: {
    id: string;
    title: string;
    startsAt?: string;
    locationName?: string;
    city?: string;
  };
}

export async function getMyEventInvites(): Promise<ApiResult<{ invites: EventInvite[] }>> {
  return apiCall('/api/events/invites');
}

export async function acceptEventInvite(
  eventId: string,
  inviteId: string,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/${eventId}/invites/${inviteId}/accept`, { method: 'POST' });
}

export async function declineEventInvite(
  eventId: string,
  inviteId: string,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/${eventId}/invites/${inviteId}/decline`, { method: 'POST' });
}

export async function inviteUserToEvent(
  eventId: string,
  userId: string,
  message?: string,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/${eventId}/invite`, {
    method: 'POST',
    body: JSON.stringify({ userId, message }),
  });
}

export async function postponeEvent(eventId: string): Promise<ApiResult<EventSummary>> {
  return apiCall(`/api/events/${eventId}/postpone`, { method: 'POST' });
}

export async function archiveEvent(eventId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/${eventId}/archive`, { method: 'POST' });
}

export async function closeRsvps(eventId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/${eventId}/close-rsvps`, { method: 'POST' });
}

export async function reopenRsvps(eventId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiCall(`/api/events/${eventId}/reopen-rsvps`, { method: 'POST' });
}

// ── User events ───────────────────────────────────────────────────────────────

export async function getUserEvents(
  userId: string,
): Promise<ApiResult<{ hosted: EventSummary[]; attending: EventSummary[] }>> {
  return apiCall(`/api/users/${userId}/events`);
}

// ── Rent-a-Buddy integration ─────────────────────────────────────────────────
//
// Pure helpers live in eventCtaHelper.ts (no external imports) so they can be
// unit-tested in node:test without pulling in the supabase client.

export {
  shouldShowRentBuddyCta,
  buildRentBuddyParamsFromEvent,
  buildRentBuddyCtaUrl,
  type RentBuddySearchParams,
} from './eventCtaHelper.ts';

// ── Near-trip events ─────────────────────────────────────────────────────────

export interface NearTripEventsResult {
  events: EventSummary[];
  tripId: string;
  city: string;
}

export async function getEventsNearTrip(
  tripId: string,
): Promise<ApiResult<NearTripEventsResult>> {
  return apiCall<NearTripEventsResult>(`/api/events/near-trip/${tripId}`);
}

export interface AddEventToTripResult {
  planItemId: string;
  tripId: string;
  alreadyAdded?: boolean;
}

export async function addEventToTrip(
  eventId: string,
  tripId: string,
): Promise<ApiResult<AddEventToTripResult>> {
  return apiCall<AddEventToTripResult>(`/api/events/${eventId}/add-to-trip`, {
    method: 'POST',
    body: JSON.stringify({ tripId }),
  });
}
