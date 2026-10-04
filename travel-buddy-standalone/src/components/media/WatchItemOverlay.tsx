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
  Share,
  Alert,
  Dimensions, useWindowDimensions, type LayoutChangeEvent,
} from 'react-native';
import { Avatar } from '../ui/Avatar.tsx';
import { recordMediaShare, mediaSignalRecorder } from '../../services/mediaInteractions.ts'; import { emitMediaSignal, emitMediaNorthStar } from '../../features/media/telemetry/mediaTelemetry.ts';
import { ShareSheet } from '../ShareSheet.tsx';
import { formatCompactCount } from '../../lib/counterFormat.ts'; import { UNREAD_COUNT_MARK, unreadCountLabel } from '../../lib/unreadCount.ts';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context'; import { useLayoverAwareBottomInset } from '../../hooks/useBottomInset.ts'; import { getOverlayHeaderTotalHeight } from '../ui/AppHeader.tsx'; // census-media §40.11: the rail's vertical budget
import { router } from 'expo-router';
import {
  MessageCircle,
  Bookmark,
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
import { color, space, type as t, radius, avatar } from '../../theme/tokens.ts';
import { VerifiedStamp } from '../ui/VerifiedStamp.tsx';
import { FeaturedBadge } from '../FeaturedBadge.tsx';
import { useFollow } from '../../hooks/useFollow.ts';
import type { MediaFeedItem } from '../../types/media.ts';
import { StampIcon } from '../stamps/StampIcon.tsx';
import { VerifiedLocationStamp } from './VerifiedLocationStamp.tsx';
import { PlaceQuickActions } from '../PlaceQuickActions.tsx';
import { formatLocationLabel } from '../../lib/formatPlaceLabel.ts';
import { PortavaShareIcon } from '../icons/PortavaShareIcon.tsx'; import { useMediaSurfaceDecisions } from '../../features/media/hooks/useMediaSurfaceDecisions.ts'; import { openPlaceByIdPerspectives } from '../../features/media/services/perspectiveOpeners.ts'; import { ASK_COMPASS_DEFAULT_PROMPT } from '../../features/media/services/mediaActions.ts'; import type { MediaProjection } from '../../features/media/types/media.ts';

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

// ── Action button ─────────────────────────────────────────────────────────────

interface ActionBtnProps {
  icon: React.ReactNode;
  count?: number | null; // null = the server could not read it (census-media §47): drawn as the mark
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
      {count === null ? <Text style={s.actionCount} accessibilityLabel={unreadCountLabel(label)}>{UNREAD_COUNT_MARK}</Text> : count !== undefined && count > 0 ? (
        <Text style={s.actionCount}>{formatCompactCount(count)}</Text>
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
  stampVisualCount: number | null;
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
  const insets = useSafeAreaInsets(); const contextFirst = useMediaSurfaceDecisions().contextOverlay; // census-media §34 (F2): false — the seed, and any unread flag — renders exactly today's overlay
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
    const message = item.caption || 'Check this out on Portava!';
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
    router.push(`/u/${item.creator.username}` as any); emitMediaSignal(mediaSignalRecorder, 'profile_open', { mediaId: item.id, creatorId: item.creator.id, surface: 'watch_overlay' });
  }, [item.creator.username, item.creator.id, item.id]);

  const goPlace = useCallback(() => {
    // Only navigate when a canonical place ID is available; location-label-only
    // items (no structured place record) are shown as non-tappable text.
    if (!item.place?.id) return;
    router.push(`/place/${item.place.id}` as any); emitMediaSignal(mediaSignalRecorder, 'place_open', { mediaId: item.id, placeId: item.place.id, surface: 'watch_overlay' }); emitMediaNorthStar(mediaSignalRecorder, 'show_on_map', { mediaId: item.id, placeId: item.place.id, entityKind: 'place', surface: 'watch_overlay' });
  }, [item.place, item.id]);

  const goEntity = useCallback(() => {
    if (!item.linkedEntity) return;
    const { kind, id } = item.linkedEntity;
    const routes: Record<string, string> = {
      event: `/event/${id}`,
      trip: `/trip/${id}`,
      // Plans (saved routes) live under app/route/[id] — there is no /plan/ route.
      plan: `/route/${id}`,
      place: `/place/${id}`,
    };
    router.push((routes[kind] ?? `/place/${id}`) as any);
  }, [item.linkedEntity]);

  const bottomPad = Math.max(insets.bottom + 100, 120); // leave space for progress bar + nav pill
  const rail = useWatchRailFit(insets.top, bottomPad, contextFirst); // census-media §40.11: the rail clears the Media tab's FAB and fits under the header
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
        <View style={s.leftCol} pointerEvents="box-none">{contextFirst ? <ContextPlaceHeader item={item} /> : null}

          {/* Creator row */}
          <View style={s.creatorRow} pointerEvents="box-none">
            <Pressable onPress={goProfile} style={s.avatarWrap} hitSlop={6}>
              <Avatar
                uri={item.creator.avatarUrl}
                name={creatorDisplayName}
                size={40}
                style={s.avatarRing}
              />
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
          {item.place && !contextFirst ? (
            item.place.id ? (
              <Pressable onPress={goPlace} style={s.chip} hitSlop={4} accessibilityRole="link" accessibilityLabel={`Go to ${item.place.name}`}>
                <MapPin size={11} color="rgba(255,255,255,0.85)" />
                <Text style={s.chipText} numberOfLines={1}>
                  {formatLocationLabel(item.place.name, item.place.city, ' · ')}
                </Text>
              </Pressable>
            ) : (
              <View style={s.chip} pointerEvents="none">
                <MapPin size={11} color="rgba(255,255,255,0.85)" />
                <Text style={s.chipText} numberOfLines={1}>
                  {formatLocationLabel(item.place.name, item.place.city, ' · ')}
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
        <View style={[s.rightCol, rail.style]} onLayout={rail.onLayout} testID="watch-action-rail" pointerEvents="box-none">{contextFirst ? <ContextCompassButton item={item} /> : null}
          {/* Stamp button — traveling ink overlay launched from this position */}
          <View ref={stampGroupRef} style={s.heartGroup}>
            <Animated.View style={stampButtonStyle as any}>
              <ActionBtn
                icon={<StampIcon size={28} active={stampVisualIsStamped} color={stampVisualIsStamped ? color.signal : '#fff'} />}
                count={contextFirst ? undefined : stampVisualCount}
                onPress={onStampPress}
                label={stampVisualIsStamped ? 'Unstamp' : 'Stamp'}
              />
            </Animated.View>
            {/* Stamp-it count — shown when at least one viewer has Stamp It'd */}
            {!contextFirst && (item.stampItCount ?? 0) > 0 ? (
              <View style={s.stampRow} pointerEvents="none">
                <Zap size={9} color="rgba(255,220,80,0.9)" fill="rgba(255,220,80,0.9)" />
                <Text style={s.stampCount}>{formatCompactCount(item.stampItCount!)}</Text>
              </View>
            ) : null}
          </View>

          <ActionBtn
            icon={<MessageCircle size={28} color="#fff" strokeWidth={1.8} />}
            count={contextFirst ? undefined : item.commentCount}
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
            count={contextFirst ? undefined : item.saveCount}
            onPress={onSave}
            label={isSaved ? 'Unsave' : 'Save'}
          />

          <ActionBtn
            icon={<PortavaShareIcon size={26} color="#fff" />}
            onPress={handleShare}
            label="Share"
          />

          <ActionBtn
            icon={<PortavaShareIcon size={26} color="#fff" />}
            onPress={() => setSendSheetVisible(true)}
            label="Send to a chat"
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
    paddingRight: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: 'rgba(17,17,15,0.71)', // census-media §31.12: an ink backing under the left column, the least alpha at which every line in it clears 4.5:1 over a white frame
  },
  creatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  avatarWrap: {},
  // Sizing/shape come from <Avatar size>; this is the contrast ring only.
  avatarRing: {
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.6)',
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
    backgroundColor: 'rgba(17,17,15,0.58)', // census-media §31.12: was a 0.18 light wash (1.00:1 over a white frame)
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
    paddingBottom: space.sm, paddingTop: space.md, paddingHorizontal: space.xs, borderRadius: radius.pill, backgroundColor: 'rgba(17,17,15,0.80)', // census-media §31.12: an ink backing under the action rail; 0.80 is set by the saved bookmark in `signal`
  },
  actionBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 44,
    minHeight: 44,
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

// ── census-media §34 (owner decision F2) — the context-first overlay ─────────
//
// Appended at the TAIL so no line the census cites moves. Rendered only while
// MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED is on (seeded OFF by migration 3341,
// read through features/media/state/mediaSurfaceFlags.ts); off, the component
// above draws exactly today's rail and neither of these is mounted.
//
// ON, three things change and nothing else does:
//   1. Ask Compass LEADS the rail — the first control and the largest, handing
//      the media id to Compass exactly as the §15 action rail does (§32).
//   2. Stamp, comment and save keep their controls and lose their counts, and
//      the Stamp It count under the Stamp is not drawn (§46 minimal vanity
//      metrics; the counts stop dominating, MD215/MD408/MD424).
//   3. The left column opens on the PLACE, which opens that place's other
//      perspectives through the §14 entry context — the contextual viewer —
//      and falls back to the place screen when there is nothing to stage
//      (MD87: a Watch open routed through an entry context). The creator row
//      follows it, where it was.

function ContextCompassButton({ item }: { item: MediaFeedItem }) {
  const ask = () => {
    emitMediaNorthStar(mediaSignalRecorder, 'ask_compass', { mediaId: item.id, placeId: item.place?.id ?? null, entityKind: item.place?.id ? 'place' : 'media', surface: 'watch_overlay' });
    router.push({ pathname: '/(tabs)/ai', params: { mediaId: item.id, prefillMessage: ASK_COMPASS_DEFAULT_PROMPT } } as never);
  };
  return (
    <Pressable
      onPress={ask}
      style={ctx.compassBtn}
      accessibilityRole="button"
      accessibilityLabel="Ask Compass about this"
      hitSlop={6}
      testID="watch-context-compass"
    >
      <View style={ctx.compassDisc}>
        <Compass size={26} color={color.ink} strokeWidth={2.2} />
      </View>
      <Text style={ctx.compassLabel}>Compass</Text>
    </Pressable>
  );
}

function ContextPlaceHeader({ item }: { item: MediaFeedItem }) {
  const place = item.place;
  if (!place) return null;
  const label = formatLocationLabel(place.name, place.city, ' · ');
  const placeId = place.id;
  const open = () => {
    if (!placeId) return;
    emitMediaSignal(mediaSignalRecorder, 'place_open', { mediaId: item.id, placeId, surface: 'watch_overlay' });
    emitMediaNorthStar(mediaSignalRecorder, 'show_on_map', { mediaId: item.id, placeId, entityKind: 'place', surface: 'watch_overlay' });
    const fallback = () => router.push(`/place/${placeId}` as never);
    // Only the tapped media's id is read (perspectiveOpeners → placeHandoff), so
    // the viewer opens on THIS perspective when the place's collection holds it.
    void openPlaceByIdPerspectives(placeId, { id: item.id } as unknown as MediaProjection)
      .then((opened) => { if (!opened) fallback(); })
      .catch(fallback);
  };
  const body = (
    <>
      <MapPin size={14} color={color.onInk} />
      <View style={ctx.placeText}>
        <Text style={ctx.placeName} numberOfLines={1}>{label}</Text>
        {placeId ? <Text style={ctx.placeHint} numberOfLines={1}>See this place's perspectives</Text> : null}
      </View>
    </>
  );
  return placeId ? (
    <Pressable
      onPress={open}
      style={ctx.placeHeader}
      accessibilityRole="link"
      accessibilityLabel={`See ${place.name}'s perspectives`}
      hitSlop={4}
      testID="watch-context-place"
    >
      {body}
    </Pressable>
  ) : (
    <View style={ctx.placeHeader} testID="watch-context-place">{body}</View>
  );
}

const ctx = StyleSheet.create({
  // Sits first in the rail, on the rail's own 0.80 ink backing.
  compassBtn: { alignItems: 'center', justifyContent: 'center', minWidth: 52, minHeight: 52, gap: 4 },
  // An opaque onInk disc under an ink glyph: its contrast does not depend on the frame.
  compassDisc: { width: avatar.s52, height: avatar.s52, borderRadius: avatar.s52 / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.onInk },
  compassLabel: { ...t.stamp, color: color.onInk, fontWeight: '700' },
  // First in the left column, on the column's own 0.71 ink backing.
  placeHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  placeText: { flexShrink: 1 },
  placeName: { ...t.bodyStrong, color: color.onInk },
  placeHint: { ...t.stamp, color: color.onInkMute },
});

// ── census-media §40.11 — the Watch rail's vertical budget ───────────────────
//
// The rail sat on the overlay's bottom row, 120 above the screen's bottom edge,
// and the Media tab's FAB (app/(tabs)/media.tsx `fab`: 16 above
// useLayoverAwareBottomInset(), avatar.s52 tall) floats over the same right
// edge, so "More options" was under the FAB and a tap on it created a post.
//
//   1. The rail's bottom edge now starts space.sm above the FAB's top edge (a
//      marginBottom on top of the row's bottomPad; the left column is unmoved).
//   2. The rail's top edge should stay below the chrome over the feed: the
//      overlay header (getOverlayHeaderTotalHeight) and the mode selector under
//      it (4 below the header, 46 tall with its border), plus space.sm. When
//      the rail's natural height (measured, gaps excluded) would cross that
//      line, its gaps shrink from space.xl toward space.xs. On a short screen
//      with the context overlay on (census-media §34), even space.xs gaps do not
//      fit; the rail then keeps its FAB clearance and rises into the selector's
//      fading scrim, still below the header bar (§40.11 has the numbers).
const WATCH_RAIL_FAB_CLEARANCE = 16 + avatar.s52 + space.sm;
const WATCH_RAIL_TOP_CLEARANCE = 4 + 46 + space.sm;

function useWatchRailFit(insetsTop: number, bottomPad: number, contextFirst: boolean) {
  const { height: windowH } = useWindowDimensions();
  const fabTopClear = useLayoverAwareBottomInset() + WATCH_RAIL_FAB_CLEARANCE;
  const railBottom = Math.max(bottomPad, fabTopClear);
  const budget = windowH - railBottom - (getOverlayHeaderTotalHeight(insetsTop) + WATCH_RAIL_TOP_CLEARANCE);
  // The rail's children: [Ask Compass], the Stamp group, Comment, Save, Share,
  // Send to a chat, More options, with one gap between each pair.
  const gaps = contextFirst ? 6 : 5;
  const [content, setContent] = useState<number | null>(null);
  const gap = content === null ? space.xl : watchRailGap(budget, content, gaps);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const measured = Math.round(e.nativeEvent.layout.height - gap * gaps);
    setContent((prev) => (prev === measured ? prev : measured));
  }, [gap, gaps]);
  return { style: { marginBottom: railBottom - bottomPad, gap }, onLayout };
}

/** The rail's gap: space.xl when the rail fits its budget, less when it would not, never under space.xs. */
export function watchRailGap(budget: number, content: number, gaps: number): number {
  return Math.max(space.xs, Math.min(space.xl, Math.floor((budget - content) / gaps)));
}
