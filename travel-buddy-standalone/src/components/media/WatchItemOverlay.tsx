/**
 * WatchItemOverlay — full-screen overlay drawn on top of WatchVideoCell.
 *
 * Left column (bottom-left):
 *   - Creator avatar → profile, display name → profile, username → profile
 *   - Follow / Request button
 *   - Caption with "Show more" expand toggle
 *   - Hashtags
 *   - Place chip (→ place screen)
 *   - Take Me Here chip (→ AddToPlan) — shown when item.place is populated
 *   - Linked entity chip (event / trip / place / plan)
 *   - Audio label row
 *
 * Right column (bottom-right):
 *   - Stamp button + count (ink overlay appears centered over the video frame)
 *   - Comment button + count
 *   - Save button + count
 *   - Share button
 *   - More (ellipsis) button
 *
 * Cinematic gradient scrim behind the content for readability.
 */

import React, { useState, useCallback } from 'react';
import Animated from 'react-native-reanimated';
import {
  View,
  Text,
  Pressable,
  Platform,
  StyleSheet,
  Image,
  Share,
  Alert,
  Dimensions,
} from 'react-native';
import { recordMediaShare } from '../../services/mediaInteractions.ts';
import { ShareSheet } from '../ShareSheet.tsx';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  MessageCircle,
  Bookmark,
  Share2,
  Send,
  MoreVertical,
  Music2,
  MapPin,
  Tag,
  UserPlus,
  UserCheck,
  Calendar,
  Map,
  Compass,
  Camera,
  Zap,
} from 'lucide-react-native';
import { color, space, type as t, radius } from '../../theme/tokens.ts';
import { VerifiedStamp } from '../ui/VerifiedStamp.tsx';
import { FeaturedBadge } from '../FeaturedBadge.tsx';
import { useFollow } from '../../hooks/useFollow.ts';
import type { MediaFeedItem } from '../../types/media.ts';
import { StampIcon } from '../stamps/StampIcon.tsx';
import { VerifiedLocationStamp } from './VerifiedLocationStamp.tsx';
import { PlaceQuickActions } from '../PlaceQuickActions.tsx';

const { width: SCREEN_W } = Dimensions.get('window');

// ── Entity icon helper ────────────────────────────────────────────────────────

function entityIcon(kind: string) {
  const sz = 12;
  const col = 'rgba(255,255,255,0.9)';
  switch (kind) {
    case 'event':  return <Calendar size={sz} color={col} />;
    case 'trip':   return <Map size={sz} color={col} />;
    case 'plan':   return <Compass size={sz} color={col} />;
    case 'place':  return <MapPin size={sz} color={col} />;
    default:       return <Tag size={sz} color={col} />;
  }
}

// ── Follow button ─────────────────────────────────────────────────────────────

function FollowButton({ userId, currentUserId }: { userId: string; currentUserId?: string }) {
  const { isFollowing, loading, toggling, toggle } = useFollow(userId);

  if (!currentUserId || userId === currentUserId) return null;

  return (
    <Pressable
      onPress={toggle}
      disabled={loading || toggling}
      style={[s.followBtn, isFollowing && s.followBtnActive]}
      accessibilityRole="button"
      accessibilityLabel={isFollowing ? 'Unfollow' : 'Follow'}
      hitSlop={6}
    >
      {isFollowing
        ? <UserCheck size={12} color={color.onInk} />
        : <UserPlus size={12} color={color.onInk} />}
      <Text style={s.followBtnText}>{isFollowing ? 'Following' : 'Follow'}</Text>
    </Pressable>
  );
}

// ── Count formatter ───────────────────────────────────────────────────────────

function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

// ── Action button ─────────────────────────────────────────────────────────────

interface ActionBtnProps {
  icon: React.ReactNode;
  count?: number;
  onPress: () => void;
  onLongPress?: () => void;
  active?: boolean;
  activeColor?: string;
  label: string;
}

