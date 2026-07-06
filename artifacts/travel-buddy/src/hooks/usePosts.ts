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
} from '../services/posts';

const PAGE_SIZE = 20;

/** Global social feed (public standalone posts). */
export function useGlobalFeed() {
  const [data, setData] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // IDs deleted this session — excluded from every reload so they never reappear
  const deletedIds = useRef(new Set<string>());

  const markDeleted = useCallback((id: string) => {
    deletedIds.current.add(id);
    setData((prev) => prev.filter((p) => !deletedIds.current.has(p.id)));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listGlobalPosts({ limit: PAGE_SIZE });
    if (res.ok) setData((res.data ?? []).filter((p) => !deletedIds.current.has(p.id)));
    else setError(res.message ?? res.errorKind ?? 'Failed to load feed');
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload, markDeleted };
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
  // IDs deleted this session — excluded from every reload so they never reappear
  const deletedIds = useRef(new Set<string>());

  const markDeleted = useCallback((id: string) => {
    deletedIds.current.add(id);
    setData((prev) => prev.filter((p) => !deletedIds.current.has(p.id)));
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
      setData(raw.filter((p) => !deletedIds.current.has(p.id)));
    } else {
      setError(res.message ?? res.errorKind ?? 'Failed to load following feed');
    }
    setLoading(false);
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
        const fresh = rows.filter((p) => !seen.has(p.id) && !deletedIds.current.has(p.id));
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

  return { data, loading, loadingMore, hasMore, error, reload, loadMore, markDeleted };
}

/** A trip's feed. isMember reflects whether the viewer is an accepted member. */
export function useTripPosts(tripId: string | undefined) {
  const [data, setData] = useState<PostRow[]>([]);
  const [isMember, setIsMember] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    } else {
      setError(res.message ?? res.errorKind ?? 'Failed to load trip posts');
    }
    setLoading(false);
  }, [tripId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, isMember, loading, error, reload };
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
