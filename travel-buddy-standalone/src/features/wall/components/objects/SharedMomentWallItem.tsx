/**
 * SharedMomentWallItem — a Shared Moment (Wall spec §12).
 *
 * Real-world overlap surfaced as a DISCOVERED SOCIAL MEMORY, not a
 * location-tracking notification. Participants are shown only at the coarse
 * granularity the viewer is authorized for (never precise co-location), and the
 * framing is gentle and reminiscent rather than a "who's near you" alert.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Sparkles } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../../../theme/tokens.ts';
import {
  ContextualActionChips,
  PlaceLine,
  SocialActionRow,
  WallImage,
  formatRelative,
} from './wallItemShared.tsx';
import { ContextThreadView } from '../ContextThreadView.tsx';
import type { SharedMomentProjection } from '../../types/wallProjection.ts';

export function SharedMomentWallItem({ projection }: { projection: SharedMomentProjection }) {
  const media = projection.media?.[0];
  const people = projection.participants ?? [];
  const names = people.map((p) => p.displayName);
  const who =
    names.length === 0
      ? 'You and someone'
      : names.length <= 2
        ? names.join(' & ')
        : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  const when = projection.experienceAt ?? projection.publishedAt;

  return (
    <View style={s.card} testID={`wall-item-${projection.objectType}`}>
      <View style={s.tagRow}>
        <Sparkles size={icon.s14} color={color.deep} />
        <Text style={s.tag}>Shared moment</Text>
      </View>
      <Text style={s.headline} numberOfLines={2}>
        {who}
      </Text>
      <Text style={s.sub} numberOfLines={1}>
        {`Crossed paths ${formatRelative(when)}`}
      </Text>
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
    borderColor: color.haze,
  },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  tag: { ...t.stamp, color: color.deep },
  headline: { ...t.heading, color: color.ink, marginTop: space.sm },
  sub: { ...t.small, color: color.faint, marginTop: 2 },
  media: { marginTop: space.md },
});
