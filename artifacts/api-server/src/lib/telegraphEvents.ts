/**
 * Telegraph realtime event bus.
 *
 * An in-memory pub/sub used by the SSE delivery layer (telegraphStream route).
 * Mutating routes publish small, structured events to the set of affected
 * users; each open SSE connection registers one subscriber callback.
 *
 * Single-instance delivery is handled by `publishToUsersLocal`, which writes
 * directly to the in-memory subscriber map.  `publishToUsers` additionally
 * calls the broadcast hook (when registered) so the same event reaches clients
 * connected to other server instances via the cross-instance channel
 * (telegraphBroadcast).
 *
 * The bus never throws into callers — publish failures are logged and swallowed
 * so realtime delivery can never break a write path.  The mobile client always
 * keeps a polling fallback, so any missed event self-heals on the next poll.
 *
 * "Swallowed" is not the same as "invisible".  An emitter that cannot fail
 * visibly cannot be operated: when realtime silently stops, the only symptom is
 * users reporting that the app "feels slow", which is unattributable.  Every
 * swallow point below therefore leaves BOTH a log line naming what was lost and
 * a counter (see `telegraphEmitterStats`) so the loss is a number an operator
 * can scrape, alert on and compare across deploys — not one line in a log they
 * would have to already suspect in order to search for.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

export type TelegraphEventType =
  | "thread.updated"
  | "message.created"
  | "message.updated"
  /**
   * Telegraph §13.2 `message.deleted`. census-telegraph T182: "Not in the event
   * union, and `routes/groupChat.ts:340-381` publishes nothing at all — a
   * delete reaches other clients only on their next poll." The row is retained
   * and redacted (the tombstone §17.2 requires), so this event carries the
   * message id and NOT the body — there is no body left to carry, and a
   * consumer that wanted one would be asking for the thing the delete removed.
   */
  | "message.deleted"
  /**
   * Telegraph §13.2 `message.unsent`. census-telegraph T181: "Absent. PR #472
   * adds no event either — its diff against `lib/telegraphEvents.ts` is empty."
   *
   * Distinct from `message.deleted` and the distinction is the product's claim:
   * an unsend asserts the message never reached a mind, and §7.4 refuses it
   * once any eligible recipient has seen it. A client that collapsed the two
   * into one "gone" state would render a retraction as a tombstone and lose the
   * only difference that matters to the person who sent it.
   */
  | "message.unsent"
  | "message.translated"
  /**
   * Telegraph §13.2 `member.joined`. census-telegraph T185: "Not in the union;
   * only `member.left` exists. A trip-membership sync (`services/groupChatSync.ts`)
   * is silent to open clients." The payload names WHO joined and by what route
   * (`source: 'trip_sync' | 'circle_sync' | 'request_accepted'`), because a
   * client showing "X joined" needs to know it was a membership sync rather
   * than an invite that does not exist (T212).
   */
  | "member.joined"
  | "member.left"
  | "typing.started"
  | "typing.stopped"
  | "read.updated"
  /**
   * Telegraph §13.2 `message.seen`. census-telegraph T179: "`read.updated` …
   * carries a **thread-level** `lastReadAt`, not a per-message seen fact, so no
   * consumer can answer 'was *this* message seen'."
   *
   * It joins `read.updated` rather than replacing it: the two answer different
   * questions and both have consumers. `read.updated` says where a person's
   * marker now is — which is what an unread count needs. This one names the
   * MESSAGE IDS that crossed the marker on this advance, which is what a sender
   * watching their own message needs, and what §7.4's unseen-unsend window is
   * closed by.
   *
   * The payload carries ids, a reader and a timestamp, and never a body: a
   * seen event is a fact about delivery, not a copy of the conversation, and it
   * is fanned out to a whole thread.
   */
  | "message.seen"
  | "request.created"
  | "request.accepted"
  | "request.declined"
  | "user.blocked"
  /**
   * Telegraph §13.2 `safety.reported`. census-telegraph T194: "Not in the
   * union; reports write a row and emit nothing."
   *
   * DELIVERED TO THE REPORTER ONLY, and that is the whole design. Telling the
   * reported party that a report exists is the fastest way to get a reporter
   * hurt, and telling the rest of a group thread turns a safety action into a
   * public accusation. The reporter gets it because THEY need the confirmation
   * — a report whose only feedback is a toast that has already gone is a report
   * people file twice. The payload carries the target TYPE and the report id,
   * never the target's identity.
   */
  | "safety.reported"
  | "call.incoming"
  | "call.accepted"
  | "call.declined"
  | "call.canceled"
  | "call.ended"
  | "call.missed"
  | "call.group_started"
  | "call.group_ended"
  | "call.room_updated"
  | "call.role_changed"
  | "call.removed_from_room"
  /** Sent to the client before closing a connection whose access has been revoked. */
  | "access.revoked"
  /** Sent to the client when the maximum connection lifetime is reached — client should reconnect. */
  | "reconnect" | "message.delivered" | "stream.resumed" | "availability.started" | "availability.expired" | "location.started" | "location.expired" | "coordination.started" | "coordination.completed"; // see TELEGRAPH_DELIVERY_EVENT_NOTES and TELEGRAPH_LIFECYCLE_EVENT_NOTES

