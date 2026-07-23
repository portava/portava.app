/**
 * Budget intelligence routes.
 *
 * Member-facing (flag: budget_intelligence_enabled):
 *   GET  /trips/:tripId/cost-estimate?tier=   — curated-baseline cost estimate
 *   POST /trips/:tripId/budget/sandbox        — what-if arithmetic vs trip budget
 *
 * Admin-facing (profiles.role = 'admin'):
 *   GET    /admin/price-baselines?country=&city=&category=
 *   POST   /admin/price-baselines             — upsert by (country, city, category, tier)
 *   DELETE /admin/price-baselines/:id
 *
 * HONESTY: numbers come exclusively from price_baselines rows; with no rows
 * the estimate returns { available: false, reason: 'no_baseline_data' }.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  BUDGET_TIERS,
  BASELINE_CATEGORIES,
  resolveTier,
  estimateTripCost,
  sandboxBudget,
  type BudgetTier,
} from "../lib/tripBudgetIntel.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

const ACCEPTED_ROLES = ["owner", "co_host", "member", "viewer"];

// ── Admin guard (local-helper pattern, mirrors src/routes/admin.ts) ───────────

async function requireAdmin(
  req: any,
  res: any,
): Promise<{ userId: string; client: any; sc: any } | null> {
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
  return { userId: user.id, client, sc };
}

// ── Shared member-route preamble ──────────────────────────────────────────────

async function requireBudgetIntelMember(
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

  if (!(await isFlagEnabled(sc, "budget_intelligence_enabled"))) {
    sendError(res, "feature_disabled", "Budget intelligence is not enabled");
    return null;
  }

  const { data: trip } = await sc
    .from("trips")
    .select("id, owner_id, destination_city, destination_country, start_date, end_date")
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

/** Count of ACCEPTED members on a trip (owner/co_host/member/viewer). */
async function countAcceptedMembers(sc: any, tripId: string): Promise<number> {
  const { data, error } = await sc
    .from("trip_members")
    .select("role, status")
    .eq("trip_id", tripId);
  if (error || !Array.isArray(data)) return 1;
  const n = (data as any[]).filter(
    (m) =>
      ACCEPTED_ROLES.includes(String(m.role)) &&
      (m.status == null || m.status === "accepted"),
  ).length;
  return Math.max(1, n);
}

/** Resolve the tier: explicit input wins, else the caller's profile budget_style. */
async function resolveCallerTier(
  sc: any,
  userId: string,
  explicit: BudgetTier | undefined,
): Promise<BudgetTier> {
  if (explicit) return explicit;
  const { data: profile } = await sc
    .from("profiles")
    .select("budget_style")
    .eq("id", userId)
    .maybeSingle();
  return resolveTier((profile as any)?.budget_style ?? null);
}

// ── GET /trips/:tripId/cost-estimate ──────────────────────────────────────────

router.get("/trips/:tripId/cost-estimate", asyncHandler(async (req, res) => {
  const ctx = await requireBudgetIntelMember(req, res);
  if (!ctx) return;
  const { sc, userId, trip } = ctx;

  const tierParam = typeof req.query.tier === "string" ? req.query.tier.trim() : "";
  let explicitTier: BudgetTier | undefined;
  if (tierParam) {
    if (!(BUDGET_TIERS as readonly string[]).includes(tierParam)) {
      sendError(res, "invalid_payload", `tier must be one of: ${BUDGET_TIERS.join(", ")}`);
      return;
    }
    explicitTier = tierParam as BudgetTier;
  }

  const tier = await resolveCallerTier(sc, userId, explicitTier);
  const partySize = await countAcceptedMembers(sc, (trip as any).id);

  const estimate = await estimateTripCost(sc, trip as any, { tier, partySize });
  res.json({ estimate, partySize });
}));

// ── POST /trips/:tripId/budget/sandbox ────────────────────────────────────────

const SandboxSchema = z.object({
  tier:                z.enum(BUDGET_TIERS as unknown as [BudgetTier, ...BudgetTier[]]).optional(),
  extraDays:           z.number().int().min(-90).max(90).optional(),
  dailySpendOverride:  z.number().min(0).max(1_000_000).optional(),
  budgetDelta:         z.number().min(-10_000_000).max(10_000_000).optional(),
  protectedCategories: z.array(z.enum(BASELINE_CATEGORIES)).max(6).optional(),
});

