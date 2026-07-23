/**
 * DestinationListEditor — multi-city destination list editor for trip create/edit.
 *
 * In CREATE mode (no tripId): accumulates destinations locally; caller reads
 * the `destinations` prop via the onChange callback and persists after trip creation.
 *
 * In EDIT mode (tripId provided): each add calls POST /api/trips/:id/destinations
 * immediately; reorder calls POST /api/trips/:id/destinations/reorder immediately;
 * remove calls DELETE /api/trips/:id/destinations/:destId immediately (rows with a
 * server ID). Rows without an ID (not yet persisted) are hidden locally only.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { MapPin, Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react-native';
import { GlobalPlacePicker } from '../selectors/GlobalPlacePicker.tsx';
import { GlobalCalendarPicker } from '../selectors/GlobalCalendarPicker.tsx';
import { CalendarDays, X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { formatDisplayDate, fromISODate } from '../../lib/dateTime/formatters.ts';
import type { Place } from '../../lib/location/placeTypes.ts';
import { addDestination, reorderDestinations, deleteDestination } from '../../services/tripDestinations.ts';

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
  // Which row's place picker is open (-1 = none)
  const [placePickerRow, setPlacePickerRow] = useState<number>(-1);
  // Which row's calendar picker is open (-1 = none)
  const [calPickerRow, setCalPickerRow] = useState<number>(-1);
  // Per-row busy state for API calls
  const [busyRows, setBusyRows] = useState<Record<string, boolean>>({});

  const visible = destinations.filter((d) => !d.removed);

  const setBusyRow = (key: string, busy: boolean) => {
    setBusyRows((prev) => ({ ...prev, [key]: busy }));
  };

  // ── Add a blank row ──────────────────────────────────────────────────────
  const handleAdd = useCallback(() => {
    const newEntry: DestinationEntry = { key: makeKey(), city: '' };
    onChange([...destinations, newEntry]);
    // Open the place picker for the new row immediately
    const newVisibleIdx = destinations.filter((d) => !d.removed).length;
    setPlacePickerRow(newVisibleIdx);
  }, [destinations, onChange]);

  // ── Remove a row ─────────────────────────────────────────────────────────
  const handleRemove = useCallback(async (key: string) => {
    const entry = destinations.find((d) => d.key === key);
    if (!entry) return;

    // In edit mode with a persisted server row: DELETE first; only hide locally
    // if the server accepted it. On failure, leave the row visible so the user
    // isn't shown a false-success that reverts on refresh.
    if (tripId && entry.id) {
      setBusyRow(key, true);
      let ok = false;
      try {
        ok = await deleteDestination(tripId, entry.id);
      } finally {
        setBusyRow(key, false);
      }
      if (!ok) return; // Server rejected — leave row visible, don't hide locally.
    }

    // Hide locally (create mode, or edit mode after confirmed server delete).
    onChange(destinations.map((d) => d.key === key ? { ...d, removed: true } : d));
  }, [destinations, onChange, tripId]);

  // ── Place selected for a row ─────────────────────────────────────────────
  const handlePlaceSelect = useCallback(async (visibleIdx: number, place: Place) => {
    const vis = destinations.filter((d) => !d.removed);
    const entry = vis[visibleIdx];
    if (!entry) return;

    const updated: DestinationEntry = {
      ...entry,
      city: place.city ?? place.name,
      country: place.country ?? null,
      lat: place.lat ?? null,
      lng: place.lng ?? null,
      placeId: place.id ?? null,
    };

    // In edit mode: persist immediately if the trip exists
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

    onChange(destinations.map((d) => d.key === entry.key ? updated : d));
    setPlacePickerRow(-1);
  }, [destinations, onChange, tripId]);

  // ── Date change for a row ────────────────────────────────────────────────
  const handleDateChange = useCallback((key: string, start: string | null, end: string | null) => {
    onChange(destinations.map((d) => d.key === key ? { ...d, arrivalDate: start, departureDate: end } : d));
    setCalPickerRow(-1);
  }, [destinations, onChange]);

  // ── Reorder: move up / down ──────────────────────────────────────────────
  const handleMove = useCallback(async (visibleIdx: number, direction: 'up' | 'down') => {
    const vis = visible;
    const targetIdx = direction === 'up' ? visibleIdx - 1 : visibleIdx + 1;
    if (targetIdx < 0 || targetIdx >= vis.length) return;

    // Rebuild the full list with the visible slice reordered
    const newVis = [...vis];
    const tmp = newVis[visibleIdx];
    newVis[visibleIdx] = newVis[targetIdx];
    newVis[targetIdx] = tmp;

    // Merge back into the full list (including removed entries)
    let visPtr = 0;
    const newFull = destinations.map((d) => {
      if (d.removed) return d;
      return newVis[visPtr++];
    });

    onChange(newFull);

    // In edit mode: persist reorder for rows that already have server IDs
    if (tripId) {
      const serverIds = newVis.map((d) => d.id).filter(Boolean) as string[];
      if (serverIds.length > 0) {
        await reorderDestinations(tripId, serverIds);
      }
    }
  }, [visible, destinations, onChange, tripId]);

  return (
    <View style={styles.container}>
      {visible.map((entry, visIdx) => {
        const isBusy = busyRows[entry.key] ?? false;
        const hasCity = Boolean(entry.city);
        const startD = entry.arrivalDate ? fromISODate(entry.arrivalDate) : null;
        const endD = entry.departureDate ? fromISODate(entry.departureDate) : null;

        // An "existing server row" in edit mode has an `id` from the server.
        // No DELETE or PATCH endpoint exists for individual destinations yet, so
        // we hide remove and date-edit affordances for those rows to prevent
        // misleading UX (changes that look saved but revert on refresh).
        // Newly added rows (no `id`) go through POST and can still have dates.
        const isServerRow = Boolean(tripId && entry.id);

        return (
          <View key={entry.key} style={styles.row}>
            {/* Position arrows */}
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
                onPress={() => setPlacePickerRow(visIdx)}
                accessibilityLabel={`Pick city for stop ${visIdx + 1}`}
              >
                {isBusy
                  ? <ActivityIndicator size="small" color={color.signal} style={{ marginRight: space.sm }} />
                  : <MapPin size={14} color={hasCity ? color.signal : color.faint} />}
                <Text style={[styles.pickerText, !hasCity && styles.pickerPlaceholder]} numberOfLines={1}>
                  {hasCity ? (entry.country ? `${entry.city}, ${entry.country}` : entry.city) : 'Add city…'}
                </Text>
              </Pressable>

              {/* Date picker — hidden for existing server rows in edit mode:
                  no PATCH /destinations/:id endpoint exists yet, so date changes
                  would not persist and would revert on refresh. */}
              {!isServerRow && (
                <Pressable
                  style={styles.datePicker}
                  onPress={() => setCalPickerRow(visIdx)}
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
              )}
            </View>

            {/* Remove button — always shown; in edit mode calls DELETE then hides. */}
            <Pressable
              onPress={() => handleRemove(entry.key)}
              disabled={busyRows[entry.key] ?? false}
              hitSlop={8}
              accessibilityLabel={`Remove stop ${visIdx + 1}`}
              style={({ pressed }) => [styles.removeBtn, pressed && { opacity: 0.6 }]}
              testID={`remove-dest-${visIdx}`}
            >
              <Trash2 size={15} color={color.mute} />
            </Pressable>
          </View>
        );
      })}

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
        visible={placePickerRow >= 0}
        title="Choose city"
        allowGPS={false}
        usedFor="trip_destination"
        onSelect={(place) => handlePlaceSelect(placePickerRow, place)}
        onClose={() => setPlacePickerRow(-1)}
      />

      {/* Single calendar picker for all rows */}
      {calPickerRow >= 0 && (() => {
        const entry = visible[calPickerRow];
        return entry ? (
          <GlobalCalendarPicker
            mode="range"
            visible
            value={{ start: entry.arrivalDate ?? null, end: entry.departureDate ?? null }}
            allowPast
            onConfirm={({ start, end }) => handleDateChange(entry.key, start, end)}
            onCancel={() => setCalPickerRow(-1)}
            title="Stop Dates"
          />
        ) : null;
      })()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: space.sm },
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
