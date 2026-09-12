/**
 * Trips spec §18 — Offline, Sync, and Multi-Device, the server's half
 * (census-trips TR334, TR343, TR349, TR451; the §23 "offline member for 6h"
 * scenario, TR421).
 *
 *   GET  /trips/:tripId/offline-bundle   §18.1 the signed / versioned bundle
 *   POST /trips/:tripId/operations       §18.2 replay a QueuedTripOperation
 *                                        queue after reconnect
 *
 * THE BUNDLE is assembled from what this deployment can read — the trip's
 * version and dates, its plan items and reservations (baseline tables), its
 * commitments when the operational gate is on — and signed with the server's
 * secret. No secret, no bundle: an unsigned bundle is one a client cannot
 * tell from an edited one, so the route refuses (503) rather than issue it.
 *
 * THE REPLAY takes the queue, orders it by when the traveller acted, and
 * asks services/trips/TripOfflineQueue.ts what each operation is: replayed
 * through the kernel with ITS OWN idempotency key and expected version (so a
 * queue sent twice produces one transition and a stale edit meets
 * TRIP_VERSION_CONFLICT, never an overwrite); or held for revalidation
 * (TRIP_OFFLINE_REVALIDATION_REQUIRED, with the current version); or
 * rejected (TRIP_OFFLINE_QUEUE_REJECTED, with why). The bundle the client
 * carried back, if any, is verified and dated: TRIP_OFFLINE_BUNDLE_STALE says
 * it is the last certified context, not the current one. Every outcome is
 * per operation and the whole queue is answered — one refusal does not hide
 * the rest.
 *
 * FAIL-CLOSED. An unreadable trips row refuses the whole request (the
 * version decides every classification); an unreadable plan or reservation
 * read refuses the bundle. The kernel flag off makes every replay a
 * TRIP_KERNEL_UNAVAILABLE outcome, reported per operation, never a 200 that
 * did nothing.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendTripRefusal } from "../lib/tripReasonCodes.js";
import { executeTripCommand, isTripKernelEnabled, TRIP_KERNEL_FLAG, type TripCommandType } from "../lib/tripKernel.js";
import { tripOperationalProjectionsGate } from "../lib/tripOperationalProjections.js";
import { COMMANDS_ENDPOINT_TYPES, CUTOVER_GATED_TYPES } from "./tripCommands.js";
import {
  QueuedTripOperationSchema, QUEUE_MAX_OPERATIONS, classifyQueuedOperations,
} from "../services/trips/TripOfflineQueue.js";
import {
  buildOfflineBundle, bundleSigningSecret, bundleStaleness, signOfflineBundle, verifyOfflineBundle,
  type BundleCommitment, type BundleMeetingPoint, type BundlePlan, type TripOfflineBundle,
} from "../services/trips/TripOfflineBundle.js";

const router = Router();
const log = logger.child({ mod: "tripOffline" });
const UUID_RE = /^[0-9a-f-]{36}$/i;
const ISSUABLE: ReadonlySet<string> = new Set(COMMANDS_ENDPOINT_TYPES);

// ── GET /trips/:tripId/offline-bundle ───────────────────────────────────────
router.get("/trips/:tripId/offline-bundle", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const secret = bundleSigningSecret();
  if (!secret) { sendError(res, "server_not_configured", "TRIP_OFFLINE_BUNDLE_SECRET (or SESSION_SECRET) is not set; an unsigned bundle is not issued"); return; }
  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to fetch the offline bundle"); return; }

  const { data: trip, error: tripErr } = await sc.from("trips").select("id, version, start_date, end_date").eq("id", tripId).maybeSingle();
  if (tripErr) { log.warn({ err: tripErr.message, tripId }, "offline bundle: trip unreadable — refusing"); sendTripRefusal(res, "degraded_unavailable", "TRIP_VERSION_UNREADABLE", "The trip's version could not be read, so no bundle can be certified"); return; }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const version = typeof (trip as any).version === "number" ? (trip as any).version : null;
  if (version === null) { sendTripRefusal(res, "degraded_unavailable", "TRIP_VERSION_UNREADABLE", "The trip carries no version; a bundle without one cannot be told stale"); return; }

  const { data: planRows, error: planErr } = await sc.from("trip_plan_items")
    .select("id, title, status, day_date, starts_at, ends_at, location_name")
    .eq("trip_id", tripId).is("removed_at", null)
    .order("day_date", { ascending: true, nullsFirst: false }).order("starts_at", { ascending: true, nullsFirst: false });
  if (planErr) { log.warn({ err: planErr.message, tripId }, "offline bundle: plan unreadable — refusing"); sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The plan could not be read; a bundle without it would be a lie about the trip"); return; }
  const { data: resRows, error: resErr } = await sc.from("trip_reservations")
    .select("id, title, location_name, starts_at, status")
    .eq("trip_id", tripId);
  if (resErr) { log.warn({ err: resErr.message, tripId }, "offline bundle: reservations unreadable — refusing"); sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The reservations could not be read; the critical addresses come from them"); return; }

  let commitments: BundleCommitment[] = [];
  let commitmentsReading: string;
  const gate = await tripOperationalProjectionsGate(sc);
  if (gate.enabled) {
    const { data: cRows, error: cErr } = await sc.from("trip_commitments").select("id, type, starts_at, required_arrival_at, place_id").eq("trip_id", tripId);
    if (cErr) { log.warn({ err: cErr.message, tripId }, "offline bundle: commitments unreadable — refusing"); sendTripRefusal(res, "degraded_unavailable", "TRIP_PROJECTION_UNAVAILABLE", "The commitments could not be read"); return; }
    commitments = ((cRows ?? []) as any[]).map((c) => ({ id: String(c.id), type: String(c.type ?? "commitment"), title: null, startsAt: c.starts_at ?? null, requiredArrivalAt: c.required_arrival_at ?? null, placeName: null }));
    commitmentsReading = `${commitments.length} commitment(s) from trip_commitments (2761)`;
  } else {
    commitmentsReading = "trip_operational_projections_enabled is off: commitments are not in this bundle";
  }
  const plans: BundlePlan[] = ((planRows ?? []) as any[]).map((p) => ({ id: String(p.id), title: String(p.title ?? ""), status: String(p.status ?? ""), dayDate: p.day_date ?? null, startsAt: p.starts_at ?? null, endsAt: p.ends_at ?? null, locationName: p.location_name ?? null }));
  const reservations = ((resRows ?? []) as any[]).filter((r) => r.status !== "cancelled" && r.status !== "dismissed")
    .map((r) => ({ id: String(r.id), title: String(r.title ?? ""), locationName: r.location_name ?? null, startsAt: r.starts_at ?? null }));

  // 2794 / §18.1: open meeting checkpoints ride the bundle when the gate is on.
  const meetingPoints = await readOpenMeetingPointsForBundle(sc, tripId, user.id);
  const bundle = buildOfflineBundle({ tripId, sourceTripVersion: version, commitments, plans, reservations, meetingPoints }, Date.now());
  const signed = signOfflineBundle(bundle, secret);
  res.json({ ...signed, readings: { commitments: commitmentsReading, staleness: bundleStaleness(bundle, Date.now(), version).detail } });
}));

async function readOpenMeetingPointsForBundle(sc: any, tripId: string, userId: string): Promise<BundleMeetingPoint[]> {
  if (!(await tripOperationalProjectionsGate(sc)).enabled) return [];
  const { data: rows, error } = await sc.from("trip_meeting_checkpoints").select("id, label, lat, lng, meet_at, purpose").eq("trip_id", tripId).eq("status", "open");
  if (error) { log.warn({ err: error.message, tripId }, "offline bundle: trip_meeting_checkpoints unreadable — carrying none"); return []; }
  const ids = ((rows ?? []) as any[]).map((r) => String(r.id));
  const mine = new Map<string, string>();
  if (ids.length > 0) {
    const { data: parts } = await sc.from("trip_meeting_checkpoint_participants").select("checkpoint_id, arrival_state").in("checkpoint_id", ids).eq("user_id", userId);
    for (const p of ((parts ?? []) as any[])) mine.set(String(p.checkpoint_id), String(p.arrival_state));
  }
  return ((rows ?? []) as any[]).map((r) => ({
    id: String(r.id), label: String(r.label ?? ""), lat: Number(r.lat), lng: Number(r.lng), meetAt: r.meet_at ?? null,
    purpose: (r.purpose ?? "regroup") as BundleMeetingPoint["purpose"], myArrivalState: mine.get(String(r.id)) ?? null,
  }));
}

// ── POST /trips/:tripId/operations ──────────────────────────────────────────
const ReplaySchema = z.object({
  operations: z.array(QueuedTripOperationSchema).min(1).max(QUEUE_MAX_OPERATIONS),
  bundle: z.object({
    bundle: z.object({ tripId: z.string().uuid(), sourceTripVersion: z.number().int().nonnegative(), generatedAt: z.string(), expiresAt: z.string() }).passthrough(),
    signature: z.string().max(128),
  }).optional(),
}).strict();

router.post("/trips/:tripId/operations", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }
  const parsed = ReplaySchema.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const foreign = parsed.data.operations.find((op) => op.tripId !== tripId);
  if (foreign) { sendError(res, "invalid_payload", `operation ${foreign.operationId} names trip ${foreign.tripId}, not this one`); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendTripRefusal(res, "not_member", "TRIP_AUTH_NOT_CREW", "You must be an accepted trip member to replay operations"); return; }

  // §18.4: the server's version is canonical, and it decides every
  // classification below — so an unreadable version refuses the whole queue.
  const { data: trip, error: tripErr } = await sc.from("trips").select("id, version").eq("id", tripId).maybeSingle();
  if (tripErr) { log.warn({ err: tripErr.message, tripId }, "operations: trip unreadable — refusing"); sendTripRefusal(res, "degraded_unavailable", "TRIP_VERSION_UNREADABLE", "The trip's version could not be read, so nothing can be replayed"); return; }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }
  const currentVersion = typeof (trip as any).version === "number" ? (trip as any).version : null;
  if (currentVersion === null) { sendTripRefusal(res, "degraded_unavailable", "TRIP_VERSION_UNREADABLE", "The trip carries no version; a queue cannot be reconciled against nothing"); return; }

  const now = Date.now();
  // The bundle the client carried back: verified (an edited bundle is no bundle) and dated.
  let bundleReport: Record<string, unknown> | null = null;
  if (parsed.data.bundle) {
    const secret = bundleSigningSecret();
    const b = parsed.data.bundle.bundle as unknown as TripOfflineBundle;
    const verified = secret ? verifyOfflineBundle(b, parsed.data.bundle.signature, secret) : false;
    if (!verified) {
      bundleReport = { verified: false, stale: null, reasonCode: "TRIP_OFFLINE_BUNDLE_STALE", detail: secret ? "the bundle's signature does not verify; it is not a bundle this server issued" : "no signing secret is configured; the bundle cannot be verified" };
    } else {
      const st = bundleStaleness(b, now, currentVersion);
      bundleReport = { verified: true, stale: st.stale, reasonCode: st.reasonCode, because: st.because, detail: st.detail };
    }
  }

  const classified = classifyQueuedOperations(parsed.data.operations, { currentTripVersion: currentVersion, now, issuable: ISSUABLE, gated: CUTOVER_GATED_TYPES });
  // The kernel flag is read once for the queue, as every kernel-issuing route
  // reads it: off, nothing is applied and every replayable operation says so
  // (TRIP_KERNEL_UNAVAILABLE) — the client keeps its queue. Never a 200 that
  // silently did nothing.
  const kernelOn = await isTripKernelEnabled(sc);
  const results: Array<Record<string, unknown>> = [];
  let version = currentVersion;
  for (const c of classified) {
    const op = c.operation;
    if (c.decision !== "replay") {
      results.push({ operationId: op.operationId, type: op.type, decision: c.decision, ok: false, reasonCode: c.reasonCode, detail: c.detail, currentVersion: version });
      continue;
    }
    if (c.via === "set") {
      // §18.3 saved ideas: a set operation by identity, not a kernel command
      // (trips.version does not move for a bookmark). Union / difference,
      // idempotent by construction; the answer says whether anything changed.
      const r = await applySetOperation(sc, tripId, user.id, op.type, op.payload);
      results.push({ operationId: op.operationId, type: op.type, decision: "replay", via: "set", ok: r.ok, set: r.ok ? r.effect : null, reasonCode: r.ok ? null : "TRIP_OFFLINE_QUEUE_REJECTED", detail: r.detail, currentVersion: version });
      continue;
    }
    if (!kernelOn) {
      results.push({ operationId: op.operationId, type: op.type, decision: "replay", ok: false, reasonCode: "TRIP_KERNEL_UNAVAILABLE", detail: `${TRIP_KERNEL_FLAG} is off: the queue is held and nothing was applied`, currentVersion: version });
      continue;
    }
    const result = await executeTripCommand(sc, {
      commandId: randomUUID(),
      tripId,
      actorUserId: user.id,
      actorRole: "user",
      expectedTripVersion: op.expectedTripVersion ?? null,
      idempotencyKey: op.idempotencyKey,
      type: op.type as TripCommandType,
      payload: op.payload,
      clientObservedAt: op.clientOccurredAt,
      correlationId: op.operationId,
    });
    if (result.ok) {
      version = Math.max(version, result.version);
      results.push({ operationId: op.operationId, type: op.type, decision: "replay", ok: true, duplicate: result.duplicate, version: result.version, eventId: result.eventId, detail: result.duplicate ? "already applied: the receipt for this idempotency key was returned and no second transition happened (§22.4)" : c.detail });
    } else {
      results.push({ operationId: op.operationId, type: op.type, decision: "replay", ok: false, reasonCode: result.reason, detail: result.detail ?? null, currentVersion: result.currentVersion ?? version, expectedVersion: result.expectedVersion ?? op.expectedTripVersion ?? null });
    }
  }
  res.json({
    tripId,
    currentVersion: version,
    counts: {
      replayed: results.filter((r) => r.decision === "replay" && r.ok === true).length,
      setOperations: results.filter((r) => r.via === "set").length,
      duplicates: results.filter((r) => r.duplicate === true).length,
      conflicted: results.filter((r) => r.reasonCode === "TRIP_VERSION_CONFLICT").length,
      revalidate: results.filter((r) => r.decision === "revalidate").length,
      rejected: results.filter((r) => r.decision === "reject").length,
      refused: results.filter((r) => r.decision === "replay" && r.ok === false && r.reasonCode !== "TRIP_VERSION_CONFLICT").length,
    },
    results,
    bundle: bundleReport,
    reading: "§18.3: replayed with each operation's own idempotency key and expected version — a duplicate returns its receipt, a stale edit is a conflict, never an overwrite; sensitive mutations wait for revalidation against the current version",
  });
}));

/** §18.3 set operations on trip_saved_places: union for SAVE_IDEA, difference for UNSAVE_IDEA, by (trip, member, place). */
async function applySetOperation(
  sc: any, tripId: string, userId: string, type: string, payload: Record<string, unknown>,
): Promise<{ ok: true; effect: "added" | "already_present" | "removed" | "already_absent"; detail: string } | { ok: false; detail: string }> {
  const placeId = String(payload.placeId ?? "");
  const { data: existing, error: readErr } = await sc
    .from("trip_saved_places").select("id").eq("trip_id", tripId).eq("user_id", userId).eq("place_id", placeId).maybeSingle();
  if (readErr) return { ok: false, detail: `the saved set could not be read: ${readErr.message}` };
  if (type === "SAVE_IDEA") {
    if (existing) return { ok: true, effect: "already_present", detail: "already in the set: nothing to add" };
    const { error } = await sc.from("trip_saved_places").insert({
      trip_id: tripId, user_id: userId, place_id: placeId, place_name: String(payload.placeName ?? ""), place_type: (payload.placeType as string | undefined) ?? null,
      lat: (payload.lat as number | null | undefined) ?? null, lng: (payload.lng as number | null | undefined) ?? null, notes: (payload.notes as string | undefined) ?? null,
    });
    if (error) {
      // A concurrent add of the same element is the same element: the unique
      // key (trip_id, user_id, place_id) refused it, and the set is as asked.
      if (String(error.code ?? "") === "23505") return { ok: true, effect: "already_present", detail: "added concurrently: in the set" };
      return { ok: false, detail: `the save could not be written: ${error.message}` };
    }
    return { ok: true, effect: "added", detail: "added to the set" };
  }
  if (!existing) return { ok: true, effect: "already_absent", detail: "not in the set: nothing to remove" };
  const { error } = await sc.from("trip_saved_places").delete().eq("id", (existing as { id: string }).id).eq("trip_id", tripId).eq("user_id", userId);
  if (error) return { ok: false, detail: `the unsave could not be written: ${error.message}` };
  return { ok: true, effect: "removed", detail: "removed from the set" };
}

export default router;
