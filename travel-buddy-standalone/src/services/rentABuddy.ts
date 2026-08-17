/**
 * Rent a Buddy — mobile service layer
 *
 * Typed fetch helpers for all Rent a Buddy API endpoints.
 * Pattern: same as tripCrewLocation.ts / hiddenGems.ts —
 * EXPO_PUBLIC_API_BASE_URL + Supabase Bearer token via authHeaders().
 */
import { freshToken } from './adminApi.ts';
import { cityCoordSpread } from '../lib/cityCoords.ts';

// Booking-refusal classification + copy. Defined in their own import-free module
// so they are unit-testable without pulling in react-native, and re-exported
// here because rentABuddy.ts is where every caller imports from.
export {
  BOOKING_UNAVAILABLE_CODES,
  isBookingUnavailable,
  bookingErrorCopy,
} from './rentABuddyBookingErrors.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BuddyStatus = 'pending' | 'active' | 'paused' | 'rejected' | 'suspended';
export type BookingStatus =
  | 'requested' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'disputed'
  | 'expired' | 'no_show_pending';
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
  availableNow?: boolean;
  buddyLevel?: string;
  /** Distance in km from the queried coordinates — set by search when lat/lng were sent.
   *  Measured to the buddy's approximate meetup base when pinned, else their city centre. */
  distanceKm?: number | null;
  /** Approximate (neighbourhood-level) meetup-base pin, when the buddy has set one. */
  meetupBaseLat?: number | null;
  meetupBaseLng?: number | null;
  /** Trust score (0–100) computed server-side. Null when not yet computed. */
  trustScore?: number | null;
  /** Human-readable trust tier label, e.g. "Trusted Traveler". */
  trustLabel?: string | null;
  /** Public factor breakdown — hints are always null for non-owners. */
  trustScoreBreakdown?: {
    factors: Array<{
      key: string;
      label: string;
      points: number;
      maxPoints: number;
      maxed: boolean;
      hint: null;
    }>;
  } | null;
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
  /** Included stops shown to travelers. */
  stops?: string[];
  /** Meetup instructions/rules shown after booking. */
  meetupRules?: string | null;
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
  routePlan: Array<{ location: string; description?: string }>;
  telegraphThreadId: string | null;
  /** Post-completion reconnect flags — both true means the pair opted to stay connected. */
  stayConnectedTraveler?: boolean;
  stayConnectedBuddy?: boolean;
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
  /** Wizard-collected profile fields, surfaced for admin review (from rent_buddy_profiles). */
  displayName: string | null;
  bio: string | null;
  hourlyRateUsd: number | null;
  availability: Array<Record<string, unknown>>;
  zones: string[];
  socialLinks: Record<string, string>;
  reviewNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BuddySortBy =
  | 'best_match'
  | 'highest_rated'
  | 'available_soon'
  | 'price_low'
  | 'price_high'
  | 'response_time'
  | 'newest';

/**
 * Coordinates must be provided together or not at all — a half pair (only lat
 * or only lng) is a type error, so callers can't accidentally send one-sided
 * coordinates to the proximity-ranking endpoint.
 */
export type CoordPair =
  | {
      /** Latitude of the user's current location — enables proximity-based ranking on the server. */
      lat: number;
      /** Longitude of the user's current location — enables proximity-based ranking on the server. */
      lng: number;
    }
  | { lat?: never; lng?: never };

export type BuddySearchParams = {
  city: string;
  category?: BuddyCategory;
  date?: string;
  groupSize?: number;
  language?: string;
  maxBudgetUsd?: number;
  sortBy?: BuddySortBy;
  verifiedOnly?: boolean;
  minRating?: number;
  sessionMode?: 'any' | 'in_person' | 'remote';
  page?: number;
  perPage?: number;
} & CoordPair;

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
  const token = await freshToken();
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

export async function getBuddyProfileByUserId(userId: string): Promise<ApiResult<{
  buddy: BuddyProfile | null;
  packages: BuddyPackage[];
  addons: BuddyAddon[];
  reviews: BuddyReview[];
  availability: BuddyAvailability[];
  savedByMe: boolean;
}>> {
  return apiFetch(`/api/rent-a-buddy/by-user/${encodeURIComponent(userId)}`);
}

export async function getBuddyAvailability(
  buddyId: string,
  month?: string,
): Promise<ApiResult<{ availability: BuddyAvailability[] }>> {
  const qs = month ? `?month=${encodeURIComponent(month)}` : '';
  return apiFetch(`/api/rent-a-buddy/buddies/${buddyId}/availability${qs}`);
}

export type BuddyBlockedRange = {
  id: string;
  type: string;
  startDate: string; // ISO YYYY-MM-DD
  endDate: string;   // ISO YYYY-MM-DD (same as startDate for single-day blocks)
};

