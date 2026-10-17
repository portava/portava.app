/**
 * Telegraph §19 P0 / §30A.6 SAFETY — a help request is TOLD to the
 * conversation (census-telegraph T254, T398; wave 5 safety lane).
 *
 * The spec, verbatim, and nothing else is relied on:
 *   §19    "P0 Safety — SOS, safety escalation — Interruptive; bypass ordinary
 *           batching where policy requires."
 *   §30A.6 "Prioritize P0 SAFETY …" · "Safety-critical delivery remains
 *           governed by the safety policy rather than ordinary mute."
 *   §15.2  "NORMAL → SAFETY_ATTENTION → SAFETY_EVENT"
 *   §15.3  "Blocking must cascade across direct delivery, location, presence …"
 *   §27.1  "block activated → future direct delivery impossible"; §28 "blocked
 *           direct deliveries — 0".
 *   §17.4  "Push failure → no loss of canonical messages; push is
 *           wakeup/fallback, not consistency authority."
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 * Nothing produced a notification for a §6.2 SAFETY message or for §9.1's
 * NEED_HELP quick state: coordinationNotifications.ts refuses NEED_HELP (it is
 * SAFETY, not COORDINATION) and messageNotifications.ts refused the SAFETY kind
 * (its cause is not MESSAGE). A member who asked for help told nobody who was
 * not already looking at the conversation.
 *
 * ── WHAT THIS PRODUCES ──────────────────────────────────────────────────────
 *   need_help — the SAFETY kind's class and §9.1's NEED_HELP: §19's "SOS".
 *               `telegraph.sos`, P0, urgent.
 *   heads_up  — raises §15.2's NORMAL → SAFETY_ATTENTION: §19's "safety
 *               escalation". `telegraph.sos`, P0, urgent, its own phrase.
 *   all_clear — ONLY when it ends a raised mode (the caller reads that):
 *               §19 P1's "return state", the shape of `safe_return.cleared`.
 *               `telegraph.safety_all_clear`, P1, normal.
 *   check_in is reassurance, not an escalation (safetyMode.ts rule 2): it is an
 *   ordinary message and messageNotifications.ts tells it.
 *
 * ── WHO IS TOLD ─────────────────────────────────────────────────────────────
 *   1. The conversation's other ACTIVE members. Never the sender.
 *   2. Minus a block EITHER way. The spec carves out no exception for safety
 *      (§15.3, §27.1, §28), so a blocked pair is not told.
 *   3. NOT the member's thread choice. SAFETY is governed by the safety policy,
 *      not the mute (§30A.6): MUTED, a temporary mute, MENTIONS and IMPORTANT
 *      all deliver (`decideThreadNotification` answers SAFETY before it reads
 *      anything), so the choice is not even read — an unreadable settings table
 *      cannot stop a help request.
 *
 * ── WHAT IS OVERRIDDEN (quiet hours: the spec is silent; the precedent rules) ─
 *   - The thread mute and level: yes (§30A.6).
 *   - Quiet hours and push-off: only where the RECIPIENT's own `safety_override`
 *     is on (the default). That is the one existing safety rule
 *     (NotificationPreferenceService.filterChannels: `urgent` + override), the
 *     rule every P0 template already follows (T254; the ladder's test requires
 *     P0 templates to be urgent). The Compass gate passes it because the router
 *     maps an `sos` event to emergency_safety (level 1, never quiet-hours- or
 *     budget-suppressed); telegraphSafetyNotifications.test.ts routes one
 *     through the real router during quiet hours, so a rename that lost the
 *     level is a failing test, not a silent downgrade.
 *   - The recipient's category in-app switch: no (unchanged precedent).
 *   - Ghost Mode: the person's OWN help request is not a location notification
 *     about them, so no `senderId` reaches the privacy guard (the circle
 *     need-help alert passes none either). The notification carries no place.
 *
 * ── WHEN A READ FAILS ───────────────────────────────────────────────────────
 *   roster  — retried; then nobody can be named: refused, logged at ERROR.
 *   blocks  — retried; then refused (nobody told), logged at ERROR. Telling
 *             everyone on an unknown block state would break §27.1's invariant
 *             and §28's zero, which the spec states without exception, and a
 *             help request reaching the person the asker blocked is the one
 *             delivery that can make things worse. The message itself is
 *             written and in the thread (§17.4: push is the wakeup, not the
 *             record). Recorded for the owner.
 *   thread choices — not read (above).
 *   notification preferences — the router delivers `urgent` regardless
 *             (NotificationRouter.route), unchanged.
 *
 * ── DEDUPE ──────────────────────────────────────────────────────────────────
 * The causal event is the message (`MESSAGE:<id>`), persisted on every row, so a
 * later non-P0 report of the same message is a duplicate (T397). P0 itself is
 * never suppressed — window 0, and exempt from causal suppression by the
 * ladder's own rule — because a second SOS is a second SOS. One message reaches
 * this producer once (one door call) and each member once (a set).
 *
 * ── WHAT A LOCK SCREEN CAN SAY ──────────────────────────────────────────────
 * "Safety alert", the sender (shown name only if they show it, else @handle,
 * else "Someone") and a CLOSED phrase. Never the label, note or approximate
 * place the sender typed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isExcluded, readBlockExclusions, type ExclusionSet } from "../../lib/exclusionSet.js";
import { actorLabel } from "./coordinationNotifications.js";
import type { CreateNotificationInput, NotificationRow } from "../notifications/NotificationService.js";
import { causalEventIdOf } from "../notifications/NotificationDeduplicationService.js";

/** P0. The name carries `sos` on purpose: it is what NotificationRouter's Compass map reads as emergency_safety. */
export const SAFETY_ALERT_EVENT = "telegraph.sos" as const;
/** P1 — the ALL CLEAR that ends a raised mode. */
export const SAFETY_ALL_CLEAR_EVENT = "telegraph.safety_all_clear" as const;
export const SAFETY_NOTIFICATION_SOURCE = "thread_safety_alert" as const;

