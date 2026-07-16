/**
 * MapLocationPicker — full-screen map modal for picking a location.
 *
 * The user pans and zooms the map to place the fixed crosshair over their
 * desired location, then taps "Confirm". The current map-center coordinates
 * are reverse-geocoded and returned via `onConfirm` as a canonical Place.
 *
 * Metro automatically uses MapLocationPicker.web.tsx on web where MapLibre
 * native modules are unavailable.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Map, Camera } from '@maplibre/maplibre-react-native';
import type { NativeSyntheticEvent } from 'react-native';
import type { ViewStateChangeEvent } from '@maplibre/maplibre-react-native';
import { Ionicons } from '@expo/vector-icons';
import { reverseGeocodeToPlace } from '../../services/location';
import { confirmMapCenterAsPlace } from './MapLocationPicker.machine';
import type { Place } from '../../lib/location/placeTypes';

// ── Map tile style ─────────────────────────────────────────────────────────────

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
  : 'https://demotiles.maplibre.org/style.json';

// ── Default viewport: world overview ──────────────────────────────────────────

const DEFAULT_CENTER: [number, number] = [0, 20];
const DEFAULT_ZOOM = 1.5;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MapLocationPickerProps {
  visible: boolean;
  /** Pre-center the map on an already-captured location, if any. */
  initialLat?: number;
  initialLng?: number;
  onConfirm: (place: Place) => void;
  onCancel: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MapLocationPicker({
  visible,
  initialLat,
  initialLng,
  onConfirm,
  onCancel,
}: MapLocationPickerProps) {
  const hasInitial = initialLat != null && initialLng != null;

  // [lng, lat] — LngLat order for MapLibre.
  const centerRef = useRef<[number, number]>(
    hasInitial
      ? [initialLng as number, initialLat as number]
      : DEFAULT_CENTER,
  );

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [confirming, setConfirming] = useState(false);
  const [geocodeError, setGeocodeError] = useState(false);

  const handleRegionDidChange = useCallback(
    (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      const c = event.nativeEvent.center;
      if (c) {
        centerRef.current = c;
      }
    },
    [],
  );

  const handleConfirm = useCallback(async () => {
    setGeocodeError(false);
    setConfirming(true);
    try {
      await confirmMapCenterAsPlace({
        center: centerRef.current,
        reverseGeocodeToPlace,
        onConfirm: (place) => {
          if (mountedRef.current) onConfirm(place);
        },
      });
    } catch {
      if (mountedRef.current) setGeocodeError(true);
    } finally {
      if (mountedRef.current) setConfirming(false);
    }
  }, [onConfirm]);

  const initialCenter: [number, number] = hasInitial
    ? [initialLng as number, initialLat as number]
    : DEFAULT_CENTER;
  const initialZoom = hasInitial ? 13 : DEFAULT_ZOOM;

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent>
      <SafeAreaView style={s.root} edges={['top', 'bottom']}>
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <View style={s.header}>
          <TouchableOpacity onPress={onCancel} hitSlop={8} style={s.headerBtn}>
            <Ionicons name="close" size={22} color="#E8F0FE" />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Pick a location</Text>
          <View style={s.headerBtn} />
        </View>

        {/* ── Map ────────────────────────────────────────────────────────── */}
        <View style={s.mapContainer}>
          <Map
            style={StyleSheet.absoluteFill}
            mapStyle={MAP_STYLE}
            logo={false}
            attribution={false}
            onRegionDidChange={handleRegionDidChange}
          >
            <Camera
              initialViewState={{
                center: initialCenter,
                zoom: initialZoom,
              }}
            />
          </Map>

          {/* ── Fixed crosshair ──────────────────────────────────────────── */}
          <View style={s.crosshairWrap} pointerEvents="none">
            <View style={s.crosshairH} />
            <View style={s.crosshairV} />
            <View style={s.crosshairDot} />
          </View>

          {/* ── Instruction hint ─────────────────────────────────────────── */}
          <View style={s.hint} pointerEvents="none">
            <Text style={s.hintText}>Pan the map to position the crosshair</Text>
          </View>
        </View>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <View style={s.footer}>
          {geocodeError && (
            <Text style={s.errorText}>Couldn't resolve that location. Try again.</Text>
          )}
          <TouchableOpacity
            style={[s.confirmBtn, confirming && s.btnDisabled]}
            onPress={handleConfirm}
            disabled={confirming}
            activeOpacity={0.8}
          >
            {confirming
              ? <ActivityIndicator color="#fff" />
              : (
                <>
                  <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
                  <Text style={s.confirmBtnText}>Confirm location</Text>
                </>
              )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const CROSSHAIR_HALF = 28;
const DOT = 8;

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0A1628',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1E2D45',
  },
  headerBtn: {
    width: 32,
    alignItems: 'center',
  },
  headerTitle: {
    color: '#E8F0FE',
    fontSize: 16,
    fontWeight: '700',
  },
  mapContainer: {
    flex: 1,
    position: 'relative',
  },
  crosshairWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  crosshairH: {
    position: 'absolute',
    width: CROSSHAIR_HALF * 2,
    height: 2,
    backgroundColor: '#4C8BF5',
    opacity: 0.9,
  },
  crosshairV: {
    position: 'absolute',
    width: 2,
    height: CROSSHAIR_HALF * 2,
    backgroundColor: '#4C8BF5',
    opacity: 0.9,
  },
  crosshairDot: {
    position: 'absolute',
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: '#4C8BF5',
    borderWidth: 2,
    borderColor: '#fff',
  },
  hint: {
    position: 'absolute',
    bottom: 16,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  hintText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: '#1E2D45',
    gap: 8,
  },
  errorText: {
    color: '#F87171',
    fontSize: 13,
    textAlign: 'center',
  },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#4C8BF5',
    borderRadius: 14,
    paddingVertical: 15,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  confirmBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
