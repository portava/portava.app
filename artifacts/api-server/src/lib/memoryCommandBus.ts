/**
 * Memory Command Bus — the command boundary for canonical Memory writes.
 *
 * Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §2   MemoryDomainService — "Canonical Memory commands, lifecycle, ownership,
 *        versioning, merge/split, audit."
 *   §5   State Machines and Lifecycle — the Memory lifecycle diagram.
 *   §17  Command Bus and Domain Events — "All canonical writes should cross an
 *        explicit command boundary for authorization, invariants, idempotency,
 *        audit, and downstream event generation." + the 17 command names, the
 *        14 domain-event names, and "Use an outbox pattern: canonical mutation
 *        and event-outbox insert occur in one database transaction."
 *   §19  "client-generated operation IDs and server-side idempotency"
 *   §23  canEditMemory / canPublishMemory — the capability each command needs.
 *   §24  "Operational logs must include memoryId, commandId, eventId, source
 *        version, engine version, reason codes, projection name, failure class."
 *
 * MEASURED STARTING POINT (census docs/architecture/census-highlights-memories.md
 * §17, and re-measured in this lane against routes/memories.ts):
 *   Eleven of §17's seventeen commands existed as ad-hoc REST writes with no
 *   command boundary, no idempotency key, no audit row and no outbox insert.
 *   `memory_event_outbox` had zero occurrences in the repository; no Memory
 *   write path emitted any of §17's fourteen domain events.
 *
 * WHAT THIS MODULE IS
 * ===================
 * The TypeScript half of the kernel. The database half is
 * public.memory_kernel_execute (migration 2710), which applies ONE command to
 * canonical state and writes the domain event, the outbox row, the idempotency
 * receipt and the command-audit row in the SAME transaction. supabase-js has no
 * transactions, so a single SQL function is the only way to make "state + event
 * + outbox + receipt + audit" atomic from this process — the same reasoning
 * migration 2420 records for the Trip Kernel, whose shape this follows
 * deliberately so the two kernels can be read against each other.
 *
 * Authorization is NOT here, and is not delegated to the database either. The
 * route/service runs its own check (owner === user.id, tagged === user.id, trip
 * owner) BEFORE issuing a command, exactly as it always has. The SQL function
 * re-checks the capability the command needs as defence in depth (§23 "service
 * roles performing projections must be scoped and audited"), so a caller that
 * skipped the pre-check is still refused — but that second check is coarser than
 * some route checks and is not a substitute for them.
 *
 * GATING, AND WHAT RUNS WITH THE FLAG OFF
 * =======================================
 * `memory_kernel_enabled` is seeded FALSE by 2710 and lib/featureFlags
 * .isFlagEnabled is fail-closed (absent row, unreadable table, thrown error =>
 * false). With the flag off, every write in routes/memories.ts is the direct
 * write it has always been — byte-identical on the wire — and the four kernel
 * tables stay empty. What is NOT gated, because it needs no table that does not
 * exist, is the §5 lifecycle guard below: `assertLifecycleTransition` runs on
 * every PATCH whether or not the kernel is on.
 *
 * DEGRADATION IS HONEST, NOT SILENT
 * =================================
 * With the flag ON and migration 2710 NOT applied, the RPC fails and
 * `executeMemoryCommand` returns MEMORY_KERNEL_UNAVAILABLE, which
 * `sendMemoryCommandRejection` turns into a 503. It never falls back to a direct
 * write, because a direct write is precisely the thing with no audit row and no
 * outbox insert: answering 201 from that path would be reporting success for a
 * command the system did not record. supabase-js RESOLVES on a database error,
 * so `error` is read explicitly on every call below; an unchecked `data` would
 * make a failed RPC indistinguishable from a rejected command.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ==================================
 *   * MERGE_MEMORY and SPLIT_MEMORY (§17) are NOT declared. There is no
 *     `memory_relations` table (§3.4) and no version chain to merge into, so a
 *     declared-but-unbacked command name would be a claim the code cannot keep.
 *     They stay NOT-BUILT and are reported as such.
 *   * The five Highlight commands (PIN/UNPIN/PUBLISH/HIDE_HIGHLIGHT,
 *     SET_RESURFACING_POLICY) are NOT declared here: routes/highlights.ts,
 *     routes/stories.ts and lib/highlightPermissions.ts belong to another lane,
 *     and a command whose handler this bus cannot write is not a boundary.
 *   * No outbox consumer and no projection worker (§18). Rows accumulate with
 *     `published_at IS NULL` until one exists. lib/memoryOutbox.ts defines the
 *     payload contract that worker will read and nothing more.
 *   * No aggregate version / optimistic concurrency (§19 H178). `memories` has
 *     no `current_version` column (§3.1) and adding one is a separate change.
 */
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "./featureFlags.js";
import { getServiceClient } from "./supabase.js";
import { MEMORY_EVENT_TYPES, type MemoryEventType } from "./memoryOutbox.js";

