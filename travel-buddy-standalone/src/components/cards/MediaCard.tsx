/**
 * MediaCard — shared card for media grid/list surfaces.
 * Thumbnail, duration/type badge, creator info.
 */
import React, { useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { PlayCircle, Image as ImageIcon } from 'lucide-react-native';
import { CachedImage } from '../CachedImage.tsx';
import { color, space, radius, shadow, typography, layout } from '../../theme/tokens.ts';

export interface MediaCardProps {
  id: string;
  thumbnailUrl?: string | null;
  mediaType?: 'image' | 'video' | null;
  durationSeconds?: number | null;
  creatorName?: string | null;
  creatorHandle?: string | null;
  title?: string | null;
  onPress: () => void;
  onLongPress?: () => void;
  /** Hide the built-in type/duration badge — use when the caller renders its own overlay badge. */
  hideBadge?: boolean;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function MediaCard({
  thumbnailUrl, mediaType, durationSeconds, creatorName, creatorHandle, title, onPress, onLongPress, hideBadge,
}: MediaCardProps) {
  const [imgFailed, setImgFailed] = useState(false);

  // Clear the failure latch whenever `thumbnailUrl` changes.
  //
  // THIS IS THE BLANK-TILE BUG. post-media is a private bucket, so callers hand
  // us a bare `post-media/<uid>/<file>` path on the first render and swap in the
  // signed URL a network round-trip later. That first source ALWAYS fails —
  // an unsigned private-bucket path returns HTTP 400 — CachedImage forwards
  // onError, we latch imgFailed, and line ~48 then unmounts CachedImage
  // entirely. When the signed URL finally arrives there is no CachedImage left
  // to receive it and no reset here, so the tile stays blank forever even
  // though hydration succeeded.
  //
  // CachedImage already carries exactly this fix (see its prevUri resync and
  // the guard test in __tests__/CachedImage.uriResync.component.test.tsx). It
  // was applied to that layer only — MediaCard latches independently, one level
  // up, and kept the defect. Same pattern, deliberately: resync in render so
  // the reset lands in the SAME commit as the new URL rather than one render
  // later, which would re-latch off the stale URI.
  const prevThumbnailUrl = useRef(thumbnailUrl);
  if (prevThumbnailUrl.current !== thumbnailUrl) {
    prevThumbnailUrl.current = thumbnailUrl;
    setImgFailed(false);
  }

  const isVideo = mediaType === 'video';
  const creator = creatorHandle ? `@${creatorHandle}` : creatorName ?? null;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={title ?? (isVideo ? 'Video' : 'Image')}
    >
      {/* Thumbnail */}
      <View style={styles.thumbWrap}>
        {thumbnailUrl && !imgFailed ? (
          <CachedImage
            source={{ uri: thumbnailUrl }}
            style={styles.thumb}
            resizeMode="cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]}>
            {isVideo
              ? <PlayCircle size={28} color={color.onInkMute} />
              : <ImageIcon size={28} color={color.onInkMute} />
            }
          </View>
        )}

        {/* Type + duration badge */}
        {!hideBadge && (
          <View style={styles.typeBadge}>
            {isVideo ? <PlayCircle size={10} color="#fff" /> : null}
            <Text style={styles.typeBadgeText}>
              {isVideo && durationSeconds != null
                ? formatDuration(durationSeconds)
                : isVideo ? 'Video' : 'Photo'}
            </Text>
          </View>
        )}
      </View>

      {/* Info */}
      {(title || creator) ? (
        <View style={styles.info}>
          {title ? (
            <Text style={styles.title} numberOfLines={1}>{title}</Text>
          ) : null}
          {creator ? (
            <Text style={styles.creator} numberOfLines={1}>{creator}</Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    overflow: 'hidden',
    ...shadow.card,
    marginBottom: space.sm,
    borderWidth: 1,
    borderColor: color.haze,
  },
  thumbWrap: {
    position: 'relative',
  },
  thumb: {
    width: '100%',
    height: 120,
  },
  thumbFallback: {
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeBadge: {
    position: 'absolute',
    bottom: space.xs,
    right: space.xs,
    backgroundColor: 'rgba(17,17,15,0.72)',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  typeBadgeText: {
    ...typography.metadata,
    color: '#fff',
  },
  info: {
    padding: space.sm,
    gap: 2,
  },
  title: {
    ...typography.label,
    color: color.ink,
  },
  creator: {
    ...typography.caption,
    color: color.mute,
  },
});
