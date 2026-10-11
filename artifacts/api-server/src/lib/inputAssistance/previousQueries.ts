/**
 * §35 — "Previously successful query completions" (census G229).
 *
 * WHAT IT IS. When the viewer types into a search field, the searches THEY ran
 * before that returned something — and that start with what they are typing —
 * are offered back as submit rows ("Search again"). Tapping one runs that
 * search; nothing is inserted silently and nothing is created.
 *
 * WHERE THE QUERIES COME FROM — THE STORE THAT ALREADY EXISTS. A raw-search
 * completion has no canonical entity, so it cannot live in
 * `input_selection_history` (2258's own column contract: `entity_id` is a
 * canonical id, "never a private fact or free-text content"). It does not need
 * a new table either: the search screen ALREADY records a successful search in
 * the viewer's own `search_history` — only when the first page returned rows
 * (`app/search.tsx`, `newRows.length > 0`) or when the typed query led to an
 * explicit pick — and the viewer already owns and erases that store through
 * `DELETE /api/me/search-history` (one entry or all). This module only READS it,
 * owner-scoped, so a query the person has erased is never offered again, and
 * there is no second copy for the erase to miss.
 *
 * GATES, all fail-closed, checked before anything is read:
 *   1. the flag `input_previous_queries_enabled` (migration 3690, seeded FALSE);
 *   2. the field policy: personalization allowed, `recent` and `completion`
 *      both declared, and a privacy class that may keep per-user memory
 *      (`public` / `viewer_scoped` — the same allow-list selection memory uses);
 *   3. only the search contexts whose submits write that store (`global_search`).
 *
 * PRECISION. A stored query that carries an email address, a phone-like or long
 * digit run, a card-like group or a coordinate pair is never offered back: a
 * suggestion row is shown on screen, often with others nearby, and those are
 * the strings that identify a person or a precise position. The row carries the
 * query text only — no timestamp, no count.
 *
 * A failed read is a PARTIAL refusal naming {@link PREVIOUS_QUERIES_LANE}, never
 * a clean answer the device keeps as "you have no previous searches".
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isFlagEnabled } from '../featureFlags';
import type { InputContext, InputFieldPolicy, InputSuggestion } from './types';
import { selectionQueryKey } from './personalization';

export const INPUT_PREVIOUS_QUERIES_FLAG = 'input_previous_queries_enabled';

/** The contexts whose successful submits are recorded in `search_history`. */
export const PREVIOUS_QUERY_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>(['global_search']);

/** How many of the viewer's newest history rows are scanned (bounded read). */
export const PREVIOUS_QUERY_SCAN = 50;
/** How many previous queries one serve may offer. */
export const PREVIOUS_QUERY_MAX = 2;

const MEMORABLE: ReadonlySet<InputFieldPolicy['privacyClass']> = new Set(['public', 'viewer_scoped']);

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LONG_DIGITS_RE = /\d[\d\s().-]{5,}\d/; // 6+ digits, with or without separators: phone, booking ref, card group
const COORD_PAIR_RE = /-?\d{1,3}\.\d{2,}\s*[,;\s]\s*-?\d{1,3}\.\d{2,}/;
const DMS_RE = /\d{1,3}\s*°/; // V-IN F7: a degrees-minutes-seconds coordinate
// V-IN F7: street-address shape — a house number then a street name ("123 Nguyen Van Linh"). Over-refuses
// a few ordinary searches ("48 hours in tokyo"), which only means they are not offered back.
const ADDRESS_RE = /^\d{1,5}[a-z]?\s+\p{L}+(?:\s+\p{L}+)+/iu;

/** May this stored query be shown back as a suggestion at all? */
export function isResurfaceableQuery(query: string): boolean {
  const q = (query ?? '').trim();
  if (q.length < 2 || q.length > 120) return false;
  if (EMAIL_RE.test(q)) return false;
  if (COORD_PAIR_RE.test(q) || DMS_RE.test(q) || ADDRESS_RE.test(q)) return false;
  if (LONG_DIGITS_RE.test(q)) return false;
  return true;
}

/** Does this field's policy admit previous-query rows? (flag checked separately) */
export function policyAdmitsPreviousQueries(context: InputContext, policy: InputFieldPolicy): boolean {
  if (!PREVIOUS_QUERY_CONTEXTS.has(context)) return false;
  if (policy.allowPersonalization !== true) return false;
  if (!MEMORABLE.has(policy.privacyClass)) return false;
  const types = policy.allowedSuggestionTypes ?? [];
  return types.includes('recent') && types.includes('completion');
}

/**
 * The viewer's own previous successful searches that START WITH what is typed
 * (folded the way selection memory folds), excluding the typed text itself —
 * the serve already carries a "Search «q»" row for that.
 */
export async function buildPreviousQueryCompletions(
  sc: SupabaseClient,
  opts: {
    userId: string;
    context: InputContext;
    policy: InputFieldPolicy;
    typed: string;
    policyVersion: string;
    max?: number;
    onUnreadable?: () => void;
  },
): Promise<InputSuggestion[]> {
  if (!opts.userId) return [];
  if (!policyAdmitsPreviousQueries(opts.context, opts.policy)) return [];
  const typedKey = selectionQueryKey(opts.typed);
  if (typedKey.length < 1) return [];
  if (!(await isFlagEnabled(sc, INPUT_PREVIOUS_QUERIES_FLAG))) return [];

  let rows: Array<{ query?: unknown }>;
  try {
    const { data, error } = await sc
      .from('search_history')
      .select('query, searched_at')
      .eq('user_id', opts.userId) // OWNER SCOPE — never a request parameter.
      .order('searched_at', { ascending: false })
      .limit(PREVIOUS_QUERY_SCAN);
    if (error || !Array.isArray(data)) { opts.onUnreadable?.(); return []; }
    rows = data as Array<{ query?: unknown }>;
  } catch {
    opts.onUnreadable?.();
    return [];
  }

  const max = Math.max(0, Math.min(opts.max ?? PREVIOUS_QUERY_MAX, opts.policy.maxSuggestions));
  const out: InputSuggestion[] = [];
  const seen = new Set<string>([typedKey]);
  for (const r of rows) {
    if (out.length >= max) break;
    const query = typeof r.query === 'string' ? r.query.trim() : '';
    if (!isResurfaceableQuery(query)) continue;
    const key = selectionQueryKey(query);
    if (!key || seen.has(key) || !key.startsWith(typedKey)) continue;
    seen.add(key);
    out.push({
      id: `${opts.context}:previous_query:${key}`,
      type: 'recent',
      context: opts.context,
      label: query,
      replacementText: query,
      action: { type: 'submit_search', query },
      // Above the generic "Search «q»" row's 0.3: a search this person already
      // ran successfully is a stronger completion than the bare text.
      confidence: 0.4,
      source: 'recent',
      reason: 'You searched this before',
      policyVersion: opts.policyVersion,
    });
  }
  return out;
}
