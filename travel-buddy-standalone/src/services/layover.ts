/**
 * Layover Mode — API service layer
 *
 * All calls go through the API server (no direct Supabase from client for layover data).
 */
import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

function airportUrl(...parts: string[]) {
  return `${apiBase()}/api/airport/${parts.join('/')}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type FlightType = 'domestic' | 'international';
export type ComfortLevel = 'safe_only' | 'moderate' | 'adventurous';
export type SafetyRating = 'safe' | 'possible_but_risky' | 'not_recommended' | 'airport_only';

export interface AirportProfile {
  id: string | null;
  iataCode: string;
  name: string;
  city: string;
  country: string;
  countryCode: string;
  timezone: string;
  lat: number;
  lng: number;
  domesticBufferMin: number;
  internationalBufferMin: number;
  verified: boolean;
}

export interface LayoverSession {
  id: string;
  userId: string;
  airportId: string | null;
  tripId: string | null;
  arrivalTime: string;
  departureTime: string;
  boardingTime: string | null;
  layoverMinutes: number;
  flightType: FlightType;
  immigrationRequired: boolean;
  checkedBags: boolean;
  loungeAccess: boolean;
  wantsToLeave: boolean;
  comfortLevel: ComfortLevel;
  vibeChips: string[];
  manualAirportName: string | null;
  manualCity: string | null;
  manualCountry: string | null;
  manualIata: string | null;
  canonicalCityId: string | null;
  shareCityStatus: boolean;
  returnReminderAt: string | null;
  status: 'active' | 'completed' | 'cancelled' | 'expired';
  createdAt: string;
}

export type LayoverTier = 'too_short' | 'airport_only' | 'quick_city' | 'half_day' | 'overnight';

export interface LayoverWindow {
  totalMinutes: number;
  exitDelayMin: number;
  returnBufferMin: number;
  usableMinutes: number;
  hardReturnTime: string;
  earliestOutTime: string;
  breakdown: {
    baseBuffer: number;
    immigrationExtra: number;
    bagsExtra: number;
    trafficExtra: number;
    timeOfDayExtra: number;
    totalBuffer: number;
    exitDelay: number;
  };
  tier: LayoverTier;
  tierLabel: string;
  tierBlurb: string;
  overnight: boolean;
}

/** Mirrors the server's LeaveAdvice (services/airport/LayoverSafetyEngine). */
export type EntryEligibility =
  | { state: 'permitted'; passportCountry: string; destinationCountry: string; status: string;
      condition: string | null; officialSourceUrl: string | null; lastVerifiedAt: string | null; disclaimer: string }
  | { state: 'not_permitted'; passportCountry: string; destinationCountry: string; status: string;
      reason: string; officialSourceUrl: string | null; lastVerifiedAt: string | null; disclaimer: string }
  | { state: 'unresolved'; reason: string; passportCountry: string | null;
      destinationCountry: string | null; disclaimer: string };

export interface LeaveAdvice {
  /**
   * `entry_unverified` means the clock says there is time but we have not
   * established that this traveller may cross the border. It is deliberately not
   * folded into 'no' (which means "not enough time") or 'tight': the two need
   * different things from the user — one is a scheduling fact, the other is a
   * missing passport or an uncurated corridor they can act on.
   */
  verdict: 'yes' | 'tight' | 'no' | 'stay_airside' | 'entry_unverified';
  reasons: string[];
  unknowns: string[];
  entry: EntryEligibility | null;
  disclaimer: string;
}

export interface PlanStop {
  id: string;
  title: string;
  description: string | null;
  stopOrder: number;
  durationMin: number;
  travelMin: number;
  placeId: string | null;
  recommendationId: string | null;
  lat: number | null;
  lng: number | null;
  locationLabel: string | null;
  insideAirport: boolean;
  source: 'user' | 'recommendation' | 'ai';
}

export interface PlanFit {
  totalPlannedMin: number;
  returnTravelMin: number;
  neededMin: number;
  usableMinutes: number;
  fitsWindow: boolean;
  overflowMin: number;
  backByTime: string;
}

export interface PublicAirport {
  id: string | null;
  iataCode: string;
  name: string;
  city: string;
  country: string;
  countryCode: string | null;
  timezone: string;
  lat: number | null;
  lng: number | null;
  verified: boolean;
}

export interface LayoverLocalTimes {
  timezone: string;
  airportNow: string;
  airportToday: string;
  arrivalLocal: string;
  arrivalDay: string;
  departureLocal: string;
  departureDay: string;
  boardingLocal: string | null;
  hardReturnLocal: string;
}

export interface LayoverOverview {
  session: LayoverSession;
  airport: PublicAirport;
  window: LayoverWindow;
  advice: LeaveAdvice;
  stops: PlanStop[];
  planFit: PlanFit;
  share: { enabled: boolean; othersInCity: number };
  returnReminderAt: string | null;
  localTimes: LayoverLocalTimes;
}

export interface PresenceTraveler {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface LayoverBuddy {
  id: string;
  userId: string;
  displayName: string | null;
  tagline: string | null;
  city: string | null;
  country: string | null;
  categories: string[];
  hourlyRateUsd: number | null;
  averageRating: number | null;
  reviewCount: number;
  verified: boolean;
  coverPhotoUrl: string | null;
  buddyLevel: string | null;
  availableNow: boolean;
  availableDuringLayover: boolean;
}

export interface CreateSessionPayload {
  airportId?: string | null;
  /** Preferred: IATA code from the picker — server resolves tz + profile. */
  iata?: string | null;
  tripId?: string | null;
  /** Legacy UTC instants. Prefer the *Local wall-time fields below. */
  arrivalTime?: string;
  departureTime?: string;
  boardingTime?: string | null;
  /** Airport-local wall times "YYYY-MM-DDTHH:mm" — converted server-side. */
  arrivalLocal?: string | null;
  departureLocal?: string | null;
  boardingLocal?: string | null;
  flightType?: FlightType;
  immigrationRequired?: boolean;
  checkedBags?: boolean;
  loungeAccess?: boolean;
  wantsToLeave?: boolean;
  comfortLevel?: ComfortLevel;
  vibeChips?: string[];
  manualAirportName?: string | null;
  manualCity?: string | null;
  manualCountry?: string | null;
  manualIata?: string | null;
}

export interface LayoverRecommendation {
  id?: string;
  recType: string;
  title: string;
  description: string | null;
  safetyRating: SafetyRating;
  safetyLabel: string;
  travelTimeMin: number;
  activityTimeMin: number;
  returnBufferMin: number;
  hardReturnTime: string | null;
  warningReason: string | null;
  insideAirport: boolean;
  locationLabel: string | null;
  city: string | null;
  neighborhood: string | null;
  meetupLocationHidden: boolean;
  meetupLocationReveal: string | null;
  placeId: string | null;
  sortOrder: number;
}

export interface LayoverSafetyResult {
  overallRating: SafetyRating;
  overallLabel: string;
  availableMinutes: number;
  usableMinutes: number;
  returnBufferMin: number;
  hardReturnTime: string;
  warningReason: string | null;
  breakdown: {
    baseBuffer: number;
    immigrationExtra: number;
    bagsExtra: number;
    trafficExtra: number;
    timeOfDayExtra: number;
    totalBuffer: number;
  };
  layoverMinutes: number;
}

export interface CompassAnswer {
  answer: string;
  safetyNote: string | null;
  hardReturnTime: string | null;
  bufferMinutes: number;
  involvesLeaving: boolean;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function searchAirports(query: string): Promise<AirportProfile[]> {
  try {
    const res = await authedFetch(airportUrl(`search?q=${encodeURIComponent(query)}`));
    if (!res.ok) return [];
    const json = await res.json();
    return json.airports ?? [];
  } catch (err) {
    console.warn('[layover] searchAirports failed:', err);
    return [];
  }
}

export async function resolveAirportByIata(iata: string): Promise<AirportProfile | null> {
  try {
    const res = await authedFetch(airportUrl(`search?iata=${encodeURIComponent(iata)}`));
    if (!res.ok) return null;
    const json = await res.json();
    return json.airports?.[0] ?? null;
  } catch (err) {
    console.warn('[layover] resolveAirportByIata failed:', err);
    return null;
  }
}

export async function createLayoverSession(payload: CreateSessionPayload): Promise<{
  session: LayoverSession;
  safeReturnSuggested: boolean;
  safeReturnReasons: string[];
}> {
  const res = await authedFetch(airportUrl('sessions'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to create layover session: ${res.status}`);
  return res.json();
}

