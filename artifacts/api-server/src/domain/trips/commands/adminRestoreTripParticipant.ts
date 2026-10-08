/**
 * The one call an upheld trip-membership appeal makes to put a removed member
 * back (census-trips §83; owner ruling 2026-10-04, "Appeal restoration": restore
 * the access and permissions removed by that decision; do not recreate missed
 * live activity or location sharing; for an ended trip, restore access to its
 * retained record only).
 *
 * Lane B's `planAppealRestoration` decides WHAT (role at removal, removal event,
 * membership vs retained_record_only) and authorizes the admin; this sends it
 * to the Trip Kernel as ADMIN_RESTORE_PARTICIPANT (migration 3974), which
 * re-checks every claim against its own ledger before it writes, stops any live
 * location session, and records `trip.participant_added` with via 'admin_restore'.
 *
 * There is NO legacy twin. With `trip_kernel_enabled` off (or no service
 * client) nothing is written and the answer says so — a restoration is a
 * kernel write or it is not made.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import { executeTripCommand, tripKernelClient, type TripKernelResult } from "./tripKernel.js";

export interface AdminRestoreTripParticipantInput {
  tripId: string;
  userId: string;
  /** The role at removal — lane B's plan.role. */
  role: string;
  /** lane B's plan.access. */
  access: "membership" | "retained_record_only";
  appealId: string;
  /** lane B's plan.removalEventId: the trip_events.event_id of the removal. */
  removalEventId: string;
  /** The admin, from a verified token. */
  adminActor: string;
  reason: string;
  idempotencyKey: string;
  expectedVersion: number | null;
}

export type AdminRestoreTripParticipantResult =
  | TripKernelResult
  | { ok: false; reason: "TRIP_KERNEL_DISABLED"; detail: string; contractVersion: null };

export async function adminRestoreTripParticipant(
  sc: SupabaseClient | null,
  input: AdminRestoreTripParticipantInput,
): Promise<AdminRestoreTripParticipantResult> {
  const kernel = await tripKernelClient(sc);
  if (!kernel) {
    return { ok: false, reason: "TRIP_KERNEL_DISABLED", detail: "trip_kernel_enabled is off or unreadable: a restoration is a kernel write and none was made", contractVersion: null };
  }
  return executeTripCommand(kernel, {
    commandId: randomUUID(),
    tripId: input.tripId,
    actorUserId: input.adminActor,
    actorRole: "admin",
    expectedTripVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey,
    type: "ADMIN_RESTORE_PARTICIPANT",
    payload: {
      user_id: input.userId,
      role: input.role,
      access: input.access,
      appeal_id: input.appealId,
      removal_event_id: input.removalEventId,
      reason: input.reason.slice(0, 2000),
    },
  });
}
