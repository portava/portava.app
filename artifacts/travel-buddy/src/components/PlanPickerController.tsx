/**
 * PlanPickerController — global "Add to Trip Plan" flow.
 *
 * Call `usePlanPicker().open(source)` from any card to:
 *   1. Show the user's real trips in a bottom-sheet picker.
 *   2. On selection, call the real plan API (createPlanItem / addMeetupToPlan).
 *   3. Guard duplicates (409 → "Already added ✓" inline).
 *   4. Toast on success.
 *
 * Replaces the mock AttachController 'plan' flow for Discovery/Pulse surfaces.
 */
import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, ActivityIndicator, StyleSheet, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Check, Plus, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens';
import { listMyTrips } from '../services/trips';
import { createPlanItem, addMeetupToPlan } from '../services/tripPlan';
import type { TripRow } from '../services/trips';
import type { TripPlanCategory } from '../types/models';
import { useSession } from '../context/SessionContext';

// ── Source descriptor (matches AttachSource shape) ────────────────────────────

export interface PlanPickerSource {
  id: string;
  type: 'hidden_gem' | 'experience' | 'compass_suggestion' | 'meetup' | 'place' | string;
  title: string;
  city?: string;
  category?: string;
  locationName?: string;
}

// ── Context ───────────────────────────────────────────────────────────────────

type OpenFn = (source: PlanPickerSource) => void;
const PlanPickerContext = createContext<{ open: OpenFn } | null>(null);

// ── Map source type → TripPlanCategory ───────────────────────────────────────

