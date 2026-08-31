/**
 * MediaPlacesScreen — the PLACES lens (spec §5/§13/§14).
 *
 * Visual reality organized around canonical Places. The lens overview lists the
 * neighbourhood/place entry points around the viewer (sourced from the World
 * projection's city visual state). Selecting one loads its Place Current View
 * (§13) — the current-picture badge, the perspective mosaic (Street · Entrance
 * · Rooftops …), and, in Time mode, the observed-vs-forecast rail (§17).
 *
 * Everything degrades cleanly while /media/places/:id is landing in the parallel
 * backend PR (a 404 → empty state, never a crash).
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { ChevronLeft, MapPin, Compass, ChevronRight } from 'lucide-react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { PresentationMode, CityVisualZone } from '../types/mediaContext.ts';
import type { PlaceCurrentView } from '../types/perspective.ts';
import type { MediaProjection } from '../types/media.ts';
import type { MediaTimelineProjection } from '../types/mediaTimeline.ts';
import {
  fetchPlaceView,
  isPlaceViewEmpty,
  fetchTimeline,
  isTimelineEmpty,
  mapTimeline,
} from '../services/mediaProjection.ts';
import { useLensProjection } from '../hooks/useLensProjection.ts';
import { CurrentPictureBadge } from '../components/CurrentPictureBadge.tsx';
import { IntelligenceStrip } from '../components/IntelligenceStrip.tsx';
import { PerspectiveMosaic } from '../components/PerspectiveMosaic.tsx';
import { MediaTimeRail } from '../components/MediaTimeRail.tsx';
import { LensStateView } from '../components/LensStateView.tsx';
import { relativeAgeLabel } from '../state/freshness.ts';
import { zoneStateLabel } from '../state/cityPulse.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MediaPlacesScreenProps {
  mode: PresentationMode;
  /** Neighbourhood/place entry points, from the World projection. */
  zones: CityVisualZone[];
  onOpenMedia?: (media: MediaProjection) => void;
  onAskCompass?: (placeId: string) => void;
}

