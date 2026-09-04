/**
 * OpenToPlansService — Passport spec §8 Open-to-Plans / Temporary Intent.
 *
 * This is the §8 `AvailabilityWindow` domain (TABLE 8), which is DISTINCT from
 * the §6 weekly grid (`user_availability`) and the four-value quick status
 * (`quick_availability_status`). Those answer "Can I do something?"; a window
 * answers "Do I want social invitations, when, for what, with whom, and how far
 * will I travel?" — and it EXPIRES.
 *
 * Two rules are load-bearing and enforced here as well as in migration 2260:
 *
 *   §7  Only an EXPLICIT answer becomes public/shared availability. Inference
 *       may create a PRIVATE window that triggers a "Free tonight?" prompt, but
 *       a `plan_derived` window can never be public/shared. `projectPublicWindows`
 *       returns explicit windows only, and `recordInferredWindow` pins the
 *       window to source='plan_derived' + visibility='private'.
 *
 *   §31 Never render stale availability as current. Expiry is re-evaluated on
 *       every read against COALESCE(expiresAt, endAt); a window past that horizon
 *       is never returned as active or public, regardless of any sweep.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "OpenToPlansService" });

// ── Closed sets (mirror the CHECK constraints in migration 2260) ───────────────

export const WINDOW_TYPES = ["recurring", "trip", "one_time", "derived"] as const;
export type WindowType = (typeof WINDOW_TYPES)[number];

export const INTENT_TYPES = ["Food", "Drinks", "Nightlife", "Explore", "Events", "MeetTravelers"] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

export const GROUP_PREFERENCES = ["solo", "one_on_one", "small_group", "crew_only", "large_group", "any"] as const;
export type GroupPreference = (typeof GROUP_PREFERENCES)[number];

export const VISIBILITY_POLICIES = ["public", "followers", "following", "crew", "private"] as const;
export type VisibilityPolicy = (typeof VISIBILITY_POLICIES)[number];

export const WINDOW_SOURCES = ["explicit", "plan_derived"] as const;
export type WindowSource = (typeof WINDOW_SOURCES)[number];

/** TABLE 10 SocialAvailability enum surface. */
export const SOCIAL_AVAILABILITY = ["open", "maybe", "crew_only", "following_only", "not_open"] as const;
export type SocialAvailability = (typeof SOCIAL_AVAILABILITY)[number];

/** Viewer relationship used when projecting another traveler's windows. */
export type ViewerRelationship = "self" | "public" | "follower" | "following" | "crew";

// ── Model (TABLE 8) ────────────────────────────────────────────────────────────

