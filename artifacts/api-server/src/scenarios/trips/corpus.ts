/**
 * Trips spec §23.1 "scenario/replay tests cover cross-domain lifecycle
 * behaviour" and §24's decision-diff CI — "planner/coordination changes run
 * against historical or synthetic Trip scenarios, reporting changed
 * decisions, increased/decreased conservatism, new conflicts, unexplained
 * large diffs" (census-trips TR409, TR410, TR433).
 *
 * This is the CORPUS: synthetic scenarios, each a typed set of inputs for the
 * pure engines — freedom, health, pulse, the four triggers, urgency, impact
 * preview, simulate, replan, the experience compiler, the opportunity diff,
 * the meeting point, rescue, attention. `run.ts` turns one scenario into a
 * canonical decision record; `golden.json` is the record the tree last agreed
 * to; `diff.ts` compares and classifies; `src/scripts/checkTripDecisionDiff.ts`
 * is the CI gate and the only writer of golden.json.
 *
 * Every input is fixed — instants, points, ids, a straight-line travel
 * estimator — so two runs of the same tree produce byte-identical records.
 * Six of the eight scenarios are §23's own list; the other two exist to put a
 * conflict and a safety event in front of every engine that has a rule for
 * one. There is nothing "historical" here: no production data leaves
 * production, so the corpus is synthetic by construction and says so.
 */
import type { EngineCommitment, FreedomInputs, HopTravel } from "../../services/trips/TripFreedomEngine.js";
import type { HealthInputs } from "../../services/trips/TripHealth.js";
import type { AttentionState, PulseContext, TripSignal } from "../../services/trips/TripSignals.js";
import type { RiskTriggerInputs } from "../../services/trips/TripRiskTriggers.js";
import type { UrgencyInputs } from "../../services/trips/TripDecisionUrgency.js";
import type { ImpactState, ProposedChange, StatePlan } from "../../services/trips/TripImpactPreview.js";
import type { ReplanConstraints } from "../../services/trips/TripReplan.js";
import type {
  CompileGoal, CompileInputs, CompileNextCommitment, CompileParticipant, ExperienceCandidate, GeoPoint, TravelEstimator,
} from "../../services/trips/TripExperienceCompiler.js";
import type { MeetingPointInputs } from "../../services/trips/TripMeetingPoint.js";
import type { RescueContext, RescueProblem } from "../../services/trips/TripRescue.js";
import type { AttentionContext, AttentionEvent } from "../../services/trips/TripAttentionPolicy.js";

// ── the fixed world ──────────────────────────────────────────────────────────

export const SCENARIO_DAY = "2026-09-13";
export const T = (hhmm: string, day = "13"): string => `2026-09-${day}T${hhmm}:00.000Z`;
export const NOW = Date.parse(T("12:00"));
export const HOTEL: GeoPoint = { lat: 48.8566, lng: 2.3522 };
export const NEAR: GeoPoint = { lat: 48.86, lng: 2.36 };
export const MID: GeoPoint = { lat: 48.8583, lng: 2.3561 };
export const FAR: GeoPoint = { lat: 48.88, lng: 2.39 };
const TRIP_START = new Date(T("00:00", "12"));
const TRIP_END = new Date(T("23:59", "15"));

/** Straight line: walking under 2 km, a taxi beyond — fixed, so the corpus is deterministic. */
export function straightLineMinutes(a: GeoPoint, b: GeoPoint): { minutes: number; mode: string } | null {
  const d = Math.hypot((b.lat - a.lat) * 111_000, (b.lng - a.lng) * 73_000);
  return d <= 2000 ? { minutes: Math.ceil(d / 75), mode: "walk" } : { minutes: Math.ceil(d / 400) + 5, mode: "taxi" };
}
export const travel: TravelEstimator = { minutes: straightLineMinutes };

// ── the scenario contract ────────────────────────────────────────────────────

