/**
 * Trip Kernel — the command boundary for canonical Trip writes.
 *
 * Spec: docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt
 *   §4.1 TripCommand envelope and the command service's validations
 *   §4.3 TripEvent envelope (written by the database function, not here)
 *   §6.1 canInviteParticipant / canEditTrip — capability per command
 *   §18.3/§18.4 optimistic concurrency; server aggregate version is canonical
 *   §21.1 trip_command_rejected_total by reason
 *   §22.4 duplicate idempotency key => no duplicate transition
 *   Appendix B reason-code families (TRIP_AUTH_*, TRIP_VERSION_*,
 *   TRIP_TEMPORAL_*, TRIP_IDENTITY_*)
 *
 * WHAT THIS MODULE IS
 * ===================
 * The TypeScript half of the kernel. The database half is
 * public.trip_kernel_execute (migration 2420 = contract v1, plan family;
 * migration 2450 = contract v2, adds the trip, participant, admin and system
 * families), which applies ONE command to canonical state and writes the
 * domain event, the outbox row, the idempotency receipt and the version bump
 * in the same transaction. This module builds the envelope, calls the function
 * through the service client, and turns the function's structured rejection
 * into an HTTP response.
 *
 * Authorization is NOT here. The route runs its own check (canEditPlan,
 * owner === user.id, membership.role === "invited", requireAdmin) exactly as it
 * always has, and only then issues a command. The function re-checks the
 * capability the command needs as defence in depth (§6.2), so a caller that
 * skipped the route-level check would still be refused, but that second check
 * is coarser than some route checks (crew, not plan-item authorship) and is
 * not a substitute.
 *
 * GATING
 * ======
 * Every route that can reach executeTripCommand first awaits
 * isTripKernelEnabled(). The flag `trip_kernel_enabled` is seeded FALSE by
 * 2420 and isFlagEnabled is fail-closed (absent row, unreadable table, thrown
 * error => false), so the pre-kernel direct write is what runs unless an
 * operator flips the row. src/test/tripKernel.test.ts proves the flag-off path
 * never calls the function and never touches trips.version.
 *
 * CONTRACT VERSIONS
 * =================
 *   v1 (2420)  plan family; actor is always a user; every response lacks
 *              `contract_version`.
 *   v2 (2450)  + actor_role ('user' | 'admin' | 'system'); + trip, participant,
 *              admin, system families; every response carries
 *              `contract_version: 2`. Every v1 envelope is a valid v2 envelope
 *              (actor_role defaults to 'user'). A v2 command type sent to a v1
 *              function is refused as TRIP_COMMAND_UNKNOWN_TYPE (400), which is
 *              how a route learns the database is behind the code — it is
 *              counted and logged, never mistaken for success.
 *   v2 + 2500  ADDITIVE, contract_version stays 2 (envelope and response shape
 *              unchanged): + JOIN_VIA_LINK (participant family; the actor is
 *              the JOINER, capability `link_holder` = the actor holds a claimed
 *              slot on an invite link that belongs to this trip); the
 *              ADD_PARTICIPANT / SET_PARTICIPANT_ROLE capability widens from
 *              `owner` to `host` (owner OR accepted co_host) because
 *              routes/trips-expansion.ts already lets a co-host approve a join
 *              request. A JOIN_VIA_LINK sent to a 2450 function is refused as
 *              TRIP_COMMAND_UNKNOWN_TYPE, the same signal as v2-against-v1.
 *   v2 + 2590  ADDITIVE, contract_version stays 2: ADD_PLAN carries the four
 *              remaining trip_plan_items columns (added_by — must be the
 *              actor —, description, city, country) so the hidden-gem
 *              attachment can be a command, and its location_is_private
 *              default is the TABLE's (true), not 2420's false. A 2500
 *              function silently drops the four keys and defaults to false —
 *              which is why every satellite route sends location_is_private
 *              explicitly and routes/hiddenGems.ts is the only writer whose
 *              kernel row depends on 2590.
 *
 * WHAT IT DOES NOT DO
 * ===================
 *   * No temporal/spatial validation beyond start <= end and no commitment
 *     dependencies (§4.1's fourth and fifth checks): there is no Temporal
 *     Freedom Engine to ask.
 *   * No lifecycle computation: lib/tripStatus.ts computes trips.status; the
 *     kernel validates the transition it is handed (§3.1 terminal states).
 *   * No outbox consumer and no projection worker (§4.4, §19.4).
 *   * The metric is an in-process counter with no exporter; nothing scrapes it.
 */
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "./featureFlags.js";
import { getServiceClient } from "./supabase.js";

export const TRIP_KERNEL_FLAG = "trip_kernel_enabled";

/** The contract version this module speaks (migration 2450). */
export const TRIP_KERNEL_CONTRACT_VERSION = 2;

/** Flag read is fail-closed (lib/featureFlags.isFlagEnabled). */
export async function isTripKernelEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, TRIP_KERNEL_FLAG);
}

/**
 * The gate every satellite writer uses: the SERVICE client when
 * `trip_kernel_enabled` is TRUE, else null — and null means "run the
 * pre-kernel direct write exactly as before". The function is executable by
 * service_role only (2420), so a user-scoped client is never handed back even
 * when the caller authorized with one. No service client configured => null,
 * the same fail-closed answer as an unreadable flag.
 *
 * routes/trips.ts, routes/trips-expansion.ts and routes/requests.ts predate
 * this helper and carry a local twin; the satellites (routes/plan.ts,
 * routes/events.ts, routes/hiddenGems.ts, routes/telegraphChat.ts,
 * routes/tripReservations.ts, routes/compass.ts, routes/airport.ts,
 * compass/CompassAutopilotEngine.ts, lib/visuals/service.ts) call this.
 */
