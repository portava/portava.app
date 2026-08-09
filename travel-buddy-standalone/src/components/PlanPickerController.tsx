/**
 * PlanPickerController — global "Add to Trip Plan" flow.
 *
 * Two-step sheet:
 *   Step 1 — Pick a trip (only trips where the user has plan-edit permission)
 *   Step 2 — Optional day / time selector → Confirm
 *
 * Usage: call `usePlanPicker().open(source)` from any card.
 * Track whether a source was already added with `usePlanPicker().isAdded(sourceId)`.
 */
import React, {
  createContext, useContext, useState, useCallback, useRef, useEffect, useMemo,
} from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, ActivityIndicator, StyleSheet, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { X, Check, MapPin, ChevronLeft, Plus } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout, avatar } from '../theme/tokens.ts';
import { fetchPlanEditableTrips, createPlanItem, addMeetupToPlan, addPlaceToPlan } from '../services/tripPlan.ts';
import type { EditableTripRow } from '../services/tripPlan.ts';
import type { TripPlanCategory, TripPlanLockType } from '../types/models.ts';
import { useSession } from '../context/SessionContext.tsx';
import { DatePickerField } from './DateTimePickerField';
import { LockTypeSelector } from './itinerary/LockTypeSelector.tsx';

// ── Source descriptor ─────────────────────────────────────────────────────────

export interface PlanPickerSource {
  id: string;
  type: 'meetup' | 'place' | 'hidden_gem' | 'experience' | 'compass_suggestion' | string;
  title: string;
  city?: string;
  category?: string;
  locationName?: string;
  /** ISO datetime string — pre-fills date + time pickers on the confirm step */
  confirmedTime?: string;
  /** Latitude for itinerary map pin placement. Null when coordinates are unavailable. */
  lat?: number | null;
  /** Longitude for itinerary map pin placement. Null when coordinates are unavailable. */
  lng?: number | null;
}

// ── Context ───────────────────────────────────────────────────────────────────

type OpenFn = (source: PlanPickerSource) => void;

interface PlanPickerContextValue {
  open: OpenFn;
  isAdded: (sourceId: string) => boolean;
}

const PlanPickerContext = createContext<PlanPickerContextValue | null>(null);

// ── Category mapping ──────────────────────────────────────────────────────────