export interface ScenarioCompile {
  windowPosition: "before_first" | "between" | "after_last";
  origin: GeoPoint | null;
  participants: CompileParticipant[];
  candidates: ExperienceCandidate[];
  goals: CompileGoal[];
  preferences: CompileInputs["preferences"];
  nextCommitment: CompileNextCommitment | null;
  prepMinutes?: number;
  /** Pulse effects name PLANS; the compiler judges CANDIDATES. Plan id → candidate id, applied to every effect's subjectIds for the "after" compile. */
  signalSubjectMap?: Record<string, string>;
  /** §12.3: ask value-of-information over the compiled experiences. */
  questions?: boolean;
}

export interface TripScenario {
  id: string;
  title: string;
  /** The spec sections this scenario exercises. */
  spec: string[];
  now: number;
  day: string;
  freedom: FreedomInputs | null;
  /** `conflicts` here are ADDED to the freedom engine's and the plan overlaps; the run merges them. */
  health: HealthInputs;
  pulse: { signals: TripSignal[]; ctx: PulseContext } | null;
  triggers: Omit<RiskTriggerInputs, "signals" | "now"> | null;
  urgency: { id: string; inputs: UrgencyInputs }[];
  impact: { state: ImpactState; changes: ProposedChange[] } | null;
  replan: { actorUserId: string; constraints?: ReplanConstraints } | null;
  compile: ScenarioCompile | null;
  meeting: MeetingPointInputs | null;
  rescue: { problem: RescueProblem; ctx: RescueContext }[];
  attention: { label: string; event: AttentionEvent; ctx: AttentionContext }[];
}

// ── builders ─────────────────────────────────────────────────────────────────

const hop = (travelMinutes: number | null): HopTravel => ({
  travelMinutes,
  confidence: (travelMinutes === null ? "LOW" : "HIGH") as HopTravel["confidence"],
  routed: false,
  unknownReason: travelMinutes === null ? "no provider in the corpus" : null,
});
const commitment = (id: string, type: string, at: string, point: GeoPoint, o: Partial<EngineCommitment> = {}): EngineCommitment => ({
  id, type, startsAt: new Date(at), requiredArrivalAt: new Date(at), endsAt: null,
  place: { placeId: id, point }, flexibility: "fixed", prepMinutes: 0, latenessToleranceMinutes: 0, ...o,
});
const plan = (id: string, title: string, startsAt: string, endsAt: string, o: Partial<StatePlan> = {}): StatePlan => ({
  id, title, status: "confirmed", startsAt, endsAt, dayDate: SCENARIO_DAY, participantIds: ["me"], planScope: "SOLO", confirmed: true, ...o,
});
const signal = (kind: TripSignal["kind"], subjectId: string, value: unknown, confidence = 0.7): TripSignal => ({
  kind, subjectId,
  estimate: {
    value, confidence, sourceClass: "imported_owned", observedAt: T("11:00"), expiresAt: T("17:00"),
    fallbackUsed: false, contradictorySources: [], support: { agreeing: 1, total: 1 },
  },
} as TripSignal);
const pulseCtx = (o: Partial<PulseContext>): PulseContext => ({
  now: NOW,
  stage: { id: "st1", startsAt: T("00:00", "12"), endsAt: T("23:59", "15"), anchor: HOTEL },
  locationBand: { centre: HOTEL, radiusM: 3000 },
  goals: [], savedIdeas: [], commitments: [], plans: [], transport: [],
  crew: { viewerId: "me", memberIds: ["me", "ana"] }, attention: "NORMAL", ...o,
});
const attentionCtx = (mode: AttentionState = "NORMAL", o: Partial<AttentionContext> = {}): AttentionContext => ({
  now: NOW, mode, recentNotifyCount: 0, quietHours: false, ...o,
});
const HEALTHY: HealthInputs = { conflicts: [], risks: [], disruptions: [], needsHelpMemberIds: [], hops: { infeasible: 0, unknown: 0 } };
const hours = (open: string, close: string) => [{ opensAt: T(open), closesAt: T(close) }];

// ── the eight ────────────────────────────────────────────────────────────────

