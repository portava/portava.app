/**
 * RouteBuilderSheet
 *
 * Bottom-sheet style modal for assembling and launching a walking route.
 * Accepts a pre-populated list of activities; user can drag-reorder,
 * set start/end points with GlobalPlacePicker, pick a route style,
 * and tap "Generate route".
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, Modal, ScrollView, Pressable, TextInput,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { X, Route, Trash2, MapPin, ChevronRight } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';
import { createRoutePlan, type CandidateStopInput, type RouteStyle, type FullRoutePlan } from '../services/routePlan';
import { GlobalPlacePicker } from './selectors/GlobalPlacePicker';
import type { Place } from '../lib/location/placeTypes';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RouteStopDraft {
  id: string;
  title: string;
  lat: number | null;
  lng: number | null;
  sourceType?: string;
  sourceId?: string;
  category?: string | null;
}

interface LocationPin {
  label: string;
  lat: number;
  lng: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onRouteCreated: (route: FullRoutePlan) => void;
  initialStops?: RouteStopDraft[];
  tripId?: string | null;
}

// ── Style options ─────────────────────────────────────────────────────────────

const STYLE_OPTIONS: Array<{ value: RouteStyle; label: string; emoji: string; desc: string }> = [
  { value: 'nightlife',    label: 'Night Out',   emoji: '🎉', desc: 'Bars & clubs later in the evening' },
  { value: 'scenic',       label: 'Scenic',       emoji: '🏛️', desc: 'Landmarks & attractions first' },
  { value: 'foodie',       label: 'Food Crawl',   emoji: '🍜', desc: 'Restaurants & cafés optimized' },
  { value: 'low_walking',  label: 'Low Walking',  emoji: '🚗', desc: 'Flag long legs for rideshare' },
  { value: 'custom',       label: 'Custom',       emoji: '🗺️', desc: 'Nearest-neighbor, no adjustments' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function RouteBuilderSheet({ visible, onClose, onRouteCreated, initialStops = [], tripId }: Props) {
  const [stops, setStops]           = useState<RouteStopDraft[]>(initialStops);
  const [routeStyle, setRouteStyle] = useState<RouteStyle>('custom');
  const [title, setTitle]           = useState('');
  const [generating, setGenerating] = useState(false);

  const [startPin, setStartPin]         = useState<LocationPin | null>(null);
  const [endPin, setEndPin]             = useState<LocationPin | null>(null);
  const [startPickerOpen, setStartPickerOpen] = useState(false);
  const [endPickerOpen, setEndPickerOpen]     = useState(false);

  React.useEffect(() => {
    if (visible) {
      setStops(initialStops);
      setRouteStyle('custom');
      setTitle('');
      setStartPin(null);
      setEndPin(null);
    }
  }, [visible]);

  const removeStop = useCallback((id: string) => {
    setStops((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const moveStop = useCallback((fromIdx: number, dir: 'up' | 'down') => {
    setStops((prev) => {
      const next = [...prev];
      const toIdx = dir === 'up' ? fromIdx - 1 : fromIdx + 1;
      if (toIdx < 0 || toIdx >= next.length) return next;
      [next[fromIdx], next[toIdx]] = [next[toIdx]!, next[fromIdx]!];
      return next;
    });
  }, []);

  const handleSelectStart = useCallback((place: Place) => {
    if (place.lat == null || place.lng == null) return;
    setStartPin({ label: place.displayName ?? place.name, lat: place.lat, lng: place.lng });
    setStartPickerOpen(false);
  }, []);

  const handleSelectEnd = useCallback((place: Place) => {
    if (place.lat == null || place.lng == null) return;
    setEndPin({ label: place.displayName ?? place.name, lat: place.lat, lng: place.lng });
    setEndPickerOpen(false);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (stops.length < 2) {
      Alert.alert('Not enough stops', 'Add at least 2 stops to create a route.');
      return;
    }

    const validStops = stops.filter((s) => s.lat != null && s.lng != null);
    const skipped    = stops.length - validStops.length;
    if (skipped > 0) {
      Alert.alert('Missing locations', `${skipped} stop(s) are missing coordinates and will be skipped.`);
    }
    if (validStops.length < 2) {
      Alert.alert('Not enough stops', 'At least 2 stops must have coordinates to create a route.');
      return;
    }

    setGenerating(true);
    try {
      const candidateStops: CandidateStopInput[] = validStops.map((s) => ({
        title: s.title,
        lat: s.lat as number,
        lng: s.lng as number,
        sourceType: s.sourceType ?? 'manual',
        sourceId: s.sourceId,
        category: s.category ?? null,
      }));

      const route = await createRoutePlan({
        title: title.trim() || undefined,
        tripId: tripId ?? null,
        routeStyle,
        stops: candidateStops,
        startLocation: startPin
          ? { label: startPin.label, lat: startPin.lat, lng: startPin.lng }
          : undefined,
        endLocation: endPin
          ? { label: endPin.label, lat: endPin.lat, lng: endPin.lng }
          : undefined,
      });

      if (route.warnings && route.warnings.length > 0) {
        Alert.alert(
          'Route created',
          route.warnings.join('\n') + '\n\nAll distances are approximate.',
          [{ text: 'Got it', onPress: () => onRouteCreated(route) }],
        );
      } else {
        onRouteCreated(route);
      }
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to create route. Please try again.');
    } finally {
      setGenerating(false);
    }
  }, [stops, routeStyle, title, tripId, startPin, endPin, onRouteCreated]);

  return (
    <>
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
        <View style={styles.root}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Route size={20} color={color.deep} />
              <Text style={styles.headerTitle}>Build Route</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12}>
              <X size={22} color={color.mute} />
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 48 }} showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionLabel}>Route name (optional)</Text>
            <TextInput
              style={styles.nameInput}
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Saturday Night Out"
              placeholderTextColor={color.mute}
              maxLength={80}
            />

            {/* Start / End pins */}
            <Text style={styles.sectionLabel}>Start point (optional)</Text>
            <Pressable style={styles.pinRow} onPress={() => setStartPickerOpen(true)}>
              <MapPin size={15} color={startPin ? color.deep : color.mute} />
              <Text style={[styles.pinLabel, !startPin && styles.pinLabelPlaceholder]} numberOfLines={1}>
                {startPin ? startPin.label : 'Set starting location'}
              </Text>
              <ChevronRight size={14} color={color.mute} />
            </Pressable>
            {startPin ? (
              <Pressable style={styles.clearPin} onPress={() => setStartPin(null)}>
                <Text style={styles.clearPinText}>✕ Clear start point</Text>
              </Pressable>
            ) : null}

            <Text style={styles.sectionLabel}>End point (optional)</Text>
            <Pressable style={styles.pinRow} onPress={() => setEndPickerOpen(true)}>
              <MapPin size={15} color={endPin ? color.signal : color.mute} />
              <Text style={[styles.pinLabel, !endPin && styles.pinLabelPlaceholder]} numberOfLines={1}>
                {endPin ? endPin.label : 'Set ending location'}
              </Text>
              <ChevronRight size={14} color={color.mute} />
            </Pressable>
            {endPin ? (
              <Pressable style={styles.clearPin} onPress={() => setEndPin(null)}>
                <Text style={styles.clearPinText}>✕ Clear end point</Text>
              </Pressable>
            ) : null}

            <Text style={styles.sectionLabel}>Route style</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.styleRow}>
              {STYLE_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[styles.styleChip, routeStyle === opt.value && styles.styleChipActive]}
                  onPress={() => setRouteStyle(opt.value)}
                >
                  <Text style={styles.styleEmoji}>{opt.emoji}</Text>
                  <Text style={[styles.styleLabel, routeStyle === opt.value && styles.styleLabelActive]}>
                    {opt.label}
                  </Text>
                  {routeStyle === opt.value && (
                    <Text style={styles.styleDesc}>{opt.desc}</Text>
                  )}
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.stopHeader}>
              <Text style={styles.sectionLabel}>Stops ({stops.length})</Text>
              <Text style={styles.stopHint}>Tap arrows to reorder</Text>
            </View>

            {stops.length === 0 && (
              <View style={styles.emptyStops}>
                <Text style={styles.emptyStopsText}>No stops added. Come back from a place card or Discovery.</Text>
              </View>
            )}

            {stops.map((stop, idx) => (
              <View key={stop.id} style={styles.stopRow}>
                <View style={styles.stopIndex}>
                  <Text style={styles.stopIndexText}>{idx + 1}</Text>
                </View>
                <View style={styles.stopInfo}>
                  <Text style={styles.stopTitle} numberOfLines={1}>{stop.title}</Text>
                  {stop.category ? <Text style={styles.stopCategory}>{stop.category}</Text> : null}
                </View>
                <View style={styles.stopActions}>
                  <Pressable
                    onPress={() => moveStop(idx, 'up')}
                    style={[styles.arrowBtn, idx === 0 && styles.arrowBtnDisabled]}
                    disabled={idx === 0}
                    hitSlop={6}
                  >
                    <Text style={styles.arrowText}>▲</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => moveStop(idx, 'down')}
                    style={[styles.arrowBtn, idx === stops.length - 1 && styles.arrowBtnDisabled]}
                    disabled={idx === stops.length - 1}
                    hitSlop={6}
                  >
                    <Text style={styles.arrowText}>▼</Text>
                  </Pressable>
                  <Pressable onPress={() => removeStop(stop.id)} hitSlop={8} style={styles.removeBtn}>
                    <Trash2 size={14} color={color.signal} />
                  </Pressable>
                </View>
              </View>
            ))}

            <View style={styles.approxNotice}>
              <Text style={styles.approxText}>
                ℹ️ All walking distances and times are approximate (straight-line). No live routing provider is used.
              </Text>
            </View>

            <Pressable
              style={[styles.generateBtn, (generating || stops.length < 2) && styles.generateBtnDisabled]}
              onPress={handleGenerate}
              disabled={generating || stops.length < 2}
            >
              {generating
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.generateBtnText}>Generate Route</Text>
              }
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      <GlobalPlacePicker
        visible={startPickerOpen}
        title="Set start point"
        onSelect={handleSelectStart}
        onClose={() => setStartPickerOpen(false)}
        allowGPS
        usedFor="route_start"
        placeholder="Search city or landmark…"
      />

      <GlobalPlacePicker
        visible={endPickerOpen}
        title="Set end point"
        onSelect={handleSelectEnd}
        onClose={() => setEndPickerOpen(false)}
        allowGPS
        usedFor="route_end"
        placeholder="Search city or landmark…"
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  headerTitle: { ...t.bodyStrong, color: color.ink, fontSize: 17 },
  body: { flex: 1, paddingHorizontal: space.lg },
  sectionLabel: { ...t.bodyStrong, color: color.ink, fontSize: 13, marginTop: space.lg, marginBottom: space.sm },
  nameInput: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
    ...t.body, color: color.ink, fontSize: 14,
  },
  pinRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  pinLabel: { flex: 1, ...t.body, color: color.ink, fontSize: 14 },
  pinLabelPlaceholder: { color: color.mute },
  clearPin: { marginTop: 4 },
  clearPinText: { ...t.small, color: color.mute, fontSize: 12 },
  styleRow: { gap: space.sm, paddingRight: space.md },
  styleChip: {
    minWidth: 90, borderRadius: radius.md, borderWidth: 1.5, borderColor: color.haze,
    backgroundColor: color.paperRaised, padding: space.md, alignItems: 'center',
  },
  styleChipActive: { borderColor: color.deep, backgroundColor: '#EAF2F4' },
  styleEmoji: { fontSize: 20 },
  styleLabel: { ...t.small, color: color.ink, fontSize: 12, fontWeight: '600', marginTop: 4 },
  styleLabelActive: { color: color.deep },
  styleDesc: { ...t.small, color: color.mute, fontSize: 10, textAlign: 'center', marginTop: 2 },
  stopHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.lg, marginBottom: space.sm },
  stopHint: { ...t.small, color: color.mute, fontSize: 11 },
  emptyStops: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.xl, alignItems: 'center',
  },
  emptyStopsText: { ...t.small, color: color.mute, fontSize: 13, textAlign: 'center' },
  stopRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.sm, marginBottom: space.sm,
  },
  stopIndex: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
  },
  stopIndexText: { ...t.small, color: '#fff', fontSize: 12, fontWeight: '700' },
  stopInfo: { flex: 1 },
  stopTitle: { ...t.body, color: color.ink, fontSize: 13 },
  stopCategory: { ...t.small, color: color.mute, fontSize: 11 },
  stopActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  arrowBtn: { padding: 4 },
  arrowBtnDisabled: { opacity: 0.3 },
  arrowText: { fontSize: 12, color: color.ink },
  removeBtn: { padding: 4, marginLeft: 4 },
  approxNotice: {
    backgroundColor: '#FFF8E1', borderRadius: radius.md, padding: space.md, marginTop: space.lg,
  },
  approxText: { ...t.small, color: '#7B5E00', fontSize: 11, lineHeight: 16 },
  generateBtn: {
    backgroundColor: color.deep, borderRadius: radius.md, padding: space.lg,
    alignItems: 'center', marginTop: space.xl,
  },
  generateBtnDisabled: { opacity: 0.5 },
  generateBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 15 },
});
