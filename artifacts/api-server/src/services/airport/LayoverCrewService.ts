/**
 * LayoverCrewService — §14.1 crew constraint solving, and the §14 disclosure
 * rules that decide what one traveller may learn about another.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §14   visibility ladder L0..L4 (census L127-L132; the L0/L2 half lives in
 *         LayoverPrivacyGuard.disclosePresence, this file owns L3 and L4)
 *   §14.1 shared_return_by = min(member.required_return_by)   (census L133)
 *         explicit split plans                                (census L134)
 *         "Crew plan must be certified against every member branch" (L135)
 *         "No precise stranger location by default"           (census L136)
 *         crew location sharing expires on dissolution, airport re-entry,
 *         boarding, session expiry or user revocation         (census L137)
 *         "Traveler pins should not expose an unsafe 'meet here' action
 *          without the established social/safety gate"        (census L138)
 *         "Shared rides require opt-in and should avoid revealing full
 *          itinerary to unrelated users"                      (census L139)
 *
 * ── WHAT THIS MODULE IS, EXACTLY ────────────────────────────────────────────
 * A deterministic solver. No clock (`nowMs` is always an argument), no I/O, no
 * randomness, no Supabase client anywhere in the file. Every function is a
 * total function of its arguments, so the tests can sweep it rather than stage
 * it, and a caller cannot get a different answer by calling at a different
 * moment without saying which moment.
 *
 * ── WHAT IT IS NOT, SAID LOUDLY ─────────────────────────────────────────────
 * There is NO CREW STORAGE on this tree. `layover_crews`, `layover_crew_members`
 * and a presence/location-grant table do not exist (spec §19 step 5 is unbuilt,
 * census L28), so nothing here is reachable from an HTTP route yet and no
 * traveller can form a crew today. This module is the constraint layer those
 * tables and routes will sit on, built first and deliberately: the census's
 * L136 and L138 are scored "N ∅" — the forbidden thing is absent only because
 * the feature is absent, and NOTHING GUARDS ITS ADDITION. These functions are
 * that guard, and they fail closed, so the day a crew table lands the unsafe
 * default is already refused.
 *
 * ── THE ONE ARITHMETIC RULE ─────────────────────────────────────────────────
 * Feasibility is NOT recomputed here. Each member arrives carrying a
 * `LayoverFeasibilityRecord` certified by `LayoverFeasibility.certifyFeasibility`
 * — the single canonical derivation (spec §1) — and this module only ever takes
 * minima over, and compares against, numbers that record already published. A
 * member with no record is not "assumed fine": the plan is INFEASIBLE.
 */
import type { LayoverFeasibilityRecord } from "./LayoverFeasibility.js";
import type { LayoverReturnState } from "./LayoverSafetyEngine.js";

/** Version of the crew constraint rules. Travels on every solution. */
export const LAYOVER_CREW_VERSION = "2026.09.08-1";

// ─────────────────────────────────────────────────────────────────────────────
// §14.1 constraint solving
// ─────────────────────────────────────────────────────────────────────────────

export interface CrewMember {
  userId: string;
  sessionId: string;
  /**
   * The member's certified feasibility record, or null when it could not be
   * produced (unreadable session, unreadable airport, expired session).
   * Null is the fail-closed input: it makes every branch containing this
   * member infeasible rather than silently dropping them from the minimum.
   */
  record: LayoverFeasibilityRecord | null;
}

/** One stop of a crew plan. Same shape as a `layover_plan_stops` row's usable half. */
export interface CrewPlanStop {
  title: string;
  durationMin: number;
  travelMin: number;
  insideAirport: boolean;
}

/**
 * A branch of a crew plan: a set of members doing the same stops together.
 * A plan with ONE branch containing everybody is the unsplit case; a plan with
 * more than one branch is the spec's "explicit split plan".
 */
export interface CrewBranch {
  branchId: string;
  memberIds: string[];
  stops: CrewPlanStop[];
}

export interface CrewPlan {
  branches: CrewBranch[];
}

export type CrewInfeasibilityReason =
  | "no_members"
  | "member_without_certified_feasibility"
  | "member_unassigned"
  | "member_assigned_twice"
  | "unknown_member_in_branch"
  | "empty_branch"
  | "plan_exceeds_usable_minutes"
  | "plan_ends_after_shared_return";

