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
  | "call.group_ended";

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
      } catch (err) {
        logger.warn(
          { err, type: event.type },
          "telegraph remote subscriber callback threw",
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
      } catch (err) {
        logger.warn({ err, type: full.type }, "telegraph subscriber callback threw");
      }
    }
  }

  // Fan out to other instances — fire-and-forget, never block callers.
  if (_broadcastHook && seen.size > 0) {
    try {
      _broadcastHook(Array.from(seen), full);
    } catch (err) {
      logger.warn({ err, type: full.type }, "telegraph broadcast hook threw");
    }
  }
}

/**
 * Resolve the active members of a thread (left_at IS NULL) and publish to them,
 * optionally excluding one user (typically the actor). Best-effort: a failure
 * to resolve members is logged and swallowed.
 */
export async function publishToThread(
  sc: SupabaseClient,
  threadId: string,
  event: Omit<TelegraphEvent, "ts" | "threadId"> & { ts?: string },
  options: { excludeUserId?: string } = {},
): Promise<void> {
  try {
    const { data } = await sc
      .from("message_thread_members")
      .select("user_id")
      .eq("thread_id", threadId)
      .is("left_at", null);

    const userIds = (data ?? [])
      .map((r: { user_id?: string }) => r.user_id)
      .filter((uid): uid is string => Boolean(uid) && uid !== options.excludeUserId);

    if (userIds.length === 0) return;
    publishToUsers(userIds, { ...event, threadId });
  } catch (err) {
    logger.warn({ err, threadId, type: event.type }, "publishToThread failed to resolve members");
  }
}
