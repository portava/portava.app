/**
 * MemoryDomainService — §2's first bounded service.
 *
 * Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §2   "MemoryDomainService — Canonical Memory commands, lifecycle, ownership,
 *         versioning, merge/split, audit." and the reason the split exists:
 *         "A single all-purpose MemoryService would become a high-risk coupling
 *         point between media, AI, privacy, profile rendering, and indexing."
 *   §5   Memory lifecycle.
 *   §10  "Being tagged or referenced does not make another user a co-owner."
 *   §17  Command bus, domain events, outbox.
 *   §21  Archive / Delete are different operations.
 *   §23  canEditMemory(userId, memoryId); "Participant membership alone does not
 *        grant full Memory access."
 *   §24  the operational log fields.
 *   Appendix A step 7: "User opens candidate, REMOVES ONE PARTICIPANT, corrects
 *        one place, and confirms." (spec .txt line 776)
 *
 * MEASURED STARTING POINT: census H6 — "`routes/memories.ts` is a CRUD router:
 * no lifecycle guard, no versioning, no merge/split, no audit". There was no
 * MemoryDomainService; the business rules were inline in eleven route handlers.
 *
 * WHAT THIS SERVICE OWNS
 * ======================
 * The decision. Every function below answers "may this actor apply this command
 * to this Memory, and what is the resulting state?" and then applies it through
 * ONE path: the kernel RPC when `memory_kernel_enabled` is on, the pre-existing
 * direct write when it is off. The route above it validates the payload,
 * establishes the actor, and renders the result. It contains no rule.
 *
 * WHAT IT DOES NOT OWN
 * ====================
 * Read-side privacy (canReadMemory, the Hidden-Gem coarsening, the block set)
 * stays in routes/memories.ts. §2 puts that in MemoryPrivacyService, which is
 * NOT-BUILT; moving read policy here would recreate the all-purpose service §2
 * exists to prevent. Notifications stay in the route for the same reason.
 *
 * THE AUDIT WHEN THERE IS NO AUDIT TABLE
 * ======================================
 * §17 wants an audit row per command; migration 2710 creates
 * `memory_command_audit` and this lane may not apply it. With the kernel flag
 * OFF there is no table, so `auditCommand` writes the §24 field set to the
 * operational log with `durable:false` on it. That is deliberately not the same
 * as skipping the audit: an operator reading the log can tell a command that was
 * recorded from one that was only logged, and neither is invisible. What the
 * code never does is answer success while claiming an audit that did not happen.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertLifecycleTransition,
  executeMemoryCommand,
  lifecycleStateOf,
  memoryKernelClient,
  COMMAND_EVENT,
  type MemoryCommandType,
  type MemoryKernelResult,
} from "../../lib/memoryCommandBus.js";
import { logger } from "../../lib/logger.js";

// ── Result shape ─────────────────────────────────────────────────────────────

/** A refusal the command bus already has an HTTP mapping for. */
export type CommandRejection = Extract<MemoryKernelResult, { ok: false }>;

/**
 * A refusal that is not command-shaped (payload, plumbing, storage).
 *
 * NO `status` FIELD, deliberately. lib/http.sendError derives the HTTP status
 * from the code alone (`STATUS[code]`), so a status carried here would be a
 * number that looks authoritative and that nothing reads — the kind of field
 * that later gets "fixed" to something the wire never honoured. The code IS the
 * status.
 */
export interface CommandHttpError {
  code: string;
  message: string;
  exposeDetail?: boolean;
}

export type CommandOutcome<T> =
  | { ok: true; body: T; duplicate: boolean; commandId: string; eventId: string | null; idempotencyKey: string }
  | { ok: false; rejection: CommandRejection }
  | { ok: false; http: CommandHttpError };

const notFound = (what: string): { ok: false; http: CommandHttpError } =>
  ({ ok: false, http: { code: "not_found", message: `${what} not found` } });

const dbError = (message: string): { ok: false; http: CommandHttpError } =>
  ({ ok: false, http: { code: "db_error", message } });

const reject = (
  reason: CommandRejection["reason"],
  extra: Partial<CommandRejection> = {},
): { ok: false; rejection: CommandRejection } =>
  ({ ok: false, rejection: { ok: false, reason, contractVersion: null, ...extra } as CommandRejection });