export interface TelegraphEvent {
  type: TelegraphEventType;
  /** Thread the event belongs to, when applicable. */
  threadId?: string | null;
  /** Event-specific data. Never include message bodies or other PII. */
  payload?: Record<string, unknown>;
  /** ISO timestamp set at publish time. */
  ts: string;
}

/**
 * TELEGRAPH_DELIVERY_EVENT_NOTES — the two event types declared on one line in
 * `TelegraphEventType` above.
 *
 * They are folded onto the `reconnect` line rather than given a stanza each
 * inside the union for one reason that has nothing to do with style: three
 * sibling censuses cite this file by `path:line`, and `census-layover.md` cites
 * `:122` — the `payload` field's comment. Adding stanzas above it silently
 * repoints another lane's evidence at the wrong line. The declaration stays
 * put; the explanation moves below every cited line. If this file is ever
 * renumbered deliberately, move these back up.
 *
 * `message.delivered` — Telegraph §13.2. census-telegraph T178: "No delivered
 * concept exists to emit (T69)", and T69: "no DELIVERED concept anywhere ...
 * State is inferred from `created_at`, `edited_at`, `deleted_at` and the
 * thread-level `last_read_at`."
 *
 *   WHAT IT CLAIMS, EXACTLY. That a recipient had an open realtime connection
 *   which ACCEPTED this message's `message.created` event. Nothing more. It
 *   does not claim the message reached the device's storage — this transport
 *   has no client acknowledgement to carry that — and it does not claim anybody
 *   read it, which is `message.seen` and has a different writer. A DELIVERED
 *   that over-claimed would be worse than no DELIVERED: a sender who believes a
 *   message landed stops re-sending it.
 *
 *   ADDRESSED TO THE SENDER, AND ONLY THE SENDER. A delivery receipt is also a
 *   presence disclosure — it says somebody's device is online right now — so it
 *   goes to the one person already entitled to know the message's fate, and it
 *   carries a COUNT rather than a roster. See `emitDeliveryReceipt`.
 *
 * `stream.resumed` — Telegraph §17.3, the outcome of a reconnect resume,
 * emitted once per connection alongside the other two per-connection frames
 * (`reconnect`, `access.revoked`). A client parser dispatches on this union, so
 * a frame type absent from it is a frame nobody can register a handler for.
 * `resumed: false` is an instruction, not a status line: the gap was NOT closed
 * and a full poll is required. See `routes/telegraphStream.ts`.
 */
type Subscriber = (event: TelegraphEvent) => void;

/** userId -> set of subscriber callbacks (one per open SSE connection). */
const subscribers = new Map<string, Set<Subscriber>>();

// ── Emitter observability ─────────────────────────────────────────────────────

/**
 * Counters for everything this bus swallows, so a realtime outage is a number
 * rather than a rumour. Monotonic for the life of the process; read via
 * `telegraphEmitterStats()`.
 */
export interface TelegraphEmitterStats {
  /** publishToUsers calls that resolved a non-empty audience. */
  published: number;
  /** Individual subscriber callbacks successfully invoked. */
  delivered: number;
  /** Subscriber callbacks that threw — that connection missed this event. */
  subscriberErrors: number;
  /** Cross-instance fan-out threw — every OTHER instance missed this event. */
  broadcastErrors: number;
  /** Cross-instance revoke fan-out threw — a revoked session may stay open elsewhere. */
  terminateBroadcastErrors: number;
  /** publishToThread could not read the thread's members. */
  audienceResolutionFailures: number;
  /**
   * Events dropped because the audience could not be resolved. One failed read
   * loses the event for EVERY member of that thread, which is why this is
   * counted separately from the read failure itself.
   */
  eventsDroppedUnresolvedAudience: number;
  /** publishToThread resolved an audience of zero (everyone left / self-excluded). */
  emptyAudience: number;
  /** §30A.12 — presence-class events not fanned out because the thread is large. */
  presenceShedLargeConversation: number;
  /** §30A.12 — events degraded to a poll signal because the thread is very large. */
  fanoutDegradedLargeConversation: number;
  /** §13.2 `message.delivered` receipts addressed back to a sender. */
  deliveryReceiptsEmitted: number;
  /**
   * Messages whose whole audience was offline on this instance. The DELIVERED
   * half of §7.2 is only useful if the failure to deliver is also a number:
   * a rising count here is a realtime outage, and it is the one symptom that
   * otherwise reaches an operator as "the app feels slow".
   */
  messagesDeliveredNowhere: number;
}