/** §23 "Solo 3-day city trip — lifecycle, Today, free windows, saved-to-plan conversion." Nothing is wrong; every engine should say so. */
function soloCityDay(): TripScenario {
  const cafe = plan("cafe", "Coffee at Le Petit", T("15:00"), T("16:00"), { status: "planned", confirmed: false });
  const state: ImpactState = {
    plans: [cafe], reservations: [], transport: [],
    commitments: [
      { id: "A", type: "check_in", startsAt: T("11:00"), requiredArrivalAt: T("11:00"), flexibility: "fixed", participantIds: ["me"] },
      { id: "B", type: "dinner", startsAt: T("20:00"), requiredArrivalAt: T("20:00"), flexibility: "fixed", participantIds: ["me"] },
    ],
    safeReturnActiveFor: [], crewIds: ["me"],
  };
  return {
    id: "solo_city_day", title: "Solo city trip — one free afternoon, nothing wrong", spec: ["§23 solo city trip", "§7.3", "§11.1", "§13.1", "§16.2"],
    now: NOW, day: SCENARIO_DAY,
    freedom: {
      commitments: [commitment("A", "check_in", T("11:00"), HOTEL), commitment("B", "dinner", T("20:00"), HOTEL, { prepMinutes: 15 })],
      hops: [hop(0)], participants: ["me"], tripStart: TRIP_START, tripEnd: TRIP_END,
    },
    health: HEALTHY,
    pulse: {
      signals: [signal("crowd_rising", "bar", { placeId: "bar", level: "high", trajectory: "rising" })],
      ctx: pulseCtx({
        savedIdeas: [{ id: "bar", placeId: "bar", placeType: "bar", name: "Le Bar", point: NEAR }],
        plans: [{ id: "cafe", title: cafe.title, category: "food", startsAt: cafe.startsAt, endsAt: cafe.endsAt, weatherSensitive: false, point: NEAR }],
        crew: { viewerId: "me", memberIds: ["me"] },
      }),
    },
    triggers: {
      commitments: [{ id: "A", type: "check_in", startsAt: T("11:00"), requiredArrivalAt: T("11:00") }, { id: "B", type: "dinner", startsAt: T("20:00"), requiredArrivalAt: T("20:00") }],
      plans: [{ id: "cafe", title: cafe.title, startsAt: cafe.startsAt, endsAt: cafe.endsAt, weatherSensitive: false, partySize: 1 }],
      transport: [], crewSize: 1,
    },
    urgency: [{ id: "book-museum", inputs: { deadlineAt: T("12:00", "18"), downstream: { dependentCommitments: 0, dependentPlans: 1, totalCommitments: 2, totalPlans: 2 }, consequence: "minor" } }],
    impact: { state, changes: [{ kind: "move_plan", targetId: "cafe", startsAt: T("16:00"), endsAt: T("17:00") }] },
    replan: { actorUserId: "me" },
    compile: {
      windowPosition: "between", origin: HOTEL, participants: [{ userId: "me" }],
      candidates: [
        { id: "cafe", placeId: null, name: "Le Petit Café", placeType: "cafe", point: NEAR, openingWindows: hours("08:00", "22:00"), source: "saved_idea" },
        { id: "park", placeId: null, name: "Jardin stroll", placeType: "park", point: MID, source: "saved_idea" },
      ],
      goals: [{ id: "g1", type: "relax", scope: "personal", status: "open" }], preferences: { energy: "low" },
      nextCommitment: { id: "B", arriveBy: T("20:00"), point: HOTEL }, prepMinutes: 15,
    },
    meeting: null, rescue: [],
    attention: [{ label: "an opportunity on a normal day", event: { kind: "opportunity_added", significance: "medium", affectsViewer: true, actionable: true }, ctx: attentionCtx() }],
  };
}

