/**
 * Trips spec §14.3 — the smart meeting point service, PURE
 * (census-trips TR212, TR272–TR279).
 *
 *   "Meeting-point computation minimizes group burden subject to next
 *    commitments, accessibility, party size, venue suitability, privacy
 *    policy, and transport reliability. The service returns explanation and
 *    alternative candidates rather than a magic coordinate."
 *
 * Group burden is the sum of the participants' travel minutes to a
 * candidate, with the longest single journey as the tie-break — a point
 * that is fair to the crew, not the centroid. Every constraint is applied
 * by name and every candidate ranked or refused carries the reasons, so
 * "why here?" and "why not there?" are both answerable. Privacy first:
 * a participant with no shared position is not placed, is said so, and
 * contributes nothing; a candidate that is a private anchor is never one.
 */
import { metresBetween, type GeoPoint } from "./TripSignals.js";
import { primitiveFor, type ActivityPrimitive } from "./TripExperienceCompiler.js";

export interface MeetingParticipant {
  userId: string;
  /** Null when the viewer may not see it (§10) or none is known. */
  point: GeoPoint | null;
  /** Why the point is null, when it is. */
  positionReason?: string | null;
  accessibilityNeeds?: string[];
  /** ISO — the participant's next commitment and where. */
  nextCommitment?: { id: string; arriveBy: string; point: GeoPoint | null } | null;
  /** Their transport mode's reliability 0..1, when known (a taxi in surge is 0.5; walking is 1). */
  transportReliability?: number | null;
}

export interface MeetingCandidate {
  id: string;
  name: string;
  point: GeoPoint;
  placeType: string | null;
  /** True only when the caller knows the place is a private anchor (hotel / home): never a meeting point. */
  privateAnchor?: boolean;
  /** Seats / standing room, when known. */
  capacity?: number | null;
  accessibilityConstraints?: string[];
  /** Live: closed / packed venues are refused. */
  closure?: string | null;
  crowdLevel?: string | null;
}

export interface MeetingPointInputs {
  now: number;
  participants: MeetingParticipant[];
  candidates: MeetingCandidate[];
  /** Party size to seat; defaults to the placed participants. */
  partySize?: number | null;
  /** Minutes to hold back before anyone's next commitment. */
  prepMinutes?: number;
  travel: (from: GeoPoint, to: GeoPoint) => { minutes: number; mode: string } | null;
}

export const MEETING_REFUSALS = [
  "PRIVATE_ANCHOR", "VENUE_CLOSED", "VENUE_UNSAFE_DENSITY", "VENUE_UNSUITABLE", "PARTY_EXCEEDS_CAPACITY",
  "ACCESSIBILITY_UNMET", "NEXT_COMMITMENT_MISSED", "TRAVEL_UNKNOWN",
] as const;
export type MeetingRefusal = (typeof MEETING_REFUSALS)[number];

export interface MeetingJourney { userId: string; minutes: number; mode: string; /** Minutes to spare before their next commitment; null with none. */ slackMinutes: number | null; reliability: number }

export interface MeetingOption {
  candidateId: string;
  name: string;
  primitive: ActivityPrimitive;
  /** Sum of journeys, weighted by (2 − reliability) so an unreliable leg costs more. */
  groupBurdenMinutes: number;
  longestJourneyMinutes: number;
  journeys: MeetingJourney[];
  refusals: MeetingRefusal[];
  explanation: string[];
}

export interface MeetingPointResult {
  recommended: MeetingOption | null;
  alternatives: MeetingOption[];
  refused: MeetingOption[];
  /** Participants who could not be placed, and why. */
  unplaced: { userId: string; reason: string }[];
  constraintsApplied: string[];
  explanation: string[];
}

/** Venue types a crew can meet at. Anything else is refused as unsuitable. */
export const MEETING_PRIMITIVES: readonly ActivityPrimitive[] = ["MEET", "DRINK", "EAT", "SEE", "WALK", "REST", "TRANSIT", "PHOTO", "EXPLORE"];
const CLOSED = new Set(["temporarily_closed", "closed_for_private_event", "permanently_closed"]);

