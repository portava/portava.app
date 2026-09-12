/**
 * Trips spec §19.1 — `TripSafetyProjection`; §17.4 Safe Return integration.
 *
 * §17.4, verbatim:
 *
 *   Safe Return can attach to solo, subgroup, or full-crew execution
 *   contexts. Status sharing is opt-in, purpose-limited, and time-limited. It
 *   exposes operational states such as RETURNING/ARRIVED/NEEDS_HELP rather
 *   than unnecessary continuous location.
 *
 * WHAT EXISTED
 * ============
 * census-trips TR361: "Safety has services and endpoints, not a trip
 * projection." Safe Return sessions are real (`safe_return_sessions`,
 * migration 0167; services/safeReturn/SafeReturnService.ts) and the crew map
 * already folds one bit of them — `safeReturnActive` — into each card, gated
 * on the member's `share_safe_return_status` preference
 * (lib/tripCrewLocation.ts:226). This projection is the trip-scoped view §17.4
 * describes, and it is deliberately narrower than the session:
 *
 *   OPERATIONAL STATE, NOT LOCATION. A member's entry carries a state, the
 *   escalation level, and the timer end. No coordinates, no area label, no
 *   route. The crew map is where presence lives, under its own contract.
 *
 *   OPT-IN, PER MEMBER. A member's session is projected to a viewer who is not
 *   that member only when the member has said so — either the standing
 *   `share_safe_return_status` preference on this trip (the crew map's rule)
 *   or the session's own `notify_trip_crew_enabled`. A member always sees
 *   their own. Everything withheld is COUNTED, not hidden: `withheld` says how
 *   many crew sessions exist that this viewer may not see, so an empty list is
 *   never mistaken for "nobody is walking home".
 *
 *   ATTACHED TO THIS TRIP. Only sessions with `trip_id = tripId`. A member on
 *   a Safe Return walk that is not attached to this trip is not this trip's
 *   safety state — the crew map's `safeReturnActive` bit takes the wider
 *   reading (any active session of a crew member), and the two readings are
 *   both stated so nobody reconciles them by accident.
 *
 *   TIME-LIMITED. An ARRIVED state is operational for 24 hours after the
 *   session closed and then it is history, which `listHistory` serves.
 *
 * THE STATE MAPPING
 * =================
 *   status=active,  escalation_level 0   → RETURNING   the walk is under way
 *   status=active,  escalation_level ≥ 1 → NEEDS_HELP  a check-in was missed and escalation began
 *   status=missed                         → NEEDS_HELP  the timer ran out without a safe confirmation
 *   status=safe                           → ARRIVED     confirmed safe (for 24h)
 *   status=pending | cancelled            → (none)      not an operational state; not projected
 *
 * PURE. The route reads sessions, preferences and the roster; this file
 * decides what each viewer may be told.
 */
import type { TripProjectionEnvelope } from "./TripProjectionEnvelope.js";

export const SAFETY_OPERATIONAL_STATES = ["RETURNING", "ARRIVED", "NEEDS_HELP"] as const;
export type SafetyOperationalState = (typeof SAFETY_OPERATIONAL_STATES)[number];

/** How long a confirmed-safe session stays ARRIVED before it is history. */
export const ARRIVED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The `safe_return_sessions` columns this projection reads. */
export interface SafetySessionRow {
  id: string;
  user_id: string;
  trip_id: string | null;
  status: string;
  escalation_level: number | null;
  timer_start_at: string | null;
  timer_end_at: string | null;
  notify_trip_crew_enabled: boolean | null;
  closed_at: string | null;
  updated_at: string | null;
}

export interface SafetyMemberState {
  userId: string;
  sessionId: string;
  state: SafetyOperationalState;
  escalationLevel: number;
  /** When the walk began. */
  since: string | null;
  /** When the timer ends (RETURNING/NEEDS_HELP) — null for ARRIVED. */
  timerEndAt: string | null;
}

export interface TripSafetyProjection extends TripProjectionEnvelope {
  tripId: string;
  /** Crew members with a projected operational state on THIS trip, visible to this viewer. */
  members: SafetyMemberState[];
  /** Crew sessions in an operational state that this viewer may NOT see. Counted, never hidden. */
  withheld: number;
  needsHelpCount: number;
  /** §17.4's own words for what this projection is and is not. */
  reading: string;
}

export const SAFETY_READING =
  "§17.4: operational states of Safe Return sessions attached to this trip, for members who opted in (share_safe_return_status or notify_trip_crew_enabled). No location. ARRIVED for 24h after confirmation.";

/** The §17.4 operational state of a session row, or null when it has none. */
export function operationalState(row: Pick<SafetySessionRow, "status" | "escalation_level" | "closed_at">, now: number = Date.now()): SafetyOperationalState | null {
  const esc = typeof row.escalation_level === "number" ? row.escalation_level : 0;
  switch (row.status) {
    case "active": return esc >= 1 ? "NEEDS_HELP" : "RETURNING";
    case "missed": return "NEEDS_HELP";
    case "safe": {
      const closed = row.closed_at ? Date.parse(row.closed_at) : NaN;
      // A `safe` row with no readable closed_at cannot be placed in time and
      // is not claimed as a current arrival.
      return Number.isFinite(closed) && now - closed <= ARRIVED_WINDOW_MS ? "ARRIVED" : null;
    }
    default: return null;
  }
}

export interface SafetyInputs {
  tripId: string;
  viewerId: string;
  /** Accepted crew of the trip (owner included). A session from anyone else is not this trip's. */
  crewIds: ReadonlySet<string>;
  sessions: readonly SafetySessionRow[];
  /** userId → share_safe_return_status, from trip_crew_location_preferences for this trip. */
  sharePrefs: ReadonlyMap<string, boolean>;
  now?: number;
}

export function projectTripSafety(
  inputs: SafetyInputs,
  envelope: TripProjectionEnvelope,
): TripSafetyProjection {
  const now = inputs.now ?? Date.now();
  const members: SafetyMemberState[] = [];
  let withheld = 0;
  let needsHelpCount = 0;

  for (const s of inputs.sessions) {
    if (s.trip_id !== inputs.tripId) continue;         // not attached to this trip
    if (!inputs.crewIds.has(s.user_id)) continue;       // not this trip's crew
    const state = operationalState(s, now);
    if (state === null) continue;

    const optedIn = s.user_id === inputs.viewerId
      || inputs.sharePrefs.get(s.user_id) === true
      || s.notify_trip_crew_enabled === true;
    if (!optedIn) { withheld += 1; continue; }

    if (state === "NEEDS_HELP") needsHelpCount += 1;
    members.push({
      userId: s.user_id,
      sessionId: s.id,
      state,
      escalationLevel: typeof s.escalation_level === "number" ? s.escalation_level : 0,
      since: s.timer_start_at,
      timerEndAt: state === "ARRIVED" ? null : s.timer_end_at,
    });
  }

  // NEEDS_HELP first, then RETURNING, then ARRIVED; stable within a state.
  const rank: Record<SafetyOperationalState, number> = { NEEDS_HELP: 0, RETURNING: 1, ARRIVED: 2 };
  members.sort((a, b) => rank[a.state] - rank[b.state]);

  return { ...envelope, tripId: inputs.tripId, members, withheld, needsHelpCount, reading: SAFETY_READING };
}
