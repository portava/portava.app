import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, Modal,
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
import { AddToPlanSheet } from '../../src/components/AddToPlanSheet';
import { listMyTrips } from '../../src/services/trips';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { useSession } from '../../src/context/SessionContext';

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

// ── Add-to-plan helpers ───────────────────────────────────────────────────────

type TripPlanCategory = 'accommodation' | 'activity' | 'dining' | 'transport' | 'meeting_point' | 'free_time' | 'other';

function discoveryCategoryToPlan(cat: string): TripPlanCategory {
  if (cat === 'food')      return 'dining';
  if (cat === 'transport') return 'transport';
  return 'activity';
}

// ── Trip picker modal ─────────────────────────────────────────────────────────

interface TripOption {
  id: string;
  title: string;
  destinationCity: string;
}

function TripPickerModal({
  visible, trips, onSelect, onClose,
}: {
  visible: boolean;
  trips: TripOption[];
  onSelect: (trip: TripOption) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={tp.backdrop} onPress={onClose} />
      <View style={tp.sheet}>
        <View style={tp.handle} />
        <Text style={tp.title}>Choose a trip</Text>
        {trips.length === 0 ? (
          <Text style={tp.empty}>No trips yet — create a trip first.</Text>
        ) : (
          <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
            {trips.map((tr) => (
              <Pressable key={tr.id} style={tp.row} onPress={() => onSelect(tr)}>
                <Text style={tp.tripTitle} numberOfLines={1}>{tr.title}</Text>
                <Text style={tp.tripDest} numberOfLines={1}>{tr.destinationCity}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const tp = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: space.lg, paddingBottom: space.xxl,
    ...shadow.float,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze,
    alignSelf: 'center', marginBottom: space.md,
  },
  title: { ...t.bodyStrong, color: color.ink, marginBottom: space.md, textAlign: 'center' },
  empty: { ...t.small, color: color.mute, textAlign: 'center', marginVertical: space.xl },
  row: {
    paddingVertical: space.md, paddingHorizontal: space.sm,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  tripTitle: { ...t.bodyStrong, color: color.ink },
  tripDest: { ...t.small, color: color.mute },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export default function DiscoveryHub() {
  const insets = useSafeAreaInsets();
  const { isAuthed } = useSession();

  // Deep-link: ?category=food navigates to that tab on mount
  const params = useLocalSearchParams<{ category?: string }>();
  const initialCategory = (
    VALID_CATEGORY_KEYS.includes(params.category as DiscoveryCategory)
      ? params.category as DiscoveryCategory
      : 'for_you'
  );

  const [activeTab, setActiveTab] = useState<DiscoveryCategory>(initialCategory);
  const [destination, setDestination] = useState('');

  // For "Add to plan" flow
  const [trips, setTrips]                     = useState<TripOption[]>([]);
  const [selectedPlace, setSelectedPlace]     = useState<DiscoveryPlace | null>(null);
  const [detailVisible, setDetailVisible]     = useState(false);
  const [tripPickerVisible, setTripPickerVisible] = useState(false);
  const [addSheetVisible, setAddSheetVisible] = useState(false);
  const [activeTripId, setActiveTripId]       = useState<string | null>(null);
  const pendingPlace                          = useRef<{ id: string; name: string; category: string; address?: string | null } | null>(null);

  // Load trips + set default destination from most recent active trip.
  // When no trip/destination exists, fall back to a popular worldwide city so
  // the feed shows content immediately without requiring manual input.
  useEffect(() => {
    const FALLBACK_DESTINATION = 'Paris';

    if (!isAuthed) {
      // Not signed in — show a popular city feed so the screen isn't empty
      if (!destination) setDestination(FALLBACK_DESTINATION);
      return;
    }

    listMyTrips().then((rows) => {
      const opts = rows.map((r) => ({
        id: r.id,
        title: r.title,
        destinationCity: r.destinationCity,
      }));
      setTrips(opts);

      if (!destination) {
        const active = rows.find((r) => r.status === 'planning' || r.status === 'active') ?? rows[0];
        // Use trip destination if available, otherwise fall back to popular city
        setDestination(active?.destinationCity || FALLBACK_DESTINATION);
      }
    }).catch(() => {
      if (!destination) setDestination(FALLBACK_DESTINATION);
    });
  }, [isAuthed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-apply deep-link category if params change (e.g. in-app navigation)
  useEffect(() => {
    if (params.category && VALID_CATEGORY_KEYS.includes(params.category as DiscoveryCategory)) {
      setActiveTab(params.category as DiscoveryCategory);
    }
  }, [params.category]);

  const openAddFlow = useCallback((place: { id: string; name: string; category: string; address?: string | null }) => {
    pendingPlace.current = place;
    setDetailVisible(false);
    if (trips.length === 1) {
      setActiveTripId(trips[0]!.id);
      setAddSheetVisible(true);
    } else {
      setTripPickerVisible(true);
    }
  }, [trips]);

  const handleAddToPlan = useCallback((place: DiscoveryPlace) => {
    openAddFlow({ id: place.id, name: place.name, category: place.category, address: place.address });
  }, [openAddFlow]);

  const handleTripSelected = (trip: TripOption) => {
    setTripPickerVisible(false);
    setActiveTripId(trip.id);
    setAddSheetVisible(true);
  };

  const handleSelectPlace = (place: DiscoveryPlace) => {
    setSelectedPlace(place);
    setDetailVisible(true);
  };

  const handlePickDestination = (city: string) => {
    setDestination(city);
  };

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

      {/* ── Active tab content ── */}
      <View style={{ flex: 1 }}>
        {activeTab === 'for_you' ? (
          destination ? (
            <ForYouTab
              key={destination}
              destination={destination}
              onAddToPlan={(item) => openAddFlow(item)}
            />
          ) : (
            /* No destination → same fallback as OSM tabs */
            <DiscoveryCategoryTab
              key="for_you-empty"
              category="for_you"
              destination=""
              onSelectPlace={handleSelectPlace}
              onAddToPlan={handleAddToPlan}
              onPickDestination={handlePickDestination}
            />
          )
        ) : (
          <DiscoveryCategoryTab
            key={`${activeTab}-${destination}`}
            category={activeTab}
            destination={destination}
            onSelectPlace={handleSelectPlace}
            onAddToPlan={handleAddToPlan}
            onPickDestination={handlePickDestination}
          />
        )}
      </View>

      {/* ── Modals ── */}
      <PlaceDetailSheet
        place={selectedPlace}
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        onAddToPlan={handleAddToPlan}
      />

      <TripPickerModal
        visible={tripPickerVisible}
        trips={trips}
        onSelect={handleTripSelected}
        onClose={() => setTripPickerVisible(false)}
      />

      {activeTripId && pendingPlace.current && addSheetVisible ? (
        <AddToPlanSheet
          visible={addSheetVisible}
          tripId={activeTripId}
          prefill={{
            title:        pendingPlace.current.name,
            category:     discoveryCategoryToPlan(pendingPlace.current.category),
            locationName: pendingPlace.current.address ?? pendingPlace.current.name,
            sourceType:   'place',
            sourceId:     pendingPlace.current.id,
          }}
          onClose={() => { setAddSheetVisible(false); pendingPlace.current = null; }}
          onAdded={() => { setAddSheetVisible(false); pendingPlace.current = null; }}
        />
      ) : null}
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
