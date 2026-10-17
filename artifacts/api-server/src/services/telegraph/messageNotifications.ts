/**
 * Telegraph §19 P2 / §30A.6 — the MESSAGE notification (census-telegraph T256).
 *
 * Spec §19: "P2 Message — Normal direct/group messages — Standard notification
 * policy." §30A.6: "Define notification causes including MESSAGE, MENTION, …,
 * and SAFETY." "Deduplicate notifications by underlying causal event."
 * "Thread notification policy may support ALL, MENTIONS, IMPORTANT, temporary
 * mute, and MUTED. Safety-critical delivery remains governed by the safety
 * policy rather than ordinary mute."
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 * The `telegraph.message` template, its P2 band and its coalescing rule all
 * existed; nothing in the server ever created one. A member who was not looking
 * at the thread was told about an @mention and nothing else. 49780ca56 restated
 * T256 C → W for exactly that.
 *
 * ── WHAT THIS PRODUCES ──────────────────────────────────────────────────────
 * One `telegraph.message` notification per other active member, for a message a
 * PERSON sent through a send door: text (and the app-authored cards the text
 * door carries), media, voice, a share, and the typed kinds that are ordinary
 * messages (GIF, album, Memory Note). Not for protocol rows (`e2ee_welcome`),
 * not for the coordination door (its own COORDINATION producer), and not for
 * LOCATION / SAFETY / ACTION / ANNOUNCEMENT, whose causes are their own.
 *
 * ── WHO IS TOLD, IN ORDER — and every unknown tells NOBODY ──────────────────
 *   1. The conversation's other ACTIVE members (a failed roster read: nobody).
 *      Never the sender.
 *   2. Minus anyone in a block with the sender, EITHER direction
 *      (`readBlockExclusions`; an unreadable blocks table: nobody).
 *   3. The CAUSE. §15.2's conversation safety mode decides it: while the
 *      conversation is in SAFETY_EVENT (somebody asked for help and no ALL CLEAR
 *      has been posted), a message from THE PERSON WHO ASKED is SAFETY-critical
 *      and its cause is SAFETY, so §30A.6's rule applies — a thread mute or a
 *      MENTIONS-only choice does not silence it. Every other message is
 *      MESSAGE. An unreadable safety state is MESSAGE: overriding somebody's
 *      mute needs evidence, and its absence is not evidence (logged, and
 *      reported in the outcome).
 *   4. Each member's thread choice for that cause — `decideThreadNotification`,
 *      the decision the mention and coordination paths take (MUTED, a temporary
 *      mute, MENTIONS, IMPORTANT all exclude MESSAGE). A failed read of the
 *      choices tells nobody, except a SAFETY message, which the decision
 *      delivers whatever the state.
 * Then the ordinary pipeline: NotificationService.create (dedupe, privacy
 * guard, persist) and NotificationRouter.route (preferences, quiet hours, push).
 *
 * ── BAND AND DEDUPE ─────────────────────────────────────────────────────────
 * The event is `telegraph.message`, §19's P2 in the attention ladder: the
 * source is the THREAD, so a burst in one conversation coalesces inside P2's
 * five minutes (NotificationDeduplicationService rule 1). A SAFETY-cause
 * message coalesces only with other SAFETY-cause messages (source
 * `thread_safety`), never into an ordinary burst it would otherwise be hidden
 * behind. The causal identity is the message itself (`MESSAGE:<id>`): a
 * recipient the same message already notified — as an @mention, through the
 * mention path's own id — is not told twice.
 *
 * ── WHAT A LOCK SCREEN CAN SAY ──────────────────────────────────────────────
 * The sender (their shown name only when they show their real name, else their
 * @handle, else "Someone") and the template's fixed "New message". NEVER THE
 * BODY. The template accepts a `preview`; this producer passes none, by
 * default and on purpose: the notification row is shared by every channel and
 * is persisted, so a preview would copy private message text into a second
 * table that unsend and deletion do not reach, onto a lock screen anyone can
 * read, and — in an end-to-end encrypted conversation — it does not exist to
 * copy. No census row or spec clause allows a preview, and the stored
 * `notification_preferences.message_previews` is consulted nowhere, so it is
 * not read as one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isExcluded, readBlockExclusions } from "../../lib/exclusionSet.js";
import { decideThreadNotification, type NotificationCause } from "../../domain/telegraph/policies/threadNotificationPolicy.js";
import { NO_THREAD_CHOICE, readThreadNotificationStates } from "./threadNotificationState.js";
import { projectSafetyMode, type SafetyInputRow } from "./safetyMode.js";
import { actorLabel } from "./coordinationNotifications.js";
import type { CreateNotificationInput, NotificationRow } from "../notifications/NotificationService.js";
import { causalEventIdOf } from "../notifications/NotificationDeduplicationService.js";

export const MESSAGE_NOTIFICATION_EVENT = "telegraph.message" as const;
export const MESSAGE_NOTIFICATION_SOURCE = "thread" as const;
export const SAFETY_MESSAGE_NOTIFICATION_SOURCE = "thread_safety" as const;

/** How far back the safety read looks — the coordination route's own scan bound (telegraphCoordination.ts COORDINATION_SCAN_LIMIT). */
export const SAFETY_SCAN_LIMIT = 400;

