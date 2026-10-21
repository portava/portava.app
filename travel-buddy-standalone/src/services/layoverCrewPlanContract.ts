/**
 * The crew split-plan wire contract — types and the fail-closed parse of `GET/POST /api/airport/sessions/:id/crew/plan`
 * (census-layover L134 "explicit split plans: A leaves at T1, B/C continue to T2", L135 "crew plan certified against
 * every member branch"). Pure: no fetch, no React Native, so node:test can run it. `services/layoverCrewPlan.ts` does
 * the I/O and re-exports this.
 *
 * NOTHING HERE DECIDES FEASIBILITY. Every verdict, reason and time arrives certified from the server, which
 * re-certifies the stored plan against every member's own layover on every read. A branch whose verdict is missing or
 * unreadable is NOT certified — never assumed fine.
 */
export type CrewPlanReason =
  | 'no_members' | 'member_without_certified_feasibility' | 'member_unassigned' | 'member_assigned_twice'
  | 'unknown_member_in_branch' | 'empty_branch' | 'plan_exceeds_usable_minutes' | 'plan_ends_after_shared_return'
  | 'landside_closed_for_member' | 'branch_returns_after_member_deadline' | 'branch_return_time_passed'
  | 'stops_do_not_fit_before_branch_return' | 'member_must_return_now';

export interface CrewPlanStop { title: string; durationMin: number; travelMin: number; insideAirport: boolean }

export interface CrewPlanBranch {
  key: string;
  /** When this branch is back at the airport — the spec's T1 / T2. */
  returnBy: string;
  stops: CrewPlanStop[];
  /** Only the viewer and the crewmates whose card they can see. */
  memberIds: string[];
  hiddenMemberCount: number;
  includesYou: boolean;
  feasible: boolean;
  reasons: string[];
  landside: string;
}

export interface CrewPlan {
  id: string;
  proposedByYou: boolean;
  createdAt: string;
  certifiedAt: string;
  feasible: boolean;
  reasons: string[];
  split: boolean;
  branches: CrewPlanBranch[];
}

export type CrewPlanRead =
  | { ok: true; available: false }
  | { ok: true; available: true; inCrew: false }
  | { ok: true; available: true; inCrew: true; plan: CrewPlan | null }
  | { ok: false; message: string };

/** Each server reason in a traveller's words. An unknown one is shown as "not certified", never dropped. */
export const CREW_PLAN_REASON_TEXT: Record<CrewPlanReason, string> = {
  no_members: 'This group has nobody in it.',
  member_without_certified_feasibility: 'Someone’s layover could not be certified, so this group is not either.',
  member_unassigned: 'Someone in the crew is not in any group.',
  member_assigned_twice: 'Someone is in two groups.',
  unknown_member_in_branch: 'A group names someone who is no longer in the crew.',
  empty_branch: 'A group has nobody in it.',
  plan_exceeds_usable_minutes: 'The stops need more time than someone in this group has.',
  plan_ends_after_shared_return: 'The stops would finish after someone in this group has to be back.',
  landside_closed_for_member: 'This group leaves the airport, and someone in it may not.',
  branch_returns_after_member_deadline: 'This group would be back later than someone in it must be.',
  branch_return_time_passed: 'This group’s return time has already passed.',
  stops_do_not_fit_before_branch_return: 'The stops do not fit before this group’s return time.',
  member_must_return_now: 'Someone in this group must head back now, so it cannot leave the airport.',
};

export function crewPlanReasonText(r: string): string {
  return (CREW_PLAN_REASON_TEXT as Record<string, string>)[r] ?? 'This group is not certified right now.';
}

function isRecord(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null; }
function strings(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; }

function stopOf(v: unknown): CrewPlanStop | null {
  if (!isRecord(v) || !str(v.title) || typeof v.durationMin !== 'number' || typeof v.travelMin !== 'number' || typeof v.insideAirport !== 'boolean') return null;
  return { title: v.title as string, durationMin: v.durationMin, travelMin: v.travelMin, insideAirport: v.insideAirport };
}