export const MEMORY_KERNEL_FLAG = "memory_kernel_enabled";

/** The contract version this module speaks (migration 2710). */
export const MEMORY_KERNEL_CONTRACT_VERSION = 1;

/** Flag read is fail-closed (lib/featureFlags.isFlagEnabled). */
export async function isMemoryKernelEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, MEMORY_KERNEL_FLAG);
}

/**
 * The SERVICE client when `memory_kernel_enabled` is TRUE, else null — and null
 * means "run the pre-kernel direct write exactly as before". The function is
 * executable by service_role only (2710), so a user-scoped client is never
 * handed back. No service client configured => null, the same fail-closed answer
 * as an unreadable flag.
 */
export async function memoryKernelClient(sc?: SupabaseClient | null): Promise<SupabaseClient | null> {
  const service = sc ?? getServiceClient();
  if (!service) return null;
  return (await isMemoryKernelEnabled(service)) ? service : null;
}

// ── §5 Memory lifecycle state machine ────────────────────────────────────────
//
// §5 draws:
//
//   CANDIDATE -> CONFIRMED -> ACTIVE -> ARCHIVED
//        |            |          |
//        v            v          v
//     REJECTED     MERGED     DELETED
//
// The database's vocabulary is older and smaller: `memories.state` is
// CHECK (state IN ('draft','published','archived','deleted','removed'))
// (docs/migrations/0067_memories.sql:22). Renaming that column is not this
// lane's to do — every read path in this repository filters on it — so the
// machine is expressed over the STORED vocabulary and the spec's states are
// carried alongside as the projection below. Both are exported: the guard runs
// on stored values, the event payload and the audit row carry the spec name, so
// a §18 consumer reads §5 vocabulary and never learns the legacy one.
//
//   draft      -> CANDIDATE   (not yet in the owner's browsable history)
//   published  -> ACTIVE
//   archived   -> ARCHIVED
//   deleted    -> DELETED
//   removed    -> DELETED     (moderation removal; terminal, see below)
//
// CONFIRMED has no stored counterpart: this product has no separate confirm
// step between draft and published, so the CANDIDATE -> CONFIRMED -> ACTIVE path
// is traversed by one command (CONFIRM_MEMORY) and emits memory.confirmed.
// REJECTED and MERGED have no stored counterpart either and no command reaches
// them (see "deliberately does not do" above).

export const MEMORY_STORED_STATES = ["draft", "published", "archived", "deleted", "removed"] as const;
export type MemoryStoredState = (typeof MEMORY_STORED_STATES)[number];

export const MEMORY_LIFECYCLE_STATES = [
  "CANDIDATE", "CONFIRMED", "ACTIVE", "ARCHIVED", "REJECTED", "MERGED", "DELETED",
] as const;
export type MemoryLifecycleState = (typeof MEMORY_LIFECYCLE_STATES)[number];

const STORED_TO_SPEC: Record<MemoryStoredState, MemoryLifecycleState> = {
  draft: "CANDIDATE",
  published: "ACTIVE",
  archived: "ARCHIVED",
  deleted: "DELETED",
  removed: "DELETED",
};

/**
 * The §5 lifecycle state for a stored `memories.state`.
 *
 * An UNKNOWN stored value does not become a plausible-looking 'CANDIDATE': it
 * returns null, and `assertLifecycleTransition` refuses every transition out of
 * a state it cannot name (§28.11 — never swallow a schema surprise into a
 * plausible answer). The CHECK constraint makes an unknown value impossible
 * today; it will not stay impossible if someone widens the constraint.
 */
