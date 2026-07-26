/**
 * GridTile — static poster cell for the three-column Grid feed.
 *
 * Shows:
 *   - Static thumbnail / poster image (no autoplay)
 *   - Video badge (play icon) for video items
 *   - Duration (bottom-left) and qualified view count (bottom-right) when present
 *   - Content-type badge (top-left) when the item has a category
 *   - Place / area label (top-right) when available
 *   - Processing overlay (spinner + status text) for in-progress uploads
 *
 * Tapping calls onPress(item, index) — the parent decides how to navigate.
 * Memoized so FlatList recycling does not re-render unchanged cells.
 */

import React, { memo } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Video, Play, MapPin } from 'lucide-react-native';
import { DisplayMediaImage } from '../ui/DisplayMediaImage.tsx';
import type { MediaGridItem } from '../../types/media.ts';
import { color, type as t, space, radius } from '../../theme/tokens.ts';

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
}

// ── Component ─────────────────────────────────────────────────────────────────

function GridTileInner({ item, index, cellWidth, cellHeight, onPress }: GridTileProps) {
  const isVideo = item.mediaType === 'video';
  const isProcessing = item.processingStatus != null;

  const posterUri = item.posterUrl ?? item.thumbnailUrl;
  const qualifiedViews = item.qualifiedViewCount > 0 ? item.qualifiedViewCount : item.viewCount;

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
      {/* ── Poster image ────────────────────────────────────────────── */}
      <DisplayMediaImage
        uri={posterUri}
        width={cellWidth}
        height={cellHeight}
        resizeMode="cover"
        style={StyleSheet.absoluteFill}
      />

      {/* ── Processing overlay (owner's uploading items) ─────────────── */}
      {isProcessing && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="small" color={color.onInk} />
          <Text style={styles.processingText} numberOfLines={1}>
            {item.processingStatus === 'processing' ? 'Processing…' : 'Uploading…'}
          </Text>
        </View>
      )}

      {/* ── Top row: content-type badge (left) + place label (right) ─── */}
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

      {/* ── Video badge (center) ─────────────────────────────────────── */}
      {isVideo && !isProcessing && (
        <View style={styles.videoCenter} pointerEvents="none">
          <View style={styles.playBadge}>
            <Play size={14} color="#fff" fill="#fff" strokeWidth={0} />
          </View>
        </View>
      )}

      {/* ── Bottom row: duration (left) + view count (right) ─────────── */}
      <View style={styles.bottomRow} pointerEvents="none">
        {isVideo && item.durationMs != null ? (
          <Text style={styles.metaText}>{formatDuration(item.durationMs)}</Text>
        ) : null}
        {qualifiedViews > 0 ? (
          <View style={styles.viewCount}>
            <Video size={8} color={color.onInk} strokeWidth={2.5} />
            <Text style={styles.metaText}>{formatViewCount(qualifiedViews)}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export const GridTile = memo(GridTileInner);

// ── Styles ────────────────────────────────────────────────────────────────────

const SCRIM_TOP = 'rgba(0,0,0,0.30)';
const SCRIM_BOTTOM = 'rgba(0,0,0,0.48)';

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
    backgroundColor: 'rgba(0,0,0,0.45)',
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

  // ── Center video badge ──────────────────────────────────────────────
  videoCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  playBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.50)',
    alignItems: 'center',
    justifyContent: 'center',
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
    backgroundImage: undefined, // RN doesn't support gradient in StyleSheet
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
});
