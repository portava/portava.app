/**
 * entryRequirements.ts — passport management + trip entry assessments +
 * admin-curated corridor CRUD.
 *
 *   GET    /me/passports                          — list own passports
 *   POST   /me/passports                          — add a passport (issuing country only)
 *   PATCH  /me/passports/:id                      — edit own passport
 *   DELETE /me/passports/:id                      — remove own passport
 *   PUT    /trips/:tripId/travelers/me/passport   — select/clear the passport used on a trip
 *   GET    /trips/:tripId/entry-requirements      — per-traveler entry matrix (flag-gated)
 *   GET    /admin/entry-requirements              — list corridors (admin)
 *   POST   /admin/entry-requirements              — upsert a corridor (admin; official source REQUIRED)
 *   DELETE /admin/entry-requirements/:id          — delete a corridor (admin)
 *
 * Privacy: the entry matrix returns full detail for the CALLER only; other
 * travelers appear as status + passportSelected — never their passport country.
 * Security: requireUser + explicit membership/ownership checks in code
 * (service-role client; RLS is a latent backstop only).
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { getServiceClient } from "../lib/supabase.js";
import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { toCountryCode } from "../lib/countryCodes.js";
import { ENTRY_FLAG, DISCLAIMER, assessTripEntry } from "../lib/entryRequirements.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const passportCreateSchema = z.object({
  issuingCountry: z.string().min(2).max(60),
  label:          z.string().max(100).optional(),
  expiryDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  isPrimary:      z.boolean().optional(),
});

const passportPatchSchema = z.object({
  label:      z.string().max(100).optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  isPrimary:  z.boolean().optional(),
});

const tripPassportSchema = z.object({
  passportId: z.string().uuid().nullable(),
});

const corridorUpsertSchema = z.object({
  passportCountry:      z.string().min(2).max(60),
  destinationCountry:   z.string().min(2).max(60),
  status: z.enum([
    "visa_free", "visa_on_arrival", "evisa",
    "visa_required", "special_authorization", "entry_restricted",
  ]),
  allowedStayDays:      z.number().int().min(0).max(3650).optional().nullable(),
  passportValidityRule: z.string().max(500).optional().nullable(),
  feeText:              z.string().max(300).optional().nullable(),
  processingTimeText:   z.string().max(300).optional().nullable(),
  officialSourceUrl:    z.string().url().max(1000),
  notes:                z.string().max(2000).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Explicit membership check: owner or accepted member. Writes error on failure. */
async function requireMembership(
  sc: any,
  res: Response,
  tripId: string,
  userId: string,
): Promise<any | null> {
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return null; }
  const { data: trip, error } = await sc
    .from("trips")
    .select("id, owner_id, destination_country")
    .eq("id", tripId)
    .maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return null; }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return null; }
  if ((trip as any).owner_id === userId) return trip;
  const membership = await requireTripMember(sc, tripId, userId);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return null; }
  return trip;
}

/** Admin gate (routes/admin.ts pattern): profiles.role === 'admin'. */
async function requireAdmin(
  req: Request,
  res: Response,
): Promise<{ userId: string; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;
  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }
  const sc = getServiceClient() ?? client;
  return { userId: user.id, sc };
}

function toPassportDto(row: any) {
  return {
    id:             row.id,
    issuingCountry: row.issuing_country,
    label:          row.label ?? "",
    expiryDate:     row.expiry_date ?? null,
    isPrimary:      Boolean(row.is_primary),
    createdAt:      row.created_at,
  };
}

// ---------------------------------------------------------------------------
// My passports
// ---------------------------------------------------------------------------

router.get("/me/passports", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { data, error } = await auth.client
    .from("traveler_passports")
    .select("id, issuing_country, label, expiry_date, is_primary, created_at")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: true });
  if (error) return sendError(res, "db_error", error.message);
  res.json({ passports: ((data as any[]) ?? []).map(toPassportDto) });
}));

