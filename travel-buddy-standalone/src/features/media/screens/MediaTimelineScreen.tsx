/**
 * MediaTimelineScreen — the §4 "Media Timeline / Time Rail" screen (spec §4 /
 * §17 / §40 / §46; census-media §19).
 *
 * One screen, served by `GET /media/timeline`, rendered both standalone at
 * `/media-timeline` and as the TIME presentation mode of the NOW and PLACES
 * lenses. Before it existed, each lens carried its own private copy of the
 * same load-and-render (`WorldTimeRail`, `PlaceTimeRail`); now they mount this.
 *
 * What it shows, and the lines it will not cross:
 *   • the §17 four-band rail (Earlier · Now · Typical · Likely next) with the
 *     distinct observed / pattern / forecast treatments `MediaTimeRail` owns;
 *   • the observed EARLIER perspectives as a mosaic, newest first — the media
 *     the rail summarises, openable in the viewer;
 *   • a place-scoped timeline when given a canonical `placeId`, else the world
 *     timeline, whose Now / Typical / Likely-Next are empty by design (the
 *     server populates them only for a place subject).
 * A failed refresh over good data renders STALE — the Now band is forced to its
 * neutral state and says "showing last update, not live" (§39 / §46.2).
 */
import React, { useCallback, useMemo } from 'react';
import { ScrollView, Text, StyleSheet } from 'react-native';
import { color, space } from '../../../theme/tokens.ts';
import type { MediaProjection } from '../types/media.ts';
import type { MediaTimelineProjection } from '../types/mediaTimeline.ts';
import { fetchTimeline, isTimelineEmpty, mapTimeline } from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { MediaTimeRail } from '../components/MediaTimeRail.tsx';
import { earlierPerspectives } from '../state/timeBands.ts';
import { PerspectiveMosaic } from '../components/PerspectiveMosaic.tsx';
import { LensStateView } from '../components/LensStateView.tsx';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MediaTimelineScreenProps {
  /** Canonical place UUID to scope Now / Typical / Likely-Next to. Absent ⇒ world. */
  placeId?: string | null;
  /** Header label ("An Thuong"); defaults to the world phrasing. */
  label?: string | null;
  onOpenMedia?: (media: MediaProjection) => void;
}

export function MediaTimelineScreen({ placeId = null, label = null, onOpenMedia }: MediaTimelineScreenProps) {
  const scopedPlace = placeId && UUID_RE.test(placeId) ? placeId : null;
  const labelOnly = placeId != null && scopedPlace == null;
  const fetcher = useCallback(
    (opts: { signal: AbortSignal }) => {
      // A label-only zone (no canonical place UUID) has no place-scoped timeline;
      // short-circuit to a well-formed empty projection rather than a doomed call.
      if (labelOnly) return Promise.resolve({ ok: true as const, data: mapTimeline({}) });
      return fetchTimeline({ placeId: scopedPlace, signal: opts.signal });
    },
    [scopedPlace, labelOnly],
  );
  const { state, reload } = useLensProjection<MediaTimelineProjection>(fetcher, isTimelineEmpty, [scopedPlace, labelOnly]);
  const timeline = state.data;
  // A 'ready' status that still carries an error kind = a failed refresh over
  // good data (SWR). Treat that data as stale so the Now band is not shown live.
  const stale = state.status === 'ready' && state.errorKind != null;
  const earlier = useMemo(() => earlierPerspectives(timeline), [timeline]);

  if (timeline && (state.status === 'ready' || state.status === 'empty' || state.status === 'revalidating')) {
    return (
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} testID="media-timeline-screen">
        <Text style={styles.title}>{label ? `${label} · over time` : 'Right now, and what’s likely next'}</Text>
        <MediaTimeRail bands={timeline.bands} stale={stale} />
        <Text style={styles.note}>
          Earlier and Now are observed. Typical is a historical pattern; Likely next is a forecast —
          shown as “Likely” with its confidence, never presented as fact (§17).
        </Text>
        {earlier.length > 0 ? (
          <>
            <Text style={styles.heading}>Earlier perspectives</Text>
            <PerspectiveMosaic media={earlier} onOpen={onOpenMedia} />
          </>
        ) : null}
      </ScrollView>
    );
  }
  return (
    <LensStateView
      status={state.status === 'idle' ? 'loading' : state.status}
      title="No timeline yet"
      message={
        scopedPlace
          ? 'Earlier, Now, Typical and Likely-Next fill in as this place gathers perspectives and intelligence.'
          : 'As perspectives are shared around you, the Earlier / Now rail fills in here.'
      }
      onRetry={reload}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.xl, gap: space.lg, paddingBottom: space.xxxl },
  title: {
    color: color.onInk,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.3,
    paddingHorizontal: space.lg,
  },
  note: { color: color.onInkMute, fontSize: 12, lineHeight: 18, paddingHorizontal: space.lg },
  heading: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
  },
});