export interface CrewMemberConstraint {
  userId: string;
  sessionId: string;
  /** ISO instant this member must be back at the airport by. Null = uncertified. */
  requiredReturnBy: string | null;
  /** Free landside minutes this member has from `nowMs`. Null = uncertified. */
  usableMinutes: number | null;
  /** §15 escalation state this member is already in. Null = uncertified. */
  returnState: LayoverReturnState | null;
  /** Certification identity of the record the two figures above came from. */
  inputHash: string | null;
}

export interface CrewBranchVerdict {
  branchId: string;
  memberIds: string[];
  /** min(required_return_by) over THIS branch's members. Null when any is uncertified. */
  branchReturnBy: string | null;
  /** The member(s) whose deadline set `branchReturnBy`. */
  bindingMemberIds: string[];
  neededMinutes: number;
  /** min(usableMinutes) over this branch's members. Null when any is uncertified. */
  usableMinutes: number | null;
  feasible: boolean;
  reasons: CrewInfeasibilityReason[];
  /** Per-member slack in minutes, negative when that member cannot make it. */
  perMemberSlackMin: Array<{ userId: string; slackMin: number | null }>;
}

export interface CrewSolution {
  crewVersion: string;
  /**
   * §14.1 `shared_return_by = min(member.required_return_by)` over the WHOLE
   * crew, whether or not the plan splits. A split plan lets a branch run past
   * it; nothing lets a branch run past its OWN branch return-by.
   */
  sharedReturnBy: string | null;
  bindingMemberIds: string[];
  members: CrewMemberConstraint[];
  branches: CrewBranchVerdict[];
  /** True only when EVERY branch is feasible for EVERY one of its members. */
  feasible: boolean;
  reasons: CrewInfeasibilityReason[];
  /** True when the plan has more than one branch — the spec's explicit split. */
  split: boolean;
  /** Certification identity of every member record folded into this solution. */
  certifiedOver: Array<{ userId: string; inputHash: string | null; engineVersion: string | null }>;
}

function memberConstraint(m: CrewMember): CrewMemberConstraint {
  const r = m.record;
  return {
    userId: m.userId,
    sessionId: m.sessionId,
    requiredReturnBy: r ? r.deadline.hardReturnTime.toISOString() : null,
    usableMinutes: r ? r.envelope.usableMinutes : null,
    returnState: r ? r.envelope.returnState : null,
    inputHash: r ? r.inputHash : null,
  };
}

/**
 * §14.1 `shared_return_by = min(member.required_return_by)`.
 *
 * Returns null when ANY member is uncertified. That is not pedantry: a minimum
 * taken over a subset is not the crew's deadline, and returning the minimum of
 * the members we happen to be able to read would hand the crew a LATER
 * deadline than the truth — the exact direction a safety minimum must never
 * move. Absent is refusable; a wrong later time is not.
 */
export function sharedReturnBy(members: CrewMember[]): { iso: string | null; bindingMemberIds: string[] } {
  if (members.length === 0) return { iso: null, bindingMemberIds: [] };
  let minMs = Number.POSITIVE_INFINITY;
  for (const m of members) {
    if (!m.record) return { iso: null, bindingMemberIds: [] };
    const ms = m.record.deadline.hardReturnTime.getTime();
    if (ms < minMs) minMs = ms;
  }
  const binding = members
    .filter((m) => m.record!.deadline.hardReturnTime.getTime() === minMs)
    .map((m) => m.userId);
  return { iso: new Date(minMs).toISOString(), bindingMemberIds: binding };
}

/**
 * Minutes a branch's itinerary needs, including getting back.
 *
 * Deliberately the SAME arithmetic as `computePlanFit` in routes/airport.ts:
 * every stop's dwell plus its travel, plus one more leg equal to the travel of
 * the last stop that is outside the airport (the ride back). It is duplicated
 * rather than imported because the route helper is not exported and this lane
 * does not own that file; if the two ever diverge the crew number is the wrong
 * one, and `layoverCrewConstraints.test.ts` pins the shape so the divergence is
 * visible rather than silent.
 */
export function branchNeededMinutes(stops: CrewPlanStop[]): number {
  const planned = stops.reduce((sum, s) => sum + (s.durationMin ?? 0) + (s.travelMin ?? 0), 0);
  const lastOutside = [...stops].reverse().find((s) => !s.insideAirport);
  return planned + (lastOutside ? (lastOutside.travelMin ?? 0) : 0);
}

