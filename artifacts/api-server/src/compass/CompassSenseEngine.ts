/**
 * CompassSenseEngine — Phase 11: Compass Sense.
 *
 * Proactive intelligence that stays quiet most of the time and speaks only
 * when genuinely useful. Every candidate nudge is grounded in verifiable data
 * already in the system — no scheduled spam, no fabricated triggers.
 *
 * Signal evaluators (all real-data only):
 *   - saved_event_starting — an event the user explicitly saved starts within
 *     the next 2 hours (events + event_saves).
 *   - leave_earlier        — a pending route stop has a planned arrival time
 *     the remaining walking/travel legs cannot meet (route_plans/stops/legs).
 *   - weather_change       — the user's in-progress trip has plan items today
 *     and the live Open-Meteo forecast says rain (or a clear window after a
 *     rainy stretch); weather nudges only fire when there are real plans they
 *     affect.
 *   - circle_plan_change   — a meetup the user RSVPed to was cancelled or
 *     confirmed within the last 2 hours (meetups + meetup_invites).
 *   - free_time_block      — the user is on an in-progress trip, it's daytime,
 *     and no plan item starts within the next 3 hours (trip_plan_items).
 *
 * Presence levels (user-controlled, enforced server-side):
 *   - passive — Sense is silent. Nothing is evaluated or sent.
 *   - aware   — only time-critical categories may deliver (timing, events,
 *               weather), capped at AWARE_DAILY_CAP per day.
 *   - active  — all categories may deliver, capped at ACTIVE_DAILY_CAP.
 *
 * Per-category permissions are honored server-side before anything is sent;
 * a category the user turned off never delivers regardless of presence level.
 *
 * Over-notification protections:
 *   - dedupe: each nudge carries a dedupe key; the same key never delivers
 *     twice within DEDUPE_WINDOW_MS (durable via compass_sense_nudges).
 *   - daily caps per presence level (see above).
 *   - quiet hours: the user's notification_preferences quiet window silences
 *     all Sense nudges (none of them are safety-critical).
 *
 * Confidence: every nudge carries a Phase 8 confidence label (makeConfidence)
 * reflecting its data source class.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { makeConfidence, type Confidence } from "../lib/liveIntelligence.js";
import { isQuietHours } from "./CompassNotificationEngine.js";
import { getWeatherContext } from "../lib/weatherCache.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter } from "../services/notifications/NotificationRouter.js";
import { fetchUserTimezone, localHourFor, nowUtcInstant } from "../lib/localTime.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PresenceLevel = "passive" | "aware" | "active";

export const SENSE_CATEGORIES = [
  "timing",
  "events",
  "weather",
  "circle",
  "free_time",
] as const;
export type SenseCategory = (typeof SENSE_CATEGORIES)[number];

/** Categories allowed at the "aware" presence level (time-critical only). */
export const AWARE_CATEGORIES: ReadonlySet<SenseCategory> = new Set([
  "timing",
  "events",
  "weather",
]);

export const AWARE_DAILY_CAP = 3;
export const ACTIVE_DAILY_CAP = 6;
export const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface SenseSettings {
  presenceLevel: PresenceLevel;
  categories: Record<SenseCategory, boolean>;
}

export interface CandidateNudge {
  type:
    | "saved_event_starting"
    | "leave_earlier"
    | "weather_change"
    | "circle_plan_change"
    | "free_time_block";
  category: SenseCategory;
  dedupeKey: string;
  title: string;
  body: string;
  /** Deep link into a real surface (event screen, route, trip plan, meetup). */
  actionUrl: string;
  confidence: Confidence;
}

export interface SuppressedNudge {
  dedupeKey: string;
  type: string;
  reason:
    | "presence_passive"
    | "presence_aware_category"
    | "category_disabled"
    | "quiet_hours"
    | "duplicate"
    | "daily_cap";
}

