/**
 * Rent a Buddy Rollout — launch control, QA gate, beta access, global kill switches
 *
 * Admin routes: /api/admin/rent-buddy/rollout/*, /api/admin/rent-buddy/beta-access/*,
 *               /api/admin/rent-buddy/qa/*, /api/admin/rent-buddy/global-controls
 * User routes:  /api/rent-buddy/launch-status, /api/rent-buddy/me/beta-status
 *
 * City status progression:
 *   disabled → waitlist_only → buddy_applications_open → internal_testing
 *              → beta_testing → public_mvp → paused | suspended
 *
 * MVP_MODE whitelist categories: city, language, arrival, shopping, content
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { requireAdmin, isAdmin } from "../lib/requireAdmin.js";
import { getServiceClient } from "../lib/supabase.js";
import { loadTravelerIdentity } from "../lib/travelerVerification.js";
import { isFlagEnabled, isKillSwitchEngaged } from "../lib/featureFlags.js";

const router = Router();

// ── Types ──────────────────────────────────────────────────────────────────────

export type CityRolloutStatus =
  | "disabled"
  | "waitlist_only"
  | "buddy_applications_open"
  | "internal_testing"
  | "beta_testing"
  | "public_mvp"
  | "paused"
  | "suspended";

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; code: string; message: string; httpStatus: number };

const MVP_ALLOWED_CATEGORIES = new Set(["city", "language", "arrival", "shopping", "content"]);

// All city rollout statuses handled by checkRentBuddyAccess.
// Used for a fail-closed guard: any DB enum value added in the future but
// not yet reflected here is denied rather than silently allowed.
const KNOWN_CITY_STATUSES = new Set<string>([
  "disabled", "waitlist_only", "buddy_applications_open", "internal_testing",
  "beta_testing", "public_mvp", "paused", "suspended",
]);

// All booking statuses that represent a cancellation, for cancel-rate metrics.
// User-initiated cancellations write `cancelled_by_traveler` / `cancelled_by_buddy`
// (see the cancel route in rentABuddy.ts); bare `cancelled` is produced only by
// admin dispute-resolution. Counting only bare `cancelled` undercounted the real
// cancel rate to ~zero, making the graduation gate falsely lenient.
const CANCELLED_BOOKING_STATUSES = new Set<string>([
  "cancelled", "cancelled_by_traveler", "cancelled_by_buddy",
]);

// ── Global controls cache (30s TTL) ───────────────────────────────────────────

let _gcCache: any = null;
let _gcCacheTs = 0;
const GC_TTL_MS = 30_000;

// ── Suggested-city cache (60s TTL) ────────────────────────────────────────────
// Stores a full ranked snapshot of every public_mvp city with its live
// available_now count, sorted descending. At read time each caller excludes
// their own city and picks the first entry with count > 0 — so the N-parallel
// DB queries only fire once per TTL window, and every caller still gets the
// correct "best *other* city" without the cache ever returning their own city.

interface RankedCityEntry {
  city: string;
  count: number;
}

let _scCache: RankedCityEntry[] | null = null;
let _scCacheTs = 0;
const SC_TTL_MS = 60_000;

export function invalidateSuggestedCityCache(): void {
  _scCacheTs = 0;
}

/**
 * The controls object for a singleton row that has never been CONFIGURED.
 *
 * A missing row is not an unreadable row. maybeSingle() answers `{data: null,
 * error: null}` for "no such row", which means "no global control has been set"
 * — the same distinction lib/featureFlags.ts draws for an absent kill-switch
 * row, and for the same reason: making an ABSENT row mean "paused" would turn
 * every freshly restored project into an outage.
 */
const GC_UNCONFIGURED = {
  id: 1,
  all_bookings_paused: false,
  applications_paused: false,
  cash_balance_paused: false,
  nightlife_paused: false,
  force_full_in_app: false,
  force_public_meetup: false,
} as const;

/**
 * The controls object for a singleton row that could not be READ.
 *
 * ── WHY EVERY SWITCH IS TRUE HERE ────────────────────────────────────────────
 * These six columns are Rent-a-Buddy's platform-wide kill switches. Each one
 * INVERTS the meaning of its value: `all_bookings_paused = true` means STOP. So
 * the old `data ?? {…all false}` — which took the same branch for "row absent"
 * and "read failed", because the read's `error` was never looked at — did not
 * degrade to a safe default. It DISENGAGED every kill switch at precisely the
 * moment the database was unhealthy, i.e. the moment an operator is most likely
 * to be reaching for one. And it then wrote that fallback into `_gcCache`, so a
 * SINGLE failed read held every switch off for the full 30-second TTL, long
 * after the database recovered.
 *
 * A state that could not be established is therefore treated as "stopped", and
 * the fail-closed object is NEVER cached: the next call re-reads, so the pause
 * lifts the instant the row becomes readable again. `unavailable` rides along
 * so the admin GET can say "could not be read" instead of asserting that an
 * operator paused the platform.
 */
const GC_UNREADABLE = {
  ...GC_UNCONFIGURED,
  all_bookings_paused: true,
  applications_paused: true,
  cash_balance_paused: true,
  nightlife_paused: true,
  force_full_in_app: true,
  force_public_meetup: true,
  unavailable: true,
} as const;

async function getGlobalControls(sc: any): Promise<any> {
  const now = Date.now();
  if (_gcCache && now - _gcCacheTs < GC_TTL_MS) return _gcCache;

  let data: any = null;
  let unreadable = false;
  try {
    const res: any = await sc
      .from("rent_buddy_global_controls")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    // supabase-js RESOLVES on a DB error, so the failure exists only in `error`.
    if (res?.error) unreadable = true;
    else data = res?.data ?? null;
  } catch {
    unreadable = true;
  }

  // Fail closed, and do NOT cache: caching this would extend one failed read
  // into 30 seconds of platform-wide pause the operator never asked for, and
  // (before this change) 30 seconds of every kill switch being off.
  if (unreadable) return { ...GC_UNREADABLE };

  _gcCache = data ?? { ...GC_UNCONFIGURED };
  _gcCacheTs = now;
  return _gcCache;
}

export function invalidateGcCache(): void {
  _gcCacheTs = 0;
}

// ── Feature flag helpers ───────────────────────────────────────────────────────