/** The causal identity of a message (T397): the mention path and this producer name the same event, so one message notifies a person once. */
export function messageCausalEventId(messageId: string): string | undefined {
  return causalEventIdOf({ objectType: "MESSAGE", objectId: messageId }) ?? undefined;
}

/** The app-authored cards the text door carries as `system` rows: a person shared something. `e2ee_welcome` is protocol. */
const NOTIFIABLE_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set(["discovery_card", "post_card", "compass_card", "meetup"]);

/**
 * §6.2 kinds that are an ordinary message (MESSAGE): a GIF, a photo album, a Memory Note, a shared Portava object.
 * NOT LOCATION, SAFETY, ACTION or ANNOUNCEMENT — §30A.6 gives those their own causes (LOCATION, SAFETY, and the
 * operational ones), and filing one as MESSAGE would let a MENTIONS-only choice or a coalesced burst hide it.
 */
const ORDINARY_TYPED_KINDS: ReadonlySet<string> = new Set(["gif", "media_album", "memory_note", "portava_object"]);

/** True for a row a person sent that an ordinary send door wrote. */
export function isNotifiableMessage(row: { msgType: string | null | undefined; subtype?: string | null }): boolean {
  const t = typeof row.msgType === "string" ? row.msgType : "";
  if (t === "text" || t === "media" || t === "voice" || ORDINARY_TYPED_KINDS.has(t)) return true;
  if (t === "system") return typeof row.subtype === "string" && NOTIFIABLE_SYSTEM_SUBTYPES.has(row.subtype);
  return false;
}

export interface MessageNotifyDeps {
  create(input: CreateNotificationInput): Promise<NotificationRow | null>;
  route(row: NotificationRow): Promise<void>;
}

export interface MessageNotifyLog {
  warn(obj: object, msg: string): void;
}

export type MessageNotifyOutcome =
  | {
      readonly status: "notified";
      readonly cause: NotificationCause;
      /** `unreadable` when the safety state could not be read (the cause then stayed MESSAGE). */
      readonly safety: "read" | "unreadable";
      readonly notified: string[];
      readonly withheld: Array<{ userId: string; reason: string }>;
    }
  | { readonly status: "skipped"; readonly reason: "not_a_person_message" }
  | { readonly status: "refused"; readonly stage: "roster" | "blocks" | "thread_policy" | "threw" };

export interface MessageNotifyInput {
  threadId: string;
  senderId: string;
  messageId: string;
  msgType: string | null | undefined;
  subtype?: string | null;
  nowMs: number;
}

async function defaultDeps(sc: SupabaseClient): Promise<MessageNotifyDeps> {
  const { NotificationService } = await import("../notifications/NotificationService.js");
  const { NotificationRouter } = await import("../notifications/NotificationRouter.js");
  const ns = new NotificationService(sc);
  const nr = new NotificationRouter(sc);
  return { create: (input) => ns.create(input), route: (row) => nr.route(row) };
}

/** Is the sender the person whose unanswered help request holds this conversation in SAFETY_EVENT? */
async function senderRaisedSafetyEvent(sc: SupabaseClient, threadId: string, senderId: string, nowMs: number): Promise<boolean | null> {
  try {
    const { data, error } = await sc
      .from("messages")
      .select("id, sender_id, created_at, deleted_at, msg_type, subtype, body")
      .eq("thread_id", threadId)
      .in("msg_type", ["safety", "coordination"])
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(SAFETY_SCAN_LIMIT);
    if (error || !Array.isArray(data)) return null;
    const projection = projectSafetyMode({ threadId, rows: data as SafetyInputRow[], nowMs });
    return projection.mode === "SAFETY_EVENT" && projection.raisedBy === senderId;
  } catch {
    return null;
  }
}

