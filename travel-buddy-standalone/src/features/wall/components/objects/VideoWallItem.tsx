/**
 * VideoWallItem — inline video (Wall spec §11).
 *
 * Inline, cinematic frame — NOT a mandatory fullscreen vertical takeover. The
 * shell renders the poster with an inline play affordance; tapping enters the
 * dedicated Media Viewer (the canonical surface). Autoplay is intentionally not
 * driven here: it is gated on product/user/device policy and reduced-motion
 * (spec §11/§36), so the shell defaults to tap-to-play rather than asserting
 * current state from a video.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { PlayCircle } from 'lucide-react-native';
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
import type { VideoProjection } from '../../types/wallProjection.ts';

export function VideoWallItem({ projection }: { projection: VideoProjection }) {
  const media = projection.media?.[0];
  const openViewer = () => runWallAction({ type: 'open_object', label: 'Play' }, projection);
  return (
    <View style={s.card} testID={`wall-item-${projection.objectType}`}>
      <View style={s.header}>
        <ActorByline
          actor={projection.actor}
          publishedAt={projection.publishedAt}
          experienceAt={projection.experienceAt}
        />
      </View>
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
  frame: { width: '100%', backgroundColor: '#000' },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { padding: space.lg },
  text: { ...t.body, color: color.onInk },
});
