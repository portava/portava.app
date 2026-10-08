/**
 * ADMIN_RESTORE_PARTICIPANT — the command contract, and nothing else.
 *
 * WHAT THIS IS
 * ============
 * `resolveAppeal`'s `trip_membership` case cannot restore a removed member:
 * REMOVE_PARTICIPANT DELETEs the `trip_members` row, so putting the member back
 * is an INSERT. No existing Trip Kernel command can carry it —
 *   • ADD_PARTICIPANT's capability is `host` (migration 2500) and the actor here
 *     is a MODERATOR, not a host of that trip;
 *   • 2450 pins actor_role to the command's family and the admin family
 *     contains exactly one command, ADMIN_HIDE_TRIP.
 * So the command must be new, which needs a migration replacing
 * `trip_kernel_execute`, which this lane does not own and must not write.
 *
 * This file is therefore the SHAPE ONLY: the input contract, the authorization
 * scaffold, the refusal codes, and an executor that REFUSES. It exists so the
 * eventual implementation has a fixed contract to satisfy and so that every
 * call site written against it today gets a refusal rather than a stub that
 * quietly does nothing — the exact failure mode the appeal defect was.
 *
 * WHY IT REFUSES — AND WHY IT CANNOT BE MADE TO ACCEPT
 * ===================================================
 * `restoration_role` is the whole problem. What role does a removed member come
 * back as? Their role at removal (which nothing records once the row is gone)?
 * `member`, demoting a removed co-host? Does the crew cap still apply, and if
 * the trip is full does the restoration fail or evict someone? That is the OPEN
 * owner decision APPEAL_RESTORE_SEMANTICS. It is NOT resolved here.
 *
 * The consequence for the validator is exact and worth being blunt about:
 *
 *     APPROVED_RESTORATION_ROLES is EMPTY, so `isApprovedRestorationRole`
 *     returns false for EVERY value, including 'member'.
 *
 * A validator that accepted `member`, or any non-empty allowlist, would BE the
 * owner decision — made in a helper function, by an engineer, without anyone
 * deciding it. An empty allowlist is not a placeholder; it is the truthful
 * statement that zero roles are approved today. When the decision lands, the
 * change is to add the approved value(s) here and to implement `execute`, and
 * every test below that asserts refusal will fail loudly and demand review —
 * which is the point.
 *
 * NOTHING IN THIS FILE WRITES. There is no `.insert(`, no `.update(`, no
 * `.delete(` and no `executeTripCommand` call: a contract that refuses cannot
 * half-perform a restoration on the way to refusing.
 */

import { z } from "zod";
import { isAdmin } from "../../lib/requireAdmin.js";
import { RESTORE_SEMANTICS_DECISION } from "./resolveAppeal.js";
import { ROLE_AT_REMOVAL_SOURCE, type RoleAtRemoval } from "./roleAtRemoval.js";

/** The command name, so call sites and audit rows spell it one way. */
export const ADMIN_RESTORE_PARTICIPANT = "ADMIN_RESTORE_PARTICIPANT" as const;

// ── Input contract ───────────────────────────────────────────────────────────

/**
 * Snake_case because this is a COMMAND ENVELOPE, matching the Trip Kernel's
 * wire shape (§4.1) and the migration that will eventually accept it — not an
 * HTTP body and not an internal TypeScript call.
 *
 * `restoration_role` and `restoration_source` are typed as plain strings ON
 * PURPOSE. Typing them as an enum of "allowed" roles would let the type system
 * imply an approved set that does not exist, and would move the refusal from a
 * reviewable runtime decision into a silent compile-time one.
 */
