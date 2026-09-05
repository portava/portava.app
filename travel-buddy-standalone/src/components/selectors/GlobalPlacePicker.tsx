/**
 * GlobalPlacePicker — THE app-wide location picker (universal location service).
 *
 * Every location selection in the app flows through this component so that
 * all saved locations are normalized Places sharing canonical location ids.
 *
 * Sections (context-aware, empty-query state):
 *  - Use my current location  (explicit GPS, never blocks the sheet)
 *  - Near You                 (silent — only when permission already granted)
 *  - Recent                   (from /api/me/recent-places)
 *  - Caller context sections  (e.g. "Trip Destinations", "Saved Places")
 *  - Popular on Portava       (real activity ranking via /api/locations/popular,
 *                              proximity-biased, seed fallback offline)
 *
 * Search covers cities, regions, neighborhoods, airports, hotels, landmarks,
 * venues, and addresses via /api/places/search (Nominatim + Foursquare).
 *
 * On selection the Place is resolved against /api/locations/resolve
 * (canonical registry find-or-create, ≤1.3 s, never blocks on failure) so
 * "Cebu", "Cebu City", and provider variants save the same canonicalId.
 * Custom free-text entries go through the same resolution path.
 *
 * Props:
 *   visible          — sheet visibility
 *   onSelect         — called with the resolved Place on selection
 *   onClose          — dismiss sheet
 *   title            — sheet title
 *   allowGPS         — show "Use my location" row (default true)
 *   countryCode      — bias search results to this country
 *   placeholder      — search placeholder
 *   usedFor          — label for recent-places storage (e.g. "trip_destination")
 *   mode             — 'all' (default) or 'city' (settlements only)
 *   contextSections  — extra caller-provided sections (label + places)
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, Modal,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { KeyboardSafeScrollView } from '../ui/KeyboardSafeView.tsx';
import { X, MapPin, Search, Navigation, Clock, TrendingUp, RefreshCw } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ExpoLocation from 'expo-location';
import { getCurrentGps } from '../../services/location.ts';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import { usePlaceSearch } from '../../hooks/usePlaceSearch.ts';
import { selectSearchRows } from '../../lib/location/searchSourceMerge.ts';
import { useRecentPlaces } from '../../hooks/useRecentPlaces.ts';
import { usePopularCities } from '../../hooks/usePopularCities.ts';
import { resolveCanonicalPlace } from '../../lib/location/resolveCanonical.ts';
import type { Place } from '../../lib/location/placeTypes.ts';
import {
  useGooglePlacesAutocomplete,
  fetchGooglePlaceDetails,
} from '../../hooks/useGooglePlacesAutocomplete.ts';
// ── Global Input Intelligence — Phase 2 (Geographic Core), ADDITIVE ────────────
// When a caller opts in via `assistContext`, the picker ALSO sources canonical
// suggestions from the P1 gateway and captures the §17/§53 binding on select.
// Every one of these code paths is guarded on `assistContext` being set, so the
// ~25 existing surfaces that pass none get byte-identical behavior.
import { useInputAssistance } from '../../platform/input-assistance/hooks/useInputAssistance.ts';
import { suggestionToPlace } from '../../platform/input-assistance/geographic/geoSuggestions.ts';
import { captureCanonicalBinding } from '../../platform/input-assistance/geographic/canonicalBinding.ts';
import { foldForMatch } from '../../platform/input-assistance/services/queryNormalization.ts';
import { recordSuggestionSelection } from '../../platform/input-assistance/services/selectionRecorder.ts';
import type { InputContext } from '../../platform/input-assistance/types/inputContext.ts';
import type { InputSessionContext, InputSuggestion } from '../../platform/input-assistance/types/inputSuggestion.ts';
import type { CanonicalPlaceBinding } from '../../platform/input-assistance/geographic/canonicalBinding.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Offline/seed fallback when /api/locations/popular is unreachable. */
export const POPULAR: Place[] = [
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

export interface PlacePickerContextSection {
  label: string;
  places: Place[];
}

interface Props {
  visible: boolean;
  onSelect: (place: Place) => void;
  onClose: () => void;
  title?: string;
  allowGPS?: boolean;
  countryCode?: string;
  placeholder?: string;
  usedFor?: string;
  /** 'city' restricts search to settlements and titles the sheet accordingly. */
  mode?: 'all' | 'city';
  /** Caller-provided sections, e.g. trip destinations or saved places. */
  contextSections?: PlacePickerContextSection[];

  // ── Global Input Intelligence opt-in (Phase 2), ALL OPTIONAL + ADDITIVE ──────
  /** Opt in to gateway-sourced canonical suggestions for this geographic field.
   *  When set, `/input-assistance/suggest` results are merged (canonical-first)
   *  into the search rows and the §17/§53 binding is captured on select. When
   *  omitted (the ~25 existing surfaces), the picker behaves exactly as before. */
  assistContext?: InputContext;
  /** Registered field id for policy/cache/telemetry. Defaults to assistContext. */
  assistFieldId?: string;
  /** Bounded task/session context forwarded to the gateway (§16). */
  sessionContext?: InputSessionContext;
  /** §17/§53 — receives the canonical binding (city id + country + timezone +
   *  coordinates) captured on selection, so dependent fields can prefill. */
  onCanonicalBinding?: (binding: CanonicalPlaceBinding) => void;
}

type GpsState = 'idle' | 'loading' | 'denied' | 'error';

export function GlobalPlacePicker({
  visible, onSelect, onClose, title, allowGPS = true, countryCode, placeholder, usedFor,
  mode = 'all', contextSections,
  assistContext, assistFieldId, sessionContext, onCanonicalBinding,
}: Props) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [gpsState, setGpsState] = useState<GpsState>('idle');
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // Silent coordinates: available only when permission was ALREADY granted.
  const [nearbyCoords, setNearbyCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [nearPlace, setNearPlace] = useState<Place | null>(null);
  const aliveRef = useRef(true);

  // Bumped by the "Retry" button on a failed search — failed requests are
  // never cached, so re-running the hook effect issues a fresh fetch.
  const [searchRetry, setSearchRetry] = useState(0);

  const cityMode = mode === 'city';
  const { results: searchResults, loading: searching, error: searchError } = usePlaceSearch(query, {
    countryCode,
    type: cityMode ? 'city' : undefined,
    lat: nearbyCoords?.lat,
    lng: nearbyCoords?.lng,
    refreshKey: searchRetry,
  });
  const { places: googlePlaces, loading: googleLoading } = useGooglePlacesAutocomplete(query, {
    countryCode,
    type: cityMode ? 'city' : 'all',
  });
  const { recents, saveRecent } = useRecentPlaces();
  const { places: popularPlaces } = usePopularCities({
    lat: nearbyCoords?.lat,
    lng: nearbyCoords?.lng,
    enabled: visible,
  });

  // ── Gateway-sourced canonical suggestions (Phase 2, opt-in) ──────────────────
  // The hook is called unconditionally (Rules of Hooks) but only fetches when a
  // caller opted in via `assistContext`. It degrades gracefully: a missing /
  // undeployed endpoint yields zero suggestions and the picker falls back to its
  // existing provider search (§38). Coordinates from silent nearby detection are
  // folded into the bounded session context for geographic ranking (§15).
  const assistSession = React.useMemo<InputSessionContext | undefined>(() => {
    if (!assistContext) return undefined;
    const base = sessionContext ?? {};
    if (nearbyCoords && base.lat == null && base.lng == null) {
      return { ...base, lat: nearbyCoords.lat, lng: nearbyCoords.lng };
    }
    return base;
  }, [assistContext, sessionContext, nearbyCoords]);
  const { suggestions: gatewaySuggestions, policy: assistPolicy } = useInputAssistance({
    fieldId: assistFieldId ?? assistContext ?? '__geo_no_assist__',
    text: query,
    context: assistContext,
    sessionContext: assistSession,
    enabled: visible && !!assistContext,
  });
  // Map gateway suggestions → Places, deduped by canonical id / folded name, so
  // they can render + resolve through the picker's existing pipeline.
  //
  // `gatewayById` keeps the ORIGINATING suggestion for each mapped Place. The
  // picker's selection pipeline speaks `Place`, but §35 selection memory has to
  // record the canonical (entityType, entityId) the user actually accepted — so
  // the mapping is retained here rather than reconstructed from the Place.
  const { gatewayPlaces, gatewayById } = React.useMemo<{
    gatewayPlaces: Place[];
    gatewayById: Map<string, InputSuggestion>;
  }>(() => {
    const byId = new Map<string, InputSuggestion>();
    if (!assistContext || gatewaySuggestions.length === 0) {
      return { gatewayPlaces: [], gatewayById: byId };
    }
    const out: Place[] = [];
    const seen = new Set<string>();
    for (const s of gatewaySuggestions) {
      const p = suggestionToPlace(s);
      if (!p) continue;
      const key = foldForMatch(p.canonicalId ?? p.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      byId.set(p.id, s);
    }
    return { gatewayPlaces: out, gatewayById: byId };
  }, [assistContext, gatewaySuggestions]);

  // Reset + silent nearby detection on open. GPS must NEVER block the sheet:
  // we only use an already-granted permission and the last known position.
  useEffect(() => {
    aliveRef.current = true;
    if (!visible) return () => { aliveRef.current = false; };
    setQuery('');
    setGpsState('idle');
    setResolvingId(null);

    (async () => {
      try {
        const perm = await ExpoLocation.getForegroundPermissionsAsync();
        if (!perm.granted) return;
        const pos = await ExpoLocation.getLastKnownPositionAsync();
        if (!pos || !aliveRef.current) return;
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setNearbyCoords(coords);

        // Reverse geocode for a tappable "Near You" city row (best-effort).
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        try {
          const res = await fetch(
            `${apiBase()}/api/places/reverse?lat=${coords.lat}&lng=${coords.lng}`,
            { signal: ctrl.signal },
          );
          if (res.ok) {
            const body = await res.json();
            if (body?.place && aliveRef.current) setNearPlace(body.place);
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Silent by design — the sheet works fully without location.
      }
    })();

    return () => { aliveRef.current = false; };
  }, [visible]);

  /**
   * Selection pipeline: resolve → save recent → emit. Resolution attaches the
   * canonicalId (universal location registry) and normalized fields; it is
   * capped at ~1.3 s and falls back to the raw place so UX never blocks.
   */
  const select = useCallback(async (place: Place) => {
    if (resolvingId) return; // guard double-tap while a selection is in flight
    setResolvingId(place.id);
    try {
      // Google autocomplete results have no lat/lng — fetch Place Details to
      // enrich with coordinates before canonical resolution.
      let enriched = place;
      if (place.source === 'google') {
        const rawId = place.id.replace(/^google-/, '');
        const details = await fetchGooglePlaceDetails(rawId);
        if (details) {
          enriched = { ...place, lat: details.lat, lng: details.lng, formattedAddress: details.formattedAddress };
        }
      }
      const resolved = await resolveCanonicalPlace(enriched);
      saveRecent(resolved, usedFor);
      // §17/§53 — capture the canonical binding (city id + country + timezone +
      // coordinates) so dependent fields can prefill. No-op unless a caller opted in.
      onCanonicalBinding?.(captureCanonicalBinding(resolved));
      // §35 Phase 8 — record this EXPLICIT accept as selection memory when the
      // row came from the gateway. Without this the picker was a READER of
      // personalization with no writer: every geographic context
      // (trip_destination, city_picker, place_picker …) could only ever read an
      // empty `input_selection_history`, because the only recorder in the app
      // was SmartInput, which is mounted on `global_search` alone — and the
      // memory read is scoped per (user, context), so a global_search row can
      // never reach a picker context. Fire-and-forget + fail-soft: it never
      // awaits, never throws, and never gates the selection above.
      const originating = gatewayById.get(place.id);
      if (originating) {
        recordSuggestionSelection(originating, { policy: assistPolicy, query });
      }
      onSelect(resolved);
      onClose();
    } finally {
      if (aliveRef.current) setResolvingId(null);
    }
  }, [onSelect, onClose, saveRecent, usedFor, resolvingId, onCanonicalBinding, gatewayById, assistPolicy, query]);

  async function useGPS() {
    setGpsState('loading');
    try {
      const gps = await getCurrentGps();
      if (!gps.granted || gps.lat == null || gps.lng == null) {
        setGpsState(gps.error === 'permission_denied' ? 'denied' : 'error');
        return;
      }
      const { lat, lng } = gps;

      // Reverse geocode via backend
      try {
        const res = await fetch(`${apiBase()}/api/places/reverse?lat=${lat}&lng=${lng}`);
        if (res.ok) {
          const body = await res.json();
          if (body.place) { await select(body.place); return; }
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
      await select(gpsPlace);
    } catch {
      setGpsState('error');
    }
  }

  // Custom entry — still normalized: it flows through the same canonical
  // resolution as every other selection (no raw-text-only saves).
  function commitFreeText() {
    const q = query.trim();
    if (!q) return;
    const place: Place = {
      id: `manual-${q.toLowerCase().replace(/\s+/g, '-')}`,
      type: 'city', name: q, displayName: q,
      country: null, countryCode: null, region: null, city: q, district: null,
      lat: null, lng: null, timezone: null, source: 'manual',
    };
    void select(place);
  }

  // Return/Search key: select the TOP real suggestion when one exists — never
  // commit the raw text over a live suggestion list. While providers are still
  // loading, do nothing (a premature submit was how "it just takes whatever word
  // I type" happened). Raw-text fallback only when the query has settled with
  // zero suggestions.
  function submitSearch() {
    if (searching || googleLoading) return;
    // Canonical (gateway) matches win over provider rows when present — but this
    // still NEVER commits raw text over a live suggestion list (§19).
    if (assistContext && gatewayPlaces.length > 0) { void select(gatewayPlaces[0]); return; }
    const top = selectSearchRows({ googlePlaces, searchResults, cityMode }).rows[0];
    if (top) { void select(top); return; }
    commitFreeText();
  }

  const showSearch = query.trim().length > 0;
  // The custom free-text row stays available when search errors, so the
  // picker degrades to manual entry instead of appearing broken.
  const showCustom = showSearch && !searching && !googleLoading
    && !searchResults.find((r) => r.name.toLowerCase() === query.trim().toLowerCase())
    && !googlePlaces.find((r) => r.name.toLowerCase() === query.trim().toLowerCase());

  const popular = popularPlaces.length > 0 ? popularPlaces : POPULAR;

  type ListItem =
    | { kind: 'gps' }
    | { kind: 'section'; label: string; icon?: 'trending' }
    | { kind: 'place'; place: Place; icon: 'pin' | 'clock' | 'near' }
    | { kind: 'custom' }
    | { kind: 'google-attribution' }
    | { kind: 'error' };

  const items: ListItem[] = [];
  if (!showSearch) {
    if (allowGPS) items.push({ kind: 'gps' });

    const recentIds = new Set(recents.slice(0, 5).map((r) => r.id));
    if (nearPlace && !recentIds.has(nearPlace.id)) {
      items.push({ kind: 'section', label: 'Near You' });
      items.push({ kind: 'place', place: nearPlace, icon: 'near' });
    }
    if (recents.length > 0) {
      items.push({ kind: 'section', label: 'Recent' });
      recents.slice(0, 5).forEach((p) => items.push({ kind: 'place', place: p, icon: 'clock' }));
    }
    for (const section of contextSections ?? []) {
      if (!section.places || section.places.length === 0) continue;
      items.push({ kind: 'section', label: section.label });
      section.places.slice(0, 5).forEach((p) => items.push({ kind: 'place', place: p, icon: 'pin' }));
    }
    // Popular is always available — real activity ranking with seed fallback.
    const seen = new Set(items.filter((i) => i.kind === 'place').map((i: any) => i.place.id));
    const popularRows = popular.filter((p) => !seen.has(p.id));
    if (popularRows.length > 0) {
      items.push({ kind: 'section', label: 'Popular on Portava', icon: 'trending' });
      popularRows.forEach((p) => items.push({ kind: 'place', place: p, icon: 'pin' }));
    }
  } else {
    // Source selection lives in lib/location/searchSourceMerge.ts. In CITY mode
    // Google is the source and /places/search is a fallback that runs only when
    // Google returns nothing — merging the two is what made city rows blink in
    // and out mid-type, because Nominatim answers partial names erratically.
    // Outside city mode the additive merge is unchanged.
    const selection = selectSearchRows({ googlePlaces, searchResults, cityMode });
    // Additive canonical section (Phase 2): gateway matches render first, and
    // provider rows that duplicate them (by folded name) are dropped so a city
    // is not listed twice. Empty when the caller did not opt in.
    const gatewayRows = assistContext ? gatewayPlaces : [];
    const gatewayNames = new Set(gatewayRows.map((p) => foldForMatch(p.name)));
    if (searchError && !searching && selection.rows.length === 0 && gatewayRows.length === 0) {
      items.push({ kind: 'error' });
    }
    if (gatewayRows.length > 0) {
      items.push({ kind: 'section', label: 'Best matches' });
      gatewayRows.forEach((p) => items.push({ kind: 'place', place: p, icon: 'pin' }));
    }
    if (selection.showGoogleAttribution) items.push({ kind: 'google-attribution' });
    selection.rows
      .filter((p) => !gatewayNames.has(foldForMatch(p.name)))
      .forEach((p) => items.push({ kind: 'place', place: p, icon: 'pin' }));
    if (showCustom) items.push({ kind: 'custom' });
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      {/* Keyboard handling: the sheet is bottom-anchored, so the KAV must lift
          it above the keyboard or the results FlatList gets covered.
          iOS: 'padding' insets the overlay by the keyboard height.
          Android: 'height' shrinks the overlay — needed because this Modal is
          statusBarTranslucent, which stops adjustResize from resizing it. */}
      <KeyboardSafeScrollView style={s.overlay}>
        <Pressable style={s.backdrop} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 8 }]}>
          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>{title ?? (cityMode ? 'Choose a City' : 'Choose Location')}</Text>
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
              placeholder={placeholder ?? (cityMode ? 'Search cities…' : 'Search cities, hotels, landmarks…')}
              placeholderTextColor={color.faint}
              autoCapitalize="words"
              returnKeyType="search"
              onSubmitEditing={submitSearch}
            />
            {(searching || googleLoading) && <ActivityIndicator size="small" color={color.signal} />}
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
              if (item.kind === 'error') return 'error';
              if (item.kind === 'google-attribution') return 'google-attribution';
              if (item.kind === 'section') return `section-${item.label}`;
              return `${item.icon}-${item.place.id}`;
            }}
            style={s.list}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => {
              if (item.kind === 'section') {
                return (
                  <View style={s.sectionRow}>
                    {item.icon === 'trending' && <TrendingUp size={11} color={color.mute} />}
                    <Text style={s.sectionLabel}>{item.label}</Text>
                  </View>
                );
              }
              if (item.kind === 'google-attribution') {
                return (
                  <View style={s.googleAttrib}>
                    <Text style={s.googleAttribText}>Suggestions powered by Google</Text>
                  </View>
                );
              }
              if (item.kind === 'error') {
                return (
                  <View style={s.errorRow} testID="place-search-error">
                    <View style={s.errorTextWrap}>
                      <Text style={s.errorTitle}>Couldn't load suggestions</Text>
                      <Text style={s.rowSub}>You can retry, or add your location as text below.</Text>
                    </View>
                    <Pressable
                      style={s.retryBtn}
                      onPress={() => setSearchRetry((n) => n + 1)}
                      hitSlop={8}
                      testID="place-search-retry"
                    >
                      <RefreshCw size={13} color={color.signal} />
                      <Text style={s.retryText}>Retry</Text>
                    </Pressable>
                  </View>
                );
              }
              if (item.kind === 'gps') {
                return (
                  <Pressable style={s.row} onPress={useGPS} disabled={gpsState === 'loading' || resolvingId != null}>
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
                  <Pressable style={s.row} onPress={commitFreeText} disabled={resolvingId != null}>
                    <View style={[s.iconCircle, { backgroundColor: `${color.signal}15` }]}>
                      {resolvingId != null
                        ? <ActivityIndicator size="small" color={color.signal} />
                        : <MapPin size={16} color={color.signal} />}
                    </View>
                    <View style={s.rowText}>
                      <Text style={s.rowName}>Use "<Text style={{ fontWeight: '700' }}>{query.trim()}</Text>"</Text>
                      <Text style={s.rowSub}>{cityMode ? 'Add as custom city' : 'Add as custom location'}</Text>
                    </View>
                  </Pressable>
                );
              }
              // Place row
              const { place, icon } = item;
              const resolving = resolvingId === place.id;
              return (
                <Pressable style={s.row} onPress={() => select(place)} disabled={resolvingId != null}>
                  <View style={icon === 'near' ? [s.iconCircle, { backgroundColor: `${color.signal}15` }] : s.iconCircle}>
                    {icon === 'clock' && <Clock size={15} color={color.mute} />}
                    {icon === 'near' && <Navigation size={15} color={color.signal} />}
                    {icon === 'pin' && <MapPin size={15} color={color.mute} />}
                  </View>
                  <View style={s.rowText}>
                    <Text style={s.rowName} numberOfLines={1}>{place.name}</Text>
                    {place.displayName !== place.name && (
                      <Text style={s.rowSub} numberOfLines={1}>{place.displayName}</Text>
                    )}
                  </View>
                  {resolving && <ActivityIndicator size="small" color={color.signal} />}
                </Pressable>
              );
            }}
            ListEmptyComponent={
              showSearch && !searching && !searchError ? (
                <View style={s.empty}>
                  <Text style={s.emptyText}>No places found. Type to enter a custom city.</Text>
                </View>
              ) : null
            }
          />
        </View>
      </KeyboardSafeScrollView>
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
    // DEFINITE height, not maxHeight.
    //
    // `list` below is flex:1, and a flex child of a parent whose height comes
    // from its own content resolves to ZERO. With maxHeight the sheet hugged
    // its header + search field, the results list measured 0pt, and searching
    // for a city returned matches that had nowhere to render — the picker
    // looked like it found nothing. Since this is the only way to set a city,
    // and an unset city leaves `destination` empty, that silently emptied
    // Discovery and the Pulse Wall too.
    height: '85%',
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
  sectionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: space.xs,
  },
  sectionLabel: {
    ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.xl, paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
  },
  iconCircle: {
    width: avatar.s34, height: avatar.s34, borderRadius: avatar.s34 / 2,
    backgroundColor: color.paperRaised,
    alignItems: 'center', justifyContent: 'center',
  },
  rowText: { flex: 1 },
  rowName: { ...t.body, color: color.ink, fontWeight: '600' },
  rowSub: { ...t.small, color: color.mute, marginTop: 1 },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  googleAttrib: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: 4,
  },
  googleAttribText: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
  errorRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    marginHorizontal: space.xl, marginTop: space.sm, marginBottom: space.xs,
    padding: space.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  errorTextWrap: { flex: 1 },
  errorTitle: { ...t.body, color: color.ink, fontWeight: '600' },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: space.md, paddingVertical: 6,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal,
  },
  retryText: { ...t.small, color: color.signal, fontWeight: '700' },
});