export function MediaPlacesScreen({ mode, zones, onOpenMedia, onAskCompass }: MediaPlacesScreenProps) {
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);

  if (selected) {
    return (
      <PlaceDetail
        placeId={selected.id}
        placeName={selected.name}
        mode={mode}
        onBack={() => setSelected(null)}
        onOpenMedia={onOpenMedia}
        onAskCompass={onAskCompass}
      />
    );
  }

  if (zones.length === 0) {
    return (
      <LensStateView
        status="empty"
        title="No places around you yet"
        message="Places fill in as the World lens learns what's near you."
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
      <Text style={styles.intro}>Places around you — tap one to see its current picture.</Text>
      {zones.map((z) => (
        <Pressable
          key={z.id}
          style={({ pressed }) => [styles.placeRow, pressed && styles.pressed]}
          onPress={() => setSelected({ id: z.id, name: z.name })}
          accessibilityRole="button"
          accessibilityLabel={`Open ${z.name}`}
        >
          <MapPin size={18} color={color.onInkMute} strokeWidth={2} />
          <View style={{ flex: 1 }}>
            <Text style={styles.placeName}>{z.name}</Text>
            <Text style={styles.placeState}>{zoneSubtitle(z)}</Text>
          </View>
          <ChevronRight size={18} color={color.faint} strokeWidth={2} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function PlaceDetail({
  placeId,
  placeName,
  mode,
  onBack,
  onOpenMedia,
  onAskCompass,
}: {
  placeId: string;
  placeName: string;
  mode: PresentationMode;
  onBack: () => void;
  onOpenMedia?: (media: MediaProjection) => void;
  onAskCompass?: (placeId: string) => void;
}) {
  const fetcher = useCallback(
    (opts: { signal: AbortSignal }) => {
      // The §43 place view is keyed by a canonical place UUID. A zone that is only
      // label-resolved (no canonical place) cannot be opened — short-circuit to a
      // clean empty state instead of a doomed 400 (§33/§39 degrade behavior).
      if (!UUID_RE.test(placeId)) {
        return Promise.resolve({ ok: true as const, data: null });
      }
      return fetchPlaceView(placeId, { signal: opts.signal });
    },
    [placeId],
  );
  // Empty when the projection is absent OR carries zero perspectives — a real
  // place with no media yet renders the honest "No current picture" state.
  const { state, reload } = useLensProjection<PlaceCurrentView | null>(
    fetcher,
    isPlaceViewEmpty,
    [placeId],
  );

  const view = state.data ?? null;

  return (
    <View style={styles.detail}>
      <View style={styles.detailHeader}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityLabel="Back to places">
          <ChevronLeft size={24} color={color.onInk} strokeWidth={2} />
        </Pressable>
        <Text style={styles.detailTitle} numberOfLines={1}>
          {view?.placeName ?? placeName}
        </Text>
        {onAskCompass ? (
          <Pressable
            onPress={() => onAskCompass(placeId)}
            hitSlop={10}
            accessibilityLabel="Ask Compass about this place"
          >
            <Compass size={22} color={color.onInk} strokeWidth={2} />
          </Pressable>
        ) : (
          <View style={{ width: 22 }} />
        )}
      </View>

      {mode === 'time' ? (
        // The §17 Time rail is its own place-scoped projection (GET /media/timeline),
        // independent of the current-picture load, so it renders even when this
        // place has no observed media yet (it may still carry Typical / Likely-Next).
        <PlaceTimeRail placeId={placeId} />
      ) : state.status !== 'ready' || !view ? (
        <LensStateView
          status={state.status === 'idle' ? 'loading' : state.status}
          title="No current picture yet"
          message="When people share perspectives from here, the current view appears."
          onRetry={reload}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.detailContent} showsVerticalScrollIndicator={false}>
          <View style={styles.pictureBlock}>
            {view.stateLabel ? <Text style={styles.stateLabel}>{view.stateLabel}</Text> : null}
            {view.areaName ? <Text style={styles.areaLabel}>{view.areaName}</Text> : null}
            <CurrentPictureBadge
              strength={view.currentPicture.strength}
              sourceCount={view.currentPicture.sourceCount}
            />
            <Text style={styles.coverage}>
              {view.currentPicture.perspectiveCount}{' '}
              {view.currentPicture.perspectiveCount === 1 ? 'perspective' : 'perspectives'} ·{' '}
              {view.currentPicture.contributorCount}{' '}
              {view.currentPicture.contributorCount === 1 ? 'contributor' : 'contributors'}
              {relativeAgeLabel(view.currentPicture.ageMinutes)
                ? ` · updated ${relativeAgeLabel(view.currentPicture.ageMinutes)}`
                : ''}
            </Text>
          </View>

          {view.heroMedia[0] ? (
            <View style={styles.heroStripBlock}>
              <IntelligenceStrip
                observationClass={view.heroMedia[0].observationClass}
                freshness={view.heroMedia[0].freshness}
                ageMinutes={view.heroMedia[0].ageMinutes}
                perspectiveLabel={view.heroMedia[0].perspectiveKey ?? null}
              />
            </View>
          ) : null}

          {mode === 'map' ? (
            <Text style={styles.mapNote}>
              Place-level perspective clusters on the map arrive with the Media Map phase.
            </Text>
          ) : (
            <PerspectiveMosaic
              media={view.heroMedia}
              groups={view.groups}
              onOpen={onOpenMedia}
            />
          )}
        </ScrollView>
      )}
    </View>
  );
}

/** Zone list sub-line: the live state when present, else honest coverage copy. */
function zoneSubtitle(z: CityVisualZone): string {
  if (z.state != null) return zoneStateLabel(z.state);
  if (z.perspectiveCount != null && z.perspectiveCount > 0) {
    return `${z.perspectiveCount} ${z.perspectiveCount === 1 ? 'perspective' : 'perspectives'}`;
  }
  return 'Tap to see its current picture';
}

/**
 * PLACES → Time mode: the §17 four-band rail for a place, sourced from the real
 * GET /media/timeline bands (Earlier / Now / Typical / Likely-Next). Loads
 * independently of the current-picture view and degrades cleanly (§33/§39):
 * empty ⇒ empty bands (rendered as neutral states), a failed refresh keeps the
 * last good data (SWR) but is flagged `stale` so it is never shown as live.
 */
function PlaceTimeRail({ placeId }: { placeId: string }) {
  const fetcher = useCallback(
    (opts: { signal: AbortSignal }) => {
      // A label-only zone (no canonical place UUID) has no place-scoped timeline;
      // short-circuit to a well-formed empty projection rather than a doomed call.
      if (!UUID_RE.test(placeId)) {
        return Promise.resolve({ ok: true as const, data: mapTimeline({}) });
      }
      return fetchTimeline({ placeId, signal: opts.signal });
    },
    [placeId],
  );
  const { state, reload } = useLensProjection<MediaTimelineProjection>(fetcher, isTimelineEmpty, [placeId]);
  const timeline = state.data;
  // A 'ready' status that still carries an error kind = a failed refresh over
  // good data (SWR). Treat that data as stale so the Now band is not shown live.
  const stale = state.status === 'ready' && state.errorKind != null;

  if (timeline && (state.status === 'ready' || state.status === 'empty' || state.status === 'revalidating')) {
    return (
      <ScrollView contentContainerStyle={styles.timeScroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.timeIntro}>Earlier · Now · Typical · Likely next</Text>
        <MediaTimeRail bands={timeline.bands} stale={stale} />
      </ScrollView>
    );
  }
  return (
    <LensStateView
      status={state.status === 'idle' ? 'loading' : state.status}
      title="No timeline yet"
      message="Earlier, Now, Typical and Likely-Next fill in as this place gathers perspectives and intelligence."
      onRetry={reload}
    />
  );
}

const styles = StyleSheet.create({
  listContent: { paddingVertical: space.lg, gap: space.sm, paddingBottom: space.xxxl },
  intro: { color: color.onInkMute, fontSize: 13, lineHeight: 18, paddingHorizontal: space.lg, marginBottom: space.xs },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(250,249,246,0.05)',
  },
  pressed: { opacity: 0.7 },
  placeName: { color: color.onInk, fontSize: 16, fontWeight: '800', letterSpacing: -0.3 },
  placeState: { color: color.onInkMute, fontSize: 12, fontWeight: '600', marginTop: 1 },
  detail: { flex: 1 },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  detailTitle: { flex: 1, color: color.onInk, fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  detailContent: { gap: space.lg, paddingBottom: space.xxxl },
  pictureBlock: { paddingHorizontal: space.lg, gap: space.sm },
  stateLabel: { color: color.onInk, fontSize: 22, fontWeight: '800', letterSpacing: -0.6 },
  areaLabel: { color: color.onInkMute, fontSize: 13, fontWeight: '700', marginTop: -2 },
  coverage: { color: color.onInkMute, fontSize: 13, fontWeight: '600' },
  heroStripBlock: { paddingHorizontal: space.lg },
  timeScroll: { paddingTop: space.sm, paddingBottom: space.xxxl, gap: space.md },
  timeIntro: {
    color: color.onInkMute,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    paddingHorizontal: space.lg,
  },
  mapNote: { color: color.onInkMute, fontSize: 14, lineHeight: 20, paddingHorizontal: space.lg },
});
