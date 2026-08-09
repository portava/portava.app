/**
 * LocationCheckMapPicker — MapLibre map with pins for geo-tagged saved places.
 * Tapping a pin shows a callout; "Use this location" calls onSelect with the
 * chosen place so the parent LocationCheckSheet can pre-fill lat/lng.
 *
 * Metro selects LocationCheckMapPicker.web.tsx on web builds (returns null),
 * so this file is native-only.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map, Camera, Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { MapPin, Check, X } from 'lucide-react-native';
import type { BookmarkedPlace } from '../../services/discoveryBookmarks.ts';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import { MAP_STYLE_URL as MAP_STYLE } from '../../constants/mapStyle.ts';
import { filterMappable, computeBounds } from '../savedPlacesMapHelpers.ts';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface LocationCheckMapPickerProps {
  places: BookmarkedPlace[];
  /** ID of the currently-selected place (highlights the pin). */
  selectedId: string | null;
  /** Called when the user confirms a place via the callout card. */
  onSelect: (place: BookmarkedPlace) => void;
}

// ── Pin ───────────────────────────────────────────────────────────────────────

function Pin({ selected, onPress }: { selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <View style={[pin.wrap, selected && pin.wrapSelected]}>
        <MapPin size={12} color="#fff" />
      </View>
    </Pressable>
  );
}

const pin = StyleSheet.create({
  wrap: {
    width: avatar.xs, height: avatar.xs,
    borderRadius: avatar.xs / 2,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 4,
  },
  wrapSelected: {
    backgroundColor: color.deep,
    width: avatar.smMd, height: avatar.smMd,
    borderRadius: avatar.smMd / 2,
  },
});

// ── Main ──────────────────────────────────────────────────────────────────────

export function LocationCheckMapPicker({
  places,
  selectedId,
  onSelect,
}: LocationCheckMapPickerProps) {
  const cameraRef = useRef<CameraRef>(null);
  // Internal active pin; kept in sync with external selectedId on mount.
  const [activeId, setActiveId] = useState<string | null>(selectedId);

  const mappable = useMemo(() => filterMappable(places), [places]);
  const active = useMemo(
    () => mappable.find((p) => p.id === activeId) ?? null,
    [mappable, activeId],
  );

  // Fit camera to all visible pins on first render.
  useEffect(() => {
    const bounds = computeBounds(mappable);
    if (!bounds || !cameraRef.current) return;
    cameraRef.current.fitBounds(bounds, {
      padding: { top: 48, right: 24, bottom: 96, left: 24 },
      duration: 400,
    });
  // Run once on mount (mappable reference stabilises after initial load).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (mappable.length === 0) {
    return (
      <View style={s.empty}>
        <MapPin size={22} color={color.faint} />
        <Text style={s.emptyText}>No geo-tagged places to show.</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <Map mapStyle={MAP_STYLE} style={StyleSheet.absoluteFill}>
        <Camera ref={cameraRef} />
        {mappable.map((place) => (
          <Marker key={place.id} lngLat={[place.lng!, place.lat!]}>
            <Pin
              selected={place.id === activeId}
              onPress={() => setActiveId(place.id === activeId ? null : place.id)}
            />
          </Marker>
        ))}
      </Map>

      {/* Callout card overlaid at the bottom of the map */}
      {active != null && (
        <View style={s.callout} testID="map-picker-callout">
          <View style={s.calloutRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.calloutName} numberOfLines={1}>
                {active.name}
              </Text>
              {active.category ? (
                <Text style={s.calloutMeta} numberOfLines={1}>
                  {active.category}
                </Text>
              ) : null}
            </View>
            <Pressable onPress={() => setActiveId(null)} hitSlop={8} accessibilityLabel="Dismiss">
              <X size={15} color={color.mute} />
            </Pressable>
          </View>

          <Pressable
            style={s.selectBtn}
            onPress={() => {
              onSelect(active);
              setActiveId(null);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Use ${active.name}`}
          >
            <Check size={14} color="#fff" />
            <Text style={s.selectBtnText}>Use this location</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    padding: space.xxl,
  },
  emptyText: {
    ...t.small,
    color: color.faint,
    textAlign: 'center',
  },
  callout: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    elevation: 6,
  },
  calloutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  calloutName: {
    ...t.bodyStrong,
    fontSize: 14,
    color: color.ink,
  },
  calloutMeta: {
    ...t.small,
    fontSize: 11,
    color: color.mute,
    textTransform: 'capitalize',
  },
  selectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: color.signal,
    borderRadius: radius.sm,
    paddingVertical: 8,
  },
  selectBtnText: {
    ...t.small,
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
});