/**
 * Read a CAPABILITY flag — one whose `true` OPENS something.
 *
 * False on an unreadable flag is the safe default here (the capability stays
 * shut), which is exactly `isFlagEnabled`. This used to be a local read that
 * destructured only `data`, so the polarity happened to be right for these
 * flags by accident; it is now the shared fail-closed reader, which also
 * survives a THROWN read rather than propagating it out of the access check.
 */
async function getFlag(sc: any, flag: string): Promise<boolean> {
  return isFlagEnabled(sc, flag);
}

/**
 * Read a RESTRICTION flag — one whose `true` CLOSES something down
 * (RENT_BUDDY_ADMIN_ONLY_MODE, RENT_BUDDY_MVP_MODE, RENT_BUDDY_BETA_ONLY_MODE).
 *
 * These invert the meaning of the value, so they invert the safe failure too:
 * reading them through the capability reader returned false on a DB error and
 * LIFTED the restriction — admin-only mode, MVP mode and beta-only mode all
 * disengaging together on one failed read. `isKillSwitchEngaged` is the reader
 * whose whole purpose is this polarity: error ⇒ engaged, absent row ⇒ not
 * configured, so nothing changes for a healthy database.
 */
async function getRestrictionFlag(sc: any, flag: string): Promise<boolean> {
  return isKillSwitchEngaged(sc, flag);
}

// ── Admin guard ────────────────────────────────────────────────────────────────

/**
 * This route group's admin guard is the shared one, opened to the WIDER role
 * set it has always accepted: 'admin' OR 'owner'. That divergence is the exact
 * reason `RequireAdminOptions.roles` exists (see lib/requireAdmin.ts) — folding
 * this onto the default would silently revoke `owner`, and folding everything
 * onto this would silently grant `owner` admin rights everywhere else.
 *
 * Note that no `owner` row can currently exist — `profiles_role_check` is
 * CHECK (role = ANY (ARRAY['user','admin'])) — so in practice this admits
 * exactly what the default would. The option is kept because narrowing it here
 * would be an authorisation change smuggled in as a refactor, and the
 * constraint is the thing that would have to change first.
 */
const ROLLOUT_ADMIN_ROLES = ["admin", "owner"] as const;

// ── checkRentBuddyAccess — exported for use by rentABuddy routes ───────────────

/**
 * Main access decision function. Reads flags, global controls, city rollout,
 * and beta access to determine whether the requesting user can proceed.
 *
 * opts.userId      — authenticated user (null for anonymous/unauthenticated)
 * opts.city        — city the booking/action is in (optional)
 * opts.category    — buddy category being requested (optional)
 * opts.action      — 'book' | 'apply' | 'waitlist' | 'read' (default 'read')
 * opts.isTestUser  — skip production checks for admin test mode
 */
