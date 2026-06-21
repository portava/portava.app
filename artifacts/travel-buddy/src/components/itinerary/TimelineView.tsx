import React, { useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Modal, Alert,
} from 'react-native';
import {
  MapPin, Clock, MoreHorizontal, CheckCircle2, Pencil, Trash2, AlertTriangle, Tag,
} from 'lucide-react-native';
import type { TripPlanItem, TripPlanCategory, TripPlanItemStatus } from '../../types/models';
import { removePlanItem, updatePlanItem } from '../../services/tripPlan';
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
  tripId: string;
  onPress: (item: TripPlanItem) => void;
  /** Called when the user taps "Edit / Reschedule" — opens the detail sheet directly in edit mode. */
  onEditPress: (item: TripPlanItem) => void;
  onRemove: (id: string) => void;
  onMarkDone: (id: string) => void;
  onMarkTentative: (id: string) => void;
  onEdited: (updated: TripPlanItem) => void;
  onMoveToUnscheduled: (id: string) => void;
}

function PlanItemCard({
  item, currentUserId, isOwner, tripId,
  onPress, onEditPress, onRemove, onMarkDone, onMarkTentative, onEdited, onMoveToUnscheduled,
}: PlanItemCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const cat = CAT_STYLE[item.category] ?? CAT_STYLE.other;
  const statusStyle = STATUS_STYLE[item.status] ?? STATUS_STYLE.tentative;
  const canAct = isOwner || item.creatorId === currentUserId;
  const timeStr = fmtTime(item.startsAt);
  const hasWarnings = item.warnings && item.warnings.length > 0;

  return (
    <>
      <Pressable style={[ic.card, hasWarnings && ic.cardWarn]} onPress={() => onPress(item)}>
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
            {item.locationName && (
              <View style={ic.metaItem}>
                <MapPin size={11} color={color.mute} />
                <Text style={ic.metaText} numberOfLines={1}>{item.locationName}</Text>
              </View>
            )}
          </View>
        )}
      </Pressable>

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

// ── Day group ─────────────────────────────────────────────────────────────────

function DayGroup({
  bucket, tripStartDate, tripId, currentUserId, isOwner,
  onItemPress, onEditPress, onItemsChanged,
}: {
  bucket: DayBucket;
  tripStartDate?: string | null;
  tripId: string;
  currentUserId: string;
  isOwner: boolean;
  onItemPress: (item: TripPlanItem) => void;
  onEditPress: (item: TripPlanItem) => void;
  onItemsChanged: (updater: (prev: TripPlanItem[]) => TripPlanItem[]) => void;
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
      ) : bucket.items.map((item) => (
        <PlanItemCard
          key={item.id}
          item={item}
          currentUserId={currentUserId}
          isOwner={isOwner}
          tripId={tripId}
          onPress={onItemPress}
          onEditPress={onEditPress}
          onRemove={handleRemove}
          onMarkDone={handleMarkDone}
          onMarkTentative={handleMarkTentative}
          onEdited={(updated) => onItemsChanged((prev) => prev.map((i) => i.id === updated.id ? updated : i))}
          onMoveToUnscheduled={handleMoveToUnscheduled}
        />
      ))}
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
  onItemPress: (item: TripPlanItem) => void;
  /** Called when "Edit / Reschedule" is selected from the context menu — opens in edit mode directly. */
  onEditPress: (item: TripPlanItem) => void;
  onItemsChanged: (updater: (prev: TripPlanItem[]) => TripPlanItem[]) => void;
}

export function TimelineView({
  buckets, tripStartDate, tripId, currentUserId, isOwner, onItemPress, onEditPress, onItemsChanged,
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
          onItemPress={onItemPress}
          onEditPress={onEditPress}
          onItemsChanged={onItemsChanged}
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
  card:        { backgroundColor: '#fff', borderRadius: radius.lg, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: color.haze, gap: 4 },
  cardWarn:    { borderColor: '#F5D77B', borderWidth: 1.5 },
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
  metaItem:    { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText:    { ...t.small, color: color.mute },
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

const tv = StyleSheet.create({
  wrap:       { gap: 0 },
  empty:      { paddingVertical: 24, alignItems: 'center' },
  emptyTitle: { ...t.small, color: color.faint },
});
