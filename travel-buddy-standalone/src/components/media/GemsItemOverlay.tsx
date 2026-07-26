/**
 * GemsItemOverlay — full-screen overlay for a single Gems feed item.
 *
 * Layout (bottom-anchored, like Watch):
 *   ┌─────────────────────────────────┐
 *   │                                 │
 *   │         (media fills bg)        │
 *   │                                 │
 *   │  [illustrative banner if set]   │
 *   ├─────────────────── ─────────────┤  ← bottom zone
 *   │  PLACE BLOCK (dominant)         │  place name, type badge, city/area
 *   │  [View Place] [Add to Trip]     │  action chips
 *   │  [Directions]                   │
 *   │  ─────────────────────────────  │
 *   │  Creator row: avatar · name     │  secondary
 *   │  Caption (2 lines, expandable)  │
 *   └─────────────────────────────────┘
 *
 *   Right column: Like · Comment · Save · Share · ⋯ (more)
 *   "Wrong place" lives inside the more-menu sheet.
 */
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Image,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { GemsFeedItem } from '../../hooks/useGemsFeed.ts';

// ── Helper: place type display label ─────────────────────────────────────────

const PLACE_TYPE_LABEL: Record<string, string> = {
  food:       'Food & Drink',
  nightlife:  'Nightlife',
  nature:     'Nature',
  beaches:    'Beach',
  waterfalls: 'Waterfall',
  views:      'Viewpoint',
  culture:    'Cultural',
  shopping:   'Shopping',
  wellness:   'Wellness',
  drink:      'Drink',
  adventure:  'Adventure',
  local_secret: 'Local Secret',
  market:     'Market',
  viewpoint:  'Viewpoint',
  transport:  'Transport',
};

