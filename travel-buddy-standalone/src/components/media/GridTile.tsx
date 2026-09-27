/**
 * GridTile — grid cell for the two-column masonry Grid feed.
 *
 * Shows:
 *   - Static poster image (always present as fallback / for images)
 *   - Muted looping video autoplay when isVisible=true and item is a video
 *   - Duration (bottom-left) and qualified view count (bottom-right) when present
 *   - Content-type badge (top-left) when the item has a category
 *   - Place / area label (top-right) when available
 *   - Processing overlay (spinner + status text) for in-progress uploads
 *
 * No play-button badge is rendered — video items autoplay while in view.
 *
 * Tapping calls onPress(item, index) — the parent decides how to navigate.
 * Memoized so scroll recycling does not re-render unchanged cells.
 */

import React, { memo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Video } from 'expo-av';
import { Video as VideoIcon, MapPin } from 'lucide-react-native';
import { DisplayMediaImage } from '../ui/DisplayMediaImage.tsx';
import { useInViewAutoplay } from '../../hooks/useInViewAutoplay.ts';
import type { MediaGridItem } from '../../types/media.ts';
import { color, type as t, space, radius } from '../../theme/tokens.ts';
import { useSmartVideoFit } from '../../hooks/useSmartVideoFit.ts';
import { VideoBlurBackdrop } from '../ui/VideoBlurBackdrop.tsx';
import { VerifiedLocationStamp } from './VerifiedLocationStamp.tsx';
import { StampButton } from '../stamps/StampButton.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViewCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GridTileProps {
  item: MediaGridItem;
  index: number;
  cellWidth: number;
  cellHeight: number;
  onPress: (item: MediaGridItem, index: number) => void;
  /** True when ≥50 % of the tile is within the visible scroll viewport. */
  isVisible?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

function GridTileInner({ item, index, cellWidth, cellHeight, onPress, isVisible = false }: GridTileProps) {
  const isVideo = item.mediaType === 'video';
  const isProcessing = item.processingStatus != null;
  const hasVideoUrl = isVideo && !!item.videoUrl && !isProcessing;

  const posterUri = item.posterUrl ?? item.thumbnailUrl;
  const qualifiedViews = item.qualifiedViewCount > 0 ? item.qualifiedViewCount : item.viewCount; const [discWidth, setDiscWidth] = useState(DISC_IDLE_WIDTH); // census-media §40.14: the stamp disc's measured width

  // Video ref for imperative play/pause control
  const videoRef = useRef<InstanceType<typeof Video>>(null);
  useInViewAutoplay(videoRef, hasVideoUrl ? isVisible : false);
  const { resizeMode, needsLetterbox, onReadyForDisplay } = useSmartVideoFit(cellWidth, cellHeight);

  return (
    <Pressable
      style={[styles.cell, { width: cellWidth, height: cellHeight }]}
      onPress={() => onPress(item, index)}
      accessibilityRole="button"
      accessibilityLabel={
        isVideo
          ? `Video${item.locationLabel ? ` from ${item.locationLabel}` : ''}`
          : `Photo${item.locationLabel ? ` from ${item.locationLabel}` : ''}`
      }
    >
      {/* ── Poster image (always rendered as fallback) ───────────── */}
      <DisplayMediaImage
        uri={posterUri}
        width={cellWidth}
        height={cellHeight}
        resizeMode="cover" fallbackBg={color.mute}
        style={StyleSheet.absoluteFill}
      />

      {/* ── Muted looping video (only for video items with a URL) ── */}
      {hasVideoUrl ? (
        <>
          {needsLetterbox ? <VideoBlurBackdrop uri={posterUri} /> : null}
          <Video
            ref={videoRef}
            source={{ uri: item.videoUrl! }}
            style={StyleSheet.absoluteFill}
            resizeMode={resizeMode}
            shouldPlay={false}   // imperative control via useInViewAutoplay
            isLooping
            isMuted
            useNativeControls={false}
            onError={() => {}}   // silent — poster already visible
            onReadyForDisplay={onReadyForDisplay}
          />
        </>
      ) : null}

      {/* ── Processing overlay (owner's uploading items) ─────────── */}
      {isProcessing && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="small" color={color.onInk} />
          <Text style={styles.processingText} numberOfLines={1}>
            {item.processingStatus === 'processing' ? 'Processing…' : 'Uploading…'}
          </Text>
        </View>
      )}

      {/* ── Top row: content-type badge (left) + place label (right) */}
      <View style={styles.topRow} pointerEvents="none">
        {item.contentType ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText} numberOfLines={1}>
              {item.contentType}
            </Text>
          </View>
        ) : null}
        {item.locationLabel ? (
          <View style={[styles.badge, styles.badgeRight]}>
            <MapPin size={8} color={color.onInk} strokeWidth={2.5} />
            <Text style={styles.badgeText} numberOfLines={1}>
              {item.locationLabel}
            </Text>
          </View>
        ) : null}
      </View>

      {/* ── Verified location stamp — bottom-left overlay ────────── */}
      {item.locationVerified && item.locationLabel ? (
        <VerifiedLocationStamp
          locationName={item.locationLabel}
          style={[styles.verifiedStamp, { maxWidth: verifiedStampMaxWidth(cellWidth, discWidth) }]}
        />
      ) : null}

      {/* ── Bottom row: duration (left) + view count (right) ──────── */}
      <View style={styles.bottomRow} pointerEvents="none" testID="grid-tile-meta-row">
        {isVideo && item.durationMs != null ? (
          <Text style={styles.metaText}>{formatDuration(item.durationMs)}</Text>
        ) : null}
        {qualifiedViews > 0 ? (
          <View style={styles.viewCount}>
            <VideoIcon size={8} color={color.onInk} strokeWidth={2.5} />
            <Text style={styles.metaText}>{formatViewCount(qualifiedViews)}</Text>
          </View>
        ) : null}
      </View>

      {/* ── Stamp-it collect button — bottom-right corner ─────────── */}
      <View style={styles.stampBtnWrapper} pointerEvents="box-none" testID="grid-tile-stamp-disc" onLayout={(e) => { const w = Math.ceil(e.nativeEvent.layout.width); setDiscWidth((prev) => (prev === w ? prev : w)); }}>
        <StampButton
          entityType="media"
          entityId={item.id}
          initialCount={0}
          initialIsStamped={false}
          iconSize={16} tone="onDark"
        />
      </View>
    </Pressable>
  );
}