export async function tripKernelClient(sc?: SupabaseClient | null): Promise<SupabaseClient | null> {
  const service = sc ?? getServiceClient();
  if (!service) return null;
  return (await isTripKernelEnabled(service)) ? service : null;
}

// ── Command vocabulary (§4.1) ─────────────────────────────────────────────────
// §4.1 lists ADD_PLAN | MOVE_PLAN | CONFIRM_PLAN | CANCEL_PLAN | JOIN_PLAN |
// LEAVE_PLAN | CREATE_SUBGROUP | SET_PRESENCE | CREATE_PROPOSAL |
// ACCEPT_PROPOSAL | COMPLETE_ACTIVITY as EXAMPLES. The five plan commands that
// carry a spec name are those five; every other name below is an extension
// the existing routes need and the spec does not name. JOIN_PLAN / LEAVE_PLAN
// (2772), SET_PRESENCE / *_PROPOSAL (2768, 2775) and CREATE_SUBGROUP (2780)
// arrived with the tables they act on and are declared beside their families.

/** Plan family (contract v1, migration 2420). Capability: crew. */
export type TripPlanCommandType =
  | "ADD_PLAN"
  | "UPDATE_PLAN"
  | "MOVE_PLAN"
  | "CONFIRM_PLAN"
  | "CANCEL_PLAN"
  | "COMPLETE_ACTIVITY"
  | "REMOVE_PLAN"
  // §5.1 stage family (2764). trip_stages is the root of §5's dependency graph;
  // these are the commands that make it non-writerless.
  | "ADD_STAGE"
  | "UPDATE_STAGE"
  | "REMOVE_STAGE"
  // §5.1 leg and commitment families (2765). Both hang off a stage: a leg joins
  // two of them and a commitment is filed under at most one. The kernel checks
  // stage OWNERSHIP explicitly rather than leaving it to the foreign key, which
  // would accept another trip's stage.
  | "ADD_LEG"
  | "UPDATE_LEG"
  | "REMOVE_LEG"
  | "ADD_COMMITMENT"
  | "UPDATE_COMMITMENT"
  | "REMOVE_COMMITMENT"
  // §5.1 goal, decision-task and risk families (2766). Trip-scoped: none of the
  // three references a stage, so the only ownership check is the assignee one
  // on decision tasks.
  | "ADD_GOAL"
  | "UPDATE_GOAL"
  | "REMOVE_GOAL"
  | "ADD_DECISION_TASK"
  | "UPDATE_DECISION_TASK"
  | "REMOVE_DECISION_TASK"
  | "ADD_RISK"
  | "UPDATE_RISK"
  | "REMOVE_RISK"
  // §10.1 presence, §9.3 proposals, §20.1 outcomes (2768). SET_PRESENCE,
  // CREATE_PROPOSAL and ACCEPT_PROPOSAL are the SPEC's names (§4.1), not local
  // ADD_/UPDATE_ inventions. REJECT_PROPOSAL is the one addition: `rejected` is
  // in the table's own status vocabulary, and a decision machine that can only
  // say yes records refusals as silence.
  | "SET_PRESENCE"
  | "CLEAR_PRESENCE"
  | "CREATE_PROPOSAL"
  | "ACCEPT_PROPOSAL"
  | "REJECT_PROPOSAL"
  // §9.3 governance (2775). Self-only: no user_id key, so there is no way to
  // spell "vote on someone's behalf".
  | "VOTE_ON_PROPOSAL"
  // Append-only. There is deliberately no UPDATE_OUTCOME and no REMOVE_OUTCOME:
  // §20.1 builds durable memory from outcomes, and a record of what happened
  // that can be edited afterwards is not evidence. Corrections are new rows.
  | "RECORD_OUTCOME"
  // §9.1 attendance (2772). JOIN_PLAN and LEAVE_PLAN are the SPEC's names
  // (§4.1). All three are self-only: none takes a user_id, so there is no way
  // to spell "mark someone else as going" and no rule about it to get wrong.
  | "JOIN_PLAN"
  | "LEAVE_PLAN"
  | "SET_PLAN_ATTENDANCE"
  | "REORDER_PLAN"
  | "LINK_PLAN_ROUTE_STOP"
  // §3.3 plan lifecycle (2779): START_PLAN → in_progress, SKIP_PLAN → skipped
  // (terminal). MOVE_PLAN on a confirmed plan leaves it 'moved' (same file).
  | "START_PLAN"
  | "SKIP_PLAN"
  // §4.2 stage lifecycle (2779): planned → active → completed, emitting
  // trip.stage_started / trip.stage_completed.
  | "START_STAGE"
  | "COMPLETE_STAGE";

/** §9.2 temporary subgroups (2780). Capability: crew; DISSOLVE additionally creator-or-host. */
export type TripSubgroupCommandType =
  | "CREATE_SUBGROUP"
  | "JOIN_SUBGROUP"
  | "LEAVE_SUBGROUP"
  | "DISSOLVE_SUBGROUP";

/** §10.4 / §11.3 meeting checkpoints (2794). Capability: crew; CLOSE additionally creator-or-host; SET_MEETING_ARRIVAL is the participant's own. */
export type TripMeetingCommandType =
  | "CREATE_MEETING_CHECKPOINT"
  | "SET_MEETING_ARRIVAL"
  | "CLOSE_MEETING_CHECKPOINT";

