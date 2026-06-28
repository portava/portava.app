/**
 * Layover Mode — API service layer
 *
 * All calls go through the API server (no direct Supabase from client for layover data).
 */
import { supabase } from '../lib/supabase';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
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
  status: 'active' | 'completed' | 'cancelled' | 'expired';
  createdAt: string;
}

export interface CreateSessionPayload {
  airportId?: string | null;
  tripId?: string | null;
  arrivalTime: string;
  departureTime: string;
  boardingTime?: string | null;
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
  const res = await authedFetch(airportUrl(`search?q=${encodeURIComponent(query)}`));
  if (!res.ok) return [];
  const json = await res.json();
  return json.airports ?? [];
}

export async function resolveAirportByIata(iata: string): Promise<AirportProfile | null> {
  const res = await authedFetch(airportUrl(`search?iata=${encodeURIComponent(iata)}`));
  if (!res.ok) return null;
  const json = await res.json();
  return json.airports?.[0] ?? null;
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
): Promise<{ hardReturnTime: string; bufferMinutes: number } | null> {
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