export function lifecycleStateOf(stored: string | null | undefined): MemoryLifecycleState | null {
  if (stored == null) return null;
  return (STORED_TO_SPEC as Record<string, MemoryLifecycleState>)[stored] ?? null;
}

/**
 * TERMINAL states: §5 draws no arrow OUT of DELETED, REJECTED or MERGED.
 *
 * `removed` matters most here and is the one transition that is a live hole
 * rather than a tidiness point. It is the moderation-removal state
 * (services/media/MediaProjectionService.ts:744 excludes it from a user's own
 * counts alongside 'deleted'). `routes/memories.ts` gates its PATCH on
 * `.neq("state","deleted")` ONLY, so a `removed` row is readable by its owner
 * and, before this guard, a plain PATCH {"state":"published"} put
 * moderator-removed content back into the discovery feed. Stated honestly, as
 * migration 2551 states its own severity: NOTHING in this API server writes
 * `state='removed'` today (measured: the only writers of `memories` are the
 * create/patch/delete paths in routes/memories.ts, AccountDeletionService's
 * hard delete, and two src/scripts seeders), so the door is being closed before
 * the room is furnished rather than after a breach.
 */
const TERMINAL_STORED: ReadonlySet<string> = new Set(["deleted", "removed"]);

/**
 * The permitted transitions, keyed from -> to, over the STORED vocabulary.
 *
 * Read against §5 arrow by arrow:
 *   draft -> published     CANDIDATE -> CONFIRMED -> ACTIVE. One step here
 *                          because no CONFIRMED row shape exists.
 *   published -> archived  ACTIVE -> ARCHIVED. Drawn.
 *   published -> deleted   ACTIVE -> DELETED. Drawn.
 *   draft -> deleted       NOT drawn (§5's only arrow out of CANDIDATE is
 *                          REJECTED). Permitted anyway, and this is a judgment
 *                          call recorded rather than hidden: REJECTED has no
 *                          stored counterpart, and refusing it would leave a
 *                          user unable to delete their own unpublished draft —
 *                          §21 lists "Delete Memory" as an action on a Memory,
 *                          not on an ACTIVE Memory. Deleting a draft is the
 *                          product's REJECTED.
 *   archived -> published  NOT drawn. Permitted: §21 defines Archive as
 *                          "Retain canonical Memory; remove from normal
 *                          browsing UNLESS EXPLICITLY REQUESTED", which is a
 *                          reversible operation by construction, and §21 keeps
 *                          Archive and Delete as separate actions precisely so
 *                          that archiving is not a one-way door.
 *   archived -> deleted    NOT drawn. Permitted for the same reason: an
 *                          archived Memory that could never be deleted would
 *                          put §21's "Delete Memory" and D6 account-deletion
 *                          semantics out of the owner's reach.
 *   published -> draft     REFUSED. §5 draws no arrow back into CANDIDATE, and
 *                          §21 already names the operation that takes a Memory
 *                          out of normal browsing: Archive. Measured before
 *                          refusing it: `updateMemory` in
 *                          travel-buddy-standalone/src/services/memories.ts:382
 *                          has ZERO production callers in the client tree (only
 *                          a component test mocks it), so no shipped screen
 *                          performs this transition.
 *   archived -> draft      REFUSED, same arrow, same reason.
 *   anything -> removed    REFUSED here: `removed` is a moderation verdict and
 *                          the owner-facing PATCH schema does not accept it.
 *                          Named explicitly so widening the zod enum cannot
 *                          quietly hand an owner a moderation verb.
 *
 * A self-transition (published -> published) is a no-op and is permitted:
 * refusing it would turn a client that re-sends its whole form into an error.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  draft: new Set(["draft", "published", "deleted"]),
  published: new Set(["published", "archived", "deleted"]),
  archived: new Set(["archived", "published", "deleted"]),
  deleted: new Set<string>(),
  removed: new Set<string>(),
};

export type LifecycleVerdict =
  | { ok: true; from: MemoryStoredState; to: MemoryStoredState; fromState: MemoryLifecycleState; toState: MemoryLifecycleState }
  | { ok: false; reason: "MEMORY_LIFECYCLE_UNKNOWN_STATE" | "MEMORY_LIFECYCLE_TERMINAL" | "MEMORY_LIFECYCLE_INVALID_TRANSITION";
      from: string | null; to: string; fromState: MemoryLifecycleState | null; toState: MemoryLifecycleState | null };

/**
 * §5. Decide whether `from -> to` is a transition this Memory may make.
 *
 * Pure: no client, no flag, no table. It runs on every PATCH regardless of
 * whether the kernel is enabled, which is what makes H50 ("accepts any of
 * draft/published/archived on PATCH with no transition guard") false from the
 * moment this ships rather than from the moment migration 2710 is applied.
 */
