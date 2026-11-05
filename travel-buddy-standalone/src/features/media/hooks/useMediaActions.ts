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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../../../lib/supabase.ts';
import { onDiscoveryScopeChange } from '../../../services/discoveryViewerScope.ts';
import { captureMessagingOwnerRequest, type MessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { fetchMediaActions, postMediaIntent, deleteMediaIntent, resolveWantedAfterRequest } from '../services/mediaActions.ts';
import type { MediaAction, MediaEntityRef, MediaIntentKind } from '../types/mediaActions.ts';

export type MediaActionsStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
export interface UseMediaActionsResult {
  status: MediaActionsStatus;
  actions: MediaAction[];
  entityRefs: MediaEntityRef[];
  wanted: boolean;
  wantPending: boolean;
  wantError: string | null;
  toggleWant: (intent?: MediaIntentKind) => void;
  reload: () => void;
}
interface Lifetime {
  owner: MessagingOwnerRequest | null;
  retired: boolean;
  read: AbortController | null;
  mutation: AbortController | null;
  wanted: boolean;
  wantRevision: number;
}
type Data = Omit<UseMediaActionsResult, 'toggleWant' | 'reload'>;
const EMPTY: Data = { status: 'idle', actions: [], entityRefs: [], wanted: false, wantPending: false, wantError: null };
function retire(lifetime: Lifetime) {
  lifetime.retired = true;
  lifetime.read?.abort();
  lifetime.mutation?.abort();
}

export function useMediaActions(mediaId: string | null | undefined, enabled: boolean): UseMediaActionsResult {
  const [revision, setRevision] = useState(0);
  const lifetime = useMemo<Lifetime>(() => ({ owner: captureMessagingOwnerRequest(), retired: false,
    read: null, mutation: null, wanted: false, wantRevision: 0 }), [mediaId, enabled, revision]);
  const latest = useRef(lifetime);
  latest.current = lifetime;
  const [state, setState] = useState<{ lifetime: Lifetime; data: Data }>({ lifetime, data: EMPTY });
  const current = useCallback(() => enabled && !!mediaId && latest.current === lifetime && !lifetime.retired && !!lifetime.owner?.isCurrent(), [lifetime, enabled, mediaId]);
  const update = useCallback((change: Partial<Data>) => {
    if (!current()) return;
    setState(previous => ({ lifetime, data: { ...(previous.lifetime === lifetime ? previous.data : EMPTY), ...change } }));
  }, [current, lifetime]);

  useEffect(() => {
    let mounted = true;
    const changed = () => {
      if (!mounted) return;
      const active = latest.current;
      if (active.owner?.isCurrent()) return;
      retire(active);
      setRevision(value => value + 1);
    };
    const unsubscribeScope = onDiscoveryScopeChange(changed);
    const subscription = isSupabaseConfigured ? supabase.auth.onAuthStateChange(() => { queueMicrotask(changed); }).data.subscription : null;
    return () => { mounted = false; unsubscribeScope(); subscription?.unsubscribe(); };
  }, []);

  const load = useCallback(() => {
    if (!current()) return;
    lifetime.read?.abort();
    const controller = new AbortController();
    lifetime.read = controller;
    const wantRevision = lifetime.wantRevision;
    update({ status: 'loading' });
    void fetchMediaActions(mediaId!, { signal: controller.signal }).then(result => {
      if (!current() || controller.signal.aborted || lifetime.read !== controller) return;
      if (result.ok) {
        const canRestoreWanted = typeof result.data.wanted === 'boolean' && !lifetime.mutation && wantRevision === lifetime.wantRevision;
        if (canRestoreWanted) lifetime.wanted = result.data.wanted!;
        update({ actions: result.data.actions, entityRefs: result.data.entityRefs,
          ...(canRestoreWanted ? { wanted: lifetime.wanted } : {}),
          status: result.data.actions.length > 0 ? 'ready' : 'empty' });
      } else update({ actions: [], entityRefs: [], status: result.errorKind === 'empty' || result.errorKind === 'auth' ? 'empty' : 'error' });
    }).catch(() => { if (!controller.signal.aborted) update({ status: 'error', actions: [], entityRefs: [] }); });
  }, [current, lifetime, mediaId, update]);

  useEffect(() => {
    lifetime.retired = false;
    load();
    return () => retire(lifetime);
  }, [lifetime, load]);

  const toggleWant = useCallback((intent: MediaIntentKind = 'want_to_go') => {
    if (!current() || lifetime.mutation) return;
    const controller = new AbortController();
    lifetime.mutation = controller; // synchronous lock: rapid taps cannot write twice
    lifetime.wantRevision += 1;
    const prior = lifetime.wanted;
    const optimistic = !prior;
    lifetime.wanted = optimistic;
    update({ wanted: optimistic, wantPending: true, wantError: null });
    const request = optimistic ? postMediaIntent(mediaId!, intent, { signal: controller.signal })
      : deleteMediaIntent(mediaId!, { signal: controller.signal });
    const settle = (ok: boolean) => {
      if (!current() || controller.signal.aborted || lifetime.mutation !== controller) return;
      lifetime.mutation = null;
      lifetime.wanted = resolveWantedAfterRequest(optimistic, prior, ok);
      update({ wanted: lifetime.wanted, wantPending: false, wantError: ok ? null : 'Couldn’t update your interest. Try again.' });
    };
    void request.then(result => settle(result.ok), () => settle(false));
  }, [current, lifetime, mediaId, update]);

  // No previous item/account content is painted while effects catch up.
  const data = state.lifetime === lifetime && current() ? state.data : EMPTY;
  return { ...data, toggleWant, reload: load };
}
