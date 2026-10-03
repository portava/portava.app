/**
 * LayoverCrewItineraryStore — the plan `certifyCrewPlan` has never been given.
 *
 * §14.1: "Crew plan must be certified against every member branch." The solver
 * in `services/airport/LayoverCrewService.ts` does exactly that — per-branch
 * needed minutes against each member's OWN usable minutes, each branch against
 * each member's own required return-by, assignment checked so an unassigned
 * member cannot slip through unconstrained — and `routes/airport.ts` has always
 * called it with `unsplitPlan(members, [])`: one branch, everybody, no stops.
 *
 * With no stops `branchNeededMinutes` is 0, so `plan_exceeds_usable_minutes`
 * and `plan_ends_after_shared_return` can never fire and `split` is always
 * false. The two verdicts the spec asks for have been reachable and unexercised.
 * This module supplies the rows that exercise them. Storage is migration 3515.
 *
 * It does four things and decides nothing: read the plan, propose a stop, drop
 * a stop, assign a branch. Every judgement about whether a plan WORKS belongs
 * to `certifyCrewPlan` and is made in the route from what this returns.
 *
 * ── THE UNSPLIT CASE COSTS NOTHING, AND THAT IS THE DESIGN ───────────────────
 * A crew with no assignment rows is ONE branch called `'all'` containing
 * everybody — byte-for-byte what `unsplitPlan` builds, including the branch id.
 * So a crew that has never split reads exactly as it reads today, and a crew
 * that has split is the same shape with more branches. `readCrewPlan` is the
 * one place that rule lives.
 *
 * ── AN UNASSIGNED MEMBER IS NOT FOLDED INTO `'all'` ──────────────────────────
 * The tempting rule is "anyone without an assignment is in `'all'`". It is
 * wrong, and it is wrong in the direction that certifies a plan nobody checked.
 *
 * Once ONE assignment exists the crew has split, and a member with no
 * assignment is not "in the default branch" — they are a person the split
 * forgot. `certifyCrewPlan` has a reason for exactly this
 * (`member_unassigned`) and its comment says why it is checked at all: "a
 * member in no branch has no constraint applied to them". Folding them into
 * `'all'` would invent a branch for them, give them that branch's stops, and
 * certify them against an itinerary they were never put on.
 *
 * So: no assignments at all → everybody is in `'all'` (the unsplit case).
 * Any assignment at all → ONLY the assignments count, and a member left out
 * appears in no branch, which `certifyCrewPlan` reports. The reader does not
 * repair the plan; it shows it.
 *
 * ── EVERY READ REFUSES RATHER THAN RETURNING AN EMPTY PLAN ───────────────────
 * `LayoverCrewStore`'s rule, and this is the surface where it matters most in
 * the whole crew feature.
 *
 * An unreadable stops table returning `[]` is a plan with no stops, and a plan
 * with no stops is CERTIFIED FEASIBLE — zero needed minutes fits inside any
 * usable minutes and ends before any deadline. So a failed read would publish
 * `feasible: true` over a real itinerary nobody could measure, to a crew about
 * to go and do it. That is not a degraded answer, it is the opposite answer,
 * and it is the exact shape of the defect this repository has found four times
 * on this domain ("an unreadable block list was served as an empty city").
 *
 * Hence `CrewPlanRead` is discriminated and the route publishes a refusal. The
 * only empty plan this module will ever return is one it measured.
 *
 * ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────
 * NO VOTING, NO APPROVAL STATE. "Propose" means "add to the crew's plan,
 * attributed". Whether a stop needs assent, and from whom, is a product
 * decision nobody has taken; a `status` column defaulted to 'accepted' would
 * answer it silently. 3515 ships no such column and says so.
 *
 * NO CHAT. §14's "shared chat" half of L131 belongs to Telegraph's threads,
 * which exist and already handle E2EE. 2984 refused to mint a second message
 * store and so does this.
 *
 * NO COORDINATES. 3515 holds none and asserts it; `CrewPlanStop` reads
 * `{ title, durationMin, travelMin, insideAirport }` and nothing else.
 *
 * ── STORAGE ──────────────────────────────────────────────────────────────────
 * `layover_crew_stops` and `layover_crew_branch_assignments`, created by
 * migration 3515. NOT APPLIED to any shared database as this file lands — see
 * 3515's header. Until it is, every read here is a refusal, which the route
 * publishes as a degrade rather than as an empty itinerary.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import type {
  CrewBranch,
  CrewPlan,
  CrewPlanStop,
} from "../airport/LayoverCrewService.js";

const logger = rootLogger.child({ service: "LayoverCrewItineraryStore" });

/**
 * NOTE FOR ANYONE TIDYING THIS UP: the `.from(...)` call sites below write the
 * table names as STRING LITERALS rather than using these constants, and
 * replacing them would be a regression — `check:write-path-columns` resolves a
 * site only when it can see `.from("<literal>")` in the AST. `LayoverCrewStore`
 * carries the same note at length. These stay exported because the tests import
 * them.
 */
