/**
 * DestinationListEditor — multi-city destination list editor for trip create/edit.
 *
 * In CREATE mode (no tripId): accumulates destinations locally; caller reads
 * the `destinations` prop via the onChange callback and persists after trip creation.
 *
 * In EDIT mode (tripId provided): each add calls POST /api/trips/:id/destinations
 * immediately; reorder calls POST /api/trips/:id/destinations/reorder immediately;
 * remove hides the row instantly then fires DELETE in the background (optimistic);
 * date changes call PATCH /api/trips/:id/destinations/:destId immediately.
 *
 * Reordering supports two methods:
 *   • Drag handle (≡) — long-press and drag to new position (primary UX).
 *   • Up/Down arrows — accessible fallback for keyboard/switch users.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { MapPin, Plus, Trash2, ChevronUp, ChevronDown, GripVertical } from 'lucide-react-native';
import DraggableFlatList, {
  ScaleDecorator,
  type RenderItemParams,
} from 'react-native-draggable-flatlist';
import { GlobalPlacePicker } from '../selectors/GlobalPlacePicker.tsx';
import { GlobalCalendarPicker } from '../selectors/GlobalCalendarPicker.tsx';
import { CalendarDays, X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { formatDisplayDate, fromISODate } from '../../lib/dateTime/formatters.ts';
import type { Place } from '../../lib/location/placeTypes.ts';
import { addDestination, reorderDestinations, deleteDestination, patchDestination } from '../../services/tripDestinations.ts';

export interface DestinationEntry {
  /** Local unique key — stable across re-renders. */
  key: string;
  /** Server ID, set once the row is persisted. */
  id?: string;
  city: string;
  country?: string | null;
  lat?: number | null;
  lng?: number | null;
  placeId?: string | null;
  arrivalDate?: string | null;
  departureDate?: string | null;
  /** Local-only flag: hidden from the list but kept so indices stay stable. */
  removed?: boolean;
}

interface Props {
  /** When provided the editor makes live API calls (edit mode). */
  tripId?: string;
  destinations: DestinationEntry[];
  onChange: (destinations: DestinationEntry[]) => void;
}

