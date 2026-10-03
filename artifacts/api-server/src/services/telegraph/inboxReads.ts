/**
 * The inbox's reads, made complete past PostgREST's `db-max-rows`.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * `GET /me/threads` and `GET /me/unread-counts` each read EVERY message of
 * EVERY thread the caller is in — `.in('thread_id', all)` ordered newest first,
 * with no limit — and took the newest row per thread from the result.
 * PostgREST stops a range-less select at `db-max-rows` (1000 on Supabase) and
 * reports nothing: no error, no flag, a short array that looks exactly like a
 * complete one. So once a person's threads held more than 1,000 messages
 * between them, every thread whose newest message was older than the
 * 1,000th-newest overall came back with NO preview and ZERO unread, and the
 * badge stopped counting it. A quiet DM under one busy trip chat looked empty
 * and read. The member roster (every member of every thread, also unbounded)
 * had the same cut: past 1,000 rows a DM's other person fell off and the inbox
 * named nobody.
 *
 * ── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────────
 * The newest-first read is BOUNDED on purpose and SAYS when the bound bit
 * (`truncated`, `cutoff`). Everything the bulk page carries is exact for any
 * question that only looks at messages newer than the cutoff; for the threads
 * whose answer lies past it, one targeted, bounded read per thread asks the
 * database directly — the newest visible message, or an exact `count` of
 * unread messages. The common case (a page that was not full) costs exactly
 * the one read it always did. The roster is paged under a total order until a
 * short page, and a page ceiling that is reached is a refusal, never a
 * shortened roster. Lists of ids are read in chunks small enough that a chunk
 * can never itself reach the cap.
 *
 * A catch-up read that FAILS is reported as a failure, never as "no message"
 * or "nothing unread": the callers refuse on it exactly as they refuse on the
 * bulk read, because a thread shown empty from a read that never happened is
 * the defect this module exists to remove.
 */

import { applyHistoryWindow, withinWindow } from "../groupChatHistoryBound.js";
import { nameVisibilitySet } from "../../lib/publicIdentity.js";

/**
 * Rows per page. Must not exceed PostgREST's `db-max-rows` (1000), or a full
 * page becomes indistinguishable from a capped one and the truncation test
 * below would read a cut page as a complete one.
 */
export const INBOX_PAGE_ROWS = 1000;

/** Ids per `.in()` chunk for reads that return at most one row per id. */
export const INBOX_ID_CHUNK = 500;

/** Parallel catch-up reads at once — bounded so one inbox cannot fan out unboundedly. */
export const INBOX_CATCHUP_CONCURRENCY = 8;

/**
 * Roster pages before the read gives up. 20 × 1000 membership rows is far past
 * any real inbox; reaching it is reported as a refusal rather than answered
 * with a roster that stopped short.
 */
export const ROSTER_MAX_PAGES = 20;

/** How many of a thread's newest rows a catch-up preview read inspects. */
const PREVIEW_SCAN = 20;

export type ReadOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/** Split a list into chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * `select … where col in (ids)` for a column that is unique per id, in chunks
 * that can never reach the cap. The first failing chunk fails the whole read:
 * a partial list of profiles or threads is the same lie as a capped one.
 */
export async function selectByIdsChunked(
  sc: any,
  table: string,
  columns: string,
  column: string,
  ids: readonly string[],
): Promise<ReadOutcome<any[]>> {
  const rows: any[] = [];
  for (const part of chunk([...new Set(ids)], INBOX_ID_CHUNK)) {
    const { data, error } = await sc.from(table).select(columns).in(column, part);
    if (error) return { ok: false, error };
    rows.push(...((data as any[]) ?? []));
  }
  return { ok: true, value: rows };
}

export interface RecentMessagesPage {
  /** Newest first, at most INBOX_PAGE_ROWS rows, deleted rows excluded. */
  rows: any[];
  /** True when the page was full, i.e. older messages exist past it. */
  truncated: boolean;
  /**
   * The `created_at` of the oldest row on a full page. Every message strictly
   * newer than this instant is on the page; nothing is claimed about the rest.
   * Null when the page was not full (it is then the whole set).
   */
  cutoff: string | null;
}