// ── §24 audit ────────────────────────────────────────────────────────────────

export interface CommandAudit {
  commandId: string;
  commandType: MemoryCommandType;
  memoryId: string | null;
  actorUserId: string;
  idempotencyKey: string;
  outcome: "accepted" | "duplicate" | "rejected";
  reason?: string;
  eventId?: string | null;
  /** false when only the operational log holds this row (kernel flag off). */
  durable: boolean;
}

/**
 * §24: "Operational logs must include memoryId, commandId, eventId, source
 * version, engine version, reason codes, projection name, and failure class.
 * Do not log sensitive raw content unless strictly necessary."
 *
 * Nothing from the Memory's body reaches this line — ids, the command name, the
 * outcome and the reason code only.
 */
export function auditCommand(a: CommandAudit): void {
  const line = {
    memoryId: a.memoryId,
    commandId: a.commandId,
    eventId: a.eventId ?? null,
    commandType: a.commandType,
    actorUserId: a.actorUserId,
    idempotencyKey: a.idempotencyKey,
    outcome: a.outcome,
    reason: a.reason ?? null,
    engineVersion: "memory-kernel/1",
    durable: a.durable,
  };
  if (a.outcome === "rejected") logger.warn(line, "memory command rejected");
  else logger.info(line, "memory command applied");
}

// ── Command selection for a PATCH (§17) ──────────────────────────────────────

/**
 * Which §17 command a PATCH body is.
 *
 * Order matters and encodes precedence, not convenience: a body that changes
 * lifecycle IS a lifecycle command whatever else it carries, because §5's
 * machine is the invariant that must be checked; a body that changes the
 * audience is CHANGE_VISIBILITY because §10's publication policy is the next
 * strongest invariant; a body that moves the Memory in space is CHANGE_PLACE
 * (§9 entity resolution, and `place_correction_rate` is a §24 metric that only
 * means anything if place edits are countable); everything else is the EXT
 * UPDATE_MEMORY. Pure — no client, no flag.
 */
export function commandTypeForPatch(patch: {
  state?: string;
  visibility?: unknown;
  allowedUserIds?: unknown;
  hiddenUserIds?: unknown;
  locationPrecision?: unknown;
  placeId?: unknown;
  canonicalLocationId?: unknown;
  locationCity?: unknown;
  locationCountry?: unknown;
  locationLat?: unknown;
  locationLng?: unknown;
}): MemoryCommandType {
  if (patch.state !== undefined) {
    if (patch.state === "archived") return "ARCHIVE_MEMORY";
    if (patch.state === "published") return "CONFIRM_MEMORY";
    return "UPDATE_MEMORY"; // -> draft: refused by the machine, named honestly
  }
  if (patch.visibility !== undefined || patch.allowedUserIds !== undefined
      || patch.hiddenUserIds !== undefined || patch.locationPrecision !== undefined) {
    return "CHANGE_VISIBILITY";
  }
  if (patch.placeId !== undefined || patch.canonicalLocationId !== undefined
      || patch.locationCity !== undefined || patch.locationCountry !== undefined
      || patch.locationLat !== undefined || patch.locationLng !== undefined) {
    return "CHANGE_PLACE";
  }
  return "UPDATE_MEMORY";
}

// ── §23 canEditMemory ────────────────────────────────────────────────────────

export interface MemoryOwnershipRow { id: string; owner_id: string; state: string }

/**
 * Load the Memory this command acts on, or say why not.
 *
 * `state` is selected because §5's guard needs the CURRENT state and a guard
 * that reads the state it is about to write is not a guard. The read filters
 * `state != 'deleted'` exactly as the pre-existing handlers did, so a deleted
 * Memory is 404 rather than a terminal-transition refusal — the two are
 * different answers and the pre-existing one is the one clients depend on.
 *
 * supabase-js RESOLVES on a database error, so `error` is bound: an unreadable
 * `memories` table is a 500, not "Memory not found" (§28.11).
 */
