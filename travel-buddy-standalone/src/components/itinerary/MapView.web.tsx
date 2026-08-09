/**
 * MapView.web.tsx — web-safe stub for ItineraryMapView.
 * react-native-maps uses codegenNativeComponent (TurboModules) which is not
 * available in react-native-web. Metro automatically picks this file over
 * MapView.tsx when bundling for web, so the native file is unchanged.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { MapPin, Navigation } from 'lucide-react-native';
import type { TripPlanItem, TripPlanCategory } from '../../types/models.ts';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';

export interface MapViewProps {
  items: TripPlanItem[];
  onItemPress: (item: TripPlanItem) => void;
  selectedDay: string;
  loading?: boolean;
}

const CAT_PIN: Record<TripPlanCategory, string> = {
  accommodation: '#3A7CA5',
  activity:      '#2A9D5C',
  dining:        '#E76F51',
  transport:     '#7A4DBF',
  free_time:     '#8B6914',
  meeting_point: '#E9C46A',
  other:         '#888',
};

export function ItineraryMapView({ items, onItemPress, selectedDay, loading }: MapViewProps) {
  const filtered = selectedDay === 'all' ? items : items.filter((i) => i.dayDate === selectedDay);

  if (loading) {
    return (
      <View style={s.empty}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (filtered.length === 0) {
    return (
      <View style={s.empty}>
        <View style={s.emptyIcon}><Navigation size={28} color={color.faint} /></View>
        <Text style={s.emptyTitle}>No items for this day</Text>
        <Text style={s.emptyBody}>Add places or activities to see them here.</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
      <View style={s.banner}>
        <Navigation size={14} color={color.mute} />
        <Text style={s.bannerText}>Map view is available in the mobile app.</Text>
      </View>
      {filtered.map((item) => {
        const pinColor = CAT_PIN[item.category] ?? '#888';
        return (
          <Pressable key={item.id} style={s.card} onPress={() => onItemPress(item)}>
            <View style={[s.pinDot, { backgroundColor: pinColor }]}>
              <MapPin size={10} color="#fff" />
            </View>
            <View style={s.cardText}>
              <Text style={s.cardTitle} numberOfLines={1}>{item.title}</Text>
              {item.locationName && (
                <Text style={s.cardLoc} numberOfLines={1}>{item.locationName}</Text>
              )}
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  list:      { gap: 8, paddingBottom: 24 },
  empty:     { alignItems: 'center', paddingVertical: 48, gap: 8 },
  emptyIcon: { width: avatar.xxl, height: avatar.xxl, borderRadius: avatar.xxl / 2, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  emptyTitle:{ ...t.title, fontSize: 16, color: color.mute },
  emptyBody: { ...t.body, color: color.faint, textAlign: 'center', maxWidth: 260 },
  banner:    { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.haze, borderRadius: radius.md, padding: 12, marginBottom: 4 },
  bannerText:{ ...t.small, color: color.mute, flex: 1 },
  card:      { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, padding: 10, borderWidth: 1, borderColor: color.haze },
  pinDot:    { width: avatar.xs, height: avatar.xs, borderRadius: avatar.xs / 2, alignItems: 'center', justifyContent: 'center' },
  cardText:  { flex: 1, gap: 2 },
  cardTitle: { ...t.body, color: color.ink, fontWeight: '600' },
  cardLoc:   { ...t.small, color: color.mute },
});
