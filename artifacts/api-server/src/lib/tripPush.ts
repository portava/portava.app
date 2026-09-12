/**
 * Every trip push goes through here — Trips spec §11.4 (census-trips TR200).
 *
 * BEFORE: ten sites in routes/trips.ts, routes/trips-expansion.ts and
 * lib/tripReminderScheduler.ts called lib/pushWithRetry.sendPushWithRetry
 * directly, bypassing services/notifications/NotificationRouter and every
 * policy in it. §11.4 says "Trip events must pass an attention policy", so
 * each of those sites now calls `sendTripPush`, which:
 *
 *   1. looks the event up in TRIP_PUSH_EVENT_PROFILES (an unknown kind is
 *      refused — a new site cannot skip the policy by not being listed);
 *   2. decides the attention level PER RECIPIENT (their hourly budget, their
 *      quiet hours) with services/trips/TripAttentionPolicy.decideAttention;
 *   3. pushes only at NOTIFY / INTERRUPT, through sendPushWithRetry exactly as
 *      before — the kill switch, retries and token handling are unchanged;
 *   4. counts every decision under `trip_notification_attention_total`
 *      {kind, level} and every push under `notification_sent_total` {kind}.
 *
 * §21.1 `notification_actionability_rate` ("Avoid notification spam") is
 * sent → acted: `recordNotificationActed` is the acted side, reached from
 * POST /trips/:tripId/notifications/acted when the client opens a trip push,
 * and `readNotificationActionability` divides the two per kind. A push that
 * is never acted on is a push that should have been a SURFACE.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPushWithRetry, type PushRecipient } from "./pushWithRetry.js";

// pushWithRetry keeps these two local; derive them so this file tracks it.
export type PushPayload = Parameters<typeof sendPushWithRetry>[2];
export type PushResult = Awaited<ReturnType<typeof sendPushWithRetry>>;
import { incrementTripMetric, readTripMetric } from "./tripMetrics.js";
import {
  decideAttention, mayPush, TRIP_PUSH_EVENT_PROFILES,
  type AttentionDecision, type AttentionLevel,
} from "../services/trips/TripAttentionPolicy.js";
import type { AttentionState } from "../services/trips/TripSignals.js";
import { logger } from "./logger.js";

const log = logger.child({ mod: "tripPush" });

export interface TripPushOptions {
  /** §17.2 mode of the trip, when the caller knows it. Default NORMAL. */
  mode?: AttentionState;
  /** ISO deadline on the recipient's ability to act (an invite's expiry, a departure). */
  deadlineAt?: string | null;
  /** The recipient's quiet hours are in effect. Default false (the caller may not know). */
  quietHours?: boolean;
  now?: number;
}

export interface TripPushOutcome {
  kind: string;
  decisions: { userId: string; decision: AttentionDecision }[];
  /** Recipients pushed (NOTIFY / INTERRUPT). */
  pushed: string[];
  /** Recipients the policy kept in-app (SURFACE / PASSIVE / IGNORE). */
  held: string[];
  push: PushResult | null;
}

// The hourly NOTIFY budget, per recipient, in process. A restart forgets it,
// which errs toward notifying — the same failure mode as before this file.
const notifyLog = new Map<string, number[]>();
const HOUR_MS = 60 * 60 * 1000;