/** The bounded newest-first page of non-deleted messages across `threadIds`. */
export async function readRecentMessages(
  sc: any,
  threadIds: readonly string[],
  columns: string,
): Promise<ReadOutcome<RecentMessagesPage>> {
  const { data, error } = await sc
    .from("messages")
    .select(columns)
    .in("thread_id", threadIds as string[])
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(INBOX_PAGE_ROWS);
  if (error) return { ok: false, error };
  const rows = ((data as any[]) ?? []);
  const truncated = rows.length >= INBOX_PAGE_ROWS;
  const cutoff = truncated ? String(rows[rows.length - 1]?.created_at ?? "") || null : null;
  return { ok: true, value: { rows, truncated, cutoff } };
}

/**
 * True when the page answers "which messages are newer than `since`" exactly:
 * either it holds the whole set, or `since` is at or after its cutoff, so every
 * message newer than `since` is newer than the cutoff and therefore on the page.
 * A null `since` (never read) needs the whole history and is only exact on a
 * page that was not full.
 */
export function pageCoversSince(page: RecentMessagesPage, since: string | null): boolean {
  if (!page.truncated) return true;
  if (!since || !page.cutoff) return false;
  const s = Date.parse(since);
  const c = Date.parse(page.cutoff);
  if (Number.isNaN(s) || Number.isNaN(c)) return false;
  return s >= c;
}

/**
 * One thread's newest message the viewer may see, read directly — for a thread
 * the bulk page did not reach. The §14.3 window is applied in the QUERY (with
 * Q6's own-message exception) and re-checked in JavaScript, exactly as the bulk
 * path re-checks it, so the two paths cannot disagree about a boundary row.
 */
export async function readNewestVisibleMessage(
  sc: any,
  args: { threadId: string; columns: string; viewerId: string; visibleFrom: string | null },
): Promise<ReadOutcome<any | null>> {
  let q = sc
    .from("messages")
    .select(args.columns)
    .eq("thread_id", args.threadId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(PREVIEW_SCAN);
  q = applyHistoryWindow(q, args.visibleFrom, args.viewerId);
  const { data, error } = await q;
  if (error) return { ok: false, error };
  const row = ((data as any[]) ?? []).find((m) =>
    withinWindow(m.created_at, args.visibleFrom, { senderId: m.sender_id, viewerId: args.viewerId }));
  return { ok: true, value: row ?? null };
}

/**
 * The exact number of messages in one thread that are unread by the viewer:
 * sent by someone else, not deleted, newer than `lastReadAt` (every message
 * when the viewer has never read the thread), inside the viewer's window. A
 * `count: 'exact'` head read, which the row cap does not apply to.
 */
export async function countUnreadFromOthers(
  sc: any,
  args: { threadId: string; viewerId: string; lastReadAt: string | null; visibleFrom: string | null },
): Promise<ReadOutcome<number>> {
  let q = sc
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", args.threadId)
    .neq("sender_id", args.viewerId)
    .is("deleted_at", null);
  if (args.lastReadAt) q = q.gt("created_at", args.lastReadAt);
  q = applyHistoryWindow(q, args.visibleFrom, args.viewerId);
  const { count, error } = await q;
  if (error) return { ok: false, error };
  if (typeof count !== "number") return { ok: false, error: new Error("count unavailable") };
  return { ok: true, value: count };
}

/**
 * Every membership row of `threadIds`, paged under a total order until a short
 * page. Reaching ROSTER_MAX_PAGES is a failure, not a shorter roster.
 */
export async function readRosterPaged(
  sc: any,
  threadIds: readonly string[],
  columns: string,
): Promise<ReadOutcome<any[]>> {
  const rows: any[] = [];
  for (const part of chunk([...new Set(threadIds)], INBOX_ID_CHUNK)) {
    for (let page = 0; ; page++) {
      if (page >= ROSTER_MAX_PAGES) {
        return { ok: false, error: new Error(`roster exceeds ${ROSTER_MAX_PAGES} pages of ${INBOX_PAGE_ROWS} rows`) };
      }
      const from = page * INBOX_PAGE_ROWS;
      const { data, error } = await sc
        .from("message_thread_members")
        .select(columns)
        .in("thread_id", part)
        .order("thread_id", { ascending: true })
        .order("user_id", { ascending: true })
        .range(from, from + INBOX_PAGE_ROWS - 1);
      if (error) return { ok: false, error };
      const got = ((data as any[]) ?? []);
      rows.push(...got);
      if (got.length < INBOX_PAGE_ROWS) break;
    }
  }
  return { ok: true, value: rows };
}

// ── Adapters for call sites written against supabase-js's `{ data, error }` ──

/** A ReadOutcome in the `{ data, error }` shape the inbox route already branches on. */
export function asSupabaseResult<T>(o: ReadOutcome<T>): { data: T | null; error: any } {
  return o.ok ? { data: o.value, error: null } : { data: null, error: o.error };
}

/** The page's rows as `data`, with the page itself (truncation stated) beside them. */
export function asPageResult(o: ReadOutcome<RecentMessagesPage>): { data: any[] | null; error: any; page: RecentMessagesPage | null } {
  return o.ok ? { data: o.value.rows, error: null, page: o.value } : { data: null, error: o.error, page: null };
}

/**
 * Newest activity first, threads with no activity last — the order the
 * single-query read asked PostgREST for (`last_message_at desc nulls last`),
 * restored after a chunked read. Stable, so equal instants keep read order.
 */
export function sortByActivityDesc<T extends { last_message_at?: string | null }>(rows: T[]): T[] {
  const at = (r: T) => {
    const t = r.last_message_at ? Date.parse(r.last_message_at) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...rows].sort((a, b) => at(b) - at(a));
}

/**
 * `nameVisibilitySet` over any number of ids, in chunks that cannot reach the
 * cap. The helper itself fails CLOSED (an unreadable settings table hides
 * names, never shows them), so a chunk that fails hides that chunk's names —
 * the privacy-safe direction — and nothing here widens it.
 */
export async function nameVisibilitySetChunked(sc: any, userIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk([...new Set(userIds)], INBOX_ID_CHUNK)) {
    for (const id of await nameVisibilitySet(sc, part)) out.add(id);
  }
  return out;
}