function placeTypeLabel(raw: string | null | undefined): string {
  if (!raw) return 'Place';
  return PLACE_TYPE_LABEL[raw] ?? raw;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GemsItemOverlayProps {
  item: GemsFeedItem;
  onViewPlace?: (item: GemsFeedItem) => void;
  onAddToTrip?: (item: GemsFeedItem) => void;
  onDirections?: (item: GemsFeedItem) => void;
  onFollowCreator?: (creatorId: string) => void;
  onLike?: (item: GemsFeedItem) => void;
  onComment?: (item: GemsFeedItem) => void;
  onSave?: (item: GemsFeedItem) => void;
  onShare?: (item: GemsFeedItem) => void;
  onWrongPlace?: (item: GemsFeedItem) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GemsItemOverlay({
  item,
  onViewPlace,
  onAddToTrip,
  onDirections,
  onFollowCreator,
  onLike,
  onComment,
  onSave,
  onShare,
  onWrongPlace,
}: GemsItemOverlayProps) {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [captionExpanded, setCaptionExpanded] = useState(false);

  const loc = item.location;
  const firstMedia = item.media[0] ?? null;
  const isIllustrative = firstMedia?.provenanceLabel === 'illustrative';

  const handleMorePress = useCallback(() => setMoreMenuOpen((v) => !v), []);
  const handleWrongPlace = useCallback(() => {
    setMoreMenuOpen(false);
    onWrongPlace?.(item);
  }, [item, onWrongPlace]);

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {/* ── Illustrative banner ───────────────────────────────────────────── */}
      {isIllustrative && (
        <View style={styles.illustrativeBanner}>
          <Text style={styles.illustrativeBannerText}>
            Illustrative image — not the actual location
          </Text>
        </View>
      )}

      {/* ── Bottom gradient scrim ─────────────────────────────────────────── */}
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.72)', 'rgba(0,0,0,0.92)']}
        style={styles.scrim}
        pointerEvents="none"
      />

      {/* ── Right action column ───────────────────────────────────────────── */}
      <View style={styles.actionColumn}>
        <ActionButton
          label={item.viewerState.hasLiked ? '♥' : '♡'}
          sublabel={String(item.stats.likeCount || '')}
          active={item.viewerState.hasLiked}
          onPress={() => onLike?.(item)}
          accessibilityLabel="Like"
        />
        <ActionButton
          label="💬"
          sublabel={String(item.stats.commentCount || '')}
          onPress={() => onComment?.(item)}
          accessibilityLabel="Comment"
        />
        <ActionButton
          label={item.viewerState.hasSaved ? '🔖' : '🏷'}
          sublabel={String(item.stats.saveCount || '')}
          active={item.viewerState.hasSaved}
          onPress={() => onSave?.(item)}
          accessibilityLabel="Save"
        />
        <ActionButton
          label="↑"
          onPress={() => onShare?.(item)}
          accessibilityLabel="Share"
        />
        <ActionButton
          label="⋯"
          onPress={handleMorePress}
          accessibilityLabel="More options"
        />
      </View>

      {/* ── More menu (inline sheet) ──────────────────────────────────────── */}
      {moreMenuOpen && (
        <View style={styles.moreMenu}>
          <Pressable
            style={({ pressed }) => [styles.moreMenuItem, pressed && styles.moreMenuItemPressed]}
            onPress={handleWrongPlace}
          >
            <Text style={styles.moreMenuItemText}>⚠ Wrong place</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.moreMenuItem, pressed && styles.moreMenuItemPressed]}
            onPress={() => setMoreMenuOpen(false)}
          >
            <Text style={[styles.moreMenuItemText, styles.moreMenuItemCancel]}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {/* ── Bottom content ─────────────────────────────────────────────────── */}
      <View style={styles.bottomContent}>
        {/* Place block — dominant */}
        {loc && (
          <View style={styles.placeBlock}>
            {/* Place type badge */}
            <View style={styles.placeTypeBadge}>
              <Text style={styles.placeTypeBadgeText}>{placeTypeLabel(loc.placeType)}</Text>
              {loc.isVerified && (
                <Text style={styles.verifiedDot}> ✓</Text>
              )}
            </View>

            {/* Place name */}
            <Text style={styles.placeName} numberOfLines={2}>
              {loc.name ?? 'Hidden Gem'}
            </Text>

            {/* City / area */}
            {(loc.city || loc.country) && (
              <Text style={styles.placeArea} numberOfLines={1}>
                {[loc.city, loc.country].filter(Boolean).join(', ')}
              </Text>
            )}

            {/* Action chips */}
            <View style={styles.chipRow}>
              {loc.canonicalPlaceId && (
                <Pressable
                  style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
                  onPress={() => onViewPlace?.(item)}
                  accessibilityLabel="View place"
                >
                  <Text style={styles.chipText}>View Place</Text>
                </Pressable>
              )}
              <Pressable
                style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
                onPress={() => onAddToTrip?.(item)}
                accessibilityLabel="Add to trip"
              >
                <Text style={styles.chipText}>+ Trip</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
                onPress={() => onDirections?.(item)}
                accessibilityLabel="Get directions"
              >
                <Text style={styles.chipText}>↗ Directions</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Divider */}
        <View style={styles.divider} />

        {/* Creator row */}
        <View style={styles.creatorRow}>
          {item.creator.avatarUrl ? (
            <Image
              source={{ uri: item.creator.avatarUrl }}
              style={styles.avatar}
              accessibilityLabel={`${item.creator.displayName}'s avatar`}
            />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarInitial}>
                {(item.creator.displayName || item.creator.username || '?')[0].toUpperCase()}
              </Text>
            </View>
          )}

          <View style={styles.creatorInfo}>
            <Text style={styles.creatorName} numberOfLines={1}>
              {item.creator.displayName || `@${item.creator.username}`}
            </Text>
            {item.creator.username ? (
              <Text style={styles.creatorUsername} numberOfLines={1}>
                @{item.creator.username}
              </Text>
            ) : null}
          </View>

          {!item.viewerState.isFollowingCreator && (
            <Pressable
              style={({ pressed }) => [styles.followBtn, pressed && styles.chipPressed]}
              onPress={() => onFollowCreator?.(item.creator.id)}
              accessibilityLabel={`Follow ${item.creator.displayName}`}
            >
              <Text style={styles.followBtnText}>Follow</Text>
            </Pressable>
          )}
        </View>

        {/* Caption */}
        {item.caption ? (
          <Pressable onPress={() => setCaptionExpanded((v) => !v)}>
            <Text
              style={styles.caption}
              numberOfLines={captionExpanded ? undefined : 2}
            >
              {item.caption}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// ── ActionButton ──────────────────────────────────────────────────────────────

interface ActionButtonProps {
  label: string;
  sublabel?: string;
  active?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}

function ActionButton({ label, sublabel, active, onPress, accessibilityLabel }: ActionButtonProps) {
  return (
    <Pressable
      style={({ pressed }) => [styles.actionBtn, pressed && styles.chipPressed]}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.actionBtnIcon, active && styles.actionBtnIconActive]}>
        {label}
      </Text>
      {sublabel ? (
        <Text style={styles.actionBtnSublabel}>{sublabel}</Text>
      ) : null}
    </Pressable>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const BOTTOM_SAFE = Platform.OS === 'ios' ? 34 : 16;

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  illustrativeBanner: {
    position: 'absolute',
    top: 100,
    left: space.lg,
    right: 80, // clear of right action column
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  illustrativeBannerText: {
    ...t.stamp,
    color: color.warn,
    textAlign: 'center',
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    top: '40%', // start gradient halfway down
  },
  actionColumn: {
    position: 'absolute',
    right: space.md,
    bottom: BOTTOM_SAFE + 120,
    alignItems: 'center',
    gap: space.lg,
  },
  actionBtn: {
    alignItems: 'center',
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
  },
  actionBtnIcon: {
    fontSize: 26,
    color: color.onInk,
  },
  actionBtnIconActive: {
    color: color.signal,
  },
  actionBtnSublabel: {
    ...t.stamp,
    color: color.onInkMute,
    marginTop: 2,
  },
  moreMenu: {
    position: 'absolute',
    right: space.xl + space.lg,
    bottom: BOTTOM_SAFE + 60,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    overflow: 'hidden',
    minWidth: 160,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  moreMenuItem: {
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  moreMenuItemPressed: {
    backgroundColor: color.haze,
  },
  moreMenuItemText: {
    ...t.body,
    color: color.ink,
  },
  moreMenuItemCancel: {
    color: color.mute,
  },
  bottomContent: {
    paddingHorizontal: space.lg,
    paddingBottom: BOTTOM_SAFE + space.md,
    paddingRight: 80, // clear of right action column
    gap: space.sm,
  },
  placeBlock: {
    gap: space.xs,
  },
  placeTypeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  placeTypeBadgeText: {
    ...t.stamp,
    color: color.onInk,
    textTransform: 'uppercase',
  },
  verifiedDot: {
    ...t.stamp,
    color: color.success,
  },
  placeName: {
    ...t.title,
    color: color.onInk,
    marginTop: space.xs,
  },
  placeArea: {
    ...t.small,
    color: color.onInkMute,
  },
  chipRow: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.xs,
    flexWrap: 'wrap',
  },
  chip: {
    height: 32,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.40)',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.30)',
  },
  chipText: {
    ...t.stamp,
    color: color.onInk,
  },
  chipPressed: {
    opacity: 0.72,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.15)',
    marginVertical: space.xs,
  },
  creatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  avatarFallback: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 14,
  },
  creatorInfo: {
    flex: 1,
    gap: 1,
  },
  creatorName: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 14,
  },
  creatorUsername: {
    ...t.small,
    color: color.onInkMute,
  },
  followBtn: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.onInk,
  },
  followBtnText: {
    ...t.stamp,
    color: color.onInk,
  },
  caption: {
    ...t.small,
    color: color.onInkMute,
    lineHeight: 18,
  },
});
