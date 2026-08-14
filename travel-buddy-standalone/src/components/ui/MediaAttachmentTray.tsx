/**
 * MediaAttachmentTray — horizontal scroll strip of picked media items.
 *
 * Each card shows:
 *   - Thumbnail (image) or video-icon overlay
 *   - Remove × button
 *   - Long-press drag to reorder (or tap-based buttons when reduce-motion is on)
 *   - Cover ★ badge (when policy.supportsCover)
 *   - Alt-text input (when policy.supportsAltText)
 *   - Per-item upload progress bar
 *   - Retry button on error
 *
 * The component is stateless — all state lives in useMediaComposer.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Image, Pressable, TextInput,
  ActivityIndicator, StyleSheet, AccessibilityInfo,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { X, Star, RefreshCw, Video as VideoIcon, GripVertical } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../theme/tokens.ts';
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
// Constants (declared early — referenced by DraggableMediaCard and styles)
// ---------------------------------------------------------------------------

const THUMB_SIZE = 80;
/** Width of one card slot (thumbnail + gap) used to compute drag target index. */
const CARD_STEP = THUMB_SIZE + space.sm;

// ---------------------------------------------------------------------------
// Reduce-motion hook
// ---------------------------------------------------------------------------

function useIsReduceMotionEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (alive) setEnabled(v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
      if (alive) setEnabled(v);
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return enabled;
}

// ---------------------------------------------------------------------------
// Card content (shared between tap-based and drag-based rendering)
// ---------------------------------------------------------------------------