/** Upcoming blocked/vacation date ranges for a buddy (public). */
export async function getBuddyBlockedDates(
  buddyId: string,
): Promise<ApiResult<{ blocked: BuddyBlockedRange[] }>> {
  return apiFetch(`/api/rent-a-buddy/buddies/${buddyId}/blocked-dates`);
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
  countryCode?: string;
  meetupLocation?: string;
  category: BuddyCategory;
  notes?: string;
  addonIds?: string[];
  acceptSafety?: boolean;
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
  payload: {
    rating: number; body?: string; photos?: string[]; isPublic?: boolean;
    /** Per-category star ratings keyed by category id. */
    categoryRatings?: Record<string, number>;
    /** Admin-only safety note — never shown publicly. */
    privateNote?: string;
    safetyScore?: number; communicationScore?: number; punctualityScore?: number;
  },
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
  /** Wizard-collected profile fields persisted atomically on submission. */
  displayName?: string;
  bio?: string;
  hourlyRateUsd?: number;
  /** Weekly availability blocks, e.g. [{ day: 'monday', from: '09:00', to: '18:00' }] */
  availability?: Array<Record<string, unknown>>;
  /** Preferred meetup zone names or area slugs. */
  zones?: string[];
  /** Profile photo URLs uploaded during the application wizard (max 3). */
  photos?: string[];
}): Promise<ApiResult<{ application: BuddyApplication | null; message: string }>> {
  return apiFetch('/api/rent-a-buddy/apply', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// Submit an existing buddy profile for admin review.
// Unlike submitApplication() which creates a new application, this transitions an
// existing profile to pending_review status.  It preserves the full structured
// error body so the UI can render the specific missing fields and verification state.
export type ProfileSubmitResult =
  | { ok: true; status: string; message?: string }
  | { ok: false; error: 'incomplete_profile'; missing: string[]; message?: string }
  | { ok: false; error: 'verification_required'; verification_status: string; message?: string }
  | { ok: false; error: string; message?: string };

export async function submitProfileForReview(opts?: {
  acceptSafety?: boolean;
  acceptBoundaries?: boolean;
}): Promise<ProfileSubmitResult> {
  try {
    const headers = await authHeaders();
    const res = await fetch(`${apiBase()}/api/me/buddy-profile/submit`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      // Preserve full body so callers can read missing[], verification_status, etc.
      return { ok: false, ...body } as ProfileSubmitResult;
    }
    return { ok: true, ...body } as ProfileSubmitResult;
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'network_error' };
  }
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

export async function joinWaitlist(
  city: string,
  category?: string,
  coords?: CoordPair,
  extras?: { desiredDate?: string; desiredTime?: string; budgetUsd?: number; notes?: string },
): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/rent-a-buddy/waitlist', {
    method: 'POST',
    body: JSON.stringify({
      city, category,
      ...cityCoordSpread(coords),
      desiredDate: extras?.desiredDate || undefined,
      desiredTime: extras?.desiredTime || undefined,
      budgetUsd: typeof extras?.budgetUsd === 'number' && Number.isFinite(extras.budgetUsd) ? extras.budgetUsd : undefined,
      notes: extras?.notes || undefined,
    }),
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

export interface DashboardAvailabilitySettings {
  availableNow: boolean;
  minNoticeHours: number | null;
  bufferMinutes: number | null;
  maxBookingsPerDay: number | null;
  blockedFrom: string | null;
  blockedTo: string | null;
}

export async function getDashboardAvailability(): Promise<ApiResult<{
  availability: BuddyAvailability[];
  settings?: DashboardAvailabilitySettings | null;
}>> {
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

export async function declineBooking(bookingId: string, reason?: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/decline`, {
    method: 'POST',
    body: JSON.stringify({ decline_reason: reason ?? null }),
  });
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

export async function optInStayConnected(bookingId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/stay-connected`, { method: 'POST' });
}

export async function addExtraTime(bookingId: string, hours: number): Promise<ApiResult<{ ok: boolean; newDurationH?: number }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/add-time`, {
    method: 'POST',
    body: JSON.stringify({ hours }),
  });
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

export interface BuddyOfferPayload {
  priceUsd: number;
  proposedDate: string;
  proposedTime?: string;
  meetupLocation?: string;
  includedServices: string[];
  message?: string;
  addonIds?: string[];
}

/**
 * Buddy sends a custom offer against an open traveller request.
 * Server: POST /api/rent-a-buddy/requests/:requestId/offers
 */
export async function createBuddyOffer(
  requestId: string,
  payload: BuddyOfferPayload,
): Promise<ApiResult<{ offer: BuddyOffer }>> {
  const proposedStart = payload.proposedDate
    ? `${payload.proposedDate}T${payload.proposedTime ?? '00:00'}:00`
    : undefined;
  return apiFetch(`/api/rent-a-buddy/requests/${requestId}/offers`, {
    method: 'POST',
    body: JSON.stringify({
      proposedPriceUsd: payload.priceUsd,
      proposedStart,
      meetupLocation: payload.meetupLocation,
      includedServices: payload.includedServices,
      message: payload.message,
      addonsOffered: payload.addonIds,
    }),
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
  /** ISO date (YYYY-MM-DD). Send '' to clear the blocked range. */
  blockedFrom?: string;
  /** ISO date (YYYY-MM-DD). Send '' to clear the blocked range. */
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

// ── Marketplace — Types ───────────────────────────────────────────────────────

export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
export type RequestStatus = 'open' | 'matched' | 'expired' | 'cancelled' | 'closed';
export type WaitlistStatus = 'active' | 'matched' | 'expired' | 'cancelled';

export interface MatchPreferences {
  need?: string | null;
  vibe?: string | null;
  energy?: string | null;
  language?: string | null;
  budgetMinUsd?: number | null;
  budgetMaxUsd?: number | null;
  bookingLength?: string | null;
  safetyPrefs?: Record<string, boolean>;
  groupSize?: number;
  femaleOnly?: boolean;
  publicOnly?: boolean;
  rawAnswers?: Record<string, string>;
}

export interface BuddyOffer {
  id: string;
  requestId: string;
  buddyProfileId: string;
  buddyUserId: string;
  proposedPriceUsd: number;
  depositAmountUsd: number;
  cashBalanceUsd: number;
  proposedStart: string | null;
  proposedEnd: string | null;
  meetupLocation: string | null;
  message: string | null;
  includedServices: string[];
  addonsOffered: unknown[];
  paymentMode: string;
  expiresAt: string;
  status: OfferStatus;
  acceptedBookingId: string | null;
  createdAt: string;
  buddy?: BuddyProfile | null;
}

export interface BuddyRequest {
  id: string;
  travelerId: string;
  city: string;
  lat: number | null;
  lng: number | null;
  category: string;
  desiredDate: string | null;
  desiredTime: string | null;
  durationMinutes: number;
  groupSize: number;
  budgetMinUsd: number | null;
  budgetMaxUsd: number | null;
  languageNeeded: string | null;
  energyType: string | null;
  paymentModePref: string | null;
  notes: string | null;
  status: RequestStatus;
  expiresAt: string;
  createdAt: string;
}

export interface SavedBuddyEntry {
  buddyId: string;
  notes: string | null;
  savedAt: string;
  updatedAt: string;
  buddy: BuddyProfile | null;
}

export interface WaitlistEntry {
  id: string;
  city: string;
  category: string | null;
  language: string | null;
  budgetMaxUsd: number | null;
  desiredDate: string | null;
  desiredTime: string | null;
  notes: string | null;
  groupSize: number;
  status: WaitlistStatus;
  expiresAt: string | null;
  createdAt: string;
}

export interface EarningsSummary {
  isEstimated: boolean;
  warning: string;
  today: { bookingCount: number; bookings: BuddyBooking[] };
  upcoming: { bookingCount: number; bookings: BuddyBooking[] };
  completed: {
    count: number; totalUsd: number; depositCollected: number;
    cashBalanceDue: number; cashBalanceConfirmed: number; inAppAmountCollected: number;
  };
  tips: { total: number; count: number };
  estimatedPlatformFeeUsd: number;
  estimatedBuddyEarningsUsd: number;
  statusBreakdown: { completed: number; disputed: number; cancelled: number };
  trustScore: number | null;
  trustLevel: string | null;
  profileViews: number;
  searchAppearances: number;
  repeatClientCount: number;
  cityRanking: number | null;
  averageRating: number | null;
  reviewCount: number;
}

export interface LedgerEntry {
  id: string;
  bookingId: string;
  pricingType: string | null;
  totalBookingUsd: number;
  addonsUsd: number;
  tipUsd: number;
  platformFeePercent: number | null;
  platformFeeAmount: number;
  travelerServiceFeeAmount: number;
  buddyGrossAmount: number;
  buddyNetEstimatedAmount: number;
  depositAmount: number;
  inAppAmountCollected: number;
  cashBalanceDue: number;
  cashBalanceConfirmed: boolean;
  isEstimated: boolean;
  createdAt: string;
}

export interface DiscoverySection {
  key: string;
  title: string;
  buddies: BuddyProfile[];
  isCtaSection?: boolean;
}

export interface PricingSuggestion {
  label: string;
  minUsd: number;
  maxUsd: number;
  pricingType: string;
}

export interface MarketplacePackage extends BuddyPackage {
  city: string | null;
  depositRequired: boolean;
  depositPercent: number;
  paymentModesAllowed: string[];
  includedStops: unknown[];
  includedServices: string[];
  adminReviewStatus: 'pending' | 'approved' | 'disabled';
}

// ── Marketplace — Match ───────────────────────────────────────────────────────

export async function saveMatchPreferences(prefs: MatchPreferences): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/rent-a-buddy/match/preferences', {
    method: 'POST',
    body: JSON.stringify(prefs),
  });
}

export async function runMatch(city: string, preferences?: MatchPreferences, limit = 20): Promise<ApiResult<{
  results: Array<BuddyProfile & { compatibilityScore: number; scoreBreakdown: Record<string, number> }>;
  total: number;
}>> {
  return apiFetch('/api/rent-a-buddy/match', {
    method: 'POST',
    body: JSON.stringify({ city, preferences, limit }),
  });
}

// ── Marketplace — Discovery ───────────────────────────────────────────────────

export async function getDiscoverySections(city?: string): Promise<ApiResult<{
  sections: DiscoverySection[];
  city: string | null;
}>> {
  const qs = city ? `?city=${encodeURIComponent(city)}` : '';
  return apiFetch(`/api/rent-a-buddy/sections${qs}`);
}

export async function getAvailableNow(city?: string): Promise<ApiResult<{ buddies: BuddyProfile[] }>> {
  const qs = city ? `?city=${encodeURIComponent(city)}` : '';
  return apiFetch(`/api/rent-a-buddy/available-now${qs}`);
}

export async function getTopInCity(city: string): Promise<ApiResult<{ buddies: BuddyProfile[] }>> {
  return apiFetch(`/api/rent-a-buddy/cities/${encodeURIComponent(city)}/top`);
}

// ── Marketplace — Availability Settings ──────────────────────────────────────

export interface FullAvailabilitySettings {
  weeklyBlocks?: unknown[];
  oneTimeBlocks?: unknown[];
  vacationDates?: unknown[];
  minNoticeHours?: number;
  bufferMinutes?: number;
  maxBookingsPerDay?: number;
  nightlifeAvailable?: boolean;
  arrivalAvailable?: boolean;
  groupAvailable?: boolean;
  customAvailable?: boolean;
}

export async function getAvailabilitySettings(): Promise<ApiResult<{ settings: FullAvailabilitySettings | null }>> {
  return apiFetch('/api/rent-a-buddy/me/availability-settings');
}

export async function updateAvailabilitySettings(settings: FullAvailabilitySettings): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/rent-a-buddy/me/availability-settings', {
    method: 'PATCH',
    body: JSON.stringify(settings),
  });
}

export async function setAvailableNow(durationMinutes = 60): Promise<ApiResult<{ ok: boolean; availableUntil: string }>> {
  return apiFetch('/api/rent-a-buddy/me/available-now', {
    method: 'POST',
    body: JSON.stringify({ durationMinutes }),
  });
}

export async function clearAvailableNow(): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/rent-a-buddy/me/available-now', { method: 'DELETE' });
}

// ── Marketplace — Requests & Offers ──────────────────────────────────────────

export async function createRequest(payload: {
  city: string; lat?: number; lng?: number; category: string; desiredDate?: string; desiredTime?: string;
  durationMinutes?: number; groupSize?: number; budgetMinUsd?: number; budgetMaxUsd?: number;
  languageNeeded?: string; energyType?: string; safetyPrefs?: Record<string, boolean>;
  paymentModePref?: string; notes?: string;
}): Promise<ApiResult<{ request: BuddyRequest }>> {
  return apiFetch('/api/rent-a-buddy/requests', { method: 'POST', body: JSON.stringify(payload) });
}

export async function getRequest(requestId: string): Promise<ApiResult<{ request: BuddyRequest }>> {
  return apiFetch(`/api/rent-a-buddy/requests/${requestId}`);
}

export async function getMatchingRequests(): Promise<ApiResult<{ requests: BuddyRequest[] }>> {
  return apiFetch('/api/rent-a-buddy/me/matching-requests');
}

export async function getRequestOffers(requestId: string): Promise<ApiResult<{ offers: BuddyOffer[] }>> {
  return apiFetch(`/api/rent-a-buddy/requests/${requestId}/offers`);
}

export async function submitOffer(requestId: string, payload: {
  proposedPriceUsd: number; depositAmountUsd?: number; cashBalanceDue?: number;
  proposedStart?: string; proposedEnd?: string; meetupLocation?: string; message?: string;
  includedServices?: string[]; addonsOffered?: unknown[]; paymentMode?: string; expiresInHours?: number;
}): Promise<ApiResult<{ offer: BuddyOffer }>> {
  return apiFetch(`/api/rent-a-buddy/requests/${requestId}/offers`, { method: 'POST', body: JSON.stringify(payload) });
}

export async function getMyOffers(): Promise<ApiResult<{ offers: BuddyOffer[] }>> {
  return apiFetch('/api/rent-a-buddy/me/offers');
}

export async function acceptOffer(offerId: string): Promise<ApiResult<{ bookingId: string }>> {
  return apiFetch(`/api/rent-a-buddy/offers/${offerId}/accept`, { method: 'POST' });
}

export async function declineOffer(offerId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/offers/${offerId}/decline`, { method: 'POST' });
}

