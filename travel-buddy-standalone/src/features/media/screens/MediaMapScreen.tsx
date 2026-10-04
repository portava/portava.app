/**
 * MediaMapScreen — the §4 "Media Map" screen (spec §4/§21/§40/§46/§46.1;
 * census-media §19).
 *
 * §21: "Media Map consumes the canonical Map projection system; it does not own
 * a second location engine." The screen reads perspective COUNTS per canonical
 * place and positions them with the canonical Map gateway's own `place` objects
 * (`hooks/useMediaMap` → `state/mediaMapStore`). It is the one Media Map, used
 * standalone at `/media-map` AND as the Map presentation mode of the NOW,
 * PLACES, EXPERIENCES, HIDDEN GEMS and MY WORLD lenses — each passes the
 * cluster source it owns, and none of them draws a map of its own.
 *
 * What the viewer sees, in the §21 wireframe's order: the map (when a viewport
 * and positions exist), then the same clusters as a list — "Beach Festival · 24
 * perspectives" — so nothing is ever reachable ONLY by its pin. A cluster the
 * Map did not position is listed under "Not on this map view", never placed at
 * an invented point. Approximate hidden gems are contoured AREAS (§46.1).
 *
 * Tapping a cluster selects it; "See these perspectives" hands it to the
 * caller, which opens the §14 contextual viewer with the MAP entry context
 * (census MD92: "Map → current geographic cluster").
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MapPin, Layers } from 'lucide-react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import { CachedImage } from '../../../components/CachedImage.tsx'; import { clusterCoverImage } from '../state/mediaMapCover.ts'; // each cluster's server-chosen cover (census-media §29)
import { mediaMapOffline, type OfflineResult } from '../../../services/media/mediaOffline.ts'; // §39 "Map thumbnails" (census-media §29, MD300)
import { useMediaMap, MEDIA_MAP_ZOOM } from '../hooks/useMediaMap.ts';
import {
  positionsUnavailableCopy, MEDIA_MAP_PARTIAL_COPY,
  selectMediaMapModel,
  type MediaMapCluster,
} from '../state/mediaMapStore.ts';
import { MediaMapCanvas, isMediaMapCanvasAvailable } from '../components/MediaMapCanvas.tsx';
import { FreshnessBadge } from '../components/FreshnessBadge.tsx';
import { LensStateView } from '../components/LensStateView.tsx';

export interface MediaMapScreenProps {
  /** Coarse city label — the scope `GET /media/map` reads. */
  city?: string | null;
  /** The viewer's COARSE location: the viewport centre. Null ⇒ list only. */
  center?: { lat: number; lng: number } | null;
  /**
   * Override the cluster source. Default: `GET /media/map` for `city`. My World
   * passes the owner's own media grouped by place; the Places / Experiences
   * lenses pass a subset of the world's clusters.
   */
  loadClusters?: (opts: { signal: AbortSignal }) => Promise<OfflineResult<MediaMapCluster[]>>; // `offline` set ⇒ served from the §39 cache, and labelled
  /** Draw §46.1 gem zones from the canonical Map's `hidden_gem` objects. */
  includeGems?: boolean;
  /** Restrict drawn gems to these ids (the §16 lens's own disclosure). */
  allowGemIds?: ReadonlySet<string> | null;
  /** Re-load when any of these change (e.g. the lens's own data). */
  reloadKey?: string;
  title?: string;
  emptyTitle?: string;
  emptyMessage?: string;
  onOpenCluster?: (cluster: MediaMapCluster) => void;
  onOpenGem?: (gemId: string) => void;
}

function defaultLoader(city: string | null) {
  return (opts: { signal: AbortSignal }): Promise<OfflineResult<MediaMapCluster[]>> =>
    mediaMapOffline({ city, signal: opts.signal }).then((r) => // census-media §29: read through the §39 `map_thumbnails` cache; §24 cited this line when it read fetchMediaMap({ city, signal: opts.signal }).then((r) =>
      r.ok ? { ok: true as const, data: r.data.clusters, offline: r.offline } : r,
    );
}

