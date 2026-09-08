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
  | "message.translated"
  | "member.left"
  | "typing.started"
  | "typing.stopped"
  | "read.updated"
  | "request.created"
  | "request.accepted"
  | "request.declined"
  | "user.blocked"
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
  | "reconnect";

export interface TelegraphEvent {
  type: TelegraphEventType;
  /** Thread the event belongs to, when applicable. */
  threadId?: string | null;
  /** Event-specific data. Never include message bodies or other PII. */
  payload?: Record<string, unknown>;
  /** ISO timestamp set at publish time. */
  ts: string;
}

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

/**
 * Deliver an event to local subscribers only (no cross-instance fan-out).
 * Used by telegraphBroadcast when it receives a remote event so it doesn't
 * re-broadcast and cause infinite loops.
 */
export function publishToUsersLocal(
  userIds: Iterable<string>,
  event: TelegraphEvent,
): void {
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
          "telegraph remote subscriber callback threw — that connection missed this event",
        );
      }
    }
  }
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

  for (const uid of userIds) {
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const set = subscribers.get(uid);
    if (!set) continue;
    for (const cb of set) {
      try {
        cb(full);
        stats.delivered++;
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

/**
 * Resolve the active members of a thread (left_at IS NULL) and publish to them,
 * optionally excluding one user (typically the actor). Best-effort: a failure
 * to resolve members is logged, counted and swallowed.
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
