/**
 * Meetups service — typed wrappers over /api/meetups/*.
 *
 * PRIVACY: No lat/lng on meetups. Location is text-only (location_name).
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { freshToken as freshApiToken } from './apiToken.ts';

export type MeetupStatus    = 'draft' | 'active' | 'confirmed' | 'cancelled';
export type MeetupVisibility = 'invitees' | 'trip' | 'circle' | 'friends';
export type TimeBlock        = 'morning' | 'afternoon' | 'evening' | 'late';
export type RsvpStatus       = 'pending' | 'going' | 'maybe' | 'declined' | 'cancelled';
export type VoteValue        = 'yes' | 'maybe' | 'no';
export type QuickStatus      = 'free_now' | 'free_tonight' | 'busy' | 'open_to_plans';

export interface MeetupSummary {
  id: string;
  creatorId: string;
  title: string;
  description: string | null;
  /** Positioned @mention spans for the description field (type: 'user' only). */
  descriptionTags?: Array<{ type: 'user'; id: string; matchToken: string; startChar: number; endChar: number; isBlocked?: boolean; isDeleted?: boolean }>;
  /** Positioned #hashtag spans for the description field. */
  descriptionHashtags?: Array<{ slug: string; hashtagId: string; startChar: number; endChar: number }>;
  locationName: string | null;
  approximateDate: string | null;
  timeBlock: TimeBlock | null;
  startsAt: string | null;
  endsAt: string | null;
  status: MeetupStatus;
  tripId: string | null;
  circleOwnerId: string | null;
  visibility: MeetupVisibility;
  chatThreadId: string | null;
  chatMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimeOptionVotes { yes: number; maybe: number; no: number; myVote: VoteValue | null; }

export interface MeetupTimeOption {
  id: string;
  proposedDate: string;
  proposedTime: string | null;
  timeBlock: TimeBlock | null;
  label: string | null;
  confirmed: boolean;
  votes: TimeOptionVotes;
}

export interface MeetupCounts { going: number; maybe: number; declined: number; pending: number; }

export interface MeetupCreator {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface AttendeePreview {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface MeetupAgeLimit {
  ageLimitEnabled: boolean;
  minAge: number | null;
  maxAge: number | null;
  /** Formatted label e.g. "Ages 21+", "Ages 18–30", "Under 35" */
  ageLimitLabel: string | null;
}

export interface MeetupDetail extends MeetupSummary, MeetupAgeLimit {
  counts: MeetupCounts;
  myRsvp: RsvpStatus | null;
  isCreator: boolean;
  timeOptions: MeetupTimeOption[];
  creator: MeetupCreator | null;
  goingAttendees: AttendeePreview[];
  totalGoing: number;
}

export interface MeetupInvite {
  inviteId: string;
  meetupId: string;
  status: RsvpStatus;
  invitedAt: string;
  /** 'invite' = pending invite; 'confirmation' = accepted invite whose meetup is now confirmed */
  kind: 'invite' | 'confirmation';
  meetup: {
    id: string;
    title: string;
    locationName: string | null;
    approximateDate: string | null;
    timeBlock: TimeBlock | null;
    startsAt: string | null;
    status: MeetupStatus;
  } | null;
  creator: { id: string; handle: string | null; name: string | null; avatarUrl: string | null; } | null;
}

export interface MeetupListItem extends MeetupSummary {
  isCreator: boolean;
  myRsvp: RsvpStatus | null;
  counts: MeetupCounts;
}

export interface MeetupResult<T = null> {
  ok: boolean;
  data: T | null;
  message?: string;
  reason?: string;
}

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function apiCall<T>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: Record<string, unknown>,
): Promise<MeetupResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: null };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, data: null, message: b?.message ?? `API ${res.status}`, reason: b?.reason };
    }
    if (res.status === 204) return { ok: true, data: null };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, data: null, message: e instanceof Error ? e.message : 'Network error' };
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createMeetup(params: {
  title: string;
  description?: string;
  locationName?: string;
  approximateDate?: string;
  timeBlock?: TimeBlock;
  startsAt?: string;
  tripId?: string;
  circleOwnerId?: string;
  visibility?: MeetupVisibility;
  inviteeIds?: string[];
  ageLimitEnabled?: boolean;
  minAge?: number;
  maxAge?: number;
}): Promise<MeetupResult<MeetupSummary & { inviteErrors?: string[] }>> {
  return apiCall('/api/meetups', 'POST', params as Record<string, unknown>);
}

