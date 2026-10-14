/**
 * useCompactPlaybackSource — the thread hooks' half of compact playback
 * (Telegraph §6.3, census-telegraph T62).
 *
 * `useThreadMessages` and `useGroupChat` call this with what they hold. It
 * registers the hook instance as a MESSAGE SOURCE for as long as it is mounted
 * and reports every change to its messages. A playback session binds to the
 * sources that held its video when it was opened, and `compactPlaybackStore`
 * stops it the moment one of them no longer does — an unsend, a delete or a
 * hide that reached the thread reaches the player in the same render — or
 * stops being able to say (`live: false`: the server answered the thread read
 * `forbidden`/`not_found`, i.e. the viewer is no longer a member), or unmounts.
 *
 * `recheck` is for a hook with no poll of its own (the group chat reads only on
 * realtime events and on reconnect / foreground return). While a session is
 * bound to this source, and only then, it is called every
 * SOURCE_RECHECK_MS, so a member REMOVED from a group — who is sent no event —
 * loses the video within that bound: the re-read answers `forbidden`, the hook
 * goes `no_access`, the source stops being live. A thread hook that already
 * polls (the DM hook, every 3 s in the foreground) passes none.
 *
 * The signal comes from here and not from the screens on purpose: the screens
 * render a filtered stream (layers, panels), the hooks hold the conversation.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  isSourceBound,
  registerMessageSource,
  reportMessageSource,
  subscribeCompactPlayback,
  unregisterMessageSource,
  type PlaybackSourceMessage,
} from './compactPlaybackStore.ts';

/** How long a removed member can keep a group video while nothing else re-reads the thread. */
export const SOURCE_RECHECK_MS = 30_000;

/** A thread read the server refused because the viewer may no longer read the thread. */
export function isAccessLoss(res: { ok: boolean; errorKind?: string | null }): boolean {
  return !res.ok && (res.errorKind === 'forbidden' || res.errorKind === 'not_found');
}

export function useCompactPlaybackSource(
  threadId: string | null | undefined,
  messages: ReadonlyArray<PlaybackSourceMessage>,
  live: boolean = true,
  recheck?: () => void,
): void {
  // State, not a ref: the bound-ness snapshot below must be recomputed once
  // the id exists.
  const [sourceId, setSourceId] = useState<number | null>(null);
  const recheckRef = useRef(recheck);
  recheckRef.current = recheck;

  useEffect(() => {
    const id = registerMessageSource();
    setSourceId(id);
    return () => {
      unregisterMessageSource(id);
    };
  }, []);

  useEffect(() => {
    if (sourceId === null) return;
    reportMessageSource(sourceId, { threadId: threadId ?? null, live, messages });
  }, [sourceId, threadId, live, messages]);

  const bound = useSyncExternalStore(
    subscribeCompactPlayback,
    () => isSourceBound(sourceId),
    () => false,
  );
  const hasRecheck = recheck !== undefined;
  useEffect(() => {
    if (!bound || !hasRecheck) return undefined;
    const timer = setInterval(() => recheckRef.current?.(), SOURCE_RECHECK_MS);
    return () => clearInterval(timer);
  }, [bound, hasRecheck]);
}
