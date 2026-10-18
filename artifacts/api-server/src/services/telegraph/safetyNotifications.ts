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
 *   1. The conversation's other ACTIVE members. Never the sender. For a help request, never one who ARCHIVED it (owner ruling, file foot).
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
 *   roster  — retried; then nobody can be named NOW: refused, ERROR-logged.
 *   blocks  — retried; then refused (nobody told NOW), ERROR-logged. Telling
 *             everyone on an unknown block state would break §27.1's invariant
 *             and §28's zero, which the spec states without exception, and a
 *             help request reaching the person the asker blocked is the one
 *             delivery that can make things worse. NOT DROPPED: the re-drive
 *             at the file foot re-attempts it for 15 minutes from the stored
 *             message, every gate re-read, once per member (Fable pass 3 §1.1).
 *   thread choices — not read (above).
 *   notification preferences — the router delivers `urgent` regardless
 *             (NotificationRouter.route), unchanged.
 *
 * ── DEDUPE ──────────────────────────────────────────────────────────────────
 * The causal event is the message (`MESSAGE:<id>`), persisted on every row, so a
 * later non-P0 report of the same message is a duplicate (T397). P0 itself is
 * never suppressed — window 0, and exempt from causal suppression by the
 * ladder's own rule — because a second SOS is a second SOS. One message reaches
 * this producer once (one door call) and each member once (a set). A P1 the layer coalesces into an EQUIVALENT is `deduped` (file foot).
 *
 * ── WHAT A LOCK SCREEN CAN SAY ──────────────────────────────────────────────
 * "Safety alert", the sender (shown name only if they show it, else @handle,
 * else "Someone") and a CLOSED phrase. Never the label, note or approximate
 * place the sender typed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isExcluded, readBlockExclusions, type ExclusionSet } from "../../lib/exclusionSet.js";
import { actorLabel } from "./coordinationNotifications.js"; import { projectSafetyMode, readSafetySignals, type SafetyInputRow } from "./safetyMode.js"; // the re-drive's "is it still open?" (file foot)
import type { CreateNotificationInput, NotificationCreateRefusal, NotificationRow } from "../notifications/NotificationService.js";
import { causalEventIdOf } from "../notifications/NotificationDeduplicationService.js"; import { dedupeWindowFor } from "../../domain/telegraph/policies/attentionLadder.js"; // `deduped` (file foot)

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
  create(input: CreateNotificationInput): Promise<NotificationRow | null>; /** Optional: `create` saying WHY nothing was written (NotificationService.createDetailed) — what lets a coalesced P1 be `deduped` (file foot). */ createDetailed?(input: CreateNotificationInput): Promise<{ row: NotificationRow | null; refusal: NotificationCreateRefusal | null }>;
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
  return { create: (input) => ns.create(input), createDetailed: (input) => ns.createDetailed(input), route: (row) => nr.route(row) };
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
  // While this door is telling the message the re-drive (file foot) leaves it alone; a door that told everyone settles it.
  const door = redriveEntry(input.messageId, input.nowMs); door.inFlight += 1; let outcome: SafetyNotifyOutcome = { status: "refused", stage: "threw" };
  try { outcome = await tellConversation(sc, input, opts); return outcome; } catch (err) {
    loud(opts.log, { err, threadId: input.threadId, signal: input.signal }, "SAFETY notification threw before anyone was told — the help request is in the thread and the durable re-drive re-attempts it");
    return outcome;
  } finally { door.inFlight -= 1; if (doorToldEveryone(outcome)) door.settled = true; }
}

