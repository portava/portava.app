import React, { useState, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, Modal, Alert, Animated, PanResponder,
} from 'react-native';
import {
  MapPin, Clock, MoreHorizontal, CheckCircle2, Pencil, Trash2, AlertTriangle, Tag, GripVertical,
} from 'lucide-react-native';
import type { TripPlanItem, TripPlanCategory, TripPlanItemStatus } from '../../types/models';
import { removePlanItem, updatePlanItem, reorderPlanItem } from '../../services/tripPlan';
import { color, space, radius, type as t } from '../../theme/tokens';

// ── Category / status maps ─────────────────────────────────────────────────────

export const CAT_STYLE: Record<TripPlanCategory, { bg: string; fg: string; label: string }> = {
  accommodation: { bg: '#E2EDF0', fg: color.deep,    label: 'Stay' },
  activity:      { bg: '#E3F1EA', fg: color.success, label: 'Activity' },
  dining:        { bg: '#FCE9E4', fg: color.signal,  label: 'Dining' },
  transport:     { bg: '#EFE7FA', fg: '#7A4DBF',     label: 'Transport' },
  free_time:     { bg: '#F5F0E8', fg: '#8B6914',     label: 'Free time' },
  meeting_point: { bg: '#FFF0D0', fg: '#B07000',     label: 'Meetup' },
  other:         { bg: color.haze, fg: color.mute,  label: 'Other' },
};

