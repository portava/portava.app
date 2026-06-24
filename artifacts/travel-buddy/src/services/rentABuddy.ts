/**
 * Rent a Buddy — mobile service layer
 *
 * Typed fetch helpers for all Rent a Buddy API endpoints.
 * Pattern: same as tripCrewLocation.ts / hiddenGems.ts —
 * EXPO_PUBLIC_API_BASE_URL + Supabase Bearer token via authHeaders().
 */
import { supabase } from '../lib/supabase';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BuddyStatus = 'pending' | 'active' | 'paused' | 'rejected' | 'suspended';
export type BookingStatus =
  | 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'disputed';
export type ApplicationStatus = 'pending' | 'under_review' | 'approved' | 'rejected';

export type BuddyCategory =
  | 'arrival' | 'city' | 'nightlife' | 'language' | 'content' | 'food'
  | 'nature' | 'culture' | 'adventure' | 'shopping' | 'wellness' | 'other';

export interface BuddyProfile {
  id: string;
  userId: string;
  displayName: string | null;
  tagline: string | null;
  bio: string | null;
  languages: string[];
  city: string;
  country: string | null;
  categories: BuddyCategory[];
  hourlyRateUsd: number | null;
  status: BuddyStatus;
  verified: boolean;
  verifiedAt: string | null;
  averageRating: number | null;
  reviewCount: number;
  responseTimeH: number | null;
  coverPhotoUrl: string | null;
  galleryUrls: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BuddyPackage {
  id: string;
  buddyId: string;
  title: string;
  description: string | null;
  category: string;
  durationH: number;
  priceUsd: number;
  maxGroup: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BuddyAddon {
  id: string;
  buddyId: string;
  title: string;
  description: string | null;
  priceUsd: number;
  isActive: boolean;
  createdAt: string;
}

export interface BuddyAvailability {
  id: string;
  buddyId: string;
  date: string;
  timeSlots: string[];
  isAvailable: boolean;
  notes: string | null;
}

export interface BuddyBooking {
  id: string;
  buddyId: string;
  travelerId: string;
  packageId: string | null;
  tripId: string | null;
  bookingDate: string;
  startTime: string | null;
  durationH: number;
  groupSize: number;
  city: string;
  category: string;
  notes: string | null;
  totalUsd: number;
  status: BookingStatus;
  cancelledAt: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuddyReview {
  id: string;
  bookingId: string;
  reviewerId: string;
  buddyId: string;
  rating: number;
  body: string | null;
  photos: string[];
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BuddyApplication {
  id: string;
  userId: string;
  status: ApplicationStatus;
  city: string;
  country: string | null;
  categories: BuddyCategory[];
  languages: string[];
  motivation: string | null;
  socialLinks: Record<string, string>;
  reviewNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuddySearchParams {
  city: string;
  category?: BuddyCategory;
  date?: string;
  groupSize?: number;
  language?: string;
  maxBudgetUsd?: number;
  page?: number;
  perPage?: number;
}

export interface BuddySearchResult {
  buddies: BuddyProfile[];
  total: number;
  page: number;
  perPage: number;
}

export interface BuddyDashboardSummary {
  profile: BuddyProfile | null;
  upcomingBookings: number;
  pendingRequests: number;
  totalEarningsUsd: number;
  averageRating: number | null;
  reviewCount: number;
}

export interface BuddyEarnings {
  totalUsd: number;
  thisMonthUsd: number;
  completedBookings: number;
  breakdown: Array<{ month: string; totalUsd: number; bookingCount: number }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function apiFetch<T>(
  path: string,
  opts: RequestInit = {},
): Promise<ApiResult<T>> {
  try {
    const headers = await authHeaders();
    const res = await fetch(`${apiBase()}${path}`, {
      ...opts,
      headers: { ...headers, ...(opts.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any)?.error ?? `HTTP ${res.status}` };
    }
    const data = await res.json() as T;
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'network_error' };
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

export async function searchBuddies(params: BuddySearchParams): Promise<ApiResult<BuddySearchResult>> {
  return apiFetch<BuddySearchResult>('/api/rent-a-buddy/search', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ── Buddy profile ─────────────────────────────────────────────────────────────

export async function getBuddyProfile(buddyId: string): Promise<ApiResult<{
  buddy: BuddyProfile | null;
  packages: BuddyPackage[];
  addons: BuddyAddon[];
  reviews: BuddyReview[];
  availability: BuddyAvailability[];
  savedByMe: boolean;
}>> {
  return apiFetch(`/api/rent-a-buddy/buddies/${buddyId}`);
}

export async function getBuddyAvailability(
  buddyId: string,
  month?: string,
): Promise<ApiResult<{ availability: BuddyAvailability[] }>> {
  const qs = month ? `?month=${encodeURIComponent(month)}` : '';
  return apiFetch(`/api/rent-a-buddy/buddies/${buddyId}/availability${qs}`);
}

export async function getBuddyReviews(
  buddyId: string,
  page = 1,
): Promise<ApiResult<{ reviews: BuddyReview[]; total: number }>> {
  return apiFetch(`/api/rent-a-buddy/buddies/${buddyId}/reviews?page=${page}`);
}

// ── Bookings ──────────────────────────────────────────────────────────────────

export async function createBooking(payload: {
  buddyId: string;
  packageId?: string;
  tripId?: string;
  bookingDate: string;
  startTime?: string;
  durationH: number;
  groupSize: number;
  city: string;
  category: BuddyCategory;
  notes?: string;
  addonIds?: string[];
}): Promise<ApiResult<{ booking: BuddyBooking | null }>> {
  return apiFetch('/api/rent-a-buddy/bookings', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function listMyBookings(): Promise<ApiResult<{ bookings: BuddyBooking[] }>> {
  return apiFetch('/api/rent-a-buddy/bookings');
}

export async function getBooking(bookingId: string): Promise<ApiResult<{ booking: BuddyBooking | null }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}`);
}

export async function cancelBooking(
  bookingId: string,
  reason?: string,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export async function submitReview(
  bookingId: string,
  payload: { rating: number; body?: string; photos?: string[]; isPublic?: boolean },
): Promise<ApiResult<{ review: BuddyReview | null }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/review`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── Application ───────────────────────────────────────────────────────────────

export async function getMyApplication(): Promise<ApiResult<{ application: BuddyApplication | null }>> {
  return apiFetch('/api/rent-a-buddy/apply');
}

export async function submitApplication(payload: {
  city: string;
  country?: string;
  categories: BuddyCategory[];
  languages: string[];
  motivation?: string;
  socialLinks?: Record<string, string>;
}): Promise<ApiResult<{ application: BuddyApplication | null; message: string }>> {
  return apiFetch('/api/rent-a-buddy/apply', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── Saved ─────────────────────────────────────────────────────────────────────

export async function getMySavedBuddies(): Promise<ApiResult<{ saved: BuddyProfile[] }>> {
  return apiFetch('/api/rent-a-buddy/saved');
}

export async function saveBuddy(buddyId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/saved/${buddyId}`, { method: 'POST' });
}

export async function unsaveBuddy(buddyId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/saved/${buddyId}`, { method: 'DELETE' });
}

// ── Waitlist ──────────────────────────────────────────────────────────────────

export async function getMyWaitlist(): Promise<ApiResult<{ waitlist: Array<{ id: string; city: string; category: string | null; createdAt: string }> }>> {
  return apiFetch('/api/rent-a-buddy/waitlist');
}

export async function joinWaitlist(city: string, category?: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/rent-a-buddy/waitlist', {
    method: 'POST',
    body: JSON.stringify({ city, category }),
  });
}

export async function leaveWaitlist(city: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/waitlist/${encodeURIComponent(city)}`, { method: 'DELETE' });
}

// ── Buddy dashboard ───────────────────────────────────────────────────────────

export async function getBuddyDashboard(): Promise<ApiResult<BuddyDashboardSummary>> {
  return apiFetch('/api/rent-a-buddy/dashboard');
}

export async function getDashboardRequests(): Promise<ApiResult<{ requests: BuddyBooking[] }>> {
  return apiFetch('/api/rent-a-buddy/dashboard/requests');
}

export async function getDashboardAvailability(): Promise<ApiResult<{ availability: BuddyAvailability[] }>> {
  return apiFetch('/api/rent-a-buddy/dashboard/availability');
}

export async function setDashboardAvailability(entries: Array<{
  date: string;
  timeSlots: string[];
  isAvailable: boolean;
  notes?: string;
}>): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/rent-a-buddy/dashboard/availability', {
    method: 'POST',
    body: JSON.stringify({ entries }),
  });
}

export async function updateOffer(patch: Partial<Pick<BuddyProfile,
  'displayName' | 'tagline' | 'bio' | 'languages' | 'categories' | 'hourlyRateUsd'
>>): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/rent-a-buddy/dashboard/offer', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function getDashboardPackages(): Promise<ApiResult<{ packages: BuddyPackage[] }>> {
  return apiFetch('/api/rent-a-buddy/dashboard/packages');
}

export async function createPackage(pkg: Omit<BuddyPackage, 'id' | 'buddyId' | 'isActive' | 'createdAt' | 'updatedAt'>): Promise<ApiResult<{ pkg: BuddyPackage | null }>> {
  return apiFetch('/api/rent-a-buddy/dashboard/packages', {
    method: 'POST',
    body: JSON.stringify(pkg),
  });
}

export async function updatePackage(packageId: string, patch: Partial<BuddyPackage>): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/dashboard/packages/${packageId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deletePackage(packageId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/dashboard/packages/${packageId}`, { method: 'DELETE' });
}

export async function getDashboardAddons(): Promise<ApiResult<{ addons: BuddyAddon[] }>> {
  return apiFetch('/api/rent-a-buddy/dashboard/addons');
}

export async function createAddon(addon: Pick<BuddyAddon, 'title' | 'description' | 'priceUsd'>): Promise<ApiResult<{ addon: BuddyAddon | null }>> {
  return apiFetch('/api/rent-a-buddy/dashboard/addons', {
    method: 'POST',
    body: JSON.stringify(addon),
  });
}

export async function updateAddon(addonId: string, patch: Partial<BuddyAddon>): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/dashboard/addons/${addonId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteAddon(addonId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/dashboard/addons/${addonId}`, { method: 'DELETE' });
}

export async function getDashboardEarnings(): Promise<ApiResult<BuddyEarnings>> {
  return apiFetch('/api/rent-a-buddy/dashboard/earnings');
}

// ── Booking lifecycle — Buddy side ────────────────────────────────────────────

export async function acceptBooking(bookingId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/accept`, { method: 'POST' });
}

export async function declineBooking(bookingId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/decline`, { method: 'POST' });
}

export async function suggestChanges(bookingId: string, payload: {
  proposedDate?: string;
  proposedTime?: string;
  proposedDurationH?: number;
  proposedLocation?: string;
  message?: string;
}): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/suggest`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function startBooking(bookingId: string, payload?: {
  trustedCircleShared?: boolean;
  safeReturnEnabled?: boolean;
  emergencyContactCount?: number;
}): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/start`, {
    method: 'POST',
    body: JSON.stringify(payload ?? {}),
  });
}

export async function completeBooking(bookingId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/complete`, { method: 'POST' });
}

export async function confirmCashBalance(
  bookingId: string,
  confirmed: boolean,
): Promise<ApiResult<{ ok: boolean; disputed: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/confirm-cash`, {
    method: 'POST',
    body: JSON.stringify({ confirmed }),
  });
}

export async function reportBooking(
  bookingId: string,
  payload: { reason?: string; details?: string },
): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/report`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function setRoutePlan(
  bookingId: string,
  stops: Array<{ name: string; notes?: string; eta?: string; lat?: number; lng?: number }>,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/route`, {
    method: 'POST',
    body: JSON.stringify({ stops }),
  });
}

export async function requestRouteChange(
  bookingId: string,
  payload: { newStops: Array<{ name: string; notes?: string; eta?: string }>; reason?: string },
): Promise<ApiResult<{ routeChangeRequest: any }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/route-change`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── Buddy-initiated offers ─────────────────────────────────────────────────────

export interface BuddyOffer {
  category: BuddyCategory;
  priceUsd: number;
  proposedDate: string;
  proposedTime?: string;
  meetupLocation?: string;
  includedServices: string[];
  message?: string;
  addonIds?: string[];
}

export async function createBuddyOffer(payload: BuddyOffer): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/rent-a-buddy/dashboard/offers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── Safety routes ─────────────────────────────────────────────────────────────

export async function safetyCheckin(
  bookingId: string,
  payload: { checkinType: string; response?: string },
): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/safety/checkin`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function feelUnsafe(bookingId: string, details?: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/safety/feel-unsafe`, {
    method: 'POST',
    body: JSON.stringify({ details }),
  });
}

export async function endBookingEarly(bookingId: string, reason?: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/safety/end-early`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export type EmergencyPhraseOption = {
  id: string;
  label: string;
};

export async function triggerEmergencyPhrase(bookingId: string): Promise<ApiResult<{
  travelerOnly: boolean;
  prompt: string;
  options: EmergencyPhraseOption[];
}>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/safety/emergency-phrase`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ── My Buddy profile ──────────────────────────────────────────────────────────

export async function getMyBuddyProfile(): Promise<ApiResult<{ profile: BuddyProfile | null }>> {
  return apiFetch('/api/rent-a-buddy/me/profile');
}

export async function updateMyBuddyProfile(patch: Partial<BuddyProfile>): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/rent-a-buddy/me/profile', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function getMyRequests(): Promise<ApiResult<{ requests: BuddyBooking[] }>> {
  return apiFetch('/api/rent-a-buddy/me/requests');
}

// ── Availability settings ──────────────────────────────────────────────────────

export interface AvailabilitySettings {
  availableNow?: boolean;
  minNoticeHours?: number;
  bufferMinutes?: number;
  maxBookingsPerDay?: number;
  blockedFrom?: string;
  blockedTo?: string;
}

export async function setAvailabilitySettings(settings: AvailabilitySettings): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/rent-a-buddy/dashboard/availability/settings', {
    method: 'PATCH',
    body: JSON.stringify(settings),
  });
}

/**
 * Get or create a Telegraph thread for a rent-a-buddy booking.
 * Returns the thread ID to navigate to messages/[id].tsx with
 * threadType='rent_buddy_booking' and contextId=bookingId.
 */
export async function getOrCreateBookingThread(bookingId: string): Promise<ApiResult<{
  threadId: string;
  bookingId: string;
  isNew: boolean;
}>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/thread`, { method: 'POST' });
}
