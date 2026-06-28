import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, FlatList, StyleSheet,
  ActivityIndicator, Pressable,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { Chip } from '../src/components/ui';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { listSaved, type BookmarkedPlace } from '../src/services/discoveryBookmarks';
import { MapPin, Bookmark, Route, List, Map, Trash2 } from 'lucide-react-native';
import { RouteBuilderSheet } from '../src/components/RouteBuilderSheet';
import { SavedPlacesMapView } from '../src/components/SavedPlacesMapView';
import { removeSaved } from '../src/services/discoveryBookmarks';
import { placesForTab } from '../src/components/savedPlacesMapHelpers';

const TABS = ['Places', 'Hotels', 'Nightlife', 'Itineraries'];

const LIST_CAT_KEY      = 'saved_places_list_cat_v1_global';
const VIEW_MODE_KEY     = 'saved_places_view_mode_v1';

// ── Place list card ───────────────────────────────────────────────────────────

interface PlaceCardProps {
  place: BookmarkedPlace;
  onAddToRoute: (place: BookmarkedPlace) => void;
  onRemove: (id: string) => void;
}

function PlaceCard({ place, onAddToRoute, onRemove }: PlaceCardProps) {
  return (
    <View style={s.card}>
      <View style={s.cardIcon}>
        <MapPin size={16} color={color.signal} />
      </View>
      <View style={s.cardBody}>
        <Text style={s.cardName} numberOfLines={1}>{place.name}</Text>
        {place.category ? (
          <Text style={s.cardMeta} numberOfLines={1}>{place.category}</Text>
        ) : null}
        {place.address ? (
          <Text style={s.cardAddress} numberOfLines={1}>{place.address}</Text>
        ) : null}
      </View>
      <Pressable style={s.routeBtn} onPress={() => onAddToRoute(place)} hitSlop={8}>
        <Route size={15} color={color.signal} />
      </Pressable>
      <Pressable style={s.removeBtn} onPress={() => onRemove(place.id)} hitSlop={8}>
        <Trash2 size={15} color={color.mute} />
      </Pressable>
    </View>
  );
}

// ── View mode toggle ──────────────────────────────────────────────────────────

interface ViewToggleProps {
  mode: 'list' | 'map';
  onChange: (m: 'list' | 'map') => void;
}

