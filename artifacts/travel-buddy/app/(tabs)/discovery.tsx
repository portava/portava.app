import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, Platform, TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import {
  Compass, Sparkles, MapPin, Coffee, Moon, Activity,
  Calendar, Waves, Navigation, Plane, Users, Hash, PlusCircle,
} from 'lucide-react-native';
import { getTrendingHashtags, type TrendingHashtag } from '../../src/services/hashtag';
import type { DiscoveryAgeFilter } from '../../src/services/discovery';
import type { Place } from '../../src/lib/location/placeTypes';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import type { DiscoveryCategory, DiscoveryPlace, DiscoveryContextMode } from '../../src/services/discovery';
import { DiscoveryCategoryTab } from '../../src/components/discovery/DiscoveryCategoryTab';
import { PlaceDetailSheet } from '../../src/components/discovery/PlaceDetailSheet';
import { ForYouTab } from '../../src/components/discovery/ForYouTab';
import { DestinationBar } from '../../src/components/discovery/DestinationBar';
import { usePlanPicker } from '../../src/components/PlanPickerController';
import { listMyTrips } from '../../src/services/trips';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { useSession } from '../../src/context/SessionContext';
import { useLocationContext } from '../../src/context/LocationContext';
import { LocationChip } from '../../src/components/LocationChip';
import { ManualCityPicker } from '../../src/components/ManualCityPicker';
import { FollowingHighlightsStrip } from '../../src/components/FollowingHighlightsStrip';
import { useFollowingHighlights } from '../../src/hooks/useFollowingHighlights';
import { RouteBuilderSheet } from '../../src/components/RouteBuilderSheet';
import type { RouteStopDraft } from '../../src/components/RouteBuilderSheet';
import { SubmitPlaceSheet } from '../../src/components/discovery/SubmitPlaceSheet';

// ── Tab definitions ───────────────────────────────────────────────────────────

interface HubTab {
  key: DiscoveryCategory;
  label: string;
  Icon: React.ComponentType<{ size: number; color: string }>;
}

const TABS: HubTab[] = [
  { key: 'for_you',    label: 'For You',    Icon: Sparkles    },
  { key: 'places',     label: 'Places',     Icon: MapPin      },
  { key: 'food',       label: 'Food',       Icon: Coffee      },
  { key: 'nightlife',  label: 'Nightlife',  Icon: Moon        },
  { key: 'activities', label: 'Activities', Icon: Activity    },
  { key: 'events',     label: 'Events',     Icon: Calendar    },
  { key: 'beaches',    label: 'Beaches',    Icon: Waves       },
  { key: 'transport',  label: 'Transport',  Icon: Navigation  },
];

const VALID_CATEGORY_KEYS = TABS.map((t) => t.key);

// ── Context modes ─────────────────────────────────────────────────────────────

interface ContextModeItem {
  key: DiscoveryContextMode;
  label: string;
  Icon: React.ComponentType<{ size: number; color: string }>;
}

const CONTEXT_MODES: ContextModeItem[] = [
  { key: 'near_me',      label: 'Near Me',      Icon: Navigation },
  { key: 'in_city',      label: 'In City',      Icon: MapPin     },
  { key: 'going_soon',   label: 'Going Soon',   Icon: Calendar   },
  { key: 'around_crew',  label: 'Around Crew',  Icon: Compass    },
  { key: 'safe_nearby',  label: 'Safe Nearby',  Icon: Activity   },
];

// ── Main screen ───────────────────────────────────────────────────────────────

