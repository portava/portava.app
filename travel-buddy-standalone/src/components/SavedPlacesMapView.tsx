/**
 * SavedPlacesMapView — renders bookmarked Discovery places as pins on a
 * MapLibre map (native iOS/Android only).
 *
 * Metro automatically selects SavedPlacesMapView.web.tsx on web builds,
 * so this file is compiled only for native.
 *
 * Requires: @maplibre/maplibre-react-native (task #566 scaffold).
 * Requires an EAS dev build — does not run in Expo Go.
 *
 * Style: uses MapTiler Streets when EXPO_PUBLIC_MAPTILER_KEY is set,
 * otherwise falls back to the MapLibre demo tiles.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map, Camera, Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
import type { CameraRef, LngLatBounds } from '@maplibre/maplibre-react-native';
import { MapPin, Route, X } from 'lucide-react-native';
import { getPlaceCategoryFallback } from '../utils/placeCategoryFallback.ts';
import type { BookmarkedPlace } from '../services/discoveryBookmarks.ts';
import { color, space, radius, type as t, avatar } from '../theme/tokens.ts';
import {
  UNCATEGORIZED,
  filterMappable,
  uniqueCategories,
  categoryCounts,
  resolveStoredCategory,
  resolveSelectedId,
  filterVisible,
  shouldShowNoPinsOverlay,
  computeBounds,
} from './savedPlacesMapHelpers.ts';
import {
  categoryStorageKey,
  readRawCategoryFilter,
  saveCategoryFilter,
} from './savedPlacesMapFilterStorage.ts';

// ── Map style ─────────────────────────────────────────────────────────────────

import { MAP_STYLE_URL as MAP_STYLE } from '../constants/mapStyle.ts';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface SavedPlacesMapViewProps {
  places: BookmarkedPlace[];
  onPlanRoute: (place: BookmarkedPlace) => void;
  /** Stable identifier used to key the persisted category filter.
   *  Defaults to 'global' (the single shared wishlist).
   *  Pass a trip or wishlist id to give each list an independent filter state. */
  listId?: string;
}

// ── Pin component ─────────────────────────────────────────────────────────────

interface PinProps {
  selected: boolean;
  onPress: () => void;
}

function Pin({ selected, onPress }: PinProps) {
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <View style={[pin.wrap, selected && pin.wrapSelected]}>
        <MapPin size={14} color="#fff" />
      </View>
    </Pressable>
  );
}

const pin = StyleSheet.create({
  wrap: {
    width: avatar.xsSm,
    height: avatar.xsSm,
    borderRadius: avatar.xsSm / 2,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 4,
  },
  wrapSelected: {
    backgroundColor: color.deep,
    width: avatar.md, height: avatar.md,
    borderRadius: avatar.md / 2,
  },
});

// ── Callout card ──────────────────────────────────────────────────────────────

interface CalloutCardProps {
  place: BookmarkedPlace;
  onPlanRoute: () => void;
  onDismiss: () => void;
}

function CalloutCard({ place, onPlanRoute, onDismiss }: CalloutCardProps) {
  const fallback = getPlaceCategoryFallback(place.category);
  return (
    <View style={card.wrap}>
      <View style={card.header}>
        <View style={[card.icon, { backgroundColor: fallback.color + '20' }]}>
          <Text style={{ fontSize: 16 }}>{fallback.emoji}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={card.name} numberOfLines={1}>{place.name}</Text>
          {place.category ? (
            <Text style={card.meta} numberOfLines={1}>{place.category}</Text>
          ) : null}
          {place.address ? (
            <Text style={card.address} numberOfLines={1}>{place.address}</Text>
          ) : null}
        </View>
        <Pressable onPress={onDismiss} hitSlop={8}>
          <X size={16} color={color.mute} />
        </Pressable>
      </View>
      <Pressable style={card.routeBtn} onPress={onPlanRoute}>
        <Route size={13} color="#fff" />
        <Text style={card.routeBtnText}>Plan route</Text>
      </Pressable>
    </View>
  );
}

