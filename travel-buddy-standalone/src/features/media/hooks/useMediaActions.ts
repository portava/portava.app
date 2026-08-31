/**
 * useMediaActions — loads the eligible media action set (§15/§43) and owns the
 * "I Want This" (§15.1) optimistic toggle.
 *
 * Fetches GET /media/:id/actions only when `enabled` (the sheet is open) so the
 * viewer pays no request until the rail is actually invoked. Degrades quietly:
 * a 404 / empty / error resolves to an empty action set (`status: 'empty'`),
 * never throws, and the rail shows a clean "no actions" state.
 *
 * The intent toggle is optimistic with degrade: the row flips immediately, the
 * POST/DELETE fires, and a failure reverts to the pre-tap value (the exact rule
 * lives in the pure `resolveWantedAfterRequest`, unit-tested separately).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchMediaActions,
  postMediaIntent,
  deleteMediaIntent,
  resolveWantedAfterRequest,
} from '../services/mediaActions.ts';
import type { MediaAction, MediaEntityRef, MediaIntentKind } from '../types/mediaActions.ts';

export type MediaActionsStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface UseMediaActionsResult {
  status: MediaActionsStatus;
  actions: MediaAction[];
  entityRefs: MediaEntityRef[];
  /** Current optimistic "I Want This" state for this media. */
  wanted: boolean;
  /** True while the intent POST/DELETE is in flight. */
  wantPending: boolean;
  /** Toggle the "I Want This" signal (optimistic + degrade). */
  toggleWant: (intent?: MediaIntentKind) => void;
  reload: () => void;
}

export function useMediaActions(
  mediaId: string | null | undefined,
  enabled: boolean,
): UseMediaActionsResult {
  const [status, setStatus] = useState<MediaActionsStatus>('idle');
  const [actions, setActions] = useState<MediaAction[]>([]);
  const [entityRefs, setEntityRefs] = useState<MediaEntityRef[]>([]);
  const [wanted, setWanted] = useState(false);
  const [wantPending, setWantPending] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const reqSeq = useRef(0);

  const load = useCallback(() => {
    if (!mediaId || !enabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++reqSeq.current;
    setStatus('loading');
    void fetchMediaActions(mediaId, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || seq !== reqSeq.current) return;
      if (result.ok) {
        setActions(result.data.actions);
        setEntityRefs(result.data.entityRefs);
        setStatus(result.data.actions.length > 0 ? 'ready' : 'empty');
      } else {
        setActions([]);
        setEntityRefs([]);
        // A 404 / empty is a benign "no rail"; a real transport failure is an
        // error the sheet can retry — but neither ever throws.
        setStatus(result.errorKind === 'empty' || result.errorKind === 'auth' ? 'empty' : 'error');
      }
    });
  }, [mediaId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    load();
    return () => abortRef.current?.abort();
  }, [enabled, load]);

  // Reset the (per-media) optimistic want state whenever the item changes.
  useEffect(() => {
    setWanted(false);
    setWantPending(false);
  }, [mediaId]);

  const toggleWant = useCallback(
    (intent: MediaIntentKind = 'want_to_go') => {
      if (!mediaId || wantPending) return;
      const prior = wanted;
      const optimistic = !prior;
      setWanted(optimistic);
      setWantPending(true);
      const req = optimistic ? postMediaIntent(mediaId, intent) : deleteMediaIntent(mediaId);
      void req.then((res) => {
        setWanted(resolveWantedAfterRequest(optimistic, prior, res.ok));
        setWantPending(false);
      });
    },
    [mediaId, wanted, wantPending],
  );

  return { status, actions, entityRefs, wanted, wantPending, toggleWant, reload: load };
}