export function assertLifecycleTransition(from: string | null | undefined, to: string): LifecycleVerdict {
  const fromState = lifecycleStateOf(from);
  const toState = lifecycleStateOf(to);
  if (from == null || fromState === null) {
    return { ok: false, reason: "MEMORY_LIFECYCLE_UNKNOWN_STATE", from: from ?? null, to, fromState: null, toState };
  }
  if (TERMINAL_STORED.has(from)) {
    return { ok: false, reason: "MEMORY_LIFECYCLE_TERMINAL", from, to, fromState, toState };
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed || !allowed.has(to) || toState === null) {
    return { ok: false, reason: "MEMORY_LIFECYCLE_INVALID_TRANSITION", from, to, fromState, toState };
  }
  return {
    ok: true,
    from: from as MemoryStoredState,
    to: to as MemoryStoredState,
    fromState,
    toState: toState,
  };
}

// ── §17 Command vocabulary ───────────────────────────────────────────────────
//
// Eleven of §17's seventeen names, plus one extension. Every name below either
// appears in §17 verbatim or is marked EXT with the gap it fills — the same
// discipline lib/tripKernel.ts applies to UPDATE_PLAN.

export const MEMORY_COMMAND_TYPES = [
  "CREATE_MEMORY",      // §17
  "CONFIRM_MEMORY",     // §17 — draft -> published
  "ARCHIVE_MEMORY",     // §17
  "DELETE_MEMORY",      // §17 — soft; §21's full deletion lifecycle is NOT built
  "ADD_MEDIA",          // §17
  "REMOVE_MEDIA",       // §17
  "ADD_PERSON",         // §17 — also the participant's own consent (approve)
  "REMOVE_PERSON",      // §17
  "CHANGE_PLACE",       // §17
  "CHANGE_VISIBILITY",  // §17
  "UPDATE_MEMORY",      // EXT — title/caption/times. §17 names no command for a
                        //       plain field edit; a PATCH that touches neither
                        //       lifecycle, place nor audience needs a name to
                        //       cross the boundary at all.
] as const;
export type MemoryCommandType = (typeof MEMORY_COMMAND_TYPES)[number];

/**
 * §17 names this bus does NOT declare, with the reason, so the gap is legible
 * from the code rather than only from the census. Exported because
 * src/test/memoryCommandBus.test.ts asserts the two lists are disjoint and
 * together cover §17's seventeen names — a declared-but-unhandled command type
 * would otherwise be caught only in production.
 */
export const MEMORY_COMMAND_TYPES_NOT_DECLARED = {
  MERGE_MEMORY: "no memory_relations table (§3.4) and no version chain to merge into",
  SPLIT_MEMORY: "same — nothing to split a Memory's evidence between",
  PIN_HIGHLIGHT: "routes/highlights.ts is owned by another lane",
  UNPIN_HIGHLIGHT: "routes/highlights.ts is owned by another lane",
  PUBLISH_HIGHLIGHT: "routes/stories.ts is owned by another lane",
  HIDE_HIGHLIGHT: "routes/highlights.ts is owned by another lane",
  SET_RESURFACING_POLICY: "no resurfacing-policy storage exists (§11 user controls are NOT-BUILT)",
} as const;

