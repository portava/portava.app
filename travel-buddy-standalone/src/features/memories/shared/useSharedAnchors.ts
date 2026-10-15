/**
 * useSharedAnchors — the one state machine behind the Memory screen's panel and
 * the invitations list (census-highlights-memories H53, MEM-ANCHOR-2).
 *
 * FLAG FIRST. `memory_shared_anchors_enabled` OFF in the app's flags (or no
 * signed-in viewer) ⇒ `off`: not one request is made and the callers render
 * nothing. If the app's flag says ON but the server answers 404 (its router
 * falls through while ITS flag is OFF) ⇒ `absent`, which renders exactly like
 * `off`, and nothing more is asked.
 *
 * NO MEMORY ACROSS LOADS. Every load replaces the state with what the server
 * answered NOW; nothing is diffed against an earlier answer, so the app can
 * never say "someone left" or "someone blocked you" — it only ever knows what
 * the server shows this instant (Q-H53-6: the server's own two-person case is
 * the owner's to rule on; the app adds nothing on top of it).
 *
 * WRITES: one at a time; a refused or failed write sets ONE flag (`refused`),
 * never a reason. Decline and leave remove the anchor from the screen as soon as
 * the server accepts them, then the list is re-read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFeatureFlags } from '../../../context/FeatureFlagsContext.tsx';
import {
  SHARED_ANCHORS_FLAG,
  acceptSharedAnchor,
  declineSharedAnchor,
  inviteToRemember,
  leaveSharedAnchor,
  listInvitable,
  listSharedAnchors,
  type SharedAnchor,
  type SharedAnchorPerson,
  type WriteResult,
} from './sharedAnchorsApi.ts';

export type SharedAnchorsState =
  | { readonly kind: 'off' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly anchors: readonly SharedAnchor[]; readonly people: readonly SharedAnchorPerson[] };

export interface SharedAnchorsHandle {
  readonly on: boolean;
  readonly state: SharedAnchorsState;
  /** The write in flight (`<verb>:<id>`), or null. */
  readonly busy: string | null;
  /** The last write was refused or failed. One flag: the app never learns why. */
  readonly refused: boolean;
  readonly reload: () => Promise<void>;
  readonly invite: (userId: string) => Promise<void>;
  readonly accept: (anchorId: string, ownMemoryId: string | null) => Promise<void>;
  readonly decline: (anchorId: string) => Promise<void>;
  readonly leave: (anchorId: string) => Promise<void>;
}

/**
 * `memoryId` + `isOwner`: the Memory screen's context. Only the OWNER of that
 * Memory asks who can be invited; the hub passes no Memory and asks nothing of it.
 */
export function useSharedAnchors({ viewerId, memoryId, isOwner }: { viewerId: string | null; memoryId: string | null; isOwner: boolean }): SharedAnchorsHandle {
  const { isEnabled } = useFeatureFlags();
  const on = isEnabled(SHARED_ANCHORS_FLAG) && typeof viewerId === 'string' && viewerId.length > 0;
  const wantInvitable = on && isOwner && typeof memoryId === 'string' && memoryId.length > 0;

  const [state, setState] = useState<SharedAnchorsState>({ kind: 'off' });
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const seq = useRef(0);
  const busyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const list = await listSharedAnchors();
    if (mine !== seq.current) return;
    if (list.state !== 'ok') { setState({ kind: list.state }); return; }
    let people: readonly SharedAnchorPerson[] = [];
    if (wantInvitable) {
      const inv = await listInvitable(memoryId as string);
      if (mine !== seq.current) return;
      if (inv.state === 'error') { setState({ kind: 'error' }); return; }
      if (inv.state === 'ok') people = inv.people;
    }
    setState({ kind: 'ready', anchors: list.anchors, people });
  }, [wantInvitable, memoryId]);

  useEffect(() => {
    if (!on) { seq.current++; setState({ kind: 'off' }); return undefined; }
    setState({ kind: 'loading' });
    void load();
    return () => { seq.current++; };
  }, [on, load]);

  const act = useCallback(async (key: string, write: () => Promise<WriteResult>, onOk: () => void) => {
    if (!on || busyRef.current !== null) return;
    busyRef.current = key;
    setBusy(key);
    setRefused(false);
    const r = await write();
    busyRef.current = null;
    setBusy(null);
    if (r.ok) onOk(); else setRefused(true);
    await load();
  }, [on, load]);

  const dropAnchor = useCallback((anchorId: string) => {
    setState((s) => (s.kind === 'ready' ? { ...s, anchors: s.anchors.filter((a) => a.id !== anchorId) } : s));
  }, []);

  const invite = useCallback((userId: string) => act(
    `invite:${userId}`,
    () => (wantInvitable ? inviteToRemember(memoryId as string, userId) : Promise.resolve({ ok: false })),
    () => setState((s) => (s.kind === 'ready' ? { ...s, people: s.people.filter((p) => p.userId !== userId) } : s)),
  ), [act, wantInvitable, memoryId]);

  const accept = useCallback((anchorId: string, ownMemoryId: string | null) => act(
    `accept:${anchorId}`, () => acceptSharedAnchor(anchorId, ownMemoryId), () => {},
  ), [act]);

  const decline = useCallback((anchorId: string) => act(
    `decline:${anchorId}`, () => declineSharedAnchor(anchorId), () => dropAnchor(anchorId),
  ), [act, dropAnchor]);

  const leave = useCallback((anchorId: string) => act(
    `leave:${anchorId}`, () => leaveSharedAnchor(anchorId), () => dropAnchor(anchorId),
  ), [act, dropAnchor]);

  return { on, state, busy, refused, reload: load, invite, accept, decline, leave };
}
