/**
 * GlobalPlacePicker — app-wide location / place selector.
 *
 * Bottom-sheet modal with:
 *  - Use current GPS location
 *  - Recent places (from /api/me/recent-places)
 *  - Search (via /api/places/search → Nominatim)
 *  - Popular city fallback list
 *  - Manual city entry (custom text)
 *
 * Props:
 *   visible       — sheet visibility
 *   onSelect      — called with Place on selection
 *   onClose       — dismiss sheet
 *   title         — sheet title
 *   allowGPS      — show "Use my location" row (default true)
 *   countryCode   — bias search results to this country
 *   placeholder   — search placeholder
 *   usedFor       — label for recent-places storage (e.g. "trip_destination")
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, Modal,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { X, MapPin, Search, Navigation, Clock } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ExpoLocation from 'expo-location';
import { color, space, radius, type as t } from '../../theme/tokens';
import { usePlaceSearch } from '../../hooks/usePlaceSearch';
import { useRecentPlaces } from '../../hooks/useRecentPlaces';
import type { Place } from '../../lib/location/placeTypes';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

const POPULAR: Place[] = [
  { id: 'pop-bangkok', type: 'city', name: 'Bangkok', displayName: 'Bangkok, Thailand', country: 'Thailand', countryCode: 'TH', region: null, city: 'Bangkok', district: null, lat: 13.756, lng: 100.502, timezone: 'Asia/Bangkok', source: 'manual' },
  { id: 'pop-bali', type: 'city', name: 'Bali', displayName: 'Bali, Indonesia', country: 'Indonesia', countryCode: 'ID', region: null, city: 'Bali', district: null, lat: -8.409, lng: 115.188, timezone: 'Asia/Makassar', source: 'manual' },
  { id: 'pop-tokyo', type: 'city', name: 'Tokyo', displayName: 'Tokyo, Japan', country: 'Japan', countryCode: 'JP', region: null, city: 'Tokyo', district: null, lat: 35.689, lng: 139.691, timezone: 'Asia/Tokyo', source: 'manual' },
  { id: 'pop-paris', type: 'city', name: 'Paris', displayName: 'Paris, France', country: 'France', countryCode: 'FR', region: null, city: 'Paris', district: null, lat: 48.856, lng: 2.351, timezone: 'Europe/Paris', source: 'manual' },
  { id: 'pop-barcelona', type: 'city', name: 'Barcelona', displayName: 'Barcelona, Spain', country: 'Spain', countryCode: 'ES', region: null, city: 'Barcelona', district: null, lat: 41.385, lng: 2.173, timezone: 'Europe/Madrid', source: 'manual' },
  { id: 'pop-newyork', type: 'city', name: 'New York', displayName: 'New York, USA', country: 'USA', countryCode: 'US', region: null, city: 'New York', district: null, lat: 40.712, lng: -74.006, timezone: 'America/New_York', source: 'manual' },
  { id: 'pop-london', type: 'city', name: 'London', displayName: 'London, UK', country: 'UK', countryCode: 'GB', region: null, city: 'London', district: null, lat: 51.507, lng: -0.127, timezone: 'Europe/London', source: 'manual' },
  { id: 'pop-singapore', type: 'city', name: 'Singapore', displayName: 'Singapore', country: 'Singapore', countryCode: 'SG', region: null, city: 'Singapore', district: null, lat: 1.352, lng: 103.819, timezone: 'Asia/Singapore', source: 'manual' },
  { id: 'pop-istanbul', type: 'city', name: 'Istanbul', displayName: 'Istanbul, Turkey', country: 'Turkey', countryCode: 'TR', region: null, city: 'Istanbul', district: null, lat: 41.013, lng: 28.979, timezone: 'Europe/Istanbul', source: 'manual' },
  { id: 'pop-dubai', type: 'city', name: 'Dubai', displayName: 'Dubai, UAE', country: 'UAE', countryCode: 'AE', region: null, city: 'Dubai', district: null, lat: 25.204, lng: 55.270, timezone: 'Asia/Dubai', source: 'manual' },
  { id: 'pop-cebu', type: 'city', name: 'Cebu City', displayName: 'Cebu City, Philippines', country: 'Philippines', countryCode: 'PH', region: null, city: 'Cebu City', district: null, lat: 10.316, lng: 123.891, timezone: 'Asia/Manila', source: 'manual' },
  { id: 'pop-hcm', type: 'city', name: 'Ho Chi Minh City', displayName: 'Ho Chi Minh City, Vietnam', country: 'Vietnam', countryCode: 'VN', region: null, city: 'Ho Chi Minh City', district: null, lat: 10.776, lng: 106.701, timezone: 'Asia/Ho_Chi_Minh', source: 'manual' },
  { id: 'pop-lisbon', type: 'city', name: 'Lisbon', displayName: 'Lisbon, Portugal', country: 'Portugal', countryCode: 'PT', region: null, city: 'Lisbon', district: null, lat: 38.716, lng: -9.139, timezone: 'Europe/Lisbon', source: 'manual' },
  { id: 'pop-cdmx', type: 'city', name: 'Mexico City', displayName: 'Mexico City, Mexico', country: 'Mexico', countryCode: 'MX', region: null, city: 'Mexico City', district: null, lat: 19.432, lng: -99.133, timezone: 'America/Mexico_City', source: 'manual' },
  { id: 'pop-capetown', type: 'city', name: 'Cape Town', displayName: 'Cape Town, South Africa', country: 'South Africa', countryCode: 'ZA', region: null, city: 'Cape Town', district: null, lat: -33.924, lng: 18.424, timezone: 'Africa/Johannesburg', source: 'manual' },
];

interface Props {
  visible: boolean;
  onSelect: (place: Place) => void;
  onClose: () => void;
  title?: string;
  allowGPS?: boolean;
  countryCode?: string;
  placeholder?: string;
  usedFor?: string;
}

type GpsState = 'idle' | 'loading' | 'denied' | 'error';

export function GlobalPlacePicker({
  visible, onSelect, onClose, title, allowGPS = true, countryCode, placeholder, usedFor,
}: Props) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [gpsState, setGpsState] = useState<GpsState>('idle');
  const { results: searchResults, loading: searching } = usePlaceSearch(query, { countryCode });
  const { recents, saveRecent } = useRecentPlaces();

  useEffect(() => {
    if (visible) { setQuery(''); setGpsState('idle'); }
  }, [visible]);

  const select = useCallback((place: Place) => {
    saveRecent(place, usedFor);
    onSelect(place);
    onClose();
  }, [onSelect, onClose, saveRecent, usedFor]);

  async function useGPS() {
    setGpsState('loading');
    try {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setGpsState('denied'); return; }
      const pos = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced });
      const { latitude: lat, longitude: lng } = pos.coords;

      // Reverse geocode via backend
      try {
        const res = await fetch(`${apiBase()}/api/places/reverse?lat=${lat}&lng=${lng}`);
        if (res.ok) {
          const body = await res.json();
          if (body.place) { select(body.place); return; }
        }
      } catch { /* fall through to coordinate-only place */ }

      // Fallback: create a GPS place with raw coordinates
      const gpsPlace: Place = {
        id: `gps-${lat.toFixed(4)}-${lng.toFixed(4)}`,
        type: 'place', name: 'Current Location',
        displayName: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
        country: null, countryCode: null, region: null, city: null, district: null,
        lat, lng, timezone: null, source: 'gps',
      };
      select(gpsPlace);
    } catch {
      setGpsState('error');
    }
  }

  // Custom entry: user typed something and tapped "Use…"
  function useCustom() {
    const q = query.trim();
    if (!q) return;
    const place: Place = {
      id: `manual-${q.toLowerCase().replace(/\s+/g, '-')}`,
      type: 'city', name: q, displayName: q,
      country: null, countryCode: null, region: null, city: q, district: null,
      lat: null, lng: null, timezone: null, source: 'manual',
    };
    select(place);
  }

  const showSearch = query.trim().length > 0;
  const showCustom = showSearch && !searchResults.find((r) => r.name.toLowerCase() === query.toLowerCase());
  const showPopular = !showSearch && recents.length === 0;
  const showRecents = !showSearch && recents.length > 0;

  type ListItem =
    | { kind: 'gps' }
    | { kind: 'section'; label: string }
    | { kind: 'place'; place: Place }
    | { kind: 'custom' };

  const items: ListItem[] = [];
  if (allowGPS) items.push({ kind: 'gps' });
  if (showRecents) {
    items.push({ kind: 'section', label: 'Recent' });
    recents.slice(0, 5).forEach((p) => items.push({ kind: 'place', place: p }));
  }
  if (showPopular) {
    items.push({ kind: 'section', label: 'Popular Destinations' });
    POPULAR.forEach((p) => items.push({ kind: 'place', place: p }));
  }
  if (showSearch) {
    searchResults.forEach((p) => items.push({ kind: 'place', place: p }));
    if (showCustom) items.push({ kind: 'custom' });
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView
        style={s.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={s.backdrop} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 8 }]}>
          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>{title ?? 'Choose Location'}</Text>
            <Pressable style={s.closeBtn} onPress={onClose} hitSlop={12}>
              <X size={18} color={color.mute} />
            </Pressable>
          </View>

          {/* Search bar */}
          <View style={s.searchRow}>
            <Search size={16} color={color.mute} />
            <TextInput
              style={s.input}
              value={query}
              onChangeText={setQuery}
              placeholder={placeholder ?? 'Search cities, places…'}
              placeholderTextColor={color.faint}
              autoCapitalize="words"
              returnKeyType="search"
              onSubmitEditing={useCustom}
            />
            {searching && <ActivityIndicator size="small" color={color.signal} />}
            {query.length > 0 && !searching && (
              <Pressable onPress={() => setQuery('')} hitSlop={8}>
                <X size={14} color={color.mute} />
              </Pressable>
            )}
          </View>

          {/* GPS status messages */}
          {gpsState === 'denied' && (
            <Text style={s.gpsMsg}>Location is off. Choose a city manually.</Text>
          )}
          {gpsState === 'error' && (
            <Text style={s.gpsMsg}>Couldn't get location. Choose a city below.</Text>
          )}

          {/* List */}
          <FlatList
            data={items}
            keyExtractor={(item, i) => {
              if (item.kind === 'gps') return 'gps';
              if (item.kind === 'custom') return 'custom';
              if (item.kind === 'section') return `section-${item.label}`;
              return item.place.id;
            }}
            style={s.list}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => {
              if (item.kind === 'section') {
                return <Text style={s.sectionLabel}>{item.label}</Text>;
              }
              if (item.kind === 'gps') {
                return (
                  <Pressable style={s.row} onPress={useGPS} disabled={gpsState === 'loading'}>
                    <View style={[s.iconCircle, { backgroundColor: `${color.signal}20` }]}>
                      {gpsState === 'loading'
                        ? <ActivityIndicator size="small" color={color.signal} />
                        : <Navigation size={16} color={color.signal} />}
                    </View>
                    <View style={s.rowText}>
                      <Text style={[s.rowName, { color: color.signal }]}>Use my current location</Text>
                      <Text style={s.rowSub}>GPS · updates automatically</Text>
                    </View>
                  </Pressable>
                );
              }
              if (item.kind === 'custom') {
                return (
                  <Pressable style={s.row} onPress={useCustom}>
                    <View style={[s.iconCircle, { backgroundColor: `${color.signal}15` }]}>
                      <MapPin size={16} color={color.signal} />
                    </View>
                    <View style={s.rowText}>
                      <Text style={s.rowName}>Use "<Text style={{ fontWeight: '700' }}>{query.trim()}</Text>"</Text>
                      <Text style={s.rowSub}>Enter as custom city</Text>
                    </View>
                  </Pressable>
                );
              }
              // Place row
              const { place } = item;
              const isRecent = recents.some((r) => r.id === place.id);
              return (
                <Pressable style={s.row} onPress={() => select(place)}>
                  <View style={s.iconCircle}>
                    {isRecent
                      ? <Clock size={15} color={color.mute} />
                      : <MapPin size={15} color={color.mute} />}
                  </View>
                  <View style={s.rowText}>
                    <Text style={s.rowName} numberOfLines={1}>{place.name}</Text>
                    {place.displayName !== place.name && (
                      <Text style={s.rowSub} numberOfLines={1}>{place.displayName}</Text>
                    )}
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              showSearch && !searching ? (
                <View style={s.empty}>
                  <Text style={s.emptyText}>No places found. Type to enter a custom city.</Text>
                </View>
              ) : null
            }
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,17,15,0.45)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.md,
  },
  title: { ...t.heading, color: color.ink, flex: 1 },
  closeBtn: { padding: 4 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    marginHorizontal: space.xl, marginBottom: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.md, height: 44,
  },
  input: { flex: 1, ...t.body, color: color.ink },
  gpsMsg: { ...t.small, color: color.mute, paddingHorizontal: space.xl, paddingBottom: space.sm },
  list: { flex: 1 },
  sectionLabel: {
    ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, fontWeight: '700',
    paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: space.xs,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.xl, paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
  },
  iconCircle: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: color.paperRaised,
    alignItems: 'center', justifyContent: 'center',
  },
  rowText: { flex: 1 },
  rowName: { ...t.body, color: color.ink, fontWeight: '600' },
  rowSub: { ...t.small, color: color.mute, marginTop: 1 },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
});
