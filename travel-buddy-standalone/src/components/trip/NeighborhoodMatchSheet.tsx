/**
 * NeighborhoodMatchSheet — two-step sheet for the "Where should I stay?" flow.
 *
 * Step 1 — Preferences: sleep-vs-play selector + five priority sliders.
 * Step 2 — Ranked areas: neighborhood cards with compass pick highlighted,
 *           OSM disclaimer, and "Check this location" CTA.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
  Platform,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { X, MapPin, Star, AlertTriangle, Check, Map, List, Maximize2 } from 'lucide-react-native';
import { LocationCheckMapPicker } from './LocationCheckMapPicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import {
  setTripAreaPreferences,
  fetchNeighborhoodMatch,
  runLocationCheck,
  type NeighborhoodArea,
} from '../../services/neighborhoods.ts';
import { useTripSavedPlaces } from '../../hooks/useTripSavedPlaces.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

type SleepVsPlay = 'inside' | 'close' | 'away';

interface Prefs {
  sleepVsPlay: SleepVsPlay | null;
  priorities: {
    nightlife: number;
    food: number;
    culture: number;
    shopping: number;
    quiet: number;
  };
}

interface MatchResult {
  areas: NeighborhoodArea[];
  compassPick?: { name: string; why: string } | null;
  disclaimer?: string;
}

interface LocationVerdict {
  verdict: 'good_fit' | 'moderate' | 'consider_alternatives' | 'insufficient_data';
  distanceToCenterOfGravityKm: number | null;
  areaFit: { areaName: string; matchScore?: number } | null;
  nearestSavedPlaces: Array<{ name: string; distanceKm: number }>;
  centerOfGravity: { lat: number; lng: number; shares?: Record<string, number> } | null;
  locatedPoints: number;
  thresholdNote?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SLEEP_OPTIONS: Array<{ value: SleepVsPlay; label: string; sub: string }> = [
  { value: 'inside', label: 'Inside the Action', sub: 'Stay where it all happens' },
  { value: 'close', label: 'Close to the Action', sub: 'Easy access, quieter nights' },
  { value: 'away', label: 'Away from the Action', sub: 'Peaceful, then venture out' },
];

const PRIORITY_KEYS: Array<{ key: keyof Prefs['priorities']; label: string }> = [
  { key: 'nightlife', label: 'Nightlife' },
  { key: 'food', label: 'Food & Dining' },
  { key: 'culture', label: 'Culture & Arts' },
  { key: 'shopping', label: 'Shopping' },
  { key: 'quiet', label: 'Quiet & Green Space' },
];

const DEFAULT_PREFS: Prefs = {
  sleepVsPlay: null,
  priorities: { nightlife: 50, food: 50, culture: 50, shopping: 50, quiet: 50 },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function StepIndicator({ step }: { step: 1 | 2 }) {
  return (
    <View style={styles.stepRow}>
      {[1, 2].map((n) => (
        <View
          key={n}
          style={[styles.stepDot, n === step && styles.stepDotActive, n < step && styles.stepDotDone]}
        />
      ))}
    </View>
  );
}

function AreaCard({
  area,
  isCompassPick,
  compassWhy,
}: {
  area: NeighborhoodArea;
  isCompassPick: boolean;
  compassWhy?: string;
}) {
  const matchPct = area.matchScore != null ? Math.round(area.matchScore) : null;
  const lowConf = area.confidence === 'low';

  return (
    <View style={[styles.areaCard, isCompassPick && styles.areaCardCompass]}>
      <View style={styles.areaCardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.areaName}>{area.name}</Text>
          {isCompassPick && (
            <View style={styles.compassBadge}>
              <Star size={11} color={color.deep} />
              <Text style={styles.compassBadgeText}>Compass Pick</Text>
            </View>
          )}
        </View>
        {matchPct != null && (
          <View style={styles.matchBadge}>
            <Text style={styles.matchBadgeText}>{matchPct}%</Text>
          </View>
        )}
      </View>

      {/* Factor tags */}
      {area.factors && area.factors.length > 0 && (
        <View style={styles.factorRow}>
          {area.factors.map((f) => (
            <View key={f.key} style={styles.factorTag}>
              <Text style={styles.factorTagText}>
                {f.label} ({Math.round(f.contribution)}/100)
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Day / Night description */}
      {Object.entries(area.dayNight).map(([period, desc]) => (
        <Text key={period} style={styles.dayNightLine}>
          <Text style={styles.dayNightPeriod}>{period === 'day' ? '☀ Day' : '🌙 Night'}: </Text>
          {desc}
        </Text>
      ))}

      {/* Compass pick "why" */}
      {isCompassPick && compassWhy ? (
        <View style={styles.compassWhy}>
          <Text style={styles.compassWhyText}>{compassWhy}</Text>
        </View>
      ) : null}

      {/* Low-confidence caveat */}
      {lowConf && (
        <View style={styles.caveatRow}>
          <AlertTriangle size={12} color={color.warn} />
          <Text style={styles.caveatText}>
            {area.caveat ?? 'Limited data — treat this as a rough guide.'}
          </Text>
        </View>
      )}
    </View>
  );
}

export function LocationCheckSheet({
  tripId,
  onClose,
}: {
  tripId: string;
  onClose: () => void;
}) {
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [selectedPlaceName, setSelectedPlaceName] = useState<string | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verdict, setVerdict] = useState<LocationVerdict | null>(null);
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');
  const [mapFullScreen, setMapFullScreen] = useState(false);

  const insets = useSafeAreaInsets();
  const { places, loading: placesLoading } = useTripSavedPlaces(tripId);
  // Only show places that have coordinates
  const geoPlaces = places.filter((p) => p.lat != null && p.lng != null);

  // Show the map toggle only on native where MapLibre is available.
  const canShowMap = Platform.OS !== 'web' && geoPlaces.length > 0;

  function handleSelectPlace(place: { id?: string; name: string; lat?: number | null; lng?: number | null }) {
    setLat(String(place.lat ?? ''));
    setLng(String(place.lng ?? ''));
    setSelectedPlaceName(place.name);
    setSelectedPlaceId(place.id ?? null);
    // After picking from the map, drop into list mode so the user can
    // confirm the pre-filled coordinates and hit "Check location".
    setViewMode('list');
  }

  async function handleCheck() {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum)) {
      Alert.alert('Invalid coordinates', 'Enter valid latitude and longitude numbers.');
      return;
    }
    setLoading(true);
    const result = await runLocationCheck(tripId, {
      lat: latNum,
      lng: lngNum,
      ...(selectedPlaceName ? { name: selectedPlaceName } : {}),
    });
    setLoading(false);
    if (result) {
      setVerdict(result as unknown as LocationVerdict);
    } else {
      Alert.alert('Check failed', 'Could not verify this location. Try again.');
    }
  }

  function handleCheckAnother() {
    setVerdict(null);
    setLat('');
    setLng('');
    setSelectedPlaceName(null);
    setSelectedPlaceId(null);
    setViewMode(canShowMap ? 'map' : 'list');
  }

  return (
    <View style={styles.locationSheet}>
      <View style={styles.locationSheetHeader}>
        <Text style={styles.locationSheetTitle}>Check this location</Text>
        <Pressable onPress={onClose} hitSlop={8}>
          <X size={20} color={color.mute} />
        </Pressable>
      </View>

      {/* ── Map / List toggle (only when geo places exist on native) ── */}
      {!verdict && canShowMap && (
        <View style={styles.viewModeToggle}>
          <Pressable
            style={[styles.viewModeBtn, viewMode === 'map' && styles.viewModeBtnActive]}
            onPress={() => setViewMode('map')}
            accessibilityRole="tab"
            accessibilityState={{ selected: viewMode === 'map' }}
            accessibilityLabel="Map view"
          >
            <Map size={14} color={viewMode === 'map' ? color.onInk : color.mute} />
            <Text style={[styles.viewModeBtnText, viewMode === 'map' && styles.viewModeBtnTextActive]}>
              Map
            </Text>
          </Pressable>
          <Pressable
            style={[styles.viewModeBtn, viewMode === 'list' && styles.viewModeBtnActive]}
            onPress={() => setViewMode('list')}
            accessibilityRole="tab"
            accessibilityState={{ selected: viewMode === 'list' }}
            accessibilityLabel="List view"
          >
            <List size={14} color={viewMode === 'list' ? color.onInk : color.mute} />
            <Text style={[styles.viewModeBtnText, viewMode === 'list' && styles.viewModeBtnTextActive]}>
              List
            </Text>
          </Pressable>
        </View>
      )}

      {verdict ? (
        <View style={styles.verdictCard}>
          {/* Checked place name */}
          {selectedPlaceName ? (
            <Text style={[styles.verdictLabel, { marginBottom: space.xs }]}>
              Checking: <Text style={styles.verdictValue}>{selectedPlaceName}</Text>
            </Text>
          ) : null}

          {/* Verdict label */}
          <Text style={styles.verdictLabel} testID="verdict-label">
            Fit:{' '}
            <Text style={styles.verdictValue}>
              {verdict.verdict === 'good_fit' ? '✓ Good fit'
                : verdict.verdict === 'moderate' ? '~ Moderate fit'
                : verdict.verdict === 'consider_alternatives' ? '⚠ Consider alternatives'
                : 'Insufficient data'}
            </Text>
          </Text>

          {/* Distance to center of gravity */}
          {verdict.distanceToCenterOfGravityKm != null && (
            <Text style={styles.verdictLabel}>
              Distance to trip center:{' '}
              <Text style={styles.verdictValue}>{verdict.distanceToCenterOfGravityKm} km</Text>
            </Text>
          )}

          {/* Area fit */}
          {verdict.areaFit != null && (
            <Text style={styles.verdictLabel}>
              Nearest area:{' '}
              <Text style={styles.verdictValue}>
                {verdict.areaFit.areaName}
                {verdict.areaFit.matchScore != null ? ` (${Math.round(verdict.areaFit.matchScore * 100)}% match)` : ''}
              </Text>
            </Text>
          )}

          {/* Nearest saved places */}
          {verdict.nearestSavedPlaces.length > 0 && (
            <>
              <Text style={[styles.verdictLabel, { marginTop: space.xs }]}>Nearby saved places:</Text>
              {verdict.nearestSavedPlaces.slice(0, 3).map((p) => (
                <Text key={p.name} style={styles.verdictLabel}>
                  {'  '}<Text style={styles.verdictValue}>{p.name}</Text> — {p.distanceKm} km
                </Text>
              ))}
            </>
          )}

          {/* Center-of-gravity shares */}
          {verdict.centerOfGravity?.shares && Object.keys(verdict.centerOfGravity.shares).length > 0 && (
            <>
              <Text style={[styles.verdictLabel, { marginTop: space.xs }]}>Trip gravity breakdown:</Text>
              {Object.entries(verdict.centerOfGravity.shares).map(([k, v]) => (
                <Text key={k} style={styles.verdictLabel}>
                  {'  '}{k}: <Text style={styles.verdictValue}>{Math.round(Number(v) * 100)}%</Text>
                </Text>
              ))}
            </>
          )}

          <Pressable style={styles.locationCheckBtn} onPress={handleCheckAnother}>
            <Text style={styles.locationCheckBtnText}>Check another</Text>
          </Pressable>
        </View>
      ) : canShowMap && viewMode === 'map' ? (
        /* ── Map picker view ── */
        <>
          <View style={styles.mapPickerSection}>
            {placesLoading ? (
              <View style={styles.mapPickerContainer}>
                <ActivityIndicator size="small" color={color.signal} />
              </View>
            ) : (
              <View style={styles.mapPickerContainer}>
                <LocationCheckMapPicker
                  places={geoPlaces}
                  selectedId={selectedPlaceId}
                  onSelect={handleSelectPlace}
                />
                {/* Expand button — top-right corner of the map */}
                <Pressable
                  style={styles.mapExpandBtn}
                  onPress={() => setMapFullScreen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Expand map to full screen"
                  hitSlop={8}
                >
                  <Maximize2 size={14} color="#fff" />
                </Pressable>
              </View>
            )}
            <Text style={styles.mapPickerHint}>
              Tap a pin, then "Use this location" to pre-fill coordinates.
            </Text>
          </View>

          {/* ── Full-screen map modal ── */}
          <Modal
            visible={mapFullScreen}
            animationType="slide"
            presentationStyle="fullScreen"
            onRequestClose={() => setMapFullScreen(false)}
          >
            <View style={[styles.fullScreenModal, { paddingTop: insets.top }]}>
              {/* Header */}
              <View style={styles.fullScreenHeader}>
                <Text style={styles.fullScreenHeaderTitle}>Pick a location</Text>
                <Pressable
                  onPress={() => setMapFullScreen(false)}
                  hitSlop={8}
                  accessibilityLabel="Close full-screen map"
                >
                  <X size={22} color={color.mute} />
                </Pressable>
              </View>
              {/* Map fills remaining space */}
              <View style={styles.fullScreenMapContainer}>
                <LocationCheckMapPicker
                  places={geoPlaces}
                  selectedId={selectedPlaceId}
                  onSelect={(place) => {
                    handleSelectPlace(place);
                    setMapFullScreen(false);
                  }}
                />
              </View>
            </View>
          </Modal>
        </>
      ) : (
        /* ── List + manual entry view ── */
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* ── Saved places picker ── */}
          {placesLoading ? (
            <ActivityIndicator size="small" color={color.signal} style={{ marginBottom: space.md }} />
          ) : geoPlaces.length > 0 ? (
            <View style={styles.savedPlacesSection}>
              <Text style={styles.savedPlacesSectionLabel}>Pick a saved place</Text>
              {geoPlaces.map((place) => {
                const isSelected = selectedPlaceName === place.name;
                return (
                  <Pressable
                    key={place.id}
                    style={[styles.savedPlaceRow, isSelected && styles.savedPlaceRowSelected]}
                    onPress={() => handleSelectPlace(place)}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${place.name}`}
                  >
                    <View style={styles.savedPlaceIconWrap}>
                      <MapPin size={14} color={isSelected ? color.onInk : color.signal} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.savedPlaceName, isSelected && styles.savedPlaceNameSelected]} numberOfLines={1}>
                        {place.name}
                      </Text>
                      {place.category ? (
                        <Text style={styles.savedPlaceCategory} numberOfLines={1}>{place.category}</Text>
                      ) : null}
                    </View>
                    {isSelected && <Check size={16} color={color.onInk} />}
                  </Pressable>
                );
              })}
              <View style={styles.savedPlacesDivider}>
                <View style={styles.savedPlacesDividerLine} />
                <Text style={styles.savedPlacesDividerText}>or enter manually</Text>
                <View style={styles.savedPlacesDividerLine} />
              </View>
            </View>
          ) : null}

          {/* ── Manual coordinate entry ── */}
          <Text style={styles.locationSheetSub}>
            {geoPlaces.length > 0
              ? 'Adjust coordinates or type new ones below.'
              : 'Enter coordinates to check how this spot fits your trip preferences.'}
          </Text>
          {selectedPlaceName ? (
            <View style={styles.selectedPlacePill}>
              <MapPin size={12} color={color.signal} />
              <Text style={styles.selectedPlacePillText} numberOfLines={1}>{selectedPlaceName}</Text>
              <Pressable
                hitSlop={8}
                onPress={() => { setSelectedPlaceName(null); setSelectedPlaceId(null); }}
                accessibilityLabel="Clear selected place"
              >
                <X size={13} color={color.mute} />
              </Pressable>
            </View>
          ) : null}
          <View style={styles.coordRow}>
            <TextInput
              style={styles.coordInput}
              placeholder="Latitude"
              placeholderTextColor={color.faint}
              keyboardType="decimal-pad"
              value={lat}
              onChangeText={(v) => { setLat(v); setSelectedPlaceName(null); setSelectedPlaceId(null); }}
              accessibilityLabel="Latitude"
            />
            <TextInput
              style={styles.coordInput}
              placeholder="Longitude"
              placeholderTextColor={color.faint}
              keyboardType="decimal-pad"
              value={lng}
              onChangeText={(v) => { setLng(v); setSelectedPlaceName(null); setSelectedPlaceId(null); }}
              accessibilityLabel="Longitude"
            />
          </View>
          <Pressable
            style={[styles.locationCheckBtn, loading && { opacity: 0.6 }]}
            onPress={handleCheck}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator size="small" color={color.onInk} />
              : <Text style={styles.locationCheckBtnText}>Check location</Text>}
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface NeighborhoodMatchSheetProps {
  visible: boolean;
  tripId: string;
  onClose: () => void;
}

export function NeighborhoodMatchSheet({ visible, tripId, onClose }: NeighborhoodMatchSheetProps) {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<1 | 2>(1);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [locationCheckOpen, setLocationCheckOpen] = useState(false);

  function handleClose() {
    setStep(1);
    setPrefs(DEFAULT_PREFS);
    setResult(null);
    setLocationCheckOpen(false);
    onClose();
  }

  async function handleSubmitPrefs() {
    setSubmitting(true);
    // Backend expects priorities as 0..1 floats; sliders store 0..100 integers.
    const scaledPriorities = Object.fromEntries(
      Object.entries(prefs.priorities).map(([k, v]) => [k, v / 100]),
    ) as Record<string, number>;
    await setTripAreaPreferences(tripId, {
      sleepVsPlay: prefs.sleepVsPlay,
      priorities: scaledPriorities,
    });
    const match = await fetchNeighborhoodMatch(tripId);
    setSubmitting(false);
    setResult(match);
    setStep(2);
  }

  function setPriority(key: keyof Prefs['priorities'], value: number) {
    setPrefs((p) => ({ ...p, priorities: { ...p.priorities, [key]: Math.round(value) } }));
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <View style={[styles.container, { paddingTop: insets.top + space.sm }]}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            {step === 1 ? 'Where should I stay?' : 'Neighborhood matches'}
          </Text>
          <Pressable onPress={handleClose} hitSlop={8} accessibilityLabel="Close">
            <X size={22} color={color.mute} />
          </Pressable>
        </View>

        <StepIndicator step={step} />

        {/* ── Step 1: Preferences ── */}
        {step === 1 && (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.step1Content} showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionLabel}>Sleep style</Text>
            {SLEEP_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                style={[styles.sleepOption, prefs.sleepVsPlay === opt.value && styles.sleepOptionActive]}
                onPress={() => setPrefs((p) => ({ ...p, sleepVsPlay: opt.value }))}
                accessibilityRole="radio"
                accessibilityState={{ selected: prefs.sleepVsPlay === opt.value }}
              >
                <Text style={[styles.sleepOptionLabel, prefs.sleepVsPlay === opt.value && styles.sleepOptionLabelActive]}>
                  {opt.label}
                </Text>
                <Text style={[styles.sleepOptionSub, prefs.sleepVsPlay === opt.value && styles.sleepOptionSubActive]}>
                  {opt.sub}
                </Text>
              </Pressable>
            ))}

            <Text style={[styles.sectionLabel, { marginTop: space.xl }]}>Priorities</Text>
            {PRIORITY_KEYS.map(({ key, label }) => (
              <View key={key} style={styles.sliderRow}>
                <View style={styles.sliderLabelRow}>
                  <Text style={styles.sliderLabel}>{label}</Text>
                  <Text style={styles.sliderValue}>{prefs.priorities[key]}</Text>
                </View>
                <Slider
                  minimumValue={0}
                  maximumValue={100}
                  step={1}
                  value={prefs.priorities[key]}
                  onValueChange={(v) => setPriority(key, v)}
                  minimumTrackTintColor={color.signal}
                  maximumTrackTintColor={color.haze}
                  thumbTintColor={color.signal}
                  accessibilityLabel={label}
                />
              </View>
            ))}

            <Pressable
              style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
              onPress={handleSubmitPrefs}
              disabled={submitting}
            >
              {submitting
                ? <ActivityIndicator size="small" color={color.onInk} />
                : <Text style={styles.submitBtnText}>Find neighborhoods →</Text>}
            </Pressable>
          </ScrollView>
        )}

        {/* ── Step 2: Ranked areas ── */}
        {step === 2 && (
          <>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.step2Content} showsVerticalScrollIndicator={false}>
              {result && result.areas.length > 0 ? (
                result.areas.map((area, i) => {
                  const isCompassPick = !!(result.compassPick && result.compassPick.name === area.name);
                  return (
                    <AreaCard
                      key={`${area.name}-${i}`}
                      area={area}
                      isCompassPick={isCompassPick}
                      compassWhy={isCompassPick ? result.compassPick?.why : undefined}
                    />
                  );
                })
              ) : (
                <View style={styles.emptyState}>
                  <MapPin size={28} color={color.mute} />
                  <Text style={styles.emptyStateText}>No area data available for this trip.</Text>
                </View>
              )}

              {result?.disclaimer ? (
                <Text style={styles.disclaimer}>{result.disclaimer}</Text>
              ) : null}
            </ScrollView>

            {/* Check this location CTA */}
            <View style={[styles.step2Footer, { paddingBottom: insets.bottom + space.md }]}>
              <Pressable style={styles.locationCheckCta} onPress={() => setLocationCheckOpen(true)}>
                <MapPin size={15} color={color.signal} />
                <Text style={styles.locationCheckCtaText}>Check this location</Text>
              </Pressable>
              <Pressable style={styles.backBtn} onPress={() => setStep(1)}>
                <Text style={styles.backBtnText}>← Adjust preferences</Text>
              </Pressable>
            </View>

            {/* Location-check sub-sheet */}
            <Modal
              visible={locationCheckOpen}
              animationType="slide"
              presentationStyle="formSheet"
              onRequestClose={() => setLocationCheckOpen(false)}
            >
              <LocationCheckSheet tripId={tripId} onClose={() => setLocationCheckOpen(false)} />
            </Modal>
          </>
        )}
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  headerTitle: {
    ...t.heading,
    color: color.ink,
    flex: 1,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.md,
  },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: color.haze,
  },
  stepDotActive: {
    backgroundColor: color.signal,
    width: 20,
    borderRadius: 4,
  },
  stepDotDone: {
    backgroundColor: color.deep,
  },
  // Step 1
  step1Content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxxl,
  },
  sectionLabel: {
    ...t.stamp,
    color: color.deep,
    letterSpacing: 1.2,
    marginBottom: space.sm,
    fontFamily: 'Courier',
  },
  sleepOption: {
    borderWidth: 1.5,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.sm,
    backgroundColor: color.paperRaised,
  },
  sleepOptionActive: {
    borderColor: color.signal,
    backgroundColor: '#FFF5F3',
  },
  sleepOptionLabel: {
    ...t.bodyStrong,
    color: color.ink,
  },
  sleepOptionLabelActive: {
    color: color.signal,
  },
  sleepOptionSub: {
    ...t.small,
    color: color.mute,
    marginTop: 2,
  },
  sleepOptionSubActive: {
    color: color.signal,
    opacity: 0.8,
  },
  sliderRow: {
    marginBottom: space.md,
  },
  sliderLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  sliderLabel: {
    ...t.small,
    color: color.ink,
    fontWeight: '600',
  },
  sliderValue: {
    ...t.stamp,
    color: color.deep,
    fontFamily: 'Courier',
  },
  submitBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
    marginTop: space.xl,
  },
  submitBtnText: {
    ...t.bodyStrong,
    color: color.onInk,
  },
  // Step 2
  step2Content: {
    padding: space.lg,
    paddingBottom: space.xxl,
    gap: space.md,
  },
  areaCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    gap: space.sm,
    ...shadow.card,
  },
  areaCardCompass: {
    borderColor: color.deep,
    borderWidth: 2,
    backgroundColor: '#F0F7F9',
  },
  areaCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  areaName: {
    ...t.heading,
    color: color.ink,
    fontSize: 17,
  },
  compassBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  compassBadgeText: {
    ...t.stamp,
    color: color.deep,
    fontFamily: 'Courier',
    fontSize: 10,
    letterSpacing: 1,
  },
  matchBadge: {
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  matchBadgeText: {
    ...t.stamp,
    color: color.onInk,
    fontFamily: 'Courier',
    fontSize: 12,
  },
  factorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  factorTag: {
    backgroundColor: color.paper,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  factorTagText: {
    ...t.stamp,
    color: color.deep,
    fontFamily: 'Courier',
    fontSize: 10,
  },
  dayNightLine: {
    ...t.small,
    color: color.mute,
  },
  dayNightPeriod: {
    fontWeight: '600',
    color: color.ink,
  },
  compassWhy: {
    backgroundColor: color.paper,
    borderRadius: radius.sm,
    padding: space.sm,
    borderLeftWidth: 3,
    borderLeftColor: color.deep,
  },
  compassWhyText: {
    ...t.small,
    color: color.ink,
    fontStyle: 'italic',
  },
  caveatRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
  },
  caveatText: {
    ...t.stamp,
    color: color.warn,
    fontFamily: 'Courier',
    flex: 1,
    fontSize: 11,
  },
  disclaimer: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    paddingHorizontal: space.md,
    marginTop: space.md,
    lineHeight: 18,
  },
  emptyState: {
    padding: space.xxl,
    alignItems: 'center',
    gap: space.sm,
  },
  emptyStateText: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
  },
  step2Footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    gap: space.sm,
  },
  locationCheckCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderWidth: 1.5,
    borderColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md,
    backgroundColor: color.paperRaised,
  },
  locationCheckCtaText: {
    ...t.bodyStrong,
    color: color.signal,
  },
  backBtn: {
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  backBtnText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
  },
  // Location check sub-sheet
  locationSheet: {
    flex: 1,
    backgroundColor: color.paper,
    padding: space.lg,
  },
  locationSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  locationSheetTitle: {
    ...t.heading,
    color: color.ink,
  },
  locationSheetSub: {
    ...t.small,
    color: color.mute,
    marginBottom: space.lg,
  },
  coordRow: {
    flexDirection: 'row',
    gap: space.md,
    marginBottom: space.lg,
  },
  coordInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    ...t.body,
    color: color.ink,
    backgroundColor: color.paperRaised,
  },
  locationCheckBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  locationCheckBtnText: {
    ...t.bodyStrong,
    color: color.onInk,
  },
  verdictCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    gap: space.sm,
    ...shadow.card,
  },
  verdictLabel: {
    ...t.small,
    color: color.mute,
  },
  verdictValue: {
    ...t.small,
    color: color.ink,
    fontWeight: '700',
  },
  // View mode toggle (Map / List)
  viewModeToggle: {
    flexDirection: 'row',
    backgroundColor: color.haze,
    borderRadius: radius.sm,
    padding: 3,
    marginBottom: space.md,
    alignSelf: 'center',
  },
  viewModeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.lg,
    paddingVertical: 6,
    borderRadius: radius.sm - 2,
  },
  viewModeBtnActive: {
    backgroundColor: color.signal,
  },
  viewModeBtnText: {
    ...t.small,
    fontWeight: '600',
    color: color.mute,
    fontSize: 13,
  },
  viewModeBtnTextActive: {
    color: color.onInk,
  },
  // Map picker section
  mapPickerSection: {
    flex: 1,
    gap: space.sm,
  },
  mapPickerContainer: {
    flex: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginHorizontal: -space.lg,
    minHeight: 240,
  },
  mapPickerHint: {
    ...t.small,
    fontSize: 11,
    color: color.faint,
    textAlign: 'center',
  },
  mapExpandBtn: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Full-screen map modal
  fullScreenModal: {
    flex: 1,
    backgroundColor: color.paper,
  },
  fullScreenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  fullScreenHeaderTitle: {
    ...t.heading,
    color: color.ink,
    flex: 1,
  },
  fullScreenMapContainer: {
    flex: 1,
  },
  // Saved places picker (inside LocationCheckSheet)
  savedPlacesSection: {
    marginBottom: space.sm,
  },
  savedPlacesSectionLabel: {
    ...t.stamp,
    color: color.deep,
    letterSpacing: 1.1,
    fontFamily: 'Courier',
    marginBottom: space.sm,
  },
  savedPlaceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    marginBottom: space.xs,
  },
  savedPlaceRowSelected: {
    borderColor: color.signal,
    backgroundColor: color.signal,
  },
  savedPlaceIconWrap: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: `${color.signal}15`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  savedPlaceName: {
    ...t.bodyStrong,
    fontSize: 13,
    color: color.ink,
  },
  savedPlaceNameSelected: {
    color: color.onInk,
  },
  savedPlaceCategory: {
    ...t.small,
    fontSize: 11,
    color: color.mute,
    textTransform: 'capitalize',
  },
  savedPlacesDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.sm,
    marginBottom: space.md,
  },
  savedPlacesDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: color.haze,
  },
  savedPlacesDividerText: {
    ...t.small,
    color: color.faint,
    fontSize: 11,
  },
  selectedPlacePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: `${color.signal}12`,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    alignSelf: 'flex-start',
    marginBottom: space.sm,
    borderWidth: 1,
    borderColor: `${color.signal}30`,
  },
  selectedPlacePillText: {
    ...t.small,
    color: color.signal,
    fontWeight: '600',
    maxWidth: 200,
  },
});