export async function withdrawOffer(offerId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/offers/${offerId}/withdraw`, { method: 'POST' });
}

// ── Marketplace — Enhanced Packages ──────────────────────────────────────────

export async function createPackageV2(payload: {
  title: string; description?: string; category: string; city?: string; durationH?: number;
  priceUsd: number; maxGroup?: number; depositRequired?: boolean; depositPercent?: number;
  paymentModesAllowed?: string[]; includedStops?: unknown[]; includedServices?: string[];
  addonIds?: string[]; isActive?: boolean;
}): Promise<ApiResult<{ pkg: MarketplacePackage; requiresAdminReview: boolean }>> {
  return apiFetch('/api/rent-a-buddy/me/packages/v2', { method: 'POST', body: JSON.stringify(payload) });
}

export async function updatePackageV2(packageId: string, patch: Partial<{
  title: string; description: string; priceUsd: number; maxGroup: number; isActive: boolean;
  depositRequired: boolean; depositPercent: number; paymentModesAllowed: string[];
  includedStops: unknown[]; includedServices: string[]; addonIds: string[];
}>): Promise<ApiResult<{ pkg: MarketplacePackage }>> {
  return apiFetch(`/api/rent-a-buddy/me/packages/v2/${packageId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function getBuddyPackages(buddyId: string): Promise<ApiResult<{ packages: MarketplacePackage[] }>> {
  return apiFetch(`/api/rent-a-buddy/buddies/${buddyId}/packages`);
}

export async function getPackage(packageId: string): Promise<ApiResult<{ pkg: MarketplacePackage & { stops: unknown[] } }>> {
  return apiFetch(`/api/rent-a-buddy/packages/${packageId}`);
}

export async function bookPackage(packageId: string, payload: {
  groupSize?: number; bookingDate?: string; notes?: string; paymentMode?: string;
}): Promise<ApiResult<{ bookingId: string; booking: BuddyBooking }>> {
  return apiFetch(`/api/rent-a-buddy/packages/${packageId}/book`, { method: 'POST', body: JSON.stringify(payload) });
}

// ── Marketplace — Add-ons & Tips ──────────────────────────────────────────────

export async function getBuddyAddons(buddyId: string): Promise<ApiResult<{ addons: BuddyAddon[] }>> {
  return apiFetch(`/api/rent-a-buddy/buddies/${buddyId}/addons`);
}

export async function createMarketplaceAddon(payload: {
  title: string; description?: string; priceUsd: number; category?: string; requiresAdminApproval?: boolean;
}): Promise<ApiResult<{ addon: BuddyAddon }>> {
  return apiFetch('/api/rent-a-buddy/me/addons', { method: 'POST', body: JSON.stringify(payload) });
}

export async function updateMarketplaceAddon(addonId: string, patch: Partial<{ title: string; description: string; priceUsd: number; isActive: boolean }>): Promise<ApiResult<{ addon: BuddyAddon }>> {
  return apiFetch(`/api/rent-a-buddy/me/addons/${addonId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function attachAddonsToBooking(bookingId: string, addonIds: string[]): Promise<ApiResult<{
  ok: boolean; newTotal: number; depositUsd: number; cashBalanceDue: number; addonsAdded: number;
}>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/addons`, { method: 'POST', body: JSON.stringify({ addonIds }) });
}

export async function leaveTip(bookingId: string, amountUsd: number, note?: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/tip`, { method: 'POST', body: JSON.stringify({ amountUsd, note }) });
}

// ── Marketplace — Saved & Waitlist ────────────────────────────────────────────

export async function saveBuddyWithNotes(buddyId: string, notes?: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/buddies/${buddyId}/save`, { method: 'POST', body: JSON.stringify({ notes }) });
}

export async function unsaveBuddyById(buddyId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/buddies/${buddyId}/save`, { method: 'DELETE' });
}

export async function getSavedBuddies(): Promise<ApiResult<{ saved: SavedBuddyEntry[] }>> {
  return apiFetch('/api/rent-a-buddy/me/saved-buddies');
}

export async function bookAgain(buddyId: string, payload?: { category?: string; durationH?: number; bookingDate?: string; notes?: string }): Promise<ApiResult<{ suggestion: unknown; message: string }>> {
  return apiFetch(`/api/rent-a-buddy/buddies/${buddyId}/book-again`, { method: 'POST', body: JSON.stringify(payload ?? {}) });
}

export async function joinWaitlistV2(payload: {
  city: string; category?: string; language?: string; budgetMaxUsd?: number;
  desiredDate?: string; desiredTime?: string; notes?: string; groupSize?: number; expiryDays?: number;
} & ({ lat: number; lng: number } | { lat?: never; lng?: never })): Promise<ApiResult<{ entry: WaitlistEntry }>> {
  return apiFetch('/api/rent-a-buddy/waitlist/v2', { method: 'POST', body: JSON.stringify(payload) });
}

export async function getWaitlistV2(): Promise<ApiResult<{ waitlist: WaitlistEntry[] }>> {
  return apiFetch('/api/rent-a-buddy/me/waitlist/v2');
}

export async function leaveWaitlistById(waitlistId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/waitlist/${waitlistId}`, { method: 'DELETE' });
}