export function findMeetingPoint(inputs: MeetingPointInputs): MeetingPointResult {
  const prep = inputs.prepMinutes ?? 10;
  const placed = inputs.participants.filter((p) => p.point !== null);
  const unplaced = inputs.participants.filter((p) => p.point === null).map((p) => ({ userId: p.userId, reason: p.positionReason ?? "no shared position (§10: not sharing, or not visible to the viewer)" }));
  const party = inputs.partySize ?? inputs.participants.length;
  const needs = new Set(placed.flatMap((p) => p.accessibilityNeeds ?? []));
  const constraintsApplied = ["next commitments", "accessibility", "party size", "venue suitability", "privacy policy", "transport reliability"];
  const options: MeetingOption[] = [];

  for (const c of inputs.candidates) {
    const refusals: MeetingRefusal[] = [];
    const explanation: string[] = [];
    const primitive = primitiveFor(c.placeType, c.name);
    if (c.privateAnchor) refusals.push("PRIVATE_ANCHOR");
    if (c.closure && CLOSED.has(c.closure)) refusals.push("VENUE_CLOSED");
    if (c.crowdLevel === "unsafe_density") refusals.push("VENUE_UNSAFE_DENSITY");
    if (!MEETING_PRIMITIVES.includes(primitive)) { refusals.push("VENUE_UNSUITABLE"); explanation.push(`${primitive.toLowerCase()} is not a place to meet`); }
    if (c.capacity != null && party > c.capacity) { refusals.push("PARTY_EXCEEDS_CAPACITY"); explanation.push(`party of ${party} over ${c.capacity} seats`); }
    const unmet = (c.accessibilityConstraints ?? []).filter((k) => needs.has(k));
    if (unmet.length > 0) { refusals.push("ACCESSIBILITY_UNMET"); explanation.push(`${unmet.join(", ")} conflicts with a participant's need`); }
    const journeys: MeetingJourney[] = [];
    let burden = 0; let longest = 0;
    for (const p of placed) {
      const t = inputs.travel(p.point!, c.point);
      if (!t) { refusals.push("TRAVEL_UNKNOWN"); explanation.push(`travel for ${p.userId} could not be estimated`); continue; }
      const reliability = p.transportReliability ?? 1;
      let slack: number | null = null;
      if (p.nextCommitment) {
        const arriveBy = Date.parse(p.nextCommitment.arriveBy);
        const back = p.nextCommitment.point ? inputs.travel(c.point, p.nextCommitment.point)?.minutes ?? null : 0;
        if (Number.isFinite(arriveBy) && back !== null) {
          slack = Math.round((arriveBy - inputs.now) / 60_000) - t.minutes - back - prep;
          if (slack < 0 && !refusals.includes("NEXT_COMMITMENT_MISSED")) { refusals.push("NEXT_COMMITMENT_MISSED"); explanation.push(`${p.userId} would miss ${p.nextCommitment.id} by ${-slack} min`); }
        }
      }
      journeys.push({ userId: p.userId, minutes: t.minutes, mode: t.mode, slackMinutes: slack, reliability });
      burden += t.minutes * (2 - reliability); longest = Math.max(longest, t.minutes);
    }
    if (refusals.length === 0) explanation.unshift(`${Math.round(burden)} min of group travel, longest ${longest} min`);
    options.push({ candidateId: c.id, name: c.name, primitive, groupBurdenMinutes: Math.round(burden), longestJourneyMinutes: longest, journeys, refusals: [...new Set(refusals)], explanation });
  }

  const ok = options.filter((o) => o.refusals.length === 0 && placed.length > 0).sort((a, b) => a.groupBurdenMinutes - b.groupBurdenMinutes || a.longestJourneyMinutes - b.longestJourneyMinutes || a.candidateId.localeCompare(b.candidateId));
  const refused = options.filter((o) => o.refusals.length > 0 || placed.length === 0).sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  const recommended = ok[0] ?? null;
  const explanation = [
    placed.length === 0 ? "nobody has a shared position; nothing can be recommended" : `${placed.length} of ${inputs.participants.length} participant(s) placed`,
    recommended ? `${recommended.name}: least group burden (${recommended.groupBurdenMinutes} min, longest ${recommended.longestJourneyMinutes} min), no constraint refused it` : "no candidate satisfies every constraint",
    `${refused.length} candidate(s) refused by name`,
  ];
  return { recommended, alternatives: ok.slice(1), refused, unplaced, constraintsApplied, explanation };
}

export { metresBetween };