function sourceToCategory(type: string, category?: string): TripPlanCategory {
  if (type === 'meetup' || type === 'plan') return 'meeting_point';
  if (type === 'dining')                    return 'dining';
  if (type === 'transport')                 return 'transport';
  if (type === 'accommodation')             return 'accommodation';
  // honour an explicit category hint from the source descriptor
  if (category === 'meeting_point')         return 'meeting_point';
  if (category === 'dining')                return 'dining';
  if (category === 'transport')             return 'transport';
  if (category === 'accommodation')         return 'accommodation';
  return 'activity';
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function dateToDayStr(d: Date): string {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}`;
}

function dateToHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildTimestamp(date: Date | null, time: Date | null): string | undefined {
  if (!date || !time) return undefined;
  return `${dateToDayStr(date)}T${dateToHHMM(time)}:00`;
}

// ── Provider ──────────────────────────────────────────────────────────────────

type Step = 'pick_trip' | 'pick_time';

export function PlanPickerControllerProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { isAuthed } = useSession();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [step, setStep]           = useState<Step>('pick_trip');
  const [source, setSource]       = useState<PlanPickerSource | null>(null);
  const [trips, setTrips]         = useState<EditableTripRow[]>([]);
  const [loadingTrips, setLoadingTrips] = useState(false);
  const [selectedTrip, setSelectedTrip] = useState<EditableTripRow | null>(null);

  const [dayDate, setDayDate]   = useState<Date | null>(null);
  const [startsAt, setStartsAt] = useState<Date | null>(null);
  const [lockType, setLockType] = useState<TripPlanLockType>('flexible');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  // Per-source added tracking — persists across open() calls in this session
  const [addedSourceIds, setAddedSourceIds] = useState<Set<string>>(new Set());

  // Toast
  const [toast, setToast] = useState<string | null>(null);
  const toastY = useRef(new Animated.Value(80)).current;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    Animated.spring(toastY, { toValue: 0, useNativeDriver: true }).start();
    setTimeout(() => {
      Animated.timing(toastY, { toValue: 80, duration: 220, useNativeDriver: true }).start(() => setToast(null));
    }, 2500);
  }, [toastY]);

  // Load editable trips when sheet opens
  useEffect(() => {
    if (!sheetOpen || !isAuthed) return;
    setLoadingTrips(true);
    fetchPlanEditableTrips()
      .then(setTrips)
      .catch(() => setTrips([]))
      .finally(() => setLoadingTrips(false));
  }, [sheetOpen, isAuthed]);

  const open: OpenFn = useCallback((src) => {
    setSource(src);
    setSelectedTrip(null);
    // Pre-fill date + time from confirmedTime when provided (e.g. confirmed meetup)
    if (src.confirmedTime) {
      const dt = new Date(src.confirmedTime);
      setDayDate(dt);
      setStartsAt(dt);
    } else {
      setDayDate(null);
      setStartsAt(null);
    }
    setLockType('flexible');
    setError(null);
    setStep('pick_trip');
    setSheetOpen(true);
  }, []);

  const close = useCallback(() => {
    setSheetOpen(false);
  }, []);

  const handleCreateTrip = useCallback(() => {
    close();
    router.push('/trip/new' as any);
  }, [close]);

  const handlePickTrip = useCallback((trip: EditableTripRow) => {
    setSelectedTrip(trip);
    // Preserve prefilled date/time when source carried a confirmedTime (e.g. confirmed meetup)
    if (!source?.confirmedTime) {
      setDayDate(null);
      setStartsAt(null);
    }
    setError(null);
    setStep('pick_time');
  }, [source]);

  const handleConfirm = useCallback(async () => {
    if (!source || !selectedTrip || submitting) return;
    setError(null);
    setSubmitting(true);

    try {
      if (source.type === 'meetup') {
        await addMeetupToPlan(source.id, selectedTrip.id, { lockType });
      } else {
        try {
          await addPlaceToPlan(source.id, selectedTrip.id, {
            dayDate:  dayDate  ? dateToDayStr(dayDate)                    : undefined,
            startsAt: buildTimestamp(dayDate, startsAt),
            lockType,
          });
        } catch (placeErr: any) {
          const msg = (placeErr.message ?? '').toLowerCase();
          if (msg.includes('404') || msg.includes('not found') || msg.includes('no place')) {
            await createPlanItem(selectedTrip.id, {
              title:        source.title,
              category:     sourceToCategory(source.type, source.category),
              sourceType:   'place',
              sourceId:     source.id,
              locationName: source.locationName ?? source.city,
              dayDate:      dayDate  ? dateToDayStr(dayDate)              : undefined,
              startsAt:     buildTimestamp(dayDate, startsAt),
              lockType,
            });
          } else {
            throw placeErr;
          }
        }
      }

      setAddedSourceIds((prev) => {
        const next = new Set(prev);
        next.add(source.id);
        return next;
      });
      close();
      showToast(`Added to "${selectedTrip.title}"`);
    } catch (e: any) {
      const msg = (e.message ?? '').toLowerCase();
      if (msg.includes('duplicate') || msg.includes('409') || msg.includes('already')) {
        setAddedSourceIds((prev) => {
          const next = new Set(prev);
          next.add(source.id);
          return next;
        });
        close();
        showToast(`Already in "${selectedTrip.title}" — no duplicate added`);
      } else {
        setError(e.message ?? 'Could not add item. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }, [source, selectedTrip, dayDate, startsAt, lockType, submitting, close, showToast]);

  const contextValue = useMemo<PlanPickerContextValue>(() => ({
    open,
    isAdded: (sourceId: string) => addedSourceIds.has(sourceId),
  }), [open, addedSourceIds]);

  return (
    <PlanPickerContext.Provider value={contextValue}>
      {children}

      <Modal
        visible={sheetOpen}
        transparent
        animationType="slide"
        onRequestClose={close}
      >
        <Pressable style={s.backdrop} onPress={close} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
          <View style={s.grab} />

          {/* Header */}
          <View style={s.head}>
            {step === 'pick_time' ? (
              <Pressable onPress={() => setStep('pick_trip')} hitSlop={layout.hitSlop} style={s.backBtn}>
                <ChevronLeft size={18} color={color.ink} />
              </Pressable>
            ) : null}
            <Text style={s.title}>Add to Trip Plan</Text>
            <View style={{ flex: 1 }} />
            <Pressable onPress={close} hitSlop={layout.hitSlop} style={s.xBtn}>
              <X size={18} color={color.ink} />
            </Pressable>
          </View>

          {/* Source preview */}
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
          ) : step === 'pick_trip' ? (
            /* ── Step 1: pick a trip ── */
            loadingTrips ? (
              <ActivityIndicator color={color.signal} style={{ marginVertical: space.xl }} />
            ) : trips.length === 0 ? (
              <View style={s.emptyWrap}>
                <Text style={s.emptyText}>
                  No trips with edit access yet. Create a trip or ask the trip owner to grant you edit permission.
                </Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: space.sm }}>
                <Text style={s.pickerLabel}>Pick a trip</Text>
                {trips.map((trip) => (
                  <Pressable
                    key={trip.id}
                    style={({ pressed }) => [s.tripRow, pressed && { opacity: layout.pressedOpacity }]}
                    onPress={() => handlePickTrip(trip)}
                  >
                    <View style={s.tripIcon}><MapPin size={14} color={color.deep} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.tripTitle} numberOfLines={1}>{trip.title}</Text>
                      {trip.destinationCity ? (
                        <Text style={s.tripMeta} numberOfLines={1}>{trip.destinationCity}</Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))}

                <Pressable
                  style={({ pressed }) => [s.createRow, pressed && { opacity: layout.pressedOpacity }]}
                  onPress={handleCreateTrip}
                >
                  <View style={s.createIcon}>
                    <Plus size={14} color={color.onInk} />
                  </View>
                  <Text style={s.createText}>Create new trip</Text>
                </Pressable>
              </ScrollView>
            )
          ) : (
            /* ── Step 2: day / time + confirm ── */
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.sm }}>
              {selectedTrip && (
                <View style={s.selectedTripChip}>
                  <MapPin size={12} color={color.signal} />
                  <Text style={s.selectedTripText} numberOfLines={1}>{selectedTrip.title}</Text>
                </View>
              )}

              <Text style={s.fieldLabel}>
                Date <Text style={s.fieldOpt}>(optional)</Text>
              </Text>
              <DatePickerField
                value={dayDate}
                onChange={setDayDate}
                onClear={() => { setDayDate(null); setStartsAt(null); }}
                placeholder="Select a date (optional)"
              />

              <Text style={s.fieldLabel}>
                Time <Text style={s.fieldOpt}>(optional)</Text>
              </Text>
              <DatePickerField
                mode="time"
                value={startsAt}
                onChange={setStartsAt}
                onClear={() => setStartsAt(null)}
                placeholder="Pick a time"
              />

              <Text style={s.fieldLabel}>Autopilot handling</Text>
              <LockTypeSelector value={lockType} onChange={setLockType} />

              <Pressable
                style={[s.confirmBtn, submitting && s.confirmBtnDisabled]}
                onPress={handleConfirm}
                disabled={submitting}
              >
                {submitting
                  ? <ActivityIndicator size="small" color={color.onInk} />
                  : <Text style={s.confirmBtnText}>Add to Plan</Text>
                }
              </Pressable>
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

export function usePlanPicker(): PlanPickerContextValue {
  const ctx = useContext(PlanPickerContext);
  return ctx ?? { open: () => {}, isAdded: () => false };
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: space.lg, gap: space.md, ...shadow.float,
  },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.title, color: color.ink, fontSize: 19 },
  backBtn: { width: avatar.sm, height: avatar.sm, borderRadius: avatar.sm / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  xBtn: { width: avatar.sm, height: avatar.sm, borderRadius: avatar.sm / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  preview: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.sm },
  previewIcon: { width: avatar.lg, height: avatar.lg, borderRadius: avatar.lg / 2, backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  previewTitle: { ...t.bodyStrong, color: color.ink },
  previewMeta: { ...t.small, color: color.mute, fontSize: 11 },
  error: { ...t.small, color: color.signal, fontWeight: '600' },
  pickerLabel: { ...t.small, fontWeight: '700', color: color.mute, letterSpacing: 0.5, textTransform: 'uppercase', fontSize: 10 },
  tripRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  tripIcon: { width: avatar.smMd, height: avatar.smMd, borderRadius: avatar.smMd / 2, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
  tripTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  tripMeta: { ...t.small, color: color.mute, fontSize: 11 },
  emptyWrap: { paddingVertical: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  createRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    borderRadius: radius.md, borderWidth: 1.5,
    borderColor: color.signal + '50', borderStyle: 'dashed',
    padding: space.md,
  },
  createIcon: {
    width: avatar.smMd, height: avatar.smMd, borderRadius: avatar.smMd / 2,
    backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center',
  },
  createText: { ...t.bodyStrong, color: color.signal, fontSize: 14 },

  selectedTripChip: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', backgroundColor: color.signal + '12', borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal + '40', paddingHorizontal: space.md, paddingVertical: 5 },
  selectedTripText: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 12 },
  fieldLabel: { ...t.small, fontWeight: '700', color: color.ink, marginTop: 2 },
  fieldOpt: { fontWeight: '400', color: color.mute },
  confirmBtn: { marginTop: space.sm, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  confirmBtnDisabled: { opacity: 0.6 },
  confirmBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 15 },

  toast: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.ink, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.pill, ...shadow.float },
  toastText: { ...t.bodyStrong, color: color.onInk },
});