/** §23 "Flight delay on arrival — dependency propagation; downstream proposal/replan." */
function flightDelayOnArrival(): TripScenario {
  const state: ImpactState = {
    plans: [
      plan("museum", "Louvre", T("16:00"), T("18:00"), { participantIds: ["me", "ana"], planScope: "ALL_CREW" }),
      plan("nap", "Rest at the hotel", T("14:30"), T("15:30"), { status: "planned", confirmed: false }),
    ],
    reservations: [], transport: [],
    commitments: [
      { id: "flight", type: "flight", startsAt: T("13:00"), requiredArrivalAt: T("13:00"), flexibility: "fixed", participantIds: ["me", "ana"] },
      { id: "dinner", type: "dinner", startsAt: T("20:00"), requiredArrivalAt: T("20:00"), flexibility: "flexible", participantIds: ["me", "ana"] },
    ],
    safeReturnActiveFor: [], crewIds: ["me", "ana"],
  };
  return {
    id: "flight_delay_on_arrival", title: "Flight delay on arrival — dependency propagation, downstream proposal / replan", spec: ["§23 flight delay", "§8.4", "§11.3", "§9.4", "§11.4"],
    now: NOW, day: SCENARIO_DAY, freedom: null, health: HEALTHY, pulse: null,
    triggers: {
      crewSize: 2, transport: [],
      commitments: [
        { id: "flight", type: "flight", startsAt: T("13:00"), requiredArrivalAt: T("13:00"), estimatedArrivalAt: T("14:15"), participantIds: ["me", "ana"] },
        { id: "dinner", type: "dinner", startsAt: T("20:00"), requiredArrivalAt: T("20:00") },
      ],
      plans: state.plans.map((p) => ({ id: p.id, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, weatherSensitive: false, partySize: null })),
    },
    urgency: [{ id: "rebook-transfer", inputs: { deadlineAt: T("13:30"), downstream: { dependentCommitments: 1, dependentPlans: 2, totalCommitments: 2, totalPlans: 2 }, consequence: "severe" } }],
    impact: { state, changes: [{ kind: "move_plan", targetId: "museum", startsAt: T("17:15"), endsAt: T("19:15") }] },
    replan: { actorUserId: "me" },
    compile: null, meeting: null, rescue: [],
    attention: [{ label: "the arrival is at risk, an hour out", event: { kind: "commitment_at_risk", significance: "high", affectsViewer: true, actionable: true, deadlineAt: T("13:00") }, ctx: attentionCtx() }],
  };
}