export interface AvailabilityWindow {
  id: string;
  userId: string;
  type: WindowType;
  startAt: string;
  endAt: string;
  tripId: string | null;
  openToPlans: boolean;
  intents: IntentType[];
  groupPreference: GroupPreference | null;
  maxTravelMinutes: number | null;
  visibility: VisibilityPolicy;
  source: WindowSource;
  socialAvailability: SocialAvailability | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWindowInput {
  userId: string;
  type: WindowType;
  startAt: string;
  endAt: string;
  tripId?: string | null;
  openToPlans?: boolean;
  intents?: IntentType[];
  groupPreference?: GroupPreference | null;
  maxTravelMinutes?: number | null;
  visibility?: VisibilityPolicy;
  /** §7: defaults to 'explicit'. Only 'explicit' windows can be public/shared. */
  source?: WindowSource;
  socialAvailability?: SocialAvailability | null;
  expiresAt?: string | null;
}

export interface UpdateWindowInput {
  openToPlans?: boolean;
  intents?: IntentType[];
  groupPreference?: GroupPreference | null;
  maxTravelMinutes?: number | null;
  visibility?: VisibilityPolicy;
  socialAvailability?: SocialAvailability | null;
  endAt?: string;
  expiresAt?: string | null;
}

const SELECT_COLS =
  "id, user_id, type, start_at, end_at, trip_id, open_to_plans, intents, group_preference, max_travel_minutes, visibility, source, social_availability, expires_at, created_at, updated_at";

// ── Row ↔ model ────────────────────────────────────────────────────────────────

export function rowToWindow(row: any): AvailabilityWindow {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    startAt: row.start_at,
    endAt: row.end_at,
    tripId: row.trip_id ?? null,
    openToPlans: Boolean(row.open_to_plans),
    intents: Array.isArray(row.intents) ? (row.intents as IntentType[]) : [],
    groupPreference: row.group_preference ?? null,
    maxTravelMinutes: row.max_travel_minutes ?? null,
    visibility: row.visibility,
    source: row.source,
    socialAvailability: row.social_availability ?? null,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Pure expiry / visibility helpers (§7, §31) — no DB, unit-testable ──────────

/** The instant a window stops being current: its TTL if set, else its end. */
export function effectiveExpiry(w: Pick<AvailabilityWindow, "endAt" | "expiresAt">): number {
  const end = Date.parse(w.endAt);
  if (w.expiresAt) {
    const ttl = Date.parse(w.expiresAt);
    return Number.isNaN(ttl) ? end : Math.min(end, ttl);
  }
  return end;
}

/** §31: a window is expired once now >= COALESCE(expiresAt, endAt). */
export function isExpired(w: Pick<AvailabilityWindow, "endAt" | "expiresAt">, nowMs: number): boolean {
  return nowMs >= effectiveExpiry(w);
}

/** Active = has started and has not expired. */
export function isActive(w: Pick<AvailabilityWindow, "startAt" | "endAt" | "expiresAt">, nowMs: number): boolean {
  return !isExpired(w, nowMs) && Date.parse(w.startAt) <= nowMs;
}

/** Does this visibility policy admit the given viewer relationship? */
export function visibilityAdmits(visibility: VisibilityPolicy, viewer: ViewerRelationship): boolean {
  if (viewer === "self") return true;
  switch (visibility) {
    case "public": return true;
    case "followers": return viewer === "follower";
    case "following": return viewer === "following";
    case "crew": return viewer === "crew";
    case "private": return false;
    default: return false;
  }
}

/**
 * §7 in one predicate: a window is publicly/shared-visible to `viewer` only if
 * its source is EXPLICIT, it is not expired, and its visibility admits the
 * viewer. An inferred (plan_derived) window is never visible to anyone but self,
 * no matter what visibility value it carries.
 */
export function isVisibleTo(
  w: Pick<AvailabilityWindow, "startAt" | "endAt" | "expiresAt" | "source" | "visibility">,
  viewer: ViewerRelationship,
  nowMs: number,
): boolean {
  if (viewer === "self") return !isExpired(w, nowMs);
  if (w.source !== "explicit") return false; // §7: inferred never becomes public/shared
  if (isExpired(w, nowMs)) return false;      // §31: never render stale as current
  return visibilityAdmits(w.visibility, viewer);
}

// ── Validation (mirrors 2260 CHECKs; used before insert/update) ────────────────

export interface ValidationResult { ok: boolean; error?: string }

export function validateCreate(input: CreateWindowInput): ValidationResult {
  if (!WINDOW_TYPES.includes(input.type)) return { ok: false, error: "invalid type" };
  const start = Date.parse(input.startAt);
  const end = Date.parse(input.endAt);
  if (Number.isNaN(start)) return { ok: false, error: "invalid startAt" };
  if (Number.isNaN(end)) return { ok: false, error: "invalid endAt" };
  if (end <= start) return { ok: false, error: "endAt must be after startAt" };
  if (input.expiresAt != null) {
    const exp = Date.parse(input.expiresAt);
    if (Number.isNaN(exp)) return { ok: false, error: "invalid expiresAt" };
    if (exp < start) return { ok: false, error: "expiresAt cannot predate startAt" };
  }
  for (const i of input.intents ?? []) {
    if (!INTENT_TYPES.includes(i)) return { ok: false, error: `invalid intent: ${i}` };
  }
  if (input.groupPreference != null && !GROUP_PREFERENCES.includes(input.groupPreference)) {
    return { ok: false, error: "invalid groupPreference" };
  }
  if (input.maxTravelMinutes != null && (!Number.isInteger(input.maxTravelMinutes) || input.maxTravelMinutes <= 0 || input.maxTravelMinutes > 1440)) {
    return { ok: false, error: "maxTravelMinutes must be 1..1440" };
  }
  const visibility = input.visibility ?? "private";
  if (!VISIBILITY_POLICIES.includes(visibility)) return { ok: false, error: "invalid visibility" };
  const source = input.source ?? "explicit";
  if (!WINDOW_SOURCES.includes(source)) return { ok: false, error: "invalid source" };
  if (input.socialAvailability != null && !SOCIAL_AVAILABILITY.includes(input.socialAvailability)) {
    return { ok: false, error: "invalid socialAvailability" };
  }
  // §7 backstop: an inferred window can never be public/shared.
  if (source !== "explicit" && visibility !== "private") {
    return { ok: false, error: "inferred windows must be private (§7)" };
  }
  return { ok: true };
}

// ── CRUD ───────────────────────────────────────────────────────────────────────

/**
 * Create an availability window. Returns the created window or null on failure.
 * Validation runs first; an invalid input never reaches the DB.
 */
export async function createWindow(
  db: SupabaseClient,
  input: CreateWindowInput,
): Promise<{ window: AvailabilityWindow | null; error?: string }> {
  const v = validateCreate(input);
  if (!v.ok) return { window: null, error: v.error };

  const now = new Date().toISOString();
  const row = {
    user_id: input.userId,
    type: input.type,
    start_at: input.startAt,
    end_at: input.endAt,
    trip_id: input.tripId ?? null,
    open_to_plans: input.openToPlans ?? false,
    intents: input.intents ?? [],
    group_preference: input.groupPreference ?? null,
    max_travel_minutes: input.maxTravelMinutes ?? null,
    visibility: input.visibility ?? "private",
    source: input.source ?? "explicit",
    social_availability: input.socialAvailability ?? null,
    expires_at: input.expiresAt ?? null,
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await db
    .from("availability_windows")
    .insert(row)
    .select(SELECT_COLS)
    .single();

  if (error) {
    logger.error({ table: "availability_windows", op: "insert", message: error.message }, "createWindow failed");
    return { window: null, error: "db_error" };
  }
  return { window: rowToWindow(data) };
}

/**
 * §7 inference path: record an INFERRED window that is always private and always
 * source='plan_derived', and report whether a "Free tonight?" prompt should be
 * surfaced. The window is NOT public and NOT shared — it only exists so the app
 * can ask the traveler; an explicit answer (createWindow with source='explicit')
 * is what actually becomes public availability.
 */
export async function recordInferredWindow(
  db: SupabaseClient,
  input: Omit<CreateWindowInput, "source" | "visibility"> & { promptLabel?: string },
): Promise<{ window: AvailabilityWindow | null; prompt: { kind: "free_tonight"; label: string } | null; error?: string }> {
  const { window, error } = await createWindow(db, {
    ...input,
    source: "plan_derived",
    visibility: "private", // §7: inference stays private, never public/shared
  });
  if (!window) return { window: null, prompt: null, error };
  return {
    window,
    prompt: { kind: "free_tonight", label: input.promptLabel ?? "Free tonight?" },
  };
}

/**
 * List a user's OWN windows. Expired windows are omitted by default (§31); pass
 * includeExpired to see the full history. Sorted soonest-ending first.
 */
export async function listWindows(
  db: SupabaseClient,
  userId: string,
  opts: { includeExpired?: boolean; nowMs?: number } = {},
): Promise<AvailabilityWindow[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const { data, error } = await db
    .from("availability_windows")
    .select(SELECT_COLS)
    .eq("user_id", userId);

  if (error) {
    logger.error({ table: "availability_windows", op: "select", message: error.message }, "listWindows failed");
    return [];
  }
  let windows = (data ?? []).map(rowToWindow);
  if (!opts.includeExpired) windows = windows.filter((w) => !isExpired(w, nowMs));
  windows.sort((a, b) => effectiveExpiry(a) - effectiveExpiry(b));
  return windows;
}

/** A user's currently-ACTIVE windows (started and not expired). */
export async function getActiveWindows(
  db: SupabaseClient,
  userId: string,
  nowMs: number = Date.now(),
): Promise<AvailabilityWindow[]> {
  const windows = await listWindows(db, userId, { includeExpired: true, nowMs });
  return windows.filter((w) => isActive(w, nowMs));
}

/**
 * Project another traveler's windows for a viewer. §7 + §31: only EXPLICIT,
 * non-expired windows whose visibility admits the viewer are returned. An
 * inferred window is never returned to a non-self viewer.
 */
export async function projectPublicWindows(
  db: SupabaseClient,
  ownerId: string,
  viewer: ViewerRelationship,
  nowMs: number = Date.now(),
): Promise<AvailabilityWindow[]> {
  const windows = await listWindows(db, ownerId, { includeExpired: true, nowMs });
  return windows
    .filter((w) => isVisibleTo(w, viewer, nowMs))
    .sort((a, b) => effectiveExpiry(a) - effectiveExpiry(b));
}

/**
 * Update an owner's window. Owner-scoped: the update only touches a row that
 * belongs to userId. Returns the updated window or null.
 */
export async function updateWindow(
  db: SupabaseClient,
  windowId: string,
  userId: string,
  patch: UpdateWindowInput,
): Promise<{ window: AvailabilityWindow | null; error?: string }> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (patch.openToPlans !== undefined) update.open_to_plans = patch.openToPlans;
  if (patch.intents !== undefined) {
    for (const i of patch.intents) if (!INTENT_TYPES.includes(i)) return { window: null, error: `invalid intent: ${i}` };
    update.intents = patch.intents;
  }
  if (patch.groupPreference !== undefined) {
    if (patch.groupPreference != null && !GROUP_PREFERENCES.includes(patch.groupPreference)) return { window: null, error: "invalid groupPreference" };
    update.group_preference = patch.groupPreference;
  }
  if (patch.maxTravelMinutes !== undefined) {
    if (patch.maxTravelMinutes != null && (!Number.isInteger(patch.maxTravelMinutes) || patch.maxTravelMinutes <= 0 || patch.maxTravelMinutes > 1440)) {
      return { window: null, error: "maxTravelMinutes must be 1..1440" };
    }
    update.max_travel_minutes = patch.maxTravelMinutes;
  }
  if (patch.visibility !== undefined) {
    if (!VISIBILITY_POLICIES.includes(patch.visibility)) return { window: null, error: "invalid visibility" };
    update.visibility = patch.visibility;
  }
  if (patch.socialAvailability !== undefined) {
    if (patch.socialAvailability != null && !SOCIAL_AVAILABILITY.includes(patch.socialAvailability)) return { window: null, error: "invalid socialAvailability" };
    update.social_availability = patch.socialAvailability;
  }
  if (patch.endAt !== undefined) {
    if (Number.isNaN(Date.parse(patch.endAt))) return { window: null, error: "invalid endAt" };
    update.end_at = patch.endAt;
  }
  if (patch.expiresAt !== undefined) {
    if (patch.expiresAt != null && Number.isNaN(Date.parse(patch.expiresAt))) return { window: null, error: "invalid expiresAt" };
    update.expires_at = patch.expiresAt;
  }

  if (Object.keys(update).length === 1) return { window: null, error: "no fields to update" };

  const { data, error } = await db
    .from("availability_windows")
    .update(update)
    .eq("id", windowId)
    .eq("user_id", userId)
    .select(SELECT_COLS)
    .maybeSingle();

  if (error) {
    logger.error({ table: "availability_windows", op: "update", message: error.message }, "updateWindow failed");
    return { window: null, error: "db_error" };
  }
  if (!data) return { window: null, error: "not_found" };
  return { window: rowToWindow(data) };
}

/**
 * Explicit clear (§8 "explicit clear action"): delete an owner's window. Returns
 * true when a row was removed. Owner-scoped by the user_id filter.
 */
export async function clearWindow(
  db: SupabaseClient,
  windowId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("availability_windows")
    .delete()
    .eq("id", windowId)
    .eq("user_id", userId)
    .select("id");

  if (error) {
    logger.error({ table: "availability_windows", op: "delete", message: error.message }, "clearWindow failed");
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}
