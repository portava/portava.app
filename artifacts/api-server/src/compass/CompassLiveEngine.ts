/**
 * CompassLiveEngine — Phase 12: Compass Live.
 *
 * A persistent live travel session the user EXPLICITLY starts and stops.
 * While a session is active, Compass maintains rolling context (current stop,
 * next plan item, timing) against the day's plan and evaluates the Phase 11
 * Sense signals at higher frequency plus live-only session-aware signals:
 *
 *   - live_next_up        — the next plan item starts within 30 minutes.
 *   - live_arriving_early — the user is ahead of schedule: a comfortable gap
 *                           (45 min – 3 h) before the next plan item.
 *   - live_ride_home      — late night (22:00–04:00 via the UTC-hour hook):
 *                           a gentle prompt about getting back safely.
 *
 * Companion, not surveillance:
 *   - NOTHING runs when no session is active — runLiveCheck returns
 *     immediately with zero evaluation and zero writes.
 *   - Context is city-level / plan-item-level only. No coordinates are read,
 *     inferred, or stored (same guarantees as CompassLocationContext).
 *   - Rolling context lives on the session row and is deleted from relevance
 *     the moment the session ends (retained only inside the ended row the
 *     user owns, for their own end-of-session summary).
 *
 * Gating during a live session: starting a session is an explicit opt-in to
 * live nudges, so the Sense presence level does NOT silence live checks.
 * Per-category permissions ARE still honored (a category the user turned off
 * never delivers), dedupe uses the same durable compass_sense_nudges log, and
 * a per-session cap bounds total nudges.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { makeConfidence } from "../lib/liveIntelligence.js";
import { wrapUgc } from "./CompassStructuredContext.js";
import {
  evaluateSenseSignals,
  getSenseSettings,
  type CandidateNudge,
  type SuppressedNudge,
} from "./CompassSenseEngine.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter } from "../services/notifications/NotificationRouter.js";
import { RealtimeActivityService } from "../services/notifications/RealtimeActivityService.js";
import { fetchUserTimezone, localHourFor, nowUtcInstant } from "../lib/localTime.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Where a live-nudge push tap lands. The AI tab hosts the CompassLive
 * surface (active session, nudges, summary), so a tap always opens the
 * screen where the live session and the nudge itself are visible.
 * Route exists in the mobile app as app/(tabs)/ai.tsx and matches the
 * in-app convention router.push('/(tabs)/ai').
 */
export const LIVE_SURFACE_URL = "/(tabs)/ai";

export const LIVE_SESSION_NUDGE_CAP = 12;
export const LIVE_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const NEXT_UP_WINDOW_MS = 30 * 60 * 1_000;
const EARLY_MIN_GAP_MS = 45 * 60 * 1_000;
const EARLY_MAX_GAP_MS = 3 * 60 * 60 * 1_000;
const RECENT_EVENTS_CAP = 20;

export interface LivePlanItem {
  id: string;
  title: string;
  startsAt: string | null;
}

export interface LiveSessionEvent {
  at: string;
  kind: string;
  detail: string;
}

export interface LiveRollingContext {
  city: string | null;
  tripId: string | null;
  currentStop: LivePlanItem | null;
  nextItem: LivePlanItem | null;
  minutesToNext: number | null;
  recentEvents: LiveSessionEvent[];
  updatedAt: string;
}

export interface LiveSession {
  id: string;
  userId: string;
  tripId: string | null;
  status: "active" | "ended";
  context: LiveRollingContext;
  checksRun: number;
  nudgesDelivered: number;
  summary: Record<string, unknown> | null;
  startedAt: string;
  lastCheckAt: string | null;
  endedAt: string | null;
}

export interface LiveCheckResult {
  active: boolean;
  session: LiveSession | null;
  evaluated: number;
  delivered: CandidateNudge[];
  suppressed: SuppressedNudge[];
}

export interface LiveSessionSummary {
  durationMinutes: number;
  checksRun: number;
  nudgesDelivered: number;
  eventsRecorded: number;
  stopsReached: number;
  city: string | null;
  startedAt: string;
  endedAt: string;
}