/** §15.1 transport segments (2782). Capability: crew. */
export type TripTransportCommandType =
  | "ADD_TRANSPORT_SEGMENT"
  | "UPDATE_TRANSPORT_SEGMENT"
  | "SET_TRANSPORT_STATE"
  | "REMOVE_TRANSPORT_SEGMENT";

/**
 * §17.2 disruptions and the §4.2 derived events (2785). DECLARE/RESOLVE are
 * crew. MARK_COMMITMENT_AT_RISK, CLEAR_COMMITMENT_RISK and OPEN_FREE_WINDOW
 * are the engines' — issued by TripHealthProjection / TripFreedomProjection
 * as actor_role "system" with a deterministic idempotency key, so a judgement
 * becomes an event once and re-detection is a duplicate — and also crew's,
 * so a person may record what they know.
 */
export type TripDisruptionCommandType =
  | "DECLARE_DISRUPTION"
  | "RESOLVE_DISRUPTION"
  | "MARK_COMMITMENT_AT_RISK"
  | "CLEAR_COMMITMENT_RISK"
  | "OPEN_FREE_WINDOW"
  /** §13.3 (2786): the engine records an opportunity-state change as trip.opportunities_changed. */
  | "RECORD_OPPORTUNITY_CHANGE";

/** Trip family (contract v2). Capability: none for CREATE_TRIP, owner otherwise. */
export type TripTripCommandType =
  | "CREATE_TRIP"
  | "UPDATE_TRIP"
  | "CANCEL_TRIP"
  | "COMPLETE_TRIP"
  | "ARCHIVE_TRIP";

/**
 * Participant family (contract v2). Capability: owner (INVITE / REMOVE), host —
 * owner or accepted co_host — for ADD / SET_PARTICIPANT_ROLE (2500; owner
 * under 2450), the invitee for ACCEPT / DECLINE, and for JOIN_VIA_LINK (2500)
 * the JOINER holding a claimed slot on an invite link of this trip.
 */
export type TripParticipantCommandType =
  | "INVITE_PARTICIPANT"
  | "ADD_PARTICIPANT"
  | "SET_PARTICIPANT_ROLE"
  | "REMOVE_PARTICIPANT"
  | "ACCEPT_INVITE"
  | "DECLINE_INVITE"
  | "JOIN_VIA_LINK";

/** Admin family (contract v2). Capability: actor_role 'admin' + profiles.role = 'admin'. */
export type TripAdminCommandType = "ADMIN_HIDE_TRIP";

/** System family (contract v2). Capability: actor_role 'system', no user. */
export type TripSystemCommandType = "SET_TRIP_COVER";

export type TripCommandType =
  | TripPlanCommandType
  | TripTripCommandType
  | TripParticipantCommandType
  | TripAdminCommandType
  | TripSystemCommandType
  | TripSubgroupCommandType
  | TripMeetingCommandType
  | TripTransportCommandType
  | TripDisruptionCommandType;

export type TripCommandFamily = "plan" | "trip" | "participant" | "admin" | "system" | "subgroup" | "meeting" | "transport" | "disruption" | "opportunity";

/** Which family a command type belongs to, and therefore which actor_role it needs. */
export function tripCommandFamily(type: TripCommandType): TripCommandFamily {
  switch (type) {
    case "CREATE_TRIP": case "UPDATE_TRIP": case "CANCEL_TRIP": case "COMPLETE_TRIP": case "ARCHIVE_TRIP":
      return "trip";
    case "INVITE_PARTICIPANT": case "ADD_PARTICIPANT": case "SET_PARTICIPANT_ROLE":
    case "REMOVE_PARTICIPANT": case "ACCEPT_INVITE": case "DECLINE_INVITE": case "JOIN_VIA_LINK":
      return "participant";
    case "ADMIN_HIDE_TRIP":
      return "admin";
    case "SET_TRIP_COVER":
      return "system";
    case "CREATE_SUBGROUP": case "JOIN_SUBGROUP": case "LEAVE_SUBGROUP": case "DISSOLVE_SUBGROUP":
      return "subgroup";
    case "CREATE_MEETING_CHECKPOINT": case "SET_MEETING_ARRIVAL": case "CLOSE_MEETING_CHECKPOINT":
      return "meeting";
    case "ADD_TRANSPORT_SEGMENT": case "UPDATE_TRANSPORT_SEGMENT": case "SET_TRANSPORT_STATE": case "REMOVE_TRANSPORT_SEGMENT":
      return "transport";
    case "DECLARE_DISRUPTION": case "RESOLVE_DISRUPTION":
    case "MARK_COMMITMENT_AT_RISK": case "CLEAR_COMMITMENT_RISK": case "OPEN_FREE_WINDOW":
      return "disruption";
    case "RECORD_OPPORTUNITY_CHANGE":
      return "opportunity";
    default:
      return "plan";
  }
}

export type TripActorRole = "user" | "admin" | "system";

/** §4.1 envelope, contract v2. */
export interface TripCommand {
  commandId: string;
  tripId: string;
  /** Required unless actorRole is "system". Always from the verified token, never the body. */
  actorUserId: string | null;
  /** Defaults to "user". "admin" and "system" commands are refused under any other role. */
  actorRole?: TripActorRole;
  expectedTripVersion?: number | null;
  idempotencyKey: string;
  type: TripCommandType;
  payload: Record<string, unknown>;
  clientObservedAt?: string | null;
  correlationId?: string | null;
}

