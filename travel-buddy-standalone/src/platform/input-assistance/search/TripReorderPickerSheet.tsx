/**
 * census G135 "reorder plan" — the person picks one of THEIR OWN open Trips and
 * lands on that Trip's edit screen, where the stops are reordered through the
 * existing authorised endpoint. Nothing is written from this sheet.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ArrowUpDown, X } from 'lucide-react-native';
import { PortavaSheet } from '../../../components/ui/PortavaSheet.tsx';
import { listMyTrips, type TripRow } from '../../../services/trips.ts';
import { selectInvitableTrips } from '../../../features/passport/TripInvitePickerSheet.tsx';
import { color, icon, radius, space, type as t } from '../../../theme/tokens.ts';

export interface TripReorderPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  viewerUserId: string | null;
  onPick: (tripId: string) => void;
  loadTrips?: () => Promise<TripRow[]>;
}

export function TripReorderPickerSheet({ visible, onClose, viewerUserId, onPick, loadTrips = listMyTrips }: TripReorderPickerSheetProps) {
  const [trips, setTrips] = useState<TripRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setTrips(null);
    try {
      setTrips(selectInvitableTrips(await loadTrips(), viewerUserId));
    } catch {
      setFailed(true);
      setTrips([]);
    }
  }, [loadTrips, viewerUserId]);

  useEffect(() => { if (visible) void load(); }, [visible, load]);

  return (
    <PortavaSheet visible={visible} onClose={onClose} accessibilityLabel="Reorder a trip" testID="trip-reorder-picker">
      <View style={s.header}>
        <View style={s.titleRow}>
          <ArrowUpDown size={icon.s18} color={color.ink} />
          <Text style={s.title}>Reorder a trip</Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
          <X size={icon.s20} color={color.ink} />
        </Pressable>
      </View>
      {trips === null ? (
        <View style={s.center}><ActivityIndicator color={color.signal} /></View>
      ) : failed ? (
        <Pressable style={s.center} onPress={() => void load()} accessibilityRole="button" testID="trip-reorder-retry">
          <Text style={s.text}>Couldn't load your trips. Tap to retry.</Text>
        </Pressable>
      ) : trips.length === 0 ? (
        <View style={s.center} testID="trip-reorder-empty"><Text style={s.text}>You have no open trips you host.</Text></View>
      ) : (
        <ScrollView style={s.list}>
          {trips.map((tr) => (
            <Pressable key={tr.id} style={s.row} onPress={() => onPick(tr.id)} accessibilityRole="button" accessibilityLabel={`Reorder ${tr.title}`} testID={`trip-reorder-row-${tr.id}`}>
              <Text style={s.rowTitle} numberOfLines={1}>{tr.title}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </PortavaSheet>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: space.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.body, color: color.ink, fontWeight: '700' },
  center: { padding: space.lg, alignItems: 'center' },
  text: { ...t.small, color: color.mute, textAlign: 'center' },
  list: { maxHeight: 360 },
  row: { paddingVertical: space.md, paddingHorizontal: space.sm, borderRadius: radius.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze },
  rowTitle: { ...t.body, color: color.ink },
});
