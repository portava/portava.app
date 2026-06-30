/**
 * Events tab screen — /(tabs)/events
 *
 * Tab-root version of the events discovery screen.
 * No back button — this is a root tab screen.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, RefreshControl, TextInput,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Search, CalendarX } from 'lucide-react-native';
import {
  listEvents, rsvpEvent,
  type EventListItem, type EventState,
} from '../../src/services/events';
import { EventDiscoveryCard } from '../../src/components/EventDiscoveryCard';
import { EventComposerSheet } from '../../src/components/EventComposerSheet';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

const STATES: { key: EventState | 'all'; label: string }[] = [
  { key: 'open',    label: 'Open' },
  { key: 'started', label: 'Happening now' },
  { key: 'all',     label: 'All' },
];

export default function EventsTabScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, configured } = useSession();

  const [events, setEvents] = useState<EventListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<EventState | 'all'>('open');
  const [cityFilter, setCityFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    if (!configured || !isAuthed) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    const res = await listEvents({
      state: stateFilter,
      city: cityFilter.trim() || undefined,
      limit: 30,
    });
    if (!res.ok) setError(res.message ?? 'Failed to load events');
    else setEvents(res.data?.events ?? []);
    setLoading(false);
  }, [configured, isAuthed, stateFilter, cityFilter]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleRsvp(eventId: string, status: 'going' | 'maybe' | 'interested' | 'cant_go') {
    const res = await rsvpEvent(eventId, status);
    if (res.ok) {
      setEvents((prev) => prev.map((e) => e.id === eventId ? { ...e, myRsvp: status } : e));
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Events</Text>
        <Pressable style={styles.createBtn} onPress={() => setShowCreate(true)}>
          <Plus size={16} color={color.onInk} />
          <Text style={styles.createBtnText}>Create</Text>
        </Pressable>
      </View>

      {/* City search */}
      <View style={styles.filterRow}>
        <View style={styles.searchBox}>
          <Search size={14} color={color.mute} />
          <TextInput
            style={styles.searchInput}
            placeholder="City…"
            placeholderTextColor={color.faint}
            value={cityFilter}
            onChangeText={setCityFilter}
            onSubmitEditing={load}
            returnKeyType="search"
          />
        </View>
      </View>

      {/* State filter pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.pills}
        contentContainerStyle={styles.pillsContent}
      >
        {STATES.map((s) => (
          <Pressable
            key={s.key}
            style={[styles.pill, stateFilter === s.key && styles.pillActive]}
            onPress={() => setStateFilter(s.key)}
          >
            <Text style={[styles.pillText, stateFilter === s.key && styles.pillTextActive]}>
              {s.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Content */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : events.length === 0 ? (
        <View style={styles.emptyState}>
          <CalendarX size={40} color={color.faint} />
          <Text style={styles.emptyTitle}>No events found</Text>
          <Text style={styles.emptySub}>
            Try a different city or filter, or create your own event.
          </Text>
          <Pressable style={styles.emptyBtn} onPress={() => setShowCreate(true)}>
            <Plus size={16} color={color.onInk} />
            <Text style={styles.emptyBtnText}>Create an event</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={color.signal} />}
        >
          {events.map((ev) => (
            <EventDiscoveryCard
              key={ev.id}
              event={ev}
              onRsvp={(status) => handleRsvp(ev.id, status)}
              onPress={() => router.push(`/event/${ev.id}` as any)}
            />
          ))}
        </ScrollView>
      )}

      {showCreate && (
        <EventComposerSheet
          onDismiss={() => setShowCreate(false)}
          onCreated={(ev) => {
            setShowCreate(false);
            router.push(`/event/${ev.id}` as any);
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:     { flex: 1, backgroundColor: color.paper },
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised, gap: space.md },
  headerTitle:   { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  createBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill },
  createBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  filterRow:     { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  searchBox:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, height: 38 },
  searchInput:   { flex: 1, ...t.body, color: color.ink },
  pills:         { maxHeight: 44 },
  pillsContent:  { paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center' },
  pill:          { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: color.haze },
  pillActive:    { backgroundColor: color.ink },
  pillText:      { ...t.small, color: color.mute, fontWeight: '600' },
  pillTextActive:{ ...t.small, color: color.onInk, fontWeight: '700' },
  center:        { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  errorText:     { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn:      { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText:     { ...t.small, color: color.onInk, fontWeight: '700' },
  emptyState:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  emptyTitle:    { ...t.title, color: color.ink, fontSize: 20, fontWeight: '800' },
  emptySub:      { ...t.body, color: color.mute, textAlign: 'center', maxWidth: 280 },
  emptyBtn:      { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.pill, marginTop: space.sm, ...shadow.card },
  emptyBtnText:  { ...t.body, color: color.onInk, fontWeight: '700' },
  list:          { padding: space.lg, gap: space.md, paddingBottom: 100 },
});