const card = StyleSheet.create({
  wrap: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  icon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: `${color.signal}15`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    ...t.bodyStrong,
    fontSize: 14,
    color: color.ink,
  },
  meta: {
    ...t.small,
    fontSize: 11,
    color: color.mute,
    textTransform: 'capitalize',
  },
  address: {
    ...t.small,
    fontSize: 11,
    color: color.faint,
  },
  routeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: color.signal,
    borderRadius: radius.sm,
    paddingVertical: 8,
  },
  routeBtnText: {
    ...t.small,
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
});

// ── Category filter chips ─────────────────────────────────────────────────────

interface CategoryChipsProps {
  categories: string[];
  counts: Record<string, number>;
  totalCount: number;
  selected: string | null;
  onSelect: (cat: string | null) => void;
}

function CategoryChips({ categories, counts, totalCount, selected, onSelect }: CategoryChipsProps) {
  // Hide when fewer than 2 distinct categories exist: with 0 or 1 category,
  // switching between "All" and the single chip would show the same set of pins,
  // so the chips add noise without giving the user any meaningful filter choice.
  if (categories.length < 2) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={chips.row}
      contentContainerStyle={chips.content}
    >
      <Pressable
        testID="map-chip-all"
        accessibilityLabel={`All, ${totalCount} places`}
        style={[chips.chip, selected === null && chips.active]}
        onPress={() => onSelect(null)}
      >
        <Text style={[chips.label, selected === null && chips.activeLabel]}>
          All ({totalCount})
        </Text>
      </Pressable>
      {categories.map((cat) => {
        const label = cat === UNCATEGORIZED ? 'Uncategorized' : cat;
        const count = counts[cat] ?? 0;
        return (
          <Pressable
            key={cat}
            testID={`map-chip-${cat}`}
            accessibilityLabel={`${label}, ${count} places`}
            style={[chips.chip, selected === cat && chips.active]}
            onPress={() => onSelect(cat)}
          >
            <Text style={[chips.label, selected === cat && chips.activeLabel]}>
              {label} ({count})
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const chips = StyleSheet.create({
  row: {
    position: 'absolute',
    top: 12,
    left: 0,
    right: 0,
    flexGrow: 0,
  },
  content: {
    gap: 6,
    paddingHorizontal: 12,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.90)',
    borderWidth: 1,
    borderColor: color.haze,
  },
  active: {
    backgroundColor: color.signal,
    borderColor: color.signal,
  },
  label: {
    ...t.small,
    fontSize: 12,
    fontWeight: '600',
    color: color.ink,
    textTransform: 'capitalize',
  },
  activeLabel: {
    color: '#fff',
  },
});

// ── Main component ────────────────────────────────────────────────────────────

export function SavedPlacesMapView({ places, onPlanRoute, listId = 'global' }: SavedPlacesMapViewProps) {
  const cameraRef = useRef<CameraRef>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const mappable = useMemo(() => filterMappable(places), [places]);

  const categories = useMemo(() => uniqueCategories(mappable), [mappable]);
  const counts     = useMemo(() => categoryCounts(mappable), [mappable]);

  // Resolve the effective category synchronously during render so that when the
  // last pin in a category is removed, the filter resets to "All" in the same
  // render pass — eliminating the one-frame "No pins in this category" flash
  // that a useEffect reset would cause.
  const effectiveCategory = useMemo(
    () => resolveStoredCategory(activeCategory, categories),
    [activeCategory, categories],
  );

  const storageKey = categoryStorageKey(listId);

  // Always-current ref so the async restore callback validates against the
  // latest categories, not the closure snapshot captured when the effect ran.
  const categoriesRef = useRef<string[]>(categories);
  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);

  // Restore persisted category on mount (or when listId changes).
  //
  // Uses readRawCategoryFilter (no categories snapshot) + categoriesRef so the
  // stored value is validated against the LATEST categories when the Promise
  // resolves. This fixes a race condition where a fast network refresh could
  // repopulate categories between the effect firing and the Promise resolving,
  // causing a valid stored category to be silently discarded as stale.
  useEffect(() => {
    let cancelled = false;
    readRawCategoryFilter(AsyncStorage, storageKey).then((raw) => {
      if (cancelled) return;
      if (raw && categoriesRef.current.includes(raw)) {
        setActiveCategory(raw);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  const visible = useMemo(
    () => filterVisible(mappable, effectiveCategory),
    [mappable, effectiveCategory],
  );

  const selected = useMemo(
    () => visible.find((p) => p.id === selectedId) ?? null,
    [visible, selectedId],
  );

  // If the selected place disappears from the visible list (removed or filtered
  // out), clear selectedId so the callout card is dismissed immediately.
  useEffect(() => {
    const resolved = resolveSelectedId(selectedId, visible);
    if (resolved !== selectedId) setSelectedId(resolved);
  }, [visible, selectedId]);

  // Fit camera to the visible places whenever the list changes
  useEffect(() => {
    const bounds = computeBounds(visible);
    if (!bounds || !cameraRef.current) return;
    cameraRef.current.fitBounds(bounds, { padding: { top: 56, right: 24, bottom: 160, left: 24 }, duration: 500 });
  }, [visible]);

  // Clear selection and persist category when it changes.
  const handleCategoryChange = useCallback((cat: string | null) => {
    setActiveCategory(cat);
    setSelectedId(null);
    saveCategoryFilter(AsyncStorage, storageKey, cat);
  }, [storageKey]);

  if (mappable.length === 0) {
    return (
      <View style={s.empty}>
        <View style={s.emptyIcon}>
          <MapPin size={28} color={color.faint} />
        </View>
        <Text style={s.emptyTitle}>No pins available</Text>
        <Text style={s.emptyBody}>
          Save places with coordinates from Discovery to see them on the map.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Map mapStyle={MAP_STYLE} style={{ flex: 1 }}>
        <Camera ref={cameraRef} />
        {visible.map((place) => (
          <Marker
            key={place.id}
            lngLat={[place.lng!, place.lat!]}
          >
            <Pin
              selected={place.id === selectedId}
              onPress={() => setSelectedId(place.id === selectedId ? null : place.id)}
            />
          </Marker>
        ))}
      </Map>

      {/* Category filter chips — overlaid at the top of the map */}
      <CategoryChips
        categories={categories}
        counts={counts}
        totalCount={mappable.length}
        selected={effectiveCategory}
        onSelect={handleCategoryChange}
      />

      {/* Selected place callout card — overlaid at the bottom */}
      {selected != null && (
        <CalloutCard
          place={selected}
          onPlanRoute={() => { onPlanRoute(selected); setSelectedId(null); }}
          onDismiss={() => setSelectedId(null)}
        />
      )}

      {/* "No pins in this category" overlay — shown when the active filter yields zero pins */}
      {shouldShowNoPinsOverlay(effectiveCategory, visible.length) && (
        <View style={s.noPinsOverlay}>
          <View style={s.noPinsIcon}>
            <MapPin size={22} color={color.faint} />
          </View>
          <Text style={s.noPinsTitle}>No pins in this category</Text>
          <Text style={s.noPinsBody}>None of your saved places in "{effectiveCategory}" have map coordinates.</Text>
        </View>
      )}

      {/* "N places without coords" notice */}
      {places.length - mappable.length > 0 && selectedId === null && (
        <View style={s.noCoordsNotice}>
          <Text style={s.noCoordsText}>
            {places.length - mappable.length} saved place
            {places.length - mappable.length === 1 ? '' : 's'} without coordinates not shown
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.xxl,
  },
  emptyIcon: {
    width: avatar.xxl, height: avatar.xxl,
    borderRadius: avatar.xxl / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    ...t.title,
    fontSize: 16,
    color: color.mute,
  },
  emptyBody: {
    ...t.body,
    color: color.faint,
    textAlign: 'center',
    maxWidth: 260,
  },
  noPinsOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.82)',
    gap: space.sm,
    paddingHorizontal: space.xxl,
  },
  noPinsIcon: {
    width: avatar.xl, height: avatar.xl,
    borderRadius: avatar.xl / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noPinsTitle: {
    ...t.title,
    fontSize: 15,
    color: color.mute,
    textAlign: 'center',
  },
  noPinsBody: {
    ...t.body,
    fontSize: 13,
    color: color.faint,
    textAlign: 'center',
    maxWidth: 240,
  },
  noCoordsNotice: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.60)',
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  noCoordsText: {
    color: '#fff',
    fontSize: 12,
  },
});
