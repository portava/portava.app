/**
 * CrowdFlowCard — "WHERE THE NIGHT IS MOVING" in the NOW lens (spec §22 Crowd
 * Flow Integration; census-media MD162 §51; lead ruling D-26d).
 *
 *   WHERE THE NIGHT IS MOVING
 *   Beachfront        12 perspectives ● Fresh
 *        ↓
 *   An Thuong          8 perspectives ● Recent
 *   Activity appears to be moving toward An Thuong
 *
 * "Never expose individual routes." The card draws NO map, NO line and NO
 * coordinate: two zone names the Map gateway published, the spec's own "↓"
 * between them, the perspective counts at each zone's listed places, and the
 * spec's sentence about the destination zone. A flow's cohort size, its zone
 * ids, its geometry and its signal families are never rendered. Nothing here
 * names a person, a time a person moved, or a photo's author.
 *
 * No empty state, on purpose: with no flow to pair — flags off, a failed read,
 * an unread or partial end, nothing recent at either end — the card renders
 * nothing, so a failure is never shown as "the night is quiet".
 *
 * An end with recent perspectives opens its busiest place through the same §14
 * cluster opener the Media Map uses (`onOpenEnd`). An end with none shows its
 * name only — never "no perspectives here", which the client cannot know.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import { FreshnessBadge } from './FreshnessBadge.tsx';
import type { MediaMapCluster } from '../state/mediaMapStore.ts';
import type { NightFlowCardModel, NightFlowEndView } from '../state/crowdFlowPairing.ts';
import { useMediaCrowdFlow } from '../hooks/useMediaCrowdFlow.ts';

export const NIGHT_FLOW_HEADING = 'Where the night is moving';

export interface CrowdFlowCardProps {
  cards: readonly NightFlowCardModel[];
  /** Open an end's busiest recent place (the §14 cluster opener). */
  onOpenEnd?: (cluster: MediaMapCluster) => void;
}

function perspectivesLabel(n: number): string {
  return `${n} ${n === 1 ? 'perspective' : 'perspectives'}`;
}

function FlowEnd({
  end,
  onOpenEnd,
  testID,
}: {
  end: NightFlowEndView;
  onOpenEnd?: (cluster: MediaMapCluster) => void;
  testID: string;
}) {
  const paired = end.perspectiveCount > 0;
  const top = end.top;
  const pressable = paired && top !== null && onOpenEnd !== undefined;
  return (
    <Pressable
      style={({ pressed }) => [styles.end, pressed && pressable && styles.endPressed]}
      onPress={pressable ? () => onOpenEnd!(top!) : undefined}
      disabled={!pressable}
      accessibilityRole={pressable ? 'button' : undefined}
      accessibilityLabel={paired ? `${end.name}, ${perspectivesLabel(end.perspectiveCount)}` : end.name}
      testID={testID}
    >
      <Text style={styles.zoneName} numberOfLines={1}>
        {end.name}
      </Text>
      {paired ? (
        <View style={styles.endMeta}>
          <Text style={styles.count}>{perspectivesLabel(end.perspectiveCount)}</Text>
          {end.freshness ? <FreshnessBadge freshness={end.freshness} /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

export function CrowdFlowCard({ cards, onOpenEnd }: CrowdFlowCardProps) {
  if (cards.length === 0) return null;
  return (
    <View style={styles.card} testID="night-flow-card">
      <Text style={styles.heading} accessibilityRole="header">
        {NIGHT_FLOW_HEADING}
      </Text>
      {cards.map((c, i) => (
        <View key={c.key} style={styles.flow} testID={`night-flow-${i}`}>
          <FlowEnd end={c.from} onOpenEnd={onOpenEnd} testID={`night-flow-${i}-from`} />
          <Text style={styles.toward} accessibilityLabel="toward">
            ↓
          </Text>
          <FlowEnd end={c.to} onOpenEnd={onOpenEnd} testID={`night-flow-${i}-to`} />
          <Text style={styles.sentence}>{c.sentence}</Text>
        </View>
      ))}
    </View>
  );
}

export interface NowCrowdFlowSectionProps {
  /** The coarse city label `GET /media/map` reads. */
  city: string | null;
  /** The viewer's coarse location. Null ⇒ nothing is read and nothing renders. */
  center: { lat: number; lng: number } | null;
  /** Re-read when the World dashboard reloads. */
  refreshKey?: string | null;
  onOpenEnd?: (cluster: MediaMapCluster) => void;
  style?: StyleProp<ViewStyle>;
}

/** The NOW lens's mount: reads, pairs, and renders the card — or nothing. */
export function NowCrowdFlowSection({ city, center, refreshKey = null, onOpenEnd, style }: NowCrowdFlowSectionProps) {
  const cards = useMediaCrowdFlow({ city, center, refreshKey });
  if (cards.length === 0) return null;
  return (
    <View style={style}>
      <CrowdFlowCard cards={cards} onOpenEnd={onOpenEnd} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(250,249,246,0.05)',
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  heading: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  flow: { gap: space.xs },
  end: { gap: space.xs, paddingVertical: 2 },
  endPressed: { opacity: 0.6 },
  zoneName: { color: color.onInk, fontSize: 15, fontWeight: '700' },
  endMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  count: { color: color.onInkMute, fontSize: 12, fontWeight: '600' },
  toward: { color: color.onInkMute, fontSize: 15, fontWeight: '700', paddingLeft: space.xs },
  sentence: { color: color.onInk, fontSize: 13, lineHeight: 18, marginTop: space.xs },
});
