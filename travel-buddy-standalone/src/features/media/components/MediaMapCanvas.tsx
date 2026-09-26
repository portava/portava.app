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
import { color, icon, space } from '../../../theme/tokens.ts';
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
              paint={{ 'line-color': GEM_ACCENT, 'line-width': 1.5, 'line-opacity': 0.7, 'line-blur': 1.5 }}
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
          const selected = c.placeId === selectedPlaceId;
          return (
            <Marker key={`cluster-${c.placeId}`} lngLat={[c.lng, c.lat]}>
              <Pressable
                testID={`media-map-cluster-${c.placeId}`}
                onPress={() => onSelectCluster?.(c.placeId)}
                accessibilityRole="button"
                accessibilityLabel={`${c.label}: ${c.perspectiveCount} ${c.perspectiveCount === 1 ? 'perspective' : 'perspectives'}`}
                style={[styles.bubble, selected && styles.bubbleSelected]}
              >
                <Text style={styles.bubbleText}>{c.perspectiveCount}</Text>
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