function ActionBtn({ icon, count, onPress, onLongPress, label }: ActionBtnProps) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={500}
      style={s.actionBtn}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
    >
      {icon}
      {count !== undefined && count > 0 ? (
        <Text style={s.actionCount}>{fmtCount(count)}</Text>
      ) : null}
    </Pressable>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface WatchItemOverlayProps {
  item: MediaFeedItem;
  currentUserId?: string;
  isSaved: boolean;
  onComment: () => void;
  onSave: () => void;
  onMore: () => void;
  /** When true, the create button routes to /media/add-gem and shows "Add a Gem" label. */
  isGemsMode?: boolean;
  /**
   * Stamp state + handlers — owned by the CellWrapper's useWatchStamp() so
   * the rail button and the double-tap-on-content gesture share ONE source
   * of truth instead of racing each other. See useWatchStamp.ts.
   */
  stampGroupRef: React.RefObject<View | null>;
  stampVisualIsStamped: boolean;
  stampVisualCount: number;
  stampButtonStyle: unknown;
  onStampPress: () => void;
}

// ── Main component ────────────────────────────────────────────────────────────

export function WatchItemOverlay({
  item,
  currentUserId,
  isSaved,
  onComment,
  onSave,
  onMore,
  isGemsMode = false,
  stampGroupRef,
  stampVisualIsStamped,
  stampVisualCount,
  stampButtonStyle,
  onStampPress,
}: WatchItemOverlayProps) {
  const insets = useSafeAreaInsets();
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [sendSheetVisible, setSendSheetVisible] = useState(false);

  const handleCreate = useCallback(() => {
    if (isGemsMode) {
      router.push('/media/add-gem' as any);
    } else {
      router.push('/create');
    }
  }, [isGemsMode]);

  const handleShare = useCallback(async () => {
    // Point the share sheet at an actual image/frame (video thumbnail, or the
    // still image for photo posts) so the native preview shows real content
    // instead of falling back to a generic app-icon placeholder.
    const previewUrl = item.posterUrl || item.videoUrl || null;
    const message = item.caption || 'Check this out on Travel Buddy!';
    try {
      await Share.share(
        Platform.OS === 'ios'
          ? { message, url: previewUrl ?? undefined }
          : { message: previewUrl ? `${message}\n${previewUrl}` : message },
      );
      // Record share event in background — never block on this
      recordMediaShare(item.id, 'native').catch(() => {});
    } catch {
      // User dismissed — no share event recorded
    }
  }, [item.id, item.caption, item.posterUrl, item.videoUrl]);

  // Defensive fallback: if the profile join for this post's author fails to
  // resolve (schema drift / missing row), displayName and username both come
  // back as "" and the creator row silently renders nothing — indistinguishable
  // from "no attribution at all". Always show something rather than blank text.
  const creatorDisplayName = item.creator.displayName || item.creator.username || 'Traveler';
  const creatorUsername = item.creator.username || '';

  const goProfile = useCallback(() => {
    // Profile route is username-based: /u/[username]
    if (!item.creator.username) return;
    router.push(`/u/${item.creator.username}` as any);
  }, [item.creator.username]);

  const goPlace = useCallback(() => {
    // Only navigate when a canonical place ID is available; location-label-only
    // items (no structured place record) are shown as non-tappable text.
    if (!item.place?.id) return;
    router.push(`/place/${item.place.id}` as any);
  }, [item.place]);

  const goEntity = useCallback(() => {
    if (!item.linkedEntity) return;
    const { kind, id } = item.linkedEntity;
    const routes: Record<string, string> = {
      event: `/event/${id}`,
      trip: `/trip/${id}`,
      plan: `/plan/${id}`,
      place: `/place/${id}`,
    };
    router.push((routes[kind] ?? `/place/${id}`) as any);
  }, [item.linkedEntity]);

  const bottomPad = Math.max(insets.bottom + 100, 120); // leave space for progress bar + nav pill

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Cinematic scrim — bottom 65% gradient */}
      <LinearGradient
        colors={[color.scrimTop, color.scrimBottom]}
        style={s.scrim}
        pointerEvents="none"
      />

      {/* ── Create button — top-right corner ──────────────────────── */}
      <Pressable
        style={[s.createBtn, { top: insets.top + 12 }]}
        onPress={handleCreate}
        accessibilityRole="button"
        accessibilityLabel={isGemsMode ? 'Add a Gem' : 'Create a post'}
        hitSlop={8}
      >
        {isGemsMode ? (
          <Text style={s.createBtnText}>+ Gem</Text>
        ) : (
          <Camera size={16} color="#fff" strokeWidth={2} />
        )}
      </Pressable>

      {/* Bottom content */}
      <View style={[s.bottom, { paddingBottom: bottomPad }]} pointerEvents="box-none">

        {/* ── Left column ─────────────────────────────────────────────── */}
        <View style={s.leftCol} pointerEvents="box-none">

          {/* Creator row */}
          <View style={s.creatorRow} pointerEvents="box-none">
            <Pressable onPress={goProfile} style={s.avatarWrap} hitSlop={6}>
              {item.creator.avatarUrl ? (
                <Image source={{ uri: item.creator.avatarUrl }} style={s.avatar} />
              ) : (
                <View style={[s.avatar, s.avatarFallback]}>
                  <Text style={s.avatarInitial}>
                    {creatorDisplayName.charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
            </Pressable>

            <View style={s.creatorInfo} pointerEvents="box-none">
              <Pressable onPress={goProfile} hitSlop={4} style={s.creatorNameRow}>
                <Text style={s.displayName} numberOfLines={1}>
                  {creatorDisplayName}
                </Text>
                {item.creator.verified ? <VerifiedStamp size="sm" dark /> : null}
              </Pressable>
              {creatorUsername ? (
                <Pressable onPress={goProfile} hitSlop={4}>
                  <Text style={s.username} numberOfLines={1}>
                    @{creatorUsername}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            <FollowButton userId={item.creator.id} currentUserId={currentUserId} />
          </View>

          {/* Featured by Portava badge */}
          {item.featuredByPortava ? (
            <FeaturedBadge category={item.featuredByPortava} size="sm" dark />
          ) : null}

          {/* Caption */}
          {item.caption ? (
            <Pressable
              onPress={() => setCaptionExpanded((e) => !e)}
              style={s.captionWrap}
              hitSlop={4}
            >
              <Text
                style={s.caption}
                numberOfLines={captionExpanded ? undefined : 2}
              >
                {item.caption}
              </Text>
              {!captionExpanded && item.caption.length > 80 ? (
                <Text style={s.captionMore}>Show more</Text>
              ) : null}
            </Pressable>
          ) : null}

          {/* Hashtags */}
          {item.hashtags.length > 0 ? (
            <View style={s.hashtagRow} pointerEvents="none">
              <Text style={s.hashtags} numberOfLines={1}>
                {item.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}
              </Text>
            </View>
          ) : null}

          {/* Verified location stamp — shown when post was GPS-verified at the tagged place */}
          {item.locationVerified && item.place?.name ? (
            <VerifiedLocationStamp locationName={item.place.name} />
          ) : null}

          {/* Place chip — tappable only when a canonical place ID is available.
              Location-label-only items (name/city/country without a place record)
              render as plain non-interactive text to avoid /place/undefined routes. */}
          {item.place ? (
            item.place.id ? (
              <Pressable onPress={goPlace} style={s.chip} hitSlop={4} accessibilityRole="link" accessibilityLabel={`Go to ${item.place.name}`}>
                <MapPin size={11} color="rgba(255,255,255,0.85)" />
                <Text style={s.chipText} numberOfLines={1}>
                  {item.place.name}
                  {item.place.city ? ` · ${item.place.city}` : ''}
                </Text>
              </Pressable>
            ) : (
              <View style={s.chip} pointerEvents="none">
                <MapPin size={11} color="rgba(255,255,255,0.85)" />
                <Text style={s.chipText} numberOfLines={1}>
                  {item.place.name}
                  {item.place.city ? ` · ${item.place.city}` : ''}
                </Text>
              </View>
            )
          ) : null}

          {/* Quick actions row — shown when place is present */}
          {item.place ? (
            <PlaceQuickActions
              place={{
                id: item.place.id,
                name: item.place.name,
                city: item.place.city ?? null,
                lat: item.place.lat ?? null,
                lng: item.place.lng ?? null,
              }}
              sourceId={item.id}
              variant="dark"
            />
          ) : null}

          {/* Linked entity chip */}
          {item.linkedEntity ? (
            <Pressable onPress={goEntity} style={s.chip} hitSlop={4}>
              {entityIcon(item.linkedEntity.kind)}
              <Text style={s.chipText} numberOfLines={1}>
                {item.linkedEntity.label}
              </Text>
            </Pressable>
          ) : null}

          {/* Audio label */}
          {item.audioLabel ? (
            <View style={s.audioRow} pointerEvents="none">
              <Music2 size={12} color="rgba(255,255,255,0.75)" />
              <Text style={s.audioText} numberOfLines={1}>
                {item.audioLabel}
              </Text>
            </View>
          ) : null}
        </View>

        {/* ── Right action column ──────────────────────────────────────── */}
        <View style={s.rightCol} pointerEvents="box-none">
          {/* Stamp button — traveling ink overlay launched from this position */}
          <View ref={stampGroupRef} style={s.heartGroup}>
            <Animated.View style={stampButtonStyle as any}>
              <ActionBtn
                icon={<StampIcon size={28} active={stampVisualIsStamped} />}
                count={stampVisualCount}
                onPress={onStampPress}
                label={stampVisualIsStamped ? 'Unstamp' : 'Stamp'}
              />
            </Animated.View>
            {/* Stamp-it count — shown when at least one viewer has Stamp It'd */}
            {(item.stampItCount ?? 0) > 0 ? (
              <View style={s.stampRow} pointerEvents="none">
                <Zap size={9} color="rgba(255,220,80,0.9)" fill="rgba(255,220,80,0.9)" />
                <Text style={s.stampCount}>{fmtCount(item.stampItCount!)}</Text>
              </View>
            ) : null}
          </View>

          <ActionBtn
            icon={<MessageCircle size={28} color="#fff" strokeWidth={1.8} />}
            count={item.commentCount}
            onPress={onComment}
            label="Comment"
          />

          <ActionBtn
            icon={
              <Bookmark
                size={28}
                color={isSaved ? color.signal : '#fff'}
                fill={isSaved ? color.signal : 'transparent'}
                strokeWidth={isSaved ? 0 : 1.8}
              />
            }
            count={item.saveCount}
            onPress={onSave}
            label={isSaved ? 'Unsave' : 'Save'}
          />

          <ActionBtn
            icon={<Share2 size={26} color="#fff" strokeWidth={1.8} />}
            onPress={handleShare}
            label="Share"
          />

          <ActionBtn
            icon={<Send size={26} color="#fff" strokeWidth={1.8} />}
            onPress={() => setSendSheetVisible(true)}
            label="Send"
          />

          <ActionBtn
            icon={<MoreVertical size={26} color="#fff" strokeWidth={1.8} />}
            onPress={onMore}
            label="More options"
          />
        </View>
      </View>

      <ShareSheet
        visible={sendSheetVisible}
        postId={item.id}
        onClose={() => setSendSheetVisible(false)}
        onShareSuccess={() => {
          recordMediaShare(item.id, 'telegraph').catch(() => {});
        }}
      />

    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '65%',
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: space.lg,
  },
  // Left column
  leftCol: {
    flex: 1,
    gap: 6,
    paddingRight: space.sm,
  },
  creatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  avatarWrap: {},
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  avatarFallback: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: color.onInk,
    fontSize: 16,
    fontWeight: '700',
  },
  creatorInfo: {
    flex: 1,
    gap: 1,
  },
  creatorNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  displayName: {
    ...t.bodyStrong,
    color: color.onInk,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  username: {
    ...t.stamp,
    color: color.onInkMute,
  },
  followBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.7)',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  followBtnActive: {
    borderColor: 'rgba(255,255,255,0.3)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  followBtnText: {
    ...t.stamp,
    color: color.onInk,
  },
  captionWrap: {
    gap: 2,
  },
  caption: {
    ...t.body,
    color: color.onInk,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  captionMore: {
    ...t.small,
    color: color.onInkMute,
    fontWeight: '600',
  },
  hashtagRow: {
    flexDirection: 'row',
  },
  hashtags: {
    ...t.small,
    color: color.onInk,
    fontWeight: '600',
    opacity: 0.85,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipText: {
    ...t.stamp,
    color: 'rgba(255,255,255,0.9)',
    flexShrink: 1,
  },
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  audioText: {
    ...t.stamp,
    color: 'rgba(255,255,255,0.75)',
    flexShrink: 1,
  },
  // Create button — top-right corner
  createBtn: {
    position: 'absolute',
    right: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  createBtnText: {
    ...t.stamp,
    color: '#fff',
    fontWeight: '700',
  },
  // Right column
  rightCol: {
    alignItems: 'center',
    gap: space.xl,
    paddingBottom: space.sm,
  },
  actionBtn: {
    alignItems: 'center',
    gap: 4,
  },
  actionCount: {
    ...t.stamp,
    color: color.onInk,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  // Stamp action group (icon + stampItCount below)
  heartGroup: {
    alignItems: 'center',
    gap: 3,
  },
  stampRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  stampCount: {
    fontSize: 10,
    fontWeight: '700' as const,
    color: 'rgba(255,220,80,0.9)',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