const stats: TelegraphEmitterStats = {
  published: 0,
  delivered: 0,
  subscriberErrors: 0,
  broadcastErrors: 0,
  terminateBroadcastErrors: 0,
  audienceResolutionFailures: 0,
  eventsDroppedUnresolvedAudience: 0,
  emptyAudience: 0,
  presenceShedLargeConversation: 0,
  fanoutDegradedLargeConversation: 0,
  deliveryReceiptsEmitted: 0,
  messagesDeliveredNowhere: 0,
};

/** Snapshot of the emitter counters. */
export function telegraphEmitterStats(): TelegraphEmitterStats {
  return { ...stats };
}

/** Test hook: zero the counters. Not used by production code. */
export function _resetTelegraphEmitterStats(): void {
  for (const k of Object.keys(stats) as Array<keyof TelegraphEmitterStats>) {
    stats[k] = 0;
  }
}

// ── Cross-instance broadcast hook ─────────────────────────────────────────────

/**
 * Optional hook registered by telegraphBroadcast at startup.  When set,
 * publishToUsers fans the event out to other server instances after local
 * delivery.
 */
let _broadcastHook:
  | ((userIds: string[], event: TelegraphEvent) => void)
  | null = null;

/**
 * Register the cross-instance broadcast hook.  Called once at server startup
 * by initTelegraphBroadcast().  Subsequent calls replace the previous hook.
 */
export function setBroadcastHook(
  hook: (userIds: string[], event: TelegraphEvent) => void,
): void {
  _broadcastHook = hook;
}

// ── Connection terminator registry ────────────────────────────────────────────

/**
 * userId -> set of close callbacks (one per open SSE connection).
 * Each callback sends an access.revoked event then ends the response.
 */
const terminators = new Map<string, Set<() => void>>();

/**
 * Register a termination callback for a live SSE connection.  Returns an
 * unregister function that must be called on cleanup (alongside unsubscribe).
 */
export function registerTerminator(userId: string, terminate: () => void): () => void {
  let set = terminators.get(userId);
  if (!set) {
    set = new Set();
    terminators.set(userId, set);
  }
  set.add(terminate);
  return () => {
    const s = terminators.get(userId);
    if (!s) return;
    s.delete(terminate);
    if (s.size === 0) terminators.delete(userId);
  };
}

// ── Terminate broadcast hook ──────────────────────────────────────────────────

/**
 * Optional hook registered by telegraphBroadcast so that terminateUserConnections
 * propagates the revocation signal to other server instances as well.
 */
let _terminateBroadcastHook: ((userId: string) => void) | null = null;

/**
 * Register the cross-instance terminate hook.  Called once at startup by
 * initTelegraphBroadcast().
 */
export function setTerminateBroadcastHook(hook: (userId: string) => void): void {
  _terminateBroadcastHook = hook;
}

/**
 * Force-close all active SSE connections for a user on THIS instance only.
 * Used by telegraphBroadcast when it receives a remote terminate signal so it
 * doesn't re-broadcast and cause infinite loops.
 */
export function terminateUserConnectionsLocal(userId: string): void {
  const set = terminators.get(userId);
  if (!set) return;
  // Copy to avoid mutation during iteration.
  for (const fn of Array.from(set)) {
    try { fn(); } catch { /* socket may already be closed */ }
  }
}

/**
 * Force-close all active SSE connections for a user (e.g. after a block).
 * Terminates local connections immediately and fans the revocation signal out
 * to other instances via the registered broadcast hook (if any).
 * Safe to call when the user has no live connections.
 */
export function terminateUserConnections(userId: string): void {
  terminateUserConnectionsLocal(userId);
  if (_terminateBroadcastHook) {
    try {
      _terminateBroadcastHook(userId);
    } catch (err) {
      // A failed revoke fan-out is an ACCESS outcome, not a delivery one: the
      // user's connections on other instances stay open and keep receiving
      // events they are no longer entitled to. That is an error, not a warning.
      stats.terminateBroadcastErrors++;
      logger.error(
        { err, userId },
        "telegraph terminate broadcast hook threw — revoked sessions on other instances stay OPEN",
      );
    }
  }
}

