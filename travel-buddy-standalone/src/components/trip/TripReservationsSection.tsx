/**
 * TripReservationsSection — reservation list + confirmation import for a trip.
 *
 * Shows reservations grouped into "Awaiting confirmation" (pending_confirm)
 * and "Confirmed" sections. A "Paste a confirmation" CTA opens an import
 * sheet where users paste text, see extracted rows, edit them, then confirm
 * or dismiss each one individually. Nothing is ever auto-confirmed.
 *
 * Returns null (renders nothing) when listReservations returns null — used
 * to hide the section when the feature flag is off in production.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Plane,
  BedDouble,
  Star,
  Car,
  Tag,
  ClipboardPaste,
  X,
  Check,
  AlertTriangle,
  Clock,
} from 'lucide-react-native';
import {
  listReservations,
  importReservations,
  confirmReservation,
  dismissReservation,
  type TripReservation,
} from '../../services/tripIntel.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

// ── Type icon map ─────────────────────────────────────────────────────────────

const RESERVATION_TYPES = [
  'flight',
  'stay',
  'activity',
  'transport',
  'other',
] as const;

type ReservationType = (typeof RESERVATION_TYPES)[number];

function TypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  switch (type as ReservationType) {
    case 'flight':    return <Plane    size={size} color={color.deep}   />;
    case 'stay':      return <BedDouble size={size} color={color.deep}  />;
    case 'activity':  return <Star     size={size} color={color.warn}   />;
    case 'transport': return <Car      size={size} color={color.mute}   />;
    default:          return <Tag      size={size} color={color.faint}  />;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function isDeadlineSoon(deadlineIso: string | null): boolean {
  if (!deadlineIso) return false;
  try {
    const diff = new Date(deadlineIso).getTime() - Date.now();
    return diff > 0 && diff < 48 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

// ── Reservation card ──────────────────────────────────────────────────────────

function ReservationCard({ item }: { item: TripReservation }) {
  const soon = isDeadlineSoon(item.cancellationDeadlineAt);
  return (
    <View style={s.card}>
      <View style={s.cardRow}>
        <View style={s.cardIcon}>
          <TypeIcon type={item.type} size={18} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.cardTitle} numberOfLines={2}>{item.title}</Text>
          {(item.startsAt || item.endsAt) ? (
            <Text style={s.cardTime}>
              {formatTime(item.startsAt)}
              {item.startsAt && item.endsAt ? ' → ' : ''}
              {item.endsAt ? formatTime(item.endsAt) : ''}
            </Text>
          ) : null}
          {item.locationName ? (
            <Text style={s.cardLocation} numberOfLines={1}>{item.locationName}</Text>
          ) : null}
        </View>
      </View>
      {soon && (
        <View style={s.deadlineChip}>
          <Clock size={11} color={color.warn} />
          <Text style={s.deadlineText}>
            Cancel by {formatTime(item.cancellationDeadlineAt)}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Editable review row ───────────────────────────────────────────────────────

interface DraftRow {
  id: string;
  type: ReservationType;
  title: string;
  startsAt: string;
  endsAt: string;
  dismissed: boolean;
  confirming: boolean;
  confirmed: boolean;
  error?: string | null;
}

function ReviewRow({
  row,
  onConfirm,
  onDismiss,
  onChange,
}: {
  row: DraftRow;
  onConfirm: (id: string, addToPlan: boolean) => void;
  onDismiss: (id: string) => void;
  onChange: (id: string, patch: Partial<Pick<DraftRow, 'type' | 'title' | 'startsAt' | 'endsAt'>>) => void;
}) {
  const [addToPlan, setAddToPlan] = useState(false);

  if (row.dismissed) return null;
  if (row.confirmed) {
    return (
      <View style={s.reviewRowDone}>
        <Check size={14} color={color.success} />
        <Text style={[s.reviewRowDoneText, { color: color.success }]}>Added</Text>
      </View>
    );
  }

  return (
    <View style={s.reviewRow}>
      {/* Type picker */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.sm }}>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {RESERVATION_TYPES.map((tp) => (
            <Pressable
              key={tp}
              style={[s.typeChip, row.type === tp && s.typeChipActive]}
              onPress={() => onChange(row.id, { type: tp })}
            >
              <TypeIcon type={tp} size={12} />
              <Text style={[s.typeChipText, row.type === tp && s.typeChipTextActive]}>
                {tp.charAt(0).toUpperCase() + tp.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {/* Title */}
      <TextInput
        style={s.reviewInput}
        value={row.title}
        onChangeText={(v) => onChange(row.id, { title: v })}
        placeholder="Title"
        placeholderTextColor={color.faint}
      />

      {/* Times */}
      <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.sm }}>
        <TextInput
          style={[s.reviewInput, { flex: 1, marginBottom: 0 }]}
          value={row.startsAt}
          onChangeText={(v) => onChange(row.id, { startsAt: v })}
          placeholder="Start (e.g. 2026-08-01 10:00)"
          placeholderTextColor={color.faint}
        />
        <TextInput
          style={[s.reviewInput, { flex: 1, marginBottom: 0 }]}
          value={row.endsAt}
          onChangeText={(v) => onChange(row.id, { endsAt: v })}
          placeholder="End"
          placeholderTextColor={color.faint}
        />
      </View>

      {/* Add to plan toggle */}
      <View style={s.toggleRow}>
        <Text style={s.toggleLabel}>Add to plan</Text>
        <Switch
          value={addToPlan}
          onValueChange={setAddToPlan}
          trackColor={{ true: color.signal, false: color.haze }}
          thumbColor={color.paperRaised}
        />
      </View>

      {/* Actions */}
      <View style={s.reviewActions}>
        <Pressable
          style={s.dismissBtn}
          onPress={() => onDismiss(row.id)}
          disabled={row.confirming}
        >
          <X size={14} color={color.mute} />
          <Text style={s.dismissText}>Dismiss</Text>
        </Pressable>
        <Pressable
          style={[s.confirmBtn, row.confirming && { opacity: 0.6 }]}
          onPress={() => onConfirm(row.id, addToPlan)}
          disabled={row.confirming}
        >
          {row.confirming
            ? <ActivityIndicator size="small" color={color.onInk} />
            : <Check size={14} color={color.onInk} />}
          <Text style={s.confirmText}>Confirm</Text>
        </Pressable>
      </View>
      {row.error ? (
        <View style={s.rowErrorBox}>
          <AlertTriangle size={12} color={color.warn} />
          <Text style={s.rowErrorText}>{row.error}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ── Import sheet ──────────────────────────────────────────────────────────────

type SheetStep = 'paste' | 'review';

/** Exported for direct testing — renders the import sheet with a given visible state. */
export function ImportSheet({
  tripId,
  visible,
  onDismiss,
  onImported,
}: {
  tripId: string;
  visible: boolean;
  onDismiss: () => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<SheetStep>('paste');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Reset on open
  useEffect(() => {
    if (visible) {
      setStep('paste');
      setText('');
      setLoading(false);
      setExtractionError(null);
      setRows([]);
    }
  }, [visible]);

  function handleCancel() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setLoading(false);
  }

  async function handleImport() {
    if (!text.trim()) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setLoading(true);
    setExtractionError(null);
    let result: Awaited<ReturnType<typeof importReservations>>;
    try {
      result = await importReservations(tripId, text.trim(), controller.signal);
    } catch {
      // AbortError — user cancelled; text is preserved, just stop loading
      abortControllerRef.current = null;
      setLoading(false);
      return;
    }
    abortControllerRef.current = null;
    setLoading(false);
    if (!result) {
      setExtractionError('Could not reach the server. Check your connection and try again.');
      return;
    }
    if (result.error) {
      setExtractionError(`Extraction failed: ${result.error}`);
      return;
    }
    if (!result.reservations || result.reservations.length === 0) {
      setExtractionError('No reservations were found in the text you pasted. Try including the full confirmation email or booking details.');
      return;
    }
    setRows(
      result.reservations.map((r) => ({
        id: r.id,
        type: (RESERVATION_TYPES.includes(r.type as ReservationType) ? r.type : 'other') as ReservationType,
        title: r.title,
        startsAt: r.startsAt ?? '',
        endsAt: r.endsAt ?? '',
        dismissed: false,
        confirming: false,
        confirmed: false,
      })),
    );
    setStep('review');
  }

  function handleRowChange(id: string, patch: Partial<Pick<DraftRow, 'type' | 'title' | 'startsAt' | 'endsAt'>>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function handleConfirm(id: string, addToPlan: boolean) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, confirming: true, error: null } : r)));
    const ok = await confirmReservation(tripId, id, addToPlan);
    if (ok) {
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, confirming: false, confirmed: true } : r)));
      onImported();
    } else {
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, confirming: false, error: 'Failed to confirm — try again' } : r)));
    }
  }

  async function handleDismiss(id: string) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, dismissed: true, error: null } : r)));
    const ok = await dismissReservation(tripId, id);
    if (!ok) {
      // Undo optimistic dismiss and surface the error
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, dismissed: false, error: 'Failed to dismiss — try again' } : r)));
    } else {
      onImported();
    }
  }

  const allDone = rows.length > 0 && rows.every((r) => r.dismissed || r.confirmed);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDismiss}>
      <View style={sh.overlay}>
        <View style={sh.sheet}>
          {/* Header */}
          <View style={sh.header}>
            <Text style={sh.title}>
              {step === 'paste' ? 'Paste a confirmation' : 'Review extracted reservations'}
            </Text>
            <Pressable onPress={onDismiss} hitSlop={8}>
              <X size={20} color={color.ink} />
            </Pressable>
          </View>

          {step === 'paste' ? (
            <View style={{ flex: 1 }}>
              <Text style={sh.hint}>
                Paste a confirmation email, booking summary, or text message below. We'll extract the reservation details for you to review.
              </Text>
              <TextInput
                style={sh.textArea}
                value={text}
                onChangeText={setText}
                multiline
                placeholder="Paste confirmation text here…"
                placeholderTextColor={color.faint}
                textAlignVertical="top"
                testID="confirmation-text-input"
              />
              {extractionError ? (
                <View style={sh.errorBox}>
                  <AlertTriangle size={14} color={color.warn} />
                  <Text style={sh.errorText}>{extractionError}</Text>
                </View>
              ) : null}
              {loading ? (
                <View style={sh.extractingRow}>
                  <View style={[sh.submitBtn, sh.extractingBtn]}>
                    <ActivityIndicator size="small" color={color.onInk} />
                    <Text style={sh.submitText}>Extracting…</Text>
                  </View>
                  <Pressable
                    style={sh.cancelBtn}
                    onPress={handleCancel}
                    testID="cancel-extract-button"
                  >
                    <X size={14} color={color.mute} />
                    <Text style={sh.cancelBtnText}>Cancel</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  style={[sh.submitBtn, !text.trim() && { opacity: 0.5 }]}
                  onPress={handleImport}
                  disabled={!text.trim()}
                  testID="extract-button"
                >
                  <ClipboardPaste size={16} color={color.onInk} />
                  <Text style={sh.submitText}>Extract reservations</Text>
                </Pressable>
              )}
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.xl }}>
              {allDone ? (
                <View style={sh.allDoneBox}>
                  <Check size={22} color={color.success} />
                  <Text style={sh.allDoneText}>All done! Your reservations have been processed.</Text>
                  <Pressable style={sh.submitBtn} onPress={onDismiss}>
                    <Text style={sh.submitText}>Close</Text>
                  </Pressable>
                </View>
              ) : (
                rows.map((row) => (
                  <ReviewRow
                    key={row.id}
                    row={row}
                    onConfirm={handleConfirm}
                    onDismiss={handleDismiss}
                    onChange={handleRowChange}
                  />
                ))
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

export function TripReservationsSection({ tripId }: { tripId: string }) {
  const [reservations, setReservations] = useState<TripReservation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await listReservations(tripId);
    if (!mountedRef.current) return;
    // Treat null result as feature-flag-off (hidden)
    setReservations(result as TripReservation[] | null);
    setLoading(false);
  }, [tripId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // null means feature is off — render nothing
  if (reservations === null && !loading) return null;

  const pending = (reservations ?? []).filter((r) => r.status === 'pending_confirm');
  const confirmed = (reservations ?? []).filter((r) => r.status === 'confirmed');
  const hasAny = pending.length > 0 || confirmed.length > 0;

  return (
    <View style={s.wrap}>
      {/* Section header */}
      <View style={s.head}>
        <Text style={s.headTitle}>Reservations</Text>
        <Pressable
          style={s.pasteBtn}
          onPress={() => setImportOpen(true)}
          testID="paste-confirmation-btn"
        >
          <ClipboardPaste size={14} color={color.signal} />
          <Text style={s.pasteBtnText}>Paste a confirmation</Text>
        </Pressable>
      </View>

      {loading && !hasAny ? (
        <View style={s.loadingRow}>
          <ActivityIndicator size="small" color={color.signal} />
        </View>
      ) : !hasAny ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>No reservations yet. Paste a confirmation to get started.</Text>
        </View>
      ) : (
        <>
          {pending.length > 0 && (
            <View>
              <Text style={s.groupLabel}>Awaiting confirmation</Text>
              {pending.map((r) => <ReservationCard key={r.id} item={r} />)}
            </View>
          )}
          {confirmed.length > 0 && (
            <View>
              <Text style={s.groupLabel}>Confirmed</Text>
              {confirmed.map((r) => <ReservationCard key={r.id} item={r} />)}
            </View>
          )}
        </>
      )}

      <ImportSheet
        tripId={tripId}
        visible={importOpen}
        onDismiss={() => setImportOpen(false)}
        onImported={load}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  wrap: { marginTop: space.xl },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    marginBottom: space.md,
  },
  headTitle: { ...t.title, color: color.ink, fontSize: 20, flex: 1 },
  pasteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.signal,
  },
  pasteBtnText: { ...t.small, color: color.signal, fontWeight: '700' },

  loadingRow: { alignItems: 'center', paddingVertical: space.xl },

  empty: {
    marginHorizontal: space.lg,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.haze,
    alignItems: 'center',
  },
  emptyText: { ...t.small, color: color.mute, textAlign: 'center' },

  groupLabel: {
    ...t.stamp,
    color: color.mute,
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  card: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
  },
  cardRow: { flexDirection: 'row', gap: space.sm },
  cardIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: color.paper,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardTitle: { ...t.bodyStrong, color: color.ink },
  cardTime: { ...t.small, color: color.mute, marginTop: 2 },
  cardLocation: { ...t.stamp, color: color.faint, marginTop: 2 },

  deadlineChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    backgroundColor: '#FEF3C7',
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  deadlineText: { ...t.stamp, color: color.warn, fontSize: 11 },

  // Review row
  reviewRow: {
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
  },
  reviewInput: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    ...t.body,
    color: color.ink,
    marginBottom: space.sm,
  },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  typeChipActive: {
    borderColor: color.deep,
    backgroundColor: color.deep,
  },
  typeChipText: { ...t.stamp, color: color.mute, fontSize: 11 },
  typeChipTextActive: { color: color.onInk },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  toggleLabel: { ...t.small, color: color.ink, fontWeight: '600' },

  reviewActions: { flexDirection: 'row', gap: space.sm },
  rowErrorBox: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  rowErrorText: { ...t.small, color: color.warn, flex: 1 },
  dismissBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
  },
  dismissText: { ...t.small, color: color.mute, fontWeight: '600' },
  confirmBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.signal,
  },
  confirmText: { ...t.small, color: color.onInk, fontWeight: '700' },

  reviewRowDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    backgroundColor: '#F0FDF4',
    borderRadius: radius.md,
  },
  reviewRowDoneText: { ...t.small },
});

const sh = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(17,17,15,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '85%',
    paddingHorizontal: space.lg,
    paddingBottom: space.xxxl,
    paddingTop: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  title: { ...t.heading, color: color.ink },
  hint: { ...t.small, color: color.mute, marginBottom: space.md, lineHeight: 20 },
  textArea: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 160,
    ...t.body,
    color: color.ink,
    marginBottom: space.md,
    backgroundColor: color.paperRaised,
  },
  errorBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: '#FEF3C7',
    borderRadius: radius.sm,
    padding: space.md,
    marginBottom: space.md,
  },
  errorText: { ...t.small, color: color.warn, flex: 1, lineHeight: 18 },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md,
  },
  submitText: { ...t.bodyStrong, color: color.onInk },
  extractingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  extractingBtn: {
    flex: 1,
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
  },
  cancelBtnText: { ...t.body, color: color.mute },
  allDoneBox: {
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.xl,
  },
  allDoneText: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
});