export const GridTile = memo(GridTileInner);

// ── Styles ────────────────────────────────────────────────────────────────────

const SCRIM_BOTTOM = 'rgba(0,0,0,0.55)'; // census-media §31.12: the least alpha at which the 9 px meta line clears 4.5:1 over a white poster; was 0.48

const styles = StyleSheet.create({
  cell: {
    overflow: 'hidden',
    backgroundColor: color.haze,
  },

  // ── Processing overlay ──────────────────────────────────────────────
  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    zIndex: 5,
  },
  processingText: {
    ...t.stamp,
    color: color.onInk,
    opacity: 0.85,
  },

  // ── Top badge row ───────────────────────────────────────────────────
  topRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    paddingTop: 4,
    zIndex: 3,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(0,0,0,0.55)', // census-media §31.12: the least alpha at which the 8 px badge text clears 4.5:1 over a white poster; was 0.45
    borderRadius: radius.sm,
    paddingHorizontal: 4,
    paddingVertical: 2,
    maxWidth: '55%',
  },
  badgeRight: {
    marginLeft: 'auto',
  },
  badgeText: {
    fontSize: 8,
    lineHeight: 10,
    fontWeight: '700',
    color: color.onInk,
    letterSpacing: 0.2,
  },

  // ── Verified location stamp ─────────────────────────────────────────
  verifiedStamp: {
    position: 'absolute',
    bottom: 28, // sit above the bottom meta row
    left: 6,
    zIndex: 4,
  },

  // ── Bottom meta row ─────────────────────────────────────────────────
  bottomRow: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    paddingBottom: 4,
    paddingTop: 12,
    zIndex: 3,
    backgroundColor: SCRIM_BOTTOM, // flat scrim fallback
  },
  viewCount: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginLeft: 'auto',
  },
  metaText: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '700',
    color: color.onInk,
    letterSpacing: 0.2,
  },

  // ── Stamp-it collect button ─────────────────────────────────────────
  stampBtnWrapper: {
    position: 'absolute',
    bottom: 28, // census-media §40: above the bottom meta row (12 + 11 + 4 = 27 tall), as verifiedStamp sits; was bottom: 4, which put the 0.80 disc over the view count
    right: 4,
    zIndex: 6, borderRadius: 999, backgroundColor: 'rgba(17,17,15,0.80)', // census-media §31.13: under the StampButton's onDark tone 0.80 is set by the stamped icon in `signal` (§31.12 had zIndex: 6, borderRadius: 999, backgroundColor: 'rgba(17,17,15,0.95)', for its idle `mute` icon)
  },
});

// census-media §40.14 — the verified-location stamp and the stamp disc share
// the band above the meta row (both at bottom 28): the stamp from the left
// (left 6), the disc from the right (right 4). The stamp is up to ~158 px wide
// (its name's maxWidth 130, its padding and border), so on a ~190 px tile a
// long place name ran under the disc. The stamp's maxWidth is now what the
// disc leaves: the tile, less the stamp's left 6, the disc's right 4, the
// disc's MEASURED width (36 idle; wider once it shows a count), and an 8 px
// gap, which also absorbs the stamp's -12° turn (about 2 px each side). The
// name, already one line, truncates earlier; nothing else about the stamp moves.
const DISC_IDLE_WIDTH = 36;
function verifiedStampMaxWidth(cellWidth: number, discWidth: number): number {
  return cellWidth - 6 - 4 - discWidth - 8;
}