/** §23 "Rain invalidates tour — risk trigger, fallback opportunity, booking side-effect explanation." */
function rainInvalidatesTour(): TripScenario {
  const state: ImpactState = {
    plans: [plan("walk", "Walking tour of Montmartre", T("15:00"), T("17:00"), { participantIds: ["me", "ana"], planScope: "ALL_CREW" })],
    reservations: [{ id: "tour-res", title: "Walking tour of Montmartre", type: "activity", status: "confirmed", startsAt: T("15:00"), endsAt: T("17:00"), cancellationDeadlineAt: T("13:00"), costMinor: 4000, currency: "EUR", planId: "walk", participantIds: ["me", "ana"] }],
    transport: [],
    commitments: [{ id: "B", type: "dinner", startsAt: T("20:00"), requiredArrivalAt: T("20:00"), flexibility: "fixed", participantIds: ["me", "ana"] }],
    safeReturnActiveFor: [], crewIds: ["me", "ana"],
  };
  return {
    id: "rain_invalidates_tour", title: "Rain invalidates the booked tour — trigger, fallback opportunity, booking side effects", spec: ["§23 rain", "§16.2", "§8.4", "§13.3", "§15.3", "§11.3"],
    now: NOW, day: SCENARIO_DAY,
    freedom: {
      commitments: [commitment("A", "check_in", T("11:00"), HOTEL), commitment("B", "dinner", T("20:00"), HOTEL, { prepMinutes: 15 })],
      hops: [hop(0)], participants: ["me", "ana"], tripStart: TRIP_START, tripEnd: TRIP_END,
    },
    health: HEALTHY,
    pulse: {
      signals: [signal("rain_arriving", SCENARIO_DAY, { date: SCENARIO_DAY, precipMm: 9, weatherCode: 63 })],
      ctx: pulseCtx({
        locationBand: null,
        savedIdeas: [{ id: "museum", placeId: null, placeType: "museum", name: "Musée d'Orsay", point: NEAR }, { id: "tour", placeId: null, placeType: "walking tour", name: "Walking tour", point: NEAR }],
        plans: [{ id: "walk", title: "Walking tour of Montmartre", category: "activity", startsAt: T("15:00"), endsAt: T("17:00"), weatherSensitive: true, point: NEAR }],
      }),
    },
    triggers: { crewSize: 2, transport: [], commitments: [], plans: [{ id: "walk", title: "Walking tour of Montmartre", startsAt: T("15:00"), endsAt: T("17:00"), weatherSensitive: true, partySize: 2 }] },
    urgency: [{ id: "cancel-before-deadline", inputs: { deadlineAt: T("13:00"), downstream: { dependentCommitments: 0, dependentPlans: 1, totalCommitments: 1, totalPlans: 1 }, consequence: "major" } }],
    impact: { state, changes: [{ kind: "cancel_plan", targetId: "walk" }] },
    replan: { actorUserId: "me" },
    compile: {
      windowPosition: "between", origin: HOTEL, participants: [{ userId: "me" }, { userId: "ana" }],
      candidates: [
        { id: "tour", placeId: null, name: "Montmartre stroll", placeType: "park", point: NEAR, source: "saved_idea" },
        { id: "museum", placeId: null, name: "Musée d'Orsay", placeType: "museum", point: NEAR, openingWindows: hours("09:00", "18:00"), source: "saved_idea" },
      ],
      goals: [], preferences: {}, nextCommitment: { id: "B", arriveBy: T("20:00"), point: HOTEL }, prepMinutes: 15,
      signalSubjectMap: { walk: "tour" },
    },
    meeting: null, rescue: [],
    attention: [{ label: "the plan is invalidated", event: { kind: "plan_invalidated", significance: "high", affectsViewer: true, actionable: true, deadlineAt: T("13:00") }, ctx: attentionCtx() }],
  };
}

/** Two commitments with no time to travel between them and two plans that overlap — every conflict rule, then the switch to AT_RISK. */
function noTimeToTravel(): TripScenario {
  const state: ImpactState = {
    plans: [
      plan("p1", "Market", T("13:00"), T("15:00"), { participantIds: ["me", "ana"], planScope: "ALL_CREW" }),
      plan("p2", "Gallery", T("14:30"), T("16:00"), { participantIds: ["me", "ana"], planScope: "ALL_CREW" }),
    ],
    reservations: [], transport: [],
    commitments: [
      { id: "museum", type: "activity", startsAt: T("14:00"), requiredArrivalAt: T("14:00"), flexibility: "shiftable", participantIds: ["me", "ana"] },
      { id: "train", type: "train", startsAt: T("16:20"), requiredArrivalAt: T("16:20"), flexibility: "fixed", participantIds: ["me", "ana"] },
    ],
    safeReturnActiveFor: [], crewIds: ["me", "ana"],
  };
  return {
    id: "no_time_to_travel", title: "A museum that ends when the train's approach begins, and two plans on top of each other", spec: ["§7.2", "§7.3", "§17.1", "§17.2", "§12.1", "§11.3"],
    now: NOW, day: SCENARIO_DAY,
    freedom: {
      commitments: [
        commitment("museum", "activity", T("14:00"), NEAR, { endsAt: new Date(T("16:00")), flexibility: "shiftable" }),
        commitment("train", "train", T("16:20"), FAR, { prepMinutes: 10 }),
      ],
      hops: [hop(45)], participants: ["me", "ana"], tripStart: TRIP_START, tripEnd: TRIP_END,
    },
    health: HEALTHY, pulse: null,
    triggers: {
      crewSize: 2, transport: [],
      commitments: [{ id: "museum", type: "activity", startsAt: T("14:00"), requiredArrivalAt: T("14:00") }, { id: "train", type: "train", startsAt: T("16:20"), requiredArrivalAt: T("16:20") }],
      plans: state.plans.map((p) => ({ id: p.id, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, weatherSensitive: false, partySize: 2 })),
    },
    urgency: [{ id: "resolve-conflict", inputs: { deadlineAt: null, downstream: { dependentCommitments: 2, dependentPlans: 2, totalCommitments: 2, totalPlans: 2 }, consequence: "severe" } }],
    impact: { state, changes: [{ kind: "move_plan", targetId: "p2", startsAt: T("15:45"), endsAt: T("16:45") }] },
    replan: { actorUserId: "me", constraints: { maxMoves: 2 } },
    compile: null, meeting: null, rescue: [],
    attention: [
      { label: "an opportunity while at risk", event: { kind: "opportunity_added", significance: "high", affectsViewer: true, actionable: true }, ctx: attentionCtx("AT_RISK") },
      { label: "the train is at risk", event: { kind: "commitment_at_risk", significance: "high", affectsViewer: true, actionable: true, deadlineAt: T("15:25") }, ctx: attentionCtx("AT_RISK") },
    ],
  };
}