// ── Marketplace — Pricing ─────────────────────────────────────────────────────

export async function getPricingSuggestion(params: {
  city: string; category: string; durationMinutes?: number; buddyLevel?: string; groupSize?: number; pricingType?: string;
}): Promise<ApiResult<PricingSuggestion>> {
  const qs = new URLSearchParams({
    city: params.city,
    category: params.category,
    durationMinutes: String(params.durationMinutes ?? 120),
    buddyLevel: params.buddyLevel ?? 'new',
    groupSize: String(params.groupSize ?? 1),
    pricingType: params.pricingType ?? 'hourly',
  }).toString();
  return apiFetch(`/api/rent-a-buddy/pricing/suggestion?${qs}`);
}

// ── Marketplace — Earnings ────────────────────────────────────────────────────

export async function getEarningsSummary(): Promise<ApiResult<EarningsSummary>> {
  return apiFetch('/api/rent-a-buddy/me/earnings/summary');
}

export async function getEarningsLedger(limit = 50, offset = 0): Promise<ApiResult<{ ledger: LedgerEntry[]; total: number }>> {
  return apiFetch(`/api/rent-a-buddy/me/earnings/ledger?limit=${limit}&offset=${offset}`);
}

// ── Compliance & Launch Hardening ─────────────────────────────────────────────

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
  age: number | null;
  ageOk: boolean;
  phoneVerified: boolean;
  idVerified: boolean;
  riskStatus: string;
  disclaimers: { main: string; adultService: string; emergency: string };
}