// ── Reason codes ─────────────────────────────────────────────────────────────
// Appendix B families used: TRIP_AUTH_*, TRIP_VERSION_*, TRIP_TEMPORAL_*
// (start > end is a genuine temporal-consistency refusal; it is NOT the §7
// engine), TRIP_IDENTITY_* (a CREATE_TRIP against an id that already exists).
// NOT in Appendix B, recorded as owner decisions: TRIP_PLAN_* (plan-state
// transition), TRIP_LIFECYCLE_* (trip-state transition), TRIP_PARTICIPANT_*
// (membership-row state). Filing those under TRIP_TEMPORAL_* or TRIP_AUTH_*
// would misstate what was checked. TRIP_COMMAND_* and TRIP_KERNEL_UNAVAILABLE
// are transport/infrastructure, not domain reasons.
export type TripKernelReason =
  | "TRIP_COMMAND_MALFORMED"
  | "TRIP_COMMAND_UNKNOWN_TYPE"
  | "TRIP_NOT_FOUND"
  | "TRIP_PLAN_NOT_FOUND"
  | "TRIP_AUTH_NOT_CREW"
  | "TRIP_AUTH_NOT_OWNER"
  | "TRIP_AUTH_NOT_INVITED"
  | "TRIP_AUTH_NOT_HOST"
  | "TRIP_AUTH_NOT_LINK_HOLDER"
  | "TRIP_AUTH_NOT_ADMIN"
  | "TRIP_AUTH_ROLE_NOT_PERMITTED"
  | "TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN"
  | "TRIP_VERSION_CONFLICT"
  // §5.1 stage family (2764).
  | "TRIP_STAGE_NOT_FOUND"
  | "TRIP_STAGE_SEQUENCE_TAKEN"
  // §5.1 leg and commitment families (2765). TRIP_STAGE_NOT_FOUND is reused
  // deliberately: a leg or commitment naming a stage that is not this trip's is
  // the same refusal as naming one that does not exist, and inventing a second
  // reason would make the client distinguish a case it cannot act on.
  | "TRIP_LEG_NOT_FOUND"
  | "TRIP_COMMITMENT_NOT_FOUND"
  // §5.1 goal, decision-task and risk families (2766).
  | "TRIP_GOAL_NOT_FOUND"
  | "TRIP_DECISION_TASK_NOT_FOUND"
  | "TRIP_RISK_NOT_FOUND"
  // §10.1 presence, §9.3 proposals (2768).
  // Presence is a claim about where a PERSON is; a claim someone else can write
  // is not that person's presence.
  | "TRIP_PRESENCE_NOT_SELF"
  | "TRIP_PRESENCE_NOT_FOUND"
  | "TRIP_PROPOSAL_NOT_FOUND"
  // Only a pending proposal has a decision left to make. Accepting an
  // already-rejected one is not a late accept; it is a second decision
  // overwriting a recorded first.
  | "TRIP_PROPOSAL_NOT_PENDING"
  // §9.3 governance (2775). Under a counted rule the VOTE decides, not whoever
  // issued the command — a crew member may close a vote and may not overrule it.
  | "TRIP_PROPOSAL_VOTE_NOT_MET"
  // An accepted proposal APPLIES. One that cannot be carried out is refused and
  // stays pending, because a decision that never took effect is not a decision.
  | "TRIP_PROPOSAL_PAYLOAD_INVALID"
  // Fail-closed: a decision_rule outside §9.3's four refuses rather than
  // falling through to something permissive.
  | "TRIP_PROPOSAL_RULE_UNKNOWN"
  // §9.1 attendance and §5.1 trip_plans.version (2772).
  | "TRIP_PLAN_ATTENDANCE_NOT_FOUND"
  // PLAN-level optimistic concurrency, distinct from TRIP_VERSION_CONFLICT:
  // trips.version moves on every command in the trip, so two crew editing two
  // different plans would conflict on it while editing nothing in common.
  | "TRIP_PLAN_VERSION_CONFLICT"
  // Distinct from TRIP_AUTH_NOT_CREW on purpose: the ACTOR is authorised and
  // the ASSIGNEE is not. A client that cannot tell those apart shows the wrong
  // error to the wrong person — "you are not on this trip" to someone who is.
  | "TRIP_ASSIGNEE_NOT_CREW"
  | "TRIP_TEMPORAL_RANGE_INVERTED"
  | "TRIP_IDENTITY_ALREADY_EXISTS"
  | "TRIP_PLAN_INVALID_TRANSITION"
  | "TRIP_LIFECYCLE_INVALID_TRANSITION"
  | "TRIP_PARTICIPANT_ALREADY_EXISTS"
  | "TRIP_PARTICIPANT_NOT_FOUND"
  | "TRIP_PARTICIPANT_IS_OWNER"
  | "TRIP_PARTICIPANT_CAPACITY_REACHED"
  // 2779: §7.2 refused AT THE WRITE — a move into a commitment's approach
  // window, unless the command carries override_conflicts: true (recorded on
  // the event). Appendix B's TRIP_TEMPORAL_* family, emitted by the kernel.
  | "TRIP_TEMPORAL_CONFLICT"
  | "TRIP_STAGE_INVALID_TRANSITION"
  // 2780 subgroups.
  | "TRIP_SUBGROUP_NOT_FOUND"
  | "TRIP_SUBGROUP_NOT_MEMBER"
  // Distinct from TRIP_AUTH_NOT_CREW for the same reason as TRIP_ASSIGNEE_NOT_CREW:
  // the actor is crew; the person they NAMED is not.
  | "TRIP_SUBGROUP_MEMBER_NOT_CREW"
  // 2794 meeting checkpoints (§10.4, §11.3).
  | "TRIP_MEETING_NOT_FOUND"
  | "TRIP_MEETING_NOT_PARTICIPANT"
  | "TRIP_MEETING_PARTICIPANT_NOT_CREW"
  | "TRIP_MEETING_INVALID_TRANSITION"
  // 2782 transport segments.
  | "TRIP_TRANSPORT_NOT_FOUND"
  | "TRIP_TRANSPORT_INVALID_TRANSITION"
  // 2783: a personal goal is its owner's.
  | "TRIP_AUTH_NOT_CREATOR"
  // 2785 disruptions (Appendix B TRIP_DISRUPTION_* family).
  | "TRIP_DISRUPTION_NOT_FOUND"
  | "TRIP_DISRUPTION_NOT_ACTIVE"
  // §4.1 "validates sensitive-domain boundaries": a payload key from another domain.
  | "TRIP_COMMAND_SENSITIVE_DOMAIN"
  | "TRIP_KERNEL_UNAVAILABLE";

