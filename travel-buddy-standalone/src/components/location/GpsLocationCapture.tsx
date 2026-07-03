/**
 * GpsLocationCapture — one-tap GPS capture for forms.
 *
 * Coordinate Input Matrix (as of initial implementation):
 *   - gems/submit.tsx (LocationStep): replaced with this component
 *   - All other GPS-dependent features (check-in, geofence, meetup, Safe Return,
 *     route checkpoint) already capture GPS via device APIs — no TextInput for
 *     raw coordinates exists elsewhere in the app.
 *
 * Props:
 *   onCapture  — called with { lat, lng, label } on success, or null when the
 *                user explicitly clears a previously captured location.
 *   initialLabel — optional label to pre-populate (e.g. when editing a draft).
 *
 * States:
 *   idle    — "Use my current location" button
 *   loading — spinner while permission is requested and GPS fix is running
 *   success — confirmation label + "Change" button
 *   denied  — permission was refused; shows settings link copy
 *   error   — GPS timed out or failed; shows retry button
 *
 * State-transition logic lives in GpsLocationCapture.machine.ts so it can be
 * tested with jest (node:test) without a React Native renderer.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getCurrentGps, reverseGeocodeDetailed } from '../../services/location';
import { runGpsCapture } from './GpsLocationCapture.machine';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

export type { GpsCaptureResult } from './GpsLocationCapture.machine';

interface Props {
  onCapture: (result: import('./GpsLocationCapture.machine').GpsCaptureResult | null) => void;
  initialLabel?: string;
}

type CaptureState = 'idle' | 'loading' | 'success' | 'denied' | 'error';

export function GpsLocationCapture({ onCapture, initialLabel }: Props) {
  const [state, setState] = useState<CaptureState>(initialLabel ? 'success' : 'idle');
  const [label, setLabel] = useState<string>(initialLabel ?? '');

  const capture = useCallback(async () => {
    setState('loading');
    try {
      const outcome = await runGpsCapture({
        getCurrentGps,
        reverseGeocodeDetailed,
        apiBase: API_BASE,
      });

      if (outcome.nextState === 'success') {
        setLabel(outcome.result.label);
        setState('success');
        onCapture(outcome.result);
      } else {
        setState(outcome.nextState);
      }
    } catch {
      setState('error');
    }
  }, [onCapture]);

  const reset = useCallback(() => {
    setLabel('');
    setState('idle');
    onCapture(null);
  }, [onCapture]);

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
          <Text style={s.successLabel}>Location detected</Text>
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
            Location permission is off. Enable it in device Settings, or skip — GPS verification is optional for gem submissions.
          </Text>
          <TouchableOpacity onPress={() => Linking.openSettings()} hitSlop={4}>
            <Text style={s.settingsLink}>Open Settings</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={s.messageBox}>
        <Ionicons name="warning-outline" size={18} color="#8A9BB5" />
        <View style={{ flex: 1 }}>
          <Text style={s.messageText}>
            Couldn't get your location. Check that GPS is enabled and try again.
          </Text>
          <TouchableOpacity onPress={capture} hitSlop={4}>
            <Text style={s.retryLink}>Try again</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <TouchableOpacity style={s.captureBtn} onPress={capture} activeOpacity={0.75}>
      <Ionicons name="location-outline" size={18} color="#4C8BF5" />
      <Text style={s.captureBtnText}>Use my current location</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12,
  },
  loadingText: { color: '#8A9BB5', fontSize: 14 },

  captureBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#13213A',
    borderRadius: 12, borderWidth: 1, borderColor: '#4C8BF5',
    paddingHorizontal: 16, paddingVertical: 13,
  },
  captureBtnText: { color: '#4C8BF5', fontWeight: '600', fontSize: 15 },

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
  settingsLink: { color: '#4C8BF5', fontSize: 13, fontWeight: '600' },
  retryLink: { color: '#4C8BF5', fontSize: 13, fontWeight: '600' },
});