export const CREW_STOP_TABLE = "layover_crew_stops";
export const CREW_BRANCH_ASSIGNMENT_TABLE = "layover_crew_branch_assignments";

/**
 * The unsplit branch's id. The SAME literal `unsplitPlan` uses, and the reason
 * it is written here rather than imported is that `unsplitPlan` does not export
 * it — it is an inline `"all"` inside that function. Keeping the two in step is
 * what makes "a crew with no assignments reads exactly as it reads today" true
 * rather than approximately true, so a test pins them equal.
 */
export const UNSPLIT_BRANCH_ID = "all";

/**
 * The most stops one crew may hold, across every branch.
 *
 * `MAX_STOPS` on the solo surface is 12 per plan. This is a crew-wide ceiling
 * at the same number PER BRANCH, bounded crew-wide so a 12-member crew split
 * twelve ways cannot turn one request into an unbounded read. The route
 * enforces the per-branch half; this is the read's own bound, and it is
 * deliberately larger than any legitimate plan so that hitting it means
 * something is wrong rather than that a traveller was thorough.
 */
export const CREW_STOP_READ_LIMIT = 200;

/** The largest crew 2984 admits, mirrored so one read cannot fan out past it. */
export const CREW_ASSIGNMENT_READ_LIMIT = 12;

export interface CrewStopRow {
  id: string;
  crewId: string;
  branchId: string;
  stopOrder: number;
  title: string;
  durationMin: number;
  travelMin: number;
  insideAirport: boolean;
  locationLabel: string | null;
  proposedBy: string;
  createdAt: string;
}

export interface CrewBranchAssignmentRow {
  crewId: string;
  userId: string;
  branchId: string;
  assignedBy: string;
  assignedAt: string;
}

type Fail = { ok: false; reason: "read_failed" };
export type CrewPlanRead<T> = { ok: true; value: T } | Fail;

const FAILED: Fail = { ok: false, reason: "read_failed" };

const STOP_COLUMNS =
  "id,crew_id,branch_id,stop_order,title,duration_min,travel_min,inside_airport,location_label,proposed_by,created_at";
const ASSIGNMENT_COLUMNS = "crew_id,user_id,branch_id,assigned_by,assigned_at";

function toStop(r: Record<string, any>): CrewStopRow {
  return {
    id: r.id,
    crewId: r.crew_id,
    branchId: r.branch_id,
    stopOrder: r.stop_order,
    title: r.title,
    durationMin: r.duration_min,
    travelMin: r.travel_min,
    insideAirport: Boolean(r.inside_airport),
    locationLabel: r.location_label ?? null,
    proposedBy: r.proposed_by,
    createdAt: r.created_at,
  };
}

function toAssignment(r: Record<string, any>): CrewBranchAssignmentRow {
  return {
    crewId: r.crew_id,
    userId: r.user_id,
    branchId: r.branch_id,
    assignedBy: r.assigned_by,
    assignedAt: r.assigned_at,
  };
}

/**
 * Branch ids are compared trimmed, in exactly one place.
 *
 * NOT lower-cased, unlike `canonCity`. A branch id is a label a client chose,
 * not a name two people might spell differently, and folding case would make
 * `"Museum"` and `"museum"` one branch — silently merging two groups of people
 * into one itinerary. Trimming alone closes the one failure that is never
 * intentional (a trailing space making a second branch that looks identical in
 * every UI).
 */
