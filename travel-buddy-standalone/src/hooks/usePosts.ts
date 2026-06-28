/**
 * Posts hooks — same {data, loading, error, reload} shape as useBackend's hooks
 * so screens swap import source with minimal churn. All reads/writes go through
 * the API server (src/services/posts.ts). When the backend isn't configured
 * these return empty so the app still runs on mock screens.
 */
import { useEffect, useState, useCallback } from 'react';
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

/** Global social feed (public standalone posts). */
export function useGlobalFeed() {
  const [data, setData] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listGlobalPosts({ limit: 20 });
    if (res.ok) setData(res.data ?? []);
    else setError(res.message ?? res.errorKind ?? 'Failed to load feed');
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}

/** Following feed — public posts from followed users only. */
export function useFollowingFeed() {
  const [data, setData] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listFollowingFeed({ limit: 20 });
    if (res.ok) setData(res.data ?? []);
    else setError(res.message ?? res.errorKind ?? 'Failed to load following feed');
    setLoading(false);
  }, []);

  return { data, loading, error, reload };
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
