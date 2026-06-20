import React, { useState, useCallback } from 'react';
import {
  View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet, Modal, Alert,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Plus, MapPin, Clock, Trash2, MoreHorizontal, CheckCircle2 } from 'lucide-react-native';
import type { TripPlanItem, TripPlanCategory } from '../types/models';
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
    const d = new Date(key);
    const label = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    buckets.push({ key, label, items: rows });
  }
  buckets.sort((a, b) => a.key.localeCompare(b.key));
  if (map.has('__unscheduled__')) {
    buckets.push({ key: '__unscheduled__', label: 'Unscheduled', items: map.get('__unscheduled__')! });
  }
  return buckets;
}

// ── Plan item card ─────────────────────────────────────────────────────────────

function PlanItemCard({
  item,
  currentUserId,
  isOwner,
  onRemove,
  onMarkDone,
}: {
  item: TripPlanItem;
  currentUserId: string;
  isOwner: boolean;
  onRemove: (id: string) => void;
  onMarkDone: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const cat = CAT_STYLE[item.category] ?? CAT_STYLE.other;
  const statusStyle = STATUS_STYLE[item.status] ?? STATUS_STYLE.tentative;
  const canAct = isOwner || item.creatorId === currentUserId;
  const timeStr = fmtTime(item.startsAt);

  return (
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

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={ic.menuOverlay} onPress={() => setMenuOpen(false)}>
          <View style={ic.menuSheet}>
            <Text style={ic.menuTitle} numberOfLines={1}>{item.title}</Text>
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
    </View>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

export function TripPlanSection({ tripId, currentUserId, isOwner }: {
  tripId: string;
  currentUserId: string;
  isOwner: boolean;
}) {
  const [items, setItems] = useState<TripPlanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchTripPlan(tripId);
      setItems(data);
    } catch {
      // non-member, unauthenticated, or network error — stay empty
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
        <Pressable style={ps.addBtn} onPress={() => setAddSheetOpen(true)}>
          <Plus size={15} color={color.onInk} />
          <Text style={ps.addBtnText}>Add Item</Text>
        </Pressable>
      </View>

      {loading && <ActivityIndicator color={color.signal} style={{ marginVertical: space.lg }} />}

      {!loading && items.length === 0 && (
        <View style={ps.empty}>
          <Text style={ps.emptyTitle}>No plans yet.</Text>
          <Text style={ps.emptyBody}>Add places, meetups, or activities to build your day-by-day itinerary.</Text>
          <Pressable style={ps.emptyBtn} onPress={() => setAddSheetOpen(true)}>
            <Text style={ps.emptyBtnText}>Add your first item</Text>
          </Pressable>
        </View>
      )}

      {!loading && buckets.map((bucket) => (
        <View key={bucket.key} style={ps.bucket}>
          <View style={ps.dayChip}>
            <Text style={ps.dayChipText}>{bucket.label}</Text>
          </View>
          {bucket.items.length === 0 ? (
            <Text style={ps.emptyDay}>Nothing planned for this day yet.</Text>
          ) : bucket.items.map((item) => (
            <PlanItemCard
              key={item.id}
              item={item}
              currentUserId={currentUserId}
              isOwner={isOwner}
              onRemove={handleRemove}
              onMarkDone={handleMarkDone}
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
