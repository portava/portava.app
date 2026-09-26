/**
 * Telegraph §21 — conversation search, authorization-scoped and object-aware.
 *
 * THE ORDER OF OPERATIONS IS THE REQUIREMENT
 * ==========================================
 * §21: "Private semantic indexes require access filtering BEFORE retrieval, not
 * post-filtering after unrestricted search."
 *
 * This service is built so that the authorized set is computed FIRST and is the
 * only thing ever queried:
 *
 *   1. read the caller's ACTIVE memberships  → the authorized conversation ids
 *   2. read each membership's §14.3 lower bound
 *   3. issue the text query SCOPED to those ids, with the bound in the WHERE
 *   4. classify and rank what comes back
 *
 * Step 3 never runs unscoped. There is no "search everything then drop what you
 * may not see" path in this file, and `searchConversations` returns an empty
 * result rather than querying at all when step 1 yields nothing — including
 * when step 1 FAILED, which is the case that matters: an unreadable membership
 * table must not become "no restrictions".
 *
 * WHY BOUNDED THREADS GET THEIR OWN QUERY
 * =======================================
 * PostgREST cannot express "thread A from time X, thread B from time Y" in one
 * filter. The naive fix is to query all threads and drop out-of-window rows in
 * JavaScript — which is precisely the post-filtering §21 forbids, and which
 * leaks through `limit`: an out-of-window row consumes a slot and then
 * disappears, so a bounded user's result set silently shrinks. Instead the
 * unbounded threads are one `.in()` query and each bounded thread is its own
 * query carrying its own `.gte()`. `MAX_BOUNDED_QUERIES` caps the fan-out and
 * the result says when the cap was hit rather than pretending it was not.
 *
 * DELETED IS EXCLUDED IN THE QUERY, NOT IN THE RENDER
 * ==================================================
 * §21: "Unsent/deleted/revoked objects must be removed from normal user
 * search." `deleted_at is null` is a filter on the query. A tombstone that
 * reaches this process and is then skipped would still have consumed a limit
 * slot and would still have had its body in memory. There is no `unsent_at`
 * column on this tree (census T161), so the unsent half of that sentence has
 * nothing to exclude yet; `LIFECYCLE_EXCLUDED` names both so the day the column
 * arrives the omission is a one-line change at a named seam rather than a
 * search for every reader.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { logger as rootLogger } from "../lib/logger.js";
import { applyHistoryWindow, historyBoundEnabled, membershipSelect, visibleFromOf, withinWindow } from "./groupChatHistoryBound.js";
// §21's unsent exclusion, which needs migration 2810's column and must not name
// it on a database that has not run it.
import { applyLifecycleExclusion, messageKernelEnabled } from "./telegraphMessageKernel.js";
import {
  TELEGRAPH_SEARCH_BUCKETS,
  STRUCTURED_SUBTYPES,
  classifyMessage,
  emptySearchResult,
  indexableText,
  type TelegraphSearchBucket,
  type TelegraphSearchHit,
  type TelegraphSearchResult,
} from "../domain/telegraph/contracts/conversationSearch.js";

const log = rootLogger.child({ svc: "telegraphSearch" });

/** Lifecycle states §21 removes from normal search. See the header. */
export const LIFECYCLE_EXCLUDED = ["deleted", "unsent", "revoked"] as const;

/** How many separately-bounded conversations get their own query. */
export const MAX_BOUNDED_QUERIES = 25;

/** Rows fetched per query before ranking. */
const PER_QUERY_LIMIT = 60;

const SNIPPET_MAX = 160;

const SELECT_COLUMNS =
  "id, thread_id, sender_id, body, created_at, deleted_at, msg_type, subtype, media_url";

export interface SearchOptions {
  /** Restrict to one conversation. Must still be one the caller is a member of. */
  conversationId?: string | null;
  /** Cap on returned hits across all buckets. */
  limit?: number;
  /** Only return these buckets. Empty/absent = all five. */
  buckets?: TelegraphSearchBucket[];
  /** §21's last line: rank structured objects above prose. */
  preferStructured?: boolean;
}

interface AuthorizedScope {
  unbounded: string[];
  bounded: Array<{ threadId: string; visibleFrom: string }>;
  degraded: boolean;
  truncated: boolean;
}

/**
 * Step 1+2: the caller's authorized conversations and their §14.3 bounds.
 *
 * Exported because the "ask this conversation" path needs the same scope and
 * must not compute it a second, subtly different way.
 */