/** §17 command -> §17 domain event. Total over MEMORY_COMMAND_TYPES. */
export const COMMAND_EVENT: Readonly<Record<MemoryCommandType, MemoryEventType>> = {
  CREATE_MEMORY: "memory.created",
  CONFIRM_MEMORY: "memory.confirmed",
  ARCHIVE_MEMORY: "memory.archived",
  DELETE_MEMORY: "memory.deleted",
  // §17 has no memory.media_added / memory.person_added event. It has
  // memory.corrected, and §6/§9's correction vocabulary is exactly what a
  // change to a Memory's media, participant or place set is: an edit to the
  // canonical assertion. The event payload carries `command_type`, so a §18
  // consumer that needs the finer distinction reads it there rather than
  // inventing an event name the spec does not list.
  ADD_MEDIA: "memory.corrected",
  REMOVE_MEDIA: "memory.corrected",
  ADD_PERSON: "memory.corrected",
  REMOVE_PERSON: "memory.corrected",
  CHANGE_PLACE: "memory.corrected",
  UPDATE_MEMORY: "memory.corrected",
  CHANGE_VISIBILITY: "memory.visibility_changed",
};

/** §23's capability vocabulary, per command. Re-checked by the SQL function. */
export const COMMAND_CAPABILITY: Readonly<Record<MemoryCommandType, "none" | "owner" | "owner_or_participant">> = {
  CREATE_MEMORY: "none",
  CONFIRM_MEMORY: "owner",
  ARCHIVE_MEMORY: "owner",
  DELETE_MEMORY: "owner",
  ADD_MEDIA: "owner",
  REMOVE_MEDIA: "owner",
  CHANGE_PLACE: "owner",
  CHANGE_VISIBILITY: "owner",
  UPDATE_MEMORY: "owner",
  // §17 REMOVE_PERSON. See services/memory/MemoryDomainService.ts for the
  // spec citation; both the owner (canEditMemory, §23) and the tagged person
  // (consent withdrawal, §5 "only after participant consent") may issue it.
  ADD_PERSON: "owner_or_participant",
  REMOVE_PERSON: "owner_or_participant",
};

// ── Command envelope ─────────────────────────────────────────────────────────

export interface MemoryCommand {
  commandId: string;
  /** null only for CREATE_MEMORY, where the id is assigned by the function. */
  memoryId: string | null;
  actorUserId: string;
  idempotencyKey: string;
  type: MemoryCommandType;
  payload: Record<string, unknown>;
  clientObservedAt?: string | null;
  correlationId?: string | null;
}

export type MemoryKernelReason =
  | "MEMORY_COMMAND_MALFORMED"
  | "MEMORY_COMMAND_UNKNOWN_TYPE"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_ITEM_NOT_FOUND"
  | "MEMORY_TAG_NOT_FOUND"
  | "MEMORY_AUTH_NOT_OWNER"
  | "MEMORY_AUTH_NOT_PARTICIPANT"
  | "MEMORY_AUTH_IDEMPOTENCY_KEY_FOREIGN"
  | "MEMORY_IDEMPOTENCY_KEY_REUSED"
  | "MEMORY_LIFECYCLE_TERMINAL"
  | "MEMORY_LIFECYCLE_INVALID_TRANSITION"
  | "MEMORY_LIFECYCLE_UNKNOWN_STATE"
  | "MEMORY_KERNEL_UNAVAILABLE";

export type MemoryKernelResult =
  | {
      ok: true;
      /** true when the idempotency receipt answered instead of a new transition. */
      duplicate: boolean;
      memoryId: string;
      eventId: string;
      eventType: MemoryEventType;
      /** the ORIGINAL result body on a replay — not a freshly computed one. */
      result: any;
      contractVersion: number | null;
    }
  | {
      ok: false;
      reason: MemoryKernelReason;
      detail?: string;
      from?: string;
      to?: string;
      contractVersion: number | null;
    };

// ── §24 memory_command_rejected_total by reason ──────────────────────────────
// In-process counter, the shape lib/tripKernel.ts already established. No
// exporter exists in this codebase; readers are tests and, one day, whatever
// metrics endpoint the platform grows. §24 asks for reason codes in operational
// logs — this is the counted half; the logged half is sendMemoryCommandRejection.
const rejectedTotal: Record<string, number> = {};

export function readMemoryCommandRejectedTotal(): Readonly<Record<string, number>> {
  return { ...rejectedTotal };
}

/** Test hook. */
export function _resetMemoryCommandRejectedTotal(): void {
  for (const k of Object.keys(rejectedTotal)) delete rejectedTotal[k];
}

