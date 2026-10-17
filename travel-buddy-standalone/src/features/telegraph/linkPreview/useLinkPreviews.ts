/**
 * census-telegraph T404 — the conversation's link previews, behind the server's
 * own flag.
 *
 * OFF ⇒ NOTHING. While `enabled` is false (the flag `telegraph_link_previews_enabled`
 * is off — it is seeded FALSE — or the conversation is in a raised safety mode,
 * or data saver sheds previews: owner question Q-LP6, "suppressed on the
 * client"), this hook makes no request of either door and `previewFor` answers
 * null for every message, so no preview can be drawn. Turning it off again
 * forgets every preview it held.
 *
 * ON:
 *   - readers ask the GET door for the plain-text messages on screen that carry
 *     an https link — in batches of the door's cap, each message once per body
 *     (an edit is asked again: the server serves a preview only beside the body
 *     it was made from);
 *   - the SENDER's device, when the server confirms a message it just sent
 *     (`deliveryStatus: 'sent'` — set only on this device's own sends, never on
 *     a loaded message), asks the POST door for that message once and draws
 *     what it answers. No URL leaves the device in either request.
 *
 * A failed read is not "no preview": nothing is recorded as asked, so the next
 * change of the message list asks again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchLinkPreviews,
  mayHaveLink,
  requestLinkPreview,
  LINK_PREVIEW_BATCH_MAX,
  type LinkPreview,
} from './linkPreviewApi.ts';

export interface PreviewableMessage {
  id: string;
  body?: string | null;
  msgType?: string | null;
  subtype?: string | null;
  deleted?: boolean | null;
  editedAt?: string | null;
  ciphertext?: string | null;
  deliveryStatus?: 'sending' | 'sent' | 'failed';
}

/** A message the server could hold a preview for: plain text, live, not end-to-end encrypted, on the server. */
export function isPreviewCandidate(m: PreviewableMessage): boolean {
  if (m.msgType !== 'text' || (m.subtype !== null && m.subtype !== undefined)) return false;
  if (m.deleted === true || m.ciphertext) return false;
  if (m.deliveryStatus === 'sending' || m.deliveryStatus === 'failed') return false;
  return mayHaveLink(m.body);
}

const askedKey = (m: PreviewableMessage) => `${m.id}:${m.editedAt ?? ''}`;

export interface LinkPreviews {
  previewFor: (messageId: string) => LinkPreview | null;
}

export function useLinkPreviews(
  threadId: string | null,
  messages: readonly PreviewableMessage[],
  enabled: boolean,
): LinkPreviews {
  const [byMessage, setByMessage] = useState<Record<string, LinkPreview>>({});
  const asked = useRef(new Set<string>());
  const requested = useRef(new Set<string>());

  useEffect(() => {
    // A different thread, or turned off: forget everything.
    asked.current = new Set();
    requested.current = new Set();
    setByMessage({});
  }, [threadId, enabled]);

  // The sender's door: once per message this device just sent, when the server confirmed it.
  useEffect(() => {
    if (!enabled || !threadId) return undefined;
    const justSent = messages.filter((m) => m.deliveryStatus === 'sent' && isPreviewCandidate(m) && !requested.current.has(m.id));
    if (justSent.length === 0) return undefined;
    let cancelled = false;
    for (const m of justSent) {
      requested.current.add(m.id);
      void requestLinkPreview(threadId, m.id).then((r) => {
        if (cancelled || !r.ok || r.data.kind !== 'preview') return;
        const preview = r.data.preview;
        setByMessage((prev) => ({ ...prev, [preview.messageId]: preview }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [threadId, enabled, messages]);

  useEffect(() => {
    if (!enabled || !threadId) return undefined;
    // A message this device is asking the POST door about is not also read from the GET.
    const want = messages.filter((m) => isPreviewCandidate(m) && !requested.current.has(m.id) && !asked.current.has(askedKey(m)));
    if (want.length === 0) return undefined;
    let cancelled = false;
    for (const m of want) asked.current.add(askedKey(m));
    void (async () => {
      for (let i = 0; i < want.length; i += LINK_PREVIEW_BATCH_MAX) {
        const chunk = want.slice(i, i + LINK_PREVIEW_BATCH_MAX);
        const r = await fetchLinkPreviews(threadId, chunk.map((m) => m.id));
        if (cancelled) return;
        if (!r.ok) {
          for (const m of chunk) asked.current.delete(askedKey(m)); // not "no preview": ask again later
          continue;
        }
        if (r.data.length === 0) continue;
        setByMessage((prev) => {
          const next = { ...prev };
          for (const p of r.data) next[p.messageId] = p;
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, enabled, messages]);

  const previewFor = useCallback(
    (messageId: string): LinkPreview | null => (enabled ? byMessage[messageId] ?? null : null),
    [enabled, byMessage],
  );

  return { previewFor };
}