/**
 * §14.1 "Crew plan must be certified against every member branch."
 *
 * Certification here means, for each branch and for EVERY member of it:
 *   1. that member has a certified feasibility record at all;
 *   2. the branch's needed minutes fit inside THAT member's usable minutes —
 *      not the crew's average, not the best member's;
 *   3. the branch does not run past that member's own required return-by.
 * A branch is feasible only when all three hold for all of its members, and the
 * plan is feasible only when all branches are.
 *
 * Assignment is checked too, because an unassigned member is the silent way a
 * split plan certifies against fewer branches than it has people: a member in
 * no branch has no constraint applied to them, and a member in two branches has
 * two contradictory ones.
 */
export function certifyCrewPlan(
  plan: CrewPlan,
  members: CrewMember[],
  opts: { nowMs: number },
): CrewSolution {
  const constraints = members.map(memberConstraint);
  const shared = sharedReturnBy(members);
  const byId = new Map(members.map((m) => [m.userId, m]));
  const planReasons: CrewInfeasibilityReason[] = [];

  if (members.length === 0) planReasons.push("no_members");
  if (members.some((m) => !m.record)) planReasons.push("member_without_certified_feasibility");

  // Assignment: exactly once, and only to known members.
  const assignmentCount = new Map<string, number>();
  for (const b of plan.branches) {
    for (const id of b.memberIds) {
      assignmentCount.set(id, (assignmentCount.get(id) ?? 0) + 1);
      if (!byId.has(id)) planReasons.push("unknown_member_in_branch");
    }
  }
  for (const m of members) {
    const n = assignmentCount.get(m.userId) ?? 0;
    if (n === 0) planReasons.push("member_unassigned");
    if (n > 1) planReasons.push("member_assigned_twice");
  }

  const branches: CrewBranchVerdict[] = plan.branches.map((b) => {
    const reasons: CrewInfeasibilityReason[] = [];
    const branchMembers = b.memberIds.map((id) => byId.get(id)).filter(Boolean) as CrewMember[];
    if (b.memberIds.length === 0) reasons.push("empty_branch");
    if (b.memberIds.some((id) => !byId.has(id))) reasons.push("unknown_member_in_branch");

    const needed = branchNeededMinutes(b.stops);
    const uncertified = branchMembers.some((m) => !m.record) || branchMembers.length !== b.memberIds.length;
    if (branchMembers.some((m) => !m.record)) reasons.push("member_without_certified_feasibility");

    let branchReturnMs: number | null = null;
    let usable: number | null = null;
    const slacks: Array<{ userId: string; slackMin: number | null }> = [];

    for (const m of branchMembers) {
      if (!m.record) { slacks.push({ userId: m.userId, slackMin: null }); continue; }
      const hardMs = m.record.deadline.hardReturnTime.getTime();
      branchReturnMs = branchReturnMs === null ? hardMs : Math.min(branchReturnMs, hardMs);
      const u = m.record.envelope.usableMinutes;
      usable = usable === null ? u : Math.min(usable, u);
      slacks.push({ userId: m.userId, slackMin: u - needed });
    }

    if (!uncertified && branchMembers.length > 0) {
      if (usable !== null && needed > usable) reasons.push("plan_exceeds_usable_minutes");
      // The branch ends `needed` minutes from now; it must end no later than
      // the earliest deadline in the branch.
      const endMs = opts.nowMs + needed * 60_000;
      if (branchReturnMs !== null && endMs > branchReturnMs) reasons.push("plan_ends_after_shared_return");
    }

    const bindingIds = branchReturnMs === null
      ? []
      : branchMembers
          .filter((m) => m.record && m.record.deadline.hardReturnTime.getTime() === branchReturnMs)
          .map((m) => m.userId);

    return {
      branchId: b.branchId,
      memberIds: [...b.memberIds],
      branchReturnBy: uncertified || branchReturnMs === null ? null : new Date(branchReturnMs).toISOString(),
      bindingMemberIds: bindingIds,
      neededMinutes: needed,
      usableMinutes: uncertified ? null : usable,
      feasible: reasons.length === 0 && branchMembers.length > 0,
      reasons,
      perMemberSlackMin: slacks,
    };
  });

  const allReasons = Array.from(new Set<CrewInfeasibilityReason>([
    ...planReasons,
    ...branches.flatMap((b) => b.reasons),
  ]));

  return {
    crewVersion: LAYOVER_CREW_VERSION,
    sharedReturnBy: shared.iso,
    bindingMemberIds: shared.bindingMemberIds,
    members: constraints,
    branches,
    feasible: allReasons.length === 0 && branches.length > 0 && branches.every((b) => b.feasible),
    reasons: allReasons,
    split: plan.branches.length > 1,
    certifiedOver: members.map((m) => ({
      userId: m.userId,
      inputHash: m.record?.inputHash ?? null,
      engineVersion: m.record?.engineVersion ?? null,
    })),
  };
}

