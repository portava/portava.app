/**
 * Telegraph §30A.6 — the per-thread notification policy, as one decision.
 *
 * Spec §30A.6, verbatim:
 *   "Thread notification policy may support ALL, MENTIONS, IMPORTANT, temporary
 *    mute, and MUTED. Safety-critical delivery remains governed by the safety
 *    policy rather than ordinary mute."
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * census-telegraph T398: "Two of five ... MUTED (message_thread_members.muted_at)
 * and the safety override. No ALL/MENTIONS/IMPORTANT selector, no temporary
 * mute." Re-read before this file was written, and MUTED was worse than the row
 * said: `muted_at` was written by PATCH /threads/:id/mute and read back for the
 * inbox's icon, and NOTHING consulted it when a notification was created — an
 * @mention in a muted thread notified the member exactly as in an unmuted one.
 * The mute was a label.
 *
 * ── THE DECISION ────────────────────────────────────────────────────────────
 * `decideThreadNotification` is the only place a thread-scoped notification is
 * decided against the member's choice. In order:
 *
 *   1. SAFETY always delivers. It is governed by the safety policy
 *      (NotificationPreferenceService's override), never by a thread choice.
 *   2. The member's state could not be READ → suppress, and say so. A failed
 *      read is not "not muted"; delivering on it would treat the absence of an
 *      answer as consent. (NotificationDigestService declines a digest on an
 *      unreadable preference for the same reason.)
 *   3. A temporary mute in force (muted_until in the future) → suppress.
 *   4. MUTED — the level, or the legacy muted_at — → suppress.
 *   5. MENTIONS → only a MENTION delivers.
 *   6. IMPORTANT → everything except an ordinary MESSAGE delivers: mentions,
 *      plan changes, invitations, coordination, location and calls are the
 *      operational causes §30A.6 lists beside SAFETY. This is the reading of
 *      "IMPORTANT" this module commits to; it is stated here so it can be
 *      changed in one place if the product means something narrower.
 *   7. ALL → delivers.
 *
 * The causes are §30A.6's eight, verbatim.
 */

export const THREAD_NOTIFICATION_LEVELS = ["ALL", "MENTIONS", "IMPORTANT", "MUTED"] as const;
export type ThreadNotificationLevel = (typeof THREAD_NOTIFICATION_LEVELS)[number];

/** §30A.6's notification causes, in the spec's order. */
export const NOTIFICATION_CAUSES = [
  "MESSAGE",
  "MENTION",
  "PLAN_CHANGED",
  "INVITATION",
  "COORDINATION",
  "LOCATION",
  "CALL",
  "SAFETY",
] as const;
export type NotificationCause = (typeof NOTIFICATION_CAUSES)[number];

/** The causes IMPORTANT admits (everything but an ordinary message). */
export const IMPORTANT_CAUSES: readonly NotificationCause[] = [
  "MENTION",
  "PLAN_CHANGED",
  "INVITATION",
  "COORDINATION",
  "LOCATION",
  "CALL",
  "SAFETY",
];

/** Temporary-mute durations a member may choose, in minutes. */
export const TEMPORARY_MUTE_MINUTES = [15, 60, 480, 1440] as const;

export function isThreadNotificationLevel(v: unknown): v is ThreadNotificationLevel {
  return typeof v === "string" && (THREAD_NOTIFICATION_LEVELS as readonly string[]).includes(v);
}

/** The stored literal (lower case, migration 4090's CHECK) ↔ the spec's name. */
export function levelFromColumn(v: unknown): ThreadNotificationLevel | null {
  if (typeof v !== "string") return null;
  const up = v.toUpperCase();
  return isThreadNotificationLevel(up) ? up : null;
}
export function levelToColumn(level: ThreadNotificationLevel): "all" | "mentions" | "important" | "muted" {
  return level.toLowerCase() as "all" | "mentions" | "important" | "muted";
}

/** One member's thread notification state, as read. `null` = the read failed. */
export interface ThreadNotificationState {
  /** The chosen level; null when the column does not exist / is not read (flag off). */
  readonly level: ThreadNotificationLevel | null;
  /** Legacy MUTED. Non-null means muted, whatever `level` says. */
  readonly mutedAt: string | null;
  /** Temporary mute end, or null. */
  readonly mutedUntil: string | null;
}

export type ThreadNotificationDecision =
  | { readonly deliver: true; readonly reason: "safety_override" | "level_admits" }
  | {
      readonly deliver: false;
      readonly reason: "state_unreadable" | "temporarily_muted" | "muted" | "level_excludes_cause";
    };

export function decideThreadNotification(input: {
  cause: NotificationCause;
  /** null when the member's state could not be read. */
  state: ThreadNotificationState | null;
  nowMs: number;
}): ThreadNotificationDecision {
  if (input.cause === "SAFETY") return { deliver: true, reason: "safety_override" };
  const s = input.state;
  if (s === null) return { deliver: false, reason: "state_unreadable" };
  if (s.mutedUntil !== null) {
    const until = Date.parse(s.mutedUntil);
    // An unparseable end is not "no mute": it is a mute we cannot bound, and
    // suppressing is the side that does not override a person's choice.
    if (Number.isNaN(until) || until > input.nowMs) return { deliver: false, reason: "temporarily_muted" };
  }
  if (s.mutedAt !== null || s.level === "MUTED") return { deliver: false, reason: "muted" };
  const level = s.level ?? "ALL";
  if (level === "MENTIONS" && input.cause !== "MENTION") return { deliver: false, reason: "level_excludes_cause" };
  if (level === "IMPORTANT" && !IMPORTANT_CAUSES.includes(input.cause)) {
    return { deliver: false, reason: "level_excludes_cause" };
  }
  return { deliver: true, reason: "level_admits" };
}