export interface InboxCatchUp {
  /** threadId → exact unread count, for every thread the page could not answer. */
  exactUnread: Record<string, number>;
  /** Targeted reads issued. Zero whenever the page was not full. */
  targetedReads: number;
}

/**
 * Finish what a FULL newest-first page could not answer, in place:
 *
 *   - a thread with no row on the page gets its newest visible message read
 *     directly into `lastMsgByThread`;
 *   - a thread whose unread set reaches past the page's cutoff (never read, or
 *     last read before the cutoff) gets an exact count. A thread last read at
 *     or after its own newest activity has nothing unread and is not queried —
 *     the same `last_message_at` test the badge already filters on.
 *
 * A page that was not full answers everything itself and this issues nothing.
 * Any targeted read that fails fails the whole catch-up.
 */
export async function catchUpInbox(
  sc: any,
  args: {
    page: RecentMessagesPage | null | undefined;
    threadIds: readonly string[];
    viewerId: string;
    columns: string;
    visibleFromByThread: Record<string, string | null>;
    lastReadByThread: Record<string, string | null>;
    lastMessageAtByThread: Record<string, string | null>;
    lastMsgByThread: Record<string, any>;
  },
): Promise<ReadOutcome<InboxCatchUp>> {
  const page = args.page;
  if (!page || !page.truncated) return { ok: true, value: { exactUnread: {}, targetedReads: 0 } };

  const missing = args.threadIds.filter((t) => !args.lastMsgByThread[t]);
  const uncovered = args.threadIds.filter((t) => {
    const lastRead = args.lastReadByThread[t] ?? null;
    if (pageCoversSince(page, lastRead)) return false;
    const lastAt = args.lastMessageAtByThread[t] ?? null;
    if (lastRead && lastAt && !Number.isNaN(Date.parse(lastAt)) && Date.parse(lastAt) <= Date.parse(lastRead)) return false;
    return true;
  });

  const previews = await mapLimit(missing, INBOX_CATCHUP_CONCURRENCY, (threadId) =>
    readNewestVisibleMessage(sc, {
      threadId, columns: args.columns, viewerId: args.viewerId,
      visibleFrom: args.visibleFromByThread[threadId] ?? null,
    }));
  for (let i = 0; i < previews.length; i++) {
    const p = previews[i]!;
    if (!p.ok) return { ok: false, error: p.error };
    if (p.value) args.lastMsgByThread[missing[i]!] = p.value;
  }

  const counts = await mapLimit(uncovered, INBOX_CATCHUP_CONCURRENCY, (threadId) =>
    countUnreadFromOthers(sc, {
      threadId, viewerId: args.viewerId,
      lastReadAt: args.lastReadByThread[threadId] ?? null,
      visibleFrom: args.visibleFromByThread[threadId] ?? null,
    }));
  const exactUnread: Record<string, number> = {};
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]!;
    if (!c.ok) return { ok: false, error: c.error };
    exactUnread[uncovered[i]!] = c.value;
  }
  return { ok: true, value: { exactUnread, targetedReads: missing.length + uncovered.length } };
}