// ── Subscriber management ─────────────────────────────────────────────────────

/**
 * Register a subscriber for a user. Returns an unsubscribe function that must
 * be called when the connection closes.
 */
export function subscribe(userId: string, cb: Subscriber): () => void {
  let set = subscribers.get(userId);
  if (!set) {
    set = new Set();
    subscribers.set(userId, set);
  }
  set.add(cb);
  return () => {
    const s = subscribers.get(userId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) subscribers.delete(userId);
  };
}

/** Number of distinct users with at least one live connection. */
export function connectedUserCount(): number {
  return subscribers.size;
}

/** Whether a user currently has at least one live connection. */
export function isUserConnected(userId: string): boolean {
  const s = subscribers.get(userId);
  return Boolean(s && s.size > 0);
}

// ── Delivery ──────────────────────────────────────────────────────────────────


// ── §13.2 message.delivered ───────────────────────────────────────────────────

/**
 * Emit the §13.2 `message.delivered` receipt for one `message.created` fan-out.
 *
 * WHY IT LIVES HERE AND NOT AT THE SEND ROUTE
 * ===========================================
 * Delivery is a fact about THIS fan-out, and only this function sees it: the
 * route knows it asked for a publish, not who was listening. Putting the
 * receipt at the send handler would also mean four handlers (`messaging.ts`
 * twice, `groupChat.ts`, and whatever comes next) each remembering to emit it,
 * and the first one to forget would produce a thread where DELIVERED silently
 * never appears. Emitting from the bus makes that unforgettable, which is the
 * same rule `emitSafetyReported` applies to its audience.
 *
 * THE RECEIPT CARRIES A COUNT, NOT A ROSTER
 * =========================================
 * `recipientUserId` is populated only when the audience was exactly ONE person.
 * In a two-party thread that names somebody the sender already knows; in a
 * larger one it would turn a delivery receipt into a per-member presence feed —
 * "who on this trip has their phone open" — which nobody in the thread agreed
 * to publish. The rule keys off audience SIZE rather than thread type because
 * this module does not know the thread type, and a rule that has to ask a
 * caller for the answer is a rule a caller can answer wrongly.
 *
 * `deliveredCount: 0` IS A CLAIM, AND IT IS SCOPED
 * ================================================
 * Zero means "no connection on THIS instance took it". With a cross-instance
 * broadcast hook registered that is not the same as offline, because another
 * instance may hold the recipient's socket and this one cannot see it. So the
 * receipt says which world it is reporting from (`crossInstance`) rather than
 * letting a consumer read a local zero as a global one.
 *
 * @param origin `"local"` for the instance that published the event, which
 *   reports its outcome even when that outcome is zero, and `"remote"` for an
 *   instance replaying a broadcast, which reports only a POSITIVE delivery —
 *   a remote zero says nothing except that this instance holds no socket, and
 *   every instance in the fleet would emit one for every message.
 */
function emitDeliveryReceipt(
  event: TelegraphEvent,
  audience: ReadonlySet<string>,
  deliveredTo: ReadonlySet<string>,
  origin: "local" | "remote",
): void {
  if (event.type !== "message.created") return;
  const payload = event.payload as Record<string, unknown> | undefined;
  const senderId = typeof payload?.senderId === "string" ? payload.senderId : null;
  const messageId = typeof payload?.messageId === "string" ? payload.messageId : null;
  // No addressee, or nothing to identify: a receipt nobody can attribute is
  // noise on a fan-out path, so none is invented.
  if (!senderId || !messageId) return;

  // A caller that forgot `excludeUserId` puts the sender in their own audience.
  // Their own copy is not a delivery and must not inflate the count.
  const recipients = new Set<string>();
  for (const uid of audience) if (uid !== senderId) recipients.add(uid);
  const delivered = new Set<string>();
  for (const uid of deliveredTo) if (uid !== senderId) delivered.add(uid);

  if (origin === "remote" && delivered.size === 0) return;
  if (recipients.size === 0) return;

  if (origin === "local" && delivered.size === 0) stats.messagesDeliveredNowhere++;
  stats.deliveryReceiptsEmitted++;

  publishToUsersLocalNoReceipt([senderId], {
    type: "message.delivered",
    threadId: event.threadId ?? null,
    ts: event.ts,
    payload: {
      messageId,
      deliveredCount: delivered.size,
      audienceCount: recipients.size,
      // Named only when there was exactly one other party — see the header.
      recipientUserId: recipients.size === 1 ? [...recipients][0] : null,
      /** Whether another instance could also hold this audience's sockets. */
      crossInstance: _broadcastHook !== null,
      deliveredAt: new Date().toISOString(),
    },
  });
}