export const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  confirmed: { bg: '#E3F1EA', fg: color.success },
  tentative: { bg: '#F5F0E8', fg: '#8B6914' },
  done:      { bg: color.haze, fg: color.mute },
  cancelled: { bg: '#FCE9E4', fg: '#B0291A' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function fmtTime(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(key: string, tripStartDate: string | null | undefined): string {
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
      if (dayNum >= 1) return `Day ${dayNum} — ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    }
  }
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Day bucket type ───────────────────────────────────────────────────────────

export interface DayBucket { key: string; items: TripPlanItem[] }

// ── Warning badge strip ───────────────────────────────────────────────────────

const WARN_SHORT: Record<string, string> = {
  time_overlap:       '⚡ Conflict',
  duplicate:          '🔁 Duplicate',
  outside_trip_dates: '📅 Off-schedule',
  missing_location:   '📍 No location',
  cancelled_source:   '🚫 Cancelled',
};

function WarningBadges({ warnings }: { warnings: string[] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <View style={wb.row}>
      {warnings.map((w) => (
        <View key={w} style={wb.badge}>
          <AlertTriangle size={9} color="#B07000" />
          <Text style={wb.text}>{WARN_SHORT[w] ?? w}</Text>
        </View>
      ))}
    </View>
  );
}

// ── Item card ─────────────────────────────────────────────────────────────────

interface PlanItemCardProps {
  item: TripPlanItem;
  currentUserId: string;
  isOwner: boolean;
  canEdit: boolean;
  tripId: string;
  onPress: (item: TripPlanItem) => void;
  onEditPress: (item: TripPlanItem) => void;
  onRemove: (id: string) => void;
  onMarkDone: (id: string) => void;
  onMarkTentative: (id: string) => void;
  onEdited: (updated: TripPlanItem) => void;
  onMoveToUnscheduled: (id: string) => void;
  dragHandlers?: object;
  isDragging?: boolean;
}

function PlanItemCard({
  item, currentUserId, isOwner, canEdit, tripId,
  onPress, onEditPress, onRemove, onMarkDone, onMarkTentative, onEdited, onMoveToUnscheduled,
  dragHandlers, isDragging,
}: PlanItemCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const cat = CAT_STYLE[item.category] ?? CAT_STYLE.other;
  const statusStyle = STATUS_STYLE[item.status] ?? STATUS_STYLE.tentative;
  const canAct = canEdit && (isOwner || item.creatorId === currentUserId);
  const timeStr = fmtTime(item.startsAt);
  const hasWarnings = item.warnings && item.warnings.length > 0;

  return (
    <>
      <View style={[ic.row, isDragging && ic.rowDragging]}>
        {canEdit && dragHandlers && (
          <View style={ic.handle} {...dragHandlers}>
            <GripVertical size={18} color={isDragging ? color.deep : color.faint} />
          </View>
        )}

        <Pressable
          style={[ic.card, hasWarnings && ic.cardWarn, { flex: 1 }]}
          onPress={() => onPress(item)}
        >
          <View style={ic.top}>
            <View style={[ic.catBadge, { backgroundColor: cat.bg }]}>
              <Text style={[ic.catText, { color: cat.fg }]}>{cat.label}</Text>
            </View>
            {item.sourceType !== 'manual' && (
              <View style={ic.sourceBadge}>
                <Tag size={9} color={color.mute} />
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

          <Text style={[ic.title, item.status === 'done' && ic.titleDone]} numberOfLines={2}>
            {item.title}
          </Text>

          <WarningBadges warnings={item.warnings ?? []} />

          {(timeStr || item.locationName) && (
            <View style={ic.metaRow}>
              {timeStr && (
                <View style={ic.metaItem}>
                  <Clock size={11} color={color.mute} />
                  <Text style={ic.metaText}>{timeStr}</Text>
                </View>
              )}
              {item.locationName ? (
                <View style={ic.metaItem}>
                  <MapPin size={11} color={color.mute} />
                  <Text style={ic.metaText} numberOfLines={1}>{item.locationName}</Text>
                </View>
              ) : (item.category === 'accommodation' || item.category === 'meeting_point') ? (
                <View style={[ic.metaItem, ic.locationHidden]}>
                  <MapPin size={11} color="#8B6914" />
                  <Text style={ic.locationHiddenText}>Location TBD</Text>
                </View>
              ) : null}
            </View>
          )}
        </Pressable>
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={ic.menuOverlay} onPress={() => setMenuOpen(false)}>
          <View style={ic.menuSheet}>
            <Text style={ic.menuTitle} numberOfLines={1}>{item.title}</Text>

            <Pressable style={ic.menuItem} onPress={() => { setMenuOpen(false); onPress(item); }}>
              <Tag size={16} color={color.deep} />
              <Text style={ic.menuItemText}>View details</Text>
            </Pressable>

            {canAct && (
              <>
                <Pressable style={ic.menuItem} onPress={() => { setMenuOpen(false); onEditPress(item); }}>
                  <Pencil size={16} color={color.deep} />
                  <Text style={ic.menuItemText}>Edit / Reschedule</Text>
                </Pressable>

                {item.dayDate && (
                  <Pressable style={ic.menuItem} onPress={() => { setMenuOpen(false); onMoveToUnscheduled(item.id); }}>
                    <Clock size={16} color={color.mute} />
                    <Text style={ic.menuItemText}>Move to unscheduled</Text>
                  </Pressable>
                )}

                {item.status !== 'done' && (
                  <Pressable style={ic.menuItem} onPress={() => { setMenuOpen(false); onMarkDone(item.id); }}>
                    <CheckCircle2 size={16} color={color.success} />
                    <Text style={ic.menuItemText}>Mark as done</Text>
                  </Pressable>
                )}
                {item.status !== 'tentative' && (
                  <Pressable style={ic.menuItem} onPress={() => { setMenuOpen(false); onMarkTentative(item.id); }}>
                    <Clock size={16} color={color.mute} />
                    <Text style={ic.menuItemText}>Mark as tentative</Text>
                  </Pressable>
                )}

                <Pressable style={ic.menuItem} onPress={() => { setMenuOpen(false); onRemove(item.id); }}>
                  <Trash2 size={16} color={color.signal} />
                  <Text style={[ic.menuItemText, { color: color.signal }]}>Remove from plan</Text>
                </Pressable>
              </>
            )}

            <Pressable style={ic.menuCancel} onPress={() => setMenuOpen(false)}>
              <Text style={ic.menuCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

// ── Draggable item list ───────────────────────────────────────────────────────

interface DraggableItemListProps {
  items: TripPlanItem[];
  tripId: string;
  currentUserId: string;
  isOwner: boolean;
  canEdit: boolean;
  onItemPress: (item: TripPlanItem) => void;
  onEditPress: (item: TripPlanItem) => void;
  onItemsChanged: (updater: (prev: TripPlanItem[]) => TripPlanItem[]) => void;
  onRemove: (id: string) => void;
  onMarkDone: (id: string) => void;
  onMarkTentative: (id: string) => void;
  onMoveToUnscheduled: (id: string) => void;
  firstWarnedId?: string;
  warnedItemRef?: React.RefObject<View | null>;
}

function DraggableItemList({
  items, tripId, currentUserId, isOwner, canEdit,
  onItemPress, onEditPress, onItemsChanged,
  onRemove, onMarkDone, onMarkTentative, onMoveToUnscheduled,
  firstWarnedId, warnedItemRef,
}: DraggableItemListProps) {
  // Local display order (IDs); actual item data comes from `items` prop.
  const [order, setOrder] = useState<string[]>(() => items.map((i) => i.id));
  const itemMap = useMemo(() => Object.fromEntries(items.map((i) => [i.id, i])), [items]);

  // Sync order when items prop changes (add / remove)
  const prevItemsRef = useRef(items);
  if (prevItemsRef.current !== items) {
    prevItemsRef.current = items;
    const incoming = items.map((i) => i.id);
    // keep existing order, append new, drop removed
    const kept = order.filter((id) => incoming.includes(id));
    const added = incoming.filter((id) => !kept.includes(id));
    const synced = [...kept, ...added];
    if (synced.join(',') !== order.join(',')) {
      setOrder(synced);
    }
  }

  // Drag state (refs for gesture tracking, state for re-render triggers)
  const activeIdxRef = useRef(-1);
  const activeAnim = useRef(new Animated.Value(0)).current;
  const [, forceUpdate] = useState(0);
  const currentDragIdx = useRef(-1); // tracks current visual swap position
  const itemHeightsRef = useRef<Record<string, number>>({});

  const getEstimatedHeight = useCallback((id: string) => {
    return itemHeightsRef.current[id] ?? 100;
  }, []);

  const commitReorder = useCallback(async (
    oldOrder: string[],
    newOrder: string[],
  ) => {
    if (oldOrder.join(',') === newOrder.join(',')) return;
    // Assign sort_order = index * 1000 for items whose position changed
    const changed = newOrder
      .map((id, idx) => ({ id, sortOrder: (idx + 1) * 1000 }))
      .filter(({ id, sortOrder }) => {
        const oldIdx = oldOrder.indexOf(id);
        return oldIdx !== newOrder.indexOf(id) || sortOrder !== (oldIdx + 1) * 1000;
      });
    await Promise.all(
      changed.map(({ id, sortOrder }) =>
        reorderPlanItem(tripId, id, sortOrder).catch(() => {
          // silent: UI already reflects order; API failure is non-blocking
        }),
      ),
    );
    // Notify parent so the canonical list stays in sync
    onItemsChanged((prev) => {
      const byId = Object.fromEntries(prev.map((i) => [i.id, i]));
      return newOrder.map((id, idx) => ({ ...(byId[id] ?? itemMap[id]), sortOrder: (idx + 1) * 1000 }));
    });
  }, [tripId, itemMap, onItemsChanged]);

  // Build one PanResponder per slot; recreate when order changes so index is correct.
  const panResponders = useMemo(() => {
    if (!canEdit) return [];
    return order.map((_, slotIdx) =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
        onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dy) > 4,
        onPanResponderGrant: () => {
          activeIdxRef.current = slotIdx;
          currentDragIdx.current = slotIdx;
          activeAnim.setValue(0);
          forceUpdate((n) => n + 1);
        },
        onPanResponderMove: (_, g) => {
          activeAnim.setValue(g.dy);
          // Compute which slot the card has drifted into
          let accumulated = 0;
          let newSlot = slotIdx;
          if (g.dy > 0) {
            for (let k = slotIdx + 1; k < order.length; k++) {
              accumulated += getEstimatedHeight(order[k]);
              if (g.dy < accumulated - getEstimatedHeight(order[k]) / 2) break;
              newSlot = k;
            }
          } else {
            for (let k = slotIdx - 1; k >= 0; k--) {
              accumulated -= getEstimatedHeight(order[k]);
              if (g.dy > accumulated + getEstimatedHeight(order[k]) / 2) break;
              newSlot = k;
            }
          }
          if (newSlot !== currentDragIdx.current) {
            currentDragIdx.current = newSlot;
            forceUpdate((n) => n + 1);
          }
        },
        onPanResponderRelease: () => {
          const from = activeIdxRef.current;
          const to = currentDragIdx.current;
          activeIdxRef.current = -1;
          currentDragIdx.current = -1;
          Animated.timing(activeAnim, {
            toValue: 0, duration: 120, useNativeDriver: true,
          }).start(() => forceUpdate((n) => n + 1));
          if (from !== to && from >= 0 && to >= 0) {
            setOrder((prev) => {
              const next = [...prev];
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              commitReorder(prev, next);
              return next;
            });
          } else {
            forceUpdate((n) => n + 1);
          }
        },
        onPanResponderTerminate: () => {
          activeIdxRef.current = -1;
          currentDragIdx.current = -1;
          activeAnim.setValue(0);
          forceUpdate((n) => n + 1);
        },
      }),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, canEdit]);

  // Build the visual render list.
  // While dragging to a different slot we:
  //   • Show the dragged card lifted (translateY) and dimmed at its origin slot
  //   • Insert a dashed placeholder at the current target slot so users can see the drop position
  //   • Other items naturally shift to make room for the placeholder
  const activeIdx = activeIdxRef.current;
  const targetIdx = currentDragIdx.current;
  const isDragging = activeIdx >= 0 && activeIdx < order.length;
  const showPlaceholder = isDragging && targetIdx !== activeIdx && targetIdx >= 0;

  type RenderEntry =
    | { kind: 'item'; id: string; slotIdx: number }
    | { kind: 'placeholder'; height: number };

  const renderEntries: RenderEntry[] = [];
  if (!showPlaceholder) {
    order.forEach((id, slotIdx) => renderEntries.push({ kind: 'item', id, slotIdx }));
  } else {
    const draggedHeight = getEstimatedHeight(order[activeIdx]);
    const placeholderBeforeDragged = targetIdx < activeIdx;
    order.forEach((id, slotIdx) => {
      // Insert placeholder before this item when target is above the dragged slot
      if (slotIdx === targetIdx && placeholderBeforeDragged) {
        renderEntries.push({ kind: 'placeholder', height: draggedHeight });
      }
      renderEntries.push({ kind: 'item', id, slotIdx });
      // Insert placeholder after this item when target is below the dragged slot
      if (slotIdx === targetIdx && !placeholderBeforeDragged) {
        renderEntries.push({ kind: 'placeholder', height: draggedHeight });
      }
    });
  }

  return (
    <>
      {renderEntries.map((entry) => {
        if (entry.kind === 'placeholder') {
          return (
            <View key="__drag_placeholder__" style={[dl.placeholder, { height: entry.height }]} />
          );
        }

        const { id, slotIdx } = entry;
        const item = itemMap[id];
        if (!item) return null;
        const isActive = activeIdx === slotIdx;
        const pr = panResponders[slotIdx];
        const card = (
          <PlanItemCard
            item={item}
            currentUserId={currentUserId}
            isOwner={isOwner}
            canEdit={canEdit}
            tripId={tripId}
            onPress={onItemPress}
            onEditPress={onEditPress}
            onRemove={onRemove}
            onMarkDone={onMarkDone}
            onMarkTentative={onMarkTentative}
            onEdited={(updated) => onItemsChanged((prev) => prev.map((i) => i.id === updated.id ? updated : i))}
            onMoveToUnscheduled={onMoveToUnscheduled}
            dragHandlers={pr?.panHandlers}
            isDragging={isActive}
          />
        );
        return (
          <Animated.View
            key={id}
            style={isActive
              ? { transform: [{ translateY: activeAnim }], zIndex: 10, opacity: showPlaceholder ? 0.55 : 0.85 }
              : undefined
            }
            onLayout={(e) => {
              itemHeightsRef.current[id] = e.nativeEvent.layout.height;
            }}
          >
            {id === firstWarnedId && warnedItemRef
              ? <View ref={warnedItemRef}>{card}</View>
              : card
            }
          </Animated.View>
        );
      })}
    </>
  );
}

// ── Day group ─────────────────────────────────────────────────────────────────

function DayGroup({
  bucket, tripStartDate, tripId, currentUserId, isOwner, canEdit,
  onItemPress, onEditPress, onItemsChanged, firstWarnedId, warnedItemRef,
}: {
  bucket: DayBucket;
  tripStartDate?: string | null;
  tripId: string;
  currentUserId: string;
  isOwner: boolean;
  canEdit: boolean;
  onItemPress: (item: TripPlanItem) => void;
  onEditPress: (item: TripPlanItem) => void;
  onItemsChanged: (updater: (prev: TripPlanItem[]) => TripPlanItem[]) => void;
  firstWarnedId?: string;
  warnedItemRef?: React.RefObject<View | null>;
}) {
  const label = dayLabel(bucket.key, tripStartDate);
  const isUnscheduled = bucket.key === '__unscheduled__';

  const handleRemove = (itemId: string) => {
    Alert.alert('Remove item', 'Remove this item from the trip plan?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          try {
            await removePlanItem(tripId, itemId);
            onItemsChanged((prev) => prev.filter((i) => i.id !== itemId));
          } catch {
            Alert.alert('Error', 'Could not remove item. Please try again.');
          }
        },
      },
    ]);
  };

  const handleMarkDone = async (itemId: string) => {
    try {
      const updated = await updatePlanItem(tripId, itemId, { status: 'done' });
      onItemsChanged((prev) => prev.map((i) => i.id === itemId ? updated : i));
    } catch {
      Alert.alert('Error', 'Could not update item.');
    }
  };

  const handleMarkTentative = async (itemId: string) => {
    try {
      const updated = await updatePlanItem(tripId, itemId, { status: 'tentative' });
      onItemsChanged((prev) => prev.map((i) => i.id === itemId ? updated : i));
    } catch {
      Alert.alert('Error', 'Could not update item.');
    }
  };

  const handleMoveToUnscheduled = async (itemId: string) => {
    try {
      const updated = await updatePlanItem(tripId, itemId, { dayDate: null, startsAt: null, endsAt: null });
      onItemsChanged((prev) => prev.map((i) => i.id === itemId ? updated : i));
    } catch {
      Alert.alert('Error', 'Could not update item.');
    }
  };

  return (
    <View style={dg.group}>
      <View style={[dg.header, isUnscheduled && dg.headerUnscheduled]}>
        <View style={[dg.dot, isUnscheduled && dg.dotUnscheduled]} />
        <Text style={[dg.label, isUnscheduled && dg.labelUnscheduled]}>{label}</Text>
        <View style={dg.line} />
        <Text style={dg.count}>{bucket.items.length}</Text>
      </View>

      {bucket.items.length === 0 ? (
        <Text style={dg.emptyDay}>Nothing planned yet.</Text>
      ) : (
        <DraggableItemList
          items={bucket.items}
          tripId={tripId}
          currentUserId={currentUserId}
          isOwner={isOwner}
          canEdit={canEdit}
          onItemPress={onItemPress}
          onEditPress={onEditPress}
          onItemsChanged={onItemsChanged}
          onRemove={handleRemove}
          onMarkDone={handleMarkDone}
          onMarkTentative={handleMarkTentative}
          onMoveToUnscheduled={handleMoveToUnscheduled}
          firstWarnedId={firstWarnedId}
          warnedItemRef={warnedItemRef}
        />
      )}
    </View>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface TimelineViewProps {
  buckets: DayBucket[];
  tripStartDate?: string | null;
  tripId: string;
  currentUserId: string;
  isOwner: boolean;
  canEdit: boolean;
  onItemPress: (item: TripPlanItem) => void;
  onEditPress: (item: TripPlanItem) => void;
  onItemsChanged: (updater: (prev: TripPlanItem[]) => TripPlanItem[]) => void;
  firstWarnedId?: string;
  warnedItemRef?: React.RefObject<View | null>;
}

export function TimelineView({
  buckets, tripStartDate, tripId, currentUserId, isOwner, canEdit, onItemPress, onEditPress, onItemsChanged,
  firstWarnedId, warnedItemRef,
}: TimelineViewProps) {
  if (buckets.length === 0 || buckets.every((b) => b.items.length === 0)) {
    return (
      <View style={tv.empty}>
        <Text style={tv.emptyTitle}>No items for this filter.</Text>
      </View>
    );
  }

  return (
    <View style={tv.wrap}>
      {buckets.map((bucket) => (
        <DayGroup
          key={bucket.key}
          bucket={bucket}
          tripStartDate={tripStartDate}
          tripId={tripId}
          currentUserId={currentUserId}
          isOwner={isOwner}
          canEdit={canEdit}
          onItemPress={onItemPress}
          onEditPress={onEditPress}
          onItemsChanged={onItemsChanged}
          firstWarnedId={firstWarnedId}
          warnedItemRef={warnedItemRef}
        />
      ))}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const wb = StyleSheet.create({
  row:   { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#FFF3CD', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  text:  { fontSize: 10, color: '#8B6914', fontWeight: '600' },
});

const ic = StyleSheet.create({
  row:         { flexDirection: 'row', alignItems: 'stretch', marginBottom: 8 },
  rowDragging: { opacity: 0.85 },
  handle:      { width: 28, justifyContent: 'center', alignItems: 'center', paddingRight: 2 },
  card:        { backgroundColor: '#fff', borderRadius: radius.lg, padding: 12, borderWidth: 1, borderColor: color.haze, gap: 4 },
  cardWarn:    { borderLeftWidth: 4, borderLeftColor: '#F59E0B', borderColor: '#F5D77B' },
  top:         { flexDirection: 'row', alignItems: 'center', gap: 4 },
  catBadge:    { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  catText:     { fontSize: 10, fontWeight: '700' },
  sourceBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: color.haze, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 },
  sourceText:  { fontSize: 10, color: color.mute, fontWeight: '600' },
  statusBadge: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  statusText:  { fontSize: 10, fontWeight: '700' },
  moreBtn:     { padding: 2 },
  title:       { ...t.body, color: color.ink, fontWeight: '600', lineHeight: 20 },
  titleDone:   { textDecorationLine: 'line-through', color: color.mute },
  metaRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 2 },
  metaItem:         { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText:         { ...t.small, color: color.mute },
  locationHidden:   { backgroundColor: '#FFF8E7', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2 },
  locationHiddenText: { ...t.small, color: '#8B6914', fontWeight: '500' },
  menuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  menuSheet:   { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: space.lg, paddingBottom: 36, gap: 4 },
  menuTitle:   { ...t.small, color: color.mute, fontWeight: '600', marginBottom: 8 },
  menuItem:    { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: color.haze },
  menuItemText:{ ...t.body, color: color.ink },
  menuCancel:  { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  menuCancelText:{ ...t.body, color: color.mute, fontWeight: '600' },
});

const dg = StyleSheet.create({
  group:            { marginBottom: 16 },
  header:           { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  headerUnscheduled:{ opacity: 0.65 },
  dot:              { width: 10, height: 10, borderRadius: 5, backgroundColor: color.deep },
  dotUnscheduled:   { backgroundColor: color.faint },
  label:            { ...t.small, color: color.ink, fontWeight: '700', fontSize: 13 },
  labelUnscheduled: { color: color.mute, fontStyle: 'italic' },
  line:             { flex: 1, height: 1, backgroundColor: color.haze },
  count:            { ...t.small, color: color.faint },
  emptyDay:         { ...t.small, color: color.faint, paddingLeft: 18, paddingBottom: 4 },
});

const dl = StyleSheet.create({
  placeholder: {
    marginBottom: 8,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: color.deep,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(30, 90, 120, 0.06)',
  },
});

const tv = StyleSheet.create({
  wrap:       { gap: 0 },
  empty:      { paddingVertical: 24, alignItems: 'center' },
  emptyTitle: { ...t.small, color: color.faint },
});