function makeKey(): string {
  return `dest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function DestinationListEditor({ tripId, destinations, onChange }: Props) {
  // Which row's place picker is open (null = none) — tracked by key, not index,
  // so it survives a drag-reorder without pointing at the wrong row.
  const [placePickerKey, setPlacePickerKey] = useState<string | null>(null);
  // Which row's calendar picker is open (null = none)
  const [calPickerKey, setCalPickerKey] = useState<string | null>(null);
  // Per-row busy state for API calls (add / date-patch; remove is optimistic)
  const [busyRows, setBusyRows] = useState<Record<string, boolean>>({});

  const visible = destinations.filter((d) => !d.removed);

  const setBusyRow = (key: string, busy: boolean) => {
    setBusyRows((prev) => ({ ...prev, [key]: busy }));
  };

  // ── Add a blank row ──────────────────────────────────────────────────────
  const handleAdd = useCallback(() => {
    const newEntry: DestinationEntry = { key: makeKey(), city: '' };
    onChange([...destinations, newEntry]);
    setPlacePickerKey(newEntry.key);
  }, [destinations, onChange]);

  // ── Remove a row (optimistic) ────────────────────────────────────────────
  const handleRemove = useCallback((key: string) => {
    const entry = destinations.find((d) => d.key === key);
    if (!entry) return;

    // Hide instantly for immediate feedback.
    onChange(destinations.map((d) => d.key === key ? { ...d, removed: true } : d));

    // In edit mode: fire DELETE in the background; best-effort (no rollback —
    // a refresh will re-surface the row if the call failed).
    if (tripId && entry.id) {
      deleteDestination(tripId, entry.id).catch(() => {});
    }
  }, [destinations, onChange, tripId]);

  // ── Place selected for a row ─────────────────────────────────────────────
  const handlePlaceSelect = useCallback(async (entryKey: string, place: Place) => {
    const entry = destinations.find((d) => d.key === entryKey);
    if (!entry) return;

    const visibleIdx = visible.findIndex((d) => d.key === entryKey);

    const updated: DestinationEntry = {
      ...entry,
      city: place.city ?? place.name,
      country: place.country ?? null,
      lat: place.lat ?? null,
      lng: place.lng ?? null,
      placeId: place.id ?? null,
    };

    if (tripId && !entry.id) {
      setBusyRow(entry.key, true);
      try {
        const saved = await addDestination(tripId, {
          city: updated.city,
          country: updated.country,
          lat: updated.lat,
          lng: updated.lng,
          placeId: updated.placeId,
          arrivalDate: updated.arrivalDate,
          departureDate: updated.departureDate,
          position: visibleIdx + 1,
        });
        if (saved) updated.id = saved.id;
      } finally {
        setBusyRow(entry.key, false);
      }
    }

    onChange(destinations.map((d) => d.key === entryKey ? updated : d));
    setPlacePickerKey(null);
  }, [destinations, visible, onChange, tripId]);

  // ── Date change for a row ────────────────────────────────────────────────
  const handleDateChange = useCallback(async (key: string, start: string | null, end: string | null) => {
    const entry = destinations.find((d) => d.key === key);
    if (!entry) return;

    // In edit mode with a persisted server row: PATCH immediately.
    if (tripId && entry.id) {
      setBusyRow(key, true);
      try {
        await patchDestination(tripId, entry.id, { arrivalDate: start, departureDate: end });
      } finally {
        setBusyRow(key, false);
      }
    }

    onChange(destinations.map((d) => d.key === key ? { ...d, arrivalDate: start, departureDate: end } : d));
    setCalPickerKey(null);
  }, [destinations, onChange, tripId]);

  // ── Reorder: arrow buttons (accessible fallback) ─────────────────────────
  const handleMove = useCallback(async (visibleIdx: number, direction: 'up' | 'down') => {
    const vis = visible;
    const targetIdx = direction === 'up' ? visibleIdx - 1 : visibleIdx + 1;
    if (targetIdx < 0 || targetIdx >= vis.length) return;

    const newVis = [...vis];
    const tmp = newVis[visibleIdx];
    newVis[visibleIdx] = newVis[targetIdx];
    newVis[targetIdx] = tmp;

    let visPtr = 0;
    const newFull = destinations.map((d) => {
      if (d.removed) return d;
      return newVis[visPtr++];
    });

    onChange(newFull);

    if (tripId) {
      const serverIds = newVis.map((d) => d.id).filter(Boolean) as string[];
      if (serverIds.length > 0) {
        await reorderDestinations(tripId, serverIds);
      }
    }
  }, [visible, destinations, onChange, tripId]);

  // ── Reorder: drag-and-drop ───────────────────────────────────────────────
  const handleDragEnd = useCallback(async ({ data: newVis }: { data: DestinationEntry[] }) => {
    let visPtr = 0;
    const newFull = destinations.map((d) => {
      if (d.removed) return d;
      return newVis[visPtr++];
    });

    onChange(newFull);

    if (tripId) {
      const serverIds = newVis.map((d) => d.id).filter(Boolean) as string[];
      if (serverIds.length > 0) {
        await reorderDestinations(tripId, serverIds);
      }
    }
  }, [destinations, onChange, tripId]);

  // ── Render a single destination row ─────────────────────────────────────
  const renderItem = useCallback(({ item: entry, drag, isActive, getIndex }: RenderItemParams<DestinationEntry>) => {
    const visIdx = getIndex() ?? 0;
    const isBusy = busyRows[entry.key] ?? false;
    const hasCity = Boolean(entry.city);
    const startD = entry.arrivalDate ? fromISODate(entry.arrivalDate) : null;
    const endD = entry.departureDate ? fromISODate(entry.departureDate) : null;

    return (
      <ScaleDecorator>
        <View style={[styles.row, isActive && styles.rowActive]}>
          {/* Drag handle — long-press to initiate drag */}
          <Pressable
            onLongPress={drag}
            delayLongPress={150}
            hitSlop={8}
            accessibilityLabel={`Drag to reorder stop ${visIdx + 1}`}
            style={styles.dragHandle}
          >
            <GripVertical size={16} color={color.mute} />
          </Pressable>

          {/* Position arrows (accessible fallback) */}
          <View style={styles.arrows}>
            <Pressable
              onPress={() => handleMove(visIdx, 'up')}
              disabled={visIdx === 0}
              hitSlop={6}
              accessibilityLabel={`Move destination ${visIdx + 1} up`}
              style={({ pressed }) => [styles.arrowBtn, pressed && { opacity: 0.6 }, visIdx === 0 && { opacity: 0.25 }]}
            >
              <ChevronUp size={14} color={color.mute} />
            </Pressable>
            <Pressable
              onPress={() => handleMove(visIdx, 'down')}
              disabled={visIdx === visible.length - 1}
              hitSlop={6}
              accessibilityLabel={`Move destination ${visIdx + 1} down`}
              style={({ pressed }) => [styles.arrowBtn, pressed && { opacity: 0.6 }, visIdx === visible.length - 1 && { opacity: 0.25 }]}
            >
              <ChevronDown size={14} color={color.mute} />
            </Pressable>
          </View>

          {/* City + date pickers */}
          <View style={styles.fields}>
            <Pressable
              style={styles.pickerField}
              onPress={() => setPlacePickerKey(entry.key)}
              accessibilityLabel={`Pick city for stop ${visIdx + 1}`}
            >
              {isBusy
                ? <ActivityIndicator size="small" color={color.signal} style={{ marginRight: space.sm }} />
                : <MapPin size={14} color={hasCity ? color.signal : color.faint} />}
              <Text style={[styles.pickerText, !hasCity && styles.pickerPlaceholder]} numberOfLines={1}>
                {hasCity ? (entry.country ? `${entry.city}, ${entry.country}` : entry.city) : 'Add city…'}
              </Text>
            </Pressable>

            {/* Date picker — shown for all rows; server rows PATCH immediately. */}
            <Pressable
              style={styles.datePicker}
              onPress={() => setCalPickerKey(entry.key)}
              accessibilityLabel={`Pick dates for stop ${visIdx + 1}`}
            >
              <CalendarDays size={12} color={(entry.arrivalDate || entry.departureDate) ? color.signal : color.faint} />
              <Text style={[styles.dateText, !(entry.arrivalDate || entry.departureDate) && styles.pickerPlaceholder]} numberOfLines={1}>
                {startD && endD
                  ? `${formatDisplayDate(startD)} – ${formatDisplayDate(endD)}`
                  : startD
                  ? `From ${formatDisplayDate(startD)}`
                  : 'Dates (optional)'}
              </Text>
              {(entry.arrivalDate || entry.departureDate) && (
                <Pressable
                  hitSlop={6}
                  onPress={(e) => { e.stopPropagation?.(); handleDateChange(entry.key, null, null); }}
                  accessibilityLabel="Clear dates"
                >
                  <X size={12} color={color.mute} />
                </Pressable>
              )}
            </Pressable>
          </View>

          {/* Remove button — always shown; fires DELETE in background (optimistic) */}
          <Pressable
            onPress={() => handleRemove(entry.key)}
            hitSlop={8}
            accessibilityLabel={`Remove stop ${visIdx + 1}`}
            style={({ pressed }) => [styles.removeBtn, pressed && { opacity: 0.6 }]}
            testID={`remove-dest-${visIdx}`}
          >
            <Trash2 size={15} color={color.mute} />
          </Pressable>
        </View>
      </ScaleDecorator>
    );
  }, [busyRows, visible.length, handleMove, handleRemove, handleDateChange]);

  const calEntry = calPickerKey ? visible.find((d) => d.key === calPickerKey) ?? null : null;

  return (
    <View style={styles.container}>
      <DraggableFlatList
        data={visible}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        onDragEnd={handleDragEnd}
        scrollEnabled={false}
        containerStyle={styles.list}
        activationDistance={5}
      />

      {/* Add button */}
      <Pressable
        style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]}
        onPress={handleAdd}
        accessibilityLabel="Add destination"
        testID="add-destination"
      >
        <Plus size={14} color={color.signal} />
        <Text style={styles.addBtnText}>Add stop</Text>
      </Pressable>

      {/* Single place picker for all rows */}
      <GlobalPlacePicker
        visible={placePickerKey !== null}
        title="Choose city"
        allowGPS={false}
        usedFor="trip_destination"
        onSelect={(place) => placePickerKey && handlePlaceSelect(placePickerKey, place)}
        onClose={() => setPlacePickerKey(null)}
      />

      {/* Single calendar picker for all rows */}
      {calEntry && (
        <GlobalCalendarPicker
          mode="range"
          visible
          value={{ start: calEntry.arrivalDate ?? null, end: calEntry.departureDate ?? null }}
          allowPast
          onConfirm={({ start, end }) => handleDateChange(calEntry.key, start, end)}
          onCancel={() => setCalPickerKey(null)}
          title="Stop Dates"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: space.sm },
  list: { gap: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  rowActive: {
    borderColor: color.signal,
    opacity: 0.95,
  },
  dragHandle: {
    paddingTop: 2,
    paddingRight: 2,
    cursor: 'grab',
  } as any,
  arrows: { gap: 2, alignItems: 'center', paddingTop: 2 },
  arrowBtn: { padding: 2 },
  fields: { flex: 1, gap: space.xs },
  pickerField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  datePicker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  pickerText: { flex: 1, ...t.body, color: color.ink },
  pickerPlaceholder: { color: color.faint },
  dateText: { flex: 1, ...t.small, color: color.ink },
  removeBtn: { paddingTop: 2 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderColor: color.signal,
    borderStyle: 'dashed',
    borderRadius: radius.md,
    paddingVertical: space.sm,
    backgroundColor: `${color.signal}08`,
  },
  addBtnText: { ...t.small, color: color.signal, fontWeight: '700' },
});