router.post("/me/passports", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = passportCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message);

  const code = toCountryCode(parsed.data.issuingCountry);
  if (!code) return sendError(res, "invalid_payload", "Unrecognized issuing country");

  if (parsed.data.isPrimary) {
    const { error: clearErr } = await auth.client
      .from("traveler_passports")
      .update({ is_primary: false, updated_at: new Date().toISOString() })
      .eq("user_id", auth.user.id);
    if (clearErr) return sendError(res, "db_error", clearErr.message);
  }

  const { data, error } = await auth.client
    .from("traveler_passports")
    .insert({
      user_id:         auth.user.id,
      issuing_country: code,
      label:           parsed.data.label ?? "",
      expiry_date:     parsed.data.expiryDate ?? null,
      is_primary:      parsed.data.isPrimary ?? false,
    })
    .select("id, issuing_country, label, expiry_date, is_primary, created_at")
    .single();
  if (error) return sendError(res, "db_error", error.message);
  res.status(201).json({ passport: toPassportDto(data) });
}));

router.patch("/me/passports/:id", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return sendError(res, "invalid_payload", "Invalid passport id");
  const parsed = passportPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message);

  const { data: existing, error: exErr } = await auth.client
    .from("traveler_passports")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (exErr) return sendError(res, "db_error", exErr.message);
  if (!existing || (existing as any).user_id !== auth.user.id) {
    return sendError(res, "not_found", "Passport not found");
  }

  if (parsed.data.isPrimary) {
    const { error: clearErr } = await auth.client
      .from("traveler_passports")
      .update({ is_primary: false, updated_at: new Date().toISOString() })
      .eq("user_id", auth.user.id);
    if (clearErr) return sendError(res, "db_error", clearErr.message);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.label !== undefined) patch.label = parsed.data.label;
  if (parsed.data.expiryDate !== undefined) patch.expiry_date = parsed.data.expiryDate;
  if (parsed.data.isPrimary !== undefined) patch.is_primary = parsed.data.isPrimary;

  const { data, error } = await auth.client
    .from("traveler_passports")
    .update(patch)
    .eq("id", id)
    .select("id, issuing_country, label, expiry_date, is_primary, created_at")
    .single();
  if (error) return sendError(res, "db_error", error.message);
  res.json({ passport: toPassportDto(data) });
}));

router.delete("/me/passports/:id", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return sendError(res, "invalid_payload", "Invalid passport id");

  const { data: existing, error: exErr } = await auth.client
    .from("traveler_passports")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (exErr) return sendError(res, "db_error", exErr.message);
  if (!existing || (existing as any).user_id !== auth.user.id) {
    return sendError(res, "not_found", "Passport not found");
  }

  const { error } = await auth.client.from("traveler_passports").delete().eq("id", id);
  if (error) return sendError(res, "db_error", error.message);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Trip passport selection
// ---------------------------------------------------------------------------

router.put("/trips/:tripId/travelers/me/passport", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const tripId = String(req.params.tripId ?? "");
  const trip = await requireMembership(auth.client, res, tripId, auth.user.id);
  if (!trip) return;

  const parsed = tripPassportSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message);

  if (parsed.data.passportId === null) {
    const { error } = await auth.client
      .from("trip_traveler_passports")
      .delete()
      .eq("trip_id", tripId)
      .eq("user_id", auth.user.id);
    if (error) return sendError(res, "db_error", error.message);
    return res.json({ ok: true, passportId: null });
  }

  // Passport must belong to the caller.
  const { data: passport, error: pErr } = await auth.client
    .from("traveler_passports")
    .select("id, user_id")
    .eq("id", parsed.data.passportId)
    .maybeSingle();
  if (pErr) return sendError(res, "db_error", pErr.message);
  if (!passport || (passport as any).user_id !== auth.user.id) {
    return sendError(res, "not_found", "Passport not found");
  }

  const { error } = await auth.client
    .from("trip_traveler_passports")
    .upsert(
      {
        trip_id:     tripId,
        user_id:     auth.user.id,
        passport_id: parsed.data.passportId,
        updated_at:  new Date().toISOString(),
      },
      { onConflict: "trip_id,user_id" },
    );
  if (error) return sendError(res, "db_error", error.message);
  res.json({ ok: true, passportId: parsed.data.passportId });
}));