export async function checkRentBuddyAccess(opts: {
  sc: any;
  userId: string | null;
  city?: string | null;
  category?: string | null;
  action?: "book" | "apply" | "waitlist" | "read" | "package-book" | "offer-accept";
  isTestUser?: boolean;
  groupSize?: number;
  paymentMode?: string | null;
  meetupType?: string | null;
}): Promise<AccessDecision> {
  const { sc, userId, city, category, action = "read", isTestUser = false } = opts;

  // 1. Global feature flag
  const rentBuddyEnabled = await getFlag(sc, "rent_buddy_enabled");
  if (!rentBuddyEnabled) {
    return { allowed: false, code: "feature_disabled", message: "Rent a Buddy is not available yet.", httpStatus: 403 };
  }

  // 2. Admin-only mode
  const adminOnlyMode = await getRestrictionFlag(sc, "RENT_BUDDY_ADMIN_ONLY_MODE");
  if (adminOnlyMode && !isTestUser) {
    if (!userId) {
      return { allowed: false, code: "unauthenticated", message: "Sign in to access Rent a Buddy.", httpStatus: 401 };
    }
    // Same role question, same answer, one implementation: `isAdmin` is the
    // predicate form of the shared guard — it sends nothing, so this function
    // keeps ownership of its own AccessDecision. Fails closed on a query error
    // exactly as the inline read did (supabase-js resolves `{data:null,error}`).
    if (!(await isAdmin(sc, userId, ROLLOUT_ADMIN_ROLES))) {
      return { allowed: false, code: "admin_only", message: "Rent a Buddy is currently in admin-only mode.", httpStatus: 403 };
    }
  }

  // 3. Global controls
  const gc = await getGlobalControls(sc);
  if (gc.all_bookings_paused && action === "book") {
    return {
      allowed: false,
      code: "globally_paused",
      message: "Rent a Buddy bookings are temporarily paused. Existing bookings remain accessible.",
      httpStatus: 503,
    };
  }
  if (gc.applications_paused && action === "apply") {
    return {
      allowed: false,
      code: "applications_paused",
      message: "Buddy applications are temporarily paused.",
      httpStatus: 503,
    };
  }

  // 3b. Cash balance paused
  if (gc.cash_balance_paused && opts.paymentMode === "deposit_plus_cash") {
    return {
      allowed: false,
      code: "cash_balance_paused",
      message: "Cash balance payments are temporarily unavailable. Full in-app payment is required.",
      httpStatus: 503,
    };
  }

  // 3c. Force full in-app payment
  if (gc.force_full_in_app && opts.paymentMode && opts.paymentMode !== "full_in_app" && action === "book") {
    return {
      allowed: false,
      code: "full_payment_required",
      message: "Only full in-app payment is accepted during this launch phase.",
      httpStatus: 403,
    };
  }

  // 3d. Force public meetup
  if (gc.force_public_meetup && opts.meetupType === "private" && action === "book") {
    return {
      allowed: false,
      code: "private_meetup_unavailable",
      message: "Private meetup locations are not available during the current launch phase. Please choose a public meetup spot.",
      httpStatus: 403,
    };
  }

  // 4. MVP mode — category whitelist
  const mvpMode = await getRestrictionFlag(sc, "RENT_BUDDY_MVP_MODE");
  if (mvpMode && category && !MVP_ALLOWED_CATEGORIES.has(category)) {
    return {
      allowed: false,
      code: "category_not_available",
      message: `The "${category}" category is not available during the MVP phase. Available categories: city, language, arrival, shopping, content.`,
      httpStatus: 403,
    };
  }

  // 4b. MVP mode — group bookings gate
  if (mvpMode && action === "book" && (category === "group" || (opts.groupSize != null && opts.groupSize > 4))) {
    const groupEnabled = await getFlag(sc, "RENT_BUDDY_GROUP_BOOKINGS_ENABLED");
    if (!groupEnabled) {
      return {
        allowed: false,
        code: "group_bookings_unavailable",
        message: "Group bookings are not available during the MVP phase.",
        httpStatus: 403,
      };
    }
  }

  // 4c. MVP mode — package bookings gate
  if (mvpMode && action === "package-book") {
    const packagesEnabled = await getFlag(sc, "RENT_BUDDY_PACKAGES_ENABLED");
    if (!packagesEnabled) {
      return {
        allowed: false,
        code: "packages_unavailable",
        message: "Package bookings are not available during the MVP phase.",
        httpStatus: 403,
      };
    }
  }

  // 4d. MVP mode — offer bookings gate
  if (mvpMode && action === "offer-accept") {
    const offersEnabled = await getFlag(sc, "RENT_BUDDY_OFFERS_ENABLED");
    if (!offersEnabled) {
      return {
        allowed: false,
        code: "offers_unavailable",
        message: "Offer bookings are not available during the MVP phase.",
        httpStatus: 403,
      };
    }
  }

  // 4e. MVP mode — unverified users blocked from booking (verification checked server-side)
  if (mvpMode && action === "book") {
    if (!userId) {
      return { allowed: false, code: "unauthenticated", message: "Sign in to make bookings.", httpStatus: 401 };
    }
    // The booking ACTOR is the traveller, so their ID verification lives on
    // `profiles`. Reading rent_buddy_profiles here meant MVP mode could only
    // ever be satisfied by users who had applied to become a buddy.
    const travIdentity = await loadTravelerIdentity(sc, userId);
    if (!travIdentity.idVerified) {
      return {
        allowed: false,
        code: "verification_required",
        message: "ID verification is required to make bookings during the MVP phase. Please verify your ID to continue.",
        httpStatus: 403,
      };
    }
  }

  // 5. Nightlife global flag
  if (category === "nightlife") {
    const nightlifeEnabled = await getFlag(sc, "RENT_BUDDY_NIGHTLIFE_ENABLED");
    if (!nightlifeEnabled || gc.nightlife_paused) {
      return {
        allowed: false,
        code: "nightlife_disabled",
        message: "Nightlife bookings are not available in the current launch phase.",
        httpStatus: 403,
      };
    }
  }

  // 6. City rollout status
  if (city) {
    const { data: rollout } = await sc
      .from("rent_buddy_city_rollouts")
      .select("id, status")
      .ilike("city", city)
      .maybeSingle();

    const cityStatus: CityRolloutStatus = rollout ? (rollout as any).status : "disabled";

    if (cityStatus === "disabled" || cityStatus === "suspended") {
      return {
        allowed: false,
        code: "city_not_available",
        message: `Rent a Buddy is not available in ${city} yet. Join the waitlist to be notified when it launches.`,
        httpStatus: 403,
      };
    }

    if (cityStatus === "waitlist_only") {
      if (action !== "waitlist" && action !== "read") {
        return {
          allowed: false,
          code: "waitlist_only",
          message: `Rent a Buddy in ${city} is not open for bookings yet. Join the waitlist to get early access.`,
          httpStatus: 403,
        };
      }
    }

    if (cityStatus === "buddy_applications_open") {
      if (action === "book") {
        return {
          allowed: false,
          code: "not_open_for_bookings",
          message: `Rent a Buddy in ${city} is accepting Buddy applications but not open for traveler bookings yet.`,
          httpStatus: 403,
        };
      }
    }

    if (cityStatus === "internal_testing" && !isTestUser) {
      return {
        allowed: false,
        code: "internal_testing",
        message: `Rent a Buddy in ${city} is in internal testing. Join the waitlist for early access.`,
        httpStatus: 403,
      };
    }

    if (cityStatus === "beta_testing" && (action === "book" || action === "apply" || action === "waitlist")) {
      // Check city-specific beta access
      if (!userId) {
        return { allowed: false, code: "unauthenticated", message: "Sign in to access Rent a Buddy beta.", httpStatus: 401 };
      }
      const { data: betaRow } = await sc
        .from("rent_buddy_beta_access")
        .select("id, status")
        .eq("user_id", userId)
        .ilike("city", city)
        .maybeSingle();

      if (!betaRow || (betaRow as any).status !== "active") {
        return {
          allowed: false,
          code: "city_beta_access_required",
          message: `Rent a Buddy in ${city} is in beta. You need a beta invitation to continue. Join the waitlist to be considered.`,
          httpStatus: 403,
        };
      }
    }

    if (cityStatus === "paused" && action === "book") {
      return {
        allowed: false,
        code: "city_paused",
        message: `Rent a Buddy in ${city} is temporarily paused. Existing confirmed bookings remain accessible.`,
        httpStatus: 503,
      };
    }

    // Fail closed: deny any status not in the known set above. This catches
    // cases where the DB enum gains a new value before this code is updated,
    // preventing a silent allow-through.
    if (!KNOWN_CITY_STATUSES.has(cityStatus as string)) {
      return {
        allowed: false,
        code: "city_not_available",
        message: `Rent a Buddy is not available in ${city}.`,
        httpStatus: 403,
      };
    }
  }

  // 7. Beta-only mode (global) — blocks all non-read actions for non-beta users
  const betaOnlyMode = await getRestrictionFlag(sc, "RENT_BUDDY_BETA_ONLY_MODE");
  if (betaOnlyMode && action !== "read" && !isTestUser) {
    if (!userId) {
      return { allowed: false, code: "unauthenticated", message: "Sign in to access Rent a Buddy.", httpStatus: 401 };
    }
    const { data: anyBeta } = await sc
      .from("rent_buddy_beta_access")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    if (!anyBeta) {
      return {
        allowed: false,
        code: "beta_access_required",
        message: "Rent a Buddy is in beta. You need a beta invitation to access this feature.",
        httpStatus: 403,
      };
    }
  }

  return { allowed: true };
}

// ── Audit log helper ───────────────────────────────────────────────────────────

