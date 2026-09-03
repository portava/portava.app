/**
 * WallObjectRenderer — dispatches a WallProjection to its DISTINCT renderer
 * (Wall spec §6/§7/§29).
 *
 * The whole point of the discriminated `objectType` is that the feed is not a
 * uniform stack of identical cards: a Postcard, a video, a Shared Moment and a
 * plain Post each get their own presentation here. An unknown object type
 * renders nothing rather than crashing the feed (spec §40).
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import { SocialPostWallItem } from './objects/SocialPostWallItem.tsx';
import { VideoWallItem } from './objects/VideoWallItem.tsx';
import { PostcardWallItem } from './objects/PostcardWallItem.tsx';
import { SharedMomentWallItem } from './objects/SharedMomentWallItem.tsx';
import { DiscoveryWallItem } from './objects/DiscoveryWallItem.tsx';
import {
  ActorByline,
  ContextualActionChips,
  PlaceLine,
} from './objects/wallItemShared.tsx';
import { ContextThreadView } from './ContextThreadView.tsx';
import type {
  ContextualOpportunityProjection,
  SocialUpdateProjection,
  WallProjection,
} from '../types/wallProjection.ts';

const OPPORTUNITY_LABEL: Record<ContextualOpportunityProjection['opportunityKind'], string> = {
  buddy_dispatch: 'Buddy on the move',
  buddy_around: 'Buddy around',
  event: 'Happening',
  trip_signal: 'Trip signal',
};

/** Light social text/update — kept deliberately airy for feed rhythm (§7). */
function SocialUpdateWallItem({ projection }: { projection: SocialUpdateProjection }) {
  return (
    <View style={s.update} testID={`wall-item-${projection.objectType}`}>
      <ActorByline
        actor={projection.actor}
        publishedAt={projection.publishedAt}
        experienceAt={projection.experienceAt}
      />
      {projection.text ? (
        <Text style={s.updateText} numberOfLines={5}>
          {projection.text}
        </Text>
      ) : null}
      <PlaceLine projection={projection} />
      <ContextualActionChips projection={projection} />
      {projection.contextThread ? (
        <ContextThreadView thread={projection.contextThread} projection={projection} />
      ) : null}
    </View>
  );
}

/** A sparingly-surfaced opportunity — Buddy/event/trip signal (§19). */
function ContextualOpportunityWallItem({
  projection,
}: {
  projection: ContextualOpportunityProjection;
}) {
  return (
    <View style={s.opportunity} testID={`wall-item-${projection.objectType}`}>
      <Text style={s.opportunityTag}>{OPPORTUNITY_LABEL[projection.opportunityKind]}</Text>
      <ActorByline
        actor={projection.actor}
        publishedAt={projection.publishedAt}
        experienceAt={projection.experienceAt}
        accent
      />
      {projection.text ? (
        <Text style={s.opportunityText} numberOfLines={4}>
          {projection.text}
        </Text>
      ) : null}
      <PlaceLine projection={projection} />
      <ContextualActionChips projection={projection} />
      {projection.contextThread ? (
        <ContextThreadView thread={projection.contextThread} projection={projection} />
      ) : null}
    </View>
  );
}

export function WallObjectRenderer({ projection }: { projection: WallProjection }) {
  switch (projection.objectType) {
    case 'social_post':
      return <SocialPostWallItem projection={projection} />;
    case 'video':
      return <VideoWallItem projection={projection} />;
    case 'postcard':
      return <PostcardWallItem projection={projection} />;
    case 'shared_moment':
      return <SharedMomentWallItem projection={projection} />;
    case 'discovery':
      return <DiscoveryWallItem projection={projection} />;
    case 'social_update':
      return <SocialUpdateWallItem projection={projection} />;
    case 'contextual_opportunity':
      return <ContextualOpportunityWallItem projection={projection} />;
    default:
      // Unknown / future object type — never crash the feed.
      return null;
  }
}

const s = StyleSheet.create({
  update: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: color.haze,
  },
  updateText: { ...t.body, color: color.ink, marginTop: space.sm },
  opportunity: {
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: color.deep,
  },
  opportunityTag: { ...t.stamp, color: color.deep, marginBottom: space.sm },
  opportunityText: { ...t.body, color: color.ink, marginTop: space.sm },
});