/**
 * Local-only delivery that does NOT itself produce a receipt.
 *
 * The receipt goes to the sender, who is a different user from the audience
 * that triggered it, so there is no recursion in practice — but "in practice"
 * is not a guarantee, and a fan-out loop on a realtime bus is a livelock rather
 * than a bug report. This entry point makes the absence of recursion
 * structural: the receipt path has no way to re-enter the receipt path.
 */
function publishToUsersLocalNoReceipt(userIds: Iterable<string>, event: TelegraphEvent): void {
  for (const uid of userIds) {
    if (!uid) continue;
    const set = subscribers.get(uid);
    if (!set) continue;
    for (const cb of set) {
      try {
        cb(event);
        stats.delivered++;
      } catch (err) {
        stats.subscriberErrors++;
        logger.warn(
          { err, type: event.type },
          "telegraph delivery-receipt callback threw — that connection missed this event",
        );
      }
    }
  }
}

/**
 * Deliver an event to local subscribers only (no cross-instance fan-out).
 * Used by telegraphBroadcast when it receives a remote event so it doesn't
 * re-broadcast and cause infinite loops.
 */
export function publishToUsersLocal(
  userIds: Iterable<string>,
  event: TelegraphEvent,
): void {
  const audience = new Set<string>();
  const deliveredTo = new Set<string>();
  for (const uid of userIds) {
    if (!uid) continue;
    audience.add(uid);
    const set = subscribers.get(uid);
    if (!set) continue;
    for (const cb of set) {
      try {
        cb(event);
        stats.delivered++;
        deliveredTo.add(uid);
      } catch (err) {
        stats.subscriberErrors++;
        logger.warn(
          { err, type: event.type },
          "telegraph remote subscriber callback threw — that connection missed this event",
        );
      }
    }
  }
  // A broadcast replay reports only a POSITIVE delivery; see emitDeliveryReceipt.
  emitDeliveryReceipt(event, audience, deliveredTo, "remote");
}

/**
 * Publish an event to an explicit set of user ids.  De-duplicates ids,
 * delivers to local subscribers, then fans out to other instances via the
 * registered broadcast hook (if any).  Never throws.
 */
export function publishToUsers(
  userIds: Iterable<string>,
  event: Omit<TelegraphEvent, "ts"> & { ts?: string },
): void {
  const full: TelegraphEvent = { ...event, ts: event.ts ?? new Date().toISOString() };
  const seen = new Set<string>();
  const deliveredTo = new Set<string>();

  for (const uid of userIds) {
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const set = subscribers.get(uid);
    if (!set) continue;
    for (const cb of set) {
      try {
        cb(full);
        stats.delivered++;
        // A callback that THREW missed this event, so it is not a delivery.
        // Counting the attempt instead would make DELIVERED mean "we tried",
        // which is the claim §7.2 exists to distinguish from.
        deliveredTo.add(uid);
      } catch (err) {
        stats.subscriberErrors++;
        logger.warn(
          { err, type: full.type },
          "telegraph subscriber callback threw — that connection missed this event",
        );
      }
    }
  }
  if (seen.size > 0) stats.published++;

  emitDeliveryReceipt(full, seen, deliveredTo, "local");

  // Fan out to other instances — fire-and-forget, never block callers.
  if (_broadcastHook && seen.size > 0) {
    try {
      _broadcastHook(Array.from(seen), full);
    } catch (err) {
      // Local subscribers still got it; everyone connected to another instance
      // did not, and nothing retries. Count it so a broken channel shows up as
      // a rising number instead of as "realtime feels flaky on some phones".
      stats.broadcastErrors++;
      logger.error(
        { err, type: full.type, audience: seen.size },
        "telegraph broadcast hook threw — event NOT delivered to other instances",
      );
    }
  }
}

// ── §30A.12 bounded fan-out ───────────────────────────────────────────────────

/**
 * Above this many recipients, presence-class events are not fanned out at all.
 *
 * census-telegraph T416: "`publishToThread` fans out to every active member
 * with no size bound, and the rule is unviolated only because event
 * conversations do not exist." The bound belongs on the PATH rather than on a
 * thread type, because the path is the same one for every thread and a rule
 * that waits for its subject to appear is a rule that will be missing on the
 * day it first matters.
 *
 * Fifty is chosen to sit above every conversation this repository can actually
 * create — a trip crew, a circle — so nothing shipped changes behaviour, and
 * below any plausible "Event conversation", so the bound is real rather than
 * decorative.
 */
