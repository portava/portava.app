import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import {
  Compass, Sparkles, MapPin, Coffee, Moon, Activity,
  Calendar, Waves, Navigation,
} from 'lucide-react-native';
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
  const [contextMode, setContextMode] = useState<DiscoveryContextMode>('in_city');
  const [selectedPlace, setSelectedPlace] = useState<DiscoveryPlace | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');

  // Keep destination in sync when location city changes (GPS capture / manual set).
  useEffect(() => {
    if (locationState.place.city) {
      setDestination(locationState.place.city);
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
    // Also persist as manual city in the location system
    setManualCity(city).catch(() => {});
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
        <DestinationBar destination={destination} onChangeDestination={setDestination} />
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

      {/* ── Active tab content ── */}
      <View style={{ flex: 1 }}>
        {activeTab === 'for_you' ? (
          <ForYouTab
            key={`${destination}-${contextMode}`}
            destination={destination}
            onAddToPlan={handleAddToPlan}
            contextMode={contextMode}
          />
        ) : (
          <DiscoveryCategoryTab
            key={`${activeTab}-${destination}-${contextMode}`}
            category={activeTab}
            destination={destination}
            onSelectPlace={handleSelectPlace}
            onAddToPlan={handleAddToPlanFromPlace}
            onPickDestination={handlePickDestination}
            contextMode={contextMode}
            viewMode={viewMode}
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
});
