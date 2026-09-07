/**
 * LiveForYouStrip — the compact, bounded live mini-surface above the feed
 * (Wall spec §4/§35).
 *
 * Shows at most 4 horizontally browsable items and a single "See Live" action.
 * It is IGNORABLE by construction: when there is nothing fresh to show it
 * renders nothing at all, so normal scrolling is entirely unaffected (spec §40
 * non-negotiable #2). Live state is conveyed with TEXT, not colour alone
 * (spec §36), and a stale item never carries a live label (spec §4).
 */

import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Radio, ChevronRight, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../../theme/tokens.ts';
import { trackLiveOpen, trackLiveShown } from '../services/wallAnalytics.ts';
import { runWallAction } from './objects/wallItemShared.tsx';
import type { LiveForYouItem } from '../types/liveForYou.ts';
import type { WallProjection } from '../types/wallProjection.ts';
import { truthQualifierLabel } from '../types/wallProjection.ts';
import { CONFLICT_LABEL, normalizeConflictState } from '../../../lib/intel/conflict.ts';

const MAX_ITEMS = 4;

/** A minimal projection stand-in so a live item's action can route + record. */
function liveActionCarrier(item: LiveForYouItem): WallProjection {
  return {
    projectionId: `live-${item.id}`,
    objectType: 'social_post',
    canonicalObjectId: item.subjectId,
    publishedAt: item.observedAt,
    visibility: 'public',
    place: item.subject,
    actions: [],
  };
}

function stateLabel(item: LiveForYouItem): string {
  // §10: a materially-conflicted claim never carries a Live label — it says so
  // in TEXT (spec §36), wherever Live now / Emerging would have rendered.
  if (normalizeConflictState(item.conflictState) === 'material') return CONFLICT_LABEL;
  // Sensing §108: a prediction must never render indistinguishably from an
  // observation. An event's schedule and a trip plan arrive as `predicted`, and
  // "Emerging" alone reads exactly like an observed emerging state — so the
  // carried truth class REPLACES the state word rather than decorating it.
  // Purely a function of the server's value; the client derives no world truth.
  const qualifier = truthQualifierLabel(item.truthClass);
  if (qualifier) return qualifier;
  return item.state === 'live' ? 'Live now' : 'Emerging';
}

export function LiveForYouStrip({
  items,
  onSeeLive,
}: {
  items: LiveForYouItem[];
  onSeeLive?: () => void;
}) {
  const bounded = items.slice(0, MAX_ITEMS);

  React.useEffect(() => {
    if (bounded.length > 0) trackLiveShown(bounded.length);
  }, [bounded.length]);

  // Ignorable: nothing fresh → render nothing, feed is unaffected (§40).
  if (bounded.length === 0) return null;

  return (
    <View style={s.container} testID="wall-live-strip">
      <View style={s.head}>
        <View style={s.headLeft} accessible accessibilityRole="header">
          <Radio size={icon.s16} color={color.signal} />
          <Text style={s.headTitle}>Live for you</Text>
        </View>
        <Pressable
          onPress={onSeeLive}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="See live"
          testID="wall-see-live"
        >
          <View style={s.seeLive}>
            <Text style={s.seeLiveText}>See Live</Text>
            <ChevronRight size={icon.s14} color={color.mute} />
          </View>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.scroll}
        accessibilityRole="list"
      >
        {bounded.map((item, idx) => (
          <Pressable
            key={item.id}
            testID={`wall-live-item-${item.id}`}
            style={s.card}
            onPress={() => {
              trackLiveOpen(item);
              if (item.action) runWallAction(item.action, liveActionCarrier(item));
            }}
            accessibilityRole="button"
            // §36 "the horizontal Live For You list supports logical focus
            // order". Each card is ONE focusable element (its inner Texts are
            // merged into the card's own label rather than being separately
            // focusable), and the position is announced so a screen-reader user
            // knows where in the strip they are rather than hearing four
            // unanchored fragments.
            accessible
            accessibilityLabel={`${item.label}. ${stateLabel(item)}. ${idx + 1} of ${
              bounded.length
            }`}
            accessibilityHint="Opens this live item"
          >
            <Text
              style={s.cardState}
              numberOfLines={1}
              importantForAccessibility="no"
              testID={`wall-live-state-${item.id}`}
            >
              {stateLabel(item)}
            </Text>
            <Text style={s.cardLabel} numberOfLines={2} importantForAccessibility="no">
              {item.label}
            </Text>
            {item.subject ? (
              <View style={s.cardPlace} importantForAccessibility="no-hide-descendants">
                <MapPin size={icon.s14} color={color.faint} />
                <Text style={s.cardPlaceText} numberOfLines={1}>
                  {item.subject.name}
                </Text>
              </View>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { paddingVertical: space.md },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  headLeft: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  headTitle: { ...t.stamp, color: color.ink },
  seeLive: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  seeLiveText: { ...t.small, color: color.mute, fontWeight: '700' },
  scroll: { paddingHorizontal: space.lg, gap: space.md },
  card: {
    width: 168,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
  },
  // §36 contrast. `signal` (#FF4D2E) is 3.31:1 on the card's white ground and
  // `signalDim` only 4.26:1 — neither clears WCAG AA (4.5:1) for 11px text, and
  // t.stamp is far below the large-text threshold. This is the ONE word on the
  // card that says whether a state is live, scheduled or out of date, so it has
  // to be readable: `deep` (teal-ink) is 11.80:1. Nothing is lost — §36 already
  // forbids conveying live state by colour alone, and the word itself carries it.
  cardState: { ...t.stamp, color: color.deep },
  cardLabel: { ...t.small, color: color.ink, fontWeight: '700' },
  cardPlace: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: 2 },
  cardPlaceText: { ...t.small, color: color.mute, flexShrink: 1 },
});
