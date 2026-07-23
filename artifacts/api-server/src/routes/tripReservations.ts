/**
 * Trip reservations — paste-to-import (confirm-before-commit) + manual CRUD.
 *
 * All routes are gated by the reservation_import_enabled flag and trip
 * membership.
 *
 *   POST   /trips/:tripId/reservations/import       — LLM-extract pasted text →
 *          rows land as status 'pending_confirm'. NEVER touches the trip plan.
 *   POST   /trips/:tripId/reservations              — manual create (confirmed)
 *   GET    /trips/:tripId/reservations?status=      — list for members
 *   PATCH  /trips/:tripId/reservations/:id          — creator or owner/co_host
 *   POST   /trips/:tripId/reservations/:id/confirm  — {addToPlan?} plan item only here
 *   POST   /trips/:tripId/reservations/:id/dismiss
 *   DELETE /trips/:tripId/reservations/:id          — creator or trip owner
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { extractReservations, RESERVATION_TYPES } from "../lib/reservationExtract.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

const RESERVATION_STATUSES = ["pending_confirm", "confirmed", "dismissed"] as const;

/** reservation type → trip_plan_items category */
const PLAN_CATEGORY_MAP: Record<string, string> = {
  stay:      "accommodation",
  flight:    "transport",
  transport: "transport",
  activity:  "activity",
  other:     "other",
};

/** Parse a model/user-supplied datetime; null when unusable (never guess). */
function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

// ── Shared preamble: auth + flag + trip + membership ──────────────────────────

async function requireReservationMember(
  req: any,
  res: any,
): Promise<{ sc: any; userId: string; trip: any; role: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return null; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return null; }

  if (!(await isFlagEnabled(sc, "reservation_import_enabled"))) {
    sendError(res, "feature_disabled", "Reservation import is not enabled");
    return null;
  }

  const { data: trip } = await sc
    .from("trips")
    .select("id, owner_id")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return null; }

  const isOwner = (trip as any).owner_id === user.id;
  let role = "owner";
  if (!isOwner) {
    const membership = await requireTripMember(sc, tripId, user.id);
    if (!membership) { sendError(res, "not_member", "You must be an accepted trip member"); return null; }
    role = membership.role;
  }

  return { sc, userId: user.id, trip, role };
}

/** Fetch a reservation row belonging to this trip; writes 404 when absent. */
async function fetchReservation(
  sc: any,
  res: any,
  tripId: string,
  reservationId: string,
): Promise<any | null> {
  if (!UUID_RE.test(reservationId)) {
    sendError(res, "invalid_payload", "Invalid reservation id");
    return null;
  }
  const { data } = await sc
    .from("trip_reservations")
    .select("*")
    .eq("id", reservationId)
    .eq("trip_id", tripId)
    .maybeSingle();
  if (!data) { sendError(res, "not_found", "Reservation not found"); return null; }
  return data;
}

/** creator OR trip owner/co_host may edit / confirm / dismiss. */
function canManageReservation(reservation: any, userId: string, role: string): boolean {
  if ((reservation as any).user_id === userId) return true;
  return role === "owner" || role === "co_host";
}

// ── POST /trips/:tripId/reservations/import ───────────────────────────────────

const ImportSchema = z.object({
  text: z.string().min(1).max(20_000),
});

router.post("/trips/:tripId/reservations/import", asyncHandler(async (req, res) => {
  const ctx = await requireReservationMember(req, res);
  if (!ctx) return;
  const { sc, userId, trip } = ctx;

  const parsed = ImportSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "text is required (max 20000 chars)");
    return;
  }
  const { text } = parsed.data;

  const extraction = await extractReservations(text);
  if (extraction.error) {
    // Honest empty import — nothing inserted, nothing guessed.
    res.json({ reservations: [], error: "extraction_failed" });
    return;
  }
  if (extraction.reservations.length === 0) {
    res.json({ reservations: [] });
    return;
  }

  // Every extracted row lands as pending_confirm — extraction NEVER
  // auto-commits to the plan; that only happens via explicit /confirm.
  const rows = extraction.reservations.map((r) => ({
    trip_id:                  (trip as any).id,
    user_id:                  userId,
    type:                     r.type,
    title:                    r.title,
    starts_at:                toIsoOrNull(r.startsAt),
    ends_at:                  toIsoOrNull(r.endsAt),
    location_name:            r.locationName ?? null,
    confirmation_ref:         r.confirmationRef ?? null,
    cancellation_deadline_at: toIsoOrNull(r.cancellationDeadlineAt),
    raw_text:                 text,
    extraction:               r as unknown as Record<string, unknown>,
    extraction_confidence:    r.confidence,
    status:                   "pending_confirm",
    created_from:             "paste",
  }));

  const { data: inserted, error } = await sc
    .from("trip_reservations")
    .insert(rows)
    .select("*");
  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(201).json({
    reservations: (inserted as any[]) ?? [],
    needsConfirmation: true,
  });
}));

