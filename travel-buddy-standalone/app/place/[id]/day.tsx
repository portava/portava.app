import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getPlaceDay, getPlaceDayFeed } from '../../../src/services/places.ts';
import type { PlaceDay, PlaceDayFeedItem } from '../../../src/types/placeLiving.ts';
import { CachedImage } from '../../../src/components/CachedImage.tsx';
import { color, radius, space, type as t, typography } from '../../../src/theme/tokens.ts';

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function PlaceDayScreen() {
  const { id, date: initialDate } = useLocalSearchParams<{ id: string; date?: string }>();
  const placeId = Array.isArray(id) ? id[0] : id;
  const [day, setDay] = useState<PlaceDay | null | undefined>(undefined);
  const [items, setItems] = useState<PlaceDayFeedItem[]>([]);
  const [selectedDate, setSelectedDate] = useState(Array.isArray(initialDate) ? initialDate[0] : initialDate);
  const [navigation, setNavigation] = useState<{ previousDate: string | null; nextDate: string | null }>({ previousDate: null, nextDate: null });

  const load = useCallback(async () => {
    if (!placeId) return;
    setDay(undefined);
    const lookup = await getPlaceDay(placeId, selectedDate);
    setDay(lookup?.day ?? null);
    setNavigation(lookup?.navigation ?? { previousDate: null, nextDate: null });
    if (lookup?.day) {
      const feed = await getPlaceDayFeed(placeId, lookup.day.localDate);
      setItems(feed?.items ?? []);
    } else setItems([]);
  }, [placeId, selectedDate]);

  useEffect(() => { void load(); }, [load]);
  const activeDate = day?.localDate ?? selectedDate ?? new Date().toISOString().slice(0, 10);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: day?.placeName ?? 'Place Day', headerShown: true }} />
      <View style={styles.dateBar}>
        <Pressable testID="place-day-previous" disabled={!navigation.previousDate} onPress={() => navigation.previousDate && setSelectedDate(navigation.previousDate)}><ChevronLeft color={navigation.previousDate ? color.deep : color.haze} /></Pressable>
        <View style={styles.dateTitle}><CalendarDays size={16} color={color.deep} /><Text style={styles.dateText}>{activeDate}</Text></View>
        <Pressable testID="place-day-next" disabled={!navigation.nextDate} onPress={() => navigation.nextDate && setSelectedDate(navigation.nextDate)}><ChevronRight color={navigation.nextDate ? color.deep : color.haze} /></Pressable>
      </View>
      {day === undefined ? <View style={styles.center}><ActivityIndicator color={color.signal} /></View> : !day ? (
        <View style={styles.center}><Text style={styles.emptyTitle}>No Place Day yet</Text><Text style={styles.emptyBody}>There’s no eligible activity for this local date.</Text></View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.status}>{day.status === 'active' ? 'Happening today' : day.status === 'closing' ? 'Day is closing' : 'Archived day'}</Text>
          {items.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>Nothing shared here yet</Text><Text style={styles.emptyBody}>Posts appear here only when they’re already visible to you.</Text></View> : items.map((item) => <DayPost key={item.id} item={item} timezone={day.timezone} />)}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function DayPost({ item, timezone }: { item: PlaceDayFeedItem; timezone: string }) {
  const image = item.thumbnailUrl ?? item.mediaUrl;
  return <View style={styles.card}>
    {image ? <CachedImage source={{ uri: image }} style={styles.image} resizeMode="cover" /> : null}
    {item.caption ? <Text style={styles.caption}>{item.caption}</Text> : <Text style={styles.muted}>Shared a moment</Text>}
    <Text style={styles.muted}>{new Intl.DateTimeFormat(undefined, { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(item.createdAt))}</Text>
  </View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.paper },
  dateBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  dateTitle: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dateText: { ...t.bodyStrong, color: color.deep },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  content: { padding: space.lg, gap: space.md },
  status: { ...typography.label, color: color.deep, textAlign: 'center' },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptyBody: { ...typography.body, color: color.mute, textAlign: 'center', marginTop: space.sm },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md, gap: space.sm, borderWidth: 1, borderColor: color.haze },
  image: { width: '100%', height: 220, borderRadius: radius.sm },
  caption: { ...typography.body, color: color.ink },
  muted: { ...typography.caption, color: color.mute },
});