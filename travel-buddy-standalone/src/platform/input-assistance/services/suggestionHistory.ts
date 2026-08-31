/**
 * Global Input Intelligence — selection memory / recents (spec §32, §35).
 *
 * PARTIAL (Phase 1). The engine may learn from repeated EXPLICIT selections,
 * never inferred private facts (§35). Recents should be device-local where
 * allowed (§32) so cold-start / offline still shows useful zero-state.
 *
 * The client audit flags that today's recents (`useRecentPlaces`, search
 * history) are server + in-memory only — no device persistence. A LATER PHASE
 * (8: Personalization) adds AsyncStorage-backed, per-context, per-user recent
 * selection memory. This module ships the in-memory ring buffer now (correct
 * behavior within a session) behind an interface that the persistent store will
 * implement, so consumers depend on the shape today.
 *
 * Kept dependency-free (no AsyncStorage/supabase import) so it is safe to import
 * anywhere, including node:test. Persistence is added by swapping the backing
 * store, not the interface.
 */
import type { InputContext } from '../types/inputContext.ts';

export interface RecentSelection {
  /** Canonical entity id (or query text for query completions). */
  value: string;
  label: string;
  /** ms since epoch of the most recent selection. */
  at: number;
}

/** Per-(context) most-recent-first list, capped. In-memory for Phase 1. */
const store = new Map<InputContext, RecentSelection[]>();
const MAX_PER_CONTEXT = 10;

/** Record an explicit selection (§35 — only explicit, never inferred). */
export function recordSelection(context: InputContext, sel: Omit<RecentSelection, 'at'>): void {
  const list = store.get(context) ?? [];
  const deduped = list.filter((r) => r.value !== sel.value);
  deduped.unshift({ ...sel, at: Date.now() });
  store.set(context, deduped.slice(0, MAX_PER_CONTEXT));
}

/** Read recent selections for a context, most-recent first (§14 zero-state). */
export function getRecentSelections(context: InputContext, limit = MAX_PER_CONTEXT): RecentSelection[] {
  return (store.get(context) ?? []).slice(0, limit);
}

/** Clear a context's recents (or all when omitted). Tests + privacy controls. */
export function clearRecentSelections(context?: InputContext): void {
  if (context) store.delete(context);
  else store.clear();
}
