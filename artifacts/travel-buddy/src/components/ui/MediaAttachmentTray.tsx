/**
 * MediaAttachmentTray — horizontal scroll strip of picked media items.
 *
 * Each card shows:
 *   - Thumbnail (image) or video-icon overlay
 *   - Remove × button
 *   - Long-press drag handles for reorder
 *   - Cover ★ badge (when policy.supportsCover)
 *   - Alt-text input (when policy.supportsAltText)
 *   - Per-item upload progress bar
 *   - Retry button on error
 *
 * The component is stateless — all state lives in useMediaComposer.
 */
import React from 'react';
import {
  View, Text, ScrollView, Image, Pressable, TextInput,
  ActivityIndicator, StyleSheet,
} from 'react-native';
import { X, Star, RefreshCw, Video as VideoIcon, GripVertical } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { UseMediaComposerReturn, MediaItem } from '../../hooks/useMediaComposer.ts';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MediaAttachmentTrayProps {
  composer: Pick<
    UseMediaComposerReturn,
    | 'policy'
    | 'items'
    | 'removeItem'
    | 'reorderItems'
    | 'setCover'
    | 'setAltText'
    | 'retryUpload'
    | 'cancelUpload'
  >;
  /** Whether reorder handles are shown (defaults to true when supportsGallery). */
  showReorder?: boolean;
  testID?: string;
}

// ---------------------------------------------------------------------------
// Single card
// ---------------------------------------------------------------------------

function MediaCard({
  item,
  index,
  totalCount,
  showCover,
  showAltText,
  showReorder,
  onRemove,
  onMoveBefore,
  onMoveAfter,
  onCoverPress,
  onAltTextChange,
  onRetry,
}: {
  item: MediaItem;
  index: number;
  totalCount: number;
  showCover: boolean;
  showAltText: boolean;
  showReorder: boolean;
  onRemove: () => void;
  onMoveBefore: () => void;
  onMoveAfter: () => void;
  onCoverPress: () => void;
  onAltTextChange: (text: string) => void;
  onRetry: () => void;
}) {
  const isUploading = item.uploadState === 'uploading';
  const isError = item.uploadState === 'error';

  return (
    <View style={s.card} testID={`media-card-${item.id}`}>
      {/* Thumbnail */}
      <View style={s.thumbWrap}>
        <Image source={{ uri: item.uri }} style={s.thumb} resizeMode="cover" />

        {/* Video indicator */}
        {item.type === 'video' && (
          <View style={s.videoOverlay}>
            <VideoIcon size={16} color="#fff" />
          </View>
        )}

        {/* Upload progress overlay */}
        {isUploading && (
          <View style={s.uploadOverlay}>
            <ActivityIndicator size="small" color="#fff" />
            <View style={s.progressBar}>
              <View style={[s.progressFill, { width: `${Math.round(item.uploadProgress * 100)}%` }]} />
            </View>
          </View>
        )}

        {/* Error overlay */}
        {isError && (
          <View style={s.errorOverlay}>
            <Pressable style={s.retryBtn} onPress={onRetry} hitSlop={8}>
              <RefreshCw size={14} color="#fff" />
              <Text style={s.retryText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {/* Remove button */}
        <Pressable style={s.removeBtn} onPress={onRemove} hitSlop={8} testID={`remove-media-${item.id}`}>
          <X size={12} color="#fff" />
        </Pressable>

        {/* Cover star (images only; visible when policy supports covers) */}
        {showCover && (
          <Pressable
            style={[s.coverBtn, item.isCover && s.coverBtnActive]}
            onPress={onCoverPress}
            hitSlop={8}
            testID={`cover-media-${item.id}`}
            accessibilityLabel={item.isCover ? 'Cover photo' : 'Set as cover'}
          >
            <Star
              size={12}
              color={item.isCover ? '#fff' : 'rgba(255,255,255,0.6)'}
              fill={item.isCover ? '#fff' : 'none'}
            />
          </Pressable>
        )}
      </View>

      {/* Alt-text field */}
      {showAltText && (
        <TextInput
          style={s.altTextInput}
          placeholder="Alt text…"
          placeholderTextColor={color.faint}
          value={item.altText}
          onChangeText={onAltTextChange}
          maxLength={200}
          testID={`alt-text-${item.id}`}
        />
      )}

      {/* Error message */}
      {isError && item.uploadError && (
        <Text style={s.errorText} numberOfLines={2}>{item.uploadError}</Text>
      )}

      {/* Reorder handles — only shown when multiple items exist */}
      {showReorder && totalCount > 1 && (
        <View style={s.reorderRow}>
          <Pressable
            style={[s.reorderBtn, index === 0 && s.reorderBtnDisabled]}
            onPress={onMoveBefore}
            disabled={index === 0}
            hitSlop={4}
            accessibilityLabel="Move earlier"
          >
            <GripVertical size={14} color={index === 0 ? color.faint : color.mute} />
          </Pressable>
          <Pressable
            style={[s.reorderBtn, index === totalCount - 1 && s.reorderBtnDisabled]}
            onPress={onMoveAfter}
            disabled={index === totalCount - 1}
            hitSlop={4}
            accessibilityLabel="Move later"
          >
            <GripVertical size={14} color={index === totalCount - 1 ? color.faint : color.mute} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

export function MediaAttachmentTray({
  composer,
  showReorder,
  testID,
}: MediaAttachmentTrayProps) {
  const { policy, items, removeItem, reorderItems, setCover, setAltText, retryUpload } = composer;

  if (items.length === 0) return null;

  const shouldShowReorder = showReorder ?? policy.supportsGallery;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={s.tray}
      contentContainerStyle={s.trayContent}
      testID={testID ?? 'media-attachment-tray'}
    >
      {items.map((item, index) => (
        <MediaCard
          key={item.id}
          item={item}
          index={index}
          totalCount={items.length}
          showCover={policy.supportsCover}
          showAltText={policy.supportsAltText}
          showReorder={shouldShowReorder}
          onRemove={() => removeItem(item.id)}
          onMoveBefore={() => reorderItems(index, index - 1)}
          onMoveAfter={() => reorderItems(index, index + 1)}
          onCoverPress={() => setCover(item.id)}
          onAltTextChange={(text) => setAltText(item.id, text)}
          onRetry={() => retryUpload(item.id)}
        />
      ))}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const THUMB_SIZE = 80;

const s = StyleSheet.create({
  tray: {
    flexGrow: 0,
  },
  trayContent: {
    flexDirection: 'row',
    gap: space.sm,
    paddingVertical: space.xs,
  },
  card: {
    width: THUMB_SIZE,
    gap: 4,
  },
  thumbWrap: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: color.haze,
    position: 'relative',
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
  },
  videoOverlay: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 4,
    padding: 2,
  },
  uploadOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 6,
  },
  progressBar: {
    width: '90%',
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.35)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#fff',
    borderRadius: 2,
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,77,46,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  retryText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  removeBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverBtn: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverBtnActive: {
    backgroundColor: color.signal,
  },
  altTextInput: {
    width: THUMB_SIZE,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 4,
    ...t.small,
    color: color.ink,
    fontSize: 11,
    backgroundColor: color.paperRaised,
  },
  errorText: {
    width: THUMB_SIZE,
    fontSize: 10,
    color: color.signal,
    fontWeight: '600',
  },
  reorderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  reorderBtn: {
    padding: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reorderBtnDisabled: {
    opacity: 0.3,
  },
});
