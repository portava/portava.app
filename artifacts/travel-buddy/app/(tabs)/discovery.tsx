import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import {
  Compass, Sparkles, MapPin, Coffee, Moon, Activity,
  Calendar, Waves, Navigation,
} from 'lucide-react-native';
import type { DiscoveryCategory, DiscoveryPlace } from '../../src/services/discovery';
import { DiscoveryCategoryTab } from '../../src/components/discovery/DiscoveryCategoryTab';
import { PlaceDetailSheet } from '../../src/components/discovery/PlaceDetailSheet';
import { ForYouTab } from '../../src/components/discovery/ForYouTab';
import { DestinationBar } from '../../src/components/discovery/DestinationBar';
import { usePlanPicker } from '../../src/components/PlanPickerController';
import { listMyTrips } from '../../src/services/trips';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { useSession } from '../../src/context/SessionContext';
import { useLocationContext } from '../../src/context/LocationContext';
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
  const [selectedPlace, setSelectedPlace] = useState<DiscoveryPlace | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);

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

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Compass size={22} color={color.signal} />
          <Text style={styles.headerTitle}>Discover</Text>
        </View>
        <DestinationBar destination={destination} onChangeDestination={setDestination} />
      </View>

      {/* ── Tab bar ── */}
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
              onPress={() => setActiveTab(tab.key)}
            >
              <tab.Icon size={16} color={active ? color.signal : color.mute} />
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

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
            key={destination}
            destination={destination}
            onAddToPlan={handleAddToPlan}
          />
        ) : (
          <DiscoveryCategoryTab
            key={`${activeTab}-${destination}`}
            category={activeTab}
            destination={destination}
            onSelectPlace={handleSelectPlace}
            onAddToPlan={handleAddToPlanFromPlace}
            onPickDestination={handlePickDestination}
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
  tabBar: {
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    flexGrow: 0,
  },
  tabBarContent: {
    paddingHorizontal: space.md,
    gap: space.xs,
    paddingVertical: space.sm,
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
});