// ── Row mapping ───────────────────────────────────────────────────────────────

function emptyContext(nowIso: string): LiveRollingContext {
  return {
    city: null,
    tripId: null,
    currentStop: null,
    nextItem: null,
    minutesToNext: null,
    recentEvents: [],
    updatedAt: nowIso,
  };
}

function mapRow(row: any): LiveSession {
  const ctx = (row.context ?? {}) as Partial<LiveRollingContext>;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tripId: (row.trip_id as string | null) ?? null,
    status: row.status === "ended" ? "ended" : "active",
    context: {
      city: ctx.city ?? null,
      tripId: ctx.tripId ?? null,
      currentStop: ctx.currentStop ?? null,
      nextItem: ctx.nextItem ?? null,
      minutesToNext: ctx.minutesToNext ?? null,
      recentEvents: Array.isArray(ctx.recentEvents) ? ctx.recentEvents : [],
      updatedAt: ctx.updatedAt ?? String(row.started_at ?? new Date(0).toISOString()),
    },
    checksRun: Number(row.checks_run ?? 0),
    nudgesDelivered: Number(row.nudges_delivered ?? 0),
    summary: (row.summary as Record<string, unknown> | null) ?? null,
    startedAt: String(row.started_at),
    lastCheckAt: (row.last_check_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
  };
}

// ── Session lookup ────────────────────────────────────────────────────────────

export async function getActiveLiveSession(
  sc: SupabaseClient,
  userId: string,
): Promise<LiveSession | null> {
  try {
    const { data } = await sc
      .from("compass_live_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1);
    const row = ((data ?? []) as any[])[0];
    return row ? mapRow(row) : null;
  } catch {
    return null;
  }
}

// ── Rolling context ───────────────────────────────────────────────────────────

async function fetchInProgressTrip(
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
      // `trip_status` is an ENUM: draft | planning | upcoming | active |
      // completed | cancelled | archived. `in_progress` is NOT a label, and
      // Postgres rejects an unknown enum literal outright (22P02) rather than
      // matching nothing — so this read failed WHOLE and `{ data }` was
      // undefined on every request. Compass Live therefore had no trip
      // grounding at all: tripId / currentStop / nextItem were permanently
      // null and no reached_stop or next_item_changed event could ever fire.
      // `active` is the label every other current-trip reader uses
      // (CompassTools:415, CompassSocialEngine:296, wall.ts:273, compass.ts:3414).
      .eq("status", "active")
      .limit(1);
    const t = ((trips ?? []) as any[])[0];
    if (!t) return null;
    return { id: String(t.id), city: (t.destination_city as string | null) ?? null };
  } catch {
    return null;
  }
}

async function fetchTodayPlan(
  sc: SupabaseClient,
  tripId: string,
  today: string,
): Promise<LivePlanItem[]> {
  try {
    const { data } = await sc
      .from("trip_plan_items")
      .select("id, title, starts_at, status, day_date, removed_at")
      .eq("trip_id", tripId)
      .eq("day_date", today);
    return ((data ?? []) as any[])
      .filter((i) => i.status !== "cancelled" && i.removed_at == null)
      .map((i) => ({
        id: String(i.id),
        title: String(i.title ?? "Plan item"),
        startsAt: (i.starts_at as string | null) ?? null,
      }))
      .sort((a, b) => String(a.startsAt ?? "").localeCompare(String(b.startsAt ?? "")));
  } catch {
    return [];
  }
}

/**
 * Recompute the rolling context against the day's plan. City-level only —
 * the city comes from the trip destination or the user's stored city, never
 * from coordinates.
 */