// ── POST /trips/:tripId/reservations (manual create) ──────────────────────────

const IsoDatetime = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 datetime");

const ManualCreateSchema = z.object({
  type:                   z.enum(RESERVATION_TYPES),
  title:                  z.string().min(1).max(300),
  startsAt:               IsoDatetime.optional(),
  endsAt:                 IsoDatetime.optional(),
  locationName:           z.string().max(300).optional(),
  confirmationRef:        z.string().max(100).optional(),
  cancellationDeadlineAt: IsoDatetime.optional(),
});

router.post("/trips/:tripId/reservations", asyncHandler(async (req, res) => {
  const ctx = await requireReservationMember(req, res);
  if (!ctx) return;
  const { sc, userId, trip } = ctx;

  const parsed = ManualCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const b = parsed.data;

  const { data: reservation, error } = await sc
    .from("trip_reservations")
    .insert({
      trip_id:                  (trip as any).id,
      user_id:                  userId,
      type:                     b.type,
      title:                    b.title,
      starts_at:                toIsoOrNull(b.startsAt),
      ends_at:                  toIsoOrNull(b.endsAt),
      location_name:            b.locationName ?? null,
      confirmation_ref:         b.confirmationRef ?? null,
      cancellation_deadline_at: toIsoOrNull(b.cancellationDeadlineAt),
      raw_text:                 null,
      extraction:               null,
      extraction_confidence:    null,
      status:                   "confirmed",
      created_from:             "manual",
    })
    .select("*")
    .single();
  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(201).json({ reservation });
}));

// ── GET /trips/:tripId/reservations ───────────────────────────────────────────

router.get("/trips/:tripId/reservations", asyncHandler(async (req, res) => {
  const ctx = await requireReservationMember(req, res);
  if (!ctx) return;
  const { sc, trip } = ctx;

  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  if (status && !(RESERVATION_STATUSES as readonly string[]).includes(status)) {
    sendError(res, "invalid_payload", `status must be one of: ${RESERVATION_STATUSES.join(", ")}`);
    return;
  }

  let query = sc
    .from("trip_reservations")
    .select("*")
    .eq("trip_id", (trip as any).id)
    .order("starts_at", { ascending: true });
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ reservations: (data as any[]) ?? [] });
}));

// ── PATCH /trips/:tripId/reservations/:id ─────────────────────────────────────

const PatchSchema = z.object({
  type:                   z.enum(RESERVATION_TYPES).optional(),
  title:                  z.string().min(1).max(300).optional(),
  startsAt:               IsoDatetime.nullable().optional(),
  endsAt:                 IsoDatetime.nullable().optional(),
  locationName:           z.string().max(300).nullable().optional(),
  confirmationRef:        z.string().max(100).nullable().optional(),
  cancellationDeadlineAt: IsoDatetime.nullable().optional(),
});

router.patch("/trips/:tripId/reservations/:id", asyncHandler(async (req, res) => {
  const ctx = await requireReservationMember(req, res);
  if (!ctx) return;
  const { sc, userId, trip, role } = ctx;

  const reservation = await fetchReservation(sc, res, (trip as any).id, req.params.id);
  if (!reservation) return;

  if (!canManageReservation(reservation, userId, role)) {
    sendError(res, "forbidden", "Only the reservation creator or trip owner/co-host can edit it");
    return;
  }

  const parsed = PatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const p = parsed.data;

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (p.type                   !== undefined) patch.type                     = p.type;
  if (p.title                  !== undefined) patch.title                    = p.title;
  if (p.startsAt               !== undefined) patch.starts_at                = toIsoOrNull(p.startsAt);
  if (p.endsAt                 !== undefined) patch.ends_at                  = toIsoOrNull(p.endsAt);
  if (p.locationName           !== undefined) patch.location_name            = p.locationName;
  if (p.confirmationRef        !== undefined) patch.confirmation_ref         = p.confirmationRef;
  if (p.cancellationDeadlineAt !== undefined) patch.cancellation_deadline_at = toIsoOrNull(p.cancellationDeadlineAt);

  const { data: updated, error } = await sc
    .from("trip_reservations")
    .update(patch)
    .eq("id", (reservation as any).id)
    .select("*")
    .single();
  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({ reservation: updated });
}));