export const AdminRestoreParticipantSchema = z.object({
  /** The trip whose membership row is to be re-created. */
  trip_id: z.string().uuid(),
  /** The removed member. */
  user_id: z.string().uuid(),
  /** The upheld appeal this restoration discharges. */
  appeal_id: z.string().uuid(),
  /** The admin issuing it. Always from a verified token, never from a body. */
  admin_actor: z.string().uuid(),
  /** Free text for the audit trail; a restoration with no stated reason is not auditable. */
  reason: z.string().min(10).max(2000),
  /** The role the member would come back as. NO value is approved — see above. */
  restoration_role: z.string().min(1).max(64),
  /** Where that role came from: e.g. the removal record, a policy default, an operator's choice. */
  restoration_source: z.string().min(1).max(64),
  /** Optimistic concurrency against trips.version. null = no If-Match. */
  expected_version: z.number().int().nonnegative().nullable(),
  /** Replay guard. The same key must never restore twice. */
  idempotency_key: z.string().min(8).max(200),
});

export type AdminRestoreParticipantInput = z.infer<typeof AdminRestoreParticipantSchema>;

// ── Restoration role / source allowlists ─────────────────────────────────────

/**
 * THE OWNER'S RULING (2026-10-04, "Trips — Appeal restoration"), verbatim:
 * the decision this module waited on. It is TAKEN; what remains missing is the
 * Trip Kernel command that can carry the write (see `executeAdminRestoreParticipant`).
 */
export const APPEAL_RESTORE_RULING =
  "If an appeal succeeds, restore the access and permissions removed by that decision. Don't recreate missed " +
  "live activity or location sharing; if a trip has ended, restore access to its retained record only.";

/**
 * The roles a restored participant may be given: exactly the role the removal
 * took away, as durably recorded by the kernel's REMOVE_PARTICIPANT event
 * (roleAtRemoval.ts). `owner` is not here: an owner is not removed from their
 * own trip, so no appeal can be restoring one. Nothing outside the
 * `member_role` enum is here.
 */
export const APPROVED_RESTORATION_ROLES: readonly string[] = Object.freeze(["member", "co_host", "viewer", "invited"]);

/**
 * Where a restoration role may come from: the removal record ONLY. A policy
 * default ("member") or an operator's choice would restore something other than
 * "the access and permissions removed by that decision".
 */
export const APPROVED_RESTORATION_SOURCES: readonly string[] = Object.freeze([ROLE_AT_REMOVAL_SOURCE]);

/** True only for a role the ruling can restore. */
export function isApprovedRestorationRole(role: string): boolean {
  return APPROVED_RESTORATION_ROLES.includes(role);
}

/** True only for the removal record. */
export function isApprovedRestorationSource(source: string): boolean {
  return APPROVED_RESTORATION_SOURCES.includes(source);
}

/** Trip statuses after which only the retained record is restored (tripStatus.ts: terminal or past). */
export const ENDED_TRIP_STATUSES: readonly string[] = Object.freeze(["completed", "archived", "cancelled"]);
export const LIVE_TRIP_STATUSES: readonly string[] = Object.freeze(["planning", "active"]);

/**
 * What an upheld trip-membership appeal restores, decided from the removal
 * record and the trip's status. Pure; reads nothing; writes nothing.
 *
 *   live trip   the membership, in the role at removal. Live features are NOT
 *               re-enabled: location sharing and live activity stay off until the
 *               person opts in again ("don't recreate missed live activity or
 *               location sharing") — `liveSharingRestored` is the literal false.
 *   ended trip  access to the trip's RETAINED RECORD only, in the role at removal.
 * Refusals name why: an unreadable ledger is retried, not answered; a removal
 * the ledger does not record restores nothing (there is nothing the decision
 * provably removed); a removal written before the kernel recorded roles needs a
 * person; an unknown trip status is not guessed.
 *
 * READING, STATED AS SUCH: the ruling does not mention the crew cap. Restoring
 * "the access removed by that decision" is read here as NOT subject to a cap
 * the person did not exceed when they were removed; this plan does not consult
 * it, and the lane report flags that reading for the owner.
 */
