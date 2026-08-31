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
  Platform,
} from 'react-native';
import { Avatar } from '../ui/Avatar.tsx';
import { LinearGradient } from 'expo-linear-gradient';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { GemsFeedItem } from '../../hooks/useGemsFeed.ts';
import { PlaceQuickActions } from '../PlaceQuickActions.tsx';
import { StampButton } from '../stamps/StampButton.tsx';
import { GemStateBadge } from '../gems/GemStateBadge.tsx';

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
  /** Omit to disable comment action for non-post-backed items (e.g. gems). */
  onComment?: (item: GemsFeedItem) => void;
  onSave?: (item: GemsFeedItem) => void;
  onShare?: (item: GemsFeedItem) => void;
  onWrongPlace?: (item: GemsFeedItem) => void;
  /**
   * When provided, tapping ⋯ calls this instead of opening the legacy inline mini-menu.
   * Use this to delegate to a unified MediaMoreMenu (recommended for all new surfaces).
   */
  onMore?: (item: GemsFeedItem) => void;
  /** Optimistic saved state from useMediaSave — overrides item.viewerState.hasSaved when provided. */
  isSaved?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GemsItemOverlay({
  item,
  onViewPlace,
  onAddToTrip,
  onDirections,
  onFollowCreator,
  onComment,
  onSave,
  onShare,
  onWrongPlace,
  onMore,
  isSaved,
}: GemsItemOverlayProps) {
  // Legacy inline mini-menu — only used when onMore is not provided.
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [captionExpanded, setCaptionExpanded] = useState(false);

  const loc = item.location;
  const firstMedia = item.media[0] ?? null;
  const isIllustrative = firstMedia?.provenanceLabel === 'illustrative';

  // When onMore is provided (e.g. GemsFeed wires MediaMoreMenu), delegate to it.
  // Otherwise fall back to the legacy inline mini-menu.
  const handleMorePress = useCallback(() => {
    if (onMore) {
      onMore(item);
    } else {
      setMoreMenuOpen((v) => !v);
    }
  }, [item, onMore]);

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
        <StampButton
          entityType="gem"
          entityId={item.id}
          initialCount={item.stats.likeCount ?? 0}
          initialIsStamped={item.viewerState?.hasLiked ?? false}
          iconSize={24}
          style={styles.stampBtnWrapper}
        />
        {/* Comments are disabled for gem items (not post-backed); only shown when onComment is wired. */}
        {onComment && (
          <ActionButton
            label="💬"
            sublabel={String(item.stats.commentCount || '')}
            onPress={() => onComment(item)}
            accessibilityLabel="Comment"
          />
        )}
        <ActionButton
          label={(isSaved ?? item.viewerState.hasSaved) ? '🔖' : '🏷'}
          sublabel={String(item.stats.saveCount || '')}
          active={isSaved ?? item.viewerState.hasSaved}
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

            {/* §16 / §46.1 — calm gem-state pill + confidence. Renders nothing
                when the item carries no gemState (degrade to today's layout). */}
            <GemStateBadge
              state={item.gemState}
              confidence={item.gemConfidence}
              showConfidence
              style={styles.gemStateBadge}
            />

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
            </View>
            {/* Quick actions: + Trip, + Event, Navigate */}
            <PlaceQuickActions
              place={{
                id: loc.canonicalPlaceId ?? undefined,
                name: loc.name ?? 'Place',
                city: loc.city ?? null,
                lat: loc.lat ?? null,
                lng: loc.lng ?? null,
              }}
              sourceId={item.id}
              variant="dark"
            />
          </View>
        )}

        {/* Divider */}
        <View style={styles.divider} />

        {/* Creator row — falls back to a generic label if the profile join
            failed to resolve (both displayName and username come back empty),
            so attribution is never silently blank. */}
        <View style={styles.creatorRow}>
          <Avatar
            uri={item.creator.avatarUrl}
            name={item.creator.displayName || item.creator.username}
            size={36}
            style={styles.avatarRing}
            accessibilityLabel={`${item.creator.displayName || 'Traveler'}'s avatar`}
          />

          <View style={styles.creatorInfo}>
            <Text style={styles.creatorName} numberOfLines={1}>
              {item.creator.displayName || (item.creator.username ? `@${item.creator.username}` : 'Traveler')}
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
  stampBtnWrapper: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
  gemStateBadge: {
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
  // Sizing/shape come from <Avatar size>; this is the contrast ring only.
  avatarRing: {
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.5)',
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