export async function getMyEligibility(category?: string): Promise<ApiResult<EligibilityResult>> {
  const qs = category ? `?category=${encodeURIComponent(category)}` : '';
  return apiFetch(`/api/rent-a-buddy/me/eligibility${qs}`);
}

export interface LocationAvailability {
  available: boolean;
  waitlistOnly: boolean;
  reason?: string;
  minAge?: number;
  nightlifeMinAge?: number;
  requireIdVerification?: boolean;
  requirePhoneVerification?: boolean;
  fullPaymentRequired?: boolean;
  disclaimers?: { main: string; emergency: string };
}

export async function checkLocationAvailability(params: {
  country?: string; city?: string; category?: string;
}): Promise<ApiResult<LocationAvailability>> {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null)) as Record<string, string>,
  ).toString();
  return apiFetch(`/api/rent-a-buddy/availability/location${qs ? '?' + qs : ''}`);
}

export interface LaunchStatus {
  enabled: boolean;
  categories: Record<string, { enabled: boolean; waitlistOnly: boolean; minAge: number }>;
}

export async function getRentABuddyFeatureStatus(): Promise<ApiResult<LaunchStatus>> {
  return apiFetch('/api/rent-a-buddy/launch-status');
}

// ── Tag consent ───────────────────────────────────────────────────────────────

