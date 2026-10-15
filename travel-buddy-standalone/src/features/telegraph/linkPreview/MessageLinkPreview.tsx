/**
 * MessageLinkPreview — the one place a message bubble gets a link preview
 * (census-telegraph T404 / T446, B58 TM-2). Mounted by the thread screen's
 * `MessageBubble` (`app/messages/[id].tsx`: direct and group threads) and the
 * trip/circle chat's `GroupMessageBubble` (`components/GroupChatScreen.tsx`).
 *
 * IT DRAWS AND ASKS NOTHING unless every gate is open:
 *   - the server's flag `telegraph_link_previews_enabled` is ON (seeded FALSE;
 *     migration 3825 applied nowhere yet) — read from the flags the app already
 *     fetched, so an OFF flag costs no request at all;
 *   - the screen allows it (`enabled`): not in a raised safety mode, not shed by
 *     data saver or a constrained connection (Q-LP6), and — on the thread
 *     screen — the server has affirmatively said the thread is NOT end-to-end
 *     encrypted (Q-LP3; unknown counts as encrypted);
 *   - the message itself may have one (`messageMayHavePreview`): a stored,
 *     live, plain text message with a link that carries no ciphertext;
 *   - a signed-in viewer and a thread are known.
 * Then it reads the STORED preview from our API (message id only) and draws
 * its text. The recipient's device never contacts the linked site.
 */
import React from 'react';
import { useFeatureFlags } from '../../../context/FeatureFlagsContext.tsx';
import { ExternalUrlPreview } from './ExternalUrlPreview.tsx';
import {
  LINK_PREVIEW_FLAG,
  bodyVersion,
  bodyWrittenAtMs,
  messageMayHavePreview,
  type PreviewableMessage,
} from './linkPreviewRules.ts';
import { useLinkPreview, type LinkPreviewTarget } from './useLinkPreviews.ts';

export interface MessageLinkPreviewProps {
  threadId: string | null | undefined;
  message: PreviewableMessage;
  viewerId: string | null | undefined;
  /** The screen's gate: safety mode, data saver, the thread's E2EE answer. Absent ⇒ off. */
  enabled?: boolean;
}

export function MessageLinkPreview({ threadId, message, viewerId, enabled = false }: MessageLinkPreviewProps) {
  const flagOn = useFeatureFlags().isEnabled(LINK_PREVIEW_FLAG);
  const active = enabled === true && flagOn && !!threadId && !!viewerId && messageMayHavePreview(message);
  const target: LinkPreviewTarget | null = active
    ? {
        viewerId: viewerId as string,
        threadId: threadId as string,
        messageId: message.id,
        version: bodyVersion(message),
        writtenAt: bodyWrittenAtMs(message),
      }
    : null;
  const preview = useLinkPreview(target);
  if (!active || !preview || preview.messageId !== message.id) return null;
  return <ExternalUrlPreview preview={preview} mine={!!message.senderId && message.senderId === viewerId} />;
}