async function tellConversation(
  sc: SupabaseClient,
  input: SafetyNotifyInput,
  opts: { deps?: SafetyNotifyDeps; log?: SafetyNotifyLog; retryDelaysMs?: readonly number[] },
): Promise<SafetyNotifyOutcome> {
  const { threadId, senderId, messageId, signal } = input;
  const delays = opts.retryDelaysMs ?? SAFETY_READ_RETRY_DELAYS_MS;

  // 1. The other active members (and who archived it: same read, same snapshot). Never the sender. Retried; unknown names nobody.
  const roster = await retried(delays, async () => {
    const { data, error } = await sc.from("message_thread_members").select("user_id, archived_at").eq("thread_id", threadId).is("left_at", null);
    return error || !Array.isArray(data) ? null : (data as Array<{ user_id: unknown; archived_at?: unknown }>);
  });
  if (roster.value === null) {
    loud(opts.log, { threadId, signal, attempts: roster.attempts }, "SAFETY notification REFUSED: the conversation's members could not be read — the help request reached NOBODY by notification yet; the durable re-drive re-attempts it for 15 minutes");
    return { status: "refused", stage: "roster" };
  }
  const archived = archivedRecipients(roster.value, senderId, signal); const others = [...new Set(roster.value.map((r) => String(r.user_id ?? "")).filter((id) => id.length > 0 && id !== senderId && !archived.has(id)))];
  const eventType = signal === "all_clear" ? SAFETY_ALL_CLEAR_EVENT : SAFETY_ALERT_EVENT;
  if (others.length === 0) return { status: "notified", signal, eventType, notified: [], withheld: archivedWithheld(archived) };

  // 2. Nobody in a block with the sender, either way. Retried; unknown tells nobody (header).
  const blocks = await retried<ExclusionSet>(delays, async () => {
    const b = await readBlockExclusions(sc, senderId, { among: others });
    return b.ok ? b : null;
  });
  if (blocks.value === null) {
    loud(opts.log, { threadId, signal, attempts: blocks.attempts }, "SAFETY notification REFUSED: block state unknown — telling everyone could reach a blocked person (§27.1), so it reached NOBODY by notification yet; the durable re-drive re-attempts it for 15 minutes");
    return { status: "refused", stage: "blocks" };
  }
  const withheld: Array<{ userId: string; reason: string }> = archivedWithheld(archived);
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
  const told = await deliverSafetySignal(deps, sc, { threadId, senderId, messageId, signal, eventType, actor }, deliverTo, opts.log);
  return { status: "notified", signal, eventType, notified: told.notified, withheld: [...withheld, ...told.withheld] };
}

/**
 * One notification per member, each on its own: one member's failure stops nobody else. The causal event
 * (`MESSAGE:<id>`) is persisted on every row (metadata.causal_event_id) — it is what the re-drive below reads to
 * tell each member at most once. `withheld` here is `not_created` (the service declined or the insert failed) or
 * `failed` (it threw) or `coalesced` (the layer held back a P1 that is not equivalent), all re-attempted, or `deduped` (an equivalent is SEEN: counted as told) — file foot. A failed ROUTE is not withheld: the row exists, the member
 * is told in-app, and repeating the push is the router's push-retry job, not this producer's.
 */
async function deliverSafetySignal(
  deps: SafetyNotifyDeps, sc: SupabaseClient,
  m: { threadId: string; senderId: string; messageId: string; signal: SafetySignal; eventType: typeof SAFETY_ALERT_EVENT | typeof SAFETY_ALL_CLEAR_EVENT; actor: string },
  deliverTo: readonly string[],
  log: SafetyNotifyLog | undefined,
): Promise<{ notified: string[]; withheld: Array<{ userId: string; reason: string }> }> {
  const { threadId, senderId, messageId, signal, eventType, actor } = m;
  const causalEventId = causalEventIdOf({ objectType: "MESSAGE", objectId: messageId }) ?? undefined;
  const notified: string[] = [];
  const withheld: Array<{ userId: string; reason: string }> = []; const duplicates: string[] = []; // refused as duplicates: classified after the loop (file foot)
  await Promise.all(deliverTo.map(async (userId) => {
    let row: NotificationRow | null; let refusal: NotificationCreateRefusal | null = null;
    try {
      ({ row, refusal } = await createSafetyRow(deps, {
        userId,
        eventType,
        actorId: senderId,
        // No `senderId`: it is only the privacy guard's Ghost Mode key, and a person's own help request is not a location notification about them (header).
        sourceType: SAFETY_NOTIFICATION_SOURCE,
        sourceId: threadId,
        params: { actor, signal: SAFETY_SIGNAL_PHRASES[signal], threadId },
        metadata: { cause: "SAFETY", signal },
        ...(causalEventId ? { causalEventId } : {}),
      }));
    } catch (err) {
      withheld.push({ userId, reason: "failed" });
      loud(log, { err, threadId, signal, userId }, "SAFETY notification failed for one member (the help request itself was written)");
      return;
    }
    if (!row && dedupeCandidate(eventType, refusal)) { duplicates.push(userId); return; } if (!row) {
      withheld.push({ userId, reason: "not_created" });
      loud(log, { threadId, signal, userId }, "SAFETY notification not created for one member (privacy guard, ledger or insert)");
      return;
    }
    notified.push(userId);
    try {
      await deps.route(row);
    } catch (err) {
      loud(log, { err, threadId, signal, userId }, "SAFETY notification failed for one member (the help request itself was written)");
    }
  }));
  withheld.push(...(await classifyDuplicates(sc, { threadId, messageId, signal, eventType }, duplicates, log))); return { notified, withheld };
}