async function writeAuditLog(sc: any, opts: {
  adminId: string;
  action: string;
  cityRolloutId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  overrideReason?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await sc.from("rent_buddy_launch_audit_logs").insert({
    city_rollout_id:  opts.cityRolloutId ?? null,
    admin_id:         opts.adminId,
    action:           opts.action,
    from_status:      opts.fromStatus ?? null,
    to_status:        opts.toStatus ?? null,
    override_reason:  opts.overrideReason ?? null,
    metadata:         opts.metadata ?? {},
  });
}

// ── QA checklist validation helper ────────────────────────────────────────────

const REQUIRED_CHECKLIST_FIELDS = [
  "policy_scan_passed",
  "safety_flow_passed",
  "booking_flow_passed",
  "telegraph_passed",
  "trust_score_passed",
  "payment_flow_passed",
  "moderation_passed",
  "waitlist_flow_passed",
  "buddy_application_passed",
] as const;

function allChecklistItemsPassed(checklist: any): boolean {
  return REQUIRED_CHECKLIST_FIELDS.every((f) => !!(checklist as any)[f]);
}

// ── Allowed status transitions ─────────────────────────────────────────────────

const STATUS_ORDER: CityRolloutStatus[] = [
  "disabled",
  "waitlist_only",
  "buddy_applications_open",
  "internal_testing",
  "beta_testing",
  "public_mvp",
];

function nextStatus(current: CityRolloutStatus): CityRolloutStatus | null {
  const idx = STATUS_ORDER.indexOf(current as any);
  if (idx === -1 || idx >= STATUS_ORDER.length - 1) return null;
  return STATUS_ORDER[idx + 1];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — City Rollout Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/rent-buddy/rollout/cities
router.get("/admin/rent-buddy/rollout/cities", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { data, error } = await admin.sc
    .from("rent_buddy_city_rollouts")
    .select("*")
    .order("city", { ascending: true });

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ cities: data ?? [] });
}));

// POST /api/admin/rent-buddy/rollout/cities
router.post("/admin/rent-buddy/rollout/cities", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { city, country, targetLaunchDate, buddyCap, notes } = req.body ?? {};
  if (!city) return sendError(res, "invalid_payload", "city is required");

  // New cities ALWAYS start at "disabled". The only way to reach public_mvp
  // is through advance-status, which enforces the QA checklist gate.
  // Any caller-provided "status" in the body is intentionally ignored.
  const initialStatus: CityRolloutStatus = "disabled";

  const now = new Date().toISOString();
  const { data, error } = await admin.sc
    .from("rent_buddy_city_rollouts")
    .insert({
      city,
      country: country ?? null,
      status:             initialStatus,
      status_changed_at:  now,
      status_changed_by:  admin.userId,
      target_launch_date: targetLaunchDate ?? null,
      buddy_cap:          buddyCap ?? null,
      notes:              notes ?? null,
    })
    .select()
    .maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  await writeAuditLog(admin.sc, {
    adminId:      admin.userId,
    action:       "city_created",
    cityRolloutId:(data as any)?.id ?? null,
    toStatus:     initialStatus,
  });

  return res.status(201).json({ city: data });
}));

// GET /api/admin/rent-buddy/rollout/cities/:id
router.get("/admin/rent-buddy/rollout/cities/:id", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { data, error } = await admin.sc
    .from("rent_buddy_city_rollouts")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return sendError(res, "db_error", error.message);
  if (!data) return sendError(res, "not_found", "City rollout not found");
  return res.json({ city: data });
}));

// PATCH /api/admin/rent-buddy/rollout/cities/:id
router.patch("/admin/rent-buddy/rollout/cities/:id", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { targetLaunchDate, buddyCap, notes, country } = req.body ?? {};
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (targetLaunchDate !== undefined) patch.target_launch_date = targetLaunchDate;
  if (buddyCap         !== undefined) patch.buddy_cap = buddyCap;
  if (notes            !== undefined) patch.notes = notes;
  if (country          !== undefined) patch.country = country;

  const { error } = await admin.sc
    .from("rent_buddy_city_rollouts")
    .update(patch)
    .eq("id", req.params.id);

  if (error) return sendError(res, "db_error", error.message);

  await writeAuditLog(admin.sc, {
    adminId:       admin.userId,
    action:        "city_updated",
    cityRolloutId: req.params.id,
    metadata:      { fields: Object.keys(patch) },
  });

  return res.json({ ok: true });
}));

// POST /api/admin/rent-buddy/rollout/cities/:id/advance-status
router.post("/admin/rent-buddy/rollout/cities/:id/advance-status", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { overrideReason } = req.body ?? {};

  const { data: rollout } = await admin.sc
    .from("rent_buddy_city_rollouts")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (!rollout) return sendError(res, "not_found", "City rollout not found");

  const current: CityRolloutStatus = (rollout as any).status;
  const next = nextStatus(current);
  if (!next) {
    return res.status(409).json({ error: "no_next_status", message: `City is already at ${current} — cannot advance further.` });
  }

  // Advancing to public_mvp requires QA checklist passed (or admin override with reason)
  if (next === "public_mvp") {
    const { data: checklist } = await admin.sc
      .from("rent_buddy_launch_checklists")
      .select("*")
      .eq("city_rollout_id", req.params.id)
      .maybeSingle();

    const checklistPassed = checklist && allChecklistItemsPassed(checklist) && (checklist as any).checklist_status === "passed";

    if (!checklistPassed) {
      if (!overrideReason) {
        return res.status(409).json({
          error: "qa_not_passed",
          message: "QA checklist must be fully passed before advancing to public_mvp. Provide an overrideReason to bypass with an audit trail.",
          checklistStatus: checklist ? (checklist as any).checklist_status : "missing",
        });
      }
      // The QA override is an ADMIN capability, gated by overrideReason + audit log.
      //
      // This used to require `admin.role === "owner"`. No `owner` row can exist:
      // `profiles_role_check` is CHECK (role = ANY (ARRAY['user','admin'])), which
      // rejects 'owner' even for a superuser (verified live 2026-08-09), and
      // `admin_set_profile_role` accepts only ('user','admin'). Since requireAdmin
      // above already admits nothing but 'admin', that test was unsatisfiable and
      // this override was unreachable by ANY caller — an escape hatch that read as
      // a real capability while silently 403-ing everyone.
      //
      // Removed rather than left in place: a dead authorisation branch invites the
      // "fix" of provisioning an owner to make it work, without the remover ever
      // learning why it was unreachable. See docs/security/admin-guard-consolidation.md.
      //
      // NOTE — this widens authorisation in practice: advancing to public_mvp on a
      // failed checklist was impossible before and is now possible for an admin who
      // supplies an overrideReason. That is the intended escape hatch finally
      // working, and it remains audit-logged below.
      await writeAuditLog(admin.sc, {
        adminId:       admin.userId,
        action:        "qa_override",
        cityRolloutId: req.params.id,
        fromStatus:    current,
        toStatus:      next,
        overrideReason,
      });
    }
  }

  const now = new Date().toISOString();
  await admin.sc
    .from("rent_buddy_city_rollouts")
    .update({ status: next, status_changed_at: now, status_changed_by: admin.userId, updated_at: now })
    .eq("id", req.params.id);

  await writeAuditLog(admin.sc, {
    adminId:       admin.userId,
    action:        "city_status_advanced",
    cityRolloutId: req.params.id,
    fromStatus:    current,
    toStatus:      next,
    overrideReason: overrideReason ?? null,
  });

  return res.json({ ok: true, fromStatus: current, toStatus: next });
}));