export async function authorizedConversationScope(
  sc: SupabaseClient,
  viewerId: string,
  conversationId?: string | null,
): Promise<AuthorizedScope> {
  const boundOn = await historyBoundEnabled(sc);
  // Two LITERAL select lists rather than one computed list. The flag gate is
  // unchanged: a database without 2400 is still never asked for the column.
  // What changes is that `check:write-path-columns` can resolve both branches
  // and verify them against the live schema, so this site no longer needs the
  // UNRESOLVED_ALLOWLIST entry it used to carry.
  let q = (boundOn
    ? sc.from("message_thread_members").select("thread_id, visible_from_at")
    : sc.from("message_thread_members").select("thread_id"))
    .eq("user_id", viewerId)
    .is("left_at", null);
  if (conversationId) q = q.eq("thread_id", conversationId);

  const { data, error } = await q;
  if (error) {
    // An unreadable membership table is NOT "no restrictions" and is NOT "no
    // conversations": it is "we cannot say". Returning an empty scope makes the
    // caller return an empty, degraded result — never an unscoped query.
    log.error({ err: error, viewerId }, "search scope unreadable — refusing to search unscoped");
    return { unbounded: [], bounded: [], degraded: true, truncated: false };
  }

  const unbounded: string[] = [];
  const bounded: Array<{ threadId: string; visibleFrom: string }> = [];
  for (const row of (data as any[]) ?? []) {
    const threadId = String(row.thread_id);
    const visibleFrom = visibleFromOf(row, boundOn);
    if (visibleFrom) bounded.push({ threadId, visibleFrom });
    else unbounded.push(threadId);
  }
  const truncated = bounded.length > MAX_BOUNDED_QUERIES;
  return {
    unbounded,
    bounded: truncated ? bounded.slice(0, MAX_BOUNDED_QUERIES) : bounded,
    degraded: false,
    truncated,
  };
}

function escapeForIlike(q: string): string {
  // PostgREST splits `or=` and filter values on commas and parentheses; a query
  // containing them would otherwise become a different filter than the user
  // typed. They are stripped rather than escaped because a search term is not a
  // place a caller needs punctuation, and a half-escaped filter is worse than a
  // slightly narrower one.
  return q.replace(/[,()*%\\]/g, " ").trim();
}

async function runQuery(
  sc: SupabaseClient,
  term: string,
  threadIds: string[],
  visibleFrom: string | null,
  kernelOn: boolean,
  viewerId: string,
): Promise<{ rows: any[]; failed: boolean }> {
  if (threadIds.length === 0) return { rows: [], failed: false };
  let q = sc
    .from("messages")
    .select(SELECT_COLUMNS)
    .in("thread_id", threadIds)
    .is("deleted_at", null)              // §21: deleted objects are excluded in the QUERY
    .ilike("body", `%${term}%`)
    .order("created_at", { ascending: false })
    .limit(PER_QUERY_LIMIT);
  // §21's UNSENT half, which had no column to filter on until migration 2810
  // (census T276). Off by default and, when off, the query does not NAME
  // unsent_at — so a database without 2810 is never asked for it.
  q = applyLifecycleExclusion(q, kernelOn);
  // Q6, AND THE REASON THIS SITE IS THE PROOF THAT THE SQL HALF MATTERS: until
  // this change §21 search called `withinWindow` ZERO times, anywhere in the
  // file. This `.gte` was the whole bound. A carve-out written only in the
  // predicate would have left search byte-for-byte unchanged — a rejoined
  // member would still have been unable to find their own earlier messages. `deleted_at IS NULL`, the §21 unsent exclusion
  // and the thread scope stay AND-ed outside the relaxed clause.
  q = applyHistoryWindow(q, visibleFrom, viewerId);
  const { data, error } = await q;
  if (error) {
    log.warn({ err: error, threads: threadIds.length }, "search query failed for a scope slice");
    return { rows: [], failed: true };
  }
  // THE SECOND LAYER, which §21 search did not have because a single-clause
  // `created_at >= bound` already excluded a row with no timestamp. The relaxed
  // clause's `sender_id.eq.<caller>` half does not, so the predicate — which
  // refuses an absent or unparseable `created_at` BEFORE it consults the Q6
  // exception — is applied here too. It also reconciles the two ISO spellings
  // at the boundary instant, exactly as every other windowed read does.
  const rows = ((data as any[]) ?? []).filter((r) =>
    withinWindow(r.created_at, visibleFrom, { senderId: r.sender_id, viewerId }));
  return { rows, failed: false };
}

