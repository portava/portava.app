/**
 * useQuickMedia — the Stories / Quick Media row's data (Wall spec §18).
 *
 * Loads the followed people's short-lived media from GET /wall/quick-media and
 * folds it into one ring per PERSON (newest first) — the row is a quiet strip
 * of people, not a media grid, and must not compete with Live For You (§18).
 *
 * Short-lived means short-lived on the client too: an item whose `expiresAt`
 * has passed is dropped at fold time (no stale rings), the same way the live
 * strip drops stale labels (§4).
 *
 * FAIL-SOFT (spec §34/§40): any failure resolves to an empty row, so the row
 * simply renders nothing and the social feed underneath is untouched.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchQuickMedia } from '../services/wallApi.ts';
import type { QuickMediaEntry } from '../components/QuickMediaRow.tsx';
import type { QuickMediaItem } from '../types/wallProjection.ts';

const DEFAULT_LIMIT = 40;

export interface UseQuickMediaResult {
  /** One ring per person, newest activity first. Empty renders nothing. */
  entries: QuickMediaEntry[];
  /** The raw, unexpired items behind the rings (newest first). */
  items: QuickMediaItem[];
  loading: boolean;
  /** True when the Wall is disabled / unconfigured / signed out → empty row. */
  degraded: boolean;
  refresh: () => void;
}

function isUnexpired(item: QuickMediaItem, nowMs: number): boolean {
  const exp = Date.parse(item.expiresAt);
  return Number.isFinite(exp) ? exp > nowMs : false;
}

/** Fold items into one entry per owner. Pure — exported for tests. */
export function foldQuickMedia(items: QuickMediaItem[], nowMs = Date.now()): {
  entries: QuickMediaEntry[];
  items: QuickMediaItem[];
} {
  const live = items
    .filter((i) => i && typeof i.postId === 'string' && isUnexpired(i, nowMs))
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const byOwner = new Map<string, QuickMediaEntry>();
  for (const item of live) {
    const existing = byOwner.get(item.ownerUserId);
    if (existing) {
      existing.mediaCount = (existing.mediaCount ?? 1) + 1;
      continue;
    }
    byOwner.set(item.ownerUserId, {
      id: item.ownerUserId,
      label: item.actor?.displayName ?? 'Someone',
      avatarUrl: item.actor?.avatarUrl ?? null,
      postId: item.postId,
      mediaCount: 1,
    });
  }
  return { entries: [...byOwner.values()], items: live };
}

export function useQuickMedia({
  enabled = true,
  limit = DEFAULT_LIMIT,
}: { enabled?: boolean; limit?: number } = {}): UseQuickMediaResult {
  const [items, setItems] = useState<QuickMediaItem[]>([]);
  const [entries, setEntries] = useState<QuickMediaEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const genRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) {
      setItems([]);
      setEntries([]);
      return;
    }
    const gen = ++genRef.current;
    setLoading(true);
    try {
      const res = await fetchQuickMedia({ limit });
      if (gen !== genRef.current) return;
      // A missing / malformed result is treated as "nothing to show" (§40 #7).
      if (!res || !res.ok) return;
      setDegraded(res.degraded);
      const folded = foldQuickMedia(res.items);
      setItems(folded.items);
      setEntries(folded.entries);
    } catch {
      // Fail-soft: keep whatever is on screen (possibly nothing).
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [enabled, limit]);

  useEffect(() => {
    void load();
    return () => {
      genRef.current += 1;
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { entries, items, loading, degraded, refresh };
}