export interface TagConsent {
  id: string;
  bookingId: string;
  requesterId: string;
  targetId: string;
  postId: string | null;
  consentStatus: 'pending' | 'approved' | 'declined' | 'removed' | 'auto_removed';
  declineReason: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export async function requestTagConsent(
  bookingId: string,
  targetUserId: string,
  postId?: string,
): Promise<ApiResult<{ consent: TagConsent; ok: boolean; alreadyExists?: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/tag-consent`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId, postId }),
  });
}

export async function approveTagConsent(consentId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/tag-consents/${consentId}/approve`, { method: 'POST' });
}

export async function declineTagConsent(consentId: string, reason?: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/tag-consents/${consentId}/decline`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function removeTagConsent(consentId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/tag-consents/${consentId}`, { method: 'DELETE' });
}

// ── Support reports ───────────────────────────────────────────────────────────

export type SupportCategory =
  | 'buddy_no_show' | 'traveler_no_show' | 'cash_dispute' | 'harassment'
  | 'adult_service_violation' | 'off_app_payment' | 'route_changed'
  | 'venue_scam' | 'refund_request' | 'fake_profile' | 'emergency' | 'other';

export interface SupportReport {
  id: string;
  bookingId: string;
  reporterId: string;
  category: SupportCategory;
  details: string | null;
  status: 'open' | 'in_review' | 'resolved' | 'closed';
  adminNotes: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export async function fileSupportReport(
  bookingId: string,
  category: SupportCategory,
  details?: string,
): Promise<ApiResult<{ report: SupportReport; templateResponse: { title: string; body: string } | null; ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/support/report`, {
    method: 'POST',
    body: JSON.stringify({ category, details }),
  });
}

// ── Training checklist ────────────────────────────────────────────────────────

export interface TrainingItem {
  key: string;
  label: string;
  completed: boolean;
}

export async function getTrainingChecklist(): Promise<ApiResult<{ checklist: TrainingItem[]; allComplete: boolean }>> {
  return apiFetch('/api/rent-a-buddy/me/training-checklist');
}

export async function completeTrainingItem(itemKey: string): Promise<ApiResult<{ ok: boolean; completedCount: number; allComplete: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/me/training-checklist/${itemKey}`, { method: 'POST' });
}

// ── Posting defaults ──────────────────────────────────────────────────────────

export interface PostingDefaults {
  hasActiveRentABuddyBooking: boolean;
  defaultDelayPost: boolean;
  defaultLocationGranularity: 'exact' | 'neighborhood' | 'city';
  suppressExactCoordinates: boolean;
  safetyNote: string | null;
}

export async function getPostingDefaults(): Promise<ApiResult<PostingDefaults>> {
  return apiFetch('/api/rent-a-buddy/me/posting-defaults');
}

// ── Earnings enhanced summary ─────────────────────────────────────────────────

export interface EarningsBreakdownSummary {
  totalInAppUsd: number;
  totalCashConfirmedUsd: number;
  totalPlatformFeesUsd: number;
  totalDisputedUsd: number;
  totalPendingUsd: number;
  totalNetUsd: number;
  yearlyNetUsd: number;
  monthlyBreakdown: Array<{
    month: string;
    totalUsd: number;
    bookingCount: number;
    inApp: number;
    cash: number;
    fees: number;
  }>;
  taxNote: string;
  platformFeePct: number;
}

export async function getEarningsBreakdownSummary(): Promise<ApiResult<EarningsBreakdownSummary>> {
  return apiFetch('/api/rent-a-buddy/dashboard/earnings/summary');
}

// ── Rollout & launch status ───────────────────────────────────────────────────

export type CityRolloutStatus =
  | 'disabled'
  | 'waitlist_only'
  | 'buddy_applications_open'
  | 'internal_testing'
  | 'beta_testing'
  | 'public_mvp'
  | 'paused'
  | 'suspended';

export interface LaunchStatusResponse {
  city: string;
  status: CityRolloutStatus;
  message: string;
  available: boolean;
  /** Real "someone is online right now in this city" count — the single
   * source of truth shared with /rent-a-buddy/available-now. `available`
   * above only means the city rollout status is public_mvp; it does NOT
   * mean anyone is actually available. Any surface claiming "buddies
   * available in X" must check this field, not `available` alone. */
  availableNowCount: number;
  betaAvailable: boolean;
  waitlistOpen: boolean;
  applicationsOpen: boolean;
  targetLaunchDate: string | null;
  /** The public_mvp city with the highest real availability when this city
   * is live but has zero buddies online right now. null when no other live
   * city has anyone available either. Never implies these buddies are local
   * to the viewer's city — the UI must label them with this city name. */
  suggestedCity?: string | null;
  /** Available-now count in suggestedCity at query time. */
  suggestedCityAvailableCount?: number;
}