// POST /api/admin/rent-buddy/rollout/cities/:id/pause
router.post("/admin/rent-buddy/rollout/cities/:id/pause", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { reason } = req.body ?? {};

  const { data: rollout } = await admin.sc
    .from("rent_buddy_city_rollouts")
    .select("status")
    .eq("id", req.params.id)
    .maybeSingle();

  if (!rollout) return sendError(res, "not_found", "City rollout not found");
  const current: CityRolloutStatus = (rollout as any).status;

  const now = new Date().toISOString();
  await admin.sc
    .from("rent_buddy_city_rollouts")
    .update({ status: "paused", status_changed_at: now, status_changed_by: admin.userId, updated_at: now })
    .eq("id", req.params.id);

  await writeAuditLog(admin.sc, {
    adminId:       admin.userId,
    action:        "city_paused",
    cityRolloutId: req.params.id,
    fromStatus:    current,
    toStatus:      "paused",
    metadata:      { reason: reason ?? null },
  });

  return res.json({ ok: true, fromStatus: current, toStatus: "paused" });
}));

// POST /api/admin/rent-buddy/rollout/cities/:id/resume
router.post("/admin/rent-buddy/rollout/cities/:id/resume", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { resumeStatus } = req.body ?? {};

  const { data: rollout } = await admin.sc
    .from("rent_buddy_city_rollouts")
    .select("status")
    .eq("id", req.params.id)
    .maybeSingle();

  if (!rollout) return sendError(res, "not_found", "City rollout not found");
  const current: CityRolloutStatus = (rollout as any).status;

  if (current !== "paused") {
    return res.status(409).json({ error: "not_paused", message: `City is not paused (current: ${current})` });
  }

  const target: CityRolloutStatus = resumeStatus ?? "public_mvp";
  const now = new Date().toISOString();
  await admin.sc
    .from("rent_buddy_city_rollouts")
    .update({ status: target, status_changed_at: now, status_changed_by: admin.userId, updated_at: now })
    .eq("id", req.params.id);

  await writeAuditLog(admin.sc, {
    adminId:       admin.userId,
    action:        "city_resumed",
    cityRolloutId: req.params.id,
    fromStatus:    current,
    toStatus:      target,
  });

  return res.json({ ok: true, fromStatus: current, toStatus: target });
}));

// GET /api/admin/rent-buddy/rollout/cities/:id/metrics
router.get("/admin/rent-buddy/rollout/cities/:id/metrics", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { data: rollout } = await admin.sc
    .from("rent_buddy_city_rollouts")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (!rollout) return sendError(res, "not_found", "City rollout not found");
  const city: string = (rollout as any).city;

  // Fetch city-scoped data first so we can derive booking IDs for downstream scoping
  const [appsRes, buddiesRes, bookingsRes, waitlistRes] = await Promise.all([
    admin.sc.from("rent_buddy_applications").select("id, status, city").ilike("city", city),
    admin.sc.from("rent_buddy_profiles").select("id, status, verified, city, average_rating, review_count, completed_bookings").ilike("city", city),
    admin.sc.from("rent_buddy_bookings").select("id, status, total_usd, traveler_id, is_test_booking").ilike("city", city),
    admin.sc.from("rent_buddy_waitlist").select("id").ilike("city", city),
  ]);

  const apps     = appsRes.data    ?? [];
  const buddies  = buddiesRes.data ?? [];
  const bookings = bookingsRes.data ?? [];
  const waitlist = waitlistRes.data ?? [];
  const cityBookingIds: string[] = bookings.map((b: any) => b.id);

  // Scope reviews, flags, disputes, and checkins to city's own bookings only
  const [reviewsRes, flagsRes, disputesRes, checkinsRes] = cityBookingIds.length > 0
    ? await Promise.all([
        admin.sc.from("rent_buddy_reviews").select("rating").in("booking_id", cityBookingIds),
        admin.sc.from("rent_buddy_policy_flags").select("id, status").in("booking_id", cityBookingIds),
        admin.sc.from("rent_buddy_disputes").select("id, status").in("booking_id", cityBookingIds),
        admin.sc.from("rent_buddy_safety_checkins").select("id").in("booking_id", cityBookingIds),
      ])
    : ([{ data: [] }, { data: [] }, { data: [] }, { data: [] }] as const);

  const reviews = reviewsRes.data ?? [];

  const realBookings = bookings.filter((b: any) => !b.is_test_booking);
  const testBookings = bookings.filter((b: any) => b.is_test_booking);
  const completedReal = realBookings.filter((b: any) => b.status === "completed");
  const cancelledReal = realBookings.filter((b: any) => CANCELLED_BOOKING_STATUSES.has(b.status));
  const revenueTotal  = completedReal.reduce((s: number, b: any) => s + Number(b.total_usd ?? 0), 0);

  const avgRating = reviews.length
    ? (reviews.reduce((s: number, r: any) => s + Number(r.rating ?? 0), 0) / reviews.length)
    : null;

  // Repeat rate: travelers who have more than one completed real booking
  const travelerBookingCounts: Record<string, number> = {};
  for (const b of completedReal) {
    travelerBookingCounts[(b as any).traveler_id] = (travelerBookingCounts[(b as any).traveler_id] ?? 0) + 1;
  }
  const repeatTravelers = Object.values(travelerBookingCounts).filter((c) => c > 1).length;
  const repeatRate = completedReal.length > 0 ? (repeatTravelers / Object.keys(travelerBookingCounts).length) : 0;

  // MVP graduation checklist (read-only recommendation)
  const graduationChecklist = {
    minBuddies10:          buddies.filter((b: any) => b.status === "active" && b.verified).length >= 10,
    minCompletedBookings5: completedReal.length >= 5,
    avgRating4:            avgRating !== null && avgRating >= 4.0,
    cancelRateUnder20:     realBookings.length > 0
      ? (cancelledReal.length / realBookings.length) < 0.20
      : true,
    noOpenCriticalFlags:   (flagsRes.data ?? []).filter((f: any) => f.status === "open").length === 0,
    noOpenDisputes:        (disputesRes.data ?? []).filter((f: any) => f.status === "open").length === 0,
    repeatRateAbove10:     repeatRate >= 0.1,
  };
  const graduationReady = Object.values(graduationChecklist).every(Boolean);

  return res.json({
    city,
    rolloutStatus: (rollout as any).status,
    buddyApplications: {
      total:        apps.length,
      approved:     apps.filter((a: any) => a.status === "approved").length,
      pending:      apps.filter((a: any) => a.status === "pending" || a.status === "under_review").length,
    },
    activeBuddies: {
      total:    buddies.filter((b: any) => b.status === "active").length,
      verified: buddies.filter((b: any) => b.status === "active" && b.verified).length,
    },
    travelerWaitlist: waitlist.length,
    bookings: {
      total:         bookings.length,
      real:          realBookings.length,
      test:          testBookings.length,
      completed:     completedReal.length,
      cancelled:     cancelledReal.length,
      inProgress:    realBookings.filter((b: any) => b.status === "in_progress").length,
    },
    revenue: {
      totalUsd:         revenueTotal,
      avgPerBookingUsd: completedReal.length > 0 ? revenueTotal / completedReal.length : 0,
    },
    qualityMetrics: {
      avgRating,
      repeatRate: Math.round(repeatRate * 100) / 100,
    },
    safety: {
      openPolicyFlags: (flagsRes.data ?? []).filter((f: any) => f.status === "open").length,
      openDisputes:    (disputesRes.data ?? []).filter((f: any) => f.status === "open").length,
      safetyCheckins:  (checkinsRes.data ?? []).length,
    },
    graduationChecklist,
    graduationReady,
  });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — Beta Access Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/rent-buddy/beta-access
router.get("/admin/rent-buddy/beta-access", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { city, status } = req.query as Record<string, string>;

  let query = admin.sc
    .from("rent_buddy_beta_access")
    .select("*")
    .order("created_at", { ascending: false });

  if (city)   query = query.ilike("city", city);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ betaAccess: data ?? [] });
}));

