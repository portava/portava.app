/**
 * usePostcardActions — optimistic CRUD for passport postcards.
 * Wraps updatePostcard / removePostcard from the profile service.
 * Consumers pass setPostcards from usePassport so state stays in one place.
 */
import { useState, useCallback } from 'react';
import type { PassportPostcard } from '../types/models.ts';
import { updatePostcard, removePostcard, type PostcardPatch } from '../services/profile.ts';
import { deletePost } from '../services/posts.ts';

export interface PostcardActionsState {
  busy: string | null; // postcard id currently being mutated
  error: string | null;
}

export function usePostcardActions(
  setPostcards: React.Dispatch<React.SetStateAction<PassportPostcard[]>>,
) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const withOptimistic = useCallback(
    async (
      id: string,
      optimisticUpdate: (prev: PassportPostcard[]) => PassportPostcard[],
      action: () => Promise<{ ok: boolean; message?: string }>,
      rollback: (prev: PassportPostcard[]) => PassportPostcard[],
    ) => {
      setBusy(id);
      setError(null);
      setPostcards(optimisticUpdate);
      const result = await action();
      setBusy(null);
      if (!result.ok) {
        setPostcards(rollback);
        setError(result.message ?? 'Action failed');
      }
    },
    [setPostcards],
  );

  const editNote = useCallback(async (id: string, note: string | null) => {
    let prev: PassportPostcard[] = [];
    await withOptimistic(
      id,
      (cards) => { prev = cards; return cards.map((c) => c.id === id ? { ...c, note } : c); },
      () => updatePostcard(id, { note }),
      () => prev,
    );
  }, [withOptimistic]);

  const clearNote = useCallback(async (id: string) => {
    await editNote(id, null);
  }, [editNote]);

  const pin = useCallback(async (id: string) => {
    let prev: PassportPostcard[] = [];
    const now = new Date().toISOString();
    await withOptimistic(
      id,
      (cards) => {
        prev = cards;
        return cards.map((c) =>
          c.id === id ? { ...c, pinnedAt: now } : { ...c, pinnedAt: null },
        );
      },
      () => updatePostcard(id, { pin: true }),
      () => prev,
    );
  }, [withOptimistic]);

  const unpin = useCallback(async (id: string) => {
    let prev: PassportPostcard[] = [];
    await withOptimistic(
      id,
      (cards) => { prev = cards; return cards.map((c) => c.id === id ? { ...c, pinnedAt: null } : c); },
      () => updatePostcard(id, { pin: false }),
      () => prev,
    );
  }, [withOptimistic]);

  const remove = useCallback(async (id: string) => {
    let prev: PassportPostcard[] = [];
    await withOptimistic(
      id,
      (cards) => { prev = cards; return cards.filter((c) => c.id !== id); },
      () => removePostcard(id),
      () => prev,
    );
  }, [withOptimistic]);

  const deletePostAndCard = useCallback(async (id: string, postId: string) => {
    let prev: PassportPostcard[] = [];
    await withOptimistic(
      id,
      (cards) => { prev = cards; return cards.filter((c) => c.id !== id); },
      async () => {
        const [removeRes, deleteRes] = await Promise.all([
          removePostcard(id),
          deletePost(postId),
        ]);
        return { ok: removeRes.ok && deleteRes.ok, message: removeRes.message ?? deleteRes.message };
      },
      () => prev,
    );
  }, [withOptimistic]);

  return { busy, error, editNote, clearNote, pin, unpin, remove, deletePostAndCard };
}