export async function loadMemoryForCommand(
  sc: SupabaseClient | any,
  memoryId: string,
): Promise<{ ok: true; row: MemoryOwnershipRow } | { ok: false; http: CommandHttpError }> {
  const { data, error } = await sc
    .from("memories")
    .select("id, owner_id, state")
    .eq("id", memoryId)
    .neq("state", "deleted")
    .maybeSingle();
  if (error) return dbError(error.message ?? "memories read failed");
  if (!data) return notFound("Memory");
  return { ok: true, row: data as MemoryOwnershipRow };
}

// ── §5 lifecycle ─────────────────────────────────────────────────────────────

/**
 * Guard a lifecycle transition. Returns the §5 spec-vocabulary pair on success
 * so the caller can put it in the event payload without re-deriving it.
 */
export function guardLifecycle(
  from: string,
  to: string | undefined,
): { ok: true; fromState: string | null; toState: string | null } | { ok: false; rejection: CommandRejection } {
  if (to === undefined) return { ok: true, fromState: lifecycleStateOf(from), toState: lifecycleStateOf(from) };
  const verdict = assertLifecycleTransition(from, to);
  if (!verdict.ok) {
    return reject(verdict.reason, { from: verdict.from ?? undefined, to: verdict.to });
  }
  return { ok: true, fromState: verdict.fromState, toState: verdict.toState };
}

// ── §17 REMOVE_PERSON / ADD_PERSON authorization ─────────────────────────────

/**
 * WHO MAY CHANGE A MEMORY'S PARTICIPANT SET.
 *
 * MEASURED DEFECT (census §17, `routes/memories.ts` PATCH
 * /memories/:id/tags/:userId): the handler opened with
 *
 *     if (userId !== user.id) { sendError(res, "forbidden", ...); return; }
 *
 * so ONLY the tagged user could act, and the Memory's OWNER could not remove a
 * person from their own Memory at all. There was no other route that could:
 * participants are inserted at create time from `taggedUserIds` and never
 * removed by the owner thereafter.
 *
 * WHAT THE SPEC SAYS, LINE BY LINE (spec .txt line numbers):
 *
 *   776  Appendix A, the canonical walkthrough: "User opens candidate, REMOVES
 *        ONE PARTICIPANT, corrects one place, and confirms." The user in that
 *        sentence is the Memory's owner — steps 6 and 7 are the owner reviewing
 *        their own AUTO_PRIVATE candidate. Removing a participant is an owner
 *        operation the spec walks through end to end.
 *   610  §23 policy functions include `canEditMemory(userId, memoryId)`; 597
 *        "Owner-only access to canonical private Memory facts by default." The
 *        participant set is a canonical Memory fact.
 *   338  §10: "Being tagged or referenced does not make another user a
 *        co-owner." The tagged person's presence does not create a veto over
 *        the owner's edit right.
 *   599  §23: "Participant membership alone does not grant full Memory access."
 *        The converse of the same rule.
 *   226  §5: a shared object exists "only after participant consent". Consent
 *        is the tagged person's to give and to withdraw, so their own
 *        approve/remove right is unchanged and is NOT the owner's to exercise.
 *
 * THE RULE THIS ENCODES:
 *   REMOVE_PERSON  — the OWNER may (canEditMemory, line 776) and the TAGGED
 *                    PERSON may (consent withdrawal, line 226).
 *   ADD_PERSON as consent ("approve") — the TAGGED PERSON ONLY. The owner may
 *                    not approve a tag on someone's behalf: line 226 makes the
 *                    approval the participant's act, and an owner who could
 *                    self-approve would turn "tagged" into "consented" without
 *                    the person, which is the one thing §5 forbids by name.
 *
 * Blocking is NOT consulted here. Whether a block should also let the blocker
 * strip themselves from a blocker's Memory is a privacy-policy question §11
 * does not answer, it belongs to MemoryPrivacyService, and the tagged person
 * can already remove themselves — so nothing is lost by leaving it alone.
 */