// POST /api/admin/rent-buddy/beta-access
router.post("/admin/rent-buddy/beta-access", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { userId, city, accessType = "invited", notes } = req.body ?? {};
  if (!userId || !city) return sendError(res, "invalid_payload", "userId and city are required");

  const now = new Date().toISOString();
  const { data, error } = await admin.sc
    .from("rent_buddy_beta_access")
    .upsert(
      {
        user_id:     userId,
        city,
        access_type: accessType,
        status:      "active",
        invited_by:  admin.userId,
        notes:       notes ?? null,
        updated_at:  now,
      },
      { onConflict: "user_id,city" },
    )
    .select()
    .maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  await writeAuditLog(admin.sc, {
    adminId: admin.userId,
    action:  "beta_access_granted",
    metadata: { targetUserId: userId, city, accessType },
  });

  return res.status(201).json({ betaAccess: data });
}));

// PATCH /api/admin/rent-buddy/beta-access/:id
router.patch("/admin/rent-buddy/beta-access/:id", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { accessType, notes } = req.body ?? {};
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (accessType !== undefined) patch.access_type = accessType;
  if (notes      !== undefined) patch.notes = notes;

  const { error } = await admin.sc
    .from("rent_buddy_beta_access")
    .update(patch)
    .eq("id", req.params.id);

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ ok: true });
}));

// POST /api/admin/rent-buddy/beta-access/:id/revoke
router.post("/admin/rent-buddy/beta-access/:id/revoke", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const now = new Date().toISOString();
  const { data: row } = await admin.sc
    .from("rent_buddy_beta_access")
    .select("user_id, city")
    .eq("id", req.params.id)
    .maybeSingle();

  if (!row) return sendError(res, "not_found", "Beta access record not found");

  await admin.sc
    .from("rent_buddy_beta_access")
    .update({ status: "revoked", revoked_at: now, revoked_by: admin.userId, updated_at: now })
    .eq("id", req.params.id);

  await writeAuditLog(admin.sc, {
    adminId: admin.userId,
    action:  "beta_access_revoked",
    metadata: { targetUserId: (row as any).user_id, city: (row as any).city },
  });

  return res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — QA Checklist Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/rent-buddy/qa/checklists
router.get("/admin/rent-buddy/qa/checklists", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { cityRolloutId } = req.query as Record<string, string>;
  let query = admin.sc.from("rent_buddy_launch_checklists").select("*").order("created_at", { ascending: false });
  if (cityRolloutId) query = query.eq("city_rollout_id", cityRolloutId);

  const { data, error } = await query;
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ checklists: data ?? [] });
}));

// POST /api/admin/rent-buddy/qa/checklists
router.post("/admin/rent-buddy/qa/checklists", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { cityRolloutId, notes } = req.body ?? {};
  if (!cityRolloutId) return sendError(res, "invalid_payload", "cityRolloutId is required");

  const { data, error } = await admin.sc
    .from("rent_buddy_launch_checklists")
    .upsert(
      { city_rollout_id: cityRolloutId, notes: notes ?? null, updated_at: new Date().toISOString() },
      { onConflict: "city_rollout_id" },
    )
    .select()
    .maybeSingle();

  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ checklist: data });
}));

// PATCH /api/admin/rent-buddy/qa/checklists/:id
router.patch("/admin/rent-buddy/qa/checklists/:id", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const allowed = [
    "policy_scan_passed", "safety_flow_passed", "booking_flow_passed",
    "telegraph_passed", "trust_score_passed", "payment_flow_passed",
    "moderation_passed", "waitlist_flow_passed", "buddy_application_passed", "notes",
  ] as const;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const field of allowed) {
    if ((req.body ?? {})[field] !== undefined) patch[field] = (req.body as any)[field];
  }

  const { error } = await admin.sc
    .from("rent_buddy_launch_checklists")
    .update(patch)
    .eq("id", req.params.id);

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ ok: true });
}));