export type RestorationPlan =
  | {
      readonly restore: true;
      readonly access: "membership" | "retained_record_only";
      readonly role: string;
      readonly source: typeof ROLE_AT_REMOVAL_SOURCE;
      readonly removalEventId: string;
      readonly liveSharingRestored: false;
    }
  | {
      readonly restore: false;
      readonly reason: "removal_record_unreadable" | "no_removal_recorded" | "role_not_recorded" | "role_not_restorable" | "trip_status_unknown";
      readonly detail: string;
    };

export function planAppealRestoration(removal: RoleAtRemoval, tripStatus: string): RestorationPlan {
  if (!removal.found) {
    if (removal.reason === "LEDGER_UNREADABLE") return { restore: false, reason: "removal_record_unreadable", detail: removal.detail ?? "trip_events could not be read" };
    if (removal.reason === "NO_REMOVAL_EVENT") return { restore: false, reason: "no_removal_recorded", detail: "no trip.participant_removed event names this person on this trip" };
    return { restore: false, reason: "role_not_recorded", detail: removal.detail ?? removal.reason };
  }
  if (!isApprovedRestorationRole(removal.role)) {
    return { restore: false, reason: "role_not_restorable", detail: `role at removal '${removal.role}' is not a restorable member role` };
  }
  const access = ENDED_TRIP_STATUSES.includes(tripStatus) ? "retained_record_only" : LIVE_TRIP_STATUSES.includes(tripStatus) ? "membership" : null;
  if (access === null) return { restore: false, reason: "trip_status_unknown", detail: `trip status '${tripStatus}' is not one this ruling is applied to` };
  return { restore: true, access, role: removal.role, source: ROLE_AT_REMOVAL_SOURCE, removalEventId: removal.eventId, liveSharingRestored: false };
}

// ── Refusal codes ────────────────────────────────────────────────────────────

export type AdminRestoreRefusalCode =
  /** The envelope did not parse. */
  | "ADMIN_RESTORE_MALFORMED"
  /** The actor is not an admin, or admin status could not be established. */
  | "ADMIN_RESTORE_NOT_AUTHORIZED"
  /** The restoration role cannot be established under approved semantics. */
  | "ADMIN_RESTORE_ROLE_NOT_ESTABLISHED"
  /** No kernel command exists that can carry this write. */
  | "ADMIN_RESTORE_COMMAND_ABSENT";

export interface AdminRestoreRefused {
  ok: false;
  /** No restoration happened. Present and always false so no caller reads `ok` alone. */
  restored: false;
  code: AdminRestoreRefusalCode;
  reason: string;
  /** The open decision, when the refusal is a decision rather than a fault. */
  blockedOn: string | null;
}

/**
 * The success shape, declared so the eventual implementation has a target —
 * and never constructed by this file. There is no code path below that can
 * produce it.
 */
export interface AdminRestoreApplied {
  ok: true;
  restored: true;
  command: typeof ADMIN_RESTORE_PARTICIPANT;
  tripId: string;
  userId: string;
  role: string;
}

export type AdminRestoreResult = AdminRestoreApplied | AdminRestoreRefused;

function refuse(
  code: AdminRestoreRefusalCode,
  reason: string,
  blockedOn: string | null = null,
): AdminRestoreRefused {
  return { ok: false, restored: false, code, reason, blockedOn };
}

// ── Authorization scaffold ───────────────────────────────────────────────────

export interface AuthorizationOutcome {
  authorized: boolean;
  reason: string;
}

/**
 * Capability check for the command. Fails closed: `isAdmin` returns false on a
 * query error, a missing profile, and a non-admin role alike, and every one of
 * those lands here as "not authorized".
 *
 * This is a SCAFFOLD in one specific sense only — it is not yet the whole
 * check. A real ADMIN_RESTORE_PARTICIPANT will also need the kernel's own
 * actor_role gate (2450 pins actor_role to the command family) and, plausibly,
 * a narrower capability than "any admin". It is NOT a scaffold in the sense of
 * being permissive: nothing here grants access that `isAdmin` denies.
 */
