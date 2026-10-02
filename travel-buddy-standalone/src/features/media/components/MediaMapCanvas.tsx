/**
 * MediaMapCanvas — the §21 Media Map's drawn surface (census-media §19).
 *
 * Draws ONLY what `state/mediaMapStore.selectMediaMapModel` positioned from the
 * canonical Map gateway: a count bubble per positioned perspective cluster, and
 * the §46.1 gem treatments — an APPROXIMATE gem as a contoured zone (a filled
 * wash plus a contour line, never a pin) and a place-level gem as a contoured
 * marker. It has no coordinate source of its own and never computes one.
 *
 * MapLibre is safe-required, exactly as RouteMinimapView does: a static import
 * registers native views at module evaluation and crashes route registration on
 * dev builds, and on web the module is absent. When the map component cannot
 * load, the canvas renders nothing and the screen's list carries the content.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map: MLMap, Camera, Marker, GeoJSONSource, Layer } = _ml as typeof import('@maplibre/maplibre-react-native');
import { avatar, color, icon, space } from '../../../theme/tokens.ts';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import {
  FALLBACK_MAP_STYLE_URL,
  DARK_MAP_STYLE_URL,
  PORTAVA_DARK_MAP_STYLE,
} from '../../../constants/mapStyle.ts';
import { gemZoneFeatures, type GemZone, type PositionedCluster } from '../state/mediaMapStore.ts';
import { GEM_ACCENT } from '../state/gemLens.ts';

export interface MediaMapCanvasProps {
  center: { lat: number; lng: number };
  zoom?: number;
  clusters: PositionedCluster[];
  gemZones: GemZone[];
  selectedPlaceId?: string | null;
  onSelectCluster?: (placeId: string) => void;
  onSelectGem?: (gemId: string) => void;
  height?: number;
}

/** True when the native map component resolved (false on web / in a failed require). */
export function isMediaMapCanvasAvailable(): boolean {
  return typeof MLMap === 'function' || (typeof MLMap === 'object' && MLMap !== null);
}

export function MediaMapCanvas({
  center,
  zoom = 12,
  clusters,
  gemZones,
  selectedPlaceId,
  onSelectCluster,
  onSelectGem,
  height = 320,
}: MediaMapCanvasProps) {
  // §46 night-first foundation: the same dark chain the Discovery map uses —
  // Portava's dark style object → the keyless dark URL → demotiles.
  const [mapStyle, setMapStyle] = useState<StyleSpecification | string>(PORTAVA_DARK_MAP_STYLE);
  const zoneData = useMemo(() => gemZoneFeatures(gemZones), [gemZones]);
  const markerGems = useMemo(() => gemZones.filter((z) => z.treatment === 'contour_marker'), [gemZones]);

  if (!isMediaMapCanvasAvailable()) return null;

  return (
    <View style={[styles.wrap, { height }]} testID="media-map-canvas">
      <MLMap
        style={StyleSheet.absoluteFill}
        mapStyle={mapStyle}
        logo={false}
        attributionPosition={{ bottom: 4, right: 4 }}
        onDidFailLoadingMap={() => {
          if (mapStyle === PORTAVA_DARK_MAP_STYLE) setMapStyle(DARK_MAP_STYLE_URL);
          else if (mapStyle !== FALLBACK_MAP_STYLE_URL) setMapStyle(FALLBACK_MAP_STYLE_URL);
        }}
      >
        <Camera initialViewState={{ center: [center.lng, center.lat], zoom }} />

        {zoneData.features.length > 0 ? (
          <GeoJSONSource id="media-gem-zones" data={zoneData}>
            {/* §46.1 approximate zone: a soft wash — an AREA, not a point. */}
            <Layer
              id="media-gem-zone-fill"
              type="fill"
              paint={{ 'fill-color': GEM_ACCENT, 'fill-opacity': 0.12 }}
            />
            {/* §46.1 discovery contour around the area. Solid, not dashed: a
                dashed edge means a FORECAST in the map vocabulary (zoneStyle). */}
            <Layer
              id="media-gem-zone-contour"
              type="line"
              paint={{ 'line-color': GEM_ACCENT, 'line-width': 1.5, 'line-opacity': 1, 'line-blur': 1.5 }} // census-media §31: at 0.7 it fell to 2.65:1 over road casings; at 1 its floor over the dark map is 3.87:1
            />
          </GeoJSONSource>
        ) : null}

        {markerGems.map((g) => (
          <Marker key={`gem-${g.gemId}`} lngLat={[g.lng, g.lat]}>
            <Pressable
              testID={`media-map-gem-${g.gemId}`}
              onPress={() => onSelectGem?.(g.gemId)}
              accessibilityRole="button"
              accessibilityLabel={`Hidden gem: ${g.label}`}
              style={styles.gemMarker}
            >
              <View style={styles.gemCore} />
            </Pressable>
          </Marker>
        ))}

        {clusters.map((c) => {
          const selected = c.placeId === selectedPlaceId; const cover = clusterCoverImage(c); // §39 "Map thumbnails": the server-chosen cover, or none (census-media §29)
          return (
            <Marker key={`cluster-${c.placeId}`} lngLat={[c.lng, c.lat]}>
              <Pressable
                testID={`media-map-cluster-${c.placeId}`}
                onPress={() => onSelectCluster?.(c.placeId)}
                accessibilityRole="button"
                accessibilityLabel={`${c.label}: ${c.perspectiveCount} ${c.perspectiveCount === 1 ? 'perspective' : 'perspectives'}`}
                style={cover ? [tailStyles.coverBubble, selected && tailStyles.coverBubbleSelected] : [styles.bubble, selected && styles.bubbleSelected]}
              >
                <ClusterBubbleFace placeId={c.placeId} cover={cover} count={c.perspectiveCount} selected={selected} />
              </Pressable>
            </Marker>
          );
        })}
      </MLMap>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: space.lg,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#1A1A17',
  },
  bubble: {
    minWidth: 30,
    height: 30,
    paddingHorizontal: 8,
    borderRadius: 15,
    backgroundColor: 'rgba(17,17,15,0.86)',
    borderWidth: 1.5,
    borderColor: color.onInk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleSelected: { backgroundColor: color.onInk },
  bubbleText: { color: color.onInk, fontSize: 12, fontWeight: '800' },
  // §46.1 contoured gem marker: a geometric discovery marker with an edge glow.
  gemMarker: {
    width: icon.s26,
    height: icon.s26,
    borderRadius: icon.s26 / 2,
    borderWidth: 1.5,
    borderColor: GEM_ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: GEM_ACCENT,
    shadowOpacity: 0.5,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    backgroundColor: 'rgba(16,185,129,0.12)',
  },
  gemCore: {
    width: 9,
    height: 9,
    transform: [{ rotate: '45deg' }],
    backgroundColor: GEM_ACCENT,
  },
});