// POST /api/admin/rent-buddy/qa/checklists/:id/mark-passed
router.post("/admin/rent-buddy/qa/checklists/:id/mark-passed", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const now = new Date().toISOString();
  const passAll: Record<string, unknown> = { updated_at: now, checklist_status: "passed", tested_by_admin_id: admin.userId, tested_at: now };
  for (const f of REQUIRED_CHECKLIST_FIELDS) passAll[f] = true;

  const { data: cl } = await admin.sc
    .from("rent_buddy_launch_checklists")
    .select("city_rollout_id")
    .eq("id", req.params.id)
    .maybeSingle();

  const { error } = await admin.sc
    .from("rent_buddy_launch_checklists")
    .update(passAll)
    .eq("id", req.params.id);

  if (error) return sendError(res, "db_error", error.message);

  await writeAuditLog(admin.sc, {
    adminId:       admin.userId,
    action:        "checklist_marked_passed",
    cityRolloutId: cl ? (cl as any).city_rollout_id : null,
  });

  return res.json({ ok: true });
}));

// POST /api/admin/rent-buddy/qa/checklists/:id/mark-failed
router.post("/admin/rent-buddy/qa/checklists/:id/mark-failed", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { reason } = req.body ?? {};
  const now = new Date().toISOString();

  const { data: cl } = await admin.sc
    .from("rent_buddy_launch_checklists")
    .select("city_rollout_id")
    .eq("id", req.params.id)
    .maybeSingle();

  const { error } = await admin.sc
    .from("rent_buddy_launch_checklists")
    .update({ checklist_status: "failed", notes: reason ?? null, updated_at: now })
    .eq("id", req.params.id);

  if (error) return sendError(res, "db_error", error.message);

  await writeAuditLog(admin.sc, {
    adminId:       admin.userId,
    action:        "checklist_marked_failed",
    cityRolloutId: cl ? (cl as any).city_rollout_id : null,
    metadata:      { reason: reason ?? null },
  });

  return res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — Global Controls
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/rent-buddy/global-controls
router.get("/admin/rent-buddy/global-controls", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const controls = await getGlobalControls(admin.sc);
  // `unavailable` is the honest answer when the singleton row could not be read:
  // the switches in `controls` are then the fail-closed ones this process is
  // ENFORCING, not values an operator set. Saying so keeps the admin UI from
  // reporting "an operator paused the platform" when the truth is "the controls
  // row is unreadable, so bookings are paused until it can be read".
  return res.json({ controls, unavailable: controls?.unavailable === true });
}));

