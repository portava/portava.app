/**
 * Telegraph §14.3 — group history bounds, the read-side half.
 *
 * "New members do not automatically receive pre-membership history."
 * (§14.3, §26 "New member reads pre-membership history without policy → DENY",
 * §29, §30A.4, §30A.20 — identical in spec v1 and v1_1.)
 *
 * Migration 2400 adds message_thread_members.visible_from_at and a trigger that
 * opens the window where the membership starts. This module is the ONLY place
 * a reader decides whether to honour it. Every member-facing reader of
 * public.messages routes its bound through here so the rule is one rule:
 *
 *   GET /threads/:id/messages       (+ the quoted-reply context it embeds)
 *   GET /me/threads                 (last-message preview, unread count)
 *   GET /me/unread-counts
 *   GET /me/saved-messages
 *
 * GATED. Nothing changes until feature flag `telegraph_history_bound_enabled`
 * is TRUE. It is seeded FALSE by 2400. While OFF:
 *   - `historyBoundEnabled` is false;
 *   - `membershipSelect` returns the caller's ORIGINAL column list, so the
 *     membership query is byte-identical to today's and does not name a column
 *     a database that has not run 2400 would reject with 42703;
 *   - `visibleFromOf` returns null;
 *   - `withinWindow` is always true.
 * So a build carrying this code is safe against a database without the
 * migration, and the flag can only exist (and therefore only be ON) in a
 * database that has run it.
 *
 * The flag is read through isFlagEnabled, which is FALSE ON ERROR. That is the
 * deliberate polarity for this gate: an unreadable flag leaves history exactly
 * as unbounded as it is today, rather than silently hiding messages from every
 * member. It is the same choice migration 2339 made for the highlights feed cap
 * and for the same reason.
 *
 * NULL visible_from_at = UNBOUNDED, even when the flag is ON. Rows that predate
 * 2400 keep NULL (2400 backfills nothing — see its header for why joined_at
 * cannot be the source), and an explicit NULL is how a "policy" grant of
 * pre-membership history would be expressed if the owner ever adds one.
 *
 * COORDINATE. The bound is a timestamp compared against messages.created_at,
 * inclusive, because created_at is the ordering and pagination key every
 * reader already uses; there is no sequence column (2400 header, Appendix A).
 */

import { isFlagEnabled } from '../lib/featureFlags.js';

export const HISTORY_BOUND_FLAG = 'telegraph_history_bound_enabled';

/** The bound column, named once. */
export const VISIBLE_FROM_COLUMN = 'visible_from_at';

/**
 * Whether the §14.3 bound is in force. False on any flag-read error (see
 * module header for why that polarity is the safe one here).
 */
export async function historyBoundEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, HISTORY_BOUND_FLAG);
}

/**
 * The column list for a membership read. Appends visible_from_at ONLY when the
 * bound is enabled, so a disabled build never names a column the live schema
 * may not have.
 */
export function membershipSelect(baseColumns: string, enabled: boolean): string {
  return enabled ? `${baseColumns}, ${VISIBLE_FROM_COLUMN}` : baseColumns;
}

/**
 * The caller's bound for one membership row: an ISO timestamp, or null when
 * the bound is disabled, the row is absent, or the row is unbounded (NULL).
 */
export function visibleFromOf(
  membership: { visible_from_at?: string | null } | null | undefined,
  enabled: boolean,
): string | null {
  if (!enabled || !membership) return null;
  const v = membership.visible_from_at;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * True when a message created at `createdAt` is inside the window that starts
 * at `visibleFrom`. A null bound admits everything. Inclusive at the boundary:
 * a message sent at the same instant the membership opened is visible, which
 * is the same edge the unread-count logic uses for last_read_at.
 *
 * Compared as instants, not strings: both values are ISO-8601 from either
 * Postgres (`+00:00`) or Node (`Z`), and a string compare would rank those two
 * spellings of the same instant differently.
 */
export function withinWindow(createdAt: string | null | undefined, visibleFrom: string | null): boolean {
  if (!visibleFrom) return true;
  if (!createdAt) return false;
  const c = Date.parse(createdAt);
  const v = Date.parse(visibleFrom);
  if (Number.isNaN(c) || Number.isNaN(v)) return false; // unparseable → outside the window, never inside it
  return c >= v;
}
