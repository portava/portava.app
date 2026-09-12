/**
 * Trips spec §17.3 — Trip Rescue, PURE (census-trips TR320–TR328).
 *
 *   "A rescue entry point routes to typed problems such as missed transport,
 *    hotel issue, lost crew, no ride, travel-document issue, stranded
 *    traveler, or emergency assistance. Compass can organize context but
 *    must escalate to airline, airport, embassy/consulate, local emergency,
 *    or human support where appropriate."
 *
 * A rescue PLAN is a function of the typed problem and what the trip knows:
 * the steps in order, who to escalate to and why (institutions by name, not
 * the user's own contacts — that is Safe Return's job), the disruption to
 * declare through the kernel (2785) so §17.2's switch flips, and what
 * Compass may and may not do about it. The route (POST /trips/:id/rescue)
 * declares the disruption and returns the plan; nothing here writes.
 */

export const RESCUE_PROBLEMS = ["missed_transport", "hotel_issue", "lost_crew", "no_ride", "travel_document", "stranded", "emergency"] as const;
export type RescueProblem = (typeof RESCUE_PROBLEMS)[number];

export const ESCALATION_TARGETS = ["airline", "airport", "rail_or_transit_operator", "property", "embassy_consulate", "local_emergency", "human_support", "trip_crew", "trusted_circle"] as const;
export type EscalationTarget = (typeof ESCALATION_TARGETS)[number];

export interface RescueContext {
  now: number;
  /** The destination's emergency number, when the trip knows its country. */
  emergencyNumber?: string | null;
  destinationCountry?: string | null;
  /** The traveller's home country, for the consulate. */
  homeCountry?: string | null;
  /** The next commitment that the problem threatens. */
  nextCommitment?: { id: string; type: string; arriveBy: string | null } | null;
  /** The lodging commitment or reservation in play. */
  lodging?: { id: string; title: string | null; confirmationRef: string | null } | null;
  /** The transport segment or reservation in play. */
  transport?: { id: string; mode: string; providerRef: string | null; fallbackId: string | null } | null;
  /** Crew members with a shared position right now (for lost_crew). */
  crewWithPosition?: string[];
  /** Safe Return is available to attach. */
  safeReturnAvailable?: boolean;
}

export interface RescueStep { order: number; action: string; who: "traveller" | "compass" | "crew"; detail: string }
export interface RescueEscalation { to: EscalationTarget; why: string; when: "now" | "if_unresolved" | "if_unsafe" }

export interface RescuePlan {
  problem: RescueProblem;
  severity: "minor" | "major" | "critical";
  /** The 2785 disruption to declare so §17.2's switch flips. */
  declare: { kind: "transport" | "lodging" | "safety" | "health" | "venue" | "other"; severity: "minor" | "major" | "critical"; note: string };
  steps: RescueStep[];
  escalation: RescueEscalation[];
  /** §17.3: what Compass may do (organise) and must not (act for an institution). */
  compass: { may: string[]; mustNot: string[] };
  safeReturn: "attach" | "offer" | "not_applicable";
  explanation: string[];
}

const PROBLEM_SEVERITY: Readonly<Record<RescueProblem, RescuePlan["severity"]>> = {
  missed_transport: "major", hotel_issue: "major", lost_crew: "major", no_ride: "minor", travel_document: "critical", stranded: "critical", emergency: "critical",
};
const PROBLEM_KIND: Readonly<Record<RescueProblem, RescuePlan["declare"]["kind"]>> = {
  missed_transport: "transport", hotel_issue: "lodging", lost_crew: "safety", no_ride: "transport", travel_document: "other", stranded: "safety", emergency: "safety",
};

