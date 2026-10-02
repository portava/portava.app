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
  /**
   * §7 — the generalised Temporal Freedom Engine's window for this layover's
   * two commitments (the inbound flight and the outbound flight). `null` when
   * there is none, which is the case `shortfallMinutes` explains.
   *
   * Typed narrowly on purpose: the server sends the engine's whole
   * `FreedomWindow` and this declares only the members a screen reads. The rest
   * are on the wire and unread, which is a fact about this client rather than
   * about the server.
   */
  freedomWindow: {
    beginsAt: string;
    endsAt: string;
    durationMinutes: number;
    /** Minutes reserved off the end for the return buffer. */
    reservedMinutes: number | null;
    /** Never true while no routed travel-time provider is configured. */
    certified: boolean;
  } | null;
  /**
   * §7.2 — how many minutes short the traveller is when there is NO window at
   * all: the required buffer (and, for a layover with no gap, the cutoff
   * itself) leaves nothing between landing and heading back. `null` whenever a
   * window exists. Before this the traveller saw `usableMinutes: 0` and the
   * number they were short by existed nowhere.
   */
  shortfallMinutes: number | null;
}

export interface LeaveAdvice {
  verdict: 'yes' | 'tight' | 'no' | 'entry_unverified' | 'stay_airside';
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
  /** Narrow claim: TRUE only when `fit === 'fits'`. */
  fitsWindow: boolean;
  /**
   * §6.1's plan-level answer, three-valued because the server refuses to
   * certify a total that omits a leg nobody stated (census L47). `over` is
   * certain — even the lower bound overflows; `unknown` means the plan may fit
   * and has not been measured; `fits` means every leg is stated and it does.
   */
  fit: 'fits' | 'over' | 'unknown';
  /** Landside stops whose journey is not a stated figure. */
  unstatedTravelStops: number;
  /** Stops whose dwell time is not a stated figure. */
  unstatedDurationStops: number;
  /** TRUE when `neededMin` omits a leg, so the real total is larger. */
  neededMinIsLowerBound: boolean;
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

/**
 * §2.1 "degrades VISIBLY" · §22 "do not imply equivalent intelligence globally".
 *
 * Transcribed from `airportIntelligence()` in
 * `artifacts/api-server/src/services/airport/LayoverFeasibility.ts`. The server
 * derives every field from the certified record's own estimates; the client
 * must not re-derive a maturity of its own from `airport.verified`, because a
 * second opinion about the same numbers is the duplicate derivation this
 * surface has been removing for four passes.
 */
export type AirportIntelligenceTier = 'GENERIC' | 'AIRPORT_RECORD' | 'VERIFIED_RECORD' | 'LIVE';

export interface LayoverAirportIntelligence {
  tier: AirportIntelligenceTier;
  airportAddressable: boolean;
  airportVerified: boolean;
  liveObserved: boolean;
  bufferSourceClass: string;
  /** 2 = an airport row supplied the buffers, 3 = a code constant did. */
  bufferFallbackLevel: 0 | 1 | 2 | 3;
  confidence: EstimateConfidence;
  sourceRefs: string[];
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
  /**
   * §16 L154 — the crew meeting point, cached for offline.
   *
   * TYPED `<string>`, AND THE OLD `<never>` WAS THE WHOLE DEFECT. In
   * `OfflineCapability<T>`, `value` is `T | null`; at `T = never` that collapses
   * to `null`, so this field could not hold a label however the server behaved.
   * L154 could never have been closed from the server side alone — there was no
   * shape on this side of the wire for the answer to land in.
   *
   * `layover_crews.meeting_point_label` exists and `LayoverCrewSection` already
   * renders it on the ONLINE crew screen (`crew.meetingPointLabel`). This is the
   * OFFLINE half: the one thing about a crew worth surviving the network dying
   * is where to meet them.
   *
   * NOT YET SERVED. `buildOfflineBundle`
   * (artifacts/api-server/src/services/airport/LayoverDegradedService.ts) still
   * returns `unavailable("no_crew_storage")` unconditionally, and its own type
   * is still `<never>`. So today every response makes this unavailable and the
   * card renders the unavailable branch. The client is ready; the server is one
   * `available(label)` call away. See the report for LO-API.
   */
  crewMeetingPoint: OfflineCapability<string>;
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

/**
 * §15.1 L144 — WHY the crew was not told, in the server's vocabulary.
 *
 * ── WHY THIS IS OPEN AND NOT A CLOSED UNION ──────────────────────────────────
 * It was `'no_crew_storage' | null`, and `'no_crew_storage'` HAS BEEN FALSE
 * SINCE 2026-09-16: `layover_crews` / `layover_crew_members` exist,
 * `LayoverCrewStore` reads and writes them, and `LayoverCrewSection` puts a
 * crew on screen. A closed union whose only member is a stale sentence cannot
 * hold the answer, so the transport was sealed shut from this end — the same
 * shape of defect as `crewMeetingPoint: OfflineCapability<never>` above.
 *
 * It is `string` rather than a rewritten union because THE VOCABULARY IS THE
 * SERVER'S. That follows the precedent already set on this wire for exactly
 * this kind of field — `LayoverPresenceAnswer.withheld` and `degradedReasons`
 * are both documented `string[]`. A client union would silently narrow a reason
 * it had not been taught, and `returnToAirportNow` casts the body whole, so a
 * narrowed union would be a lie the compiler could not catch.
 *
 * KNOWN MEMBERS TODAY, and neither is a policy decision:
 *   `no_crew_storage`  what the server still sends unconditionally
 *                      (LayoverSafeReturnService.ts:383), now stale.
 *
 * ── WHAT THIS CLIENT DELIBERATELY DOES NOT DECIDE ────────────────────────────
 * Whether a crew SHOULD be told that one of its members aborted is a
 * DISCLOSURE ABOUT THAT TRAVELLER, not plumbing, and it is the owner's call —
 * so nothing here initiates a notification, offers a control that would, or
 * asks the server to send one. This type and `describeCrewNotification` only
 * let the ABORTING TRAVELLER read back what the server says already happened
 * about them, which they are owed either way.
 */
export type CrewNotifyUnavailableReason = string;

/** The 200 body of POST /airport/sessions/:id/return-now. */
export interface ReturnNowSuccess {
  ok: true;
  safeReturnVersion: string;
  abortedAt: string;
  returnContract: ReturnContract;
  posture: SafeReturnPosture;
  cancelledStopIds: string[];
  effects: AbortEffect[];
  /** User ids the server says it told. Empty is an ANSWER, not a placeholder. */
  crewNotified: string[];
  crewNotifyUnavailableReason: CrewNotifyUnavailableReason | null;
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

/**
 * §8 / §13 — the certified safe-envelope GEOMETRY, exactly as the server cuts
 * it (`services/airport/LayoverEnvelope.ts`). Published on `GET /overview` as
 * `safeEnvelope` since census L63 and, until this type existed, READ BY
 * NOTHING: the map had no geometry to consume because no client type had a
 * field for it, which is why L116 and L121 both read `N` while the server was
 * already sending the answer.
 *
 * TWO radii, and the difference is the point. `radiusMetres` is PROVED —
 * outside it the round trip exceeds the certified window at a straight-line
 * lower bound, so nothing fits however it is travelled to. `plannedRadiusMetres`
 * is the CONTRACTED planning edge after the §6.2 confidence haircut; a place
 * between the two is FLAGGED and never blocked.
 *
 * `certifiedInward: false` is a permanent, deliberate field: being inside the
 * disc is not a certification that anything fits, because there is no routed
 * provider to certify with. A surface that renders the disc as "safe" is the
 * L293 defect in a new shape.
 */
export interface LayoverSafeEnvelope {
  centre: { lat: number; lng: number };
  /** Metres. Outside this, nothing fits at any speed. */
  radiusMetres: number;
  /** The certified §7 window the radius was cut from. */
  usableMinutes: number;
  maxOneWayMinutes: number;
  basis: 'straight_line_lower_bound';
  /** Always true: a point outside the disc is certainly infeasible. */
  certifiedOutward: true;
  /** Always false: a point inside the disc is NOT certified to fit. */
  certifiedInward: false;
  confidence: EstimateConfidence | null;
  /** Minutes of the window deliberately not planned against. */
  uncertaintyBudgetMinutes: number;
  plannedMaxOneWayMinutes: number;
  /** The contracted edge. <= radiusMetres, equal only at HIGH confidence. */
  plannedRadiusMetres: number;
}

/** §13's band vocabulary. `SAFE`/`TIGHT` have no producer on this tree. */
export type EnvelopeBand = 'SAFE' | 'TIGHT' | 'BLOCKED' | 'UNCERTIFIED';

/**
 * §13 L122 — the feasibility state a candidate PIN carries, straight off the
 * recommendation contract (`services/airport/layoverRankingFeasibility.ts`).
 *
 * The map consumes this and does not recalculate: L115 forbids a second
 * feasibility rule on the client, and the overview's `safeEnvelope` makes one
 * tempting (a haversine against `centre` is four lines). The band is decided
 * once, on the server, beside the certification that produced the window.
 */
export interface CandidateFeasibility {
  band: EnvelopeBand;
  /** TRUE only when an envelope actually measured this candidate. */
  certified: boolean;
  lowerBoundOneWayMin: number | null;
  /** Inside the contracted planning edge. `null` when nothing measured it. */
  withinPlannedEdge: boolean | null;
  reason: string | null;
  plannedEdgeReason: string | null;
  /** Whether this band CERTIFIES a fit. False for every band this tree emits. */
  impliesFit: boolean;
}

/**
 * Mirrors `services/airport/LayoverReturnEscalation.ts#ReminderDisposition`.
 * Kept structural rather than importing: this package does not depend on the
 * api-server sources, and a wire shape that drifts should fail at the surface
 * that reads it, not silently typecheck against a stale copy of the server.
 */
export interface LayoverReminderDisposition {
  action: 'none' | 'keep' | 'fired' | 'reschedule' | 'cancel';
  reason:
    | 'no_reminder_scheduled'
    | 'reminder_unreadable'
    | 'aligned'
    | 'below_material_threshold'
    | 'already_fired'
    | 'deadline_moved'
    | 'deadline_moved_after_fire'
    | 'rung_already_passed'
    | 'deadline_passed';
  /** POSITIVE: the flight went later, so the reminder now fires too EARLY. */
  driftMinutes: number;
  materialChange: boolean;
  /** The instant to schedule at, or null when there is nothing to schedule. */
  firesAt: string | null;
  /** The instant currently stored, so a surface can say what it replaces. */
  staleFiresAt: string | null;
  /** The §15 rung in force. `label` is the only field a surface should render. */
  rung: { level: string; priority: string; label: string };
}

export interface LayoverOverview {
  session: LayoverSession;
  airport: PublicAirport;
  window: LayoverWindow;
  advice: LeaveAdvice;
  stops: PlanStop[];
  planFit: PlanFit;
  share: { enabled: boolean; othersInCity: number };
  /**
   * §24 — what the SERVER thinks of the reminder it stored, recomputed against
   * the currently certified hard return on every overview read.
   *
   * `action` is the whole point: a reminder scheduled against a deadline that
   * has since moved is not a reminder, and a footer that keeps rendering
   * "Reminder set" over it is lying. `reason` is a stable token and never a
   * sentence — the surface writes its own words.
   *
   * Optional for the same reason as `toolsConsulted`: an older server does not
   * send it, and absent must render as nothing rather than as `none`.
   */
  reminder?: LayoverReminderDisposition;
  /** §2.1 — which rules and which inputs produced `advice`/`window`. */
  certification: LayoverCertification;
  /** §2.1/§22 — how much of THIS airport went into those numbers. */
  airportIntelligence: LayoverAirportIntelligence;
  /** §15 — the posture the surface should take now. */
  safeReturn: SafeReturnPosture;
  /** §16 — the bundle that lets an offline client say how old its answer is. */
  offlineBundle: LayoverOfflineBundle;
  /**
   * §8/§13 — the certified envelope geometry the map draws. `null` only when
   * the airport has no usable coordinate, which is what every
   * `buildFallbackProfile` airport carries: an envelope centred on (0,0) would
   * block every real place on earth, so the absence of a coordinate produces
   * the absence of an envelope and never a default one.
   */
  safeEnvelope: LayoverSafeEnvelope | null;
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
  /**
   * Minutes to get there, or NULL when nobody has measured the journey
   * (census-layover L293). It is not 0 and must never be rendered as one: the
   * server has no routed travel-time provider, so this is null for every
   * landside card. Show the absence; a blank reads as "nearby".
   */
  travelTimeMin: number | null;
  /** Minutes at the destination, or NULL when nobody stated a duration. */
  activityTimeMin: number | null;
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
  /**
   * §13 L122 — the band this card's PIN renders. Always present from a server
   * that has the candidate-feasibility contract; optional here only so an older
   * server degrades to "not measured" rather than to a crash.
   */
  feasibility?: CandidateFeasibility;
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
  /**
   * Provenance of this answer's landside leg. There is no longer a leg here at
   * all — census L293c deleted the fabricated 20-minute probe this endpoint
   * used to score — so the value is "unmeasured", and never "measured".
   */
  travelTimeSource: string;
  advice: LeaveAdvice;
  certification: LayoverCertification;
  airportIntelligence: LayoverAirportIntelligence;
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
  /**
   * §12 — the deterministic tools the model actually invoked for THIS answer,
   * in the order they ran. Empty when it answered from the certified record
   * alone, which is the common case and is not a degradation.
   *
   * Optional on the wire because a deployment running an older server does not
   * send it. A surface must render nothing rather than "Checked: " with an
   * empty list, and must never infer "no tools were available" from its
   * absence — absent means UNREPORTED, not none.
   */
  toolsConsulted?: LayoverToolName[];
}

/** §12's twelve, in the order `06_Layover.md` §12 lists them. */
export type LayoverToolName =
  | 'getLayoverContext'
  | 'getConnectionState'
  | 'getTimeWallet'
  | 'getSafeEnvelope'
  | 'getReachableExperiences'
  | 'simulatePlan'
  | 'getReturnContract'
  | 'getAirportState'
  | 'getCrewCandidates'
  | 'requestConstraintClarification'
  | 'replan'
  | 'explainDecision';

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

/**
 * §11.1 as the server published it for one edit.
 *
 * `ran: false` is the COMMON case and is not a failure: most edits move nothing
 * the eleven-type vocabulary can describe, and the server names which. The
 * screen shows the reason rather than inventing "nothing changed", because
 * "nothing changed" is a claim and a refusal is not.
 */
export type ReplanOutcome =
  | { ran: false; reason: string; detail: string }
  | {
      ran: true;
      wiringVersion: string;
      replannerVersion: string;
      event: {
        eventId: string;
        eventType: string;
        occurredAt: string;
        receivedAt: string;
        source: string;
        dedupKey: string;
        confidence: string;
      };
      diff: {
        verdictChanged: boolean;
        returnStateChanged: boolean;
        tierChanged: boolean;
        usableMinutesDelta: number;
        /** Positive = the deadline moved LATER (more freedom). */
        deadlineDeltaMinutes: number;
        candidatesGained: string[];
        candidatesLost: string[];
        /**
         * Stops the recomputation could not judge because a leg or a dwell is
         * unstated (census L47). PUBLISHED AND NOT YET RENDERED — listed here
         * because this file's rule is that a field appears when the server puts
         * it on the wire, and named as unread in census §17.5 rather than
         * scored as reachable.
         */
        candidatesUnmeasured: string[];
        reasonCodesAdded: string[];
        reasonCodesRemoved: string[];
      };
      invalidation: {
        noLongerFeasible: string[];
        staleCertification: string[];
        newInputHash: string;
      };
      opportunity: { why: string[]; reasonCodes: string[] } | null;
      notify: { notify: false; reason: string } | { notify: true; priority: 'high' | 'normal'; reason: string };
      disruptionState: string;
      certification: LayoverCertification;
      reasonCodes: string[];
      snapshotPersisted: false;
      snapshotUnavailableReason: string;
      counts: { impacted: number; replanned: number; skipped: number; notifications: number };
    };

export interface SessionUpdateResult {
  session: LayoverSession;
  replan: ReplanOutcome;
}

/**
 * PATCH the session and read back what the replanner made of the edit.
 *
 * The `replan` half is additive on the server, so an older server answers
 * without it; that is reported as an explicit refusal rather than left
 * undefined, so a caller cannot mistake "this build does not replan" for
 * "nothing changed".
 */
export async function updateLayoverSession(
  sessionId: string,
  updates: Partial<CreateSessionPayload>,
): Promise<SessionUpdateResult> {
  const res = await authedFetch(airportUrl('sessions', sessionId), {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Failed to update layover session: ${res.status}`);
  const json = await res.json();
  const replan: ReplanOutcome = json.replan ?? {
    ran: false,
    reason: 'not_published',
    detail: 'this server did not publish a replan decision',
  };
  return { session: json.session, replan };
}

/**
 * census-layover L294 (C2) — a list, or a stated failure. Never both.
 *
 * `ok: true` with an empty array is a MEASUREMENT: the window was computed and
 * nothing fits. `ok: false` is the absence of a measurement, and `message` is
 * the SERVER's own sentence for it.
 */
export type LayoverRecsResult =
  | { ok: true; recommendations: LayoverRecommendation[] }
  | { ok: false; message: string };

/** What a failure says when the server said nothing at all (offline, unparseable). */
const RECS_UNREACHABLE = 'Layover ideas could not be loaded. Please try again.';

/**
 * THE ROUTE REFUSES RATHER THAN SERVING AN EMPTY LIST, AND THIS PRESERVES THAT.
 *
 * `GET /:id/recommendations` takes two separate branches to avoid fabricating a
 * zero (`artifacts/api-server/src/routes/airport.ts:1012`, `:1019`), under a
 * comment that says why: *"'There is nothing to do on your layover' is a claim
 * about a city, not a description of a failed query."*
 *
 * This function used to answer `if (!res.ok) return []`, which turned that
 * refusal straight back into the claim the route had declined to make — and
 * `LayoverRecsSection` printed "No recommendations yet for this layover." over
 * an outage. It also let an offline `fetch` rejection escape into the caller's
 * `Promise.all`, taking the whole dashboard load down with it.
 */
export async function getRecommendations(sessionId: string): Promise<LayoverRecsResult> {
  let res: Response;
  try {
    res = await authedFetch(airportUrl('sessions', sessionId, 'recommendations'));
  } catch {
    return { ok: false, message: RECS_UNREACHABLE };
  }

  let json: Record<string, unknown> = {};
  try { json = await res.json(); } catch { /* falls through to the status check */ }

  if (!res.ok) {
    // The server's sentence when it wrote one; never a sentence made up here to
    // stand in for it.
    return {
      ok: false,
      message: typeof json.message === 'string' ? json.message : RECS_UNREACHABLE,
    };
  }
  return {
    ok: true,
    recommendations: Array.isArray(json.recommendations)
      ? (json.recommendations as LayoverRecommendation[])
      : [],
  };
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

/**
 * §3 L19 · §17 L162 — how the layover ended, and whether to keep a stamp of it.
 *
 * `outcome` and `passportStamp` are two separate answers and the client must
 * send them separately: "I made my flight" is a fact about the session, and
 * "put this city in my Passport" is a durable artifact the traveller elects.
 * The server refuses the second without the first and says which term failed —
 * `reason` below is the server's word, never re-derived here.
 */
export type LayoverEndOutcome = 'completed' | 'cancelled';

export type LayoverStampReason =
  | 'written'
  | 'already_stamped'
  | 'not_elected'
  | 'not_completed'
  | 'feature_disabled'
  | 'no_city'
  | 'write_failed';

export interface LayoverEndResult {
  ok: boolean;
  outcome: LayoverEndOutcome;
  passportStamp: { requested: boolean; written: boolean; reason: LayoverStampReason } | null;
}

export async function endLayoverSession(
  sessionId: string,
  opts: { outcome?: LayoverEndOutcome; passportStamp?: boolean } = {},
): Promise<LayoverEndResult> {
  const outcome: LayoverEndOutcome = opts.outcome ?? 'cancelled';
  const res = await authedFetch(airportUrl('sessions', sessionId), {
    method: 'DELETE',
    body: JSON.stringify({ outcome, passportStamp: opts.passportStamp === true }),
  });
  if (!res.ok) return { ok: false, outcome, passportStamp: null };
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return {
    ok: true,
    // The SERVER's outcome, not the requested one: an older server that ignores
    // the field must not have its answer overwritten by this client's hope.
    outcome: body?.outcome === 'completed' ? 'completed' : 'cancelled',
    passportStamp: body?.passportStamp ?? null,
  };
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

/**
 * census-layover L156 — WHY the overview is missing, because the server says.
 *
 * `gone`         404 `not_found` — deleted, or never this traveller's.
 *                A retry cannot change it, so nothing offers one.
 * `unavailable`  503 `degraded_unavailable` — a read failed server-side. The
 *                server marks these `retryable: true`; the session is fine.
 * `unreachable`  `fetch` rejected. The device could not reach the server at
 *                all, so there is no server sentence to quote and this is the
 *                one case whose message is written on the client.
 * `refused`      any other non-2xx, or a 2xx whose envelope says `ok: false`.
 */
export type LayoverOverviewFailure = 'gone' | 'unavailable' | 'unreachable' | 'refused';

export type LayoverOverviewRead =
  | { ok: true; overview: LayoverOverview }
  | { ok: false; reason: LayoverOverviewFailure; message: string; retryable: boolean };

/** The only sentence in this module not written by the server — see `unreachable`. */
const OVERVIEW_UNREACHABLE = "We couldn't reach Portava. Check your connection and try again.";

/**
 * THE SERVER ALREADY DECIDED WHICH FAILURE THIS IS.
 *
 * `ownedSessionOr` (`artifacts/api-server/src/routes/airport.ts:1869`) splits a
 * missing session from a failed read and gives each its own status, code and
 * sentence. This function used to answer `null` to both — and to THROW when
 * `fetch` rejected, which its one caller ran inside an uncaught `Promise.all`,
 * so an offline device got a permanent spinner rather than any message at all.
 *
 * It now resolves in every case and names which one, so the dashboard can stop
 * guessing "It may have been removed, or you're offline."
 */
export async function getLayoverOverview(sessionId: string): Promise<LayoverOverviewRead> {
  let res: Response;
  try {
    res = await authedFetch(airportUrl('sessions', sessionId, 'overview'));
  } catch {
    return { ok: false, reason: 'unreachable', message: OVERVIEW_UNREACHABLE, retryable: true };
  }

  let json: Record<string, any> = {};
  try { json = await res.json(); } catch { /* falls through to the status check */ }

  if (!res.ok) {
    // `retryable` is the server's own flag (`isRetryableErrorCode`,
    // `artifacts/api-server/src/lib/http.ts:130`), not a status-code rule
    // re-invented here — the list of retryable codes is the server's to keep.
    const message = typeof json.message === 'string' ? json.message : OVERVIEW_UNREACHABLE;
    if (res.status === 404 || json.error === 'not_found') {
      return { ok: false, reason: 'gone', message, retryable: json.retryable === true };
    }
    if (json.error === 'degraded_unavailable') {
      return { ok: false, reason: 'unavailable', message, retryable: json.retryable === true };
    }
    return { ok: false, reason: 'refused', message, retryable: json.retryable === true };
  }
  if (!json.ok) {
    return {
      ok: false,
      reason: 'refused',
      message: typeof json.message === 'string' ? json.message : OVERVIEW_UNREACHABLE,
      retryable: false,
    };
  }
  // The cast below is the only thing standing between this type and the wire.
  // A screen that renders a field ONLY when it is present looks perfectly fine
  // against a server that never sends it, so the absence is made loud here
  // rather than left to show up as a missing badge nobody notices.
  for (const field of ['certification', 'safeReturn', 'offlineBundle'] as const) {
    if (json[field] == null) {
      console.warn(`[layover] overview is missing "${field}" — server contract mismatch`);
    }
  }
  // `safeEnvelope` is checked for ABSENCE and not for null, and the difference
  // is a real distinction on the wire: the server sends `null` on purpose for an
  // airport with no usable coordinate (see LayoverSafeEnvelope), and warning on
  // that would train the warning to be ignored. `undefined` is the contract
  // mismatch — a server that does not publish the field at all.
  if (!('safeEnvelope' in json)) {
    console.warn('[layover] overview is missing "safeEnvelope" — server contract mismatch');
  }
  return { ok: true, overview: json as LayoverOverview };
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

/** The §14 rung the server actually served. Its vocabulary, not ours. */
export type PresenceLevel = 'L0_AGGREGATE' | 'L2_DISCOVERY';

/**
 * census-layover L127 / L128 / L294 — the whole presence answer.
 *
 * `GET /:id/presence` returns `disclosePresence`'s result
 * (`artifacts/api-server/src/services/airport/LayoverPrivacyGuard.ts:468`),
 * and four of its fields never had a name on this side of the wire. They were
 * on every response body; `res.json()` carried them; the type stopped at
 * `count` and `travelers`, so no caller could see them and the screen threw
 * them away. Naming them is the whole change — nothing new is fetched.
 *
 * `level` and `withheld` are OPTIONAL because an older server that predates
 * the privacy guard does not publish them; `degraded` is not, because a
 * caller that cannot see it will state a count it has no right to state.
 * `getLayoverPresence` therefore normalises it rather than leaving it absent.
 */
export interface LayoverPresenceAnswer {
  sharing: boolean;
  city?: string | null;
  count: number;
  travelers: PresenceTraveler[];
  level?: PresenceLevel;
  /**
   * `sharing_paused` | `location_mode_off` | `ghost_mode` — the traveller's own
   * stored settings — or `preferences_unreadable` | `ghost_mode_unreadable`,
   * the closed fallbacks that stood in for them. The latter always arrive with
   * `degraded: true`; see `LayoverPeopleSection` for why that ordering matters.
   */
  withheld?: string[];
  /** TRUE when the count is NOT a measurement. Never widen a claim past this. */
  degraded: boolean;
  degradedReasons: string[];
}

/**
 * Returns `null` on ANY failure to obtain an answer — a non-2xx, a body that
 * will not parse, or a `fetch` that rejected because the device is offline.
 *
 * The caller must render `null` as "we could not check", NOT as "nobody is
 * here". The server refuses rather than serving a fabricated zero precisely so
 * the two stay distinguishable (`cityPresence`: *"a refusal caused by an
 * UNREADABLE TABLE is now distinguishable from a measured zero"*); collapsing
 * them here would undo that on the client instead.
 *
 * The `try` is not decoration. `authedFetch` rejects when the device has no
 * network, and this function's one caller floats its promise — so before this,
 * going offline produced an unhandled rejection and the presence box kept
 * whatever it was last showing.
 */
export async function getLayoverPresence(sessionId: string): Promise<LayoverPresenceAnswer | null> {
  let res: Response;
  try {
    res = await authedFetch(airportUrl('sessions', sessionId, 'presence'));
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: Record<string, unknown>;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  return {
    sharing: json.sharing === true,
    city: (json.city as string | null | undefined) ?? null,
    count: typeof json.count === 'number' ? json.count : 0,
    travelers: Array.isArray(json.travelers) ? (json.travelers as PresenceTraveler[]) : [],
    level: json.level as PresenceLevel | undefined,
    withheld: Array.isArray(json.withheld) ? (json.withheld as string[]) : [],
    // A server that does not publish `degraded` answered without falling back,
    // which is what `false` means. The normalisation is here so that no screen
    // has to decide what an absent confidence flag means.
    degraded: json.degraded === true,
    degradedReasons: Array.isArray(json.degradedReasons) ? (json.degradedReasons as string[]) : [],
  };
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

/**
 * census-layover L271 — `posted` is the field the caller actually needs.
 *
 * The route used to return `ok: true` and a `threadId` whether or not the
 * message reached that thread, and this screen navigated on `threadId` alone.
 * A traveller was therefore pushed into a chat their text was not in, and told
 * nothing. `posted` says whether the message is in the thread; `postFailure`
 * names why not (`e2ee` | `unverifiable` | `no_thread` | `insert_failed`) so
 * the caller can say something true rather than something reassuring.
 */
export async function sendLayoverTelegraph(sessionId: string, message: string): Promise<{
  intent: string;
  city: string | null;
  threadId: string | null;
  posted: boolean;
  postFailure: string | null;
} | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'telegraph'), {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
  if (!res.ok) return null;
  return res.json();
}

// ── §10 traveller observations (census L82) ───────────────────────────────────

/**
 * The three facts a traveller may report. Exactly the `TRAVELER_OBSERVATION`
 * class of `AIRPORT_FACT_TYPES` — §10's own row reads "checkpoint timing, queue
 * report, closure".
 *
 * The server publishes this list on every GET (`submittableFactTypes`) and
 * validates against its own copy, so this type is a convenience for rendering
 * and NEVER the authority. A client that guessed a fourth type would be refused
 * by name.
 */
export type TravellerFactType =
  | 'checkpoint_timing_minutes'
  | 'queue_report_minutes'
  | 'closure_reported';

export type EstimateSourceClass = 'STATIC' | 'HISTORICAL' | 'LIVE' | 'USER_DECLARED';
export type EstimateFallbackLevel = 'NONE' | 'REGIONAL' | 'GLOBAL';

/**
 * §10 `TruthValue<T>`, transcribed from
 * `artifacts/api-server/src/services/airport/LayoverAirportTruth.ts`.
 *
 * `conflict` is not decoration: when it is true the server took the
 * CONSERVATIVE reading rather than an average, dropped the confidence, and kept
 * BOTH sides in `sourceRefs`. A surface that renders the value and hides the
 * flag is averaging the disagreement away on the server's behalf.
 */
export interface AirportTruthValue {
  value: number;
  confidence: EstimateConfidence;
  conflict: boolean;
  sourceClass: EstimateSourceClass;
  sourceRefs: string[];
  observedAt: string | null;
  expiresAt: string | null;
  fallbackLevel: EstimateFallbackLevel;
}

export interface AirportObservedFact {
  factType: TravellerFactType;
  factClass: string;
  truthVersion: string;
  /**
   * NULL IS AN ANSWER, not a loading state and not a zero. It means either that
   * nothing unexpired has been reported, or that what has been reported sits
   * below the corroboration floor — one stranger cannot move a deadline. The
   * screen must render it as "no reading", never as 0 minutes.
   */
  truth: AirportTruthValue | null;
  corroboration: Record<string, number>;
  conflictBetween: { low: number; high: number } | null;
  rulesApplied: string[];
}

export interface AirportObservationsResult {
  airportRef: string;
  submittableFactTypes: TravellerFactType[];
  rateLimit: { maxPerWindow: number; windowMinutes: number };
  facts: AirportObservedFact[];
}

/**
 * The reconciled traveller reports for this session's airport.
 *
 * Returns `null` on ANY non-ok response, and the caller must render that as
 * "could not load" rather than as "nothing reported". The server refuses with
 * `degraded_unavailable` when the corpus read fails precisely so that an outage
 * is distinguishable from an empty airport; collapsing the two here would throw
 * that away on the client side instead.
 */
export async function getAirportObservations(
  sessionId: string,
): Promise<AirportObservationsResult | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'observations'));
  if (!res.ok) return null;
  return res.json();
}

export type ObservationSubmitOutcome =
  | { ok: true; duplicate: boolean; fact: AirportObservedFact }
  /** Screened out, rate-limited or refused. `message` is the server's sentence. */
  | { ok: false; message: string; rateLimited: boolean };

/**
 * Report a queue, a checkpoint timing or a closure.
 *
 * `submissionToken` is the caller's idempotency key (migration 2982) and is
 * REQUIRED. It must be stable across retries of the SAME report and different
 * for a genuinely new one — a token minted inside this function would be fresh
 * on every retry and would dedupe nothing, which is why it is a parameter.
 *
 * Failure carries the server's own sentence rather than a code. The route
 * writes one per screening verdict (implausible value, rate limited, …) because
 * a rejection here is the traveller's answer, not a server fault.
 */
export async function submitAirportObservation(
  sessionId: string,
  input: { factType: TravellerFactType; value: number; submissionToken: string },
): Promise<ObservationSubmitOutcome> {
  let res: Response;
  try {
    res = await authedFetch(airportUrl('sessions', sessionId, 'observations'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, message: 'Your report could not be sent. Please try again.', rateLimited: false };
  }

  let body: Record<string, unknown> = {};
  try { body = await res.json(); } catch { /* falls through to the status check */ }

  if (!res.ok) {
    const message = typeof body.message === 'string'
      ? body.message
      : 'That report could not be accepted.';
    return { ok: false, message, rateLimited: res.status === 429 };
  }
  return {
    ok: true,
    duplicate: body.duplicate === true,
    fact: body.fact as AirportObservedFact,
  };
}

// ── §14 Layover Crew (census L28/L29/L131/L185/L186/L188) ─────────────────────

export interface CrewSummary {
  id: string;
  title: string;
  city: string;
  meetingPointLabel: string | null;
  status: 'open' | 'closed' | 'disbanded';
  maxMembers: number;
  expiresAt: string;
  youAreOwner: boolean;
  /**
   * From the MEMBERSHIP rows, not from `members` below. The two differ whenever
   * a crewmate has blocked you, paused sharing or gone into ghost mode: they
   * are still in the crew and still bind the shared deadline, they just have no
   * card. Rendering `members.length` as the size of the crew would quietly
   * un-count them.
   */
  memberCount: number;
}

/** One member's certified constraint, as §14.1 folds it into the minimum. */
export interface CrewMemberConstraint {
  userId: string;
  /** ISO. Null = this member's feasibility could not be certified. */
  requiredReturnBy: string | null;
  usableMinutes: number | null;
  returnState: LayoverReturnState | null;
}

export type CrewInfeasibilityReason =
  | 'no_members'
  | 'member_without_certified_feasibility'
  | 'member_unassigned'
  | 'member_assigned_twice'
  | 'unknown_member_in_branch'
  | 'empty_branch'
  | 'plan_exceeds_usable_minutes'
  | 'plan_ends_after_shared_return';

/**
 * §14.1, server-certified. Transcribed from `certifyCrewPlan` in
 * `artifacts/api-server/src/services/airport/LayoverCrewService.ts`.
 *
 * `sharedReturnBy` is `min(member.required_return_by)` over the WHOLE crew and
 * is NULL whenever any member is uncertified — not because the server is being
 * fussy, but because a minimum over the subset it could read is a LATER
 * deadline than the truth. The client must render null as "not certified", and
 * must never substitute its own earliest time: that is the duplicate
 * time-budget derivation L2/L6 exist to forbid.
 */
export interface CrewSolution {
  crewVersion: string;
  sharedReturnBy: string | null;
  bindingMemberIds: string[];
  feasible: boolean;
  reasons: CrewInfeasibilityReason[];
  split: boolean;
  members: CrewMemberConstraint[];
}

export interface CrewMemberCard {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface CrewOpening {
  id: string;
  title: string;
  meetingPointLabel: string | null;
  maxMembers: number;
  expiresAt: string;
}

export type CrewState =
  | {
      inCrew: true;
      crew: CrewSummary;
      solution: CrewSolution;
      members: CrewMemberCard[];
      degraded: boolean;
      degradedReasons: string[];
    }
  | { inCrew: false; city: string | null; crews: CrewOpening[]; reason?: string };

/**
 * The crew for this layover, or the open crews in this city.
 *
 * `null` is a FAILED READ and the caller must render it as one. "You are in no
 * crew" and "we could not read your crew" produce the same screen if they are
 * collapsed, and a traveller who believes the first walks away from people who
 * are waiting for them.
 */
export async function getLayoverCrew(sessionId: string): Promise<CrewState | null> {
  const res = await authedFetch(airportUrl('sessions', sessionId, 'crew'));
  if (!res.ok) return null;
  return res.json();
}

export type CrewActionOutcome =
  | { ok: true; state: CrewState }
  | { ok: false; message: string };

async function crewAction(url: string, body?: unknown): Promise<CrewActionOutcome> {
  let res: Response;
  try {
    res = await authedFetch(url, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch {
    return { ok: false, message: 'That could not be sent. Please try again.' };
  }
  let parsed: Record<string, unknown> = {};
  try { parsed = await res.json(); } catch { /* falls through to the status check */ }
  if (!res.ok) {
    return {
      ok: false,
      message: typeof parsed.message === 'string' ? parsed.message : 'That did not work. Please try again.',
    };
  }
  return { ok: true, state: parsed as unknown as CrewState };
}

export function createLayoverCrew(
  sessionId: string,
  input: { title: string; meetingPointLabel?: string | null; maxMembers?: number },
): Promise<CrewActionOutcome> {
  return crewAction(airportUrl('sessions', sessionId, 'crew'), input);
}

export function joinLayoverCrew(sessionId: string, crewId: string): Promise<CrewActionOutcome> {
  return crewAction(airportUrl('sessions', sessionId, 'crew', crewId, 'join'));
}

export function leaveLayoverCrew(sessionId: string): Promise<CrewActionOutcome> {
  return crewAction(airportUrl('sessions', sessionId, 'crew', 'leave'));
}

// ── §25.2 / census L269 — Layover Discovery ───────────────────────────────────

/**
 * One gem, narrowed to what the layover surface actually renders.
 *
 * NOT `HiddenGem` from `services/hiddenGems.ts`. That type carries thirty-odd
 * fields — verification level, save counts, submitter, gem state, confidence —
 * none of which this surface shows, and importing it would make a layover card
 * a consumer of the whole Hidden Gems contract for four strings. It is a
 * SEPARATE READ of the same wire, not a second vocabulary: every field below is
 * named for the column the route serialises.
 */
export interface LayoverDiscoveryGem {
  id: string;
  name: string;
  neighborhood: string | null;
  /**
   * The gem's OWN floor, as the server published it (`minimum_layover_minutes`).
   * Null when the row carries none — which is not zero, and is not "fits".
   */
  minimumLayoverMinutes: number | null;
}

/**
 * census L269 — why there is, or is not, a Discovery answer.
 *
 * `gated_off` IS NOT A FAILURE AND IS NOT AN EMPTY LIST. It is the third thing,
 * and the reason it needs its own member is that `feature_disabled` answers
 * **404 — the same status as `not_found`** (`lib/http.ts` STATUS). A reader
 * keyed on the status code cannot tell "this capability is switched off" from
 * "the read failed", and the two must render differently: off shows NO CARD,
 * failed shows the server's refusal.
 *
 * It carries no message on purpose. `sendError(res, "feature_disabled")` is
 * called with no sentence, so the envelope's `message` is the literal string
 * `"feature_disabled"` — a code, not traveller-facing copy. There is nothing
 * honest to quote, and nothing needs quoting, because the surface renders
 * nothing.
 */
export type LayoverDiscoveryRead =
  | { ok: true; gems: LayoverDiscoveryGem[] }
  | { ok: false; reason: 'gated_off' }
  | {
      ok: false;
      reason: 'unavailable' | 'unreachable' | 'refused';
      message: string;
      retryable: boolean;
    };

/** The only sentence here not written by the server — the device reached nobody. */
const DISCOVERY_UNREACHABLE = "We couldn't reach Portava. Check your connection and try again.";

function toDiscoveryGem(row: Record<string, unknown>): LayoverDiscoveryGem | null {
  const id = typeof row.id === 'string' ? row.id : null;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  // A row with no id cannot be keyed and a row with no name cannot be read.
  // Dropping it is right; rendering a blank chip would not be.
  if (!id || !name) return null;
  const minimum = row.minimum_layover_minutes ?? row.minimumLayoverMinutes;
  const neighborhood = row.neighborhood;
  return {
    id,
    name,
    neighborhood: typeof neighborhood === 'string' && neighborhood.trim() ? neighborhood : null,
    minimumLayoverMinutes: typeof minimum === 'number' && Number.isFinite(minimum) ? minimum : null,
  };
}

/**
 * §25.2 Layover Discovery — the gems this layover's CERTIFIED window permits.
 *
 * ── `availableMinutes` IS NOT DERIVED HERE ───────────────────────────────────
 * It is the server's own `window.usableMinutes`, handed down from the overview.
 * Nothing on this path subtracts a deadline from a clock: the route filters on
 * `minLayoverMinutes` itself, and a second arithmetic on this side would be a
 * second feasibility answer about the same layover — which is what
 * `LayoverReturnPanel.tsx` was deleted at `a718beb5` for.
 *
 * ── WHAT THE DISCOVERY-MODE FLAG DOES AND DOES NOT CHANGE HERE ───────────────
 * `layover_discovery_mode_enabled` (migration 2971) narrows what the SERVER
 * serves — a Discovery serve in an airport session is restricted to the
 * certified action universe rather than to distance alone. It is not on this
 * response's envelope and this reader does not look for it: the flag changes
 * WHICH gems arrive, never the shape, so this consumer is correct in both flag
 * states by construction and needs no change when the gate moves. The two
 * flags this reader CAN observe are `hidden_gems_enabled` and
 * `hidden_gems_layover_enabled`, and both surface as `feature_disabled`.
 *
 * Resolves in every case; it never throws, because its one caller renders the
 * refusal and a rejected promise would render nothing at all.
 */
export async function getLayoverDiscovery(
  availableMinutes: number,
  city: string | null,
): Promise<LayoverDiscoveryRead> {
  const params = new URLSearchParams({ availableMinutes: String(availableMinutes) });
  if (city) params.set('city', city);

  let res: Response;
  try {
    res = await authedFetch(`${apiBase()}/api/hidden-gems/layover-safe?${params.toString()}`);
  } catch {
    return { ok: false, reason: 'unreachable', message: DISCOVERY_UNREACHABLE, retryable: true };
  }

  let json: Record<string, any> = {};
  try { json = await res.json(); } catch { /* falls through to the status check */ }

  if (!res.ok) {
    // THE CODE, NOT THE STATUS — see `LayoverDiscoveryRead`.
    if (json.error === 'feature_disabled') return { ok: false, reason: 'gated_off' };
    // `retryable` is the server's own flag (`isRetryableErrorCode`), read off
    // the response rather than re-derived from a status-code rule here.
    const message = typeof json.message === 'string' ? json.message : DISCOVERY_UNREACHABLE;
    const retryable = json.retryable === true;
    if (json.error === 'db_error' || json.error === 'server_not_configured') {
      return { ok: false, reason: 'unavailable', message, retryable };
    }
    return { ok: false, reason: 'refused', message, retryable };
  }

  // A 200 whose body has no `gems` ARRAY is not an empty list. The route always
  // sends one on success, so its absence is a contract mismatch, and answering
  // `[]` to it would be the failed-read-as-empty-result this whole type exists
  // to prevent.
  if (!Array.isArray(json.gems)) {
    return {
      ok: false,
      reason: 'refused',
      message: DISCOVERY_UNREACHABLE,
      retryable: false,
    };
  }

  const gems: LayoverDiscoveryGem[] = [];
  for (const row of json.gems as unknown[]) {
    if (row && typeof row === 'object') {
      const gem = toDiscoveryGem(row as Record<string, unknown>);
      if (gem) gems.push(gem);
    }
  }
  return { ok: true, gems };
}