export interface CityLaunchItem {
  city: string;
  country: string | null;
  status: CityRolloutStatus;
  targetLaunchDate: string | null;
  message: string;
}

/** GET /api/rent-buddy/launch-status?city=<city> */
export async function getLaunchStatus(city: string): Promise<ApiResult<LaunchStatusResponse>> {
  const q = encodeURIComponent(city);
  return apiFetch(`/api/rent-buddy/launch-status?city=${q}`);
}

/** GET /api/rent-buddy/launch-status — all cities */
export async function getAllLaunchStatuses(): Promise<ApiResult<{ cities: CityLaunchItem[] }>> {
  return apiFetch('/api/rent-buddy/launch-status');
}

export interface BetaAccessEntry {
  id: string;
  city: string;
  accessType: string;
  status: 'active' | 'revoked';
  createdAt: string;
}

/** GET /api/rent-buddy/me/beta-status */
export async function getMyBetaStatus(city?: string): Promise<ApiResult<{ hasBetaAccess: boolean; access: BetaAccessEntry[] }>> {
  const q = city ? `?city=${encodeURIComponent(city)}` : '';
  return apiFetch(`/api/rent-buddy/me/beta-status${q}`);
}

// ── Admin rollout endpoints ───────────────────────────────────────────────────

export interface AdminCityRollout {
  id: string;
  city: string;
  country: string | null;
  status: CityRolloutStatus;
  statusChangedAt: string | null;
  statusChangedBy: string | null;
  targetLaunchDate: string | null;
  buddyCap: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function adminGetCities(): Promise<ApiResult<{ cities: AdminCityRollout[] }>> {
  return apiFetch('/api/admin/rent-buddy/rollout/cities');
}

export async function adminCreateCity(payload: {
  city: string;
  country?: string;
  status?: CityRolloutStatus;
  targetLaunchDate?: string;
  buddyCap?: number;
  notes?: string;
}): Promise<ApiResult<{ city: AdminCityRollout }>> {
  return apiFetch('/api/admin/rent-buddy/rollout/cities', { method: 'POST', body: JSON.stringify(payload) });
}

export async function adminAdvanceCityStatus(cityId: string, overrideReason?: string): Promise<ApiResult<{ ok: boolean; fromStatus: CityRolloutStatus; toStatus: CityRolloutStatus }>> {
  return apiFetch(`/api/admin/rent-buddy/rollout/cities/${cityId}/advance-status`, {
    method: 'POST',
    body: JSON.stringify(overrideReason ? { overrideReason } : {}),
  });
}

export async function adminPauseCity(cityId: string, reason?: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/admin/rent-buddy/rollout/cities/${cityId}/pause`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export async function adminResumeCity(cityId: string, resumeStatus?: CityRolloutStatus): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/admin/rent-buddy/rollout/cities/${cityId}/resume`, { method: 'POST', body: JSON.stringify({ resumeStatus }) });
}

export async function adminGetCityMetrics(cityId: string): Promise<ApiResult<any>> {
  return apiFetch(`/api/admin/rent-buddy/rollout/cities/${cityId}/metrics`);
}

export interface BetaAccessRecord {
  id: string;
  userId: string;
  city: string;
  accessType: string;
  status: 'active' | 'revoked';
  invitedBy: string | null;
  notes: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export async function adminGetBetaAccess(filters?: { city?: string; status?: string }): Promise<ApiResult<{ betaAccess: BetaAccessRecord[] }>> {
  const q = new URLSearchParams();
  if (filters?.city)   q.set('city', filters.city);
  if (filters?.status) q.set('status', filters.status);
  const qs = q.toString();
  return apiFetch(`/api/admin/rent-buddy/beta-access${qs ? `?${qs}` : ''}`);
}

export async function adminGrantBetaAccess(payload: {
  userId: string;
  city: string;
  accessType?: string;
  notes?: string;
}): Promise<ApiResult<{ betaAccess: BetaAccessRecord }>> {
  return apiFetch('/api/admin/rent-buddy/beta-access', { method: 'POST', body: JSON.stringify(payload) });
}

export async function adminRevokeBetaAccess(betaId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/admin/rent-buddy/beta-access/${betaId}/revoke`, { method: 'POST', body: '{}' });
}

export interface LaunchChecklist {
  id: string;
  cityRolloutId: string;
  checklistStatus: 'pending' | 'in_progress' | 'passed' | 'failed';
  policyScanPassed: boolean;
  safetyFlowPassed: boolean;
  bookingFlowPassed: boolean;
  telegraphPassed: boolean;
  trustScorePassed: boolean;
  paymentFlowPassed: boolean;
  moderationPassed: boolean;
  waitlistFlowPassed: boolean;
  buddyApplicationPassed: boolean;
  testedByAdminId: string | null;
  testedAt: string | null;
  notes: string | null;
}

export async function adminGetQAChecklists(cityRolloutId?: string): Promise<ApiResult<{ checklists: LaunchChecklist[] }>> {
  const q = cityRolloutId ? `?cityRolloutId=${cityRolloutId}` : '';
  return apiFetch(`/api/admin/rent-buddy/qa/checklists${q}`);
}

export async function adminMarkChecklistPassed(checklistId: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/admin/rent-buddy/qa/checklists/${checklistId}/mark-passed`, { method: 'POST', body: '{}' });
}