// ---------------------------------------------------------------------------
// Trip entry matrix
// ---------------------------------------------------------------------------

router.get("/trips/:tripId/entry-requirements", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const enabled = await isFlagEnabled(auth.client, ENTRY_FLAG);
  if (!enabled) return sendError(res, "feature_disabled", "Entry intelligence is not enabled");

  const tripId = String(req.params.tripId ?? "");
  const trip = await requireMembership(auth.client, res, tripId, auth.user.id);
  if (!trip) return;

  let assessment;
  try {
    assessment = await assessTripEntry(auth.client, tripId);
  } catch (e: any) {
    if (e?.code === "not_found") return sendError(res, "not_found", "Trip not found");
    return sendError(res, "db_error", e?.message ?? "assessment failed");
  }

  // Privacy shaping: full detail for the caller; status-only for others.
  const travelers = assessment.travelers.map((t) => {
    if (t.userId === auth.user.id) {
      return {
        userId:           t.userId,
        self:             true,
        passportSelected: t.passportSelected,
        passportCountry:  t.passportCountry,
        status:           (t.requirement as any)?.status ?? "unknown",
        requirement:      t.requirement,
        unknownReason:    t.unknownReason ?? null,
        lastVerifiedAt:   (t.requirement as any)?.last_verified_at ?? null,
      };
    }
    return {
      userId:           t.userId,
      self:             false,
      passportSelected: t.passportSelected,
      status:           (t.requirement as any)?.status ?? "unknown",
    };
  });

  res.json({
    destinationCountry: assessment.destinationCountry,
    disclaimer: DISCLAIMER,
    travelers,
  });
}));

// ---------------------------------------------------------------------------
// Admin corridor CRUD
// ---------------------------------------------------------------------------

router.get("/admin/entry-requirements", asyncHandler(async (req: Request, res: Response) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  let q = admin.sc
    .from("entry_requirements")
    .select("*")
    .order("passport_country", { ascending: true });
  const passport = typeof req.query.passport === "string" ? toCountryCode(req.query.passport) : null;
  const destination = typeof req.query.destination === "string" ? toCountryCode(req.query.destination) : null;
  if (passport) q = q.eq("passport_country", passport);
  if (destination) q = q.eq("destination_country", destination);

  const { data, error } = await q;
  if (error) return sendError(res, "db_error", error.message);
  res.json({ corridors: (data as any[]) ?? [] });
}));

router.post("/admin/entry-requirements", asyncHandler(async (req: Request, res: Response) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = corridorUpsertSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message);

  const passportCountry = toCountryCode(parsed.data.passportCountry);
  const destinationCountry = toCountryCode(parsed.data.destinationCountry);
  if (!passportCountry) return sendError(res, "invalid_payload", "Unrecognized passport country");
  if (!destinationCountry) return sendError(res, "invalid_payload", "Unrecognized destination country");

  const row = {
    passport_country:       passportCountry,
    destination_country:    destinationCountry,
    status:                 parsed.data.status,
    allowed_stay_days:      parsed.data.allowedStayDays ?? null,
    passport_validity_rule: parsed.data.passportValidityRule ?? null,
    fee_text:               parsed.data.feeText ?? null,
    processing_time_text:   parsed.data.processingTimeText ?? null,
    official_source_url:    parsed.data.officialSourceUrl,
    notes:                  parsed.data.notes ?? null,
    confidence:             "curated",
    last_verified_at:       new Date().toISOString(),
    verified_by:            admin.userId,
    updated_at:             new Date().toISOString(),
  };

  const { data, error } = await admin.sc
    .from("entry_requirements")
    .upsert(row, { onConflict: "passport_country,destination_country" })
    .select("*")
    .single();
  if (error) return sendError(res, "db_error", error.message);
  res.status(201).json({ corridor: data });
}));

router.delete("/admin/entry-requirements/:id", asyncHandler(async (req: Request, res: Response) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return sendError(res, "invalid_payload", "Invalid id");
  const { error } = await admin.sc.from("entry_requirements").delete().eq("id", id);
  if (error) return sendError(res, "db_error", error.message);
  res.json({ ok: true });
}));

export default router;