export const FANOUT_PRESENCE_MAX = 50;

/**
 * Above this many recipients, EVERY event degrades to a single poll signal.
 *
 * Not to silence: the member is told that the thread moved and what kind of
 * thing moved, and pulls the rest. That keeps the work of one publish bounded
 * by a constant payload rather than by the roster, which is the property §30A.12
 * asks for — and it keeps the body of a message off a fan-out that large.
 */
export const FANOUT_HARD_MAX = 500;

/**
 * Events whose cost is O(members) per KEYSTROKE and whose loss costs a reader
 * nothing. A typing indicator nobody receives is a typing indicator nobody
 * misses; a message nobody receives is a lost conversation, which is why
 * `message.created` is deliberately NOT in this set.
 */
const PRESENCE_CLASS_EVENTS: ReadonlySet<TelegraphEventType> = new Set([
  "typing.started",
  "typing.stopped",
  "read.updated",
  "message.seen",
  "message.delivered",
]);

/**
 * Resolve the active members of a thread (left_at IS NULL) and publish to them,
 * optionally excluding one user (typically the actor). Best-effort: a failure
 * to resolve members is logged, counted and swallowed.
 *
 * §30A.12: the fan-out is BOUNDED. See FANOUT_PRESENCE_MAX / FANOUT_HARD_MAX.
 */
export async function publishToThread(
  sc: SupabaseClient,
  threadId: string,
  event: Omit<TelegraphEvent, "ts" | "threadId"> & { ts?: string },
  options: { excludeUserId?: string } = {},
): Promise<void> {
  try {
    const { data, error } = await sc
      .from("message_thread_members")
      .select("user_id")
      .eq("thread_id", threadId)
      .is("left_at", null);

    // supabase-js RESOLVES on a database error. Unchecked, `data` is null, the
    // audience is empty, and the function returns through the "nobody to tell"
    // path below — so an unreadable membership table looked EXACTLY like a
    // thread whose members had all left, and every realtime event for every
    // thread vanished without a single line of log. The two are not the same
    // outcome and are no longer reported as if they were.
    if (error) {
      stats.audienceResolutionFailures++;
      stats.eventsDroppedUnresolvedAudience++;
      logger.error(
        { err: error, threadId, type: event.type },
        "publishToThread: thread audience read FAILED — realtime event DROPPED for every member of this thread",
      );
      return;
    }

    const userIds = (data ?? [])
      .map((r: { user_id?: string }) => r.user_id)
      .filter((uid): uid is string => Boolean(uid) && uid !== options.excludeUserId);

    if (userIds.length === 0) {
      stats.emptyAudience++;
      return;
    }

    // §30A.12 — bounded strategies, applied to the resolved audience rather
    // than to a thread type, because the audience is the thing that costs.
    if (userIds.length > FANOUT_PRESENCE_MAX && PRESENCE_CLASS_EVENTS.has(event.type)) {
      stats.presenceShedLargeConversation++;
      logger.debug(
        { threadId, type: event.type, audience: userIds.length },
        "telegraph: presence-class event SHED — conversation above the presence fan-out bound",
      );
      return;
    }

    if (userIds.length > FANOUT_HARD_MAX) {
      stats.fanoutDegradedLargeConversation++;
      // A poll signal, not silence. The member learns that the thread moved and
      // what kind of thing moved; the payload stays off a fan-out this wide.
      publishToUsers(userIds, {
        type: "thread.updated",
        threadId,
        payload: { threadId, degraded: "large_conversation", originalType: event.type },
        ts: event.ts,
      });
      return;
    }

    publishToUsers(userIds, { ...event, threadId });
  } catch (err) {
    stats.audienceResolutionFailures++;
    stats.eventsDroppedUnresolvedAudience++;
    logger.error(
      { err, threadId, type: event.type },
      "publishToThread threw resolving members — realtime event DROPPED for every member of this thread",
    );
  }
}

/**
 * Telegraph §13.2 `safety.reported` — published to the REPORTER, and to nobody
 * else.
 *
 * A dedicated emitter rather than a bare `publishToUsers` call at each report
 * handler, for one reason: the audience is the load-bearing part of this event
 * and a helper makes it impossible to widen by accident. There is no parameter
 * here that could carry a thread id or a second recipient, so "who sees a
 * report" is a decision made once, in this file, rather than at every call
 * site that files one.
 *
 * The payload deliberately omits the target's identity. A reporter's own client
 * already knows what they reported; putting the reported user's id on a wire
 * that a realtime transport fans out is how it ends up somewhere it should not.
 */
