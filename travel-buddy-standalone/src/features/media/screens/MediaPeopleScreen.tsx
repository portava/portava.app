/**
 * MediaPeopleScreen — the PEOPLE lens (spec §5/§27).
 *
 * The explicitly social lens: followed users, Trip Crew, Shared Moment
 * participants, and relevant creators. Uploading media does NOT imply precise
 * live location (§27) — this lens shows perspectives, never a live map of people.
 * Visual mode only (§5). Degrades cleanly while /media/people lands.
 */
import React, { useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { color, space } from '../../../theme/tokens.ts';
import type { MediaProjection } from '../types/media.ts';
import { fetchPeople } from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { PerspectiveMosaic } from '../components/PerspectiveMosaic.tsx';
import { LensStateView } from '../components/LensStateView.tsx';

export interface MediaPeopleScreenProps {
  onOpenMedia?: (media: MediaProjection) => void;
}

export function MediaPeopleScreen({ onOpenMedia }: MediaPeopleScreenProps) {
  const fetcher = useCallback((opts: { signal: AbortSignal }) => fetchPeople({ signal: opts.signal }), []);
  const { state, reload } = useLensProjection<MediaProjection[]>(
    fetcher,
    (data) => data.length === 0,
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
      <View style={styles.mosaicWrap}>
        <PerspectiveMosaic media={state.data} onOpen={onOpenMedia} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.lg, gap: space.md, paddingBottom: space.xxxl },
  intro: { color: color.onInkMute, fontSize: 13, lineHeight: 18, paddingHorizontal: space.lg },
  mosaicWrap: { marginTop: space.xs },
});