function branchOf(v: unknown): CrewPlanBranch | null {
  if (!isRecord(v)) return null;
  const key = str(v.key), returnBy = str(v.returnBy);
  if (!key || !returnBy || !Number.isFinite(Date.parse(returnBy))) return null;
  const stops: CrewPlanStop[] = [];
  for (const s of Array.isArray(v.stops) ? v.stops : []) { const n = stopOf(s); if (!n) return null; stops.push(n); }
  return {
    key, returnBy, stops,
    memberIds: strings(v.memberIds),
    hiddenMemberCount: typeof v.hiddenMemberCount === 'number' && v.hiddenMemberCount > 0 ? v.hiddenMemberCount : 0,
    includesYou: v.includesYou === true,
    // FAIL CLOSED: only a literal `true` is a certified branch.
    feasible: v.feasible === true,
    reasons: strings(v.reasons),
    landside: str(v.landside) ?? 'unknown',
  };
}

/** The plan object, or null when it cannot be read whole (a plan missing a branch is not shown as a smaller plan). */
export function parseCrewPlan(v: unknown): CrewPlan | null {
  if (!isRecord(v) || !str(v.id) || !Array.isArray(v.branches) || v.branches.length === 0) return null;
  const branches: CrewPlanBranch[] = [];
  for (const b of v.branches) { const p = branchOf(b); if (!p) return null; branches.push(p); }
  return {
    id: v.id as string,
    proposedByYou: v.proposedByYou === true,
    createdAt: str(v.createdAt) ?? '',
    certifiedAt: str(v.certifiedAt) ?? '',
    feasible: v.feasible === true && branches.every((b) => b.feasible),
    reasons: strings(v.reasons),
    split: v.split === true,
    branches,
  };
}

export function parseCrewPlanRead(status: number, json: unknown): CrewPlanRead {
  const r = isRecord(json) ? json : null;
  const message = (r && str(r.message)) ?? 'Your crew plan could not be loaded.';
  // A 404 that is not the feature answering (an older server without the route) is "not available", never a failure.
  if (status === 404 && (!r || r.available === undefined)) return { ok: true, available: false };
  if (status < 200 || status >= 300 || !r || r.ok !== true) return { ok: false, message };
  if (r.available === false) return { ok: true, available: false };
  if (r.available !== true) return { ok: false, message: 'Your crew plan could not be read.' };
  if (r.inCrew === false) return { ok: true, available: true, inCrew: false };
  if (r.inCrew !== true) return { ok: false, message: 'Your crew plan could not be read.' };
  if (r.plan === null) return { ok: true, available: true, inCrew: true, plan: null };
  const plan = parseCrewPlan(r.plan);
  if (!plan) return { ok: false, message: 'Your crew plan could not be read.' };
  return { ok: true, available: true, inCrew: true, plan };
}

/** What a proposal asks for: the members who head back at their own T, and when everyone else is back. */
export interface CrewPlanProposal {
  branches: Array<{ memberIds: string[]; includeMe?: boolean; returnBy: string; stops?: CrewPlanStop[] }>;
  rest: { returnBy: string; stops?: CrewPlanStop[] } | null;
}

export type CrewPlanProposeOutcome =
  | { ok: true; plan: CrewPlan | null }
  | { ok: false; notCertified: CrewPlan | null; message: string };

export function parseCrewPlanPropose(status: number, json: unknown): CrewPlanProposeOutcome {
  const r = isRecord(json) ? json : null;
  if (status === 409 && r && r.reason === 'crew_plan_not_certified') {
    return { ok: false, notCertified: parseCrewPlan({ ...(isRecord(r.certification) ? r.certification : {}), id: 'draft' }), message: str(r.message) ?? 'That split does not fit everyone’s layover. Nothing was saved.' };
  }
  if (status >= 200 && status < 300 && r && r.ok === true) {
    const plan = r.plan === null || r.plan === undefined ? null : parseCrewPlan(r.plan);
    return { ok: true, plan };
  }
  return { ok: false, notCertified: null, message: (r && str(r.message)) ?? 'Your crew plan was not saved. Please try again.' };
}
