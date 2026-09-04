/**
 * DiscoveryWallItem — a discovery insertion reaching outside the follow graph
 * (Wall spec §13).
 *
 * MUST be visually identifiable and explainable: a labelled "Discovered for you"
 * ribbon plus the server-supplied `discoveryReason` ("Followed by 3 people you
 * know", "Near your Bangkok trip", …) so it never reads as a naked directory
 * listing. The underlying content is still social (a person / Postcard / video),
 * so it keeps the normal social affordances.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Compass } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../../../theme/tokens.ts';
import {
  ActorByline,
  ContextualActionChips,
  PlaceLine,
  SocialActionRow,
  WallImage,
} from './wallItemShared.tsx';
import { ContextThreadView } from '../ContextThreadView.tsx';
import type { DiscoveryProjection } from '../../types/wallProjection.ts';

export function DiscoveryWallItem({ projection }: { projection: DiscoveryProjection }) {
  const media = projection.media?.[0];
  return (
    <View style={s.card} testID={`wall-item-${projection.objectType}`}>
      <View style={s.ribbon} accessible accessibilityRole="text">
        <Compass size={icon.s14} color={color.deep} />
        <Text style={s.ribbonText} numberOfLines={1}>
          Discovered for you
        </Text>
      </View>
      <Text style={s.reason} numberOfLines={2}>
        {projection.discoveryReason}
      </Text>
      <ActorByline
        actor={projection.actor}
        publishedAt={projection.publishedAt}
        experienceAt={projection.experienceAt}
        accent
      />
      {projection.text ? (
        <Text style={s.text} numberOfLines={4}>
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
    borderWidth: 1,
    borderColor: color.deep,
  },
  ribbon: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  ribbonText: { ...t.stamp, color: color.deep },
  reason: { ...t.small, color: color.mute, marginTop: space.xs, marginBottom: space.md },
  text: { ...t.body, color: color.ink, marginTop: space.md },
  media: { marginTop: space.md },
});