function recentNotifies(userId: string, now: number): number {
  const times = (notifyLog.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
  notifyLog.set(userId, times);
  return times.length;
}
function noteNotify(userId: string, now: number): void {
  const times = notifyLog.get(userId) ?? [];
  times.push(now);
  notifyLog.set(userId, times);
}

export function _resetTripPushBudget(): void {
  notifyLog.clear();
}

function kindOf(payload: PushPayload): string | null {
  const t = (payload.data as Record<string, unknown> | undefined)?.type;
  return typeof t === "string" && t.length > 0 ? t : null;
}

/**
 * The one entry point. Recipients whose decision is NOTIFY or INTERRUPT are
 * pushed in one sendPushWithRetry call; the rest are returned as `held`, and
 * the caller's in-app notification row (written by NotificationRouter at the
 * call sites that have one) is the SURFACE.
 */
export async function sendTripPush(
  db: SupabaseClient | null,
  recipients: PushRecipient | PushRecipient[],
  payload: PushPayload,
  opts: TripPushOptions = {},
): Promise<TripPushOutcome> {
  const kind = kindOf(payload);
  if (!kind) throw new Error("sendTripPush: payload.data.type is required — it names the event the attention policy judges");
  const profile = TRIP_PUSH_EVENT_PROFILES[kind];
  if (!profile) throw new Error(`sendTripPush: '${kind}' has no TRIP_PUSH_EVENT_PROFILES row; add one (services/trips/TripAttentionPolicy.ts) before pushing it`);

  const now = opts.now ?? Date.now();
  const list = Array.isArray(recipients) ? recipients : [recipients];
  const outcome: TripPushOutcome = { kind, decisions: [], pushed: [], held: [], push: null };
  const toPush: PushRecipient[] = [];

  for (const r of list) {
    const decision = decideAttention(
      { kind, ...profile, deadlineAt: opts.deadlineAt ?? null },
      { now, mode: opts.mode ?? "NORMAL", recentNotifyCount: recentNotifies(r.userId, now), quietHours: opts.quietHours ?? false },
    );
    outcome.decisions.push({ userId: r.userId, decision });
    incrementTripMetric("trip_notification_attention_total", { kind, level: decision.level });
    if (mayPush(decision.level)) {
      toPush.push(r);
      outcome.pushed.push(r.userId);
      noteNotify(r.userId, now);
    } else {
      outcome.held.push(r.userId);
    }
  }

  if (toPush.length > 0) {
    outcome.push = await sendPushWithRetry(db, toPush, payload);
    for (const r of toPush) incrementTripMetric("notification_sent_total", { kind, userId: r.userId });
  } else {
    log.debug({ kind, held: outcome.held.length }, "trip push held by the attention policy");
  }
  return outcome;
}

/** The acted side of §21.1's rate: the recipient opened / used the push. */
export function recordNotificationActed(kind: string, userId: string): void {
  incrementTripMetric("notification_acted_total", { kind, userId });
}

export interface NotificationActionability {
  kind: string;
  sent: number;
  acted: number;
  /** acted / sent, or null when nothing was sent — a rate over zero is not a rate. */
  rate: number | null;
}

/** §21.1 `notification_actionability_rate`, per kind, from the two counters. */
export function readNotificationActionability(): NotificationActionability[] {
  const sent = new Map<string, number>();
  const acted = new Map<string, number>();
  for (const s of readTripMetric("notification_sent_total")) sent.set(s.labels.kind, (sent.get(s.labels.kind) ?? 0) + s.count);
  for (const s of readTripMetric("notification_acted_total")) acted.set(s.labels.kind, (acted.get(s.labels.kind) ?? 0) + s.count);
  const kinds = [...new Set([...sent.keys(), ...acted.keys()])].sort();
  return kinds.map((kind) => {
    const n = sent.get(kind) ?? 0;
    const a = acted.get(kind) ?? 0;
    return { kind, sent: n, acted: a, rate: n > 0 ? Math.min(1, a / n) : null };
  });
}

/** For a surface that wants to say what level an event got without pushing. */
export function attentionLevelFor(kind: string, opts: TripPushOptions & { userId: string }): AttentionLevel {
  const profile = TRIP_PUSH_EVENT_PROFILES[kind];
  if (!profile) return "IGNORE";
  const now = opts.now ?? Date.now();
  return decideAttention(
    { kind, ...profile, deadlineAt: opts.deadlineAt ?? null },
    { now, mode: opts.mode ?? "NORMAL", recentNotifyCount: recentNotifies(opts.userId, now), quietHours: opts.quietHours ?? false },
  ).level;
}