export function MediaMapScreen({
  city = null,
  center = null,
  loadClusters,
  includeGems = false,
  allowGemIds = null,
  reloadKey = '',
  title = 'Media Map',
  emptyTitle = 'No perspectives on the map yet',
  emptyMessage = 'As people share perspectives from places around you, they gather here — by place, never by precise location.',
  onOpenCluster,
  onOpenGem,
}: MediaMapScreenProps) {
  const { loader, cachedLabel } = useCachedLabel(useMemo(() => loadClusters ?? defaultLoader(city), [loadClusters, city]));
  const { state, reload, selectCluster } = useMediaMap({
    loadClusters: loader,
    center,
    includeGems,
    deps: [city, reloadKey],
  });
  const model = useMemo(() => selectMediaMapModel(state, { allowGemIds }), [state, allowGemIds]);

  const onSelect = useCallback(
    (placeId: string) => selectCluster(placeId === state.selectedPlaceId ? null : placeId),
    [selectCluster, state.selectedPlaceId],
  );

  if (state.status === 'idle' || state.status === 'loading' || state.status === 'error' || state.status === 'empty') {
    return (
      <LensStateView
        status={state.status === 'idle' ? 'loading' : state.status}
        title={state.status === 'error' ? 'The Media Map could not load' : emptyTitle}
        message={
          state.status === 'error'
            ? 'We could not read perspective counts right now. Nothing here means "no one is out" — try again.'
            : emptyMessage
        }
        onRetry={reload}
      />
    );
  }

  const unavailableCopy = positionsUnavailableCopy(model.positionsUnavailable);
  const canDraw =
    center != null &&
    model.positionsUnavailable == null &&
    isMediaMapCanvasAvailable() &&
    (model.positioned.length > 0 || model.gemZones.length > 0);
  const listed = [...model.positioned, ...model.unpositioned];

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} testID="media-map-screen">
      <View style={styles.header}>
        <Layers size={16} color={color.onInkMute} strokeWidth={2.2} />
        <Text style={styles.title}>{city ? `${city} · ${title}` : title}</Text>
        {state.totalPerspectives > 0 ? (
          <Text style={styles.total}>
            {state.totalPerspectives} {state.totalPerspectives === 1 ? 'perspective' : 'perspectives'}
          </Text>
        ) : null}
      </View>{cachedLabel ? <Text style={tailStyles.cached} accessibilityRole="text" testID="media-map-cached">{cachedLabel}</Text> : null}{model.positionsPartial ? <Text style={tailStyles.cached} accessibilityRole="text" testID="media-map-partial">{MEDIA_MAP_PARTIAL_COPY}</Text> : null /* census-discovery §114 (DV-83, sweep SW3) */}

      {canDraw && center ? (
        <MediaMapCanvas
          center={center}
          zoom={MEDIA_MAP_ZOOM}
          clusters={model.positioned}
          gemZones={model.gemZones}
          selectedPlaceId={state.selectedPlaceId}
          onSelectCluster={onSelect}
          onSelectGem={onOpenGem}
        />
      ) : unavailableCopy ? (
        <Text style={styles.note} testID="media-map-positions-unavailable">
          {unavailableCopy}
        </Text>
      ) : null}

      {model.gemZones.some((z) => z.treatment === 'approximate_zone') ? (
        <Text style={styles.legend}>Shaded areas are hidden gems shown only approximately — never a doorstep.</Text>
      ) : null}

      {model.selected ? (
        <View style={styles.selected} testID="media-map-selected">
          <Text style={styles.selectedTitle}>{model.selected.label}</Text>
          <Text style={styles.selectedMeta}>
            {model.selected.perspectiveCount}{' '}
            {model.selected.perspectiveCount === 1 ? 'perspective' : 'perspectives'} here
          </Text>
          {onOpenCluster ? (
            <Pressable
              style={styles.openBtn}
              onPress={() => model.selected && onOpenCluster(model.selected)}
              accessibilityRole="button"
              testID="media-map-open-cluster"
            >
              <Text style={styles.openBtnText}>See these perspectives</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <View style={styles.list}>
        {listed.map((c, i) => {
          const firstUnpositioned = i === model.positioned.length && model.unpositioned.length > 0 && canDraw;
          return (
            <React.Fragment key={c.placeId}>
              {firstUnpositioned ? <Text style={styles.subhead}>Not on this map view</Text> : null}
              <Pressable
                style={[styles.row, state.selectedPlaceId === c.placeId && styles.rowSelected]}
                onPress={() => onSelect(c.placeId)}
                accessibilityRole="button"
                accessibilityLabel={`${c.label}, ${c.perspectiveCount} ${c.perspectiveCount === 1 ? 'perspective' : 'perspectives'}`}
                testID={`media-map-row-${c.placeId}`}
              >
                <ClusterRowMark placeId={c.placeId} cover={clusterCoverImage(c)} />
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {c.label}
                </Text>
                <Text style={styles.rowCount}>
                  {c.perspectiveCount} {c.perspectiveCount === 1 ? 'perspective' : 'perspectives'}
                </Text>
                {c.freshness ? <FreshnessBadge freshness={c.freshness} /> : null}
              </Pressable>
            </React.Fragment>
          );
        })}
        {model.gemZones.map((g) => (
          <Pressable
            key={`gem-row-${g.gemId}`}
            style={styles.row}
            onPress={() => onOpenGem?.(g.gemId)}
            accessibilityRole="button"
            testID={`media-map-gem-row-${g.gemId}`}
          >
            <View style={styles.gemDot} />
            <Text style={styles.rowLabel} numberOfLines={1}>
              {g.label}
            </Text>
            <Text style={styles.rowCount}>{g.treatment === 'approximate_zone' ? 'Approximate area' : 'Hidden gem'}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: space.lg, gap: space.md, paddingBottom: space.xxxl },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg },
  title: { flex: 1, color: color.onInk, fontSize: 16, fontWeight: '800', letterSpacing: -0.3 },
  total: { color: color.onInkMute, fontSize: 12, fontWeight: '700' },
  note: { color: color.onInkMute, fontSize: 13, lineHeight: 19, paddingHorizontal: space.lg },
  legend: { color: color.onInkMute, fontSize: 12, lineHeight: 17, paddingHorizontal: space.lg },
  selected: {
    marginHorizontal: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(250,249,246,0.07)',
    gap: 4,
  },
  selectedTitle: { color: color.onInk, fontSize: 16, fontWeight: '800' },
  selectedMeta: { color: color.onInkMute, fontSize: 13, fontWeight: '600' },
  openBtn: {
    alignSelf: 'flex-start',
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: color.onInk,
  },
  openBtnText: { color: color.ink, fontSize: 13, fontWeight: '800' },
  list: { gap: space.xs },
  subhead: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
    marginTop: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(250,249,246,0.05)',
  },
  rowSelected: { backgroundColor: 'rgba(250,249,246,0.12)' },
  rowLabel: { flex: 1, color: color.onInk, fontSize: 15, fontWeight: '700' },
  rowCount: { color: color.onInkMute, fontSize: 12, fontWeight: '700' },
  gemDot: { width: 10, height: 10, transform: [{ rotate: '45deg' }], backgroundColor: '#10B981' },
});

// ── census-media §29 (MD300) — appended at the TAIL so no line cited above moves ──
// (census-media cites :65 and :70; lane H's §27 cites :262.)

type ClusterLoader = (opts: { signal: AbortSignal }) => Promise<OfflineResult<MediaMapCluster[]>>;

/**
 * Whichever cluster source the map was given, remember whether its last answer
 * came from the offline cache, and say so: `cachedLabel` is the "Cached ·
 * updated 2h ago" of that answer, and null the moment a live answer replaces it
 * (the rule `useOfflineLens` keeps for the other lenses). A source that never
 * reads the cache (My World's own media) never sets it. §39: what the map shows
 * from the cache says its age, and nothing on it is presented as live.
 */
function useCachedLabel(base: ClusterLoader): { loader: ClusterLoader; cachedLabel: string | null } {
  const [cachedLabel, setCachedLabel] = useState<string | null>(null);
  const loader = useCallback<ClusterLoader>(
    async (opts) => {
      const r = await base(opts);
      if (!opts.signal.aborted) setCachedLabel(r.ok && r.offline ? r.offline.label : null);
      return r;
    },
    [base],
  );
  return { loader, cachedLabel };
}

/**
 * The mark at the head of a cluster's list row: its server-chosen cover through
 * the signing image component, or, with no cover, the pin it always had.
 */
function ClusterRowMark({ placeId, cover }: { placeId: string; cover: string | null }) {
  if (!cover) return <MapPin size={16} color={color.onInkMute} strokeWidth={2} />;
  return (
    <CachedImage
      source={{ uri: cover }}
      style={tailStyles.rowCover}
      resizeMode="cover"
      fallbackLabel=""
      testID={`media-map-row-cover-${placeId}`}
    />
  );
}

const tailStyles = StyleSheet.create({
  rowCover: { width: 32, height: 32, borderRadius: radius.sm, backgroundColor: '#22221E' },
  cached: { color: color.onInkMute, fontSize: 12, fontWeight: '700', paddingHorizontal: space.lg },
});
