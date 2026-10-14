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
 * stops being able to say (`live: false`), or unmounts.
 *
 * The signal comes from here and not from the screens on purpose: the screens
 * render a filtered stream (layers, panels), the hooks hold the conversation.
 */
import { useEffect, useRef } from 'react';
import {
  registerMessageSource,
  reportMessageSource,
  unregisterMessageSource,
  type PlaybackSourceMessage,
} from './compactPlaybackStore.ts';

export function useCompactPlaybackSource(
  threadId: string | null | undefined,
  messages: ReadonlyArray<PlaybackSourceMessage>,
  live: boolean = true,
): void {
  const sourceIdRef = useRef<number | null>(null);

  useEffect(() => {
    const id = registerMessageSource();
    sourceIdRef.current = id;
    return () => {
      sourceIdRef.current = null;
      unregisterMessageSource(id);
    };
  }, []);

  useEffect(() => {
    const id = sourceIdRef.current;
    if (id === null) return;
    reportMessageSource(id, { threadId: threadId ?? null, live, messages });
  }, [threadId, live, messages]);
}