// ═════════════════════════════════════════════════════════════════════════════
// THE DURABLE RE-DRIVE — Fable pass 3 §1.1: "do not lose the help request"
// ═════════════════════════════════════════════════════════════════════════════
/**
 * THE DEFECT. The door retries an unreadable roster or blocks read for ~1.25 s
 * (250 ms + 1 s) and then refuses. Before this, the refusal was the end: an
 * outage longer than that (a PostgREST restart, a pooler hiccup) lost that
 * help request's notification for good — loud in the log, but nobody woken.
 *
 * THE RULE KEPT. An unreadable roster or blocks read still tells nobody AT
 * THAT MOMENT (§27.1 / §28 are unconditional; header). What changes is that
 * the moment is not the last one.
 *
 * WHAT IS DURABLE, AND WHY NO TABLE. No production-present queue can carry
 * this (the handback lists what was checked: push_retry_queue is keyed on an
 * EXISTING notification, the journey / stamp / place / outbox queues are each
 * one domain's, scheduler_watermarks and telegraph_outbox are not applied in
 * production, and the 3000-3999 band is exhausted). It needs none: the help
 * request IS a durable row — public.messages, written in the door's own
 * transaction before any of this runs — and who has been told IS a durable
 * row too — public.notifications, each carrying metadata.causal_event_id =
 * `MESSAGE:<id>`. So the job is "a §6.2/§9.1 safety row from the last 15
 * minutes that some eligible member holds no notification for", and
 * lib/safetySignalRedriveScheduler.ts derives it from those two tables on
 * every pass. A restart loses only the in-process memo below (which attempt
 * is next; which messages are already settled) — the next pass on ANY
 * instance re-derives the work from the database and makes one catch-up
 * attempt for each message still inside the window.
 *
 * THE SCHEDULE. The door's own attempt (with its two quick retries) is the
 * first; then one attempt as each age in SAFETY_REDRIVE_SCHEDULE_MS passes —
 * 10 s, 30 s, 1, 2, 4, 8 and 15 minutes: seven re-drives, doubling back-off,
 * bounded. Points a pass missed (a slow pass, a restart) collapse into ONE
 * attempt, never a burst. After the 15-minute attempt fails the re-drive
 * gives up and says so at ERROR, naming the message.
 *
 * EVERY ATTEMPT RE-READS EVERY GATE, from the database, in this order:
 *   1. the message — unsent or deleted since (both set deleted_at): nobody;
 *   2. the members NOW — a member who left since is not told; nor is anyone
 *      whose membership began AFTER the message (joined_at / §14.3's
 *      visible_from_at): the door could not have told them, so a late
 *      delivery must not widen its audience;
 *   3. the blocks NOW, both ways — a block made since is honoured; unknown
 *      tells nobody this attempt (the door's rule);
 *   4. who already HAS it — any notification to them with this causal id,
 *      whoever wrote it (the door, an earlier attempt, another instance);
 *      unknown tells nobody this attempt. This is "never told twice";
 *   5. only if someone is still untold: is it still OPEN (below).
 *
 * A RAISED MODE THAT ENDED MEANWHILE — decided from the spec and the safety
 * lane's handback, and stated: a help request or heads-up that an ALL CLEAR
 * posted AFTER it has already answered is NOT sent late. §17.4 makes push the
 * wakeup, not the record — the message is in the thread either way — and
 * §19's P0 is "Interruptive": an urgent "Safety alert: asked for help" that
 * arrives after (or beside) "posted ALL CLEAR" reads as a NEW emergency and
 * would wake people through quiet hours for one that is over. safetyMode.ts
 * rule 1 (an EVENT ends only by an explicit ALL CLEAR) is what makes that
 * ALL CLEAR the evidence. A LATER, separate help request does not count: it
 * is its own message with its own delivery. Symmetrically, an ALL CLEAR is
 * re-driven only while it still ends something (the §15.2 mode just before
 * it was raised — the door's own test) and no NEW help request or heads-up
 * came after it: a late "ALL CLEAR" landing after a fresh SOS would read as
 * clearing that one.
 *
 * WHAT IT DOES NOT CLOSE (stated for the owner, in the handback too):
 *   - Two instances due on the same message within the same ~100 ms can both
 *     find a member untold and both tell them. Closing that needs a unique
 *     index on (user_id, metadata->>causal_event_id) or a claim row — a
 *     migration, and none is available.
 *   - The loop is an in-process timer like every scheduler here: no process
 *     running at all (autoscale with no instance up) means no attempt until
 *     one starts; a gap past 15 minutes forfeits the remaining attempts and
 *     the give-up ERROR (no pass saw the last point).
 */
