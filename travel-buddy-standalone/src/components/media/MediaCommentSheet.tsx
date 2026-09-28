/**
 * MediaCommentSheet — wraps the existing CommentsSheet for media feed items.
 *
 * Media items backed by posts use the same comment endpoints as regular posts
 * (the media item ID IS the post ID). This component is a thin adapter that
 * passes the correct postId and respects the MEDIA_COMMENTS_ENABLED flag gate.
 *
 * Feature-flag gating is the caller's responsibility: render this component
 * only when MEDIA_COMMENTS_ENABLED is true (or unknown — fail-open on mobile).
 */
import React from 'react';
import { CommentsSheet } from '../CommentsSheet.tsx';
import { mediaSignalRecorder } from '../../services/mediaInteractions.ts';
import { emitMediaSignal } from '../../features/media/telemetry/mediaTelemetry.ts';

interface MediaCommentSheetProps {
  /** Media item (post) ID. */
  mediaId: string | null;
  visible: boolean;
  onClose: () => void;
  /** Called with the new total comment count whenever it changes (e.g. after posting). */
  onCountChange?: (count: number) => void;
}

/**
 * Thin adapter: maps the media item ID to CommentsSheet's postId prop.
 * When `mediaId` is null the sheet is not rendered.
 */
export function MediaCommentSheet({ mediaId, visible, onClose, onCountChange }: MediaCommentSheetProps) {
  if (!mediaId) return null;
  return (
    <CommentsSheet
      visible={visible}
      postId={mediaId}
      onClose={onClose}
      onCountChange={onCountChange ?? (() => {})}
      // §44 Comment (census-media §21) — a media surface, a comment the server accepted.
      onCommentPosted={() => emitMediaSignal(mediaSignalRecorder, 'comment', { mediaId, surface: 'media_comments' })}
    />
  );
}