function sourceToCategory(type: string): TripPlanCategory {
  if (type === 'meetup') return 'meeting_point';
  if (type === 'dining') return 'dining';
  if (type === 'transport') return 'transport';
  if (type === 'accommodation') return 'accommodation';
  return 'activity';
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function PlanPickerControllerProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { isAuthed } = useSession();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [source, setSource] = useState<PlanPickerSource | null>(null);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [loadingTrips, setLoadingTrips] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // toast
  const [toast, setToast] = useState<string | null>(null);
  const toastY = useRef(new Animated.Value(80)).current;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    Animated.spring(toastY, { toValue: 0, useNativeDriver: true }).start();
    setTimeout(() => {
      Animated.timing(toastY, { toValue: 80, duration: 220, useNativeDriver: true }).start(() => setToast(null));
    }, 2500);
  }, [toastY]);

  const open: OpenFn = useCallback((src) => {
    setSource(src);
    setAddedIds(new Set());
    setError(null);
    setBusyId(null);
    setSheetOpen(true);
  }, []);

  // Fetch trips when sheet opens
  useEffect(() => {
    if (!sheetOpen || !isAuthed) return;
    setLoadingTrips(true);
    listMyTrips()
      .then(setTrips)
      .catch(() => setTrips([]))
      .finally(() => setLoadingTrips(false));
  }, [sheetOpen, isAuthed]);

  const addToTrip = useCallback(async (trip: TripRow) => {
    if (!source) return;
    setBusyId(trip.id);
    setError(null);
    try {
      if (source.type === 'meetup') {
        await addMeetupToPlan(source.id, trip.id);
      } else {
        await createPlanItem(trip.id, {
          title: source.title,
          category: sourceToCategory(source.type),
          sourceType: 'place',
          sourceId: source.id,
          locationName: source.locationName ?? source.city,
        });
      }
      setAddedIds((prev) => new Set(prev).add(trip.id));
      setSheetOpen(false);
      showToast(`Added to "${trip.title}"`);
    } catch (e: any) {
      if (e.message?.includes('duplicate') || e.message?.includes('409') || e.message?.includes('already')) {
        // Treat 409 as "already added" — not a hard error
        setAddedIds((prev) => new Set(prev).add(trip.id));
        showToast(`Already in "${trip.title}" — no duplicate added`);
        setSheetOpen(false);
      } else {
        setError(e.message ?? 'Could not add item. Please try again.');
      }
    } finally {
      setBusyId(null);
    }
  }, [source, showToast]);

  return (
    <PlanPickerContext.Provider value={{ open }}>
      {children}

      <Modal
        visible={sheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSheetOpen(false)}
      >
        <Pressable style={s.backdrop} onPress={() => setSheetOpen(false)} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
          <View style={s.grab} />

          <View style={s.head}>
            <Text style={s.title}>Add to Trip Plan</Text>
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => setSheetOpen(false)} hitSlop={layout.hitSlop} style={s.xBtn}>
              <X size={18} color={color.ink} />
            </Pressable>
          </View>

          {source && (
            <View style={s.preview}>
              <View style={s.previewIcon}><MapPin size={16} color={color.onInk} /></View>
              <View style={{ flex: 1 }}>
                <Text style={s.previewTitle} numberOfLines={1}>{source.title}</Text>
                <Text style={s.previewMeta} numberOfLines={1}>
                  {[source.category, source.city].filter(Boolean).join(' · ') || 'Place'}
                </Text>
              </View>
            </View>
          )}

          {error ? <Text style={s.error}>{error}</Text> : null}

          {!isAuthed ? (
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>Sign in to add items to a trip plan.</Text>
            </View>
          ) : loadingTrips ? (
            <ActivityIndicator color={color.signal} style={{ marginVertical: space.xl }} />
          ) : trips.length === 0 ? (
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>No trips yet. Create a trip first, then add items to its plan.</Text>
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: space.sm }}>
              <Text style={s.pickerLabel}>Pick a trip</Text>
              {trips.map((trip) => {
                const already = addedIds.has(trip.id);
                const busy = busyId === trip.id;
                return (
                  <Pressable
                    key={trip.id}
                    style={({ pressed }) => [s.tripRow, pressed && { opacity: layout.pressedOpacity }]}
                    onPress={() => addToTrip(trip)}
                    disabled={busy || already}
                  >
                    <View style={s.tripIcon}><MapPin size={14} color={color.deep} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.tripTitle} numberOfLines={1}>{trip.title}</Text>
                      {trip.destinationCity ? (
                        <Text style={s.tripMeta} numberOfLines={1}>{trip.destinationCity}</Text>
                      ) : null}
                    </View>
                    {busy ? (
                      <ActivityIndicator size="small" color={color.signal} />
                    ) : already ? (
                      <View style={s.addedBadge}>
                        <Check size={12} color={color.success} />
                        <Text style={s.addedText}>Added</Text>
                      </View>
                    ) : (
                      <Plus size={18} color={color.signal} />
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Modal>

      {toast ? (
        <Animated.View
          style={[s.toast, { transform: [{ translateY: toastY }], bottom: insets.bottom + 84 }]}
          pointerEvents="none"
        >
          <Check size={16} color={color.onInk} />
          <Text style={s.toastText}>{toast}</Text>
        </Animated.View>
      ) : null}
    </PlanPickerContext.Provider>
  );
}

export function usePlanPicker() {
  const ctx = useContext(PlanPickerContext);
  return ctx ?? { open: () => {} };
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: space.lg, gap: space.md, ...shadow.float,
  },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze },
  head: { flexDirection: 'row', alignItems: 'center' },
  title: { ...t.title, color: color.ink, fontSize: 19 },
  xBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  preview: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.sm },
  previewIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  previewTitle: { ...t.bodyStrong, color: color.ink },
  previewMeta: { ...t.small, color: color.mute, fontSize: 11 },
  error: { ...t.small, color: color.signal, fontWeight: '600' },
  pickerLabel: { ...t.small, fontWeight: '700', color: color.mute, letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 10 },
  tripRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  tripIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
  tripTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  tripMeta: { ...t.small, color: color.mute, fontSize: 11 },
  addedBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  addedText: { ...t.small, color: color.success, fontWeight: '700', fontSize: 12 },
  emptyWrap: { paddingVertical: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  toast: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.ink, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.pill, ...shadow.float },
  toastText: { ...t.bodyStrong, color: color.onInk },
});
