/**
 * Circle Age Settings routes
 *
 * GET /api/circle-age-settings          — owner reads their own settings
 * PUT /api/circle-age-settings          — owner creates or updates their settings
 * GET /api/circle-age-settings/:ownerId — service / eligibility check (auth required)
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { validateAgeRange, formatAgeLimitLabel } from "../lib/ageEligibility.js";

const router = Router();

// ── GET /api/circle-age-settings ─────────────────────────────────────────────

router.get("/circle-age-settings", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { data, error } = await client
    .from("circle_age_settings")
    .select("owner_id, age_limit_enabled, min_age, max_age, updated_at")
    .eq("owner_id", user.id)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "circle-age-settings GET");
    sendError(res, "db_error", error.message);
    return;
  }

  if (!data) {
    res.json({
      ageLimitEnabled: false,
      minAge: null,
      maxAge: null,
      label: null,
      updatedAt: null,
    });
    return;
  }

  const d = data as any;
  res.json({
    ageLimitEnabled: d.age_limit_enabled ?? false,
    minAge: d.min_age ?? null,
    maxAge: d.max_age ?? null,
    label: formatAgeLimitLabel(d.age_limit_enabled, d.min_age, d.max_age),
    updatedAt: d.updated_at ?? null,
  });
});

// ── PUT /api/circle-age-settings ─────────────────────────────────────────────

const UpsertSchema = z.object({
  ageLimitEnabled: z.boolean(),
  minAge: z.number().int().nullable().optional(),
  maxAge: z.number().int().nullable().optional(),
});

router.put("/circle-age-settings", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const parsed = UpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const b = parsed.data;

  const minAge = b.minAge ?? null;
  const maxAge = b.maxAge ?? null;

  if (b.ageLimitEnabled) {
    const rangeErr = validateAgeRange(minAge, maxAge);
    if (rangeErr) {
      sendError(res, "invalid_payload", rangeErr);
      return;
    }
    if (minAge === null && maxAge === null) {
      sendError(res, "invalid_payload", "At least one of minAge or maxAge must be set when ageLimitEnabled is true");
      return;
    }
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const now = new Date().toISOString();

  const { data, error } = await sc
    .from("circle_age_settings")
    .upsert(
      {
        owner_id:          user.id,
        age_limit_enabled: b.ageLimitEnabled,
        min_age:           b.ageLimitEnabled ? minAge : null,
        max_age:           b.ageLimitEnabled ? maxAge : null,
        updated_at:        now,
      },
      { onConflict: "owner_id" },
    )
    .select("owner_id, age_limit_enabled, min_age, max_age, updated_at")
    .single();

  if (error) {
    req.log.error({ err: error }, "circle-age-settings PUT");
    sendError(res, "db_error", error.message);
    return;
  }

  const d = data as any;

  // Audit log: circle age limit saved (fire-and-forget)
  void (async () => {
    const { error: auditError } = await sc.from("age_limit_audit_log").insert({
      actor_user_id: user.id,
      target_type:   "circle",
      target_id:     user.id,
      action:        b.ageLimitEnabled ? "age_limit_set" : "age_limit_removed",
      new_min_age:   b.ageLimitEnabled ? minAge : null,
      new_max_age:   b.ageLimitEnabled ? maxAge : null,
    });
    if (auditError) req.log.warn({ err: auditError }, "age limit audit insert failed (best-effort)");
  })();

  res.json({
    ageLimitEnabled: d.age_limit_enabled ?? false,
    minAge: d.min_age ?? null,
    maxAge: d.max_age ?? null,
    label: formatAgeLimitLabel(d.age_limit_enabled, d.min_age, d.max_age),
    updatedAt: d.updated_at ?? null,
  });
});

// ── GET /api/circle-age-settings/:ownerId — eligibility read ─────────────────
// Used by the circle invite accept path to read another owner's settings.
// Returns the same public shape as the self-read route — no raw DOBs exposed.

router.get("/circle-age-settings/:ownerId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;

  const { ownerId } = req.params;
  const UUID = /^[0-9a-f-]{36}$/i;
  if (!UUID.test(ownerId)) {
    sendError(res, "invalid_payload", "Invalid ownerId");
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    res.json({ ageLimitEnabled: false, minAge: null, maxAge: null, label: null, updatedAt: null });
    return;
  }

  const { data } = await sc
    .from("circle_age_settings")
    .select("age_limit_enabled, min_age, max_age, updated_at")
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (!data) {
    res.json({ ageLimitEnabled: false, minAge: null, maxAge: null, label: null, updatedAt: null });
    return;
  }

  const d = data as any;
  res.json({
    ageLimitEnabled: d.age_limit_enabled ?? false,
    minAge: d.min_age ?? null,
    maxAge: d.max_age ?? null,
    label: formatAgeLimitLabel(d.age_limit_enabled, d.min_age, d.max_age),
    updatedAt: d.updated_at ?? null,
  });
});

export default router;