export type TripKernelResult =
  | {
      ok: true;
      duplicate: boolean;
      version: number;
      eventId: string;
      sequence: number | null;
      result: any;
      /** Absent from a contract-v1 function (2420 without 2450). */
      contractVersion: number | null;
    }
  | {
      ok: false;
      reason: TripKernelReason;
      detail?: string;
      currentVersion?: number;
      expectedVersion?: number;
      from?: string;
      to?: string;
      /** TRIP_AUTH_NOT_INVITED / TRIP_PARTICIPANT_ALREADY_EXISTS: the row's role. */
      currentRole?: string;
      contractVersion: number | null;
    };

// ── Trip-owned event types (§4.2) ─────────────────────────────────────────────
// The stable vocabulary a consumer (Map, Discovery, Layover, Sensing, Passport)
// may subscribe to through trip_outbox / trip_events. Adding a type is
// additive; renaming one is a contract break and needs a new schema_version
// on the event. Spec-named: trip.plan_added, trip.plan_moved,
// trip.plan_confirmed, trip.participant_joined, trip.trip_completed.
export const TRIP_EVENT_TYPES = [
  // plan family (v1)
  "trip.plan_added", "trip.plan_updated", "trip.plan_moved", "trip.plan_confirmed",
  "trip.plan_cancelled", "trip.plan_completed", "trip.plan_removed", "trip.plan_reordered",
  "trip.plan_route_stop_linked",
  // trip family (v2)
  "trip.created", "trip.updated", "trip.trip_completed", "trip.trip_cancelled", "trip.trip_archived",
  "trip.cover_set", "trip.hidden_by_admin",
  // participant family (v2). JOIN_VIA_LINK (2500) emits the spec-named
  // trip.participant_joined with payload.via = 'invite_link' — no new type.
  "trip.participant_invited", "trip.participant_added", "trip.participant_role_set",
  "trip.participant_removed", "trip.participant_joined", "trip.participant_declined",
  // stage family (2764). A stage order that can collide is not an order, so the
  // sequence is unique per trip and a clash is its own typed rejection rather
  // than a 23505 reaching the client as a 500.
  "trip.stage_added", "trip.stage_updated", "trip.stage_removed",
  // leg and commitment families (2765).
  "trip.leg_added", "trip.leg_updated", "trip.leg_removed",
  "trip.commitment_added", "trip.commitment_updated", "trip.commitment_removed",
  // goal, decision-task and risk families (2766).
  "trip.goal_added", "trip.goal_updated", "trip.goal_removed",
  "trip.decision_task_added", "trip.decision_task_updated", "trip.decision_task_removed",
  "trip.risk_added", "trip.risk_updated", "trip.risk_removed",
  // presence, proposal and outcome families (2768). trip.proposal_accepted is
  // named by the spec itself (§4.2), which is why it is not trip.proposal_set.
  "trip.presence_set", "trip.presence_cleared",
  "trip.proposal_created", "trip.proposal_accepted", "trip.proposal_rejected",
  "trip.proposal_voted",
  "trip.outcome_recorded",
  // attendance family (2772).
  "trip.plan_joined", "trip.plan_left", "trip.plan_attendance_set",
  // plan lifecycle, subgroup, transport, disruption, derived and opportunity
  // families (2779–2786) — every type trip_kernel_execute assigns.
  "trip.plan_started", "trip.plan_skipped", "trip.stage_started", "trip.stage_completed",
  "trip.commitment_at_risk", "trip.commitment_risk_cleared", "trip.disruption_resolved", "trip.free_window_created", "trip.opportunities_changed", "trip.subgroup_created", "trip.subgroup_dissolved", "trip.subgroup_joined", "trip.subgroup_left", "trip.transport_segment_added", "trip.transport_segment_removed", "trip.transport_segment_state_changed", "trip.transport_segment_updated", "trip.trip_disrupted",
] as const;
export type TripEventType = (typeof TRIP_EVENT_TYPES)[number];

// ── §21.1 trip_command_rejected_total by reason ──────────────────────────────
// In-process counter. No exporter exists in this codebase; readers are tests
// and, one day, whatever metrics endpoint the platform grows.
const rejectedTotal: Record<string, number> = {};