/**
 * §21 search. Returns the five buckets with counts, over the caller's own
 * authorized conversations only.
 */
export async function searchConversations(
  sc: SupabaseClient,
  viewerId: string,
  rawQuery: string,
  opts: SearchOptions = {},
): Promise<TelegraphSearchResult> {
  const term = escapeForIlike(rawQuery);
  const result = emptySearchResult(rawQuery);
  if (term.length < 2) return result;

  const scope = await authorizedConversationScope(sc, viewerId, opts.conversationId ?? null);
  result.conversationsSearched = scope.unbounded.length + scope.bounded.length;
  result.conversationsBounded = scope.bounded.length;
  if (scope.degraded) { result.degraded = true; return result; }
  if (result.conversationsSearched === 0) return result;
  if (scope.truncated) result.degraded = true;

  const kernelOn = await messageKernelEnabled(sc);
  const slices: Array<Promise<{ rows: any[]; failed: boolean }>> = [
    runQuery(sc, term, scope.unbounded, null, kernelOn, viewerId),
    ...scope.bounded.map((b) => runQuery(sc, term, [b.threadId], b.visibleFrom, kernelOn, viewerId)),
  ];
  const settled = await Promise.all(slices);
  const rows: any[] = [];
  for (const s of settled) {
    if (s.failed) result.degraded = true;
    rows.push(...s.rows);
  }

  const wanted = new Set<TelegraphSearchBucket>(
    opts.buckets && opts.buckets.length > 0 ? opts.buckets : TELEGRAPH_SEARCH_BUCKETS,
  );
  const needle = term.toLowerCase();

  const hits: TelegraphSearchHit[] = [];
  for (const row of rows) {
    const subtype = (row.subtype ?? null) as string | null;
    const { text, objectTitle } = indexableText(row.body, subtype);
    // A card whose SAFE fields do not contain the term is not a hit even though
    // the raw JSON did: the match was on a field the allowlist refused to index
    // (an id, a URL, a coordinate), and surfacing it would let a searcher
    // confirm the presence of a value they are not allowed to read.
    const haystack = text.toLowerCase();
    if (text === "" || !haystack.includes(needle)) continue;

    const bucket = classifyMessage(row);
    if (!wanted.has(bucket)) continue;
    hits.push({
      messageId: String(row.id),
      conversationId: String(row.thread_id),
      bucket,
      senderId: String(row.sender_id),
      createdAt: String(row.created_at),
      snippet: text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text,
      objectTitle,
      subtype,
      msgType: String(row.msg_type ?? "text"),
      hasMedia: Boolean(row.media_url),
    });
  }

  // §21's last line: structured objects rank above prose when asked for.
  hits.sort((a, b) => {
    if (opts.preferStructured) {
      const sa = a.subtype && STRUCTURED_SUBTYPES.has(a.subtype) ? 0 : 1;
      const sb = b.subtype && STRUCTURED_SUBTYPES.has(b.subtype) ? 0 : 1;
      if (sa !== sb) return sa - sb;
    }
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  const limit = Math.max(1, Math.min(opts.limit ?? 40, 100));
  result.hits = hits.slice(0, limit);
  // Counts are over EVERY hit found, not over the page returned: "MESSAGES 3"
  // in §21's mockup is a count of matches, not a count of rows on screen.
  for (const h of hits) result.counts[h.bucket] += 1;
  return result;
}

/**
 * §21 "Ask this conversation" — structured first.
 *
 * Same authorization path, same exclusions, one difference: structured plans,
 * decisions and place objects are returned ahead of prose and are reported
 * separately, so a caller (a UI, or Compass) can answer from the structured set
 * and fall back to prose only when it is empty — rather than inferring an
 * answer from chat text that happens to rank well.
 */
export async function askConversation(
  sc: SupabaseClient,
  viewerId: string,
  conversationId: string,
  rawQuery: string,
): Promise<{ structured: TelegraphSearchHit[]; prose: TelegraphSearchHit[]; result: TelegraphSearchResult }> {
  const result = await searchConversations(sc, viewerId, rawQuery, {
    conversationId,
    preferStructured: true,
    limit: 40,
  });
  const structured = result.hits.filter((h) => h.subtype !== null && STRUCTURED_SUBTYPES.has(h.subtype));
  const prose = result.hits.filter((h) => !(h.subtype !== null && STRUCTURED_SUBTYPES.has(h.subtype)));
  return { structured, prose, result };
}
