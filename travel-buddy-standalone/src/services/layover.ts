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
  /**
   * §15 escalation state at the instant the server computed this window.
   * `serializeEnvelope` (routes/airport.ts) spreads the whole engine envelope,
   * so this and `engineVersion` have always been on the wire.
   */
  returnState: LayoverReturnState;
  engineVersion: string;
}

export interface LeaveAdvice {
  verdict: 'yes' | 'tight' | 'no' | 'stay_airside';
  reasons: string[];
  unknowns: string[];
  /** §9 machine-readable reason codes. Sent on /overview and /safety. */
  reasonCodes: string[];
  disclaimer: string;
  engineVersion: string;
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

// ── §2.1 certification · §15 safe return · §16 offline bundle ─────────────────
//
// Every type below is transcribed from the server that produces it, not from
// what a screen happens to want:
//   certificationHeader()   services/airport/LayoverFeasibility.ts
//   safeReturnPosture()     services/airport/LayoverSafeReturnService.ts
//   buildReturnContract()   services/airport/LayoverSafeReturnService.ts
//   AbortResult             services/airport/LayoverSafeReturnService.ts
//   buildOfflineBundle()    services/airport/LayoverDegradedService.ts
// A field is listed here only if that source puts it on the wire.

export type LayoverReturnState = 'NORMAL' | 'RETURN_SOON' | 'RETURN_NOW' | 'CONNECTION_AT_RISK';
export type EstimateConfidence = 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH';
export type EstimatePercentile = 'p50' | 'p75' | 'p90';

/**
 * §2.1 "versioned, explainable and replayable" — what lets a stored answer be
 * traced to the rules and inputs that produced it. `computedAt` is the instant
 * the SERVER certified the answer; it is the only freshness claim on this
 * object, and the client must not upgrade it into a stronger one.
 */
export interface LayoverCertification {
  engineVersion: string;
  feasibilityVersion: string;
  inputHash: string;
  /** ISO instant the record was computed for. */
  computedAt: string;
  verdict: LeaveAdvice['verdict'];
  confidence: EstimateConfidence;
  bufferPercentile: EstimatePercentile;
}

export type SafeReturnPrimaryAction = 'explore' | 'plan_return' | 'return_now' | 'recover_connection';

/** §15 — what the surface must do now, derived from the certified record. */
export interface SafeReturnPosture {
  safeReturnVersion: string;
  returnState: LayoverReturnState;
  explorationCollapsed: boolean;
  returnRoutePrimary: boolean;
  pinTerminalContext: boolean;
  notifyCrew: boolean;
  offerRecoveryHelp: boolean;
  primaryAction: SafeReturnPrimaryAction;
  /** §15.1: true in EVERY state, including NORMAL. */
  abortAvailable: boolean;
  minutesToHardReturn: number;
}

/** §15.1 — the contract handed back by the abort, and cacheable offline. */
export interface ReturnContract {
  safeReturnVersion: string;
  hardReturnTime: string;
  returnState: LayoverReturnState;
  minutesToHardReturn: number;
  bufferMinutes: number;
  breakdown: LayoverWindow['breakdown'];
  airport: {
    id: string | null;
    iataCode: string;
    name: string;
    city: string;
    country: string;
    timezone: string;
    lat: number | null;
    lng: number | null;
    terminalInfo: unknown | null;
  };
  /** Always null on this tree — there is no routing provider. */
  route: null;
  routeUnavailableReason: 'no_routing_provider';
  certification: LayoverCertification;
}

export type OfflineUnavailableReason =
  | 'no_routing_provider'
  | 'no_envelope_geometry'
  | 'no_flight_feed'
  | 'no_crew_storage'
  | 'no_phrase_catalogue';

export interface OfflineCapability<T> {
  available: boolean;
  value: T | null;
  reason: OfflineUnavailableReason | null;
}

export interface LayoverOfflineBundle {
  bundleVersion: string;
  sessionId: string;
  /** Instant the underlying feasibility record was certified for. */
  certifiedAt: string;
  /** After this instant a client MUST badge the bundle stale. */
  staleAfter: string;
  certification: LayoverCertification;
  returnDeadline: {
    hardReturnTime: string;
    hardReturnLocal: string | null;
    returnState: LayoverReturnState;
    bufferMinutes: number;
    returnReminderAt: string | null;
  };
  airport: {
    iataCode: string;
    name: string;
    city: string;
    country: string;
    timezone: string;
    lat: number | null;
    lng: number | null;
    terminalInfo: Record<string, unknown> | null;
  };
  mapGeometry: OfflineCapability<never>;
  route: OfflineCapability<never>;
  flightStatus: OfflineCapability<never>;
  crewMeetingPoint: OfflineCapability<never>;
  translationPhrases: OfflineCapability<never>;
  stops: Array<{ title: string; durationMin: number; travelMin: number; insideAirport: boolean }>;
}

export type AbortEffect =
  | 'itinerary_cancelled'
  | 'itinerary_cancel_failed'
  | 'itinerary_nothing_to_cancel'
  | 'status_marked_returning'
  | 'status_unchanged_flag_off'
  | 'status_unchanged_no_active_row'
  | 'status_write_failed'
  | 'ledger_recorded'
  | 'ledger_write_failed'
  | 'crew_notify_unavailable';

export type ReturnNowStatusCapability = 'enabled' | 'flag_on_readers_not_widened' | 'flag_off';

/** The 200 body of POST /airport/sessions/:id/return-now. */
export interface ReturnNowSuccess {
  ok: true;
  safeReturnVersion: string;
  abortedAt: string;
  returnContract: ReturnContract;
  posture: SafeReturnPosture;
  cancelledStopIds: string[];
  effects: AbortEffect[];
  crewNotified: string[];
  crewNotifyUnavailableReason: 'no_crew_storage' | null;
  statusApplied: boolean;
  statusCapability: ReturnNowStatusCapability;
}

/**
 * The abort's outcomes, as the SERVER distinguishes them.
 *
 * `partial` is the load-bearing one: the route answers 500 with `ok:false` AND
 * still carries `returnContract` + `posture`, because "head to the airport now"
 * must survive a half-failed abort. Collapsing that into a generic error would
 * throw away the only instruction that matters at that moment — so the shape
 * forces every caller to have somewhere to put the contract.
 */
export type ReturnNowOutcome =
  | { kind: 'ok'; result: ReturnNowSuccess }
  | {
      kind: 'partial';
      message: string;
      returnContract: ReturnContract;
      posture: SafeReturnPosture;
      effects: AbortEffect[];
    }
  | { kind: 'already_ended'; message: string }
  | { kind: 'offline' }
  | { kind: 'error'; status: number | null; message: string };

export interface LayoverOverview {
  session: LayoverSession;
  airport: PublicAirport;
  window: LayoverWindow;
  advice: LeaveAdvice;
  stops: PlanStop[];
  planFit: PlanFit;
  share: { enabled: boolean; othersInCity: number };
  /** §2.1 — which rules and which inputs produced `advice`/`window`. */
  certification: LayoverCertification;
  /** §15 — the posture the surface should take now. */
  safeReturn: SafeReturnPosture;
  /** §16 — the bundle that lets an offline client say how old its answer is. */
  offlineBundle: LayoverOfflineBundle;
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
  tier: LayoverTier;
  tierLabel: string;
  /** Provenance of the 20-minute landside probe leg. Never "measured" here. */
  travelTimeSource: string;
  advice: LeaveAdvice;
  certification: LayoverCertification;
  safeReturn: SafeReturnPosture;
}

export interface CompassClarifyingQuestion {
  field: string;
  question: string;
  impact: {
    verdictChanges: boolean;
    riskBandChanges: boolean;
    returnStateChanges: boolean;
    usableMinutesDelta: number;
  };
  valueOfInformation: number;
}

export interface CompassBoundaryViolation {
  kind: string;
  /** The exact substring that violated the certified envelope. */
  stated: string;
  /** The certified value it exceeded. */
  certified: string;
}

export interface CompassAnswer {
  ok: true;
  answer: string;
  safetyNote: string | null;
  hardReturnTime: string | null;
  bufferMinutes: number;
  involvesLeaving: boolean;
  /** §12.1 — the single highest-value clarifying question, or null. */
  clarifyingQuestion: CompassClarifyingQuestion | null;
  /** §12 — envelope-widening the model attempted. Empty is the norm. */
  boundaryViolations: CompassBoundaryViolation[];
  /** §20 — which rules and which inputs produced the figures above. */
  certification: LayoverCertification;
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

export interface ReturnDeadlineResult {
  ok: true;
  hardReturnTime: string;
  hardReturnLocal: string;
  reminderAt: string;
  bufferMinutes: number;
  reminderMinutesBefore: number;
  certification: LayoverCertification;
  safeReturn: SafeReturnPosture;
}

export async function setReturnDeadline(
  sessionId: string,
  minutesBefore = 30,
): Promise<ReturnDeadlineResult | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'return-deadline'), {
    method: 'POST',
    body: JSON.stringify({ minutesBefore }),
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * §15.1 one-tap abort — POST /api/airport/sessions/:id/return-now.
 *
 * ── WHY THE FAILURE PATH IS NOT AN ERROR PATH ────────────────────────────────
 * The route answers 500 with `ok:false` and STILL sends `returnContract` and
 * `posture`, deliberately: the itinerary may not have been cleared and the
 * ledger may not have been written, but the hard return time is still true and
 * "head to the airport now" is the one instruction that must survive a partial
 * failure. So this function does not decide by status code — it decides by
 * WHAT IS IN THE BODY. A body carrying a return contract is never reported as
 * a bare error, whatever the status line said.
 *
 * Nothing here guards against a double tap; the caller owns the press. The
 * server is idempotent-safe either way (see the route's comment), and a guard
 * living in the service would silently swallow a deliberate retry.
 */
export async function returnToAirportNow(sessionId: string): Promise<ReturnNowOutcome> {
  let res: Response;
  try {
    res = await authedFetch(airportUrl('sessions', sessionId, 'return-now'), { method: 'POST' });
  } catch {
    // No response at all: airplane mode, dead tunnel, DNS. The caller falls
    // back to the last certified deadline it already holds.
    return { kind: 'offline' };
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  // Body first, status second. A 500 that carries the contract is a PARTIAL
  // abort, not an outage, and the traveller still gets their return time.
  if (body && body.returnContract && body.posture) {
    if (body.ok === true) return { kind: 'ok', result: body as ReturnNowSuccess };
    return {
      kind: 'partial',
      message: typeof body.message === 'string' && body.message
        ? body.message
        : 'Your plan could not be fully cleared. Head to the airport now.',
      returnContract: body.returnContract as ReturnContract,
      posture: body.posture as SafeReturnPosture,
      effects: Array.isArray(body.effects) ? (body.effects as AbortEffect[]) : [],
    };
  }

  // 400 invalid_payload on this route means exactly one thing: the session has
  // already ended. `invalid_payload` is not in the server's SANITIZED_CODES, so
  // the specific message ("This layover is already completed.") reaches us.
  if (res.status === 400) {
    return {
      kind: 'already_ended',
      message: typeof body?.message === 'string' ? body.message : 'This layover has already ended.',
    };
  }

  return {
    kind: 'error',
    status: res.status ?? null,
    message: typeof body?.message === 'string' ? body.message : 'Could not start the return.',
  };
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
  if (!json.ok) return null;
  // The cast below is the only thing standing between this type and the wire.
  // A screen that renders a field ONLY when it is present looks perfectly fine
  // against a server that never sends it, so the absence is made loud here
  // rather than left to show up as a missing badge nobody notices.
  for (const field of ['certification', 'safeReturn', 'offlineBundle'] as const) {
    if (json[field] == null) {
      console.warn(`[layover] overview is missing "${field}" — server contract mismatch`);
    }
  }
  return json as LayoverOverview;
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