export function readTripCommandRejectedTotal(): Readonly<Record<string, number>> {
  return { ...rejectedTotal };
}

/** Test hook. */
export function _resetTripCommandRejectedTotal(): void {
  for (const k of Object.keys(rejectedTotal)) delete rejectedTotal[k];
}

function countRejection(reason: string): void {
  rejectedTotal[reason] = (rejectedTotal[reason] ?? 0) + 1;
}

// ── HTTP envelope ─────────────────────────────────────────────────────────────
// The spec defines the envelope (§4.1) and not its HTTP transport. Choices made
// here, all standard HTTP rather than invented headers:
//   Idempotency-Key   the §4.1 idempotencyKey (IETF draft-ietf-httpapi-
//                     idempotency-key-header). Absent => a fresh UUID, i.e. the
//                     request is NOT idempotent, which is exactly today's
//                     behaviour for every plan write.
//   If-Match          the §4.1 expectedTripVersion, as the integer aggregate
//                     version, optionally quoted like an ETag. Absent => no
//                     version check (§4.1 marks the field optional).
//   X-Trip-Version    RESPONSE header carrying the new aggregate version so a
//                     client can chain If-Match on its next write (§18.4
//                     "Clients may cache current version").
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const IF_MATCH_HEADER = "if-match";
export const TRIP_VERSION_RESPONSE_HEADER = "X-Trip-Version";

export type CommandEnvelopeHeaders =
  | { ok: true; idempotencyKey: string; expectedTripVersion: number | null }
  | { ok: false; message: string };

export function readCommandEnvelope(req: Request): CommandEnvelopeHeaders {
  const rawKey = req.get(IDEMPOTENCY_KEY_HEADER);
  let idempotencyKey: string;
  if (rawKey === undefined || rawKey === "") {
    idempotencyKey = randomUUID();
  } else {
    const trimmed = rawKey.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      return { ok: false, message: "Idempotency-Key must be 1-200 characters" };
    }
    idempotencyKey = trimmed;
  }

  const rawMatch = req.get(IF_MATCH_HEADER);
  let expectedTripVersion: number | null = null;
  if (rawMatch !== undefined && rawMatch !== "") {
    const m = /^\s*(?:W\/)?"?(\d{1,15})"?\s*$/.exec(rawMatch);
    if (!m) {
      return { ok: false, message: "If-Match must be the trip's aggregate version as an integer" };
    }
    expectedTripVersion = Number(m[1]);
  }

  return { ok: true, idempotencyKey, expectedTripVersion };
}

export function setTripVersionHeader(res: Response, version: number): void {
  res.setHeader(TRIP_VERSION_RESPONSE_HEADER, String(version));
}

// ── §3.3's arrows, for the flag-off twin ─────────────────────────────────────
// The kernel refuses a status change out of `done`, `cancelled` or `skipped`
// (TRIP_PLAN_INVALID_TRANSITION: "§3.3 draws no arrow out of COMPLETED or
// CANCELLED"). A legacy write that copied the client's status into the column
// accepted every pair (census-trips TR48); the twin now asks this first, so
// no path — kernel or not — lets a finished plan become tentative again.
export const PLAN_TERMINAL_STATUSES = ["done", "cancelled", "skipped"] as const;

/** The refused arrow, or null when the patch carries no status or the change is allowed. */
export function planStatusTransitionRefused(
  from: string | null | undefined,
  to: string | null | undefined,
): { from: string; to: string } | null {
  if (to === undefined || to === null || !from) return null;
  if (to !== from && (PLAN_TERMINAL_STATUSES as readonly string[]).includes(from)) return { from, to };
  return null;
}

// ── Plan-status command mapping (§3.3) ───────────────────────────────────────
// A PATCH body carrying `status` is a state transition and gets the spec's
// command name for that transition; a body moving the item in time is
// MOVE_PLAN; anything else is UPDATE_PLAN. The function validates the
// transition itself (a `done` or `cancelled` item cannot change status).
export function planCommandTypeForPatch(patch: {
  status?: string;
  dayDate?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}): TripCommandType {
  if (patch.status !== undefined) {
    if (patch.status === "confirmed") return "CONFIRM_PLAN";
    if (patch.status === "cancelled") return "CANCEL_PLAN";
    if (patch.status === "done") return "COMPLETE_ACTIVITY";
    return "UPDATE_PLAN"; // -> tentative: §3.3 has no command for un-confirming
  }
  if (patch.dayDate !== undefined || patch.startsAt !== undefined || patch.endsAt !== undefined) {
    return "MOVE_PLAN";
  }
  return "UPDATE_PLAN";
}

// ── Execution ─────────────────────────────────────────────────────────────────

/**
 * Apply one command through public.trip_kernel_execute.
 *
 * `sc` MUST be the service client: the function is executable by service_role
 * only (2420 revokes it from anon and authenticated). supabase-js RESOLVES on a
 * database error, so `error` is read explicitly and becomes a counted
 * TRIP_KERNEL_UNAVAILABLE rejection rather than an empty result read as success.
 */