/** The unsplit plan: one branch, everybody, one itinerary. */
export function unsplitPlan(members: CrewMember[], stops: CrewPlanStop[]): CrewPlan {
  return { branches: [{ branchId: "all", memberIds: members.map((m) => m.userId), stops }] };
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 / §14.1 disclosure: precise location, meet actions, shared rides
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How precisely one traveller's position may be shown to another.
 * Ordered weakest-first; `none` is the default for everybody.
 */
export const LOCATION_PRECISIONS = ["none", "city", "meeting_point", "precise"] as const;
export type LocationPrecision = (typeof LOCATION_PRECISIONS)[number];

export type CrewShareEndReason =
  | "crew_dissolved"
  | "airport_reentry"
  | "boarding"
  | "session_expired"
  | "user_revoked"
  | "ttl_elapsed"
  | "never_granted";

/**
 * An L4 temporary-location grant. Every field is required on purpose: a grant
 * with no expiry is not expressible, which is how "auto-expiring" (§14, L132)
 * is enforced by the type rather than by remembering to set it.
 */
export interface CrewLocationGrant {
  grantedByUserId: string;
  crewId: string;
  grantedAtMs: number;
  expiresAtMs: number;
}

/**
 * The five terminators §14.1 names, plus the grant's own TTL. Any signal whose
 * instant is <= now ends the share. `undefined` means "has not happened".
 */
export interface CrewShareSignals {
  crewDissolvedAtMs?: number;
  airportReentryAtMs?: number;
  boardingAtMs?: number;
  sessionExpiredAtMs?: number;
  revokedAtMs?: number;
}

/**
 * Is a temporary-location grant still live, and if not, what ended it?
 *
 * Checked in the order the spec lists them so the reported cause is the FIRST
 * thing that happened, not whichever branch the code reached first: a share
 * that ended at boarding and is now also past its TTL ended at boarding.
 * An absent grant is `never_granted`, never "expired" — the two are different
 * answers and only one of them means a traveller once said yes.
 */
export function evaluateCrewLocationShare(
  grant: CrewLocationGrant | null | undefined,
  signals: CrewShareSignals,
  nowMs: number,
): { active: boolean; endedBy: CrewShareEndReason | null; endedAtMs: number | null } {
  if (!grant) return { active: false, endedBy: "never_granted", endedAtMs: null };
  if (nowMs < grant.grantedAtMs) return { active: false, endedBy: "never_granted", endedAtMs: null };

  const terminators: Array<[CrewShareEndReason, number | undefined]> = [
    ["crew_dissolved", signals.crewDissolvedAtMs],
    ["airport_reentry", signals.airportReentryAtMs],
    ["boarding", signals.boardingAtMs],
    ["session_expired", signals.sessionExpiredAtMs],
    ["user_revoked", signals.revokedAtMs],
    ["ttl_elapsed", grant.expiresAtMs],
  ];

  let first: { reason: CrewShareEndReason; at: number } | null = null;
  for (const [reason, at] of terminators) {
    if (at === undefined || at === null) continue;
    if (at > nowMs) continue;
    if (first === null || at < first.at) first = { reason, at };
  }
  if (first) return { active: false, endedBy: first.reason, endedAtMs: first.at };
  return { active: true, endedBy: null, endedAtMs: null };
}

/**
 * §14.1 "No precise stranger location by default."
 *
 * The ONLY path to `precise` is a live L4 grant from the target, to a crew the
 * viewer is in. Everything else walks down:
 *
 *   viewer is not in a crew with the target      → "none"  (a stranger; the
 *                                                  presence list already
 *                                                  carries no location at all)
 *   crew mate, no live grant                     → "meeting_point" (the crew's
 *                                                  agreed place, which is a
 *                                                  place, not a person)
 *   crew mate, live grant                        → "precise"
 *
 * `blocked` short-circuits to "none" before anything else, and an unknown
 * relationship is treated as a stranger. There is no argument combination that
 * yields `precise` without a grant — that is the property the test sweeps.
 */
export function locationPrecisionFor(input: {
  viewerUserId: string;
  targetUserId: string;
  sameCrewId: string | null;
  blocked: boolean;
  grant: CrewLocationGrant | null | undefined;
  signals: CrewShareSignals;
  nowMs: number;
}): { precision: LocationPrecision; reason: string } {
  if (input.blocked) return { precision: "none", reason: "blocked" };
  if (input.viewerUserId === input.targetUserId) return { precision: "precise", reason: "self" };
  if (!input.sameCrewId) return { precision: "none", reason: "not_in_a_crew_together" };

  const share = evaluateCrewLocationShare(input.grant, input.signals, input.nowMs);
  if (!share.active) {
    return { precision: "meeting_point", reason: `no_live_grant:${share.endedBy ?? "unknown"}` };
  }
  if (input.grant!.grantedByUserId !== input.targetUserId) {
    return { precision: "meeting_point", reason: "grant_not_from_target" };
  }
  if (input.grant!.crewId !== input.sameCrewId) {
    return { precision: "meeting_point", reason: "grant_scoped_to_another_crew" };
  }
  return { precision: "precise", reason: "live_scoped_grant" };
}

export type MeetActionDenial =
  | "blocked"
  | "not_mutual"
  | "no_crew"
  | "meeting_point_not_public"
  | "safety_gate_not_cleared"
  | "return_state_escalated";

/**
 * §14.1 "Traveler pins should not expose an unsafe 'meet here' action without
 * the established social/safety gate."
 *
 * Every condition must hold; the function returns ALL failures rather than the
 * first, so a caller can explain the gate instead of just closing it. Note the
 * last one: a traveller already at RETURN_NOW or CONNECTION_AT_RISK is not
 * offered a meet-up, because §15 says exploration surfaces collapse there — a
 * "meet here" button at that moment is an invitation to miss a flight.
 */
export function meetActionAvailability(input: {
  blocked: boolean;
  mutualConnection: boolean;
  sameCrewId: string | null;
  meetingPointIsPublicVenue: boolean;
  safetyGateCleared: boolean;
  viewerReturnState: LayoverReturnState | null;
  targetReturnState: LayoverReturnState | null;
}): { allowed: boolean; denials: MeetActionDenial[] } {
  const denials: MeetActionDenial[] = [];
  if (input.blocked) denials.push("blocked");
  if (!input.mutualConnection) denials.push("not_mutual");
  if (!input.sameCrewId) denials.push("no_crew");
  if (!input.meetingPointIsPublicVenue) denials.push("meeting_point_not_public");
  if (!input.safetyGateCleared) denials.push("safety_gate_not_cleared");
  const escalated = (s: LayoverReturnState | null) =>
    s === null || s === "RETURN_NOW" || s === "CONNECTION_AT_RISK";
  if (escalated(input.viewerReturnState) || escalated(input.targetReturnState)) {
    denials.push("return_state_escalated");
  }
  return { allowed: denials.length === 0, denials };
}

export interface SharedRideLeg {
  fromLabel: string;
  toLabel: string;
  departsAtIso: string;
}

/**
 * §14.1 "Shared rides require opt-in and should avoid revealing the full
 * itinerary to unrelated users."
 *
 * The redaction is structural, not a filter over a fuller object: an unrelated
 * viewer gets `{ offered: false, leg: null }` and there is no field on the
 * result that could carry the rest of the itinerary. A co-rider gets exactly
 * ONE leg — the shared one — and never the stops before or after it.
 */
export function sharedRideDisclosure(input: {
  offererOptedIn: boolean;
  viewerIsCoRider: boolean;
  blocked: boolean;
  sharedLeg: SharedRideLeg | null;
  fullItinerary: SharedRideLeg[];
}): { offered: boolean; leg: SharedRideLeg | null; withheldLegs: number } {
  const withheld = input.fullItinerary.length - (input.sharedLeg ? 1 : 0);
  if (input.blocked || !input.offererOptedIn || !input.viewerIsCoRider || !input.sharedLeg) {
    return { offered: false, leg: null, withheldLegs: Math.max(0, input.fullItinerary.length) };
  }
  return { offered: true, leg: input.sharedLeg, withheldLegs: Math.max(0, withheld) };
}