/** §23 "6-person nightlife trip — attendance, subgroup split/rejoin, presence privacy, route chain." The crew regroups; the taxi is too small. */
function nightlifeCrewMeetup(): TripScenario {
  const crew = ["me", "ana", "bo", "cy", "dee", "eli"];
  const state: ImpactState = {
    plans: [plan("club", "Club night", T("22:00"), T("02:00", "14"), { participantIds: crew, planScope: "ALL_CREW" })],
    reservations: [{ id: "club-res", title: "Club night — table", type: "activity", status: "confirmed", startsAt: T("22:00"), endsAt: T("02:00", "14"), cancellationDeadlineAt: T("18:00"), costMinor: 12000, currency: "EUR", planId: "club", participantIds: crew }],
    transport: [{ id: "taxi1", mode: "taxi", state: "planned", plannedDepartureAt: T("21:30"), plannedArrivalAt: T("21:50"), servesId: "club", partySize: 6, costMinor: 2500, currency: "EUR" }],
    commitments: [], safeReturnActiveFor: [], crewIds: crew,
  };
  return {
    id: "nightlife_crew_meetup", title: "Six-person nightlife trip — regroup at a meeting point, a taxi for four", spec: ["§23 nightlife", "§14.3", "§8.4", "§10", "§16.2", "§15.3"],
    now: NOW, day: SCENARIO_DAY, freedom: null, health: HEALTHY,
    pulse: {
      signals: [
        signal("friend_nearby", "ana", { userId: "ana", distanceBand: "walking", bothSharing: true }),
        signal("friend_nearby", "dee", { userId: "dee", distanceBand: "nearby", bothSharing: false }),
      ],
      ctx: pulseCtx({ crew: { viewerId: "me", memberIds: crew } }),
    },
    triggers: {
      crewSize: 6, commitments: [],
      plans: [{ id: "club", title: "Club night", startsAt: T("22:00"), endsAt: T("02:00", "14"), weatherSensitive: false, partySize: 6 }],
      transport: [{ id: "taxi1", mode: "taxi", state: "planned", plannedDepartureAt: T("21:30"), partySize: 6, capacity: null, servesId: "club" }],
    },
    urgency: [{ id: "club-tickets", inputs: { deadlineAt: T("18:00"), downstream: { dependentCommitments: 0, dependentPlans: 1, totalCommitments: 0, totalPlans: 1 }, consequence: "major" } }],
    impact: { state, changes: [{ kind: "cancel_plan", targetId: "club" }] },
    replan: { actorUserId: "me" },
    compile: null,
    meeting: {
      now: NOW, travel: straightLineMinutes, partySize: 6, prepMinutes: 5,
      participants: [
        { userId: "me", point: HOTEL },
        { userId: "ana", point: NEAR, accessibilityNeeds: ["stairs_only"] },
        { userId: "bo", point: FAR, nextCommitment: { id: "train", arriveBy: T("13:30"), point: FAR } },
        { userId: "dee", point: null, positionReason: "not sharing" },
      ],
      candidates: [
        { id: "cafe", name: "Café Mid", point: MID, placeType: "cafe", capacity: 20 },
        { id: "far-bar", name: "Far Bar", point: FAR, placeType: "bar" },
        { id: "hotel", name: "Our hotel", point: HOTEL, placeType: "hotel", privateAnchor: true },
        { id: "station", name: "Gare", point: NEAR, placeType: "train_station" },
        { id: "closed", name: "Closed bar", point: NEAR, placeType: "bar", closure: "temporarily_closed" },
        { id: "tiny", name: "Tiny bar", point: NEAR, placeType: "bar", capacity: 2 },
        { id: "stairs", name: "Stairs bar", point: NEAR, placeType: "bar", accessibilityConstraints: ["stairs_only"] },
        { id: "mall", name: "Mall", point: NEAR, placeType: "shopping_mall" },
      ],
    },
    rescue: [],
    attention: [{ label: "a friend is nearby", event: { kind: "meetup_opportunity", significance: "low", affectsViewer: true, actionable: true }, ctx: attentionCtx() }],
  };
}

