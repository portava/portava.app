/**
 * MediaPeopleScreen — the PEOPLE lens (spec §5/§27).
 *
 * The explicitly social lens: followed users, Trip Crew, Shared Moment
 * participants, and relevant creators. The §43 /media/people projection groups
 * eligible perspectives BY contributor server-side, so this lens renders a
 * per-person section (identity header + that person's perspective mosaic) rather
 * than a flat creator feed. Creator identity is visible but the section still
 * leads with perspectives, not vanity metrics (§46 / §46.2).
 *
 * Uploading media does NOT imply a precise live location (§27) — this lens shows
 * perspectives, never a live map of people. Visual mode only (§5). Degrades
 * cleanly (§33/§39): 404 / empty ⇒ clean empty state, never a throw.
 */
import React, { useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { BadgeCheck } from 'lucide-react-native';
import { avatar, color, radius, space } from '../../../theme/tokens.ts';
import { CachedImage } from '../../../components/CachedImage.tsx';
import type { MediaProjection } from '../types/media.ts';
import type { PeopleLensGroup, PeopleLensProjection } from '../types/peopleLens.ts';
import { fetchPeople } from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { PerspectiveMosaic } from '../components/PerspectiveMosaic.tsx';
import { FreshnessBadge } from '../components/FreshnessBadge.tsx';
import { LensStateView } from '../components/LensStateView.tsx';

export interface MediaPeopleScreenProps {
  onOpenMedia?: (media: MediaProjection) => void;
}

export function MediaPeopleScreen({ onOpenMedia }: MediaPeopleScreenProps) {
  const fetcher = useCallback((opts: { signal: AbortSignal }) => fetchPeople({ signal: opts.signal }), []);
  const { state, reload } = useLensProjection<PeopleLensProjection>(
    fetcher,
    (data) => data.people.length === 0,
    [],
  );

  if (state.status !== 'ready' || !state.data) {
    return (
      <LensStateView
        status={state.status === 'idle' ? 'loading' : state.status}
        title="Nothing from your people yet"
        message="Perspectives from people you follow, your Trip Crew, and Shared Moments will appear here."
        onRetry={reload}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Text style={styles.intro}>
        From people you follow and your Trip Crew. Sharing a photo never reveals someone&apos;s precise
        live location.
      </Text>
      {state.data.people.map((group) => (
        <PeopleGroupSection key={group.contributor.id} group={group} onOpenMedia={onOpenMedia} />
      ))}
    </ScrollView>
  );
}

function PeopleGroupSection({
  group,
  onOpenMedia,
}: {
  group: PeopleLensGroup;
  onOpenMedia?: (media: MediaProjection) => void;
}) {
  const { contributor: c, perspectiveCount } = group;
  return (
    <View style={styles.group}>
      <View style={styles.header}>
        {c.avatarUrl ? (
          <CachedImage source={{ uri: c.avatarUrl }} style={styles.avatar} resizeMode="cover" />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]} />
        )}
        <View style={{ flex: 1 }}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {c.displayName}
            </Text>
            {c.verified ? <BadgeCheck size={15} color="#3DD6C4" strokeWidth={2.4} /> : null}
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {c.trustLabel
              ? c.trustLabel
              : `${perspectiveCount} ${perspectiveCount === 1 ? 'perspective' : 'perspectives'}`}
          </Text>
        </View>
        <FreshnessBadge freshness={group.freshness} />
      </View>
      <PerspectiveMosaic media={group.media} onOpen={onOpenMedia} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.lg, gap: space.xl, paddingBottom: space.xxxl },
  intro: { color: color.onInkMute, fontSize: 13, lineHeight: 18, paddingHorizontal: space.lg },
  group: { gap: space.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  avatar: { width: avatar.s34, height: avatar.s34, borderRadius: avatar.s34 / 2, backgroundColor: '#22221E' },
  avatarFallback: { backgroundColor: '#2C2C27' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  name: { color: color.onInk, fontSize: 15, fontWeight: '800', letterSpacing: -0.3 },
  meta: { color: color.onInkMute, fontSize: 12, fontWeight: '600', marginTop: 1 },
});