// ── POST /trips/:tripId/reservations/:id/confirm ──────────────────────────────

const ConfirmSchema = z.object({
  addToPlan: z.boolean().optional().default(false),
});

router.post("/trips/:tripId/reservations/:id/confirm", asyncHandler(async (req, res) => {
  const ctx = await requireReservationMember(req, res);
  if (!ctx) return;
  const { sc, userId, trip, role } = ctx;

  const reservation = await fetchReservation(sc, res, (trip as any).id, req.params.id);
  if (!reservation) return;

  if (!canManageReservation(reservation, userId, role)) {
    sendError(res, "forbidden", "Only the reservation creator or trip owner/co-host can confirm it");
    return;
  }

  const parsed = ConfirmSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { addToPlan } = parsed.data;

  const { data: updated, error } = await sc
    .from("trip_reservations")
    .update({ status: "confirmed", updated_at: new Date().toISOString() })
    .eq("id", (reservation as any).id)
    .select("*")
    .single();
  if (error) { sendError(res, "db_error", error.message); return; }

  let planItem: any = null;
  if (addToPlan) {
    // Duplicate guard: one plan item per reservation (source_id = reservation id).
    const { data: dup } = await sc
      .from("trip_plan_items")
      .select("id")
      .eq("trip_id", (trip as any).id)
      .eq("source_type", "manual")
      .eq("source_id", (reservation as any).id)
      .is("removed_at", null)
      .maybeSingle();

    if (dup) {
      planItem = dup;
    } else {
      const startsAt: string | null = (reservation as any).starts_at ?? null;
      // Column shape mirrors POST /trips/:tripId/plan/items (src/routes/trips.ts).
      const { data: item, error: planError } = await sc
        .from("trip_plan_items")
        .insert({
          trip_id:             (trip as any).id,
          creator_id:          userId, // always from token
          title:               (reservation as any).title,
          category:            PLAN_CATEGORY_MAP[(reservation as any).type] ?? "other",
          status:              "confirmed",
          source_type:         "manual",
          source_id:           (reservation as any).id,
          day_date:            startsAt ? String(startsAt).slice(0, 10) : null,
          starts_at:           startsAt,
          ends_at:             (reservation as any).ends_at ?? null,
          location_name:       (reservation as any).location_name ?? null,
          lat:                 null,
          lng:                 null,
          location_is_private: false,
          notes:               (reservation as any).confirmation_ref
            ? `Confirmation: ${(reservation as any).confirmation_ref}`
            : null,
          sort_order:          0,
          lock_type:           startsAt ? "fixed" : "flexible",
          visibility:          "members",
        })
        .select("*")
        .single();
      if (planError) { sendError(res, "db_error", planError.message); return; }
      planItem = item;
    }
  }

  res.json({ reservation: updated, planItem });
}));

// ── POST /trips/:tripId/reservations/:id/dismiss ──────────────────────────────

router.post("/trips/:tripId/reservations/:id/dismiss", asyncHandler(async (req, res) => {
  const ctx = await requireReservationMember(req, res);
  if (!ctx) return;
  const { sc, userId, trip, role } = ctx;

  const reservation = await fetchReservation(sc, res, (trip as any).id, req.params.id);
  if (!reservation) return;

  if (!canManageReservation(reservation, userId, role)) {
    sendError(res, "forbidden", "Only the reservation creator or trip owner/co-host can dismiss it");
    return;
  }

  const { data: updated, error } = await sc
    .from("trip_reservations")
    .update({ status: "dismissed", updated_at: new Date().toISOString() })
    .eq("id", (reservation as any).id)
    .select("*")
    .single();
  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({ reservation: updated });
}));

// ── DELETE /trips/:tripId/reservations/:id ────────────────────────────────────

router.delete("/trips/:tripId/reservations/:id", asyncHandler(async (req, res) => {
  const ctx = await requireReservationMember(req, res);
  if (!ctx) return;
  const { sc, userId, trip, role } = ctx;

  const reservation = await fetchReservation(sc, res, (trip as any).id, req.params.id);
  if (!reservation) return;

  // Delete is stricter than edit: creator or trip OWNER only.
  const isCreator = (reservation as any).user_id === userId;
  if (!isCreator && role !== "owner") {
    sendError(res, "forbidden", "Only the reservation creator or trip owner can delete it");
    return;
  }

  const { error } = await sc
    .from("trip_reservations")
    .delete()
    .eq("id", (reservation as any).id);
  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(204).end();
}));

export default router;