/** A member needs help: the priority switch, the pulse, the attention policy and the rescue plans under a safety event. */
function safetyEvent(): TripScenario {
  return {
    id: "safety_event", title: "A crew member needs help — everything discretionary steps back", spec: ["§17.1", "§17.2", "§17.3", "§16.2", "§11.4", "§17.4"],
    now: NOW, day: SCENARIO_DAY, freedom: null,
    health: {
      conflicts: [], risks: [{ id: "r1", likelihood: "high", impact: "high", status: "open" }],
      disruptions: [{ id: "d1", kind: "safety", severity: "critical", state: "active" }],
      needsHelpMemberIds: ["bo"], hops: { infeasible: 0, unknown: 0 },
    },
    pulse: {
      signals: [
        signal("crowd_rising", "bar", { placeId: "bar", level: "high", trajectory: "rising" }),
        signal("friend_nearby", "ana", { userId: "ana", distanceBand: "walking", bothSharing: true }),
      ],
      ctx: pulseCtx({ attention: "SAFETY_EVENT", savedIdeas: [{ id: "bar", placeId: "bar", placeType: "bar", name: "Le Bar", point: NEAR }], crew: { viewerId: "me", memberIds: ["me", "ana", "bo"] } }),
    },
    triggers: null, urgency: [], impact: null, replan: null, compile: null, meeting: null,
    rescue: [
      { problem: "lost_crew", ctx: { now: NOW, crewWithPosition: ["me", "ana"], safeReturnAvailable: true, destinationCountry: "FR" } },
      { problem: "emergency", ctx: { now: NOW, emergencyNumber: "112", destinationCountry: "FR", homeCountry: "GB" } },
    ],
    attention: [
      { label: "the safety alert itself", event: { kind: "safety_alert", significance: "critical", affectsViewer: true, actionable: true, safety: true }, ctx: attentionCtx("SAFETY_EVENT") },
      { label: "an opportunity during a safety event", event: { kind: "opportunity_added", significance: "high", affectsViewer: true, actionable: true }, ctx: attentionCtx("SAFETY_EVENT") },
    ],
  };
}