/** The words each signal puts on a lock screen. Closed: nothing the sender typed. */
export const SAFETY_SIGNAL_PHRASES = {
  need_help: "asked for help",
  heads_up: "raised a safety heads-up",
  all_clear: "posted ALL CLEAR",
} as const;
export type SafetySignal = keyof typeof SAFETY_SIGNAL_PHRASES;

/** How long to wait before each RETRY of a roster or blocks read (two retries). */
export const SAFETY_READ_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

/** The signal a §6.2 SAFETY row carries. `check_in` is null: it is an ordinary message. */
export function safetySignalOfRow(row: { msgType: string | null | undefined; subtype?: string | null }): SafetySignal | null {
  if (row.msgType !== "safety") return null;
  const s = row.subtype;
  return s === "need_help" || s === "heads_up" || s === "all_clear" ? s : null;
}

/** §9.1's NEED_HELP quick state, as a coordination write carries it. */
export function isNeedHelpQuickState(kind: string, payload: unknown): boolean {
  if (kind !== "COORDINATION" || !payload || typeof payload !== "object") return false;
  return (payload as { state?: unknown }).state === "NEED_HELP";
}

export interface SafetyNotifyDeps {
  create(input: CreateNotificationInput): Promise<NotificationRow | null>;
  route(row: NotificationRow): Promise<void>;
}

export interface SafetyNotifyLog {
  warn(obj: object, msg: string): void;
  error?(obj: object, msg: string): void;
}

export interface SafetyNotifyInput {
  threadId: string;
  senderId: string;
  messageId: string;
  signal: SafetySignal;
  nowMs: number;
}

export type SafetyNotifyOutcome =
  | {
      readonly status: "notified";
      readonly signal: SafetySignal;
      readonly eventType: typeof SAFETY_ALERT_EVENT | typeof SAFETY_ALL_CLEAR_EVENT;
      readonly notified: string[];
      readonly withheld: Array<{ userId: string; reason: string }>;
    }
  | { readonly status: "refused"; readonly stage: "roster" | "blocks" | "threw" };

async function defaultDeps(sc: SupabaseClient): Promise<SafetyNotifyDeps> {
  const { NotificationService } = await import("../notifications/NotificationService.js");
  const { NotificationRouter } = await import("../notifications/NotificationRouter.js");
  const ns = new NotificationService(sc);
  const nr = new NotificationRouter(sc);
  return { create: (input) => ns.create(input), route: (row) => nr.route(row) };
}

/** A safety failure is an ERROR, never a warning: somebody asked for help and was not relayed. */
function loud(log: SafetyNotifyLog | undefined, obj: object, msg: string): void {
  if (!log) return;
  if (typeof log.error === "function") log.error(obj, msg);
  else log.warn(obj, msg);
}