/**
 * Tell the conversation's other members that a message arrived. NEVER rejects —
 * the send doors fire it without awaiting, after the write has answered — and a
 * failure at any gate tells nobody and says which gate.
 */
export async function notifyNewMessage(
  sc: SupabaseClient,
  input: MessageNotifyInput,
  opts: { deps?: MessageNotifyDeps; log?: MessageNotifyLog } = {},
): Promise<MessageNotifyOutcome> {
  try {
    return await tellMembers(sc, input, opts);
  } catch (err) {
    opts.log?.warn({ err, threadId: input.threadId }, "message notification threw before anyone was told (the message itself was written)");
    return { status: "refused", stage: "threw" };
  }
}

async function tellMembers(
  sc: SupabaseClient,
  input: MessageNotifyInput,
  opts: { deps?: MessageNotifyDeps; log?: MessageNotifyLog },
): Promise<MessageNotifyOutcome> {
  const { threadId, senderId, messageId, nowMs } = input;
  if (!isNotifiableMessage(input)) return { status: "skipped", reason: "not_a_person_message" };

  // 1. The other active members. Never the sender.
  const { data: roster, error: rosterErr } = await sc
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", threadId)
    .is("left_at", null);
  if (rosterErr || !Array.isArray(roster)) return { status: "refused", stage: "roster" };
  const others = [...new Set((roster as Array<{ user_id: unknown }>).map((r) => String(r.user_id ?? "")).filter((id) => id.length > 0 && id !== senderId))];

  // 2. Nobody in a block with the sender, either way. Unknown block state tells nobody.
  const blocks = await readBlockExclusions(sc, senderId, { among: others });
  if (!blocks.ok) return { status: "refused", stage: "blocks" };
  const withheld: Array<{ userId: string; reason: string }> = [];
  const unblocked = others.filter((id) => {
    if (!isExcluded(blocks, id)) return true;
    withheld.push({ userId: id, reason: "blocked" });
    return false;
  });

  // 3. The cause: SAFETY only for the person who asked for help, while it stands.
  const raised = unblocked.length > 0 ? await senderRaisedSafetyEvent(sc, threadId, senderId, nowMs) : false;
  if (raised === null) opts.log?.warn({ threadId }, "message notification: the conversation's safety state is unreadable — the message is notified as an ordinary one (no mute is overridden without evidence)");
  const cause: NotificationCause = raised === true ? "SAFETY" : "MESSAGE";
  const safety = raised === null ? "unreadable" as const : "read" as const;
  if (unblocked.length === 0) return { status: "notified", cause, safety, notified: [], withheld };

  // 4. Each member's thread choice for that cause.
  const states = await readThreadNotificationStates(sc, threadId, unblocked);
  if (!states.ok && cause !== "SAFETY") return { status: "refused", stage: "thread_policy" };
  const deliverTo = unblocked.filter((id) => {
    const decision = decideThreadNotification({ cause, state: states.ok ? (states.states.get(id) ?? NO_THREAD_CHOICE) : null, nowMs });
    if (!decision.deliver) withheld.push({ userId: id, reason: decision.reason });
    return decision.deliver;
  });
  if (deliverTo.length === 0) return { status: "notified", cause, safety, notified: [], withheld };

  const actor = await actorLabel(sc, senderId);
  const deps = opts.deps ?? (await defaultDeps(sc));
  const causalEventId = messageCausalEventId(messageId);
  const notified: string[] = [];
  await Promise.all(deliverTo.map(async (userId) => {
    try {
      const row = await deps.create({
        userId,
        eventType: MESSAGE_NOTIFICATION_EVENT,
        actorId: senderId,
        senderId,
        sourceType: cause === "SAFETY" ? SAFETY_MESSAGE_NOTIFICATION_SOURCE : MESSAGE_NOTIFICATION_SOURCE,
        sourceId: threadId,
        // No `preview`: the template's fixed "New message" (header).
        params: { actor, threadId },
        metadata: { cause },
        ...(causalEventId ? { causalEventId } : {}),
      });
      if (!row) { withheld.push({ userId, reason: "not_created" }); return; }
      notified.push(userId);
      await deps.route(row);
    } catch (err) {
      opts.log?.warn({ err, threadId }, "message notification failed for one member (the message itself was written)");
    }
  }));
  return { status: "notified", cause, safety, notified, withheld };
}