/**
 * The plan interval this command would LEAVE BEHIND, when that interval is
 * inverted; null otherwise.
 *
 * ADD_PLAN carries both endpoints in the payload, so its own pair is the
 * answer. The UPDATE family carries a PATCH, and the effective value of each
 * endpoint is the patch's when the patch names it and the stored row's
 * otherwise — which this function cannot see. So it judges only what it can:
 *
 *   • the patch names BOTH endpoints  → the merged interval IS the patch's, and
 *     an inversion here is certain. Refused.
 *   • the patch names ONE             → the other endpoint is whatever the row
 *     holds. Undecidable here, and NOT refused: guessing would reject a legal
 *     command. Migration 2750's CHECK catches it at the write, which is why the
 *     constraint is the guarantee and this is only the good error message.
 *
 * Stated rather than hidden, because "validated in TS" would otherwise read as
 * a stronger claim than it is.
 */
/**
 * §4.1 sensitive-domain boundary: the payload keys a trip command must not
 * carry, by name. Travel documents, health and payment instruments have their
 * own domains; a trip plan, proposal or note is not where they live. Matched
 * against every key at every depth, so a proposal's free-form payload_json is
 * held to the same line as a top-level field.
 */
export const SENSITIVE_DOMAIN_KEY = /^(passport(_?(number|no|id))?|document_number|national_id|id_number|ssn|tax_id|health|medical|diagnosis|allerg(y|ies)|medication|blood_type|card_number|cvv|cvc|iban|account_number)$/i;
const SENSITIVE_SCAN_DEPTH = 6;