function ViewToggle({ mode, onChange }: ViewToggleProps) {
  return (
    <View style={s.toggleRow}>
      <Pressable
        style={[s.toggleBtn, mode === 'list' && s.toggleActive]}
        onPress={() => onChange('list')}
      >
        <List size={14} color={mode === 'list' ? color.signal : color.mute} />
        <Text style={[s.toggleLabel, mode === 'list' && s.toggleLabelActive]}>List</Text>
      </Pressable>
      <Pressable
        style={[s.toggleBtn, mode === 'map' && s.toggleActive]}
        onPress={() => onChange('map')}
      >
        <Map size={14} color={mode === 'map' ? color.signal : color.mute} />
        <Text style={[s.toggleLabel, mode === 'map' && s.toggleLabelActive]}>Map</Text>
      </Pressable>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function Saved() {
  const [tab, setTab]           = useState('Places');
  const [places, setPlaces]     = useState<BookmarkedPlace[]>([]);
  const [loading, setLoading]   = useState(true);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [builderPlace, setBuilderPlace] = useState<BookmarkedPlace | null>(null);

  // Restore persisted tab and viewMode on mount
  useEffect(() => {
    AsyncStorage.multiGet([LIST_CAT_KEY, VIEW_MODE_KEY]).then(([[, storedTab], [, storedMode]]) => {
      if (storedTab && TABS.includes(storedTab)) setTab(storedTab);
      if (storedMode === 'map') setViewMode('map');
    }).catch(() => {});
  }, []);

  // Persist tab changes
  const handleTabChange = useCallback((next: string) => {
    setTab(next);
    AsyncStorage.setItem(LIST_CAT_KEY, next).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listSaved();
      setPlaces(data);
    } catch {
      setPlaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // Persist viewMode when the user explicitly toggles it
  const handleViewModeChange = useCallback((next: 'list' | 'map') => {
    setViewMode(next);
    AsyncStorage.setItem(VIEW_MODE_KEY, next).catch(() => {});
  }, []);

  // Reset to list when switching away from Places tab (do not persist this reset)
  useEffect(() => {
    if (tab !== 'Places') setViewMode('list');
  }, [tab]);

  const showPlaces = tab === 'Places';

  /** Places filtered to the active tab (catch-all for 'Places'). */
  const tabPlaces = useMemo(
    () => placesForTab(tab, places),
    [tab, places],
  );

  const handleAddToRoute = useCallback((place: BookmarkedPlace) => {
    setBuilderPlace(place);
  }, []);

  // Optimistically remove a place from both the list and map views, then
  // persist to AsyncStorage. The map re-renders immediately because
  // SavedPlacesMapView is purely prop-driven — it computes visible pins from
  // the `places` prop via useMemo, so the pin disappears on the next render
  // cycle without requiring a full reload or navigation away.
  //
  // If the active non-Places tab becomes empty after this removal, snap back
  // to 'Places' so the user isn't left on a highlighted but empty chip.
  const handleRemove = useCallback((id: string) => {
    const next = places.filter((p) => p.id !== id);
    setPlaces(next);
    removeSaved(id).catch(() => {});
    if (tab !== 'Places' && placesForTab(tab, next).length === 0) {
      handleTabChange('Places');
    }
  }, [places, tab, handleTabChange]);

  // Count places that have usable coordinates (for map vs list info)
  const mappableCount = useMemo(
    () => places.filter((p) => p.lat != null && p.lng != null).length,
    [places],
  );

  const initialStop = builderPlace
    ? [{
        id:         builderPlace.id,
        title:      builderPlace.name,
        lat:        builderPlace.lat ?? null,
        lng:        builderPlace.lng ?? null,
        sourceType: 'discovery' as const,
        sourceId:   builderPlace.id,
        category:   builderPlace.category ?? undefined,
      }]
    : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Saved" back />

      {/* Category tab bar */}
      <FlatList
        data={TABS}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(x) => x}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ gap: space.sm, padding: space.lg }}
        renderItem={({ item }) => (
          <Chip label={item} active={item === tab} onPress={() => handleTabChange(item)} />
        )}
      />

      {/* List / Map toggle — only on the Places tab, only when there's data */}
      {showPlaces && !loading && places.length > 0 && (
        <ViewToggle mode={viewMode} onChange={handleViewModeChange} />
      )}

      {/* Content */}
      {showPlaces ? (
        loading ? (
          <View style={s.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : places.length === 0 ? (
          <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
            <View style={s.empty}>
              <Bookmark size={28} color={color.haze} />
              <Text style={s.emptyTitle}>No saved places yet</Text>
              <Text style={s.emptySub}>
                Tap the bookmark icon on any place in Discovery to save it here.
              </Text>
            </View>
          </ScrollView>
        ) : viewMode === 'map' ? (
          /* Map view — SavedPlacesMapView handles the MapLibre / web split */
          <View style={{ flex: 1 }}>
            <SavedPlacesMapView
              places={places}
              onPlanRoute={handleAddToRoute}
            />
            {mappableCount === 0 && (
              <View style={s.noCoordsBanner}>
                <Text style={s.noCoordsTxt}>
                  None of your saved places have coordinates yet.
                  Save places from the map view in Discovery to see them here.
                </Text>
              </View>
            )}
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: 0, gap: space.lg }}>
            {places.map((p) => (
              <PlaceCard key={p.id} place={p} onAddToRoute={handleAddToRoute} onRemove={handleRemove} />
            ))}
          </ScrollView>
        )
      ) : (
        loading ? (
          <View style={s.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : tabPlaces.length === 0 ? (
          <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
            <View style={s.empty}>
              <Bookmark size={28} color={color.haze} />
              <Text style={s.emptyTitle}>Nothing saved here yet</Text>
              <Text style={s.emptySub}>
                Save places from Discovery and they&apos;ll appear in this category.
              </Text>
            </View>
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: 0, gap: space.lg }}>
            {tabPlaces.map((p) => (
              <PlaceCard key={p.id} place={p} onAddToRoute={handleAddToRoute} onRemove={handleRemove} />
            ))}
          </ScrollView>
        )
      )}

      <RouteBuilderSheet
        visible={builderPlace != null}
        onClose={() => setBuilderPlace(null)}
        onRouteCreated={() => setBuilderPlace(null)}
        initialStops={initialStop}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: `${color.signal}15`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    flex: 1,
    gap: 2,
  },
  cardName: {
    fontSize: 14,
    fontWeight: '600',
    color: color.ink,
  },
  cardMeta: {
    fontSize: 12,
    color: color.mute,
    textTransform: 'capitalize',
  },
  cardAddress: {
    fontSize: 12,
    color: color.faint,
  },
  routeBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: `${color.signal}15`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xxxl,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
  },
  emptySub: {
    fontSize: 13,
    color: color.mute,
    textAlign: 'center',
    paddingHorizontal: space.xl,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  toggleActive: {
    borderColor: color.signal,
    backgroundColor: `${color.signal}12`,
  },
  toggleLabel: {
    ...t.small,
    fontSize: 12,
    fontWeight: '600',
    color: color.mute,
  },
  toggleLabelActive: {
    color: color.signal,
  },
  noCoordsBanner: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.60)',
    borderRadius: radius.sm,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
  },
  noCoordsTxt: {
    color: '#fff',
    fontSize: 12,
    textAlign: 'center',
  },
});
