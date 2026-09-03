/**
 * PostcardWallItem — a first-class Postcard (Wall spec §10).
 *
 * A Postcard is NOT a Post with a badge. It gets a distinct travel-story
 * presentation: a paper frame with a prominent place + experience date (the
 * two-clock "happened" time, spec §16), decorative-but-readable typography
 * (spec §36), and a collectible feel that periodically breaks feed rhythm.
 * Opening it enters the canonical Postcard viewer.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { color, space, radius, type as t, icon, aspect, shadow } from '../../../../theme/tokens.ts';
import {
  ContextualActionChips,
  WallImage,
  formatDate,
  runWallAction,
} from './wallItemShared.tsx';
import { ContextThreadView } from '../ContextThreadView.tsx';
import type { PostcardProjection } from '../../types/wallProjection.ts';

export function PostcardWallItem({ projection }: { projection: PostcardProjection }) {
  const media = projection.media?.[0];
  const place = projection.place;
  const experience = projection.experienceAt ?? projection.publishedAt;
  const authorName = projection.actor?.displayName ?? 'A traveler';
  const open = () => runWallAction({ type: 'open_object', label: 'Open Postcard' }, projection);

  return (
    <View style={s.outer} testID={`wall-item-${projection.objectType}`}>
      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`Postcard from ${place?.name ?? place?.city ?? 'somewhere'}`}
        style={s.card}
      >
        <View style={s.mediaWrap}>
          <WallImage media={media} ratio={aspect.card} rounded={false} />
          <View style={s.dateStamp}>
            <Text style={s.dateStampText}>{formatDate(experience).toUpperCase()}</Text>
          </View>
        </View>
        <View style={s.footer}>
          <View style={s.locRow}>
            <MapPin size={icon.s14} color={color.deep} />
            <Text style={s.place} numberOfLines={1}>
              {place?.name ?? place?.city ?? 'Somewhere'}
            </Text>
          </View>
          {projection.text ? (
            <Text style={s.caption} numberOfLines={3}>
              {projection.text}
            </Text>
          ) : null}
          <Text style={s.byline} numberOfLines={1}>
            Postcard · {authorName}
          </Text>
        </View>
      </Pressable>
      <ContextualActionChips projection={projection} />
      {projection.contextThread ? (
        <ContextThreadView thread={projection.contextThread} projection={projection} />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  // A slight rotation + paper border makes Postcards break feed rhythm (§10).
  outer: { transform: [{ rotate: '-0.6deg' }] },
  card: {
    backgroundColor: '#FFFDF7',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
    ...shadow.float,
  },
  mediaWrap: { width: '100%' },
  dateStamp: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    backgroundColor: color.paperRaised,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: color.haze,
  },
  dateStampText: { ...t.stamp, color: color.deep },
  footer: { padding: space.lg, gap: space.xs },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  place: { ...t.heading, color: color.ink, flexShrink: 1 },
  caption: { ...t.body, color: color.mute, fontStyle: 'italic' },
  byline: { ...t.stamp, color: color.faint, marginTop: space.xs },
});