export function planRescue(problem: RescueProblem, ctx: RescueContext): RescuePlan {
  const steps: RescueStep[] = [];
  const escalation: RescueEscalation[] = [];
  const explanation: string[] = [];
  let n = 0;
  const step = (who: RescueStep["who"], action: string, detail: string) => steps.push({ order: ++n, who, action, detail });
  const may = ["gather the trip's context: the commitment, the reservation, the crew's state", "draft what to say to the institution, with the reference numbers", "propose a replan through the command path once the traveller is safe"];
  const mustNot = ["book, cancel or rebook on the traveller's behalf", "invent a flight, booking or place fact", "relax a safety constraint or expand a certified window"];
  let safeReturn: RescuePlan["safeReturn"] = "not_applicable";

  switch (problem) {
    case "missed_transport": {
      step("traveller", "Go to the operator's desk or app now", ctx.transport?.providerRef ? `reference ${ctx.transport.providerRef}` : "the booking reference is on the reservation");
      if (ctx.transport?.fallbackId) step("compass", "Surface the fallback segment", `2782 fallback ${ctx.transport.fallbackId} is on the trip`);
      step("compass", "Recompute the day's plan", ctx.nextCommitment ? `${ctx.nextCommitment.type} ${ctx.nextCommitment.id} is next; the replan says what moves` : "no next commitment is threatened");
      escalation.push({ to: ctx.transport?.mode === "flight" ? "airline" : "rail_or_transit_operator", why: "only the operator can rebook a missed departure", when: "now" });
      if (ctx.transport?.mode === "flight") escalation.push({ to: "airport", why: "the airport's transfer desk handles missed connections", when: "if_unresolved" });
      break;
    }
    case "hotel_issue": {
      step("traveller", "Speak to the property's desk with the confirmation", ctx.lodging?.confirmationRef ? `confirmation ${ctx.lodging.confirmationRef}` : "the confirmation is on the reservation");
      step("compass", "List the crew's saved lodging ideas and tonight's free window", "an alternate entry plan needs somewhere to go");
      escalation.push({ to: "property", why: "the property owns the room and the policy", when: "now" });
      escalation.push({ to: "human_support", why: "a booking platform's support can re-book or refund; Compass cannot", when: "if_unresolved" });
      break;
    }
    case "lost_crew": {
      step("compass", "Show the crew who shares a position", ctx.crewWithPosition?.length ? `${ctx.crewWithPosition.length} member(s) share a position now` : "nobody is sharing a position; ask them to start a live share");
      step("crew", "Agree a meeting point", "the meeting-point service ranks candidates by group burden");
      step("compass", "Offer Safe Return to the lost member", "an operational RETURNING / ARRIVED / NEEDS_HELP state, not continuous location");
      safeReturn = ctx.safeReturnAvailable === false ? "not_applicable" : "offer";
      escalation.push({ to: "trip_crew", why: "the crew is the first search party", when: "now" });
      escalation.push({ to: "local_emergency", why: "a member unreachable and at risk is a police matter, not a Compass one", when: "if_unsafe" });
      break;
    }
    case "no_ride": {
      step("compass", "Show taxi demand and the transit condition from the pulse", "a transport_uncertainty signal says how bad it is");
      step("traveller", "Try the next mode", "transit, a walk under two kilometres, or a crew member's ride");
      step("compass", "Recompute the free window and the next commitment's leave-by", "the freedom projection says how long the wait can be");
      escalation.push({ to: "rail_or_transit_operator", why: "the last train or bus may still run; the operator knows", when: "if_unresolved" });
      break;
    }
    case "travel_document": {
      step("traveller", "Contact the embassy or consulate", ctx.homeCountry ? `${ctx.homeCountry}'s mission in ${ctx.destinationCountry ?? "the destination"}` : "the home country's mission at the destination");
      step("compass", "Gather what the consulate will ask for", "the passport details the trip holds, the itinerary, the return flight");
      step("compass", "Mark the return flight at risk", "the freedom engine marks the commitment; nothing is cancelled");
      escalation.push({ to: "embassy_consulate", why: "only a consulate can issue an emergency travel document", when: "now" });
      escalation.push({ to: "airline", why: "the airline decides whether a replacement document is accepted for boarding", when: "if_unresolved" });
      break;
    }
    case "stranded": {
      step("compass", "Establish the traveller's state through Safe Return", "RETURNING / ARRIVED / NEEDS_HELP, opt-in and time-limited");
      step("compass", "Find shelter and a way back", "the meeting-point and opportunity engines over the trip's lodging and transport");
      step("crew", "Coordinate through the crew", "a crew member with a ride or a room resolves most stranding");
      safeReturn = "attach";
      escalation.push({ to: "trip_crew", why: "first responders who already know the traveller", when: "now" });
      escalation.push({ to: "local_emergency", why: "stranded and unsafe is an emergency", when: "if_unsafe" });
      escalation.push({ to: "human_support", why: "a stranded traveller may need a person, not a model", when: "if_unresolved" });
      break;
    }
    case "emergency": {
      step("traveller", "Call the local emergency number", ctx.emergencyNumber ? `${ctx.emergencyNumber} in ${ctx.destinationCountry ?? "the destination"}` : "the destination's emergency number");
      step("compass", "Notify the crew and the trusted circle through Safe Return", "NEEDS_HELP is the state; the crew's health switches to SAFETY_EVENT (§17.2)");
      safeReturn = "attach";
      escalation.push({ to: "local_emergency", why: "an emergency is not organised, it is answered", when: "now" });
      escalation.push({ to: "trusted_circle", why: "Safe Return's contacts, by the user's own opt-in", when: "now" });
      escalation.push({ to: "embassy_consulate", why: "a citizen in a medical or legal emergency abroad", when: "if_unresolved" });
      break;
    }
  }
  const severity = PROBLEM_SEVERITY[problem];
  explanation.push(`${problem.replace(/_/g, " ")}: ${severity}; ${steps.length} step(s), ${escalation.length} escalation(s)`);
  explanation.push("Compass organises context; it escalates to the institution and does not act for it (§17.3)");
  return {
    problem, severity,
    declare: { kind: PROBLEM_KIND[problem], severity, note: `rescue: ${problem.replace(/_/g, " ")}` },
    steps, escalation, compass: { may, mustNot }, safeReturn, explanation,
  };
}