export interface SenseRunResult {
  presenceLevel: PresenceLevel;
  evaluated: number;
  delivered: CandidateNudge[];
  suppressed: SuppressedNudge[];
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function defaultSenseSettings(): SenseSettings {
  return {
    presenceLevel: "passive",
    categories: {
      timing: true,
      events: true,
      weather: true,
      circle: true,
      free_time: true,
    },
  };
}

export async function getSenseSettings(
  sc: SupabaseClient,
  userId: string,
): Promise<SenseSettings> {
  try {
    const { data } = await sc
      .from("compass_sense_settings")
      .select("presence_level, categories")
      .eq("user_id", userId)
      .maybeSingle();
    const defaults = defaultSenseSettings();
    if (!data) return defaults;
    const row = data as any;
    const level = ["passive", "aware", "active"].includes(row.presence_level)
      ? (row.presence_level as PresenceLevel)
      : "passive";
    const cats = { ...defaults.categories };
    const stored = (row.categories ?? {}) as Record<string, unknown>;
    for (const c of SENSE_CATEGORIES) {
      if (typeof stored[c] === "boolean") cats[c] = stored[c] as boolean;
    }
    return { presenceLevel: level, categories: cats };
  } catch {
    return defaultSenseSettings();
  }
}

export async function upsertSenseSettings(
  sc: SupabaseClient,
  userId: string,
  patch: { presenceLevel?: PresenceLevel; categories?: Partial<Record<SenseCategory, boolean>> },
): Promise<SenseSettings> {
  const current = await getSenseSettings(sc, userId);
  const next: SenseSettings = {
    presenceLevel: patch.presenceLevel ?? current.presenceLevel,
    categories: { ...current.categories },
  };
  for (const c of SENSE_CATEGORIES) {
    const v = patch.categories?.[c];
    if (typeof v === "boolean") next.categories[c] = v;
  }
  await sc.from("compass_sense_settings").upsert(
    {
      user_id: userId,
      presence_level: next.presenceLevel,
      categories: next.categories,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  return next;
}

// ── Signal evaluators ─────────────────────────────────────────────────────────

const SAVED_EVENT_WINDOW_MS = 2 * 60 * 60 * 1_000;
const LEAVE_EARLIER_HORIZON_MS = 3 * 60 * 60 * 1_000;
const LEAVE_EARLIER_BUFFER_MS = 10 * 60 * 1_000;
const CIRCLE_CHANGE_WINDOW_MS = 2 * 60 * 60 * 1_000;
const FREE_BLOCK_MIN_GAP_MS = 3 * 60 * 60 * 1_000;

function timeLabel(iso: string): string {
  try {
    const d = new Date(iso);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`;
  } catch {
    return "soon";
  }
}

/** Saved events starting within the next 2 hours. */
async function evalSavedEventStarting(
  sc: SupabaseClient,
  userId: string,
  nowMs: number,
): Promise<CandidateNudge[]> {
  try {
    const { data: saves } = await sc
      .from("event_saves")
      .select("event_id")
      .eq("user_id", userId);
    const ids = ((saves ?? []) as any[]).map((r) => String(r.event_id));
    if (ids.length === 0) return [];

    const fromIso = new Date(nowMs).toISOString();
    const toIso = new Date(nowMs + SAVED_EVENT_WINDOW_MS).toISOString();
    const { data: events } = await sc
      .from("events")
      .select("id, title, starts_at, state")
      .in("id", ids)
      .gte("starts_at", fromIso)
      .lte("starts_at", toIso);

    return ((events ?? []) as any[])
      .filter((e) => !["cancelled", "deleted", "banned"].includes(String(e.state ?? "")))
      .map((e) => ({
        type: "saved_event_starting" as const,
        category: "events" as const,
        dedupeKey: `event_start:${e.id}`,
        title: "Saved event starting soon",
        body: `${e.title} starts at ${timeLabel(String(e.starts_at))}.`,
        actionUrl: `/event/${e.id}`,
        confidence: makeConfidence("verified_live", "Event time from the host's listing"),
      }));
  } catch {
    return [];
  }
}

/** Pending route stops whose planned arrival the remaining legs can't meet. */
async function evalLeaveEarlier(
  sc: SupabaseClient,
  userId: string,
  nowMs: number,
): Promise<CandidateNudge[]> {
  try {
    const { data: plans } = await sc
      .from("route_plans")
      .select("id, title")
      .eq("owner_user_id", userId);
    const out: CandidateNudge[] = [];

    for (const plan of ((plans ?? []) as any[]).slice(0, 5)) {
      const [{ data: stops }, { data: legs }] = await Promise.all([
        sc
          .from("route_stops")
          .select("id, title, order_index, checkpoint_status, planned_arrival_time")
          .eq("route_plan_id", plan.id),
        sc
          .from("route_legs")
          .select("to_stop_id, duration_seconds")
          .eq("route_plan_id", plan.id),
      ]);
      const durByStop = new Map(
        ((legs ?? []) as any[]).map((l) => [String(l.to_stop_id), Number(l.duration_seconds ?? 0)]),
      );
      const pending = ((stops ?? []) as any[])
        .filter((s) => s.checkpoint_status === "pending" && s.planned_arrival_time)
        .sort((a, b) => Number(a.order_index ?? 0) - Number(b.order_index ?? 0));

      for (const stop of pending) {
        const arriveMs = new Date(String(stop.planned_arrival_time)).getTime();
        if (!Number.isFinite(arriveMs)) continue;
        if (arriveMs <= nowMs || arriveMs - nowMs > LEAVE_EARLIER_HORIZON_MS) continue;
        const travelMs = (durByStop.get(String(stop.id)) ?? 0) * 1_000;
        if (travelMs <= 0) continue;
        // Genuine signal only: travel time + buffer exceeds time remaining.
        if (travelMs + LEAVE_EARLIER_BUFFER_MS > arriveMs - nowMs) {
          const shortMin = Math.ceil((travelMs + LEAVE_EARLIER_BUFFER_MS - (arriveMs - nowMs)) / 60_000);
          out.push({
            type: "leave_earlier",
            category: "timing",
            dedupeKey: `leave_earlier:${stop.id}`,
            title: "Leave earlier to make your next stop",
            body: `Travel to ${stop.title} takes longer than the time left — head out about ${shortMin} min earlier.`,
            actionUrl: `/route-plan/${plan.id}`,
            confidence: makeConfidence("verified_live", "Based on your route's planned times and travel legs"),
          });
          break; // one timing nudge per plan is enough
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Fetch the user's in-progress trip (accepted membership). */
async function fetchActiveTrip(
  sc: SupabaseClient,
  userId: string,
): Promise<{ id: string; city: string | null } | null> {
  try {
    const [{ data: memberRows }, { data: ownedRows }] = await Promise.all([
      sc.from("trip_members").select("trip_id").eq("user_id", userId).in("role", ["owner", "member"]),
      sc.from("trips").select("id").eq("owner_id", userId),
    ]);
    const tripIds = Array.from(new Set([
      ...((memberRows ?? []) as any[]).map((r) => String(r.trip_id)),
      ...((ownedRows ?? []) as any[]).map((r) => String(r.id)),
    ]));
    if (tripIds.length === 0) return null;
    const { data: trips } = await sc
      .from("trips")
      .select("id, destination_city, status")
      .in("id", tripIds)
      // `in_progress` is not a label of the `trip_status` enum (draft |
      // planning | upcoming | active | completed | cancelled | archived), so
      // PostgREST rejected the literal 22P02 and this read failed whole — the
      // two trip-grounded Sense nudges could never fire. `active` is the label
      // every other current-trip reader uses.
      .eq("status", "active")
      .limit(1);
    const t = ((trips ?? []) as any[])[0];
    if (!t) return null;
    return { id: String(t.id), city: (t.destination_city as string | null) ?? null };
  } catch {
    return null;
  }
}

/** Today's plan items for a trip (non-cancelled, not removed). */
async function fetchTodayPlanItems(
  sc: SupabaseClient,
  tripId: string,
  today: string,
): Promise<Array<{ id: string; starts_at: string | null }>> {
  try {
    const { data } = await sc
      .from("trip_plan_items")
      .select("id, starts_at, status, day_date, removed_at")
      .eq("trip_id", tripId)
      .eq("day_date", today);
    return ((data ?? []) as any[])
      .filter((i) => i.status !== "cancelled" && i.removed_at == null)
      .map((i) => ({ id: String(i.id), starts_at: (i.starts_at as string | null) ?? null }));
  } catch {
    return [];
  }
}

/**
 * Weather change vs plans: only fires when the user has real plan items today
 * on an in-progress trip AND the live forecast is notable (rain incoming, or
 * clear after rain). No plans → silence; no forecast → silence.
 */
async function evalWeatherChange(
  sc: SupabaseClient,
  userId: string,
  nowMs: number,
): Promise<CandidateNudge[]> {
  const trip = await fetchActiveTrip(sc, userId);
  if (!trip || !trip.city) return [];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const items = await fetchTodayPlanItems(sc, trip.id, today);
  if (items.length === 0) return [];

  const wx = await getWeatherContext(trip.city, today, today).catch(() => null);
  const f = wx?.forecasts?.find((d) => d.date === today) ?? wx?.forecasts?.[0];
  if (!f) return [];

  const rainy = f.precipMm > 2 || f.weatherCode >= 51;
  const clear = f.weatherCode <= 3 && f.precipMm <= 0.5;
  if (rainy) {
    return [{
      type: "weather_change",
      category: "weather",
      dedupeKey: `weather:${trip.id}:${today}:rain`,
      title: `Rain expected in ${trip.city} today`,
      body: `${f.summary} with ${f.precipMm} mm forecast — your plans today may need an indoor backup.`,
      actionUrl: `/trip/${trip.id}`,
      confidence: makeConfidence("verified_live", "Open-Meteo forecast for today"),
    }];
  }
  if (clear) {
    return [{
      type: "weather_change",
      category: "weather",
      dedupeKey: `weather:${trip.id}:${today}:clear`,
      title: `Clear skies in ${trip.city}`,
      body: `${f.summary}, ${f.minTempC}–${f.maxTempC}°C — a good window for today's plans.`,
      actionUrl: `/trip/${trip.id}`,
      confidence: makeConfidence("verified_live", "Open-Meteo forecast for today"),
    }];
  }
  return [];
}

/** Meetups the user RSVPed to that were cancelled/confirmed in the last 2h. */
async function evalCirclePlanChange(
  sc: SupabaseClient,
  userId: string,
  nowMs: number,
): Promise<CandidateNudge[]> {
  try {
    const { data: rsvps } = await sc
      .from("meetup_invites")
      .select("meetup_id, status")
      .eq("user_id", userId)
      .in("status", ["going", "maybe"]);
    const ids = ((rsvps ?? []) as any[]).map((r) => String(r.meetup_id));
    if (ids.length === 0) return [];

    const sinceIso = new Date(nowMs - CIRCLE_CHANGE_WINDOW_MS).toISOString();
    const { data: meetups } = await sc
      .from("meetups")
      .select("id, title, status, updated_at")
      .in("id", ids)
      .gte("updated_at", sinceIso);

    return ((meetups ?? []) as any[])
      .filter((m) => ["cancelled", "confirmed"].includes(String(m.status ?? "")))
      .map((m) => ({
        type: "circle_plan_change" as const,
        category: "circle" as const,
        dedupeKey: `meetup:${m.id}:${m.status}`,
        title: m.status === "cancelled" ? "A meetup you joined was cancelled" : "Your meetup is confirmed",
        body: `${m.title} is now ${m.status}.`,
        actionUrl: `/meetup/${m.id}`,
        confidence: makeConfidence("verified_live", "Meetup status change from the organiser"),
      }));
  } catch {
    return [];
  }
}

/**
 * Free time block: in-progress trip, daytime (09–22 local-ish via UTC hour
 * hook), and no plan item starting within the next 3 hours.
 */
async function evalFreeTimeBlock(
  sc: SupabaseClient,
  userId: string,
  nowMs: number,
  hourUtc: number,
): Promise<CandidateNudge[]> {
  if (hourUtc < 9 || hourUtc >= 22) return [];
  const trip = await fetchActiveTrip(sc, userId);
  if (!trip) return [];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const items = await fetchTodayPlanItems(sc, trip.id, today);
  // A free block is only meaningful on a day that HAS a plan — an entirely
  // unplanned day is normal, not a signal.
  const timed = items.filter((i) => i.starts_at).map((i) => new Date(i.starts_at!).getTime());
  if (timed.length === 0) return [];
  const upcoming = timed.filter((t) => t > nowMs).sort((a, b) => a - b);
  const nextMs = upcoming[0] ?? null;
  const gapMs = nextMs === null ? Infinity : nextMs - nowMs;
  if (gapMs < FREE_BLOCK_MIN_GAP_MS) return [];
  const gapLabel = nextMs === null
    ? "the rest of today"
    : `about ${Math.floor(gapMs / 3_600_000)} hours`;
  return [{
    type: "free_time_block",
    category: "free_time",
    dedupeKey: `free_time:${trip.id}:${today}`,
    title: "You have a free block today",
    body: `Nothing on your plan for ${gapLabel} — want ideas nearby?`,
    actionUrl: `/trip/${trip.id}`,
    confidence: makeConfidence("ai_inference", "Inferred from gaps in your trip plan"),
  }];
}

/** Run all evaluators over real data. Returns candidate nudges only. */
export async function evaluateSenseSignals(
  sc: SupabaseClient,
  userId: string,
  opts: { nowMs?: number; hourUtc?: number } = {},
): Promise<CandidateNudge[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const nowUtc = new Date(nowMs);
  const hourUtc = opts.hourUtc !== undefined
    ? opts.hourUtc
    : localHourFor(nowUtc, null, await fetchUserTimezone(sc, userId));
  const results = await Promise.all([
    evalSavedEventStarting(sc, userId, nowMs),
    evalLeaveEarlier(sc, userId, nowMs),
    evalWeatherChange(sc, userId, nowMs),
    evalCirclePlanChange(sc, userId, nowMs),
    evalFreeTimeBlock(sc, userId, nowMs, hourUtc),
  ]);
  return results.flat();
}

// ── Delivery gate + throttling ────────────────────────────────────────────────

async function loadQuietWindow(
  sc: SupabaseClient,
  userId: string,
): Promise<{ start: string; end: string; timezone: string | null } | null> {
  try {
    const { data } = await sc
      .from("notification_preferences")
      .select("quiet_hours_enabled, quiet_start, quiet_end, timezone")
      .eq("user_id", userId)
      .maybeSingle();
    const row = data as any;
    if (!row || row.quiet_hours_enabled !== true) return null;
    if (typeof row.quiet_start !== "string" || typeof row.quiet_end !== "string") return null;
    return { start: row.quiet_start, end: row.quiet_end, timezone: row.timezone ?? null };
  } catch {
    return null;
  }
}

async function isDuplicateNudge(
  sc: SupabaseClient,
  userId: string,
  dedupeKey: string,
  nowMs: number,
): Promise<boolean> {
  try {
    const sinceIso = new Date(nowMs - DEDUPE_WINDOW_MS).toISOString();
    const { data } = await sc
      .from("compass_sense_nudges")
      .select("id")
      .eq("user_id", userId)
      .eq("dedupe_key", dedupeKey)
      .gte("created_at", sinceIso)
      .limit(1);
    return ((data ?? []) as any[]).length > 0;
  } catch {
    return false;
  }
}

async function countDeliveredToday(
  sc: SupabaseClient,
  userId: string,
  nowMs: number,
): Promise<number> {
  try {
    const startOfDayIso = new Date(nowMs).toISOString().slice(0, 10) + "T00:00:00.000Z";
    const { data } = await sc
      .from("compass_sense_nudges")
      .select("id")
      .eq("user_id", userId)
      .gte("created_at", startOfDayIso);
    return ((data ?? []) as any[]).length;
  } catch {
    return 0;
  }
}

/**
 * Evaluate + gate + throttle + deliver for one user.
 *
 * Order of enforcement (server-side, before anything is sent):
 *   presence level → per-category permission → quiet hours → dedupe → daily cap.
 * Survivors are persisted to compass_sense_nudges and delivered through the
 * existing notification pathway (NotificationService + NotificationRouter).
 */
export async function runSense(
  sc: SupabaseClient,
  userId: string,
  opts: { nowMs?: number; hourUtc?: number; nowMinutes?: number } = {},
): Promise<SenseRunResult> {
  const nowMs = opts.nowMs ?? Date.now();
  // Resolve the traveler's local hour (stored timezone → UTC fallback) when
  // the caller hasn't supplied an explicit override.
  const nowUtc = new Date(nowMs);
  const resolvedHourUtc = opts.hourUtc !== undefined
    ? opts.hourUtc
    : localHourFor(nowUtc, null, await fetchUserTimezone(sc, userId));
  const resolvedOpts = { ...opts, hourUtc: resolvedHourUtc };
  const settings = await getSenseSettings(sc, userId);

  // Passive = silent. Nothing is evaluated, nothing is sent.
  if (settings.presenceLevel === "passive") {
    return { presenceLevel: "passive", evaluated: 0, delivered: [], suppressed: [] };
  }

  const candidates = await evaluateSenseSignals(sc, userId, resolvedOpts);
  const delivered: CandidateNudge[] = [];
  const suppressed: SuppressedNudge[] = [];

  const quiet = await loadQuietWindow(sc, userId);
  const cap = settings.presenceLevel === "active" ? ACTIVE_DAILY_CAP : AWARE_DAILY_CAP;
  let deliveredToday = await countDeliveredToday(sc, userId, nowMs);

  const notifSvc = new NotificationService(sc);
  const notifRouter = new NotificationRouter(sc);

  for (const nudge of candidates) {
    if (settings.presenceLevel === "aware" && !AWARE_CATEGORIES.has(nudge.category)) {
      suppressed.push({ dedupeKey: nudge.dedupeKey, type: nudge.type, reason: "presence_aware_category" });
      continue;
    }
    if (settings.categories[nudge.category] === false) {
      suppressed.push({ dedupeKey: nudge.dedupeKey, type: nudge.type, reason: "category_disabled" });
      continue;
    }
    if (quiet && isQuietHours(quiet.start, quiet.end, opts.nowMinutes, quiet.timezone)) {
      suppressed.push({ dedupeKey: nudge.dedupeKey, type: nudge.type, reason: "quiet_hours" });
      continue;
    }
    if (await isDuplicateNudge(sc, userId, nudge.dedupeKey, nowMs)) {
      suppressed.push({ dedupeKey: nudge.dedupeKey, type: nudge.type, reason: "duplicate" });
      continue;
    }
    if (deliveredToday >= cap) {
      suppressed.push({ dedupeKey: nudge.dedupeKey, type: nudge.type, reason: "daily_cap" });
      continue;
    }

    // Persist the durable nudge record FIRST so dedupe/caps hold even if the
    // notification insert races or fails downstream.
    try {
      await sc.from("compass_sense_nudges").insert({
        user_id: userId,
        nudge_type: nudge.type,
        category: nudge.category,
        dedupe_key: nudge.dedupeKey,
        title: nudge.title,
        body: nudge.body,
        action_url: nudge.actionUrl,
        confidence: nudge.confidence,
        created_at: new Date(nowMs).toISOString(),
      });
    } catch { /* best-effort log; delivery still attempted */ }

    try {
      const row = await notifSvc.create({
        userId,
        eventType: `compass.sense.${nudge.type}`,
        title: nudge.title,
        body: nudge.body,
        category: "compass",
        priority: "normal",
        actionUrl: nudge.actionUrl,
        sourceType: "compass_sense",
        sourceId: nudge.dedupeKey,
        metadata: { confidence: nudge.confidence, senseType: nudge.type },
      });
      if (row) void notifRouter.route(row).catch(() => {});
    } catch { /* delivery is best-effort; the nudge log row already exists */ }

    delivered.push(nudge);
    deliveredToday += 1;
  }

  return {
    presenceLevel: settings.presenceLevel,
    evaluated: candidates.length,
    delivered,
    suppressed,
  };
}