export function canonBranchId(branchId: string): string {
  return branchId.trim();
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function crewStops(
  db: SupabaseClient,
  crewId: string,
): Promise<CrewPlanRead<CrewStopRow[]>> {
  const { data, error } = await db
    .from("layover_crew_stops")
    .select(STOP_COLUMNS)
    .eq("crew_id", crewId)
    .order("branch_id", { ascending: true })
    .order("stop_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(CREW_STOP_READ_LIMIT);
  if (error) {
    logger.warn(
      { err: error.message, crewId },
      "crew stop read failed — refusing rather than certifying an empty itinerary as feasible",
    );
    return FAILED;
  }
  return { ok: true, value: (data ?? []).map((r) => toStop(r as Record<string, any>)) };
}

export async function crewBranchAssignments(
  db: SupabaseClient,
  crewId: string,
): Promise<CrewPlanRead<CrewBranchAssignmentRow[]>> {
  const { data, error } = await db
    .from("layover_crew_branch_assignments")
    .select(ASSIGNMENT_COLUMNS)
    .eq("crew_id", crewId)
    .order("assigned_at", { ascending: true })
    .limit(CREW_ASSIGNMENT_READ_LIMIT);
  if (error) {
    logger.warn(
      { err: error.message, crewId },
      "crew branch assignment read failed — refusing rather than certifying a split plan as unsplit",
    );
    return FAILED;
  }
  return {
    ok: true,
    value: (data ?? []).map((r) => toAssignment(r as Record<string, any>)),
  };
}

/** `CrewPlanStop` is the solver's shape. Everything else on the row is ours. */
function toPlanStop(row: CrewStopRow): CrewPlanStop {
  return {
    title: row.title,
    durationMin: row.durationMin,
    travelMin: row.travelMin,
    insideAirport: row.insideAirport,
  };
}

/**
 * Assemble the stored rows into the `CrewPlan` the solver takes.
 *
 * PURE. The reads are separate so the route can refuse on either one without
 * this function having to know what a failed read looks like, and so the
 * branch-building rule — which is the part with the argument in it — is
 * testable without a database.
 *
 * `memberIds` is the crew's CURRENT membership, from `crewMembers`. It is
 * passed in rather than derived from the assignments because an assignment row
 * for somebody who has since left is not a member, and a member who joined
 * after the split has no assignment. Both are real states and
 * `certifyCrewPlan` has the vocabulary for them
 * (`unknown_member_in_branch`, `member_unassigned`); inventing a branch for
 * either would hide it.
 *
 * ── BRANCH ORDER ─────────────────────────────────────────────────────────────
 * Branches come back sorted by id, and `'all'` is not special-cased into first
 * place. A deterministic order matters because `CrewSolution.branches` goes on
 * the wire and a client rendering them in read order would otherwise shuffle
 * between polls; which order it is does not matter, so the cheapest stable one
 * is used.
 */
export function buildCrewPlan(input: {
  memberIds: string[];
  stops: CrewStopRow[];
  assignments: CrewBranchAssignmentRow[];
}): CrewPlan {
  const members = new Set(input.memberIds);

  // An assignment for someone who has left the crew is not an assignment. It is
  // dropped here rather than passed through as `unknown_member_in_branch`,
  // because a departed member is not an unknown one — `leaveCrew` left their
  // assignment row behind and the crew is not malformed. A member who is still
  // here and in no branch IS reported, which is the case that matters.
  const live = input.assignments.filter((a) => members.has(a.userId));

  const stopsByBranch = new Map<string, CrewStopRow[]>();
  for (const s of input.stops) {
    const key = canonBranchId(s.branchId);
    const bucket = stopsByBranch.get(key);
    if (bucket) bucket.push(s);
    else stopsByBranch.set(key, [s]);
  }

  // THE UNSPLIT CASE. No live assignment means one branch, everybody — exactly
  // `unsplitPlan`, branch id included.
  if (live.length === 0) {
    return {
      branches: [
        {
          branchId: UNSPLIT_BRANCH_ID,
          memberIds: [...input.memberIds],
          stops: (stopsByBranch.get(UNSPLIT_BRANCH_ID) ?? []).map(toPlanStop),
        },
      ],
    };
  }

  // THE SPLIT CASE. Only the assignments count; see AN UNASSIGNED MEMBER IS NOT
  // FOLDED INTO `'all'`.
  const membersByBranch = new Map<string, string[]>();
  for (const a of live) {
    const key = canonBranchId(a.branchId);
    const bucket = membersByBranch.get(key);
    if (bucket) bucket.push(a.userId);
    else membersByBranch.set(key, [a.userId]);
  }

  // A branch holding stops but nobody is kept, not dropped. Dropping it would
  // quietly discard an itinerary somebody proposed; keeping it makes
  // `certifyCrewPlan` report `empty_branch`, which is the true state and is
  // visible to whoever has to fix it.
  for (const branchId of stopsByBranch.keys()) {
    if (!membersByBranch.has(branchId)) membersByBranch.set(branchId, []);
  }

  const branches: CrewBranch[] = [...membersByBranch.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([branchId, memberIds]) => ({
      branchId,
      memberIds,
      stops: (stopsByBranch.get(branchId) ?? []).map(toPlanStop),
    }));

  return { branches };
}

// ── writes ───────────────────────────────────────────────────────────────────

export type CrewPlanWrite<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | "read_failed"
        | "write_failed"
        /** The writer is not in this crew, or their membership has ended. */
        | "not_a_member"
        /** `MAX_CREW_STOPS_PER_BRANCH` would be exceeded. */
        | "branch_full"
        /** The stop named is not in this crew. */
        | "stop_unavailable"
        /** An assignment named somebody who is not in this crew. */
        | "not_all_members";
    };

/**
 * Per-branch stop ceiling, the solo surface's `MAX_STOPS`.
 *
 * Per BRANCH rather than per crew because a branch is what one person actually
 * walks, and the 12-stop limit is a statement about a day, not about a database.
 * A crew split three ways may legitimately hold 36 stops.
 */
export const MAX_CREW_STOPS_PER_BRANCH = 12;

export interface ProposeCrewStopInput {
  crewId: string;
  branchId: string;
  proposedBy: string;
  title: string;
  durationMin: number;
  travelMin: number;
  insideAirport: boolean;
  locationLabel: string | null;
}

/**
 * Propose a stop.
 *
 * MEMBERSHIP IS CHECKED HERE AND IT IS A READ, SO A FAILED READ REFUSES THE
 * WRITE. 3515 cascades `crew_id` but cannot assert that the proposer is in the
 * crew — a row count is not something a CHECK can see — so an unreadable
 * membership list is an unenforced scope. A crew's plan is a shared object:
 * without this check a crew id would be enough to write an itinerary into
 * somebody else's layover, and `certifyCrewPlan` would then certify THEIR
 * deadlines against it.
 *
 * THE CAPACITY CHECK IS ALSO A READ, AND A FAILED READ REFUSES. Same rule
 * `joinCrew` applies to `max_members` and the stops route to `MAX_STOPS`: an
 * unreadable stop list is an unenforced ceiling.
 *
 * `stop_order` IS DERIVED FROM THE READ BUT IS NOT A UNIQUENESS CLAIM. Two
 * members proposing at the same instant both read the same length and both
 * write that order, and 3515 deliberately has no unique index to turn the
 * second one into a 23505 for a traveller who did nothing wrong. Display order
 * falls back to `created_at`, and `branchNeededMinutes` folds over the stops
 * order-independently, so a duplicated order costs nothing anyone can see.
 *
 * NOTHING HERE VALIDATES THE LANDSIDE TRAVEL TIME. `landsideTravelRefusal` in
 * the route is the single place that rule lives, for both surfaces; a second
 * copy here is how the two would come to disagree (census L47 is what that cost
 * when it happened on the solo surface).
 */
export async function proposeCrewStop(
  db: SupabaseClient,
  input: ProposeCrewStopInput,
): Promise<CrewPlanWrite<CrewStopRow>> {
  const branchId = canonBranchId(input.branchId);

  const { data: mem, error: memErr } = await db
    .from("layover_crew_members")
    .select("crew_id,user_id,session_id,role,joined_at")
    .eq("crew_id", input.crewId)
    .eq("user_id", input.proposedBy)
    .is("left_at", null)
    .maybeSingle();
  if (memErr) {
    logger.warn(
      { err: memErr.message, crewId: input.crewId },
      "crew membership read failed on propose — refusing rather than writing into an unverified crew's plan",
    );
    return { ok: false, reason: "read_failed" };
  }
  if (!mem) return { ok: false, reason: "not_a_member" };

  const existing = await crewStops(db, input.crewId);
  if (!existing.ok) return { ok: false, reason: "read_failed" };
  const inBranch = existing.value.filter((s) => canonBranchId(s.branchId) === branchId);
  if (inBranch.length >= MAX_CREW_STOPS_PER_BRANCH) {
    return { ok: false, reason: "branch_full" };
  }

  const { data, error } = await db
    .from("layover_crew_stops")
    .insert({
      crew_id: input.crewId,
      branch_id: branchId,
      stop_order: inBranch.length,
      title: input.title,
      duration_min: input.durationMin,
      travel_min: input.travelMin,
      inside_airport: input.insideAirport,
      location_label: input.locationLabel,
      proposed_by: input.proposedBy,
    })
    .select(STOP_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    logger.warn(
      { err: error?.message, crewId: input.crewId },
      "crew stop insert failed",
    );
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: toStop(data as Record<string, any>) };
}

/**
 * Drop a stop.
 *
 * ANY MEMBER MAY DROP ANY OF THE CREW'S STOPS, and that is a decision rather
 * than an omission. A crew's itinerary is a shared object with no owner — 2984
 * gives the crew a founder but the plan is not theirs — and the alternative,
 * "only the proposer may remove it", leaves a crew unable to drop a stop
 * proposed by somebody whose flight has gone. Who proposed it is kept
 * (`proposed_by`) and published, so the act is attributable; it is not
 * restricted.
 *
 * THE DELETE IS SCOPED BY `crew_id` AS WELL AS `id`, so a stop id from another
 * crew deletes nothing and is reported as `stop_unavailable` rather than
 * silently succeeding. The id alone would be enough for the database; it is not
 * enough for the answer to be true.
 *
 * `stop_order` IS NOT COMPACTED, unlike the solo route's delete. There is
 * nothing to compact for: order is per branch, the fold is order-independent,
 * and a gap in the sequence is invisible once `created_at` is the tie-break.
 * Compacting would mean rewriting every later row on a table several people
 * write to, to fix a number nobody reads.
 */
export async function dropCrewStop(
  db: SupabaseClient,
  input: { crewId: string; stopId: string; userId: string },
): Promise<CrewPlanWrite<{ dropped: true }>> {
  const { data: mem, error: memErr } = await db
    .from("layover_crew_members")
    .select("crew_id,user_id,session_id,role,joined_at")
    .eq("crew_id", input.crewId)
    .eq("user_id", input.userId)
    .is("left_at", null)
    .maybeSingle();
  if (memErr) {
    logger.warn(
      { err: memErr.message, crewId: input.crewId },
      "crew membership read failed on drop — refusing rather than deleting from an unverified crew's plan",
    );
    return { ok: false, reason: "read_failed" };
  }
  if (!mem) return { ok: false, reason: "not_a_member" };

  const { data, error } = await db
    .from("layover_crew_stops")
    .delete()
    .eq("id", input.stopId)
    .eq("crew_id", input.crewId)
    .select("id");
  if (error) {
    logger.warn(
      { err: error.message, crewId: input.crewId, stopId: input.stopId },
      "crew stop delete failed",
    );
    return { ok: false, reason: "write_failed" };
  }
  // `select("id")` after the delete is what makes this VERIFY THE RESULTING
  // STATE rather than trust the call: supabase-js resolves without error when
  // the predicate matched nothing, so a stop id from another crew would
  // otherwise report success having deleted nothing.
  if (((data ?? []) as unknown[]).length === 0) {
    return { ok: false, reason: "stop_unavailable" };
  }
  return { ok: true, value: { dropped: true } };
}

/**
 * Split the crew, or re-split it, or put it back together.
 *
 * TAKES THE WHOLE ASSIGNMENT AT ONCE, not one member at a time, and the
 * difference is the whole safety of this write. §14.1's split is a property of
 * the PLAN: a crew half-assigned has members in no branch, and
 * `certifyCrewPlan` correctly reports `member_unassigned` and certifies nothing
 * for them. If a client had to assign members one call at a time, the crew
 * would pass through that state on every re-split, and a poll landing in the
 * middle would publish an infeasible plan for a crew nobody had broken.
 *
 * So the write is: delete every assignment for this crew, insert the ones
 * given. NOT A TRANSACTION — supabase-js has no client-side transaction, the
 * same constraint `createCrew` works under — so the window between them is
 * real, and its failure is handled rather than hoped away: if the insert fails
 * after the delete succeeded, the crew is UNSPLIT, which is a state
 * `certifyCrewPlan` certifies honestly (one branch, everybody, the `'all'`
 * stops) rather than a malformed one. That is why the delete goes first:
 * crashing into "unsplit" is recoverable by the traveller repeating the action,
 * and crashing into "half-split" is a plan that reads as broken.
 *
 * AN EMPTY ASSIGNMENT LIST IS THE WAY BACK TO UNSPLIT, deliberately. It is not
 * an invalid argument; it is "we are all going together again", and the delete
 * alone expresses it.
 *
 * EVERY NAMED USER MUST BE A CURRENT MEMBER. Checked here, as a read, so a
 * failed read refuses: assigning a non-member would write a row
 * `buildCrewPlan` then drops, so the assignment would silently not happen. It
 * is refused with a reason instead.
 *
 * WHAT IS NOT CHECKED: that every member got a branch. A partial split is a
 * real thing a crew may be doing mid-decision, and `certifyCrewPlan` already
 * names it (`member_unassigned`) rather than guessing. Refusing it here would
 * be this module deciding what a plan may look like, which is the one thing its
 * header says it does not do.
 */
export async function assignCrewBranches(
  db: SupabaseClient,
  input: {
    crewId: string;
    assignedBy: string;
    assignments: Array<{ userId: string; branchId: string }>;
  },
): Promise<CrewPlanWrite<{ assigned: number }>> {
  const { data: members, error: memErr } = await db
    .from("layover_crew_members")
    .select("crew_id,user_id,session_id,role,joined_at")
    .eq("crew_id", input.crewId)
    .is("left_at", null)
    .limit(CREW_ASSIGNMENT_READ_LIMIT);
  if (memErr) {
    logger.warn(
      { err: memErr.message, crewId: input.crewId },
      "crew membership read failed on assign — refusing rather than splitting an unverified crew",
    );
    return { ok: false, reason: "read_failed" };
  }
  const memberIds = new Set(
    ((members ?? []) as Array<Record<string, any>>).map((r) => String(r.user_id)),
  );
  if (!memberIds.has(input.assignedBy)) return { ok: false, reason: "not_a_member" };
  if (input.assignments.some((a) => !memberIds.has(a.userId))) {
    return { ok: false, reason: "not_all_members" };
  }

  const { error: delErr } = await db
    .from("layover_crew_branch_assignments")
    .delete()
    .eq("crew_id", input.crewId);
  if (delErr) {
    logger.warn(
      { err: delErr.message, crewId: input.crewId },
      "crew branch assignment clear failed — the previous split still stands",
    );
    return { ok: false, reason: "write_failed" };
  }

  if (input.assignments.length === 0) return { ok: true, value: { assigned: 0 } };

  const { error: insErr } = await db
    .from("layover_crew_branch_assignments")
    .insert(
      input.assignments.map((a) => ({
        crew_id: input.crewId,
        user_id: a.userId,
        branch_id: canonBranchId(a.branchId),
        assigned_by: input.assignedBy,
      })),
    );
  if (insErr) {
    // The crew is now UNSPLIT, which is honest and certifiable, and the caller
    // is told the write failed so it does not report a split that did not land.
    logger.error(
      { err: insErr.message, crewId: input.crewId },
      "crew branch assignment insert failed after the clear — the crew is now unsplit",
    );
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, value: { assigned: input.assignments.length } };
}
