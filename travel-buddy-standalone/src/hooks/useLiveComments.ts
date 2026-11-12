import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { AppState } from 'react-native';
import { useSession } from '../context/SessionContext.tsx';
import { useInputAccountEpoch } from '../platform/input-assistance/hooks/useInputAccountEpoch.ts';
import { captureMessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { readLiveComments, readLiveReplies } from '../services/commentActivity.ts';
import type { EngagementComment, EngagementReply } from '../services/postEngagement.ts';

export const COMMENT_REFRESH_MS = 4000;
export interface CommentMutation {
  isCurrent: () => boolean;
  finish: () => void;
}
interface CommentState {
  comments: EngagementComment[];
  loading: boolean;
  error: boolean;
  newCount: number;
  repliesMap: Record<string, EngagementReply[]>;
  repliesLoaded: Set<string>;
  repliesOpen: Set<string>;
  repliesLoading: Set<string>;
  repliesErrors: Set<string>;
}
const empty = (loading = false): CommentState => ({comments: [], loading, error: false, newCount: 0,
  repliesMap: {}, repliesLoaded: new Set(), repliesOpen: new Set(), repliesLoading: new Set(), repliesErrors: new Set()});

// This external session controller owns cancellation/revisions. React renders
// immutable snapshots of its value; request callbacks never mutate a render snapshot.
class CommentScope {
  readonly owner = captureMessagingOwnerRequest();
  live = false;
  foreground = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  revision = 0;
  mutations = 0;
  value: CommentState;
  controllers = new Set<AbortController>();
  refresh = () => {};
  loadReplies: (id: string) => Promise<void> = () => Promise.resolve();
  constructor(readonly postId: string, readonly active: boolean, readonly userId: string | null, readonly epoch: number) {
    const ready = Boolean(userId) && this.owner?.ownerId === userId && Boolean(this.owner?.isCurrent());
    this.value = empty(active && ready);
    this.value.error = active && !ready;
  }
  patch(next: Partial<CommentScope>) { Object.assign(this, next); }
  revise() { this.revision++; }
  begin() { this.mutations++; this.revise(); }
  finish() { this.mutations--; this.revise(); }
}

/** One owner/post/open session owns every answer, mutation and expanded reply thread. */
export function useLiveComments(postId: string, active: boolean, onCountChange: (count: number) => void) {
  const { userId } = useSession();
  const epoch = useInputAccountEpoch();
  const scope = useMemo(() => new CommentScope(postId, active, userId, epoch), [postId, active, userId, epoch]);
  const [snapshot, setSnapshot] = useState({scope, value: scope.value});
  const countCallback = useRef(onCountChange);
  useEffect(() => { countCallback.current = onCountChange; }, [onCountChange]);
  const sessionCurrent = useCallback(() => scope.live && active && Boolean(scope.owner)
    && scope.owner?.ownerId === userId && scope.owner.isCurrent(), [scope, active, userId]);
  const current = useCallback(() => sessionCurrent() && scope.foreground, [scope, sessionCurrent]);
  const publish = useCallback((patch: Partial<CommentState>) => {
    if (!scope.live) return;
    scope.patch({value: {...scope.value, ...patch}});
    setSnapshot({scope, value: scope.value});
  }, [scope]);
  const update = useCallback(<K extends keyof CommentState>(key: K, next: SetStateAction<CommentState[K]>) => {
    if (!sessionCurrent()) return;
    scope.revise();
    const value = typeof next === 'function' ? (next as (previous: CommentState[K]) => CommentState[K])(scope.value[key]) : next;
    publish({[key]: value} as Pick<CommentState, K>);
  }, [scope, sessionCurrent, publish]);
  const setComments = useCallback((next: SetStateAction<EngagementComment[]>) => update('comments', next), [update]);
  const setRepliesMap = useCallback((next: SetStateAction<Record<string, EngagementReply[]>>) => update('repliesMap', next), [update]);
  const setRepliesLoaded = useCallback((next: SetStateAction<Set<string>>) => update('repliesLoaded', next), [update]);
  const setRepliesOpen = useCallback((next: SetStateAction<Set<string>>) => update('repliesOpen', next), [update]);
  const beginMutation = useCallback((): CommentMutation | null => {
    if (!current()) return null;
    scope.begin();
    for (const controller of scope.controllers) controller.abort();
    let finished = false;
    return {isCurrent: sessionCurrent, finish: () => {
      if (finished) return;
      finished = true; scope.finish();
      if (current()) queueMicrotask(() => scope.refresh());
    }};
  }, [scope, current, sessionCurrent]);

  useEffect(() => {
    scope.patch({live: true});
    if (!active || !userId || !scope.owner || scope.owner.ownerId !== userId) {
      return () => { scope.patch({live: false}); };
    }
    const owner = scope.owner;
    let busy = false;
    let queued = false;
    let initialized = false;
    const seen = new Set<string>();
    const replyRequests = new Map<string, AbortController>();
    const clearPrivate = () => {
      scope.revise();
      for (const controller of scope.controllers) controller.abort();
      publish({...empty(), error: true});
    };
    const loadReplies = async (id: string, open = true) => {
      if (!current() || scope.mutations || replyRequests.has(id) || !scope.value.comments.some(row => row.id === id)) return;
      const revision = scope.revision;
      const pending = new AbortController(); scope.controllers.add(pending); replyRequests.set(id, pending);
      publish({repliesLoading: new Set(scope.value.repliesLoading).add(id)});
      try {
        const result = await readLiveReplies(postId, id, {owner, signal: pending.signal, isCurrent: current});
        if (!current() || pending.signal.aborted || revision !== scope.revision) return;
        if (!scope.value.comments.some(row => row.id === id) || !open && !scope.value.repliesOpen.has(id)) return;
        const errors = new Set(scope.value.repliesErrors);
        if (!result.ok) {
          errors.add(id);
          const repliesMap = {...scope.value.repliesMap};
          if (result.denied) delete repliesMap[id];
          publish({repliesErrors: errors, repliesMap});
          return;
        }
        errors.delete(id);
        publish({repliesMap: {...scope.value.repliesMap, [id]: result.replies}, repliesErrors: errors,
          repliesLoaded: new Set(scope.value.repliesLoaded).add(id),
          repliesOpen: open ? new Set(scope.value.repliesOpen).add(id) : scope.value.repliesOpen});
      } catch {
        if (current() && !pending.signal.aborted) publish({repliesErrors: new Set(scope.value.repliesErrors).add(id)});
      } finally {
        scope.controllers.delete(pending); replyRequests.delete(id);
        if (scope.live) { const loading = new Set(scope.value.repliesLoading); loading.delete(id); publish({repliesLoading: loading}); }
      }
    };
    const refresh = async () => {
      if (!owner.isCurrent()) { if (scope.live) clearPrivate(); return; }
      if (!current() || scope.mutations) return;
      if (busy) { queued = true; return; }
      busy = true; queued = false;
      const revision = scope.revision;
      const pending = new AbortController(); scope.controllers.add(pending);
      try {
        const result = await readLiveComments(postId, {owner, signal: pending.signal, isCurrent: current});
        if (!current() || pending.signal.aborted || revision !== scope.revision) return;
        if (!result.ok) { if (result.denied) clearPrivate(); else publish({error: true}); return; }
        const added = initialized ? result.comments.filter(row => !seen.has(row.id) && row.author.id !== owner.ownerId).length : 0;
        for (const row of result.comments) seen.add(row.id);
        initialized = true;
        const visible = new Set(result.comments.map(row => row.id));
        publish({comments: result.comments, error: false, newCount: scope.value.newCount + added,
          repliesMap: Object.fromEntries(Object.entries(scope.value.repliesMap).filter(([id]) => visible.has(id))),
          repliesOpen: new Set([...scope.value.repliesOpen].filter(id => visible.has(id)))});
        countCallback.current(result.comments.length);
        for (const id of scope.value.repliesOpen) void loadReplies(id, false);
      } catch {
        if (current() && !pending.signal.aborted) publish({error: true});
      } finally {
        scope.controllers.delete(pending); busy = false;
        if (scope.live) publish({loading: false});
        if (queued && current()) { queued = false; void refresh(); }
      }
    };
    scope.patch({refresh: () => { void refresh(); }, loadReplies: id => loadReplies(id)});
    void refresh();
    const timer = setInterval(() => { void refresh(); }, COMMENT_REFRESH_MS);
    const app = AppState.addEventListener('change', state => {
      scope.patch({foreground: state === 'active'});
      if (!scope.foreground) for (const controller of scope.controllers) controller.abort();
      else void refresh();
    });
    return () => { scope.patch({live: false}); for (const controller of scope.controllers) controller.abort(); clearInterval(timer); app.remove(); };
  }, [scope, postId, active, userId, current, publish]);

  // A new post/account/closed sheet must not render the previous session for one frame.
  const visible = active && snapshot.scope === scope && (!scope.owner || scope.owner.ownerId === userId && scope.owner.isCurrent());
  return {...(visible ? snapshot.value : snapshot.scope !== scope ? scope.value : {...empty(), error: active}), setComments, setRepliesMap, setRepliesLoaded, setRepliesOpen,
    beginMutation, isCurrent: current, load: useCallback(() => scope.refresh(), [scope]),
    loadReplies: useCallback((id: string) => scope.loadReplies(id), [scope]),
    clearNewCount: useCallback(() => { if (current()) publish({newCount: 0}); }, [current, publish])};
}