export const SAFETY_REDRIVE_SCHEDULE_MS: readonly number[] = [10_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000];
/** The re-drive's deadline: the last scheduled attempt (15 minutes after the message). */
export const SAFETY_REDRIVE_WINDOW_MS: number = SAFETY_REDRIVE_SCHEDULE_MS[SAFETY_REDRIVE_SCHEDULE_MS.length - 1]!;
/** The stored subtypes of the rows this producer tells (§6.2 SAFETY's kinds; §9.1's NEED_HELP, lower-cased by coordination.ts). */
export const SAFETY_REDRIVE_SUBTYPES: readonly string[] = ["need_help", "heads_up", "all_clear"];
/** The §15.2 read's bound — messageNotifications.ts SAFETY_SCAN_LIMIT's value (not imported: that module imports this one). */
const SAFETY_REDRIVE_MODE_SCAN_LIMIT = 400;
/** `.in()` chunk for the "already told" read, the block reader's own chunk size (lib/exclusionSet.ts). */
const TOLD_CHUNK = 100;

/** In-process only, and only an optimisation: which messages need no further attempt, which is next, and which a door is still telling. */
export interface SafetyRedriveEntry { createdMs: number; next: number; settled: boolean; inFlight: number }
const _redrive = new Map<string, SafetyRedriveEntry>();
const REDRIVE_MEMO_CAP = 5_000;

/** The memo entry for one message, created on first use. */
export function redriveEntry(messageId: string, createdMs: number): SafetyRedriveEntry {
  let e = _redrive.get(messageId);
  if (!e) {
    if (_redrive.size >= REDRIVE_MEMO_CAP) pruneSafetyRedriveMemo(createdMs - SAFETY_REDRIVE_WINDOW_MS);
    e = { createdMs, next: 0, settled: false, inFlight: 0 };
    _redrive.set(messageId, e);
  }
  return e;
}

/** Forget every idle entry for a message created before `beforeMs` (the pass prunes what has left its window). */
export function pruneSafetyRedriveMemo(beforeMs: number): void {
  for (const [id, e] of _redrive) if (e.inFlight === 0 && e.createdMs < beforeMs) _redrive.delete(id);
}

/** Test seam: what a process restart does to the re-drive — every in-process memo gone, the database untouched. */
export function _resetSafetyRedriveMemo(): void {
  _redrive.clear();
}

/** A door that told every member it could (blocked, for a help request archived, and `deduped` ones excepted) leaves nothing for the re-drive. */
function doorToldEveryone(o: SafetyNotifyOutcome): boolean {
  return o.status === "notified" && o.withheld.every((w) => w.reason === "blocked" || w.reason === "archived" || w.reason === DEDUPED);
}

/** The signal a STORED row carries: a §6.2 SAFETY row's kind, or §9.1's NEED_HELP (coordination.ts stores the state lower-cased as the subtype). */
export function storedSafetySignalOf(m: { msg_type?: unknown; subtype?: unknown }): SafetySignal | null {
  const msgType = typeof m.msg_type === "string" ? m.msg_type : null;
  const subtype = typeof m.subtype === "string" ? m.subtype : null;
  if (msgType === "coordination") return subtype === "need_help" ? "need_help" : null;
  return safetySignalOfRow({ msgType, subtype });
}