export async function buildLiveRollingContext(
  sc: SupabaseClient,
  userId: string,
  previous: LiveRollingContext | null,
  nowMs: number,
): Promise<LiveRollingContext> {
  const nowIso = new Date(nowMs).toISOString();
  const trip = await fetchInProgressTrip(sc, userId);

  let city: string | null = trip?.city ?? null;
  if (!city) {
    try {
      const { data: locState } = await sc
        .from("user_location_state")
        .select("city, manual_city")
        .eq("user_id", userId)
        .maybeSingle();
      city = ((locState as any)?.manual_city ?? (locState as any)?.city ?? null) as string | null;
    } catch { /* non-fatal */ }
  }

  let currentStop: LivePlanItem | null = null;
  let nextItem: LivePlanItem | null = null;
  if (trip) {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const items = await fetchTodayPlan(sc, trip.id, today);
    const timed = items.filter((i) => i.startsAt);
    const past = timed.filter((i) => new Date(i.startsAt!).getTime() <= nowMs);
    const future = timed.filter((i) => new Date(i.startsAt!).getTime() > nowMs);
    currentStop = past[past.length - 1] ?? null;
    nextItem = future[0] ?? null;
  }

  const minutesToNext = nextItem?.startsAt
    ? Math.max(0, Math.round((new Date(nextItem.startsAt).getTime() - nowMs) / 60_000))
    : null;

  // Carry the event trail forward and record real transitions as events so
  // context provably accumulates across a sequence of checks.
  const events: LiveSessionEvent[] = [...(previous?.recentEvents ?? [])];
  if (previous) {
    if (currentStop && currentStop.id !== previous.currentStop?.id) {
      events.push({ at: nowIso, kind: "reached_stop", detail: currentStop.title });
    }
    if (nextItem && nextItem.id !== previous.nextItem?.id) {
      events.push({ at: nowIso, kind: "next_item_changed", detail: nextItem.title });
    }
  }

  return {
    city,
    tripId: trip?.id ?? null,
    currentStop,
    nextItem,
    minutesToNext,
    recentEvents: events.slice(-RECENT_EVENTS_CAP),
    updatedAt: nowIso,
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function startLiveSession(
  sc: SupabaseClient,
  userId: string,
  nowMs: number = Date.now(),
): Promise<{ session: LiveSession; alreadyActive: boolean }> {
  const existing = await getActiveLiveSession(sc, userId);
  if (existing) return { session: existing, alreadyActive: true };

  const nowIso = new Date(nowMs).toISOString();
  const context = await buildLiveRollingContext(sc, userId, null, nowMs);
  context.recentEvents = [{ at: nowIso, kind: "session_started", detail: context.city ?? "unknown city" }];

  const { data, error } = await sc
    .from("compass_live_sessions")
    .insert({
      user_id: userId,
      trip_id: context.tripId,
      status: "active",
      context,
      checks_run: 0,
      nudges_delivered: 0,
      started_at: nowIso,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message ?? "live session insert failed");
  return { session: mapRow(data), alreadyActive: false };
}

export async function stopLiveSession(
  sc: SupabaseClient,
  userId: string,
  nowMs: number = Date.now(),
): Promise<{ stopped: boolean; summary: LiveSessionSummary | null }> {
  const session = await getActiveLiveSession(sc, userId);
  if (!session) return { stopped: false, summary: null };

  const nowIso = new Date(nowMs).toISOString();
  const startedMs = new Date(session.startedAt).getTime();
  const summary: LiveSessionSummary = {
    durationMinutes: Math.max(0, Math.round((nowMs - startedMs) / 60_000)),
    checksRun: session.checksRun,
    nudgesDelivered: session.nudgesDelivered,
    eventsRecorded: session.context.recentEvents.length,
    stopsReached: session.context.recentEvents.filter((e) => e.kind === "reached_stop").length,
    city: session.context.city,
    startedAt: session.startedAt,
    endedAt: nowIso,
  };

  await sc
    .from("compass_live_sessions")
    .update({ status: "ended", ended_at: nowIso, summary })
    .eq("id", session.id)
    .eq("user_id", userId);

  return { stopped: true, summary };
}

// ── Live-only signal evaluators ───────────────────────────────────────────────

function liveOnlyCandidates(
  context: LiveRollingContext,
  nowMs: number,
  hourUtc: number,
): CandidateNudge[] {
  const out: CandidateNudge[] = [];
  const today = new Date(nowMs).toISOString().slice(0, 10);

  if (context.nextItem?.startsAt) {
    const gapMs = new Date(context.nextItem.startsAt).getTime() - nowMs;
    if (gapMs > 0 && gapMs <= NEXT_UP_WINDOW_MS) {
      out.push({
        type: "live_next_up" as any,
        category: "timing",
        dedupeKey: `live_next_up:${context.nextItem.id}`,
        title: "Next up on your plan",
        body: `${context.nextItem.title} starts in about ${Math.max(1, Math.round(gapMs / 60_000))} min.`,
        actionUrl: LIVE_SURFACE_URL,
        confidence: makeConfidence("verified_live", "From your trip plan's scheduled times"),
      });
    } else if (gapMs >= EARLY_MIN_GAP_MS && gapMs <= EARLY_MAX_GAP_MS) {
      out.push({
        type: "live_arriving_early" as any,
        category: "timing",
        dedupeKey: `live_early:${context.nextItem.id}`,
        title: "You're ahead of schedule",
        body: `About ${Math.round(gapMs / 60_000)} min until ${context.nextItem.title} — room for a detour nearby.`,
        actionUrl: LIVE_SURFACE_URL,
        confidence: makeConfidence("verified_live", "From your trip plan's scheduled times"),
      });
    }
  }

  if (hourUtc >= 22 || hourUtc < 4) {
    out.push({
      type: "live_ride_home" as any,
      category: "timing",
      dedupeKey: `live_ride_home:${today}`,
      title: "Heading back soon?",
      body: "It's getting late — want a hand planning a safe way back?",
      actionUrl: LIVE_SURFACE_URL,
      confidence: makeConfidence("verified_live", "Based on the current time during your live session"),
    });
  }

  return out;
}

// ── Live check loop ───────────────────────────────────────────────────────────

async function isDuplicate(
  sc: SupabaseClient,
  userId: string,
  dedupeKey: string,
  nowMs: number,
): Promise<boolean> {
  try {
    const sinceIso = new Date(nowMs - LIVE_DEDUPE_WINDOW_MS).toISOString();
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

/**
 * One live check tick. STRICTLY scoped to an active session:
 * no active session → zero evaluation, zero DB writes, immediate return.
 */
export async function runLiveCheck(
  sc: SupabaseClient,
  userId: string,
  opts: { nowMs?: number; hourUtc?: number } = {},
): Promise<LiveCheckResult> {
  const session = await getActiveLiveSession(sc, userId);
  if (!session) {
    return { active: false, session: null, evaluated: 0, delivered: [], suppressed: [] };
  }

  const nowMs = opts.nowMs ?? Date.now();
  // Resolve the traveler's local hour via stored timezone (background job: no
  // client tz offset available). Falls through to UTC when timezone is unknown.
  const nowUtcDate = new Date(nowMs);
  const hourUtc = opts.hourUtc !== undefined
    ? opts.hourUtc
    : localHourFor(nowUtcDate, null, await fetchUserTimezone(sc, userId));

  // Refresh rolling context (records transition events against the previous
  // context so a sequence of checks provably carries context forward).
  const context = await buildLiveRollingContext(sc, userId, session.context, nowMs);

  // Phase 11 evaluators at live frequency + live-only session-aware signals.
  const senseCandidates = await evaluateSenseSignals(sc, userId, { nowMs, hourUtc });
  // Every nudge delivered during a live session taps through to the live
  // surface (AI tab) where the session and the nudge itself are visible —
  // including Sense-derived candidates that carry other deep links outside
  // live mode.
  const candidates = [...senseCandidates, ...liveOnlyCandidates(context, nowMs, hourUtc)].map(
    (n) => ({ ...n, actionUrl: LIVE_SURFACE_URL }),
  );

  // Explicit opt-in: presence level does not gate live checks, but per-category
  // permissions, durable dedupe, and the per-session cap all do.
  const settings = await getSenseSettings(sc, userId);
  const delivered: CandidateNudge[] = [];
  const suppressed: SuppressedNudge[] = [];
  let sessionDelivered = session.nudgesDelivered;

  const notifSvc = new NotificationService(sc);
  const notifRouter = new NotificationRouter(sc);
  const realtimeSvc = new RealtimeActivityService(sc);

  for (const nudge of candidates) {
    if (settings.categories[nudge.category] === false) {
      suppressed.push({ dedupeKey: nudge.dedupeKey, type: nudge.type, reason: "category_disabled" });
      continue;
    }
    if (await isDuplicate(sc, userId, nudge.dedupeKey, nowMs)) {
      suppressed.push({ dedupeKey: nudge.dedupeKey, type: nudge.type, reason: "duplicate" });
      continue;
    }
    if (sessionDelivered >= LIVE_SESSION_NUDGE_CAP) {
      suppressed.push({ dedupeKey: nudge.dedupeKey, type: nudge.type, reason: "daily_cap" });
      continue;
    }

    // Durable log first so dedupe/caps hold even if delivery fails downstream.
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
    } catch { /* best-effort */ }

    try {
      const row = await notifSvc.create({
        userId,
        eventType: `compass.live.${nudge.type}`,
        title: nudge.title,
        body: nudge.body,
        category: "compass",
        priority: "normal",
        actionUrl: nudge.actionUrl,
        sourceType: "compass_live",
        sourceId: nudge.dedupeKey,
        metadata: { confidence: nudge.confidence, liveSessionId: session.id, nudgeType: nudge.type },
      });
      if (row) {
        // Push etc. via the existing router, plus an immediate SSE emit so the
        // in-app live surface refreshes the moment the nudge exists — no wait
        // for the next poll tick.
        void notifRouter.route(row).catch(() => {});
        realtimeSvc.emitCreated(row);
      }
    } catch { /* delivery best-effort; log row exists */ }

    delivered.push(nudge);
    sessionDelivered += 1;
  }

  for (const d of delivered) {
    context.recentEvents.push({
      at: new Date(nowMs).toISOString(),
      kind: "nudge_delivered",
      detail: d.title,
    });
  }
  context.recentEvents = context.recentEvents.slice(-RECENT_EVENTS_CAP);

  const nowIso = new Date(nowMs).toISOString();
  await sc
    .from("compass_live_sessions")
    .update({
      context,
      checks_run: session.checksRun + 1,
      nudges_delivered: sessionDelivered,
      last_check_at: nowIso,
    })
    .eq("id", session.id)
    .eq("user_id", userId);

  return {
    active: true,
    session: { ...session, context, checksRun: session.checksRun + 1, nudgesDelivered: sessionDelivered, lastCheckAt: nowIso },
    evaluated: candidates.length,
    delivered,
    suppressed,
  };
}

// ── Chat grounding ────────────────────────────────────────────────────────────

/**
 * Context lines for /compass/ask while a live session is active.
 * Empty array when no session — chat is unchanged outside live mode.
 */
export async function buildLiveChatContextLines(
  sc: SupabaseClient,
  userId: string,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const session = await getActiveLiveSession(sc, userId);
  if (!session) return [];
  const ctx = session.context;
  const lines: string[] = ["Live session: ACTIVE — the user is out right now; keep answers timely and practical."];
  if (ctx.city) lines.push(`Live session city: ${ctx.city}`);
  // Stop/next-item titles and event details are UGC (a trip co-member can set
  // them), so wrap them in <portava:ugc> before they enter the /ask prompt.
  if (ctx.currentStop) lines.push(`Current stop: ${wrapUgc(String(ctx.currentStop.title ?? ""))}`);
  if (ctx.nextItem) {
    const when = ctx.nextItem.startsAt
      ? ` at ${String(ctx.nextItem.startsAt).slice(11, 16)} UTC${ctx.minutesToNext != null ? ` (~${ctx.minutesToNext} min from now)` : ""}`
      : "";
    lines.push(`Next planned stop: ${wrapUgc(String(ctx.nextItem.title ?? ""))}${when}`);
  }
  const recent = ctx.recentEvents.slice(-3).map((e) => `${e.kind}: ${wrapUgc(String(e.detail ?? ""))}`);
  if (recent.length > 0) lines.push(`Recent session events: ${recent.join("; ")}`);
  void nowMs;
  return lines;
}