export function authorizeParticipantCommand(
  command: "ADD_PERSON" | "REMOVE_PERSON",
  actorUserId: string,
  memoryOwnerId: string,
  taggedUserId: string,
): { ok: true; actorRole: "owner" | "participant" } | { ok: false; rejection: CommandRejection } {
  const isParticipant = actorUserId === taggedUserId;
  const isOwner = actorUserId === memoryOwnerId;

  if (command === "ADD_PERSON") {
    // Consent. The participant only — see line 226 above.
    if (isParticipant) return { ok: true, actorRole: "participant" };
    return reject("MEMORY_AUTH_NOT_PARTICIPANT", {
      detail: "Only the tagged person can approve their own tag",
    });
  }

  if (isParticipant) return { ok: true, actorRole: "participant" };
  if (isOwner) return { ok: true, actorRole: "owner" };
  return reject("MEMORY_AUTH_NOT_OWNER", {
    detail: "Only the memory's owner or the tagged person can remove a tag",
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export interface DispatchInput<T> {
  sc: SupabaseClient | any;
  commandType: MemoryCommandType;
  memoryId: string | null;
  actorUserId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  /**
   * The pre-kernel direct write, run ONLY when `memory_kernel_enabled` is off.
   * It is the code that shipped before this lane, moved verbatim, so the
   * flag-off behaviour is byte-identical to what it was.
   */
  legacy: () => Promise<{ ok: true; body: T } | { ok: false; http: CommandHttpError }>;
  /** Turn the kernel's `result` jsonb into the route's response body. */
  fromKernelResult?: (result: any) => T;
}

/**
 * Run one command.
 *
 * KERNEL ON  — one RPC. State, event, outbox row, idempotency receipt and audit
 *              row are the function's, in one transaction (§17). A replay of the
 *              same key returns the ORIGINAL result from the receipt; this code
 *              cannot recompute it and does not try.
 * KERNEL OFF — the legacy direct write, and an audit line marked
 *              `durable:false`. No event is emitted, and nothing here pretends
 *              one was: `eventId` is null in the outcome.
 *
 * There is NO third path. If the flag is on and the function is missing, the
 * result is MEMORY_KERNEL_UNAVAILABLE and the caller renders a 503 — it does
 * not silently fall back to the unaudited write, because the whole point of the
 * boundary is that a command the system did not record is not a success.
 */
export async function dispatchMemoryCommand<T>(input: DispatchInput<T>): Promise<CommandOutcome<T>> {
  const commandId = randomUUID();
  const kernel = await memoryKernelClient(input.sc);

  if (!kernel) {
    const legacy = await input.legacy();
    if (!legacy.ok) {
      auditCommand({
        commandId, commandType: input.commandType, memoryId: input.memoryId,
        actorUserId: input.actorUserId, idempotencyKey: input.idempotencyKey,
        outcome: "rejected", reason: legacy.http.code, durable: false,
      });
      return legacy;
    }
    auditCommand({
      commandId, commandType: input.commandType, memoryId: input.memoryId,
      actorUserId: input.actorUserId, idempotencyKey: input.idempotencyKey,
      outcome: "accepted", eventId: null, durable: false,
    });
    return { ok: true, body: legacy.body, duplicate: false, commandId, eventId: null, idempotencyKey: input.idempotencyKey };
  }

  const result = await executeMemoryCommand(kernel, {
    commandId,
    memoryId: input.memoryId,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    type: input.commandType,
    payload: input.payload,
  });

  if (!result.ok) {
    auditCommand({
      commandId, commandType: input.commandType, memoryId: input.memoryId,
      actorUserId: input.actorUserId, idempotencyKey: input.idempotencyKey,
      outcome: "rejected", reason: result.reason,
      // The kernel wrote its own audit row for every rejection it evaluated.
      // MEMORY_KERNEL_UNAVAILABLE is the one reason where it did not, because
      // the function never ran — that one is log-only and says so.
      durable: result.reason !== "MEMORY_KERNEL_UNAVAILABLE",
    });
    return { ok: false, rejection: result };
  }

  auditCommand({
    commandId, commandType: input.commandType, memoryId: result.memoryId,
    actorUserId: input.actorUserId, idempotencyKey: input.idempotencyKey,
    outcome: result.duplicate ? "duplicate" : "accepted", eventId: result.eventId, durable: true,
  });

  const body = input.fromKernelResult
    ? input.fromKernelResult(result.result)
    : (result.result as T);

  return {
    ok: true,
    body,
    duplicate: result.duplicate,
    commandId,
    eventId: result.eventId,
    idempotencyKey: input.idempotencyKey,
  };
}

/** The §17 event a command produces. Re-exported so routes need one import. */
export { COMMAND_EVENT };