export function emitSafetyReported(
  reporterUserId: string,
  payload: { reportId: string | null; targetType: "thread" | "message" | "user"; filedAt: string },
): void {
  if (!reporterUserId) return;
  publishToUsers([reporterUserId], { type: "safety.reported", threadId: null, payload });
}

/**
 * TELEGRAPH_LIFECYCLE_EVENT_NOTES — §13.2's six lifecycle events, declared on
 * the `reconnect` line in `TelegraphEventType` above.
 *
 * They are folded onto that one line for the reason TELEGRAPH_DELIVERY_EVENT_NOTES
 * gives: three sibling censuses cite this file by `path:line`, and one of them
 * cites `:122`. A stanza per event inside the union would silently repoint
 * another lane's evidence at the wrong line. The declaration stays put; the
 * explanation lives here, below every cited line.
 *
 * census-telegraph T187-T192, verbatim: `availability.started` "Not in the
 * union"; `availability.expired` "Not in the union; expiry is evaluated lazily
 * on read (`2260:38-42`) and emits nothing"; `location.started` /
 * `location.expired` "Not in the union"; `coordination.started` /
 * `coordination.completed` "No coordination (T85)".
 *
 * WHO EACH ONE GOES TO, AND WHY THE TWO HALVES DIFFER
 * ===================================================
 * `availability.*` goes to the OWNER AND NOBODY ELSE. An availability signal is
 * a presence disclosure — it says a person is free right now — and who is
 * entitled to see it is decided by §4's visibility gates
 * (`OpenToPlansService#projectPublicWindows`, the trip/circle availability
 * routes), which this bus does not re-implement and must not route around. The
 * owner's own other devices are the one audience already entitled, and they are
 * the audience that needs it: §4.3 says "availability expires automatically and
 * revokes across Telegraph, Discovery and Compass", and a second device holding
 * a chip that says FREE NOW after the window closed is exactly that revocation
 * failing to arrive. This is the same rule `emitDeliveryReceipt` applies to
 * `message.delivered` for the same reason.
 *
 * `location.*` and `coordination.*` go to the CONVERSATION, because the fact
 * they report was already published to that conversation as a `message.created`
 * — the §6.2 LOCATION message carrying the scope, the COORDINATION_SESSION
 * message that opened the session. They disclose nothing the audience does not
 * already hold, and they must reach everybody who saw the original: a location
 * scope whose expiry reaches four of five members leaves the fifth rendering a
 * live share that has ended.
 *
 * NEITHER IS PRESENCE-CLASS. `PRESENCE_CLASS_EVENTS` sheds events "whose loss
 * costs a reader nothing". The loss of an expiry costs a reader a stale privacy
 * indicator, which is the most expensive kind of staleness this product has, so
 * none of the six is in that set. They remain subject to FANOUT_HARD_MAX, whose
 * degradation is a poll signal rather than silence.
 *
 * EVERY PAYLOAD CARRIES A STABLE `eventKey`, AND WHAT THAT DOES NOT CLAIM.
 * §13.3's second sentence asks consumers to "consume asynchronously and
 * idempotently", and a consumer cannot be idempotent without a key to dedupe
 * on. `lifecycleEventKey` derives one from the event type and the subject id,
 * so two deliveries of one expiry are recognisably the same fact. It is NOT a
 * claim of exactly-once DELIVERY: this bus logs and swallows publish failures
 * by design (see the file header), so it is at-most-once per connection, and
 * the key is what lets a consumer survive the at-LEAST-once case a sweeper
 * restart can produce. census T196 records that absence as a defect; this
 * closes it for these six events and for no others.
 */

/** A stable dedupe key for a lifecycle event, for §13.3's idempotent consumers. */
export function lifecycleEventKey(type: TelegraphEventType, subjectId: string): string {
  return `${type}:${subjectId}`;
}

/**
 * §13.2 `availability.started` — published to the OWNER, and to nobody else.
 *
 * A dedicated emitter rather than a bare `publishToUsers` at each availability
 * writer, for the reason `emitSafetyReported` gives: the audience is the
 * load-bearing part and a helper makes it impossible to widen by accident.
 * There is no parameter here that could carry a thread id or a second
 * recipient.
 *
 * The payload carries the status LABEL the owner themselves set and the expiry,
 * and never a place, a coordinate or a counterpart.
 */
