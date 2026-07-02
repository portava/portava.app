/**
 * Saved events screen — /events/saved
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, RefreshControl,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Bookmark, CalendarX } from 'lucide-react-native';
import { getSavedEvents, type EventListItem } from '../../src/services/events';
import { EventDiscoveryCard } from '../../src/components/EventDiscoveryCard';
import { color, space, radius, type as t } from '../../src/theme/tokens';

export default function SavedEventsScreen() {
  const insets = useSafeAreaInsets();
  const [events, setEvents] = useState<EventListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    const res = await getSavedEvents();
    if (!res.ok) setError(res.message ?? 'Failed to load saved events');
    else setEvents(res.data?.events ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Bookmark size={18} color={color.mute} />
        <Text style={styles.headerTitle}>Saved events</Text>
      </View>

      {loading && !refreshing ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => load()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : events.length === 0 ? (
        <View style={styles.center}>
          <CalendarX size={40} color={color.faint} />
          <Text style={styles.emptyTitle}>No saved events</Text>
          <Text style={styles.emptySub}>Tap the bookmark icon on any event to save it here.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={color.signal} />
          }
        >
          {events.map((ev) => (
            <EventDiscoveryCard
              key={ev.id}
              event={ev}
              onPress={() => router.push(`/event/${ev.id}` as any)}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: color.paper },
  header:     { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised },
  backBtn:    { padding: 4 },
  headerTitle:{ ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  center:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  errorText:  { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn:   { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText:  { ...t.small, color: color.onInk, fontWeight: '700' },
  emptyTitle: { ...t.title, color: color.ink, fontSize: 18, fontWeight: '800' },
  emptySub:   { ...t.body, color: color.mute, textAlign: 'center', maxWidth: 260 },
  list:       { padding: space.lg, gap: space.md, paddingBottom: 100 },
});