export async function updateLayoverSession(
  sessionId: string,
  updates: Partial<CreateSessionPayload>,
): Promise<LayoverSession> {
  const res = await authedFetch(airportUrl('sessions', sessionId), {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Failed to update layover session: ${res.status}`);
  const json = await res.json();
  return json.session;
}

export async function getRecommendations(sessionId: string): Promise<LayoverRecommendation[]> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'recommendations'));
  if (!res.ok) return [];
  const json = await res.json();
  return json.recommendations ?? [];
}

export async function getSessionSafety(sessionId: string): Promise<LayoverSafetyResult | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'safety'));
  if (!res.ok) return null;
  const json = await res.json();
  return json.featureEnabled ? json : null;
}

export async function askCompass(sessionId: string, question: string): Promise<CompassAnswer | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'compass'), {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function setReturnDeadline(
  sessionId: string,
  minutesBefore = 30,
): Promise<{ hardReturnTime: string; hardReturnLocal?: string; reminderAt?: string; bufferMinutes: number } | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'return-deadline'), {
    method: 'POST',
    body: JSON.stringify({ minutesBefore }),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function endLayoverSession(sessionId: string): Promise<boolean> {
  const res = await authedFetch(airportUrl('sessions', sessionId), { method: 'DELETE' });
  return res.ok;
}

// ── Dashboard / overview ──────────────────────────────────────────────────────

export async function getActiveLayoverSession(): Promise<{
  session: LayoverSession | null;
  airport?: PublicAirport;
} | null> {
  const res = await authedFetch(airportUrl('sessions', 'active'));
  if (!res.ok) return null;
  return res.json();
}

export async function listLayoverSessions(
  status?: LayoverSession['status'],
): Promise<LayoverSession[]> {
  const qs = status ? `?status=${status}` : '';
  const res = await authedFetch(airportUrl(`sessions${qs}`));
  if (!res.ok) return [];
  const json = await res.json();
  return json.sessions ?? [];
}

export async function getLayoverOverview(sessionId: string): Promise<LayoverOverview | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'overview'));
  if (!res.ok) return null;
  const json = await res.json();
  return json.ok ? (json as LayoverOverview) : null;
}

// ── Mini-itinerary plan stops ─────────────────────────────────────────────────

export interface StopsResponse { stops: PlanStop[]; planFit: PlanFit }

export interface NewStopInput {
  title: string;
  description?: string | null;
  durationMin: number;
  travelMin?: number;
  locationLabel?: string | null;
  insideAirport?: boolean;
  lat?: number | null;
  lng?: number | null;
  placeId?: string | null;
}

export async function getPlanStops(sessionId: string): Promise<StopsResponse | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'stops'));
  if (!res.ok) return null;
  return res.json();
}

export async function addPlanStop(sessionId: string, stop: NewStopInput): Promise<StopsResponse | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'stops'), {
    method: 'POST',
    body: JSON.stringify(stop),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function addStopFromRecommendation(
  sessionId: string,
  recommendationId: string,
): Promise<StopsResponse | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'stops', 'from-recommendation'), {
    method: 'POST',
    body: JSON.stringify({ recommendationId }),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function updatePlanStop(
  sessionId: string,
  stopId: string,
  updates: Partial<NewStopInput>,
): Promise<StopsResponse | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'stops', stopId), {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function deletePlanStop(sessionId: string, stopId: string): Promise<StopsResponse | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'stops', stopId), { method: 'DELETE' });
  if (!res.ok) return null;
  return res.json();
}

export async function reorderPlanStops(sessionId: string, orderedIds: string[]): Promise<StopsResponse | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'stops', 'reorder'), {
    method: 'POST',
    body: JSON.stringify({ orderedIds }),
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Sharing, presence & buddies ───────────────────────────────────────────────

export async function setShareCityStatus(sessionId: string, enabled: boolean): Promise<LayoverSession | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'share'), {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.session ?? null;
}

export async function getLayoverPresence(sessionId: string): Promise<{
  sharing: boolean;
  city?: string | null;
  count: number;
  travelers: PresenceTraveler[];
} | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'presence'));
  if (!res.ok) return null;
  return res.json();
}

export async function getLayoverBuddies(sessionId: string): Promise<{
  city: string | null;
  buddies: LayoverBuddy[];
} | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'buddies'));
  if (!res.ok) return null;
  return res.json();
}

// ── Telegraph ─────────────────────────────────────────────────────────────────

export async function sendLayoverTelegraph(sessionId: string, message: string): Promise<{
  intent: string;
  city: string | null;
  threadId: string | null;
} | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'telegraph'), {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
  if (!res.ok) return null;
  return res.json();
}
