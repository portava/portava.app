/**
 * VideoWallItem — inline video (Wall spec §11/§36).
 *
 * Inline, cinematic playback in the feed — NOT a mandatory fullscreen vertical
 * takeover (§11). The item plays inline with the shared player and honors an
 * explicit CLIENT autoplay policy:
 *
 *   - Muted autoplay ONLY while the item is on-screen (FlatList viewability via
 *     useWallItemVisible); scrolling away pauses playback (§11).
 *   - The decision is CLIENT policy end to end (resolveVideoAutoplay, §11): the
 *     server never forces autoplay on and never vetoes it. `DisplayMedia
 *     .autoplayEligible` is an advisory note ("this media is playable"), so a
 *     `false`/absent value means the server has no opinion, not "forbidden".
 *   - Reduced motion (AccessibilityInfo) falls back to the still poster and never
 *     autoplays (§36).
 *
 * Lazy mount (§31 / TABLE 4 "Video: Lazy load; only near viewport"): the real
 * player is not mounted until the item first enters the viewport. Before that —
 * and whenever reduce-motion is on or there is no playable source — the poster is
 * shown with a play affordance. Tapping the poster (or the inline Open control)
 * enters the dedicated Media Viewer, the canonical surface (§11).
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { PlayCircle, Maximize2 } from 'lucide-react-native';
import { color, space, radius, type as t, icon, aspect } from '../../../../theme/tokens.ts';
import {
  ActorByline,
  ContextualActionChips,
  PlaceLine,
  SocialActionRow,
  WallImage,
  runWallAction,
} from './wallItemShared.tsx';
import { ContextThreadView } from '../ContextThreadView.tsx';
import { SharedVideoPlayer } from '../../../../components/ui/SharedVideoPlayer.tsx';
import { useWallItemVisible } from '../../hooks/useWallItemVisibility.tsx';
import { useReducedMotionSetting } from '../../hooks/useReducedMotionSetting.ts';
import { resolveVideoAutoplay } from '../../services/videoAutoplayPolicy.ts';
import type { VideoProjection } from '../../types/wallProjection.ts';

export function VideoWallItem({ projection }: { projection: VideoProjection }) {
  const media = projection.media?.[0];
  const videoUri = media?.url ?? null;
  const posterUri = media?.thumbnailUrl ?? media?.url ?? undefined;
  const openViewer = () => runWallAction({ type: 'open_object', label: 'Play' }, projection);

  const isVisible = useWallItemVisible(projection.projectionId);
  const reduceMotion = useReducedMotionSetting();

  // Lazy mount: activate the real player only once the item has entered the
  // viewport (TABLE 4). Once activated it stays mounted so pause/resume is a
  // shouldPlay toggle rather than an unmount/remount as the user scrolls.
  const [activated, setActivated] = React.useState(false);
  React.useEffect(() => {
    if (isVisible && !activated) setActivated(true);
  }, [isVisible, activated]);

  // Client-owned policy (§11/§36). The projection's `autoplayEligible` is an
  // advisory note, not a command, so it is deliberately not consulted here.
  const { autoplay, muted } = resolveVideoAutoplay({
    visible: isVisible,
    reduceMotion,
  });

  // The inline player is used when there is a playable source, reduce-motion is
  // off, the media is not still processing, and the item has been near the
  // viewport. Otherwise the still poster stands in (fallback for reduced motion,
  // pending processing, missing source, or not-yet-scrolled-into-view).
  const showPlayer = !!videoUri && !reduceMotion && !media?.processing && activated;

  return (
    <View style={s.card} testID={`wall-item-${projection.objectType}`}>
      <View style={s.header}>
        <ActorByline
          actor={projection.actor}
          publishedAt={projection.publishedAt}
          experienceAt={projection.experienceAt}
        />
      </View>
      {showPlayer ? (
        <View style={s.frame}>
          <SharedVideoPlayer
            uri={videoUri as string}
            poster={posterUri}
            autoplay={autoplay}
            muted={muted}
            style={StyleSheet.absoluteFill}
          />
          {/* §11: tapping may enter the dedicated Media Viewer. The player owns
              tap (play/pause) + mute; this quiet control opens the canonical
              viewer without stealing the inline play gesture. */}
          <Pressable
            style={s.openBtn}
            onPress={openViewer}
            accessibilityRole="button"
            accessibilityLabel="Open video"
            hitSlop={8}
            testID={`wall-video-open-${projection.projectionId}`}
          >
            <Maximize2 size={icon.s16} color={color.onInk} />
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={openViewer}
          accessibilityRole="button"
          accessibilityLabel="Play video"
          style={s.frame}
        >
          <WallImage media={media} ratio={aspect.wide} rounded={false} />
          <View style={s.playOverlay} pointerEvents="none">
            <PlayCircle size={icon.s26} color={color.onInk} />
          </View>
        </Pressable>
      )}
      <View style={s.body}>
        {projection.text ? (
          <Text style={s.text} numberOfLines={3}>
            {projection.text}
          </Text>
        ) : null}
        <PlaceLine projection={projection} />
        <ContextualActionChips projection={projection} />
        <SocialActionRow projection={projection} />
        {projection.contextThread ? (
          <ContextThreadView thread={projection.contextThread} projection={projection} />
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: color.ink,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  header: {
    backgroundColor: color.paperRaised,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  frame: { width: '100%', aspectRatio: aspect.wide, backgroundColor: '#000' },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openBtn: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    padding: space.xs,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(17,17,15,0.55)',
    zIndex: 2,
  },
  body: { padding: space.lg },
  text: { ...t.body, color: color.onInk },
});