router.post("/trips/:tripId/budget/sandbox", asyncHandler(async (req, res) => {
  const ctx = await requireBudgetIntelMember(req, res);
  if (!ctx) return;
  const { sc, userId, trip, role } = ctx;

  const parsed = SandboxSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const whatIf = parsed.data;

  const tier = await resolveCallerTier(sc, userId, whatIf.tier);
  const partySize = await countAcceptedMembers(sc, (trip as any).id);
  const estimate = await estimateTripCost(sc, trip as any, { tier, partySize });

  // Trip budget stays owner/co_host-only (matches /trips/:tripId/budget).
  const budgetVisible = role === "owner" || role === "co_host";
  let budgetRow: any = null;
  if (budgetVisible) {
    const { data } = await sc
      .from("trip_budget")
      .select("total_budget, currency")
      .eq("trip_id", (trip as any).id)
      .maybeSingle();
    budgetRow = data ?? null;
  }

  const sandbox = sandboxBudget(estimate, budgetRow, {
    extraDays:           whatIf.extraDays,
    dailySpendOverride:  whatIf.dailySpendOverride,
    budgetDelta:         whatIf.budgetDelta,
    protectedCategories: whatIf.protectedCategories,
  });

  if (sandbox.available && !budgetVisible) {
    // Honest note: budget exists checks are simply not visible to this role.
    sandbox.notes = sandbox.notes.filter(
      (n) => !n.startsWith("No trip budget is set"),
    );
    sandbox.notes.push(
      "Trip budget comparison is only available to the trip owner and co-hosts.",
    );
  }

  res.json({ sandbox, estimate });
}));

// ── Admin: price baselines CRUD ───────────────────────────────────────────────

router.get("/admin/price-baselines", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const country  = typeof req.query.country  === "string" ? req.query.country.trim()  : "";
  const city     = typeof req.query.city     === "string" ? req.query.city.trim()     : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";

  let query = sc
    .from("price_baselines")
    .select("*")
    .order("country", { ascending: true })
    .order("city", { ascending: true })
    .order("category", { ascending: true })
    .order("tier", { ascending: true });

  if (country)  query = query.eq("country", country.toUpperCase());
  if (city)     query = query.ilike("city", `%${city}%`);
  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ baselines: (data as any[]) ?? [] });
}));

const BaselineUpsertSchema = z.object({
  country:     z.string().regex(/^[A-Za-z]{2}$/, "country must be a 2-letter ISO code").nullish(),
  city:        z.string().min(1).max(120).nullish(),
  category:    z.enum(BASELINE_CATEGORIES),
  tier:        z.enum(BUDGET_TIERS as unknown as [BudgetTier, ...BudgetTier[]]),
  dailyAmount: z.number().min(0).max(1_000_000),
  currency:    z.string().regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter code").default("USD"),
  sourceNote:  z.string().max(500).nullish(),
  confidence:  z.string().max(40).optional(),
});

router.post("/admin/price-baselines", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId } = admin;

  const parsed = BaselineUpsertSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const b = parsed.data;
  const country = b.country ? b.country.toUpperCase() : null;
  const city    = b.city ? b.city.trim() : null;
  const now     = new Date().toISOString();

  // The unique key uses a COALESCE expression index, so upsert is done
  // app-side: find the existing (country, city, category, tier) row, then
  // update-or-insert. Service-role writes keep this race-safe enough for an
  // admin curation surface; the DB index is the final guarantee.
  let findQ = sc
    .from("price_baselines")
    .select("id")
    .eq("category", b.category)
    .eq("tier", b.tier);
  findQ = country === null ? findQ.is("country", null) : findQ.eq("country", country);
  findQ = city    === null ? findQ.is("city", null)    : findQ.eq("city", city);
  const { data: existing } = await findQ.maybeSingle();

  const values: Record<string, any> = {
    country,
    city,
    category:         b.category,
    tier:             b.tier,
    daily_amount:     b.dailyAmount,
    currency:         b.currency.toUpperCase(),
    source_note:      b.sourceNote ?? null,
    confidence:       b.confidence ?? "curated",
    last_verified_at: now,
    verified_by:      userId,
    updated_at:       now,
  };

  if (existing) {
    const { data: row, error } = await sc
      .from("price_baselines")
      .update(values)
      .eq("id", (existing as any).id)
      .select("*")
      .single();
    if (error) { sendError(res, "db_error", error.message); return; }
    res.json({ baseline: row, created: false });
    return;
  }

  const { data: row, error } = await sc
    .from("price_baselines")
    .insert(values)
    .select("*")
    .single();
  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json({ baseline: row, created: true });
}));

router.delete("/admin/price-baselines/:id", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid baseline id"); return; }

  const { data: existing } = await sc
    .from("price_baselines")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!existing) { sendError(res, "not_found", "Baseline not found"); return; }

  const { error } = await sc.from("price_baselines").delete().eq("id", id);
  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(204).end();
}));

export default router;