function MediaCardContent({
  item,
  showCover,
  showAltText,
  onRemove,
  onCoverPress,
  onAltTextChange,
  onRetry,
  dragActive,
}: {
  item: MediaItem;
  showCover: boolean;
  showAltText: boolean;
  onRemove: () => void;
  onCoverPress: () => void;
  onAltTextChange: (text: string) => void;
  onRetry: () => void;
  dragActive: boolean;
}) {
  const isUploading = item.uploadState === 'uploading';
  const isError = item.uploadState === 'error';
  const isFormatError = isError && item.uploadErrorKind === 'format_unsupported';

  return (
    <>
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
            {isFormatError ? (
              /* Format errors can't be retried — the file will always fail.
                 Guide the user to remove and pick a different file. */
              <Pressable
                style={s.retryBtn}
                onPress={onRemove}
                hitSlop={8}
                accessibilityLabel="Remove unsupported file"
              >
                <X size={14} color="#fff" />
                <Text style={s.retryText}>Remove</Text>
              </Pressable>
            ) : (
              <Pressable style={s.retryBtn} onPress={onRetry} hitSlop={8} testID={`retry-media-${item.id}`}>
                <RefreshCw size={14} color="#fff" />
                <Text style={s.retryText}>Retry</Text>
              </Pressable>
            )}
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

        {/* Drag active: grip icon overlay */}
        {dragActive && (
          <View style={s.gripOverlay} pointerEvents="none">
            <GripVertical size={20} color="#fff" />
          </View>
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Tap-based reorder card (reduce-motion fallback)
// ---------------------------------------------------------------------------

function TapMediaCard({
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
  return (
    <View style={s.card} testID={`media-card-${item.id}`}>
      <MediaCardContent
        item={item}
        showCover={showCover}
        showAltText={showAltText}
        onRemove={onRemove}
        onCoverPress={onCoverPress}
        onAltTextChange={onAltTextChange}
        onRetry={onRetry}
        dragActive={false}
      />

      {/* Tap-based reorder handles — only shown when multiple items exist */}
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
// Drag-based card (when reduce-motion is off)
// ---------------------------------------------------------------------------

interface DragSharedState {
  fromIndex: SharedValue<number>;
  offsetX: SharedValue<number>;
}

function DraggableMediaCard({
  item,
  index,
  totalCount,
  showCover,
  showAltText,
  drag,
  activeIndex,
  onRemove,
  onCoverPress,
  onAltTextChange,
  onRetry,
  onDragStart,
  onDragEnd,
}: {
  item: MediaItem;
  index: number;
  totalCount: number;
  showCover: boolean;
  showAltText: boolean;
  drag: DragSharedState;
  activeIndex: number;
  onRemove: () => void;
  onCoverPress: () => void;
  onAltTextChange: (text: string) => void;
  onRetry: () => void;
  onDragStart: (fromIndex: number) => void;
  onDragEnd: (fromIndex: number, toIndex: number) => void;
}) {
  const isActive = activeIndex === index;

  const animStyle = useAnimatedStyle(() => {
    if (drag.fromIndex.value === index) {
      return {
        transform: [{ translateX: drag.offsetX.value }],
        zIndex: 10,
        opacity: 0.9,
      };
    }
    return { transform: [{ translateX: 0 }], zIndex: 1, opacity: 1 };
  });

  const gesture = Gesture.Simultaneous(
    Gesture.LongPress()
      .minDuration(400)
      .onStart(() => {
        'worklet';
        drag.fromIndex.value = index;
        drag.offsetX.value = 0;
        runOnJS(onDragStart)(index);
      }),
    Gesture.Pan()
      .onUpdate((e) => {
        'worklet';
        if (drag.fromIndex.value >= 0) {
          drag.offsetX.value = e.translationX;
        }
      })
      .onEnd(() => {
        'worklet';
        const from = drag.fromIndex.value;
        if (from >= 0) {
          const steps = Math.round(drag.offsetX.value / CARD_STEP);
          const to = Math.max(0, Math.min(totalCount - 1, from + steps));
          drag.fromIndex.value = -1;
          drag.offsetX.value = withSpring(0, { duration: 200 });
          runOnJS(onDragEnd)(from, to);
        }
      })
      .onFinalize(() => {
        'worklet';
        // Ensure state is reset even if gesture is cancelled
        if (drag.fromIndex.value >= 0) {
          drag.fromIndex.value = -1;
          drag.offsetX.value = 0;
        }
      }),
  );

  // With only one item there is nothing to reorder. Skip the GestureDetector
  // entirely so the long-press never fires and the grip overlay never appears.
  // This also prevents the gesture from intercepting scroll in parent views.
  if (totalCount === 1) {
    return (
      <Animated.View style={[s.card, animStyle]} testID={`media-card-${item.id}`}>
        <MediaCardContent
          item={item}
          showCover={showCover}
          showAltText={showAltText}
          onRemove={onRemove}
          onCoverPress={onCoverPress}
          onAltTextChange={onAltTextChange}
          onRetry={onRetry}
          dragActive={false}
        />
      </Animated.View>
    );
  }

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[s.card, animStyle]} testID={`media-card-${item.id}`}>
        <MediaCardContent
          item={item}
          showCover={showCover}
          showAltText={showAltText}
          onRemove={onRemove}
          onCoverPress={onCoverPress}
          onAltTextChange={onAltTextChange}
          onRetry={onRetry}
          dragActive={isActive}
        />
      </Animated.View>
    </GestureDetector>
  );
}

// ---------------------------------------------------------------------------
// Draggable tray (reduce-motion off)
// ---------------------------------------------------------------------------

function DraggableTray({
  items,
  policy,
  removeItem,
  reorderItems,
  setCover,
  setAltText,
  retryUpload,
  testID,
}: {
  items: MediaItem[];
  policy: UseMediaComposerReturn['policy'];
  removeItem: (id: string) => void;
  reorderItems: (from: number, to: number) => void;
  setCover: (id: string) => void;
  setAltText: (id: string, text: string) => void;
  retryUpload: (id: string) => void;
  testID?: string;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Shared values for gesture tracking (stable across renders)
  const fromIndex = useSharedValue(-1);
  const offsetX = useSharedValue(0);
  const drag: DragSharedState = { fromIndex, offsetX };

  const handleDragStart = (idx: number) => {
    setActiveIndex(idx);
    // Disable scroll during drag by scrolling to current position
    scrollRef.current?.scrollTo({ animated: false });
  };

  const handleDragEnd = (from: number, to: number) => {
    setActiveIndex(-1);
    if (from !== to) {
      reorderItems(from, to);
    }
  };

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={s.tray}
      contentContainerStyle={s.trayContent}
      scrollEnabled={activeIndex < 0}
      testID={testID ?? 'media-attachment-tray'}
    >
      {items.map((item, index) => (
        <DraggableMediaCard
          key={item.id}
          item={item}
          index={index}
          totalCount={items.length}
          showCover={policy.supportsCover}
          showAltText={policy.supportsAltText}
          drag={drag}
          activeIndex={activeIndex}
          onRemove={() => removeItem(item.id)}
          onCoverPress={() => setCover(item.id)}
          onAltTextChange={(text) => setAltText(item.id, text)}
          onRetry={() => retryUpload(item.id)}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        />
      ))}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Tray (public)
// ---------------------------------------------------------------------------

export function MediaAttachmentTray({
  composer,
  showReorder,
  testID,
}: MediaAttachmentTrayProps) {
  const { policy, items, removeItem, reorderItems, setCover, setAltText, retryUpload } = composer;
  const reduceMotion = useIsReduceMotionEnabled();

  if (items.length === 0) return null;

  const shouldShowReorder = showReorder ?? policy.supportsGallery;

  // Reduce-motion: fall back to tap-based buttons
  if (reduceMotion) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.tray}
        contentContainerStyle={s.trayContent}
        testID={testID ?? 'media-attachment-tray'}
      >
        {items.map((item, index) => (
          <TapMediaCard
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

  // Default: drag-to-reorder
  return (
    <DraggableTray
      items={items}
      policy={policy}
      removeItem={removeItem}
      reorderItems={reorderItems}
      setCover={setCover}
      setAltText={setAltText}
      retryUpload={retryUpload}
      testID={testID}
    />
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

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
    width: icon.s20, height: icon.s20,
    borderRadius: icon.s20 / 2,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverBtn: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: icon.s20, height: icon.s20,
    borderRadius: icon.s20 / 2,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverBtnActive: {
    backgroundColor: color.signal,
  },
  gripOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
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