export async function getMyMeetups(
  filter?: 'upcoming' | 'past' | 'all',
): Promise<MeetupResult<{ meetups: MeetupListItem[] }>> {
  const qs = filter ? `?filter=${filter}` : '';
  return apiCall(`/api/me/meetups${qs}`, 'GET');
}

export async function getMeetup(meetupId: string): Promise<MeetupResult<MeetupDetail>> {
  return apiCall(`/api/meetups/${meetupId}`, 'GET');
}

export async function updateMeetup(
  meetupId: string,
  patch: Partial<{
    title: string;
    description: string | null;
    locationName: string | null;
    approximateDate: string | null;
    timeBlock: TimeBlock | null;
    startsAt: string | null;
    status: MeetupStatus;
    ageLimitEnabled: boolean;
    minAge: number;
    maxAge: number;
  }>,
): Promise<MeetupResult<MeetupSummary>> {
  return apiCall(`/api/meetups/${meetupId}`, 'PATCH', patch as Record<string, unknown>);
}

export async function cancelMeetup(meetupId: string): Promise<MeetupResult<{ status: string; meetupId: string }>> {
  return apiCall(`/api/meetups/${meetupId}`, 'DELETE');
}

// ── Invites ───────────────────────────────────────────────────────────────────

export async function inviteToMeetup(
  meetupId: string,
  userIds: string[],
): Promise<MeetupResult<{ invited: string[]; skipped: string[] }>> {
  return apiCall(`/api/meetups/${meetupId}/invites`, 'POST', { userIds });
}

export async function getMyMeetupInvites(): Promise<MeetupResult<{ invites: MeetupInvite[] }>> {
  return apiCall('/api/me/meetup-invites', 'GET');
}

// ── RSVP ─────────────────────────────────────────────────────────────────────

export async function rsvpMeetup(
  meetupId: string,
  status: 'going' | 'maybe' | 'declined',
): Promise<MeetupResult<{ status: RsvpStatus; meetupId: string; counts: MeetupCounts }>> {
  return apiCall(`/api/meetups/${meetupId}/rsvp`, 'POST', { status });
}

// ── Time poll ─────────────────────────────────────────────────────────────────

export async function addTimeOption(
  meetupId: string,
  params: { proposedDate: string; proposedTime?: string; timeBlock?: TimeBlock; label?: string },
): Promise<MeetupResult<MeetupTimeOption>> {
  return apiCall(`/api/meetups/${meetupId}/time-options`, 'POST', params as Record<string, unknown>);
}

export async function voteTimeOption(
  meetupId: string,
  optionId: string,
  vote: VoteValue,
): Promise<MeetupResult<{ optionId: string; votes: TimeOptionVotes }>> {
  return apiCall(`/api/meetups/${meetupId}/time-options/${optionId}/vote`, 'POST', { vote });
}

export async function confirmTime(
  meetupId: string,
  optionId: string,
): Promise<MeetupResult<{ startsAt: string; status: string; meetupId: string }>> {
  return apiCall(`/api/meetups/${meetupId}/confirm-time`, 'POST', { optionId });
}

// ── Frequent invitees ─────────────────────────────────────────────────────────

export interface FrequentInvitee {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  count: number;
}

export async function getFrequentInvitees(): Promise<MeetupResult<{ invitees: FrequentInvitee[] }>> {
  return apiCall('/api/me/frequent-invitees', 'GET');
}

// ── Trip plan ─────────────────────────────────────────────────────────────────

export async function addMeetupToTripPlan(
  meetupId: string,
  tripId: string,
): Promise<MeetupResult<{ planItemId?: string; tripId: string; meetupId: string; idempotent?: boolean }>> {
  return apiCall(`/api/meetups/${meetupId}/add-to-trip-plan`, 'POST', { tripId });
}
