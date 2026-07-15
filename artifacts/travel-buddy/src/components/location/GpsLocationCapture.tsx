/**
 * GpsLocationCapture — one-tap GPS capture for forms, with an alternate
 * "Pick on map" flow so users can pin any location (not just their current one).
 *
 * Props:
 *   onCapture  — called with a canonical Place on success, or null when the
 *                user explicitly clears a previously captured location.
 *   initialLabel — optional label to pre-populate (e.g. when editing a draft).
 *
 * States:
 *   idle    — "Use my current location" + "Pick on map" buttons
 *   loading — spinner while permission is requested and GPS fix is running
 *   success — confirmation label + "Change" button
 *   denied  — permission was refused; shows settings link copy
 *   error   — GPS timed out or failed; shows retry button
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getCurrentGps, reverseGeocodeToPlace } from '../../services/location';
import { MapLocationPicker } from './MapLocationPicker';
import type { Place } from '../../lib/location/placeTypes';

// Keep GpsCaptureResult exported for backward compat with machines/tests.
export type { GpsCaptureResult } from './GpsLocationCapture.machine';

interface Props {
  onCapture: (place: Place | null) => void;
  initialLabel?: string;
  initialLat?: number;
  initialLng?: number;
}

type CaptureState = 'idle' | 'loading' | 'success' | 'denied' | 'error';

export function GpsLocationCapture({ onCapture, initialLabel, initialLat, initialLng }: Props) {
  const [state, setState] = useState<CaptureState>(initialLabel ? 'success' : 'idle');
  const [label, setLabel] = useState<string>(initialLabel ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedLat, setPickedLat] = useState<number | undefined>(initialLat);
  const [pickedLng, setPickedLng] = useState<number | undefined>(initialLng);

  const capture = useCallback(async () => {
    setState('loading');
    try {
      const gps = await getCurrentGps();

      if (!gps.granted) {
        setState(gps.error === 'permission_denied' ? 'denied' : 'error');
        return;
      }

      if (gps.lat === null || gps.lng === null) {
        setState('error');
        return;
      }

      const place = await reverseGeocodeToPlace(gps.lat, gps.lng);
      setLabel(place.displayName);
      setPickedLat(gps.lat);
      setPickedLng(gps.lng);
      setState('success');
      onCapture(place);
    } catch {
      setState('error');
    }
  }, [onCapture]);

  const reset = useCallback(() => {
    setLabel('');
    setPickedLat(undefined);
    setPickedLng(undefined);
    setState('idle');
    onCapture(null);
  }, [onCapture]);

  const handleMapConfirm = useCallback(
    (place: Place) => {
      setPickerOpen(false);
      setLabel(place.displayName);
      setPickedLat(place.lat ?? undefined);
      setPickedLng(place.lng ?? undefined);
      setState('success');
      onCapture(place);
    },
    [onCapture],
  );

  if (state === 'loading') {
    return (
      <View style={s.row}>
        <ActivityIndicator size="small" color="#4C8BF5" />
        <Text style={s.loadingText}>Getting your location…</Text>
      </View>
    );
  }

  if (state === 'success') {
    return (
      <View style={s.successBox}>
        <Ionicons name="location" size={18} color="#4C8BF5" />
        <View style={{ flex: 1 }}>
          <Text style={s.successLabel}>Location pinned</Text>
          <Text style={s.successValue} numberOfLines={2}>{label}</Text>
        </View>
        <TouchableOpacity onPress={reset} hitSlop={8}>
          <Text style={s.changeLink}>Change</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (state === 'denied') {
    return (
      <View style={s.messageBox}>
        <Ionicons name="location-outline" size={18} color="#8A9BB5" />
        <View style={{ flex: 1 }}>
          <Text style={s.messageText}>
            Location permission is off. Enable it in device Settings, or pick on the map instead.
          </Text>
          <View style={s.deniedActions}>
            <TouchableOpacity onPress={() => Linking.openSettings()} hitSlop={4}>
              <Text style={s.settingsLink}>Open Settings</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setPickerOpen(true)} hitSlop={4}>
              <Text style={s.settingsLink}>Pick on map</Text>
            </TouchableOpacity>
          </View>
        </View>
        <MapLocationPicker
          visible={pickerOpen}
          initialLat={pickedLat}
          initialLng={pickedLng}
          onConfirm={handleMapConfirm}
          onCancel={() => setPickerOpen(false)}
        />
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={s.messageBox}>
        <Ionicons name="warning-outline" size={18} color="#8A9BB5" />
        <View style={{ flex: 1 }}>
          <Text style={s.messageText}>
            Couldn't get your location. Check that GPS is enabled and try again, or pick on the map.
          </Text>
          <View style={s.deniedActions}>
            <TouchableOpacity onPress={capture} hitSlop={4}>
              <Text style={s.retryLink}>Try again</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setPickerOpen(true)} hitSlop={4}>
              <Text style={s.retryLink}>Pick on map</Text>
            </TouchableOpacity>
          </View>
        </View>
        <MapLocationPicker
          visible={pickerOpen}
          initialLat={pickedLat}
          initialLng={pickedLng}
          onConfirm={handleMapConfirm}
          onCancel={() => setPickerOpen(false)}
        />
      </View>
    );
  }

  return (
    <View style={s.idleWrap}>
      <TouchableOpacity style={s.captureBtn} onPress={capture} activeOpacity={0.75}>
        <Ionicons name="location-outline" size={18} color="#4C8BF5" />
        <Text style={s.captureBtnText}>Use my current location</Text>
      </TouchableOpacity>

      <TouchableOpacity style={s.mapBtn} onPress={() => setPickerOpen(true)} activeOpacity={0.75}>
        <Ionicons name="map-outline" size={18} color="#8A9BB5" />
        <Text style={s.mapBtnText}>Pick on map</Text>
      </TouchableOpacity>

      <MapLocationPicker
        visible={pickerOpen}
        initialLat={pickedLat}
        initialLng={pickedLng}
        onConfirm={handleMapConfirm}
        onCancel={() => setPickerOpen(false)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12,
  },
  loadingText: { color: '#8A9BB5', fontSize: 14 },

  idleWrap: {
    gap: 10,
  },
  captureBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#13213A',
    borderRadius: 12, borderWidth: 1, borderColor: '#4C8BF5',
    paddingHorizontal: 16, paddingVertical: 13,
  },
  captureBtnText: { color: '#4C8BF5', fontWeight: '600', fontSize: 15 },

  mapBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#13213A',
    borderRadius: 12, borderWidth: 1, borderColor: '#2A3D5E',
    paddingHorizontal: 16, paddingVertical: 13,
  },
  mapBtnText: { color: '#8A9BB5', fontWeight: '600', fontSize: 15 },

  successBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: '#0D1F3A',
    borderRadius: 12, borderWidth: 1, borderColor: '#4C8BF5',
    padding: 14,
  },
  successLabel: { color: '#8A9BB5', fontSize: 12, fontWeight: '600', marginBottom: 2 },
  successValue: { color: '#E8F0FE', fontSize: 15, fontWeight: '600', lineHeight: 20 },
  changeLink: { color: '#4C8BF5', fontSize: 13, fontWeight: '600', marginTop: 2 },

  messageBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: '#13213A',
    borderRadius: 12, borderWidth: 1, borderColor: '#2A3D5E',
    padding: 14,
  },
  messageText: { color: '#8A9BB5', fontSize: 13, lineHeight: 19, marginBottom: 6 },
  deniedActions: { flexDirection: 'row', gap: 16 },
  settingsLink: { color: '#4C8BF5', fontSize: 13, fontWeight: '600' },
  retryLink: { color: '#4C8BF5', fontSize: 13, fontWeight: '600' },
});