/** Run `read` until it answers, at most once plus once per delay. null = it never answered. */
async function retried<T>(delays: readonly number[], read: () => Promise<T | null>): Promise<{ value: T | null; attempts: number }> {
  let attempts = 0;
  for (let i = 0; ; i++) {
    attempts++;
    const value = await read();
    if (value !== null) return { value, attempts };
    if (i >= delays.length) return { value: null, attempts };
    const wait = delays[i]!;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * Tell the conversation's other members about one safety signal. NEVER rejects
 * — the doors fire it without awaiting, after the write has answered — and a
 * failure at any gate says which gate, at ERROR.
 */
export async function notifySafetySignal(
  sc: SupabaseClient,
  input: SafetyNotifyInput,
  opts: { deps?: SafetyNotifyDeps; log?: SafetyNotifyLog; retryDelaysMs?: readonly number[] } = {},
): Promise<SafetyNotifyOutcome> {
  try {
    return await tellConversation(sc, input, opts);
  } catch (err) {
    loud(opts.log, { err, threadId: input.threadId, signal: input.signal }, "SAFETY notification threw before anyone was told — the help request is in the thread but reached nobody by notification");
    return { status: "refused", stage: "threw" };
  }
}

async function tellConversation(
  sc: SupabaseClient,
  input: SafetyNotifyInput,
  opts: { deps?: SafetyNotifyDeps; log?: SafetyNotifyLog; retryDelaysMs?: readonly number[] },
): Promise<SafetyNotifyOutcome> {
  const { threadId, senderId, messageId, signal } = input;
  const delays = opts.retryDelaysMs ?? SAFETY_READ_RETRY_DELAYS_MS;

  // 1. The other active members. Never the sender. Retried; unknown names nobody.
  const roster = await retried(delays, async () => {
    const { data, error } = await sc.from("message_thread_members").select("user_id").eq("thread_id", threadId).is("left_at", null);
    return error || !Array.isArray(data) ? null : (data as Array<{ user_id: unknown }>);
  });
  if (roster.value === null) {
    loud(opts.log, { threadId, signal, attempts: roster.attempts }, "SAFETY notification REFUSED: the conversation's members could not be read — the help request reached NOBODY by notification");
    return { status: "refused", stage: "roster" };
  }
  const others = [...new Set(roster.value.map((r) => String(r.user_id ?? "")).filter((id) => id.length > 0 && id !== senderId))];
  const eventType = signal === "all_clear" ? SAFETY_ALL_CLEAR_EVENT : SAFETY_ALERT_EVENT;
  if (others.length === 0) return { status: "notified", signal, eventType, notified: [], withheld: [] };

  // 2. Nobody in a block with the sender, either way. Retried; unknown tells nobody (header).
  const blocks = await retried<ExclusionSet>(delays, async () => {
    const b = await readBlockExclusions(sc, senderId, { among: others });
    return b.ok ? b : null;
  });
  if (blocks.value === null) {
    loud(opts.log, { threadId, signal, attempts: blocks.attempts }, "SAFETY notification REFUSED: block state unknown — telling everyone could reach a blocked person (§27.1), so it reached NOBODY by notification");
    return { status: "refused", stage: "blocks" };
  }
  const withheld: Array<{ userId: string; reason: string }> = [];
  const deliverTo = others.filter((id) => {
    if (!isExcluded(blocks.value!, id)) return true;
    withheld.push({ userId: id, reason: "blocked" });
    return false;
  });
  if (deliverTo.length === 0) return { status: "notified", signal, eventType, notified: [], withheld };

  // 3. No thread choice is read: SAFETY is not governed by it (§30A.6).
  // The name is decoration: a failure to read it names "Someone", it never stops the alert.
  const actor = await actorLabel(sc, senderId).catch(() => "Someone");
  const deps = opts.deps ?? (await defaultDeps(sc));
  const causalEventId = causalEventIdOf({ objectType: "MESSAGE", objectId: messageId }) ?? undefined;
  const notified: string[] = [];
  await Promise.all(deliverTo.map(async (userId) => {
    try {
      const row = await deps.create({
        userId,
        eventType,
        actorId: senderId,
        // No `senderId`: it is only the privacy guard's Ghost Mode key, and a person's own help request is not a location notification about them (header).
        sourceType: SAFETY_NOTIFICATION_SOURCE,
        sourceId: threadId,
        params: { actor, signal: SAFETY_SIGNAL_PHRASES[signal], threadId },
        metadata: { cause: "SAFETY", signal },
        ...(causalEventId ? { causalEventId } : {}),
      });
      if (!row) {
        withheld.push({ userId, reason: "not_created" });
        loud(opts.log, { threadId, signal, userId }, "SAFETY notification not created for one member (privacy guard, ledger or insert)");
        return;
      }
      notified.push(userId);
      await deps.route(row);
    } catch (err) {
      loud(opts.log, { err, threadId, signal, userId }, "SAFETY notification failed for one member (the help request itself was written)");
    }
  }));
  return { status: "notified", signal, eventType, notified, withheld };
}