export async function adminMarkChecklistFailed(checklistId: string, reason?: string): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/admin/rent-buddy/qa/checklists/${checklistId}/mark-failed`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export interface GlobalControls {
  id: 1;
  all_bookings_paused: boolean;
  applications_paused: boolean;
  cash_balance_paused: boolean;
  nightlife_paused: boolean;
  force_full_in_app: boolean;
  force_public_meetup: boolean;
  force_delayed_posting: boolean;
}

export async function adminGetGlobalControls(): Promise<ApiResult<{ controls: GlobalControls }>> {
  return apiFetch('/api/admin/rent-buddy/global-controls');
}

export async function adminUpdateGlobalControls(patch: Partial<Omit<GlobalControls, 'id'>>): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch('/api/admin/rent-buddy/global-controls', { method: 'PATCH', body: JSON.stringify(patch) });
}

/**
 * Checks whether Rent-a-Buddy is available in a given city using the server-side
 * rollout table. Returns { available: boolean, code?: string }.
 * Does NOT require authentication — safe to call from unauthenticated contexts.
 */
export async function checkCityAvailable(
  city: string,
): Promise<{ available: boolean; code?: string }> {
  try {
    const res = await apiFetch<{ available: boolean; code?: string; status?: string }>(
      `/api/rent-a-buddy/cities/${encodeURIComponent(city)}/available`,
    );
    if (!res.ok || res.data == null) return { available: false, code: 'service_unavailable' };
    return { available: res.data.available, code: res.data.code };
  } catch {
    return { available: false, code: 'service_unavailable' };
  }
}

export async function adminGetAuditLog(filters?: {
  cityRolloutId?: string;
  adminId?: string;
  action?: string;
  page?: number;
  perPage?: number;
}): Promise<ApiResult<{ logs: any[]; total: number; page: number; perPage: number }>> {
  const q = new URLSearchParams();
  if (filters?.cityRolloutId) q.set('cityRolloutId', filters.cityRolloutId);
  if (filters?.adminId)       q.set('adminId', filters.adminId);
  if (filters?.action)        q.set('action', filters.action);
  if (filters?.page)          q.set('page', String(filters.page));
  if (filters?.perPage)       q.set('perPage', String(filters.perPage));
  const qs = q.toString();
  return apiFetch(`/api/admin/rent-buddy/audit-log${qs ? `?${qs}` : ''}`);
}

// ── Profile checklist ──────────────────────────────────────────────────────────

export type ChecklistItem = {
  key: string;
  label: string;
  done: boolean;
  verificationRequired?: boolean;
};

export type ProfileChecklist = {
  checklist: ChecklistItem[];
  allComplete: boolean;
};

export async function getProfileChecklist(): Promise<ApiResult<ProfileChecklist>> {
  return apiFetch('/api/me/buddy-profile/checklist');
}

// ── Booking lifecycle helpers ──────────────────────────────────────────────────

export type DisputeReason =
  | 'cash_balance_disagreement'
  | 'no_show'
  | 'harassment'
  | 'policy_violation'
  | 'route_violation'
  | 'other';

export type BookingEvent = {
  id: string;
  event: string;
  from_status: string | null;
  to_status: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export async function openDispute(
  bookingId: string,
  reason: DisputeReason,
): Promise<ApiResult<{ ok: boolean; disputeId: string | null }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/dispute`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function reportNoShow(
  bookingId: string,
  note?: string,
): Promise<ApiResult<{ ok: boolean; disputeId: string | null; gracePeriodExpiresAt?: string }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/no-show`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

export async function travelerConfirmComplete(
  bookingId: string,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/traveler-confirm`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getBookingEvents(
  bookingId: string,
): Promise<ApiResult<{ events: BookingEvent[] }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/events`);
}

export type CheckInStatus =
  | 'arrived'
  | 'started'
  | 'could_not_find'
  | 'unsafe'
  | 'missed'
  | 'no_show';

export async function submitCheckIn(
  bookingId: string,
  status: CheckInStatus,
  broadArea?: string,
): Promise<ApiResult<{ ok: boolean }>> {
  return apiFetch(`/api/buddy-bookings/${bookingId}/check-in`, {
    method: 'POST',
    body: JSON.stringify({ status, broadArea }),
  });
}

export async function getOpenDispute(
  bookingId: string,
): Promise<ApiResult<{ dispute: Record<string, unknown> | null }>> {
  return apiFetch(`/api/rent-a-buddy/bookings/${bookingId}/dispute`);
}

export async function rebookBooking(
  originalBookingId: string,
  payload: {
    bookingDate: string;
    startTime?: string;
    durationH?: number;
    groupSize?: number;
  },
): Promise<ApiResult<{ bookingId: string; booking: Record<string, unknown> }>> {
  return apiFetch(`/api/buddy-bookings/${originalBookingId}/rebook`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
