/**
 * The stored preview of one message, read through the shared, batching store
 * (`linkPreviewStore.ts`). Pass `null` and the hook does nothing at all — no
 * registration, no read — which is how every gate (flag OFF, E2EE, safety mode,
 * data saver, a message without a link) makes NO request.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { linkPreviewStore } from './linkPreviewApi.ts';
import type { WirePreview } from './linkPreviewRules.ts';
import type { LinkPreviewStore } from './linkPreviewStore.ts';

export interface LinkPreviewTarget {
  viewerId: string;
  threadId: string;
  messageId: string;
  /** The body version (`editedAt`, or '' for a never-edited message). */
  version: string;
  /** When the body was written, ms (decides the single re-ask of a young miss). */
  writtenAt: number;
}

export function useLinkPreview(target: LinkPreviewTarget | null, store: LinkPreviewStore = linkPreviewStore): WirePreview | null {
  const viewerId = target?.viewerId ?? null;
  const threadId = target?.threadId ?? null;
  const messageId = target?.messageId ?? null;
  const version = target?.version ?? '';
  const writtenAt = target?.writtenAt ?? NaN;

  const entry = useSyncExternalStore(
    store.subscribe,
    () => (threadId && messageId ? store.get(threadId, messageId, version) : undefined),
    () => undefined,
  );

  useEffect(() => {
    if (!viewerId || !threadId || !messageId) return;
    store.setViewer(viewerId);
    store.want(threadId, messageId, version, writtenAt);
  }, [store, viewerId, threadId, messageId, version, writtenAt]);

  return target && entry?.state === 'ready' ? entry.preview : null;
}