/** §9.4 / §15.3: what cancelling, moving or removing a booked shared dinner costs, and three decisions ranked by more than their dates. */
function bookedDinnerCancellation(): TripScenario {
  const crew = ["me", "ana", "bo"];
  const state: ImpactState = {
    plans: [plan("dinner", "Dinner at Chez Paul", T("20:00"), T("22:00"), { participantIds: crew, planScope: "ALL_CREW" })],
    reservations: [{ id: "din-res", title: "Chez Paul", type: "restaurant", status: "confirmed", startsAt: T("20:00"), endsAt: T("22:00"), cancellationDeadlineAt: T("18:00"), costMinor: 9000, currency: "EUR", planId: "dinner", participantIds: crew }],
    transport: [{ id: "cab", mode: "taxi", state: "booked", plannedDepartureAt: T("19:30"), plannedArrivalAt: T("19:50"), servesId: "dinner", partySize: 3, costMinor: 2500, currency: "EUR" }],
    commitments: [], safeReturnActiveFor: [], crewIds: crew,
  };
  return {
    id: "booked_dinner_cancellation", title: "Cancelling, moving or removing a booked shared dinner — and three decisions ranked by urgency", spec: ["§9.4", "§15.3", "§12.1", "§8.2", "§9.1"],
    now: NOW, day: SCENARIO_DAY, freedom: null, health: HEALTHY, pulse: null, triggers: null,
    urgency: [
      { id: "confirm-dinner", inputs: { deadlineAt: T("18:00"), downstream: { dependentCommitments: 0, dependentPlans: 1, totalCommitments: 0, totalPlans: 1 }, consequence: "major" } },
      { id: "undated-severe", inputs: { deadlineAt: null, downstream: { dependentCommitments: 0, dependentPlans: 1, totalCommitments: 0, totalPlans: 1 }, consequence: "severe" } },
      { id: "dated-trivia", inputs: { deadlineAt: T("12:00", "14"), downstream: { dependentCommitments: 0, dependentPlans: 0, totalCommitments: 0, totalPlans: 1 }, consequence: "none" } },
    ],
    impact: {
      state,
      changes: [
        { kind: "cancel_plan", targetId: "dinner" },
        { kind: "move_plan", targetId: "dinner", startsAt: T("21:00"), endsAt: T("23:00") },
        { kind: "remove_plan", targetId: "dinner" },
      ],
    },
    replan: { actorUserId: "me" }, compile: null, meeting: null, rescue: [], attention: [],
  };
}

/** §22.4 / §13.1 / §12.3: a venue closed before arrival, one with unknown hours, one with a queue longer than the window — and which of them is worth a question. */
function closedVenueUncertainHours(): TripScenario {
  return {
    id: "closed_venue_uncertain_hours", title: "Closed before arrival, hours unknown, a queue longer than the afternoon — and what is worth asking", spec: ["§13.1", "§22.4", "§12.3"],
    now: NOW, day: SCENARIO_DAY,
    freedom: {
      commitments: [commitment("A", "check_in", T("11:00"), HOTEL), commitment("B", "dinner", T("20:00"), HOTEL, { prepMinutes: 15 })],
      hops: [hop(0)], participants: ["me"], tripStart: TRIP_START, tripEnd: TRIP_END,
    },
    health: HEALTHY, pulse: null, triggers: null, urgency: [], impact: null, replan: null,
    compile: {
      windowPosition: "between", origin: HOTEL, participants: [{ userId: "me" }],
      candidates: [
        { id: "early-closer", placeId: null, name: "Morning museum", placeType: "museum", point: NEAR, openingWindows: hours("09:00", "11:00"), source: "saved_idea" },
        { id: "unknown-hours", placeId: null, name: "Back-street gallery", placeType: "gallery", point: NEAR, openingWindows: null, source: "saved_idea" },
        { id: "long-queue", placeId: null, name: "The tower", placeType: "tourist_attraction", point: NEAR, openingWindows: hours("09:00", "20:00"), liveConditions: { queueWaitMinutes: 600, confidence: 0.8 }, source: "saved_idea" },
        { id: "cafe", placeId: null, name: "Le Petit Café", placeType: "cafe", point: NEAR, openingWindows: hours("08:00", "22:00"), source: "saved_idea" },
      ],
      goals: [{ id: "g-art", type: "culture", scope: "personal", status: "open" }], preferences: {},
      nextCommitment: { id: "B", arriveBy: T("20:00"), point: HOTEL }, prepMinutes: 15, questions: true,
    },
    meeting: null, rescue: [], attention: [],
  };
}

/** The corpus, in the order the report prints it. Fresh objects on every call: no run can leak into the next. */
export function tripScenarioCorpus(): TripScenario[] {
  return [
    soloCityDay(), flightDelayOnArrival(), rainInvalidatesTour(), noTimeToTravel(),
    nightlifeCrewMeetup(), safetyEvent(), bookedDinnerCancellation(), closedVenueUncertainHours(),
  ];
}