// ── census-media §29 — appended at the TAIL so no line cited above moves ──────
// (census-media cites :80 and :92; lane H's §27 cites :150 and :151.)

/**
 * What a cluster bubble shows.
 *   • With a cover (§39 "Map thumbnails", MD300): the ONE image the server chose
 *     for the cluster, drawn through the signing image component, with the
 *     count as a badge.
 *   • Without one: the count, exactly as before covers existed.
 *
 * A SELECTED bubble is filled `color.onInk` (`styles.bubbleSelected`), and its
 * count used to stay `color.onInk` too: 1.00:1, invisible (found by lane H,
 * census-media §27). Selected, the count is now `color.ink`, the same pair the
 * Media Map's own "See these perspectives" button uses.
 */
function ClusterBubbleFace({
  placeId,
  cover,
  count,
  selected,
}: {
  placeId: string;
  cover: string | null;
  count: number;
  selected: boolean;
}) {
  if (!cover) {
    return (
      <Text style={[styles.bubbleText, selected && tailStyles.bubbleTextSelected]} testID={`media-map-cluster-count-${placeId}`}>
        {count}
      </Text>
    );
  }
  return (
    <>
      <CachedImage
        source={{ uri: cover }}
        style={tailStyles.coverImg}
        resizeMode="cover"
        fallbackLabel=""
        testID={`media-map-cover-${placeId}`}
      />
      <View style={tailStyles.coverCount}>
        <Text style={tailStyles.coverCountText}>{count}</Text>
      </View>
    </>
  );
}

const tailStyles = StyleSheet.create({
  // Selected bubble: ink on the onInk fill (lane H, census-media §27).
  bubbleTextSelected: { color: color.ink },
  // A cluster with a cover: the image in a ringed circle, its count as a badge.
  coverBubble: {
    width: avatar.s40,
    height: avatar.s40,
    borderRadius: avatar.s40 / 2,
    borderWidth: 2,
    borderColor: color.onInk,
    backgroundColor: '#22221E',
  },
  // Selected: larger and heavier-ringed. Not the gem accent — green means a gem here.
  coverBubbleSelected: { borderWidth: 3, transform: [{ scale: 1.15 }] },
  coverImg: { width: '100%', height: '100%', borderRadius: avatar.s40 / 2 - 2 },
  coverCount: {
    position: 'absolute',
    right: -6,
    bottom: -6,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: 'rgba(17,17,15,0.92)',
    borderWidth: 1,
    borderColor: color.onInk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverCountText: { color: color.onInk, fontSize: 11, fontWeight: '800' },
});

// Imported at the TAIL so no cited line above moves; ESM hoists them.
import { CachedImage } from '../../../components/CachedImage.tsx';
import { clusterCoverImage } from '../state/mediaMapCover.ts';
