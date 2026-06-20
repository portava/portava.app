import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { Plus, Lock, Map as MapIcon, List, RotateCcw } from 'lucide-react-native';
import type { TripPlanItem, TripPlanCategory } from '../types/models';
import { fetchTripPlan, fetchTripPlanMap } from '../services/tripPlan';
import { color, space, radius, type as t } from '../theme/tokens';
import { AddToPlanSheet } from './AddToPlanSheet';
import { TimelineView, type DayBucket } from './itinerary/TimelineView';
import { ItineraryMapView } from './itinerary/MapView';
import { PlanItemSheet } from './itinerary/PlanItemSheet';

// ── Category filter data ───────────────────────────────────────────────────────

const CAT_CHIPS: { key: TripPlanCategory | 'all'; label: string }[] = [
  { key: 'all',           label: 'All' },
  { key: 'accommodation', label: 'Stay' },
  { key: 'activity',      label: 'Activity' },
  { key: 'dining',        label: 'Dining' },
  { key: 'transport',     label: 'Transport' },
  { key: 'meeting_point', label: 'Meetup' },
  { key: 'free_time',     label: 'Free time' },
  { key: 'other',         label: 'Other' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function dayChipLabel(key: string, tripStartDate: string | null | undefined): string {
  if (key === '__unscheduled__') return 'Unscheduled';
  const d = new Date(key + 'T00:00:00');
  if (isNaN(d.getTime())) return key;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const ms = d.getTime();
  if (ms === today.getTime()) return 'Today';
  if (ms === tomorrow.getTime()) return 'Tomorrow';
  if (tripStartDate) {
    const start = new Date(tripStartDate + 'T00:00:00');
    if (!isNaN(start.getTime())) {
      const dayNum = Math.round((ms - start.getTime()) / 86_400_000) + 1;
      if (dayNum >= 1) return `Day ${dayNum}`;
    }
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function buildBuckets(
  items: TripPlanItem[],
  tripStartDate: string | null | undefined,
  tripEndDate: string | null | undefined,
): DayBucket[] {
  const byDay: Map<string, TripPlanItem[]> = new Map();
  const unscheduled: TripPlanItem[] = [];

  for (const item of items) {
    if (item.dayDate) {
      if (!byDay.has(item.dayDate)) byDay.set(item.dayDate, []);
      byDay.get(item.dayDate)!.push(item);
    } else {
      unscheduled.push(item);
    }
  }

  const buckets: DayBucket[] = [];

  if (tripStartDate && tripEndDate) {
    const start = new Date(tripStartDate + 'T00:00:00');
    const end   = new Date(tripEndDate   + 'T00:00:00');
    const cur = new Date(start);
    while (cur <= end) {
      const key = cur.toISOString().slice(0, 10);
      buckets.push({ key, items: byDay.get(key) ?? [] });
      byDay.delete(key);
      cur.setDate(cur.getDate() + 1);
    }
    for (const [key, rows] of byDay) buckets.push({ key, items: rows });
    buckets.sort((a, b) => a.key.localeCompare(b.key));
  } else {
    for (const [key, rows] of byDay) buckets.push({ key, items: rows });
    buckets.sort((a, b) => a.key.localeCompare(b.key));
  }

  if (unscheduled.length > 0 || items.length === 0) {
    buckets.push({ key: '__unscheduled__', items: unscheduled });
  }

  return buckets;
}

// ── Day chip bar ──────────────────────────────────────────────────────────────

function DayChipBar({
  buckets, activeDay, onPick, tripStartDate,
}: {
  buckets: DayBucket[];
  activeDay: string;
  onPick: (key: string) => void;
  tripStartDate?: string | null;
}) {
  if (buckets.length <= 1) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={dc.strip} style={dc.scroll}>
      <Pressable style={[dc.chip, activeDay === 'all' && dc.chipActive]} onPress={() => onPick('all')}>
        <Text style={[dc.chipText, activeDay === 'all' && dc.chipTextActive]}>All</Text>
      </Pressable>
      {buckets.map((b) => {
        const on = activeDay === b.key;
        return (
          <Pressable key={b.key} style={[dc.chip, on && dc.chipActive]} onPress={() => onPick(b.key)}>
            <Text style={[dc.chipText, on && dc.chipTextActive]}>{dayChipLabel(b.key, tripStartDate)}</Text>
            {b.items.length > 0 && <View style={[dc.dot, on && dc.dotActive]} />}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ── Category chip bar ─────────────────────────────────────────────────────────

function CategoryChipBar({
  activeCat, onPick,
}: {
  activeCat: TripPlanCategory | 'all';
  onPick: (key: TripPlanCategory | 'all') => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cc.strip} style={cc.scroll}>
      {CAT_CHIPS.map((c) => {
        const on = activeCat === c.key;
        return (
          <Pressable key={c.key} style={[cc.chip, on && cc.chipActive]} onPress={() => onPick(c.key)}>
            <Text style={[cc.chipText, on && cc.chipTextActive]}>{c.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
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

// ── Timeline / Map toggle ─────────────────────────────────────────────────────

type ViewMode = 'timeline' | 'map';

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <View style={vt.wrap}>
      <Pressable style={[vt.btn, mode === 'timeline' && vt.btnActive]} onPress={() => onChange('timeline')}>
        <List size={14} color={mode === 'timeline' ? '#fff' : color.mute} />
        <Text style={[vt.btnText, mode === 'timeline' && vt.btnTextActive]}>Timeline</Text>
      </Pressable>
      <Pressable style={[vt.btn, mode === 'map' && vt.btnActive]} onPress={() => onChange('map')}>
        <MapIcon size={14} color={mode === 'map' ? '#fff' : color.mute} />
        <Text style={[vt.btnText, mode === 'map' && vt.btnTextActive]}>Map</Text>
      </Pressable>
    </View>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

export function TripPlanSection({
  tripId,
  currentUserId,
  isOwner,
  tripStartDate,
  tripEndDate,
}: {
  tripId: string;
  currentUserId: string;
  isOwner: boolean;
  tripStartDate?: string | null;
  tripEndDate?: string | null;
}) {
  const [items, setItems] = useState<TripPlanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [mapItems, setMapItems] = useState<TripPlanItem[]>([]);
  const [mapLoading, setMapLoading] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [activeDay, setActiveDay] = useState<string>('all');
  const [activeCat, setActiveCat] = useState<TripPlanCategory | 'all'>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [detailItem, setDetailItem] = useState<TripPlanItem | null>(null);

  // Persist view mode per-trip
  useEffect(() => {
    AsyncStorage.getItem(`tripPlanMode:${tripId}`)
      .then((v) => { if (v === 'timeline' || v === 'map') setViewMode(v); })
      .catch(() => {});
  }, [tripId]);

  const loadMap = useCallback(async () => {
    setMapLoading(true);
    try {
      const data = await fetchTripPlanMap(tripId);
      setMapItems(data);
    } catch {
      // Map is advisory — silently ignore errors
    } finally {
      setMapLoading(false);
    }
  }, [tripId]);

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
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleViewModeChange = useCallback((m: ViewMode) => {
    setViewMode(m);
    AsyncStorage.setItem(`tripPlanMode:${tripId}`, m).catch(() => {});
    if (m === 'map' && mapItems.length === 0 && !mapLoading) loadMap();
  }, [tripId, mapItems.length, mapLoading, loadMap]);

  const handleAdded = useCallback((item: TripPlanItem) => {
    setItems((prev) => [...prev, item]);
    setAddSheetOpen(false);
  }, []);

  const handleItemsChanged = useCallback(
    (updater: (prev: TripPlanItem[]) => TripPlanItem[]) => setItems(updater),
    [],
  );

  // Apply day + category filters to items
  const filteredItems = items.filter((item) => {
    const dayOk = activeDay === 'all'
      ? true
      : activeDay === '__unscheduled__'
        ? !item.dayDate
        : item.dayDate === activeDay;
    const catOk = activeCat === 'all' || item.category === activeCat;
    return dayOk && catOk;
  });

  // Build day buckets from ALL items (for the chip bar) and filtered items (for rendering)
  const allBuckets = buildBuckets(items, tripStartDate, tripEndDate);

  const visibleBuckets = activeDay === 'all' && activeCat === 'all'
    ? allBuckets
    : buildBuckets(filteredItems, tripStartDate, tripEndDate);

  const hasContent = items.length > 0;

  return (
    <View style={ps.wrap}>
      {/* Header */}
      <View style={ps.head}>
        <Text style={ps.title}>Trip Plan</Text>
        <View style={{ flex: 1 }} />
        {!accessDenied && hasContent && (
          <ViewToggle mode={viewMode} onChange={handleViewModeChange} />
        )}
        {!accessDenied && (
          <>
            <Pressable style={ps.refreshBtn} onPress={load} hitSlop={8}>
              <RotateCcw size={15} color={color.mute} />
            </Pressable>
            <Pressable style={ps.addBtn} onPress={() => setAddSheetOpen(true)}>
              <Plus size={15} color={color.onInk} />
              <Text style={ps.addBtnText}>Add</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* Filters — only shown when there's content */}
      {!loading && !accessDenied && hasContent && (
        <>
          <DayChipBar
            buckets={allBuckets}
            activeDay={activeDay}
            onPick={setActiveDay}
            tripStartDate={tripStartDate}
          />
          <CategoryChipBar activeCat={activeCat} onPick={setActiveCat} />
        </>
      )}

      {loading && <ActivityIndicator color={color.signal} style={{ marginVertical: space.lg }} />}

      {!loading && accessDenied && <PlanLockedView />}

      {!loading && !accessDenied && items.length === 0 && (
        <View style={ps.empty}>
          <Text style={ps.emptyTitle}>No plans yet.</Text>
          <Text style={ps.emptyBody}>
            Add places, meetups, or activities to build your day-by-day itinerary.
          </Text>
          <Pressable style={ps.emptyBtn} onPress={() => setAddSheetOpen(true)}>
            <Text style={ps.emptyBtnText}>Add your first item</Text>
          </Pressable>
        </View>
      )}

      {!loading && !accessDenied && hasContent && viewMode === 'timeline' && (
        <TimelineView
          buckets={visibleBuckets}
          tripStartDate={tripStartDate}
          tripId={tripId}
          currentUserId={currentUserId}
          isOwner={isOwner}
          onItemPress={setDetailItem}
          onItemsChanged={handleItemsChanged}
        />
      )}

      {!loading && !accessDenied && hasContent && viewMode === 'map' && (
        <ItineraryMapView
          items={mapItems.length > 0
            ? mapItems.filter((item) => activeCat === 'all' || item.category === activeCat)
            : filteredItems.filter((item) => item.lat != null && item.lng != null && !item.locationIsPrivate)}
          onItemPress={setDetailItem}
          selectedDay={activeDay}
          loading={mapLoading}
        />
      )}

      {/* Item detail sheet */}
      <PlanItemSheet
        item={detailItem}
        tripId={tripId}
        currentUserId={currentUserId}
        isOwner={isOwner}
        onClose={() => setDetailItem(null)}
        onUpdated={(updated) => {
          setItems((prev) => prev.map((i) => i.id === updated.id ? updated : i));
          setDetailItem(updated);
        }}
        onRemoved={(id) => {
          setItems((prev) => prev.filter((i) => i.id !== id));
          setDetailItem(null);
        }}
      />

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
  wrap:       { marginTop: space.lg },
  head:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, marginBottom: space.sm, gap: 8 },
  title:      { ...t.title, color: color.ink, fontSize: 20 },
  refreshBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  addBtn:     { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.deep, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 6 },
  addBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  empty:      { padding: space.lg, alignItems: 'center', gap: 8, paddingVertical: 40 },
  emptyTitle: { ...t.title, fontSize: 18, color: color.ink },
  emptyBody:  { ...t.body, color: color.mute, textAlign: 'center', maxWidth: 280, lineHeight: 22 },
  emptyBtn:   { marginTop: 8, backgroundColor: color.deep, borderRadius: radius.md, paddingHorizontal: 20, paddingVertical: 10 },
  emptyBtnText:{ ...t.body, color: '#fff', fontWeight: '700' },
});

const vt = StyleSheet.create({
  wrap:         { flexDirection: 'row', backgroundColor: color.haze, borderRadius: radius.md, padding: 2 },
  btn:          { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  btnActive:    { backgroundColor: color.deep },
  btnText:      { ...t.small, color: color.mute, fontWeight: '600', fontSize: 11 },
  btnTextActive:{ color: '#fff' },
});

const dc = StyleSheet.create({
  scroll: { marginHorizontal: -space.lg, marginBottom: 4 },
  strip:  { paddingHorizontal: space.lg, gap: 6, paddingVertical: 4 },
  chip:   { borderRadius: 20, borderWidth: 1, borderColor: color.haze, backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 4 },
  chipActive:     { backgroundColor: color.deep, borderColor: color.deep },
  chipText:       { ...t.small, color: color.mute, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  dot:            { width: 5, height: 5, borderRadius: 3, backgroundColor: color.signal },
  dotActive:      { backgroundColor: '#fff' },
});

const cc = StyleSheet.create({
  scroll: { marginHorizontal: -space.lg, marginBottom: 8 },
  strip:  { paddingHorizontal: space.lg, gap: 6, paddingVertical: 2 },
  chip:   { borderRadius: 12, borderWidth: 1, borderColor: color.haze, backgroundColor: '#fff', paddingHorizontal: 10, paddingVertical: 3 },
  chipActive:     { backgroundColor: '#EEF4FF', borderColor: color.deep },
  chipText:       { ...t.small, color: color.mute, fontSize: 11 },
  chipTextActive: { color: color.deep, fontWeight: '600' },
});

const lk = StyleSheet.create({
  wrap:    { padding: space.lg, alignItems: 'center', gap: 8, paddingVertical: 36 },
  iconWrap:{ width: 48, height: 48, borderRadius: 24, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  title:   { ...t.title, fontSize: 16, color: color.ink },
  body:    { ...t.body, color: color.mute, textAlign: 'center', maxWidth: 260, lineHeight: 22 },
});
