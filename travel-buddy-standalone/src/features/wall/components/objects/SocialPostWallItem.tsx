/**
 * SocialPostWallItem — a normal social post (Wall spec §7).
 *
 * The creator stays visually primary; intelligence is optional. A plain text
 * post with no media, place, actions or context thread renders as exactly that
 * — a plain post, no annotations bolted on.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, space, radius, type as t, shadow } from '../../../../theme/tokens.ts';
import {
  ActorByline,
  ContextualActionChips,
  PlaceLine,
  SocialActionRow,
  WallImage,
} from './wallItemShared.tsx';
import { ContextThreadView } from '../ContextThreadView.tsx';
import type { SocialPostProjection } from '../../types/wallProjection.ts';

export function SocialPostWallItem({ projection }: { projection: SocialPostProjection }) {
  const media = projection.media?.[0];
  return (
    <View style={s.card} testID={`wall-item-${projection.objectType}`}>
      <ActorByline
        actor={projection.actor}
        publishedAt={projection.publishedAt}
        experienceAt={projection.experienceAt}
      />
      {projection.text ? (
        <Text style={s.text} numberOfLines={6}>
          {projection.text}
        </Text>
      ) : null}
      {media ? (
        <View style={s.media}>
          <WallImage media={media} />
        </View>
      ) : null}
      <PlaceLine projection={projection} />
      <ContextualActionChips projection={projection} />
      <SocialActionRow projection={projection} />
      {projection.contextThread ? (
        <ContextThreadView thread={projection.contextThread} projection={projection} />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.lg,
    ...shadow.card,
  },
  text: { ...t.body, color: color.ink, marginTop: space.md },
  media: { marginTop: space.md },
});