export async function authorizeAdminRestoreParticipant(
  sc: any,
  adminActor: string,
): Promise<AuthorizationOutcome> {
  if (!sc) return { authorized: false, reason: "no service client" };
  let ok = false;
  try {
    ok = await isAdmin(sc, adminActor);
  } catch {
    // A thrown lookup is an unknown answer, and unknown is not permission.
    return { authorized: false, reason: "admin lookup failed" };
  }
  return ok
    ? { authorized: true, reason: "admin" }
    : { authorized: false, reason: "actor is not an admin" };
}

// ── Execution — refuses ──────────────────────────────────────────────────────

/**
 * Execute the command. It does not execute.
 *
 * Order matters and is fail-closed:
 *   1. shape        — a malformed envelope is rejected before anything else is
 *                     read from it;
 *   2. authorization— a non-admin is refused BEFORE the semantic refusal, so an
 *                     unauthorized caller learns nothing about restoration
 *                     policy and no un-admin'd call ever reaches step 3;
 *   3. semantics    — and here every remaining call refuses, because
 *                     `restoration_role` cannot be established while
 *                     APPEAL_RESTORE_SEMANTICS is open.
 *
 * Step 3 has no `else`. There is no combination of inputs, no flag, and no
 * caller that reaches a write.
 */
export async function executeAdminRestoreParticipant(
  sc: any,
  input: unknown,
): Promise<AdminRestoreRefused> {
  const parsed = AdminRestoreParticipantSchema.safeParse(input);
  if (!parsed.success) {
    return refuse(
      "ADMIN_RESTORE_MALFORMED",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }

  const cmd = parsed.data;

  const auth = await authorizeAdminRestoreParticipant(sc, cmd.admin_actor);
  if (!auth.authorized) {
    return refuse(
      "ADMIN_RESTORE_NOT_AUTHORIZED",
      `${ADMIN_RESTORE_PARTICIPANT} refused: ${auth.reason}`,
    );
  }

  // The role cannot be established. Not "is not in a list we happen to ship" —
  // there is no approved list, because the decision that would produce one has
  // not been made. Reporting the submitted value back is deliberate: an
  // operator must be able to see WHICH role was asked for when the decision is
  // finally taken.
  if (!isApprovedRestorationRole(cmd.restoration_role) ||
      !isApprovedRestorationSource(cmd.restoration_source)) {
    return refuse(
      "ADMIN_RESTORE_ROLE_NOT_ESTABLISHED",
      `${ADMIN_RESTORE_PARTICIPANT} refused for trip=${cmd.trip_id} user=${cmd.user_id} ` +
      `appeal=${cmd.appeal_id}: restoration_role='${cmd.restoration_role}' from ` +
      `restoration_source='${cmd.restoration_source}' is not what the ${RESTORE_SEMANTICS_DECISION} ruling restores ` +
      `(the role at removal, from the removal record — planAppealRestoration). Nothing was restored.`,
      null,
    );
  }

  // Unreachable while the allowlists are empty, and it must STAY a refusal
  // rather than a write: even with a decided role, the command does not exist
  // in the kernel (2450's admin family is ADMIN_HIDE_TRIP alone), so there is
  // nothing to dispatch to. Whoever makes the allowlists non-empty has to come
  // through here and add the migration first.
  // The ruling is taken (APPEAL_RESTORE_RULING) and this envelope satisfies it.
  // The write still cannot happen: the command does not exist in the kernel.
  return refuse(
    "ADMIN_RESTORE_COMMAND_ABSENT",
    `${ADMIN_RESTORE_PARTICIPANT} is not implemented by the Trip Kernel: the admin command family ` +
    "contains only ADMIN_HIDE_TRIP (migration 2450), so no kernel command can re-insert a trip_members row.",
    "TRIP_KERNEL_ADMIN_RESTORE_PARTICIPANT",
  );
}
