import React, { useState, useCallback } from 'react';
import {
  View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet, Modal, Alert,
  TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Plus, MapPin, Clock, Trash2, MoreHorizontal, CheckCircle2, Pencil, Lock } from 'lucide-react-native';
import type { TripPlanItem, TripPlanCategory, TripPlanItemStatus } from '../types/models';
import { fetchTripPlan, removePlanItem, updatePlanItem } from '../services/tripPlan';
import { color, space, radius, type as t } from '../theme/tokens';
import { AddToPlanSheet } from './AddToPlanSheet';

// ── Category colours ──────────────────────────────────────────────────────────

const CAT_STYLE: Record<TripPlanCategory, { bg: string; fg: string; label: string }> = {
  accommodation:   { bg: '#E2EDF0', fg: color.deep,    label: 'Stay' },
  activity:        { bg: '#E3F1EA', fg: color.success, label: 'Activity' },
  dining:          { bg: '#FCE9E4', fg: color.signal,  label: 'Dining' },
  transport:       { bg: '#EFE7FA', fg: '#7A4DBF',     label: 'Transport' },
  free_time:       { bg: '#F5F0E8', fg: '#8B6914',     label: 'Free time' },
  meeting_point:   { bg: '#FFF0D0', fg: '#B07000',     label: 'Meetup' },
  other:           { bg: color.haze, fg: color.mute,  label: 'Other' },
};

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  confirmed:  { bg: '#E3F1EA', fg: color.success },
  tentative:  { bg: '#F5F0E8', fg: '#8B6914' },
  done:       { bg: color.haze, fg: color.mute },
  cancelled:  { bg: '#FCE9E4', fg: '#B0291A' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(key: string, tripStartDate: string | null | undefined): string {
  if (key === '__unscheduled__') return 'Unscheduled';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const d = new Date(key + 'T00:00:00');
  if (isNaN(d.getTime())) return key;

  const ms = d.getTime();
  if (ms === today.getTime()) return 'Today';
  if (ms === tomorrow.getTime()) return 'Tomorrow';

  if (tripStartDate) {
    const start = new Date(tripStartDate + 'T00:00:00');
    if (!isNaN(start.getTime())) {
      const dayNum = Math.round((ms - start.getTime()) / 86_400_000) + 1;
      if (dayNum >= 1) {
        const fmt = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return `Day ${dayNum} — ${fmt}`;
      }
    }
  }
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function groupByDay(items: TripPlanItem[]): { label: string; key: string; items: TripPlanItem[] }[] {
  const map = new Map<string, TripPlanItem[]>();
  for (const item of items) {
    const key = item.dayDate ?? '__unscheduled__';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  const buckets: { label: string; key: string; items: TripPlanItem[] }[] = [];
  for (const [key, rows] of map) {
    if (key === '__unscheduled__') continue;
    buckets.push({ key, label: key, items: rows });
  }
  buckets.sort((a, b) => a.key.localeCompare(b.key));
  if (map.has('__unscheduled__')) {
    buckets.push({ key: '__unscheduled__', label: '__unscheduled__', items: map.get('__unscheduled__')! });
  }
  return buckets;
}

// ── Inline edit modal ─────────────────────────────────────────────────────────

interface EditSheetProps {
  item: TripPlanItem;
  onClose: () => void;
  onSaved: (updated: TripPlanItem) => void;
  tripId: string;
}

const STATUS_OPTIONS: { value: TripPlanItemStatus; label: string }[] = [
  { value: 'tentative', label: 'Tentative' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'done',      label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

function EditPlanItemSheet({ item, tripId, onClose, onSaved }: EditSheetProps) {
  const [title, setTitle] = useState(item.title);
  const [dayDate, setDayDate] = useState(item.dayDate ?? '');
  const [startsAt, setStartsAt] = useState(
    item.startsAt ? new Date(item.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
  );
  const [status, setStatus] = useState<TripPlanItemStatus>(item.status);
  const [notes, setNotes] = useState(item.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    setError('');
    setSubmitting(true);
    try {
      const updated = await updatePlanItem(tripId, item.id, {
        title: title.trim(),
        dayDate: dayDate.trim() || null,
        startsAt: dayDate.trim() && startsAt.trim() ? `${dayDate.trim()}T${startsAt.trim()}:00` : null,
        status,
        notes: notes.trim() || null,
      });
      onSaved(updated);
    } catch (e: any) {
      setError(e.message ?? 'Could not save. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={ed.overlay} onPress={onClose} />
        <View style={ed.sheet}>
          <View style={ed.handle} />
          <View style={ed.header}>
            <Text style={ed.headerTitle}>Edit Plan Item</Text>
            <Pressable onPress={onClose} style={ed.cancelBtn}><Text style={ed.cancelText}>Cancel</Text></Pressable>
          </View>
          <ScrollView
            contentContainerStyle={ed.body}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={ed.label}>Title</Text>
            <TextInput style={ed.input} value={title} onChangeText={setTitle} placeholderTextColor={color.faint} />

            <Text style={ed.label}>Date <Text style={ed.opt}>(YYYY-MM-DD)</Text></Text>
            <TextInput style={ed.input} value={dayDate} onChangeText={setDayDate} placeholder="e.g. 2026-07-15" placeholderTextColor={color.faint} keyboardType="numbers-and-punctuation" />

            <Text style={ed.label}>Time <Text style={ed.opt}>(HH:MM, 24-hour)</Text></Text>
            <TextInput style={ed.input} value={startsAt} onChangeText={setStartsAt} placeholder="e.g. 19:30" placeholderTextColor={color.faint} keyboardType="numbers-and-punctuation" />

            <Text style={ed.label}>Status</Text>
            <View style={ed.statusRow}>
              {STATUS_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[ed.statusChip, status === opt.value && ed.statusChipActive]}
                  onPress={() => setStatus(opt.value)}
                >
                  <Text style={[ed.statusChipText, status === opt.value && ed.statusChipTextActive]}>
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={ed.label}>Notes <Text style={ed.opt}>(optional)</Text></Text>
            <TextInput
              style={[ed.input, ed.inputMulti]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Any extra details…"
              placeholderTextColor={color.faint}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />

            {error ? <Text style={ed.error}>{error}</Text> : null}

            <Pressable
              style={[ed.saveBtn, submitting && ed.saveBtnDisabled]}
              onPress={handleSave}
              disabled={submitting}
            >
              <Text style={ed.saveText}>{submitting ? 'Saving…' : 'Save Changes'}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Plan item card ─────────────────────────────────────────────────────────────

function PlanItemCard({
  item,
  currentUserId,
  isOwner,
  tripId,
  onRemove,
  onMarkDone,
  onMarkTentative,
  onEdited,
}: {
  item: TripPlanItem;
  currentUserId: string;
  isOwner: boolean;
  tripId: string;
  onRemove: (id: string) => void;
  onMarkDone: (id: string) => void;
  onMarkTentative: (id: string) => void;
  onEdited: (updated: TripPlanItem) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const cat = CAT_STYLE[item.category] ?? CAT_STYLE.other;
  const statusStyle = STATUS_STYLE[item.status] ?? STATUS_STYLE.tentative;
  const canAct = isOwner || item.creatorId === currentUserId;
  const timeStr = fmtTime(item.startsAt);

  return (
    <>
      <View style={ic.card}>
        <View style={ic.top}>
          <View style={[ic.catBadge, { backgroundColor: cat.bg }]}>
            <Text style={[ic.catText, { color: cat.fg }]}>{cat.label}</Text>
          </View>
          {item.sourceType !== 'manual' && (
            <View style={ic.sourceBadge}>
              <Text style={ic.sourceText}>{item.sourceType === 'meetup' ? 'Meetup' : 'Place'}</Text>
            </View>
          )}
          <View style={{ flex: 1 }} />
          <View style={[ic.statusBadge, { backgroundColor: statusStyle.bg }]}>
            <Text style={[ic.statusText, { color: statusStyle.fg }]}>{item.status}</Text>
          </View>
          {canAct && (
            <Pressable hitSlop={8} onPress={() => setMenuOpen(true)} style={ic.moreBtn}>
              <MoreHorizontal size={16} color={color.mute} />
            </Pressable>
          )}
        </View>

        <Text style={ic.title} numberOfLines={2}>{item.title}</Text>

        {(timeStr || item.locationName) && (
          <View style={ic.metaRow}>
            {timeStr && (
              <View style={ic.metaItem}>
                <Clock size={12} color={color.mute} />
                <Text style={ic.metaText}>{timeStr}</Text>
              </View>
            )}
            {item.locationName && (
              <View style={ic.metaItem}>
                <MapPin size={12} color={color.mute} />
                <Text style={ic.metaText} numberOfLines={1}>{item.locationName}</Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Action menu modal */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={ic.menuOverlay} onPress={() => setMenuOpen(false)}>
          <View style={ic.menuSheet}>
            <Text style={ic.menuTitle} numberOfLines={1}>{item.title}</Text>

            <Pressable style={ic.menuItem} onPress={() => { setMenuOpen(false); setEditOpen(true); }}>
              <Pencil size={18} color={color.deep} />
              <Text style={ic.menuItemText}>Edit / Reschedule</Text>
            </Pressable>

            {item.status !== 'confirmed' && (
              <Pressable style={ic.menuItem} onPress={() => { setMenuOpen(false); onMarkTentative(item.id); }}>
                <Clock size={18} color={color.mute} />
                <Text style={ic.menuItemText}>Mark as tentative</Text>
              </Pressable>
            )}

            {item.status !== 'done' && (
              <Pressable style={ic.menuItem} onPress={() => { setMenuOpen(false); onMarkDone(item.id); }}>
                <CheckCircle2 size={18} color={color.success} />
                <Text style={ic.menuItemText}>Mark as done</Text>
              </Pressable>
            )}

            <Pressable style={ic.menuItem} onPress={() => { setMenuOpen(false); onRemove(item.id); }}>
              <Trash2 size={18} color={color.signal} />
              <Text style={[ic.menuItemText, { color: color.signal }]}>Remove from plan</Text>
            </Pressable>

            <Pressable style={ic.menuCancel} onPress={() => setMenuOpen(false)}>
              <Text style={ic.menuCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Edit sheet */}
      {editOpen && (
        <EditPlanItemSheet
          item={item}
          tripId={tripId}
          onClose={() => setEditOpen(false)}
          onSaved={(updated) => { setEditOpen(false); onEdited(updated); }}
        />
      )}
    </>
  );
}

// ── Non-member locked view ─────────────────────────────────────────────────────

function PlanLockedView() {
  return (
    <View style={lk.wrap}>
      <View style={lk.iconWrap}><Lock size={22} color={color.mute} /></View>
      <Text style={lk.title}>Members-only</Text>
      <Text style={lk.body}>Join this trip to see and collaborate on the day-by-day plan.</Text>
    </View>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

export function TripPlanSection({
  tripId,
  currentUserId,
  isOwner,
  tripStartDate,
}: {
  tripId: string;
  currentUserId: string;
  isOwner: boolean;
  tripStartDate?: string | null;
}) {
  const [items, setItems] = useState<TripPlanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setAccessDenied(false);
    try {
      const data = await fetchTripPlan(tripId);
      setItems(data);
    } catch (e: any) {
      const msg = (e.message ?? '').toLowerCase();
      if (msg.includes('403') || msg.includes('401') || msg.includes('forbidden') || msg.includes('unauthorized')) {
        setAccessDenied(true);
      }
      // other errors: stay empty, don't show locked
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleRemove = useCallback(async (itemId: string) => {
    Alert.alert('Remove item', 'Remove this item from the trip plan?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          try {
            await removePlanItem(tripId, itemId);
            setItems((prev) => prev.filter((i) => i.id !== itemId));
          } catch {
            Alert.alert('Error', 'Could not remove item. Please try again.');
          }
        },
      },
    ]);
  }, [tripId]);

  const handleMarkDone = useCallback(async (itemId: string) => {
    try {
      const updated = await updatePlanItem(tripId, itemId, { status: 'done' });
      setItems((prev) => prev.map((i) => i.id === itemId ? updated : i));
    } catch {
      Alert.alert('Error', 'Could not update item. Please try again.');
    }
  }, [tripId]);

  const handleMarkTentative = useCallback(async (itemId: string) => {
    try {
      const updated = await updatePlanItem(tripId, itemId, { status: 'tentative' });
      setItems((prev) => prev.map((i) => i.id === itemId ? updated : i));
    } catch {
      Alert.alert('Error', 'Could not update item. Please try again.');
    }
  }, [tripId]);

  const handleEdited = useCallback((updated: TripPlanItem) => {
    setItems((prev) => prev.map((i) => i.id === updated.id ? updated : i));
  }, []);

  const handleAdded = useCallback((item: TripPlanItem) => {
    setItems((prev) => [...prev, item]);
    setAddSheetOpen(false);
  }, []);

  const buckets = groupByDay(items);

  return (
    <View style={ps.wrap}>
      <View style={ps.head}>
        <Text style={ps.title}>Trip Plan</Text>
        <View style={{ flex: 1 }} />
        {!accessDenied && (
          <Pressable style={ps.addBtn} onPress={() => setAddSheetOpen(true)}>
            <Plus size={15} color={color.onInk} />
            <Text style={ps.addBtnText}>Add Item</Text>
          </Pressable>
        )}
      </View>

      {loading && <ActivityIndicator color={color.signal} style={{ marginVertical: space.lg }} />}

      {!loading && accessDenied && <PlanLockedView />}

      {!loading && !accessDenied && items.length === 0 && (
        <View style={ps.empty}>
          <Text style={ps.emptyTitle}>No plans yet.</Text>
          <Text style={ps.emptyBody}>Add places, meetups, or activities to build your day-by-day itinerary.</Text>
          <Pressable style={ps.emptyBtn} onPress={() => setAddSheetOpen(true)}>
            <Text style={ps.emptyBtnText}>Add your first item</Text>
          </Pressable>
        </View>
      )}

      {!loading && !accessDenied && buckets.map((bucket) => (
        <View key={bucket.key} style={ps.bucket}>
          <View style={ps.dayChip}>
            <Text style={ps.dayChipText}>{dayLabel(bucket.key, tripStartDate)}</Text>
          </View>
          {bucket.items.length === 0 ? (
            <Text style={ps.emptyDay}>Nothing planned for this day yet.</Text>
          ) : bucket.items.map((item) => (
            <PlanItemCard
              key={item.id}
              item={item}
              currentUserId={currentUserId}
              isOwner={isOwner}
              tripId={tripId}
              onRemove={handleRemove}
              onMarkDone={handleMarkDone}
              onMarkTentative={handleMarkTentative}
              onEdited={handleEdited}
            />
          ))}
        </View>
      ))}

      <AddToPlanSheet
        visible={addSheetOpen}
        tripId={tripId}
        onClose={() => setAddSheetOpen(false)}
        onAdded={handleAdded}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const ps = StyleSheet.create({
  wrap: { marginTop: space.lg },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, marginBottom: space.md },
  title: { ...t.title, color: color.ink, fontSize: 20 },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.signal, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill },
  addBtnText: { ...t.small, fontWeight: '800', color: color.onInk },
  empty: { marginHorizontal: space.lg, padding: space.xl, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze, gap: space.sm, alignItems: 'flex-start' },
  emptyTitle: { ...t.bodyStrong, color: color.ink },
  emptyBody: { ...t.body, color: color.mute, lineHeight: 20 },
  emptyBtn: { marginTop: space.sm, backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.md },
  emptyBtnText: { ...t.small, fontWeight: '800', color: color.onInk },
  bucket: { marginBottom: space.md },
  dayChip: { marginHorizontal: space.lg, marginBottom: space.sm, backgroundColor: color.ink, alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill },
  dayChipText: { ...t.small, color: color.onInk, fontWeight: '800', fontSize: 12 },
  emptyDay: { ...t.small, color: color.mute, marginHorizontal: space.lg, fontStyle: 'italic' },
});

const ic = StyleSheet.create({
  card: { marginHorizontal: space.lg, marginBottom: space.sm, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: 6 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  catBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.sm },
  catText: { ...t.small, fontWeight: '800', fontSize: 10 },
  sourceBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: '#EFE7FA' },
  sourceText: { ...t.small, color: '#7A4DBF', fontWeight: '700', fontSize: 10 },
  statusBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  statusText: { ...t.small, fontWeight: '700', fontSize: 10 },
  moreBtn: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  metaRow: { flexDirection: 'row', gap: space.md, flexWrap: 'wrap' },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { ...t.small, color: color.mute, fontSize: 12 },
  menuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  menuSheet: { backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, gap: space.sm, paddingBottom: 40 },
  menuTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  menuItemText: { ...t.body, color: color.ink },
  menuCancel: { paddingVertical: space.md, alignItems: 'center', marginTop: space.sm },
  menuCancelText: { ...t.bodyStrong, color: color.mute },
});

const lk = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, padding: space.xl, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, alignItems: 'center', gap: space.sm },
  iconWrap: { width: 48, height: 48, borderRadius: 24, backgroundColor: color.paperRaised, alignItems: 'center', justifyContent: 'center', marginBottom: space.sm },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  body: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 20 },
});

const ed = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'transparent' },
  sheet: { backgroundColor: color.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%', paddingBottom: 30 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  headerTitle: { ...t.heading, color: color.ink, fontSize: 17 },
  cancelBtn: { padding: 4 },
  cancelText: { ...t.bodyStrong, color: color.mute },
  body: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.lg, gap: 4 },
  label: { ...t.small, fontWeight: '700', color: color.ink, marginTop: space.md, marginBottom: 4 },
  opt: { fontWeight: '400', color: color.mute },
  input: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, ...t.body, color: color.ink, backgroundColor: color.paperRaised },
  inputMulti: { height: 80, paddingTop: space.sm },
  statusRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  statusChip: { paddingHorizontal: space.md, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.haze, backgroundColor: color.paperRaised },
  statusChipActive: { backgroundColor: color.signal, borderColor: color.signal },
  statusChipText: { ...t.small, fontWeight: '700', color: color.ink },
  statusChipTextActive: { color: color.onInk },
  error: { ...t.small, color: color.signal, marginTop: space.sm },
  saveBtn: { marginTop: space.lg, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  saveBtnDisabled: { opacity: 0.6 },
  saveText: { ...t.bodyStrong, color: color.onInk, fontSize: 15 },
});