export default function DiscoveryHub() {
  const insets = useSafeAreaInsets();
  const { isAuthed } = useSession();
  const { open: openPlanPicker } = usePlanPicker();
  const { locationState, showCityPicker, openCityPicker, closeCityPicker, setManualCity } = useLocationContext();
  const { users: highlightUsers, sessionViewedIds, markSessionViewed } = useFollowingHighlights();
  const currentCity = locationState.place.city ?? null;

  const [trendingHashtags, setTrendingHashtags] = useState<TrendingHashtag[]>([]);
  useEffect(() => {
    getTrendingHashtags('city', currentCity).then((res) => {
      if (res.ok && res.data) setTrendingHashtags(res.data.trending.slice(0, 12));
    }).catch(() => {});
  }, [currentCity]);

  // Deep-link: ?category=food navigates to that tab on mount
  const params = useLocalSearchParams<{ category?: string }>();
  const initialCategory = (
    VALID_CATEGORY_KEYS.includes(params.category as DiscoveryCategory)
      ? params.category as DiscoveryCategory
      : 'for_you'
  );

  const [activeTab, setActiveTab] = useState<DiscoveryCategory>(initialCategory);
  // Seed from location context city if available; fall back to 'Paris' so
  // content fetches start immediately without a blank screen.
  const [destination, setDestination] = useState(
    () => locationState.place.city ?? 'Paris'
  );
  const [destinationLat, setDestinationLat] = useState<number | null>(
    () => locationState.coords?.lat ?? null
  );
  const [destinationLng, setDestinationLng] = useState<number | null>(
    () => locationState.coords?.lng ?? null
  );
  const [contextMode, setContextMode] = useState<DiscoveryContextMode>('in_city');
  const [ageFilter, setAgeFilter] = useState<DiscoveryAgeFilter>('any');
  const [customMinAge, setCustomMinAge] = useState<number | null>(null);
  const [customMaxAge, setCustomMaxAge] = useState<number | null>(null);
  const [showCustomInputs, setShowCustomInputs] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<DiscoveryPlace | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [layoverOpen, setLayoverOpen] = useState(false);
  const [routeBuilderDraft, setRouteBuilderDraft] = useState<RouteStopDraft | null>(null);
  const [routeBuilderOpen, setRouteBuilderOpen] = useState(false);
  const [submitPlaceOpen, setSubmitPlaceOpen] = useState(false);
  const [communityRefreshKey, setCommunityRefreshKey] = useState(0);

  const handleAddToRoute = useCallback((draft: RouteStopDraft) => {
    setRouteBuilderDraft(draft);
    setRouteBuilderOpen(true);
  }, []);

  // Keep destination in sync when location city changes (GPS capture / manual set).
  useEffect(() => {
    if (locationState.place.city) {
      setDestination(locationState.place.city);
      setDestinationLat(locationState.coords?.lat ?? null);
      setDestinationLng(locationState.coords?.lng ?? null);
    }
  }, [locationState.place.city]);

  // Upgrade to the user's actual trip destination once trips load.
  // Only overrides if the user hasn't set a location yet.
  useEffect(() => {
    if (!isAuthed) return;
    listMyTrips().then((rows) => {
      const active = rows.find((r) => r.status === 'planning' || r.status === 'active') ?? rows[0];
      if (active?.destinationCity && !locationState.place.city) {
        setDestination(active.destinationCity);
      }
    }).catch(() => {});
  }, [isAuthed, locationState.place.city]);

  // Re-apply deep-link category if params change (e.g. in-app navigation)
  useEffect(() => {
    if (params.category && VALID_CATEGORY_KEYS.includes(params.category as DiscoveryCategory)) {
      setActiveTab(params.category as DiscoveryCategory);
    }
  }, [params.category]);

  // Reset to list view when the user switches tabs
  const handleTabChange = (key: DiscoveryCategory) => {
    setActiveTab(key);
    setViewMode('list');
  };

  // Map toggle is shown only on native (Platform.OS !== 'web') and only for
  // category tabs that use DiscoveryCategoryTab (not for_you which is ForYouTab)
  const showMapToggle = Platform.OS !== 'web' && activeTab !== 'for_you';

  const handleAddToPlan = useCallback((place: { id: string; name: string; category: string; address?: string | null }) => {
    setDetailVisible(false);
    openPlanPicker({
      id:           place.id,
      type:         'place',
      title:        place.name,
      category:     place.category,
      locationName: place.address ?? undefined,
    });
  }, [openPlanPicker]);

  const handleAddToPlanFromPlace = useCallback((place: DiscoveryPlace) => {
    handleAddToPlan({ id: place.id, name: place.name, category: place.category, address: place.address });
  }, [handleAddToPlan]);

  const handleSelectPlace = (place: DiscoveryPlace) => {
    setSelectedPlace(place);
    setDetailVisible(true);
  };

  const handlePickDestination = useCallback((city: string) => {
    setDestination(city);
    setDestinationLat(null);
    setDestinationLng(null);
    // Also persist as manual city in the location system
    setManualCity(city).catch(() => {});
  }, [setManualCity]);

  const handleSelectPlaceFromBar = useCallback((place: Place) => {
    setDestination(place.city ?? place.name);
    setDestinationLat(place.lat ?? null);
    setDestinationLng(place.lng ?? null);
    setManualCity(place.city ?? place.name).catch(() => {});
  }, [setManualCity]);

  // Derive LocationChip props from current location state (no coordinates exposed)
  const locationChipProps = (() => {
    if (!locationState.place.city) return null;
    if (locationState.source === 'manual_city') {
      return { variant: 'trip_city' as const, label: locationState.place.city };
    }
    return { variant: 'current_city' as const, label: locationState.place.city };
  })();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Compass size={22} color={color.signal} />
          <Text style={styles.headerTitle}>Discover</Text>
          {locationChipProps && (
            <LocationChip {...locationChipProps} size="sm" muted />
          )}
        </View>
        <View style={styles.headerRight}>
          {isAuthed && (
            <Pressable
              style={styles.sharePlaceBtn}
              onPress={() => setSubmitPlaceOpen(true)}
              hitSlop={8}
            >
              <PlusCircle size={16} color={color.signal} />
              <Text style={styles.sharePlaceBtnText}>Share a Place</Text>
            </Pressable>
          )}
          <DestinationBar destination={destination} onSelectPlace={handleSelectPlaceFromBar} />
        </View>
      </View>

      {/* ── Context mode selector ── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.modeBar}
        contentContainerStyle={styles.modeBarContent}
      >
        {CONTEXT_MODES.map((m) => {
          const active = m.key === contextMode;
          return (
            <Pressable
              key={m.key}
              style={[styles.modeChip, active && styles.modeChipActive]}
              onPress={() => setContextMode(m.key)}
            >
              <m.Icon size={12} color={active ? color.signal : color.mute} />
              <Text style={[styles.modeChipLabel, active && styles.modeChipLabelActive]}>
                {m.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* ── Age filter chip strip ── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.ageFilterBar}
        contentContainerStyle={styles.ageFilterBarContent}
      >
        {([
          { key: 'any',        label: 'Any age' },
          { key: 'open_to_me', label: 'Open to me' },
          { key: '18_plus',    label: '18+' },
          { key: '21_plus',    label: '21+' },
          { key: 'under_30',   label: 'Under 30' },
          { key: '30_plus',    label: '30+' },
          { key: 'custom',     label: 'Custom' },
        ] as { key: DiscoveryAgeFilter; label: string }[]).map((opt) => {
          const active = ageFilter === opt.key;
          return (
            <Pressable
              key={opt.key}
              style={[styles.ageChip, active && styles.ageChipActive]}
              onPress={() => {
                setAgeFilter(opt.key);
                if (opt.key === 'custom') setShowCustomInputs(true);
              }}
            >
              {opt.key === 'open_to_me' && (
                <Users size={10} color={active ? color.signal : color.mute} />
              )}
              <Text style={[styles.ageChipLabel, active && styles.ageChipLabelActive]}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* ── Custom age range inputs (shown when "Custom" chip is active) ── */}
      {ageFilter === 'custom' && (
        <View style={styles.customRangeRow}>
          <Text style={styles.customRangeLabel}>Min age</Text>
          <TextInput
            style={styles.customRangeInput}
            value={customMinAge != null ? String(customMinAge) : ''}
            onChangeText={(v) => setCustomMinAge(v ? parseInt(v, 10) || null : null)}
            keyboardType="number-pad"
            placeholder="e.g. 18"
            placeholderTextColor={color.mute}
            maxLength={3}
          />
          <Text style={styles.customRangeLabel}>Max age</Text>
          <TextInput
            style={styles.customRangeInput}
            value={customMaxAge != null ? String(customMaxAge) : ''}
            onChangeText={(v) => setCustomMaxAge(v ? parseInt(v, 10) || null : null)}
            keyboardType="number-pad"
            placeholder="e.g. 35"
            placeholderTextColor={color.mute}
            maxLength={3}
          />
        </View>
      )}

      {/* ── Tab bar + list/map toggle ── */}
      <View style={styles.tabRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBar}
          contentContainerStyle={styles.tabBarContent}
        >
          {TABS.map((tab) => {
            const active = tab.key === activeTab;
            return (
              <Pressable
                key={tab.key}
                style={[styles.tab, active && styles.tabActive]}
                onPress={() => handleTabChange(tab.key)}
              >
                <tab.Icon size={16} color={active ? color.signal : color.mute} />
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {showMapToggle && (
          <View style={styles.viewToggle}>
            <Pressable
              style={[styles.toggleBtn, viewMode === 'list' && styles.toggleBtnActive]}
              onPress={() => setViewMode('list')}
            >
              <Text style={[styles.toggleBtnText, viewMode === 'list' && styles.toggleBtnTextActive]}>
                List
              </Text>
            </Pressable>
            <Pressable
              style={[styles.toggleBtn, viewMode === 'map' && styles.toggleBtnActive]}
              onPress={() => setViewMode('map')}
            >
              <MapPin size={11} color={viewMode === 'map' ? color.signal : color.mute} />
              <Text style={[styles.toggleBtnText, viewMode === 'map' && styles.toggleBtnTextActive]}>
                Map
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* ── Following highlights strip ── */}
      {isAuthed && (
        <FollowingHighlightsStrip
          users={highlightUsers}
          sessionViewedIds={sessionViewedIds}
          onMarkViewed={markSessionViewed}
        />
      )}

      {/* ── Trending hashtags strip ── */}
      {trendingHashtags.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.trendingBar}
          contentContainerStyle={styles.trendingBarContent}
        >
          {trendingHashtags.map((ht) => (
            <Pressable
              key={ht.id}
              style={styles.trendingChip}
              onPress={() => router.push(`/hashtag/${ht.slug}` as any)}
            >
              <Hash size={10} color={color.deep} />
              <Text style={styles.trendingChipText}>{ht.slug}</Text>
              {ht.usageCount > 0 && (
                <Text style={styles.trendingChipCount}>
                  {ht.usageCount >= 1000 ? `${(ht.usageCount / 1000).toFixed(1)}k` : String(ht.usageCount)}
                </Text>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* ── Active tab content ── */}
      <View style={{ flex: 1 }}>
        {activeTab === 'for_you' ? (
          <ForYouTab
            key={`${destination}-${contextMode}-${communityRefreshKey}`}
            destination={destination}
            onAddToPlan={handleAddToPlan}
            onAddToRoute={handleAddToRoute}
            contextMode={contextMode}
            lat={destinationLat}
            lng={destinationLng}
          />
        ) : (
          <DiscoveryCategoryTab
            key={`${activeTab}-${destination}-${contextMode}`}
            category={activeTab}
            destination={destination}
            onSelectPlace={handleSelectPlace}
            onAddToPlan={handleAddToPlanFromPlace}
            onAddToRoute={handleAddToRoute}
            onPickDestination={handlePickDestination}
            contextMode={contextMode}
            viewMode={viewMode}
            ageFilter={ageFilter}
            customMinAge={customMinAge}
            customMaxAge={customMaxAge}
            lat={destinationLat}
            lng={destinationLng}
          />
        )}
      </View>

      {/* ── Place detail sheet ── */}
      <PlaceDetailSheet
        place={selectedPlace}
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        onAddToPlan={handleAddToPlanFromPlace}
      />

      {/* City picker — triggered from DestinationBar or location context */}
      <ManualCityPicker
        visible={showCityPicker}
        onClose={closeCityPicker}
        onSelect={handlePickDestination}
      />

      {/* Layover Mode floating entry */}
      <Pressable style={styles.layoverFab} onPress={() => setLayoverOpen(true)}>
        <Plane size={16} color="#fff" />
        <Text style={styles.layoverFabText}>Layover Mode</Text>
      </Pressable>

      <LayoverModeSheet
        visible={layoverOpen}
        onClose={() => setLayoverOpen(false)}
        initialCity={destination}
      />

      {/* Route builder — opened from any "Add to Route" button in this tab */}
      <RouteBuilderSheet
        visible={routeBuilderOpen}
        initialStops={routeBuilderDraft ? [routeBuilderDraft] : []}
        onClose={() => { setRouteBuilderOpen(false); setRouteBuilderDraft(null); }}
        onRouteCreated={(route) => {
          setRouteBuilderOpen(false);
          setRouteBuilderDraft(null);
          router.push(`/route/${route.plan.id}`);
        }}
      />

      {/* Submit a community place */}
      <SubmitPlaceSheet
        visible={submitPlaceOpen}
        city={destination}
        onClose={() => setSubmitPlaceOpen(false)}
        onSubmitted={() => {
          setSubmitPlaceOpen(false);
          setCommunityRefreshKey((k) => k + 1);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.md,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
  },
  sharePlaceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: color.signal + '12',
    borderWidth: 1,
    borderColor: color.signal + '30',
  },
  sharePlaceBtnText: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: color.signal,
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 20,
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  tabBar: {
    flexGrow: 1,
    flexShrink: 1,
  },
  tabBarContent: {
    paddingHorizontal: space.md,
    gap: space.xs,
    paddingVertical: space.sm,
  },
  viewToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderLeftWidth: 1,
    borderLeftColor: color.haze,
  },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  toggleBtnActive: {
    backgroundColor: color.signal + '14',
  },
  toggleBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: color.mute,
  },
  toggleBtnTextActive: {
    color: color.signal,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  tabActive: {
    backgroundColor: color.signal + '12',
    borderColor: color.signal + '40',
  },
  tabLabel: {
    ...t.stamp,
    color: color.mute,
    fontSize: 12,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: color.signal,
    fontWeight: '700',
  },
  modeBar: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  modeBarContent: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    gap: space.xs,
  },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: color.haze,
  },
  modeChipActive: {
    backgroundColor: color.signal + '14',
    borderColor: color.signal + '50',
  },
  modeChipLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: color.mute,
  },
  modeChipLabelActive: {
    color: color.signal,
  },
  ageFilterBar: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  ageFilterBarContent: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    gap: space.xs,
  },
  ageChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: color.haze,
  },
  ageChipActive: {
    backgroundColor: color.signal + '14',
    borderColor: color.signal + '50',
  },
  ageChipLabel: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: color.mute,
  },
  ageChipLabelActive: {
    color: color.signal,
  },
  customRangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  customRangeLabel: {
    fontSize: 12,
    color: color.mute,
    fontWeight: '600' as const,
  },
  customRangeInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    fontSize: 13,
    color: color.ink,
    backgroundColor: color.paper,
    textAlign: 'center',
  },
  layoverFab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1565C0',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  layoverFabText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  trendingBar: {
    flexGrow: 0,
    flexShrink: 0,
    paddingTop: 4,
  },
  trendingBarContent: {
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
    gap: space.xs,
    flexDirection: 'row',
  },
  trendingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: color.deep + '12',
    borderWidth: 1,
    borderColor: color.deep + '22',
  },
  trendingChipText: {
    ...t.small,
    color: color.deep,
    fontWeight: '600' as const,
  },
  trendingChipCount: {
    fontSize: 10,
    color: color.mute,
  },
});
