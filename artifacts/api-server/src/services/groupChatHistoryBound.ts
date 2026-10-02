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
 *
 * ONE APPROVED EXCEPTION — Q6, the own-message rejoin exception. A currently
 * authorized member reads their OWN earlier messages; every other sender's stay
 * bounded. It has TWO halves and they are both in this file, because EIGHTEEN
 * read paths pushed the bound into the QUERY as `.gte('created_at', bound)` —
 * two of them (§21 search and `GET /threads/:id/messages`) had no JavaScript
 * window check at all — so a predicate-only carve-out would have changed
 * nothing on any of them. Seventeen now call `applyHistoryWindow`; the
 * eighteenth is `routes/telegraphLifecycle.ts`'s seen-crossing scan, whose
 * floor is the caller's READ MARKER rather than a §14.3 bound and says so in
 * place. The two halves are:
 *   - `withinWindow(createdAt, visibleFrom, { senderId, viewerId })`, and
 *   - `applyHistoryWindow(query, visibleFrom, viewerId)`, which every read that
 *     used to write `.gte('created_at', bound)` itself now calls instead.
 * The long block at the FOOT of this file states what the exception admits,
 * what stays mandatory outside it, and why fail-closed is checked first.
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
export function withinWindow(
  createdAt: string | null | undefined,
  visibleFrom: string | null,
  own?: OwnMessageContext | null,
): boolean {
  if (!visibleFrom) return true;
  // FAIL-CLOSED FIRST, and deliberately BEFORE the Q6 exception: a row whose
  // `created_at` is absent is a damaged row, and a damaged row is refused even
  // to the person who sent it. The exception may only ever admit rows the
  // WINDOW excluded; it may never rescue a row another rule refused.
  if (!createdAt) return false;
  const c = Date.parse(createdAt);
  const v = Date.parse(visibleFrom);
  if (Number.isNaN(c) || Number.isNaN(v)) return false; // unparseable → outside the window, never inside it
  // Q6 (owner-approved): a currently authorized member reads their OWN earlier
  // messages. See the block at the foot of this file for what stays mandatory
  // and outside this condition. Reached only for a row that is otherwise
  // well-formed and genuinely outside the window.
  if (c < v && isOwnMessage(own)) return true;
  return c >= v;
}

/* ───────────────────────── Q6: the own-message rejoin exception ─────────────
 *
 * OWNER DECISION Q6. A currently authorized, REJOINED member may read their
 * OWN earlier messages. Other senders' messages stay subject to the new
 * membership window.
 *
 * WHY IT IS SAFE, STATED AS THE THING THAT IS ACTUALLY TRUE: the carve-out
 * discloses to a person only rows they themselves authored. §14.3 exists
 * because a group add must not hand a new member SOMEBODY ELSE'S history; a
 * person's own sent messages are not somebody else's history. The set of
 * (viewer, row) pairs this admits is exactly `row.sender_id = viewer`, and
 * nothing else about the disclosure boundary moves.
 *
 * WHAT IS DELIBERATELY *OUTSIDE* THIS RULE and stays mandatory on BOTH branches
 * of the condition — the carve-out is ANDed with all of it, never ORed:
 *   - thread identity (`.eq('thread_id', …)`)
 *   - ACTIVE membership (`left_at IS NULL`). A DEPARTED member reads nothing,
 *     including their own messages. Every gate checks membership BEFORE the
 *     window and the order is load-bearing; `memberCanReadMessageAt` and
 *     `authorizeSavedMessage` both say so in their own comments.
 *   - deletion / tombstone / unsent filters (`deleted_at IS NULL`, §21)
 *   - block rules, e2ee, tenant boundaries, per-route capability checks
 *
 * `visible_from_at` IS NOT WIDENED. The stored bound, migration 2400 and its
 * trigger are untouched. This is a read-side exception, decided per row, per
 * viewer, at the read.
 *
 * AN ACCESSIBLE OWN MESSAGE IS NOT A KEY TO ANYTHING ELSE. The exception is
 * evaluated against the row BEING SERVED, so a reply of mine that quotes
 * somebody else's pre-window message admits MY row and not theirs: the quoted
 * body, the inbox preview and the attachment each go through this same
 * predicate with THEIR OWN sender, and refuse.
 */