/** The first sensitive-domain key found in `value`, or null. */
export function sensitiveDomainKey(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > SENSITIVE_SCAN_DEPTH) return null;
  if (Array.isArray(value)) { for (const v of value) { const k = sensitiveDomainKey(v, depth + 1); if (k) return k; } return null; }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_DOMAIN_KEY.test(k)) return k;
    const nested = sensitiveDomainKey(v, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function invertedPlanInterval(cmd: TripCommand): { starts: string; ends: string } | null {
  const p = (cmd.payload ?? {}) as Record<string, unknown>;
  const src = cmd.type === "ADD_PLAN" ? p : ((p.patch as Record<string, unknown> | undefined) ?? {});
  const starts = src.starts_at;
  const ends = src.ends_at;
  if (typeof starts !== "string" || typeof ends !== "string") return null;
  const a = Date.parse(starts);
  const b = Date.parse(ends);
  // An unparseable timestamp is the function's business, not this one's: it
  // returns TRIP_COMMAND_MALFORMED with the real SQLSTATE behind it.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b < a ? { starts, ends } : null;
}

export async function executeTripCommand(sc: any, cmd: TripCommand): Promise<TripKernelResult> {
  // §4.4, the plan-item half. The kernel FUNCTION already refuses an inverted
  // range on the TRIP (start_date > end_date, on create and on update, using the
  // merged value). A plan item's interval was never checked anywhere, so
  // ADD_PLAN and the UPDATE family would persist an item that ends before it
  // starts. Migration 2750 adds the CHECK that makes that impossible for ANY
  // writer; this is the typed refusal, so a caller gets a modelled
  // TRIP_TEMPORAL_RANGE_INVERTED instead of a raw 23514 surfacing as a 500.
  //
  // THE SPLIT IS REAL AND IS NOT PRETENDED AWAY: a service_role caller invoking
  // the RPC directly skips this and meets the constraint instead — a correct
  // outcome with a worse error. The check belongs inside trip_kernel_execute,
  // and every kernel change replaces that 700-line function in full, so it
  // should ride along with the next migration that replaces it for its own
  // reasons. Recorded in census-trips TR54.
  // §4.1 "the command service validates sensitive-domain boundaries". A trip
  // command carries trip state. A key that names a travel document number, a
  // health fact or a payment instrument belongs to another domain — documents,
  // safety, payments — each with its own routes and gates; here it is refused
  // BY NAME before the kernel sees it, rather than persisted into a plan's or a
  // proposal's payload_json where nothing would ever look for it again.
  // census-trips TR56: the boundary is a check now, not an accident of routing.
  const crossing = sensitiveDomainKey(cmd.payload);
  if (crossing) {
    countRejection("TRIP_COMMAND_SENSITIVE_DOMAIN");
    return {
      ok: false,
      reason: "TRIP_COMMAND_SENSITIVE_DOMAIN",
      detail: `payload key "${crossing}" belongs to a sensitive domain a trip command must not carry`,
      contractVersion: null,
    };
  }

  const inverted = invertedPlanInterval(cmd);
  if (inverted) {
    countRejection("TRIP_TEMPORAL_RANGE_INVERTED");
    return {
      ok: false,
      reason: "TRIP_TEMPORAL_RANGE_INVERTED",
      detail: `ends_at ${inverted.ends} is before starts_at ${inverted.starts}`,
      contractVersion: null,
    };
  }

  const p_command = {
    command_id: cmd.commandId,
    trip_id: cmd.tripId,
    actor_user_id: cmd.actorUserId ?? null,
    actor_role: cmd.actorRole ?? "user",
    expected_trip_version: cmd.expectedTripVersion ?? null,
    idempotency_key: cmd.idempotencyKey,
    type: cmd.type,
    payload: cmd.payload,
    client_observed_at: cmd.clientObservedAt ?? null,
    correlation_id: cmd.correlationId ?? null,
  };

  let data: any;
  let error: any;
  try {
    ({ data, error } = await sc.rpc("trip_kernel_execute", { p_command }));
  } catch (e) {
    error = e;
  }
  if (error || !data || typeof data !== "object") {
    countRejection("TRIP_KERNEL_UNAVAILABLE");
    return {
      ok: false,
      reason: "TRIP_KERNEL_UNAVAILABLE",
      detail: error?.message ?? "trip_kernel_execute returned no result",
      contractVersion: null,
    };
  }

  const contractVersion = data.contract_version == null ? null : Number(data.contract_version);

  if (data.ok === true) {
    return {
      ok: true,
      duplicate: Boolean(data.duplicate),
      version: Number(data.version),
      eventId: String(data.event_id),
      sequence: data.sequence == null ? null : Number(data.sequence),
      result: data.result,
      contractVersion,
    };
  }

  const reason = String(data.reason ?? "TRIP_KERNEL_UNAVAILABLE") as TripKernelReason;
  countRejection(reason);
  return {
    ok: false,
    reason,
    detail: data.detail == null ? undefined : String(data.detail),
    currentVersion: data.current_version == null ? undefined : Number(data.current_version),
    expectedVersion: data.expected_version == null ? undefined : Number(data.expected_version),
    from: data.from == null ? undefined : String(data.from),
    to: data.to == null ? undefined : String(data.to),
    currentRole: data.current_role == null ? undefined : String(data.current_role),
    contractVersion,
  };
}

// ── Rejection → HTTP ──────────────────────────────────────────────────────────
// Same envelope shape as lib/http.sendError ({ error, message }) plus the
// reason code, and the version fields on a conflict so the client can refetch
// and retry with a fresh If-Match (§18.3 "explicit conflict").
export function sendKernelRejection(
  res: Response,
  r: Extract<TripKernelResult, { ok: false }>,
  log?: { error: (obj: unknown, msg: string) => void },
): void {
  switch (r.reason) {
    case "TRIP_VERSION_CONFLICT":
      res.status(409).json({
        error: "conflict",
        message: "The trip changed since you last read it",
        reason: r.reason,
        currentVersion: r.currentVersion,
        expectedVersion: r.expectedVersion,
      });
      return;
    case "TRIP_PLAN_INVALID_TRANSITION":
      res.status(409).json({
        error: "invalid_state_transition",
        message: `A ${r.from ?? "finished"} plan item cannot become ${r.to ?? "something else"}`,
        reason: r.reason,
        from: r.from,
        to: r.to,
      });
      return;
    case "TRIP_LIFECYCLE_INVALID_TRANSITION":
      res.status(409).json({
        error: "invalid_state_transition",
        message: `A ${r.from ?? "finished"} trip cannot become ${r.to ?? "something else"}`,
        reason: r.reason,
        from: r.from,
        to: r.to,
      });
      return;
    case "TRIP_TEMPORAL_RANGE_INVERTED":
      res.status(400).json({ error: "invalid_payload", message: "end_date must be ≥ start_date", reason: r.reason });
      return;
    case "TRIP_IDENTITY_ALREADY_EXISTS":
      res.status(409).json({ error: "conflict", message: "A trip with this id already exists", reason: r.reason });
      return;
    case "TRIP_PARTICIPANT_ALREADY_EXISTS":
      res.status(409).json({ error: "conflict", message: "This user is already on the trip", reason: r.reason, currentRole: r.currentRole });
      return;
    case "TRIP_PARTICIPANT_NOT_FOUND":
      res.status(404).json({ error: "not_found", message: "Member not found on this trip", reason: r.reason });
      return;
    case "TRIP_PARTICIPANT_IS_OWNER":
      res.status(400).json({ error: "invalid_payload", message: "Cannot change or remove the trip owner", reason: r.reason });
      return;
    case "TRIP_PARTICIPANT_CAPACITY_REACHED":
      res.status(409).json({ error: "conflict", message: "This trip is full", reason: r.reason });
      return;
    case "TRIP_AUTH_NOT_CREW":
    case "TRIP_AUTH_NOT_OWNER":
    case "TRIP_AUTH_NOT_INVITED":
    case "TRIP_AUTH_NOT_HOST":
    case "TRIP_AUTH_NOT_LINK_HOLDER":
    case "TRIP_AUTH_NOT_ADMIN":
    case "TRIP_AUTH_ROLE_NOT_PERMITTED":
    case "TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN":
      res.status(403).json({ error: "forbidden", message: "Not permitted on this trip", reason: r.reason });
      return;
    case "TRIP_NOT_FOUND":
      res.status(404).json({ error: "not_found", message: "Trip not found", reason: r.reason });
      return;
    case "TRIP_PLAN_NOT_FOUND":
      res.status(404).json({ error: "not_found", message: "Plan item not found", reason: r.reason });
      return;
    case "TRIP_COMMAND_MALFORMED":
      res.status(400).json({ error: "invalid_payload", message: r.detail ?? "Invalid command", reason: r.reason });
      return;
    case "TRIP_COMMAND_UNKNOWN_TYPE":
      // A v2 command against a v1 function (2450 not applied where 2420 is):
      // the database is behind the code. Logged so an operator sees it.
      log?.error({ reason: r.reason, detail: r.detail, contractVersion: r.contractVersion }, "trip kernel refused the command type — database contract behind the code?");
      res.status(400).json({ error: "invalid_payload", message: r.detail ?? "Invalid command", reason: r.reason });
      return;
    case "TRIP_KERNEL_UNAVAILABLE":
    default:
      log?.error({ reason: r.reason, detail: r.detail }, "trip kernel unavailable");
      res.status(500).json({ error: "db_error", message: "Trip kernel unavailable", reason: "TRIP_KERNEL_UNAVAILABLE" });
      return;
  }
}
