/**
 * GeofenceSettingsSheet — host geofence configuration for plan meetups.
 * Only renders when plan_geofence_enabled feature flag is on.
 * Gated: shows nothing until featureEnabled=true from the API.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, Switch,
  Alert, StyleSheet, TextInput,
} from 'react-native';
import { X, MapPin, Clock, Users, Eye, Shield } from 'lucide-react-native';
import { color, space, radius, type as t, icon, dot} from '../../theme/tokens.ts';
import { GpsLocationCapture } from '../location/GpsLocationCapture.tsx';
import { GlobalPlacePicker } from '../selectors/GlobalPlacePicker.tsx';
import { resolvePickedPlace } from '../../lib/location/applyPickedPlace.ts';
import type { Place } from '../../lib/location/placeTypes.ts';
import { KeyboardSafeScrollView } from '../ui/KeyboardSafeView.tsx';
import {
  setGeofence, revealExactLocation,
  type PublicPreviewLevel, type ExactVisibility, type GeofenceData,
} from '../../services/geofence.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GeofenceSettingsSheetProps {
  tripId: string;
  isOwner: boolean;
  featureEnabled: boolean;
  existing: GeofenceData | null;
  onClose: () => void;
  onSaved: () => void;
}

// ── Option maps ───────────────────────────────────────────────────────────────

const PREVIEW_OPTIONS: { value: PublicPreviewLevel; label: string; desc: string }[] = [
  { value: 'city_only',     label: 'City only',         desc: 'Guests see the city name only' },
  { value: 'neighborhood',  label: 'Neighborhood',      desc: 'Guests see the neighborhood area' },
  { value: 'venue_tagged',  label: 'Venue tagged',      desc: 'Guests see the venue name (no address)' },
];

const EXACT_VIS_OPTIONS: { value: ExactVisibility; label: string; desc: string }[] = [
  { value: 'exact_after_acceptance', label: 'Reveal after acceptance', desc: 'Accepted guests see the full location immediately' },
  { value: 'exact_private_host_reveal', label: "I'll reveal it manually", desc: 'You reveal the exact location when ready' },
];

const RADIUS_PRESETS = [50, 100, 150, 250, 500];

// ── Main component ────────────────────────────────────────────────────────────

export function GeofenceSettingsSheet({
  tripId, isOwner, featureEnabled, existing, onClose, onSaved,
}: GeofenceSettingsSheetProps) {
  const [lat, setLat] = useState(String(existing ? '0' : ''));
  const [lng, setLng] = useState(String(existing ? '0' : ''));
  const [locationName, setLocationName] = useState(existing?.locationName ?? '');
  const [city, setCity] = useState(existing?.city ?? '');
  const [neighborhood, setNeighborhood] = useState(existing?.neighborhood ?? '');
  const [venueName, setVenueName] = useState(existing?.venueName ?? '');
  const [placePickerOpen, setPlacePickerOpen] = useState(false);
  const [publicPreviewLevel, setPublicPreviewLevel] = useState<PublicPreviewLevel>(existing?.publicPreviewLevel ?? 'neighborhood');

  /**
   * Picking a canonical place fills the public-preview labels.
   *
   * These three fields were free text with no autocomplete: whatever was typed
   * was persisted verbatim, so "Bkk", "bangkok" and "Bangkok" were three
   * different cities to every consumer that groups by this string.
   *
   * The picker is available and preferred, never required — a host whose venue
   * is in a town no global place index carries must still be able to save. What
   * a pick must NOT do is overwrite text the host already typed; that is the
   * defect EventComposerSheet.tsx:604 and app/events/create/index.tsx:927 both
   * carry a "QA round 2, bug 6" comment about. resolvePickedPlace draws that
   * line once, here and in the other composers alike.
   */
  const handlePlacePicked = useCallback((place: Place) => {
    setPlacePickerOpen(false);
    const { fill, conflict, hasConflict } = resolvePickedPlace(place, {
      city, neighborhood,
    });
    if (fill.city) setCity(fill.city);
    if (fill.neighborhood) setNeighborhood(fill.neighborhood);
    if (place.lat != null) setLat(String(place.lat));
    if (place.lng != null) setLng(String(place.lng));
    if (!locationName.trim() && place.displayName) setLocationName(place.displayName);
    if (!hasConflict) return;
    Alert.alert(
      'Replace what you typed?',
      `${place.displayName} is linked. Replace the public labels you entered with its own?`,
      [
        { text: 'Keep mine', style: 'cancel' },
        {
          text: 'Use this place',
          onPress: () => {
            if (conflict.city) setCity(conflict.city);
            if (conflict.neighborhood) setNeighborhood(conflict.neighborhood);
          },
        },
      ],
    );
  }, [city, neighborhood, locationName]);
  const [exactVisibility, setExactVisibility] = useState<ExactVisibility>(existing?.exactVisibility ?? 'exact_after_acceptance');
  const [checkInRequired, setCheckInRequired] = useState(existing?.checkInRequired ?? false);
  const [radiusM, setRadiusM] = useState(existing?.checkInRadiusM ?? 150);
  const [arrivalStatusVisible, setArrivalStatusVisible] = useState(existing?.arrivalStatusVisible ?? true);
  const [noShowAffectsReliability, setNoShowAffectsReliability] = useState(existing?.noShowAffectsReliability ?? false);
  const [hostEnabled, setHostEnabled] = useState(existing?.hostEnabled ?? true);
  const [revealing, setRevealing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  if (!featureEnabled || !isOwner) return null;

  const handleSave = async () => {
    const latN = parseFloat(lat);
    const lngN = parseFloat(lng);
    if (isNaN(latN) || isNaN(lngN)) {
      setErr('Enter valid coordinates (lat/lng) for the meetup location.');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await setGeofence(tripId, {
        lat: latN,
        lng: lngN,
        locationName: locationName.trim() || null,
        city: city.trim() || null,
        neighborhood: neighborhood.trim() || null,
        venueName: venueName.trim() || null,
        publicPreviewLevel,
        exactVisibility,
        checkInRequired,
        checkInRadiusM: radiusM,
        arrivalStatusVisible,
        noShowAffectsReliability,
        hostEnabled,
      });
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e.message ?? 'Could not save geofence settings');
    } finally {
      setSaving(false);
    }
  };

  const handleReveal = () => {
    Alert.alert(
      'Reveal exact location?',
      'Accepted members will immediately see the exact meetup details.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reveal now',
          onPress: async () => {
            setRevealing(true);
            try {
              await revealExactLocation(tripId);
              Alert.alert('Location revealed', 'Accepted members can now see the exact meetup details.');
              onSaved();
            } catch (e: any) {
              Alert.alert('Error', e.message ?? 'Could not reveal location');
            } finally {
              setRevealing(false);
            }
          },
        },
      ],
    );
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardSafeScrollView style={{ justifyContent: 'flex-end' }}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={s.sheet}>
          <View style={s.handle} />

          <View style={s.header}>
            <Shield size={18} color={color.deep} />
            <Text style={s.headerTitle}>Meetup Location Settings</Text>
            <Pressable onPress={onClose} hitSlop={8} style={{ marginLeft: 'auto' }}>
              <X size={20} color={color.mute} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

            {/* Enable/disable toggle */}
            <View style={s.row}>
              <Text style={s.label}>Enable geofence for this trip</Text>
              <Switch value={hostEnabled} onValueChange={setHostEnabled} trackColor={{ true: color.deep }} />
            </View>

            {hostEnabled && (
              <>
                {/* Exact meetup coordinates (private — never shown to guests) */}
                <View style={s.section}>
                  <View style={s.sectionHeader}>
                    <MapPin size={14} color={color.deep} />
                    <Text style={s.sectionTitle}>Meetup coordinates</Text>
                    <Text style={s.badge}>Private</Text>
                  </View>
                  <Text style={s.sectionDesc}>These stay server-side only. Guests never see raw GPS coordinates.</Text>

                  <GpsLocationCapture
                    onCapture={(result) => {
                      if (result) {
                        setLat(String(result.lat));
                        setLng(String(result.lng));
                      } else {
                        setLat('');
                        setLng('');
                      }
                    }}
                  />

                  <Text style={s.fieldLabel}>Venue / location name <Text style={s.opt}>(shown to accepted members)</Text></Text>
                  <TextInput
                    style={s.input}
                    value={locationName}
                    onChangeText={setLocationName}
                    placeholder="e.g. Le Labo Rooftop"
                    placeholderTextColor={color.faint}
                  />
                </View>

                {/* Public location labels */}
                <View style={s.section}>
                  <View style={s.sectionHeader}>
                    <Eye size={14} color={color.deep} />
                    <Text style={s.sectionTitle}>What non-accepted guests see</Text>
                  </View>
                  <Text style={s.fieldLabel}>City (for public preview)</Text>
                  <Pressable
                    testID="geofence-pick-place"
                    style={s.pickPlaceBtn}
                    onPress={() => setPlacePickerOpen(true)}
                  >
                    <MapPin size={13} color={color.signal} />
                    <Text style={s.pickPlaceText}>Search for a place</Text>
                  </Pressable>
                  <TextInput style={s.input} value={city} onChangeText={setCity} placeholder="e.g. Paris" placeholderTextColor={color.faint} />
                  <Text style={s.fieldLabel}>Neighborhood <Text style={s.opt}>(optional)</Text></Text>
                  <TextInput style={s.input} value={neighborhood} onChangeText={setNeighborhood} placeholder="e.g. Le Marais" placeholderTextColor={color.faint} />
                  <Text style={s.fieldLabel}>Venue tag <Text style={s.opt}>(optional)</Text></Text>
                  <TextInput style={s.input} value={venueName} onChangeText={setVenueName} placeholder="e.g. Rooftop bar" placeholderTextColor={color.faint} />

                  <Text style={[s.fieldLabel, { marginTop: space.md }]}>Preview level for non-accepted guests</Text>
                  {PREVIEW_OPTIONS.map((opt) => (
                    <Pressable
                      key={opt.value}
                      style={[s.optionRow, publicPreviewLevel === opt.value && s.optionRowActive]}
                      onPress={() => setPublicPreviewLevel(opt.value)}
                    >
                      <View style={s.radioOuter}>
                        {publicPreviewLevel === opt.value && <View style={s.radioInner} />}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.optionLabel, publicPreviewLevel === opt.value && s.optionLabelActive]}>{opt.label}</Text>
                        <Text style={s.optionDesc}>{opt.desc}</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>

                {/* Exact location visibility */}
                <View style={s.section}>
                  <View style={s.sectionHeader}>
                    <Eye size={14} color={color.deep} />
                    <Text style={s.sectionTitle}>Exact location visibility for accepted guests</Text>
                  </View>
                  {EXACT_VIS_OPTIONS.map((opt) => (
                    <Pressable
                      key={opt.value}
                      style={[s.optionRow, exactVisibility === opt.value && s.optionRowActive]}
                      onPress={() => setExactVisibility(opt.value)}
                    >
                      <View style={s.radioOuter}>
                        {exactVisibility === opt.value && <View style={s.radioInner} />}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.optionLabel, exactVisibility === opt.value && s.optionLabelActive]}>{opt.label}</Text>
                        <Text style={s.optionDesc}>{opt.desc}</Text>
                      </View>
                    </Pressable>
                  ))}

                  {exactVisibility === 'exact_private_host_reveal' && existing?.id && !existing?.hostRevealed && (
                    <Pressable style={[s.revealBtn, revealing && { opacity: 0.5 }]} onPress={handleReveal} disabled={revealing}>
                      <Text style={s.revealBtnText}>{revealing ? 'Revealing…' : 'Reveal exact location now'}</Text>
                    </Pressable>
                  )}
                  {existing?.hostRevealed && (
                    <Text style={s.revealedLabel}>✓ Exact location has been revealed to accepted members.</Text>
                  )}
                </View>

                {/* Check-in settings */}
                <View style={s.section}>
                  <View style={s.sectionHeader}>
                    <Clock size={14} color={color.deep} />
                    <Text style={s.sectionTitle}>Check-in settings</Text>
                  </View>

                  <View style={s.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.optionLabel}>Require check-in</Text>
                      <Text style={s.optionDesc}>Members must check in to confirm attendance</Text>
                    </View>
                    <Switch value={checkInRequired} onValueChange={setCheckInRequired} trackColor={{ true: color.deep }} />
                  </View>

                  {checkInRequired && (
                    <>
                      <Text style={[s.fieldLabel, { marginTop: space.md }]}>Check-in radius</Text>
                      <View style={s.presetRow}>
                        {RADIUS_PRESETS.map((r) => (
                          <Pressable
                            key={r}
                            style={[s.presetChip, radiusM === r && s.presetChipActive]}
                            onPress={() => setRadiusM(r)}
                          >
                            <Text style={[s.presetText, radiusM === r && s.presetTextActive]}>{r}m</Text>
                          </Pressable>
                        ))}
                      </View>
                      <Text style={s.optionDesc}>Members must be within {radiusM}m of the meetup to check in.</Text>
                    </>
                  )}
                </View>

                {/* Attendance visibility */}
                <View style={s.section}>
                  <View style={s.sectionHeader}>
                    <Users size={14} color={color.deep} />
                    <Text style={s.sectionTitle}>Attendance visibility</Text>
                  </View>

                  <View style={s.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.optionLabel}>Show arrival status to attendees</Text>
                      <Text style={s.optionDesc}>Attendees see each other's status (Arrived, On the way, etc.) — no map pins</Text>
                    </View>
                    <Switch value={arrivalStatusVisible} onValueChange={setArrivalStatusVisible} trackColor={{ true: color.deep }} />
                  </View>

                  <View style={[s.row, { marginTop: space.md }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.optionLabel}>Record late / no-show</Text>
                      <Text style={s.optionDesc}>No-shows are recorded for future reliability features (never auto-penalised now)</Text>
                    </View>
                    <Switch value={noShowAffectsReliability} onValueChange={setNoShowAffectsReliability} trackColor={{ true: color.deep }} />
                  </View>
                </View>
              </>
            )}

            {err ? <Text style={s.errText}>{err}</Text> : null}

            <Pressable style={[s.saveBtn, saving && { opacity: 0.5 }]} onPress={handleSave} disabled={saving}>
              <Text style={s.saveBtnText}>{saving ? 'Saving…' : 'Save Geofence Settings'}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardSafeScrollView>

      {/* Mounted only while open: the picker reads safe-area insets and starts
          its own location work on mount, and neither is worth paying for while
          it is invisible. It also keeps this modal renderable without a
          SafeAreaProvider, which is how its existing tests render it. */}
      {placePickerOpen && (
      <GlobalPlacePicker
        visible={placePickerOpen}
        title="Meetup location"
        placeholder="City, venue or address…"
        allowGPS
        usedFor="geofence_location"
        onSelect={handlePlacePicked}
        onClose={() => setPlacePickerOpen(false)}
      />
      )}
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  overlay:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet:         { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '93%' },
  handle:        { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  header:        { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  headerTitle:   { ...t.body, color: color.ink, fontWeight: '700', fontSize: 16 },
  body:          { paddingHorizontal: space.lg, paddingBottom: 48, gap: 4 },
  section:       { backgroundColor: '#F8F7F4', borderRadius: radius.md, padding: space.md, gap: 8, marginTop: space.md },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionTitle:  { ...t.body, color: color.ink, fontWeight: '700' },
  sectionDesc:   { ...t.small, color: color.mute },
  badge:         { backgroundColor: '#E3F1EA', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, ...t.small, color: color.success, fontWeight: '700', marginLeft: 'auto' },
  row:           { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label:         { ...t.body, color: color.ink, fontWeight: '600', flex: 1 },
  fieldLabel:    { ...t.small, color: color.mute, fontWeight: '600' },
  opt:           { fontWeight: '400', color: color.faint },
  input:         { backgroundColor: '#fff', borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, padding: 10, ...t.body, color: color.ink },
  optionRow:     { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 10, borderRadius: radius.sm, backgroundColor: '#fff', borderWidth: 1, borderColor: color.haze },
  optionRowActive:{ borderColor: color.deep, backgroundColor: '#EFF5F7' },
  radioOuter:    { width: icon.s18, height: icon.s18, borderRadius: icon.s18 / 2, borderWidth: 2, borderColor: color.mute, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  radioInner:    { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2, backgroundColor: color.deep },
  optionLabel:   { ...t.body, color: color.ink, fontWeight: '600' },
  optionLabelActive: { color: color.deep },
  optionDesc:    { ...t.small, color: color.mute },
  presetRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  presetChip:    { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: color.haze },
  presetChipActive:{ backgroundColor: color.deep },
  presetText:    { ...t.small, color: color.mute, fontWeight: '600' },
  presetTextActive:{ color: '#fff' },
  revealBtn:     { backgroundColor: color.signal, borderRadius: radius.sm, padding: 11, alignItems: 'center', marginTop: 8 },
  revealBtnText: { ...t.body, color: '#fff', fontWeight: '700' },
  revealedLabel: { ...t.small, color: color.success, fontWeight: '600' },
  errText:       { ...t.small, color: color.signal, marginTop: 4 },
  pickPlaceBtn:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  pickPlaceText: { ...t.small, color: color.signal, fontWeight: '600' },
  saveBtn:       { backgroundColor: color.deep, borderRadius: radius.md, padding: 14, alignItems: 'center', marginTop: space.lg },
  saveBtnText:   { ...t.body, color: '#fff', fontWeight: '700' },
});
