import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet, findNodeHandle, Animated,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { Plus, Lock, Map as MapIcon, List, RotateCcw, AlertTriangle, Settings2, RefreshCw } from 'lucide-react-native';
import type { TripPlanItem, TripPlanCategory } from '../types/models';
import { fetchTripPlan, fetchTripPlanMap, type TripPlanResult } from '../services/tripPlan';
import { usePlanSync } from '../hooks/usePlanSync';
import { color, space, radius, type as t } from '../theme/tokens';
import { AddToPlanSheet } from './AddToPlanSheet';
import { TimelineView, type DayBucket } from './itinerary/TimelineView';
import { ItineraryMapView } from './itinerary/MapView';
import { PlanItemSheet } from './itinerary/PlanItemSheet';
import { TripPlanSettingsSheet } from './TripPlanSettingsSheet';

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

// ── Pending-invite view ────────────────────────────────────────────────────────

function PendingInviteView() {
  return (
    <View style={lk.wrap}>
      <View style={lk.iconWrap}><Lock size={22} color={color.signal} /></View>
      <Text style={lk.title}>Invite pending</Text>
      <Text style={lk.body}>Accept your trip invite to contribute to the plan.</Text>
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

// ── Background-sync merge ──────────────────────────────────────────────────────

// Cheap per-item equality: `updatedAt` changes on any server-side field edit,
// `sortOrder` covers reorders, and warnings are advisory and recomputed per fetch.
function planItemEqual(a: TripPlanItem, b: TripPlanItem): boolean {
  return (
    a.id === b.id &&
    a.updatedAt === b.updatedAt &&
    a.sortOrder === b.sortOrder &&
    a.dayDate === b.dayDate &&
    (a.warnings?.join('|') ?? '') === (b.warnings?.join('|') ?? '')
  );
}

/**
 * Merge a freshly-fetched plan into the current local list. The server response
 * is the source of truth for membership and order. Unchanged items keep their
 * previous object reference so React can skip re-rendering those rows. Returns
 * the same array reference when nothing changed so callers can no-op.
 */
function mergePlanItems(
  prev: TripPlanItem[],
  next: TripPlanItem[],
): { merged: TripPlanItem[]; changed: boolean } {
  const sameLength = prev.length === next.length;
  if (sameLength && prev.every((p, i) => p.id === next[i].id && planItemEqual(p, next[i]))) {
    return { merged: prev, changed: false };
  }
  const prevById = new Map(prev.map((p) => [p.id, p]));
  const merged = next.map((n) => {
    const existing = prevById.get(n.id);
    return existing && planItemEqual(existing, n) ? existing : n;
  });
  return { merged, changed: true };
}

// ── Main section ──────────────────────────────────────────────────────────────

export function TripPlanSection({
  tripId,
  currentUserId,
  isOwner,
  isPendingInvite,
  tripStartDate,
  tripEndDate,
  pageScrollRef,
}: {
  tripId: string;
  currentUserId: string;
  isOwner: boolean;
  isPendingInvite?: boolean;
  tripStartDate?: string | null;
  tripEndDate?: string | null;
  pageScrollRef?: React.RefObject<ScrollView | null>;
}) {
  const [items, setItems] = useState<TripPlanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [mapItems, setMapItems] = useState<TripPlanItem[]>([]);
  const [mapLoading, setMapLoading] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeDay, setActiveDay] = useState<string>('all');
  const [activeCat, setActiveCat] = useState<TripPlanCategory | 'all'>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [showWarningsOnly, setShowWarningsOnly] = useState(false);
  const [detailItem, setDetailItem] = useState<TripPlanItem | null>(null);
  const [detailStartInEditMode, setDetailStartInEditMode] = useState(false);

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
      const result = await fetchTripPlan(tripId);
      setItems(result.items);
      setCanEdit(result.canEdit);
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

  // ── Background auto-sync ──────────────────────────────────────────────────────
  // Keep a ref of the latest items so the poll callback merges against current
  // state without needing to be re-created (which would restart the interval).
  const itemsRef = useRef<TripPlanItem[]>(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // "Plan updated" toast — fades in when a remote change arrives, then auto-hides.
  const updatedAnim = useRef(new Animated.Value(0)).current;
  const updatedHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showUpdatedToast = useCallback(() => {
    if (updatedHideTimer.current) clearTimeout(updatedHideTimer.current);
    Animated.timing(updatedAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    updatedHideTimer.current = setTimeout(() => {
      Animated.timing(updatedAnim, { toValue: 0, duration: 240, useNativeDriver: true }).start();
    }, 2200);
  }, [updatedAnim]);
  useEffect(() => () => { if (updatedHideTimer.current) clearTimeout(updatedHideTimer.current); }, []);

  const applyServerResult = useCallback((result: TripPlanResult) => {
    setCanEdit(result.canEdit);
    const { merged, changed } = mergePlanItems(itemsRef.current, result.items);
    if (!changed) return;
    itemsRef.current = merged;
    setItems(merged);
    setMapItems([]);        // invalidate map cache so it refetches fresh coords
    showUpdatedToast();
  }, [showUpdatedToast]);

  usePlanSync(tripId, {
    enabled: !accessDenied,
    intervalMs: 10_000,
    onResult: applyServerResult,
  });

  // Auto-load map when entering map mode or when mapItems is cleared by a mutation
  useEffect(() => {
    if (viewMode === 'map' && mapItems.length === 0 && !mapLoading) {
      loadMap();
    }
  }, [viewMode, mapItems.length, mapLoading, loadMap]);

  const handleViewModeChange = useCallback((m: ViewMode) => {
    setViewMode(m);
    AsyncStorage.setItem(`tripPlanMode:${tripId}`, m).catch(() => {});
  }, [tripId]);

  const warnedItemRef = useRef<View>(null);

  const warnCount = items.filter((i) => i.warnings && i.warnings.length > 0).length;
  const firstWarnedId = items.find((i) => i.warnings && i.warnings.length > 0)?.id;

  // Auto-clear warnings filter if all warnings disappear (e.g. after an item edit or reload)
  useEffect(() => {
    if (warnCount === 0 && showWarningsOnly) setShowWarningsOnly(false);
  }, [warnCount, showWarningsOnly]);

  const handleNeedsAttention = useCallback(() => {
    const first = items.find((i) => i.warnings && i.warnings.length > 0);
    if (!first) return;
    setViewMode('timeline');
    setActiveDay(first.dayDate ?? '__unscheduled__');
    setActiveCat('all');
    // After React re-renders the timeline with filters applied, scroll to the exact item
    setTimeout(() => {
      if (!warnedItemRef.current || !pageScrollRef?.current) return;
      const nodeHandle = findNodeHandle(pageScrollRef.current);
      if (nodeHandle == null) return;
      warnedItemRef.current.measureLayout(
        nodeHandle,
        (_x, y) => { pageScrollRef.current?.scrollTo({ y: Math.max(0, y - 16), animated: true }); },
        () => {},
      );
    }, 120);
  }, [items, pageScrollRef]);

  const handleAdded = useCallback((item: TripPlanItem) => {
    setItems((prev) => [...prev, item]);
    setMapItems([]);   // invalidate map cache so it refetches on next map view
    setAddSheetOpen(false);
  }, []);

  const handleItemsChanged = useCallback(
    (updater: (prev: TripPlanItem[]) => TripPlanItem[]) => {
      setItems(updater);
      setMapItems([]);  // invalidate map cache
    },
    [],
  );

  const handleItemPress = useCallback((item: TripPlanItem) => {
    setDetailStartInEditMode(false);
    setDetailItem(item);
  }, []);

  const handleEditPress = useCallback((item: TripPlanItem) => {
    setDetailStartInEditMode(true);
    setDetailItem(item);
  }, []);

  // Apply day + category + warnings filters to items
  const filteredItems = items.filter((item) => {
    const dayOk = activeDay === 'all'
      ? true
      : activeDay === '__unscheduled__'
        ? !item.dayDate
        : item.dayDate === activeDay;
    const catOk = activeCat === 'all' || item.category === activeCat;
    const warnOk = !showWarningsOnly || (item.warnings && item.warnings.length > 0);
    return dayOk && catOk && warnOk;
  });

  // Build day buckets from ALL items (for the chip bar) and filtered items (for rendering)
  const allBuckets = buildBuckets(items, tripStartDate, tripEndDate);

  const visibleBuckets = (() => {
    if (activeDay === 'all' && activeCat === 'all' && !showWarningsOnly) return allBuckets;
    if (activeDay !== 'all') {
      // Single-day view: return exactly one bucket so no empty date-range days appear
      return [{ key: activeDay, items: filteredItems }];
    }
    // Category-only or warnings-only filter — keep full date range structure
    return buildBuckets(filteredItems, tripStartDate, tripEndDate);
  })();

  const hasContent = items.length > 0;

  return (
    <View style={ps.wrap}>
      {/* "Plan updated" toast — appears briefly when a teammate's change syncs in */}
      <Animated.View
        pointerEvents="none"
        style={[
          ps.updatedToast,
          {
            opacity: updatedAnim,
            transform: [{
              translateY: updatedAnim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }),
            }],
          },
        ]}
      >
        <RefreshCw size={11} color={color.onInk} />
        <Text style={ps.updatedToastText}>Plan updated</Text>
      </Animated.View>

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
            {isOwner && (
              <Pressable style={ps.settingsBtn} onPress={() => setSettingsOpen(true)} hitSlop={8}>
                <Settings2 size={15} color={color.mute} />
              </Pressable>
            )}
            {canEdit && (
              <Pressable style={ps.addBtn} onPress={() => setAddSheetOpen(true)}>
                <Plus size={15} color={color.onInk} />
                <Text style={ps.addBtnText}>Add</Text>
              </Pressable>
            )}
          </>
        )}
      </View>

      {/* Read-only notice for members without edit permission */}
      {!loading && !accessDenied && !canEdit && !isOwner && items.length > 0 && (
        <View style={ps.readOnlyBanner}>
          <Lock size={12} color={color.mute} />
          <Text style={ps.readOnlyText}>Only the organizer can edit this plan</Text>
        </View>
      )}

      {/* Warning summary banner */}
      {!loading && !accessDenied && warnCount > 0 && (
        <Pressable style={ps.warnBanner} onPress={handleNeedsAttention}>
          <AlertTriangle size={12} color="#8B5E00" />
          <Text style={ps.warnBannerText}>
            {warnCount} item{warnCount !== 1 ? 's' : ''} need{warnCount === 1 ? 's' : ''} attention
          </Text>
          <Text style={ps.warnBannerLink}>Jump to first →</Text>
        </Pressable>
      )}

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
          {warnCount > 0 && (
            <View style={wf.row}>
              <Pressable
                style={[wf.chip, showWarningsOnly && wf.chipActive]}
                onPress={() => setShowWarningsOnly((v) => !v)}
              >
                <AlertTriangle
                  size={11}
                  color={showWarningsOnly ? '#8B5E00' : color.mute}
                />
                <Text style={[wf.chipText, showWarningsOnly && wf.chipTextActive]}>
                  Warnings ({warnCount})
                </Text>
              </Pressable>
            </View>
          )}
        </>
      )}

      {loading && <ActivityIndicator color={color.signal} style={{ marginVertical: space.lg }} />}

      {!loading && accessDenied && (isPendingInvite ? <PendingInviteView /> : <PlanLockedView />)}

      {!loading && !accessDenied && items.length === 0 && (
        <View style={ps.empty}>
          <Text style={ps.emptyTitle}>No plans yet.</Text>
          <Text style={ps.emptyBody}>
            {canEdit
              ? 'Add places, meetups, or activities to build your day-by-day itinerary.'
              : 'The organizer hasn\'t added any items yet.'}
          </Text>
          {canEdit && (
            <Pressable style={ps.emptyBtn} onPress={() => setAddSheetOpen(true)}>
              <Text style={ps.emptyBtnText}>Add your first item</Text>
            </Pressable>
          )}
        </View>
      )}

      {!loading && !accessDenied && hasContent && viewMode === 'timeline' && (
        <TimelineView
          buckets={visibleBuckets}
          tripStartDate={tripStartDate}
          tripId={tripId}
          currentUserId={currentUserId}
          isOwner={isOwner}
          canEdit={canEdit}
          onItemPress={handleItemPress}
          onEditPress={handleEditPress}
          onItemsChanged={handleItemsChanged}
          firstWarnedId={firstWarnedId}
          warnedItemRef={warnedItemRef}
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
        canEdit={canEdit}
        startInEditMode={detailStartInEditMode}
        onClose={() => { setDetailItem(null); setDetailStartInEditMode(false); }}
        onUpdated={(updated) => {
          setItems((prev) => prev.map((i) => i.id === updated.id ? updated : i));
          setMapItems([]);  // invalidate map cache
          setDetailItem(updated);
          setDetailStartInEditMode(false);
        }}
        onRemoved={(id) => {
          setItems((prev) => prev.filter((i) => i.id !== id));
          setMapItems([]);  // invalidate map cache
          setDetailItem(null);
          setDetailStartInEditMode(false);
        }}
      />

      <AddToPlanSheet
        visible={addSheetOpen}
        tripId={tripId}
        onClose={() => setAddSheetOpen(false)}
        onAdded={handleAdded}
      />

      {/* Plan settings — owner only */}
      <TripPlanSettingsSheet
        visible={settingsOpen}
        tripId={tripId}
        onClose={() => setSettingsOpen(false)}
        onSaved={load}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const ps = StyleSheet.create({
  wrap:           { marginTop: space.lg },
  head:           { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, marginBottom: space.sm, gap: 8 },
  title:          { ...t.title, color: color.ink, fontSize: 20 },
  refreshBtn:     { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  settingsBtn:    { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  addBtn:         { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.deep, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 6 },
  addBtnText:     { ...t.small, color: color.onInk, fontWeight: '700' },
  readOnlyBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: space.lg, marginBottom: space.sm, paddingHorizontal: space.md, paddingVertical: 8, backgroundColor: color.haze, borderRadius: radius.md },
  readOnlyText:   { ...t.small, color: color.mute, flex: 1 },
  warnBanner:     { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: space.lg, marginBottom: space.sm, backgroundColor: '#FFFBEB', borderRadius: radius.md, borderWidth: 1, borderColor: '#F5D77B', paddingHorizontal: space.md, paddingVertical: 8 },
  warnBannerText: { ...t.small, color: '#8B5E00', fontWeight: '600' as const, flex: 1 },
  warnBannerLink: { ...t.small, color: '#F59E0B', fontWeight: '700' as const },
  updatedToast:     { position: 'absolute', top: -4, alignSelf: 'center', zIndex: 50, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.deep, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  updatedToastText: { ...t.small, color: color.onInk, fontWeight: '700' },
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

const wf = StyleSheet.create({
  row:          { paddingHorizontal: space.lg, marginBottom: 8, flexDirection: 'row' },
  chip:         { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 12, borderWidth: 1, borderColor: '#F5D77B', backgroundColor: '#FFFBEB', paddingHorizontal: 10, paddingVertical: 4 },
  chipActive:   { backgroundColor: '#F59E0B', borderColor: '#D97706' },
  chipText:     { ...t.small, color: '#8B5E00', fontWeight: '600' as const, fontSize: 11 },
  chipTextActive: { color: '#fff' },
});