// PATCH /api/admin/rent-buddy/global-controls
router.patch("/admin/rent-buddy/global-controls", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const allowed = [
    "all_bookings_paused", "applications_paused", "cash_balance_paused",
    "nightlife_paused", "force_full_in_app", "force_public_meetup",
  ] as const;

  const patch: Record<string, unknown> = {
    updated_by_admin_id: admin.userId,
    updated_at:          new Date().toISOString(),
  };
  for (const field of allowed) {
    if ((req.body ?? {})[field] !== undefined) patch[field] = (req.body as any)[field];
  }

  // `all_bookings_paused` and its siblings are the platform-wide kill switches
  // for Rent-A-Buddy. This UPDATE targets the singleton row id = 1, and if that
  // row is not there it matches nothing — which PostgREST reports with NO error
  // at all, so neither the missing error check nor the missing affected-row
  // check would have said a word. Worse, getGlobalControls() above falls back to
  // an all-false object when the row is absent, so the switch an admin just
  // "set" reads back as OFF: bookings keep flowing while {ok:true} and a
  // "global_controls_updated" audit row say the platform was paused.
  //
  // `.select("id")` makes the statement RETURNING so the rows it touched can be
  // counted. Nothing touched => refuse, and write no audit row for a pause that
  // did not happen.
  const { data: controlRows, error: controlsErr } = await admin.sc
    .from("rent_buddy_global_controls")
    .update(patch)
    .eq("id", 1)
    .select("id");
  if (controlsErr) { sendError(res, "db_error", controlsErr.message); return; }
  if (!Array.isArray(controlRows) || controlRows.length === 0) {
    req.log?.error(
      { adminId: admin.userId, patch },
      "rent-buddy global controls PATCH matched no row (id = 1 missing) — NO control was changed",
    );
    sendError(
      res,
      "not_found",
      "The rent_buddy_global_controls singleton (id = 1) does not exist, so no control was changed.",
    );
    return;
  }

  invalidateGcCache();

  await writeAuditLog(admin.sc, {
    adminId:  admin.userId,
    action:   "global_controls_updated",
    metadata: { fields: patch },
  });

  return res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — Launch Audit Log
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/rent-buddy/audit-log
router.get("/admin/rent-buddy/audit-log", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res, { roles: ROLLOUT_ADMIN_ROLES });
  if (!admin) return;

  const { cityRolloutId, adminId, action, page = "1", perPage = "50" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const perPageNum = Math.min(200, Math.max(1, parseInt(perPage, 10)));

  let query = admin.sc
    .from("rent_buddy_launch_audit_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((pageNum - 1) * perPageNum, pageNum * perPageNum - 1);

  if (cityRolloutId) query = query.eq("city_rollout_id", cityRolloutId);
  if (adminId)       query = query.eq("admin_id", adminId);
  if (action)        query = query.eq("action", action);

  const { data, count, error } = await query;
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ logs: data ?? [], total: count ?? 0, page: pageNum, perPage: perPageNum });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// USER — Launch Status
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/rent-buddy/launch-status
router.get("/rent-buddy/launch-status", asyncHandler(async (req, res) => {
  const sc = getServiceClient();
  if (!sc) {
    return res.json({ available: false, status: "unknown", message: "Service temporarily unavailable." });
  }

  const { city } = req.query as { city?: string };

  if (!city) {
    // Return all public cities
    const { data } = await sc
      .from("rent_buddy_city_rollouts")
      .select("city, country, status, target_launch_date")
      .order("city", { ascending: true });

    return res.json({
      cities: (data ?? []).map((r: any) => ({
        city:             r.city,
        country:          r.country,
        status:           r.status,
        targetLaunchDate: r.target_launch_date,
        message:          statusToMessage(r.status, r.city),
      })),
    });
  }

  const { data: rollout } = await sc
    .from("rent_buddy_city_rollouts")
    .select("city, country, status, target_launch_date, buddy_cap")
    .ilike("city", city)
    .maybeSingle();

  const status: CityRolloutStatus = rollout ? (rollout as any).status : "disabled";
  const message = statusToMessage(status, city);

  // Single source of truth for "are there real buddies here right now" —
  // same normalized (trimmed, case-insensitive) city match used by
  // /rent-a-buddy/available-now, so this field and that list can never
  // disagree. Callers (Pulse card, landing banner) must use THIS field —
  // not `available` alone — before claiming buddies exist in a city.
  // `available: status === "public_mvp"` means "the city has been rolled
  // out to the public," not "someone is online right now" — those are
  // different facts and must never be merged into a single claim in the UI.
  const trimmedCity = city.trim();
  const { count: availableNowCount } = await sc
    .from("rent_buddy_profiles")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("admin_status", "active")
    .eq("available_now", true)
    .ilike("city", trimmedCity);

  // When the viewer's city is live but has nobody online right now, find the
  // best alternative public_mvp city — the one with the highest
  // available_now count. This lets the UI surface real buddies from elsewhere
  // with honest labelling ("available in Miami") instead of a dead end.
  // Only computed when needed (avoids extra DB work for the common case).
  let suggestedCity: string | null = null;
  let suggestedCityAvailableCount = 0;

  if (status === "public_mvp" && (availableNowCount ?? 0) === 0) {
    const now = Date.now();
    let ranked: RankedCityEntry[];

    if (_scCache && now - _scCacheTs < SC_TTL_MS) {
      // Cache hit — full ranked snapshot already populated; no DB queries needed
      ranked = _scCache;
    } else {
      // Cache miss — query ALL public_mvp cities (no per-requester exclusion),
      // then cache the full ranked list so every caller can derive their own
      // "best other city" without re-running the N-parallel count queries.
      const { data: publicCities } = await sc
        .from("rent_buddy_city_rollouts")
        .select("city")
        .eq("status", "public_mvp");

      if (publicCities && (publicCities as any[]).length > 0) {
        const counts = await Promise.all(
          (publicCities as any[]).map(async (row: any) => {
            const { count } = await sc
              .from("rent_buddy_profiles")
              .select("id", { count: "exact", head: true })
              .eq("status", "active")
              .eq("admin_status", "active")
              .eq("available_now", true)
              .ilike("city", row.city);
            return { city: row.city as string, count: count ?? 0 };
          }),
        );
        counts.sort((a, b) => b.count - a.count);
        ranked = counts;
      } else {
        ranked = [];
      }

      _scCache = ranked;
      _scCacheTs = now;
    }

    // Exclude the requesting city at read time (case-insensitive) so we never
    // suggest the viewer's own city back to them.
    const lowerCity = trimmedCity.toLowerCase();
    const best = ranked.find((e) => e.city.toLowerCase() !== lowerCity && e.count > 0);
    if (best) {
      suggestedCity = best.city;
      suggestedCityAvailableCount = best.count;
    }
  }

  return res.json({
    city,
    status,
    message,
    targetLaunchDate: rollout ? (rollout as any).target_launch_date : null,
    available: status === "public_mvp",
    availableNowCount: availableNowCount ?? 0,
    betaAvailable: status === "beta_testing",
    waitlistOpen: status !== "disabled" && status !== "suspended",
    applicationsOpen: status === "buddy_applications_open" || status === "internal_testing" || status === "beta_testing" || status === "public_mvp",
    /** Populated only when this city is live but has zero available buddies.
     *  The public_mvp city with the highest real availability count among all
     *  other live cities. null when no other city has anyone online either. */
    suggestedCity,
    suggestedCityAvailableCount,
  });
}));

function statusToMessage(status: CityRolloutStatus, city: string): string {
  switch (status) {
    case "disabled":               return `Rent a Buddy is not available in ${city} yet.`;
    case "waitlist_only":          return `Rent a Buddy is coming to ${city} — join the waitlist to be first!`;
    case "buddy_applications_open":return `Rent a Buddy is accepting Buddy applications in ${city}. Traveler bookings open soon.`;
    case "internal_testing":       return `Rent a Buddy is in testing in ${city}. Join the waitlist for beta access.`;
    case "beta_testing":           return `Rent a Buddy is in beta in ${city}. Check your beta invitation status.`;
    case "public_mvp":             return `Rent a Buddy is live in ${city}!`;
    case "paused":                 return `Rent a Buddy in ${city} is temporarily paused. Check back soon.`;
    case "suspended":              return `Rent a Buddy is not available in ${city} at this time.`;
    default:                       return `Rent a Buddy status in ${city} is unknown.`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER — Beta Status
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/rent-buddy/waitlist
// Rollout-aware waitlist join — respects feature flag, city status, and global controls.
router.post("/rent-buddy/waitlist", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const sc = getServiceClient() ?? auth.client;
  const { city, category } = req.body ?? {};

  if (!city) return sendError(res, "invalid_payload", "city is required.");

  const access = await checkRentBuddyAccess({
    sc, userId: auth.user.id, city, category: category ?? null, action: "waitlist",
  });
  if (!access.allowed) {
    return res.status(access.httpStatus).json({ error: access.code, message: access.message });
  }

  await sc
    .from("rent_buddy_waitlist")
    .upsert({ user_id: auth.user.id, city, category: category ?? null }, { onConflict: "user_id,city" });

  return res.status(201).json({ ok: true, city, inWaitlist: true });
}));

// GET /api/rent-buddy/me/beta-status
router.get("/rent-buddy/me/beta-status", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const sc = getServiceClient() ?? auth.client;
  const { city } = req.query as { city?: string };

  let query = sc
    .from("rent_buddy_beta_access")
    .select("id, city, access_type, status, created_at")
    .eq("user_id", auth.user.id)
    .eq("status", "active");

  if (city) query = query.ilike("city", city);

  const { data } = await query;

  return res.json({
    hasBetaAccess: (data ?? []).length > 0,
    access:        data ?? [],
  });
}));

export default router;
