/**
 * Posts hooks — same {data, loading, error, reload} shape as useBackend's hooks
 * so screens swap import source with minimal churn. All reads/writes go through
 * the API server (src/services/posts.ts). When the backend isn't configured
 * these return empty so the app still runs on mock screens.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  listGlobalPosts,
  listFollowingFeed,
  listTripPosts,
  createPost,
  updatePost,
  deletePost,
  type PostRow,
  type PostResult,
} from '../services/posts.ts';
import { sanitizeFeedRows, splitPendingPosts } from '../lib/feedSanitize.ts';

const PAGE_SIZE = 20;

/**
 * How long feed data stays "fresh" after a load. Focus-driven refreshes are
 * skipped while fresh so re-entering the tab never resets the list (and the
 * user's scroll position) needlessly.
 */
export const FEED_FOCUS_TTL_MS = 5 * 60 * 1000;

/**
 * How long Pulse and event-detail data stays "fresh" after a load. Focus-driven
 * reloads are skipped within this window so rapid tab switches don't fire
 * redundant network requests (60 s — shorter than the 5-min feed TTL because
 * these screens carry more time-sensitive, ephemeral content).
 */
export const FOCUS_REFETCH_TTL_MS = 60_000;

/** Global social feed (public standalone posts). */
export function useGlobalFeed() {
  const [data, setData] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Newer posts fetched by a background/focus refresh while the user is
  // mid-feed — buffered here (behind a "N new posts" pill) instead of being
  // prepended immediately, which would jump the scroll position.
  const [pending, setPending] = useState<PostRow[]>([]);
  // IDs deleted this session — excluded from every reload so they never reappear
  const deletedIds = useRef(new Set<string>());
  // Timestamp of the last successful load — drives the focus TTL.
  const lastLoadedAt = useRef(0);
  // Guard against overlapping background refreshes.
  const refreshing = useRef(false);

  const markDeleted = useCallback((id: string) => {
    deletedIds.current.add(id);
    setData((prev) => prev.filter((p) => !deletedIds.current.has(p.id)));
    setPending((prev) => prev.filter((p) => !deletedIds.current.has(p.id)));
  }, []);

  /** Full replace — explicit pull-to-refresh / initial load. */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listGlobalPosts({ limit: PAGE_SIZE });
    if (res.ok) {
      setData(sanitizeFeedRows(res.data ?? []).filter((p) => !deletedIds.current.has(p.id)));
      setPending([]);
      lastLoadedAt.current = Date.now();
    } else {
      setError(res.message ?? res.errorKind ?? 'Failed to load feed');
    }
    setLoading(false);
  }, []);

  /**
   * Focus-driven refresh: no-op while the data is fresh (TTL); otherwise
   * fetch in the background WITHOUT clearing the current list. New posts are
   * buffered into `pending` instead of replacing the list mid-scroll.
   */
  const refreshIfStale = useCallback(async (ttlMs: number = FEED_FOCUS_TTL_MS) => {
    if (refreshing.current) return;
    if (Date.now() - lastLoadedAt.current < ttlMs) return;
    refreshing.current = true;
    try {
      const res = await listGlobalPosts({ limit: PAGE_SIZE });
      if (!res.ok) return; // background refresh: keep showing the current list
      const fetched = (res.data ?? []).filter((p) => !deletedIds.current.has(p.id));
      lastLoadedAt.current = Date.now();
      setData((prev) => {
        const { pending: fresh, replace } = splitPendingPosts(prev, fetched);
        if (replace) {
          setPending([]);
          return replace;
        }
        setPending(fresh);
        return prev;
      });
    } finally {
      refreshing.current = false;
    }
  }, []);

  /** Prepend the buffered new posts (user tapped the "new posts" pill). */
  const applyPending = useCallback(() => {
    setPending((buffered) => {
      if (buffered.length > 0) {
        setData((prev) => sanitizeFeedRows([...buffered, ...prev]));
      }
      return [];
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload, refreshIfStale, pending, applyPending, markDeleted };
}

/** Following feed — public posts from followed users only, with cursor pagination. */
export function useFollowingFeed() {
  const [data, setData] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // cursor = createdAt of oldest post on last page
  const [cursor, setCursor] = useState<string | null>(null);
  // Newer posts fetched by a background/focus refresh while the user is
  // mid-feed — buffered here (behind a "N new posts" pill) instead of being
  // prepended immediately, which would jump the scroll position.
  const [pending, setPending] = useState<PostRow[]>([]);
  // IDs deleted this session — excluded from every reload so they never reappear
  const deletedIds = useRef(new Set<string>());
  // Timestamp of the last successful load — drives the focus TTL.
  const lastLoadedAt = useRef(0);
  // Guard against overlapping background refreshes.
  const refreshing = useRef(false);

  const markDeleted = useCallback((id: string) => {
    deletedIds.current.add(id);
    setData((prev) => prev.filter((p) => !deletedIds.current.has(p.id)));
    setPending((prev) => prev.filter((p) => !deletedIds.current.has(p.id)));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCursor(null);
    setHasMore(false);
    const res = await listFollowingFeed({ limit: PAGE_SIZE });
    if (res.ok) {
      const raw = res.data ?? [];
      // Pagination state uses raw backend count so a locally-deleted post cannot
      // prematurely end pagination.
      if (raw.length === PAGE_SIZE) {
        setCursor(raw[raw.length - 1]?.createdAt ?? null);
        setHasMore(true);
      }
      setData(sanitizeFeedRows(raw).filter((p) => !deletedIds.current.has(p.id)));
      setPending([]);
      lastLoadedAt.current = Date.now();
    } else {
      setError(res.message ?? res.errorKind ?? 'Failed to load following feed');
    }
    setLoading(false);
  }, []);

  /**
   * Focus-driven refresh: no-op while the data is fresh (TTL); otherwise
   * fetch in the background WITHOUT clearing the current list. New posts are
   * buffered into `pending` instead of replacing the list mid-scroll.
   */
  const refreshIfStale = useCallback(async (ttlMs: number = FEED_FOCUS_TTL_MS) => {
    if (refreshing.current) return;
    if (Date.now() - lastLoadedAt.current < ttlMs) return;
    refreshing.current = true;
    try {
      const res = await listFollowingFeed({ limit: PAGE_SIZE });
      if (!res.ok) return; // background refresh: keep showing the current list
      const fetched = (res.data ?? []).filter((p) => !deletedIds.current.has(p.id));
      lastLoadedAt.current = Date.now();
      setData((prev) => {
        const { pending: fresh, replace } = splitPendingPosts(prev, fetched);
        if (replace) {
          setPending([]);
          return replace;
        }
        setPending(fresh);
        return prev;
      });
    } finally {
      refreshing.current = false;
    }
  }, []);

  /** Prepend the buffered new posts (user tapped the "new posts" pill). */
  const applyPending = useCallback(() => {
    setPending((buffered) => {
      if (buffered.length > 0) {
        setData((prev) => sanitizeFeedRows([...buffered, ...prev]));
      }
      return [];
    });
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !cursor) return;
    setLoadingMore(true);
    const res = await listFollowingFeed({ limit: PAGE_SIZE, before: cursor });
    if (res.ok) {
      const rows = res.data ?? [];
      // De-dupe by id and exclude locally-deleted posts
      setData((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const fresh = sanitizeFeedRows(rows).filter((p) => !seen.has(p.id) && !deletedIds.current.has(p.id));
        return [...prev, ...fresh];
      });
      if (rows.length === PAGE_SIZE) {
        setCursor(rows[rows.length - 1]?.createdAt ?? null);
        setHasMore(true);
      } else {
        setCursor(null);
        setHasMore(false);
      }
    }
    setLoadingMore(false);
  }, [loadingMore, hasMore, cursor]);

  return { data, loading, loadingMore, hasMore, error, reload, refreshIfStale, loadMore, markDeleted, pending, applyPending };
}

/** A trip's feed. isMember reflects whether the viewer is an accepted member. */
export function useTripPosts(tripId: string | undefined) {
  const [data, setData] = useState<PostRow[]>([]);
  const [isMember, setIsMember] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Timestamp of the last successful load — drives the focus TTL.
  const lastLoadedAt = useRef(0);

  const reload = useCallback(async () => {
    if (!tripId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await listTripPosts(tripId);
    if (res.ok) {
      setData(res.data ?? []);
      setIsMember(Boolean(res.isMember));
      lastLoadedAt.current = Date.now();
    } else {
      setError(res.message ?? res.errorKind ?? 'Failed to load trip posts');
    }
    setLoading(false);
  }, [tripId]);

  /** Focus-driven refresh: only reload when the data is older than the TTL. */
  const refreshIfStale = useCallback(async (ttlMs: number = FEED_FOCUS_TTL_MS) => {
    if (Date.now() - lastLoadedAt.current < ttlMs) return;
    await reload();
  }, [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, isMember, loading, error, reload, refreshIfStale };
}

/**
 * Imperative actions for a composer / post menu. Each returns the PostResult so
 * the caller can branch on errorKind (e.g. show "you must be a member").
 */
export function usePostActions() {
  const [submitting, setSubmitting] = useState(false);

  const create = useCallback(
    async (input: Parameters<typeof createPost>[0]): Promise<PostResult<PostRow>> => {
      setSubmitting(true);
      try {
        return await createPost(input);
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const edit = useCallback(
    async (postId: string, patch: Parameters<typeof updatePost>[1]): Promise<PostResult<PostRow>> => {
      setSubmitting(true);
      try {
        return await updatePost(postId, patch);
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const remove = useCallback(async (postId: string): Promise<PostResult<null>> => {
    setSubmitting(true);
    try {
      return await deletePost(postId);
    } finally {
      setSubmitting(false);
    }
  }, []);

  return { create, edit, remove, submitting };
}