function countRejection(reason: string): void {
  rejectedTotal[reason] = (rejectedTotal[reason] ?? 0) + 1;
}

// ── HTTP envelope (§19) ──────────────────────────────────────────────────────
// §19: "client-generated operation IDs and server-side idempotency". The header
// is the IETF one (draft-ietf-httpapi-idempotency-key-header), the same choice
// lib/tripKernel.ts made, so a client speaks one dialect to both kernels.
//
// ABSENT KEY. A fresh UUID, i.e. the request is NOT idempotent — which is
// exactly what every Memory write does today, so a client that has never heard
// of the header keeps its current behaviour rather than acquiring a silent
// dedup window keyed on something it did not choose.
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export type MemoryCommandEnvelope =
  | { ok: true; idempotencyKey: string; clientGenerated: boolean }
  | { ok: false; message: string };

export function readMemoryCommandEnvelope(req: Request): MemoryCommandEnvelope {
  const raw = req.get(IDEMPOTENCY_KEY_HEADER);
  if (raw === undefined || raw === "") {
    return { ok: true, idempotencyKey: randomUUID(), clientGenerated: false };
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    return { ok: false, message: "Idempotency-Key must be 1-200 characters" };
  }
  return { ok: true, idempotencyKey: trimmed, clientGenerated: true };
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Apply one command through public.memory_kernel_execute.
 *
 * `sc` MUST be the service client: 2710 revokes EXECUTE from anon and
 * authenticated.
 *
 * THE ONE THING THIS FUNCTION MUST NOT DO is emit an event of its own. There is
 * exactly one RPC call and no second write anywhere in this module: the event,
 * the outbox row, the receipt and the audit row are the SQL function's, inside
 * its transaction (§17 "canonical mutation and event-outbox insert occur in one
 * database transaction"). A `void sc.from('memory_event_outbox').insert(...)`
 * here would be worse than nothing — measured this session, a PostgrestBuilder
 * with no `.then`/`.catch`/`await` issues ZERO HTTP requests, so such a line
 * would emit nothing at all while reading as an emit. src/test/memoryOutbox
 * .test.ts asserts statically that no such line exists in this lane's files.
 */
export async function executeMemoryCommand(sc: any, cmd: MemoryCommand): Promise<MemoryKernelResult> {
  const p_command = {
    command_id: cmd.commandId,
    memory_id: cmd.memoryId,
    actor_user_id: cmd.actorUserId,
    idempotency_key: cmd.idempotencyKey,
    type: cmd.type,
    payload: cmd.payload,
    client_observed_at: cmd.clientObservedAt ?? null,
    correlation_id: cmd.correlationId ?? null,
  };

  let data: any;
  let error: any;
  try {
    ({ data, error } = await sc.rpc("memory_kernel_execute", { p_command }));
  } catch (e) {
    // supabase-js RESOLVES on a database error, so this catch is for a thrown
    // transport/config failure only. It is not dead code the way a try/catch
    // around a `.from()` read would be: `sc.rpc` is not guaranteed to exist on
    // every client shape this process constructs.
    error = e;
  }
  if (error || !data || typeof data !== "object") {
    countRejection("MEMORY_KERNEL_UNAVAILABLE");
    return {
      ok: false,
      reason: "MEMORY_KERNEL_UNAVAILABLE",
      detail: error?.message ?? "memory_kernel_execute returned no result",
      contractVersion: null,
    };
  }

  const contractVersion = data.contract_version == null ? null : Number(data.contract_version);

  if (data.ok === true) {
    const eventType = String(data.event_type ?? "");
    return {
      ok: true,
      duplicate: Boolean(data.duplicate),
      memoryId: String(data.memory_id),
      eventId: String(data.event_id),
      eventType: (MEMORY_EVENT_TYPES as readonly string[]).includes(eventType)
        ? (eventType as MemoryEventType)
        : COMMAND_EVENT[cmd.type],
      result: data.result,
      contractVersion,
    };
  }

  const reason = String(data.reason ?? "MEMORY_KERNEL_UNAVAILABLE") as MemoryKernelReason;
  countRejection(reason);
  return {
    ok: false,
    reason,
    detail: data.detail == null ? undefined : String(data.detail),
    from: data.from == null ? undefined : String(data.from),
    to: data.to == null ? undefined : String(data.to),
    contractVersion,
  };
}

// ── Rejection → HTTP ─────────────────────────────────────────────────────────
// Same envelope shape as lib/http.sendError ({ error, message }) plus the §24
// reason code. The status codes are chosen so a caller can tell "you may not"
// from "you may, but not from here" from "the kernel is not there".

export function sendMemoryCommandRejection(
  res: Response,
  r: Extract<MemoryKernelResult, { ok: false }>,
  log?: { error: (obj: unknown, msg: string) => void },
): void {
  switch (r.reason) {
    case "MEMORY_LIFECYCLE_INVALID_TRANSITION":
      res.status(409).json({
        error: "invalid_state_transition",
        message: `A ${describeState(r.from)} memory cannot become ${describeState(r.to)}`,
        reason: r.reason,
        from: r.from,
        to: r.to,
      });
      return;
    case "MEMORY_LIFECYCLE_TERMINAL":
      res.status(409).json({
        error: "invalid_state_transition",
        message: `A ${describeState(r.from)} memory cannot change state`,
        reason: r.reason,
        from: r.from,
        to: r.to,
      });
      return;
    case "MEMORY_LIFECYCLE_UNKNOWN_STATE":
      // Not a user error: the row holds a state this build cannot name.
      log?.error({ reason: r.reason, from: r.from, to: r.to },
        "memory kernel: stored lifecycle state is outside the known vocabulary — refusing the transition");
      res.status(409).json({
        error: "invalid_state_transition",
        message: "This memory is in a state this server does not recognise",
        reason: r.reason,
      });
      return;
    case "MEMORY_AUTH_NOT_OWNER":
    case "MEMORY_AUTH_NOT_PARTICIPANT":
    case "MEMORY_AUTH_IDEMPOTENCY_KEY_FOREIGN":
      res.status(403).json({ error: "forbidden", message: "Not permitted on this memory", reason: r.reason });
      return;
    case "MEMORY_IDEMPOTENCY_KEY_REUSED":
      // The actor already used this key for a DIFFERENT command. Returning the
      // stored result would answer a question the caller did not ask, and
      // applying the new command would make the key meaningless. 409, and the
      // client picks a new key. §19's operation ids are per-operation.
      res.status(409).json({
        error: "conflict",
        message: "This Idempotency-Key was already used for a different command",
        reason: r.reason,
      });
      return;
    case "MEMORY_NOT_FOUND":
      res.status(404).json({ error: "not_found", message: "Memory not found", reason: r.reason });
      return;
    case "MEMORY_ITEM_NOT_FOUND":
      res.status(404).json({ error: "not_found", message: "Item not found", reason: r.reason });
      return;
    case "MEMORY_TAG_NOT_FOUND":
      res.status(404).json({ error: "not_found", message: "Tag not found", reason: r.reason });
      return;
    case "MEMORY_COMMAND_MALFORMED":
      res.status(400).json({ error: "invalid_payload", message: r.detail ?? "Invalid command", reason: r.reason });
      return;
    case "MEMORY_COMMAND_UNKNOWN_TYPE":
      log?.error({ reason: r.reason, detail: r.detail, contractVersion: r.contractVersion },
        "memory kernel refused the command type — database contract behind the code?");
      res.status(400).json({ error: "invalid_payload", message: r.detail ?? "Invalid command", reason: r.reason });
      return;
    case "MEMORY_KERNEL_UNAVAILABLE":
    default:
      // 503, not 500, and NOT a fallback to a direct write. The flag says the
      // kernel is the write path; if the kernel is not there, the command was
      // not recorded and saying otherwise would be the lie this lane exists to
      // remove. Retryable, and the idempotency key makes the retry safe.
      log?.error({ reason: r.reason, detail: r.detail }, "memory kernel unavailable — command not applied");
      res.status(503).json({
        error: "kernel_unavailable",
        message: "The memory command service is unavailable. Please try again.",
        reason: "MEMORY_KERNEL_UNAVAILABLE",
      });
      return;
  }
}

function describeState(stored: string | undefined): string {
  if (!stored) return "finished";
  const spec = lifecycleStateOf(stored);
  return spec ? spec.toLowerCase() : stored;
}