/** A UUID, as every id in this tree is spelled. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who sent a row, and who is asking. Both sides are needed for the exception;
 * either one missing means NO exception — the window decides alone, which is
 * the behaviour a call site that has not been taught to pass them still gets.
 */
export interface OwnMessageContext {
  readonly senderId?: string | null;
  readonly viewerId?: string | null;
}

/**
 * The Q6 test, named once so no call site can re-spell it. Strict equality of
 * two NON-EMPTY strings. An absent, empty or non-string id on EITHER side is
 * not a match — never `undefined === undefined`, which would make every row
 * with an unknown sender "own" to every viewer with an unknown id.
 */
export function isOwnMessage(own: OwnMessageContext | null | undefined): boolean {
  if (!own) return false;
  const s = own.senderId;
  const v = own.viewerId;
  if (typeof s !== 'string' || s.length === 0) return false;
  if (typeof v !== 'string' || v.length === 0) return false;
  return s === v;
}

/**
 * The PostgREST `or=` argument that expresses the window WITH the Q6 exception,
 * for the reads that push the bound into the query.
 *
 * Null means "the exception cannot be expressed here — keep the plain `.gte`",
 * which is the NARROWER behaviour and therefore the safe fallback. Null when:
 * there is no bound (the caller applies nothing at all), there is no viewer,
 * the viewer id is not a UUID, or the bound carries a character PostgREST's
 * `or=` grammar splits on (`,` `(` `)` `"`). Those last two guards are why no
 * value reaching here can become filter SYNTAX: anything that could change the
 * shape of the filter makes this return null, and the caller falls back to the
 * single-clause `.gte` that ships today.
 */
export function historyWindowOrFilter(
  visibleFrom: string | null,
  viewerId: string | null | undefined,
): string | null {
  if (!visibleFrom) return null;
  if (typeof viewerId !== 'string' || !UUID_SHAPE.test(viewerId)) return null;
  if (/[,()"]/.test(visibleFrom)) return null;
  return `created_at.gte.${visibleFrom},sender_id.eq.${viewerId}`;
}

/**
 * Apply the §14.3 window to a PostgREST query, WITH the Q6 exception when it
 * can be expressed.
 *
 * THIS IS THE HALF THAT ACTUALLY DECIDES on seventeen surfaces. Those reads
 * pushed the bound into the query as `.gte('created_at', bound)`, so PostgREST
 * discards the rows before any JavaScript runs — a carve-out written only in
 * `withinWindow` would pass its unit tests and change NOTHING there. Every such
 * site now calls this instead of writing the `.gte` itself, so the two halves
 * cannot drift.
 *
 * Returns the query UNCHANGED when there is no bound, so a build with the flag
 * OFF issues the byte-identical query it issues today and never names
 * `sender_id` in a filter it did not name before.
 *
 * The clause it adds is ONLY the window. Thread identity, `deleted_at IS NULL`,
 * `msg_type` and every other predicate stay where the caller put them — as
 * separate top-level filters, which PostgREST ANDs with this one.
 */
/**
 * The two builder methods this needs, spelled WITHOUT referring to the builder's
 * own type. A self-referential constraint (`Q extends { or(f: string): Q }`)
 * makes tsc walk PostgrestFilterBuilder's generics until it gives up with
 * TS2589; this shape does not, and the return type still hands the caller back
 * the exact builder it passed in, so the chain keeps its real type.
 */
interface WindowableQuery {
  gte(column: string, value: string): unknown;
  or(filters: string): unknown;
}

export function applyHistoryWindow<Q extends WindowableQuery>(
  q: Q,
  visibleFrom: string | null,
  viewerId: string | null | undefined,
): Q {
  if (!visibleFrom) return q;
  const or = historyWindowOrFilter(visibleFrom, viewerId);
  return (or ? q.or(or) : q.gte('created_at', visibleFrom)) as Q;
}