const msOf = (v: unknown): number => {
  const t = typeof v === "string" && v.length > 0 ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

export type SafetyRedriveStage = "message" | "roster" | "blocks" | "told" | "mode" | "deliver" | "threw";
export type SafetyRedriveSettledReason = "complete" | "message_absent" | "not_a_signal" | "cleared" | "superseded" | "ends_nothing";
export type SafetyRedriveOutcome =
  | {
      readonly status: "settled";
      readonly reason: SafetyRedriveSettledReason;
      readonly threadId: string | null;
      readonly signal: SafetySignal | null;
      /** Told by THIS attempt (not those who already had it). */
      readonly notified: string[];
      readonly withheld: Array<{ userId: string; reason: string }>;
    }
  | { readonly status: "retry"; readonly stage: SafetyRedriveStage; readonly threadId: string | null; readonly signal: SafetySignal | null; readonly notified: string[] };

/**
 * ONE re-drive attempt for one stored message. NEVER rejects. `settled` = no
 * further attempt is needed (everyone eligible holds it, or it must not go);
 * `retry` = a gate could not be read or a member could not be written — the
 * caller (lib/safetySignalRedriveScheduler.ts) decides when, and when to stop.
 */
export async function redriveSafetySignal(
  sc: SupabaseClient,
  messageId: string,
  opts: { deps?: SafetyNotifyDeps; log?: SafetyNotifyLog } = {},
): Promise<SafetyRedriveOutcome> {
  try {
    return await redriveOnce(sc, messageId, opts);
  } catch (err) {
    opts.log?.warn({ err, messageId }, "SAFETY re-drive attempt threw — re-attempted at the next due point");
    return { status: "retry", stage: "threw", threadId: null, signal: null, notified: [] };
  }
}

async function redriveOnce(sc: SupabaseClient, messageId: string, opts: { deps?: SafetyNotifyDeps; log?: SafetyNotifyLog }): Promise<SafetyRedriveOutcome> {
  let threadId: string | null = null;
  let signal: SafetySignal | null = null;
  const withheld: Array<{ userId: string; reason: string }> = [];
  const retry = (stage: SafetyRedriveStage, notified: string[] = []): SafetyRedriveOutcome => ({ status: "retry", stage, threadId, signal, notified });
  const settle = (reason: SafetyRedriveSettledReason, notified: string[] = []): SafetyRedriveOutcome => ({ status: "settled", reason, threadId, signal, notified, withheld });

  // 1. The message, re-read. Unsent or deleted since (both set deleted_at): it is not in the thread, nobody is told.
  const { data: m, error: mErr } = await sc.from("messages").select("id, thread_id, sender_id, created_at, deleted_at, msg_type, subtype").eq("id", messageId).maybeSingle();
  if (mErr) return retry("message");
  if (!m || (m as { deleted_at?: unknown }).deleted_at != null) return settle("message_absent");
  const row = m as { thread_id?: unknown; sender_id?: unknown; created_at?: unknown; msg_type?: unknown; subtype?: unknown };
  signal = storedSafetySignalOf(row);
  threadId = typeof row.thread_id === "string" && row.thread_id.length > 0 ? row.thread_id : null;
  const senderId = typeof row.sender_id === "string" && row.sender_id.length > 0 ? row.sender_id : null;
  const atMs = msOf(row.created_at);
  if (signal === null || threadId === null || senderId === null || !Number.isFinite(atMs)) return settle("not_a_signal");

  // 2. The members NOW, never the sender. A member who left since is not told; nor, for a help request, one who has
  //    archived it (owner ruling, below); nor anyone whose membership began after the message (the door could not have told them).
  const { data: roster, error: rErr } = await sc.from("message_thread_members").select("user_id, joined_at, visible_from_at, archived_at").eq("thread_id", threadId).is("left_at", null);
  if (rErr || !Array.isArray(roster)) return retry("roster");
  const archived = archivedRecipients(roster as Array<{ user_id?: unknown; archived_at?: unknown }>, senderId, signal);
  withheld.push(...archivedWithheld(archived)); // archived NOW: an archive made during the window is honoured
  const others: string[] = [];
  for (const r of roster as Array<{ user_id?: unknown; joined_at?: unknown; visible_from_at?: unknown }>) {
    const id = String(r?.user_id ?? "");
    if (id.length === 0 || id === senderId || others.includes(id) || withheld.some((w) => w.userId === id)) continue;
    if (Math.max(msOf(r.joined_at), msOf(r.visible_from_at)) > atMs) { withheld.push({ userId: id, reason: "joined_after" }); continue; }
    others.push(id);
  }
  if (others.length === 0) return settle("complete");

  // 3. The blocks NOW, both ways: a block made since is honoured. Unknown tells nobody this attempt (the door's rule).
  const blocks = await readBlockExclusions(sc, senderId, { among: others });
  if (!blocks.ok) return retry("blocks");
  const eligible = others.filter((id) => {
    if (!isExcluded(blocks, id)) return true;
    withheld.push({ userId: id, reason: "blocked" });
    return false;
  });
  if (eligible.length === 0) return settle("complete");

  // 4. Who already HAS it: a notification carrying this message's causal id, whoever wrote it. Unknown tells nobody
  //    this attempt — never twice.
  const causal = causalEventIdOf({ objectType: "MESSAGE", objectId: messageId });
  if (causal === null) return retry("told");
  const told = new Set<string>();
  for (let i = 0; i < eligible.length; i += TOLD_CHUNK) {
    const { data, error } = await sc.from("notifications").select("user_id").in("user_id", eligible.slice(i, i + TOLD_CHUNK)).eq("metadata->>causal_event_id", causal);
    if (error || !Array.isArray(data)) return retry("told");
    for (const t of data as Array<{ user_id?: unknown }>) told.add(String(t?.user_id ?? ""));
  }
  const untold = eligible.filter((id) => !told.has(id));
  if (untold.length === 0) return settle("complete");

  // 5. Still open? Read only when someone is untold (most re-checks end at 4): the thread's own §15.2 signal rows.
  const { data: rows, error: modeErr } = await sc
    .from("messages")
    .select("id, sender_id, created_at, deleted_at, msg_type, subtype, body")
    .eq("thread_id", threadId)
    .in("msg_type", ["safety", "coordination"])
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(SAFETY_REDRIVE_MODE_SCAN_LIMIT);
  if (modeErr || !Array.isArray(rows)) return retry("mode");
  const signalRows = (rows as SafetyInputRow[]).filter((r) => r.id !== messageId);
  const later = readSafetySignals(signalRows).filter((s) => msOf(s.at) > atMs);
  if (signal === "all_clear") {
    const before = projectSafetyMode({ threadId, rows: signalRows.filter((r) => msOf(r.created_at) <= atMs), nowMs: atMs });
    if (before.mode === "NORMAL") return settle("ends_nothing");
    if (later.some((s) => s.raises !== null)) return settle("superseded");
  } else if (later.some((s) => s.kind === "all_clear")) {
    return settle("cleared");
  }

  // 6. Tell the rest, exactly as the door would have.
  const actor = await actorLabel(sc, senderId).catch(() => "Someone");
  const deps = opts.deps ?? (await defaultDeps(sc));
  const eventType = signal === "all_clear" ? SAFETY_ALL_CLEAR_EVENT : SAFETY_ALERT_EVENT;
  const out = await deliverSafetySignal(deps, sc, { threadId, senderId, messageId, signal, eventType, actor }, untold, opts.log);
  if (out.withheld.some((w) => w.reason !== DEDUPED)) return retry("deliver", out.notified); // a `deduped` member counts as told (file foot)
  withheld.push(...out.withheld); return settle("complete", out.notified);
}

// ═════════════════════════════════════════════════════════════════════════════
// ARCHIVED CONVERSATIONS — OWNER RULING 2026-10-17
// ═════════════════════════════════════════════════════════════════════════════
/**
 * THE RULING (relayed by the lead): "Archived conversations can still receive
 * new help requests. … prevent new help requests from being routed to archived
 * conversations; preserve conversation history and existing requests; allow
 * users to unarchive conversations; ensure archived conversations are excluded
 * from active request routing."
 *
 * HOW ARCHIVING WORKS HERE, MEASURED (2026-10-17). It is PER MEMBER:
 * `message_thread_members.archived_at` (baseline :7501; in the production
 * capture). GET /me/threads returns it as `archivedAt` (routes/messaging.ts).
 *   - The ONLY writer is Rent-a-Buddy booking completion
 *     (routes/rentABuddy.ts, the two `.update({ archived_at })` sites), which
 *     archives the booking thread for EVERY member when the booking completes
 *     and the pair did not both choose "stay connected".
 *   - UNARCHIVE (wave 5): POST /threads/:threadId/unarchive (routes/
 *     telegraphArchive.ts) clears the caller's OWN archived_at. Members still
 *     cannot write the table (baseline mtm_insert / mtm_select only).
 *   - `message_threads.status` ('active' | 'archived') is a per-THREAD value
 *     with no writer, and TELEGRAPH_POLICY_THREAD_ARCHIVED is declared but not
 *     enforced anywhere; it is not read here.
 *
 * WHAT THIS DOES. A help request — telegraph.sos: §6.2 need_help, heads_up and
 * §9.1's NEED_HELP quick state — is not routed to a recipient whose
 * archived_at is set, at the door and on every re-drive attempt (re-read, so
 * an archive made during the window is honoured). The message itself is
 * written and stays in the thread's history unchanged; notifications already
 * delivered are untouched. Clearing archived_at (POST /threads/:id/unarchive)
 * makes the NEXT help request route normally — nothing is remembered.
 *
 * NOT CHANGED: the ALL CLEAR (telegraph.safety_all_clear) — it is not a
 * request, and someone who archived after an SOS reached them should still
 * learn it is over — and ordinary messages (T256, messageNotifications.ts),
 * which still notify an archived member exactly as before. The ruling is about
 * help requests only.
 *
 * AN UNREADABLE ARCHIVE STATE is read in the SAME statement as the roster, so
 * it is an unreadable roster: nobody is told at that moment, it is logged at
 * ERROR, and the durable re-drive re-attempts it for 15 minutes. It is never
 * guessed in either direction — "everyone" would ignore an archive, "nobody
 * for good" is the silent drop the re-drive exists to prevent.
 */
function archivedRecipients(rows: ReadonlyArray<{ user_id?: unknown; archived_at?: unknown }>, senderId: string, signal: SafetySignal): Set<string> {
  const out = new Set<string>();
  if (signal === "all_clear") return out;
  for (const r of rows) {
    const id = String(r?.user_id ?? "");
    if (id.length > 0 && id !== senderId && r?.archived_at != null) out.add(id);
  }
  return out;
}

function archivedWithheld(archived: ReadonlySet<string>): Array<{ userId: string; reason: string }> {
  return [...archived].map((userId) => ({ userId, reason: "archived" }));
}

// ═════════════════════════════════════════════════════════════════════════════
// A CREATE THE NOTIFICATION LAYER COALESCED — `deduped` (Fable pass 4 §2.1)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * THE DEFECT. `create` answers null both when nothing could be written and
 * when NotificationService legitimately COALESCED the notification into one
 * the member already holds: NotificationDeduplicationService rule 4 (a P1 ALL
 * CLEAR inside the ladder's 60 s window of an earlier ALL CLEAR from this
 * producer in the same thread) or rule 0b (a row carrying this message's
 * causal id, landed by another writer between the re-drive's "already told"
 * read and the create). Read as `not_created`, that was an ERROR at the door
 * and a re-attempt at every point, and while the coalescing held it ended in a
 * false "GAVE UP" ERROR for a member who was correctly not told twice.
 *
 * `deduped` — COUNTED AS TOLD. The layer refused the create as a DUPLICATE
 * (refusal `duplicate`, NotificationService.createDetailed) AND this module
 * then READ, for that member, an EQUIVALENT notification:
 *   - a row carrying this message's causal id MESSAGE:<id>, any event, whoever
 *     wrote it (the re-drive's own "already told" rule); or
 *   - rule 4's identity, made exact: inside the ladder's window for this event
 *     type (measured now, on the clock the layer used), the member's NEWEST
 *     row from this producer for this thread is of THIS event type. It already
 *     says what this one says: nothing different has been said since.
 * The door settles; a re-drive attempt settles instead of retrying. A
 * `deduped` member is never counted as `notified`.
 *
 * `coalesced` — RE-ATTEMPTED, at WARN. The layer coalesced it into an ALL
 * CLEAR the member holds, but something DIFFERENT from this producer reached
 * them after that one: a help request. That is the one realistic way rule 4
 * swallows a door-sent ALL CLEAR (need_help, ALL CLEAR, need_help, ALL CLEAR
 * inside 60 s): the earlier ALL CLEAR answered the earlier request, and the
 * member's last word from this thread is "asked for help". Not equivalent —
 * the ladder's own P1 rule is that two real changes both arrive — so it is
 * re-attempted, and it goes, once, at the first point after the layer's 60 s
 * window lapses (measured on one clock: written 30 s late). Were it still held
 * back at the last point, the GAVE UP ERROR would be true: that member never
 * learned the request was answered.
 *
 * A DUPLICATE REFUSAL ALONE IS NOT EVIDENCE. The layer also answers
 * "duplicate" when its ledger cannot be read (NotificationDeduplicationService
 * "AN UNREADABLE LEDGER IS A DUPLICATE"). With no such row seen — or when this
 * read fails — the member stays `not_created`: ERROR, re-attempted at every
 * point, given up on loudly. The house precedent is LayoverCrewAbortNotice's
 * `priorNotices`.
 *
 * P0 IS NEVER `deduped` (nor `coalesced`), twice over. (1) The layer never
 * answers duplicate for telegraph.sos: the ladder gives P0 window 0, which
 * skips rule 0b and rule 4, and rules 1-3 belong to other events — it reads no
 * ledger at all. (2) Should that ever change, `dedupeCandidate` refuses both
 * classes for SAFETY_ALERT_EVENT outright: a P0 duplicate refusal is
 * `not_created` (ERROR, re-driven, GAVE UP at ERROR) and no evidence is even
 * read. A help request is never settled by a coalescing rule.
 *
 * STATED LIMITS. Like every settle, `deduped` lives in the in-process memo:
 * after a restart inside the window the catch-up attempt asks the layer again,
 * and if its window has lapsed the ALL CLEAR is written then — once (its
 * causal id then holds it). An attempt in which one member is `deduped` and
 * another's create failed is retried; the retry asks the layer again for
 * both, under the same once-per-message bound.
 */
const DEDUPED = "deduped";
const COALESCED = "coalesced";

/** Only a non-P0 can be coalesced into what the member holds; a P0 duplicate refusal is a failure (above). */
function dedupeCandidate(eventType: string, refusal: NotificationCreateRefusal | null): boolean {
  return refusal === "duplicate" && eventType !== SAFETY_ALERT_EVENT;
}

/** `create`, saying why nothing was written when the deps can (NotificationService.createDetailed); a bare null otherwise. */
async function createSafetyRow(deps: SafetyNotifyDeps, input: CreateNotificationInput): Promise<{ row: NotificationRow | null; refusal: NotificationCreateRefusal | null }> {
  if (typeof deps.createDetailed === "function") return deps.createDetailed(input);
  return { row: await deps.create(input), refusal: null };
}

/** Each duplicate refusal: `deduped` (an equivalent is SEEN), `coalesced` (held back, not equivalent: WARN), else `not_created` at ERROR. */
async function classifyDuplicates(
  sc: SupabaseClient,
  m: { threadId: string; messageId: string; signal: SafetySignal; eventType: string },
  candidates: readonly string[],
  log: SafetyNotifyLog | undefined,
): Promise<Array<{ userId: string; reason: string }>> {
  if (candidates.length === 0) return [];
  const held = await readEquivalentHolders(sc, m, candidates);
  const out: Array<{ userId: string; reason: string }> = [];
  for (const userId of candidates) {
    const reason = held === null ? null : held.equivalent.has(userId) ? DEDUPED : held.coalesced.has(userId) ? COALESCED : null;
    if (reason !== null) { out.push({ userId, reason }); continue; }
    out.push({ userId, reason: "not_created" });
    loud(log, { threadId: m.threadId, signal: m.signal, userId, refusal: "duplicate", evidence: held === null ? "unreadable" : "none" }, "SAFETY notification not created for one member: refused as a duplicate, but no notification it duplicates could be seen (the layer's ledger may be unreadable) — re-attempted");
  }
  const of = (r: string) => out.filter((w) => w.reason === r).map((w) => w.userId);
  if (of(DEDUPED).length > 0) log?.warn({ threadId: m.threadId, signal: m.signal, deduped: of(DEDUPED) }, "SAFETY notification coalesced by the notification layer: the member already holds an equivalent one — counted as told, not re-attempted");
  if (of(COALESCED).length > 0) log?.warn({ threadId: m.threadId, signal: m.signal, coalesced: of(COALESCED) }, "SAFETY notification held back by the notification layer's coalescing window, but a help request reached the member since the one it was coalesced into — re-attempted; it goes once the window lapses");
  return out;
}

/** Who holds an EQUIVALENT of this create, and who only one it was coalesced into (above). null = it could not be read. */
async function readEquivalentHolders(sc: SupabaseClient, m: { threadId: string; messageId: string; eventType: string }, userIds: readonly string[]): Promise<{ equivalent: Set<string>; coalesced: Set<string> } | null> {
  const causal = causalEventIdOf({ objectType: "MESSAGE", objectId: m.messageId });
  const windowMs = dedupeWindowFor(m.eventType);
  const since = typeof windowMs === "number" && windowMs > 0 ? new Date(Date.now() - windowMs).toISOString() : null;
  const equivalent = new Set<string>();
  const coalesced = new Set<string>();
  try {
    for (let i = 0; i < userIds.length; i += TOLD_CHUNK) {
      const chunk = userIds.slice(i, i + TOLD_CHUNK);
      if (causal !== null) {
        const { data, error } = await sc.from("notifications").select("user_id").in("user_id", chunk).eq("metadata->>causal_event_id", causal);
        if (error || !Array.isArray(data)) return null;
        for (const r of data as Array<{ user_id?: unknown }>) equivalent.add(String(r?.user_id ?? ""));
      }
      if (since === null) continue;
      // Everything this producer told them about this thread inside the window, newest first per member.
      const { data, error } = await sc.from("notifications").select("user_id, event_type, created_at").in("user_id", chunk).eq("source_type", SAFETY_NOTIFICATION_SOURCE).eq("source_id", m.threadId).gt("created_at", since);
      if (error || !Array.isArray(data)) return null;
      const newest = new Map<string, { atMs: number; same: boolean }>();
      const hasSame = new Set<string>();
      for (const r of data as Array<{ user_id?: unknown; event_type?: unknown; created_at?: unknown }>) {
        const u = String(r?.user_id ?? "");
        const same = r?.event_type === m.eventType;
        const atMs = msOf(r?.created_at);
        if (same) hasSame.add(u);
        const cur = newest.get(u);
        if (!cur || atMs > cur.atMs) newest.set(u, { atMs, same });
        else if (atMs === cur.atMs && !same) cur.same = false; // a tie is not "nothing different since"
      }
      for (const u of hasSame) if (!equivalent.has(u)) (newest.get(u)?.same ? equivalent : coalesced).add(u);
    }
  } catch {
    return null;
  }
  for (const u of equivalent) coalesced.delete(u);
  return { equivalent, coalesced };
}