export function emitAvailabilityStarted(
  ownerUserId: string,
  payload: { status: string; startedAt: string; expiresAt: string | null },
): void {
  if (!ownerUserId) return;
  publishToUsers([ownerUserId], {
    type: "availability.started",
    threadId: null,
    payload: {
      ...payload,
      eventKey: lifecycleEventKey("availability.started", `${ownerUserId}:${payload.startedAt}`),
    },
  });
}

/**
 * §13.2 `availability.expired` — published to the OWNER, and to nobody else.
 *
 * `expiredAt` is the signal's OWN `expires_at`, not the moment the sweep
 * noticed. A sweep that ran late must not report the availability as having
 * lasted until the sweep: the revocation §4.3 asks for happened when the window
 * closed, and an event that said otherwise would make a late sweep look like a
 * longer disclosure than it was. `sweptAt` carries the other number so the lag
 * is visible rather than hidden.
 */
export function emitAvailabilityExpired(
  ownerUserId: string,
  payload: { status: string | null; expiredAt: string; sweptAt: string },
): void {
  if (!ownerUserId) return;
  publishToUsers([ownerUserId], {
    type: "availability.expired",
    threadId: null,
    payload: {
      ...payload,
      eventKey: lifecycleEventKey("availability.expired", `${ownerUserId}:${payload.expiredAt}`),
    },
  });
}

/**
 * §13.2 `location.started` — published to the conversation the scope was
 * declared in.
 *
 * NO COORDINATES, EVER. The event names the share, its precision, its purpose
 * and when it ends. A member entitled to the coordinates already has them, in
 * the LOCATION message itself and behind that message's own read gate; putting
 * them on a fan-out as well would create a second copy on a path with a
 * different audience calculation.
 */
export async function emitLocationStarted(
  sc: SupabaseClient,
  threadId: string,
  payload: {
    shareId: string;
    ownerUserId: string;
    precision: string;
    purpose: string | null;
    startedAt: string;
    expiresAt: string;
  },
): Promise<void> {
  if (!threadId || !payload.shareId) return;
  await publishToThread(sc, threadId, {
    type: "location.started",
    payload: { ...payload, eventKey: lifecycleEventKey("location.started", payload.shareId) },
  });
}

/**
 * §13.2 `location.expired` — published to the conversation, everybody included.
 *
 * The actor is NOT excluded here, and that is deliberate: nobody performed this
 * event. A clock did. Excluding "the actor" would silently mean excluding the
 * person who started the share — the one whose screen is most likely to be
 * showing it as live.
 */
export async function emitLocationExpired(
  sc: SupabaseClient,
  threadId: string,
  payload: { shareId: string; ownerUserId: string; expiredAt: string; sweptAt: string },
): Promise<void> {
  if (!threadId || !payload.shareId) return;
  await publishToThread(sc, threadId, {
    type: "location.expired",
    payload: { ...payload, eventKey: lifecycleEventKey("location.expired", payload.shareId) },
  });
}

/** §13.2 `coordination.started` — published to the conversation. */
export async function emitCoordinationStarted(
  sc: SupabaseClient,
  threadId: string,
  payload: { sessionId: string; startedBy: string; startedAt: string; planObjectId: string | null },
): Promise<void> {
  if (!threadId || !payload.sessionId) return;
  await publishToThread(sc, threadId, {
    type: "coordination.started",
    payload: { ...payload, eventKey: lifecycleEventKey("coordination.started", payload.sessionId) },
  });
}

/**
 * §13.2 `coordination.completed` — published to the conversation when the
 * session reaches a TERMINAL state.
 *
 * §9's diagram has exactly two terminal states, COMPLETE and CANCELLED, and
 * §13.2 names one event. Emitting only on COMPLETE would leave a cancelled
 * session's panel open on every other client until the next poll, so this fires
 * for both and names which one in `terminalState`. It is NOT collapsed into a
 * single "ended" claim: a consumer that rendered a cancellation as a completion
 * would tell people an evening happened that did not, and the recap surface
 * (§10.3) is downstream of exactly that distinction.
 */
export async function emitCoordinationCompleted(
  sc: SupabaseClient,
  threadId: string,
  payload: {
    sessionId: string;
    terminalState: "COMPLETE" | "CANCELLED";
    endedAt: string;
    declaredBy: string;
    reason: string | null;
  },
): Promise<void> {
  if (!threadId || !payload.sessionId) return;
  await publishToThread(sc, threadId, {
    type: "coordination.completed",
    payload: { ...payload, eventKey: lifecycleEventKey("coordination.completed", payload.sessionId) },
  });
}
