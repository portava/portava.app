/**
 * Events tab screen — /(tabs)/events
 *
 * Sections:
 *  - Pending invites banner (if any)
 *  - Drafts row (resume / discard)
 *  - Today
 *  - This weekend
 *  - Saved
 *  - Browse by category
 *  - Full filtered list
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, RefreshControl, TextInput,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Plus, Search, CalendarX, CalendarClock, Bookmark, ChevronRight,
  Inbox, FileEdit,
} from 'lucide-react-native';
import {
  listEvents, getSavedEvents, getMyEventInvites, listDrafts,
  rsvpEvent, deleteDraft,
  type EventListItem, type EventState, type EventInvite, type EventDraft,
} from '../../src/services/events';
import { EventDiscoveryCard } from '../../src/components/EventDiscoveryCard';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

const STATES: { key: EventState | 'all'; label: string }[] = [
  { key: 'open',    label: 'Open' },
  { key: 'started', label: 'Happening now' },
  { key: 'all',     label: 'All' },
];

const CATEGORIES = [
  'All', 'Hiking', 'Food', 'Music', 'Nightlife',
  'Sports', 'Art', 'Travel', 'Social',
];

function todayRange(): { dateFrom: string; dateTo: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setHours(23, 59, 59, 999);
  return { dateFrom: from.toISOString(), dateTo: to.toISOString() };
}

function weekendRange(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const day = now.getDay();
  const satOffset = (6 - day + 7) % 7;
  const sat = new Date(now);
  sat.setDate(now.getDate() + satOffset);
  sat.setHours(0, 0, 0, 0);
  const sun = new Date(sat);
  sun.setDate(sat.getDate() + 1);
  sun.setHours(23, 59, 59, 999);
  return { dateFrom: sat.toISOString(), dateTo: sun.toISOString() };
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function EventsTabScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, configured } = useSession();

  const [events, setEvents] = useState<EventListItem[]>([]);
  const [todayEvents, setTodayEvents] = useState<EventListItem[]>([]);
  const [weekendEvents, setWeekendEvents] = useState<EventListItem[]>([]);
  const [savedEvents, setSavedEvents] = useState<EventListItem[]>([]);
  const [invites, setInvites] = useState<EventInvite[]>([]);
  const [drafts, setDrafts] = useState<EventDraft[]>([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [stateFilter, setStateFilter] = useState<EventState | 'all'>('open');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [search, setSearch] = useState('');

  const load = useCallback(async (isRefresh = false) => {
    if (!configured || !isAuthed) { setLoading(false); return; }
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    const todayR = todayRange();
    const weekendR = weekendRange();
    const cat = categoryFilter !== 'All' ? categoryFilter : undefined;

    const [main, today, weekend, saved, inv, draftList] = await Promise.all([
      listEvents({ state: stateFilter, category: cat, limit: 30 }),
      listEvents({ state: 'open', dateFrom: todayR.dateFrom, dateTo: todayR.dateTo, limit: 5 }),
      listEvents({ state: 'open', dateFrom: weekendR.dateFrom, dateTo: weekendR.dateTo, limit: 5 }),
      getSavedEvents(),
      getMyEventInvites(),
      listDrafts(),
    ]);

    if (!main.ok) setError(main.message ?? 'Failed to load events');
    setEvents(main.data?.events ?? []);
    setTodayEvents(today.data?.events ?? []);
    setWeekendEvents(weekend.data?.events ?? []);
    setSavedEvents(saved.data?.events ?? []);
    setInvites((inv.data?.invites ?? []).filter((i) => i.status === 'pending'));
    setDrafts(draftList.data?.drafts ?? []);

    setLoading(false);
    setRefreshing(false);
  }, [configured, isAuthed, stateFilter, categoryFilter]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleRsvp(eventId: string, status: EventListItem['myRsvp'] & string) {
    const res = await rsvpEvent(eventId, status as any);
    if (res.ok) {
      const update = (list: EventListItem[]) =>
        list.map((e) => e.id === eventId ? { ...e, myRsvp: status as any } : e);
      setEvents(update);
      setTodayEvents(update);
      setWeekendEvents(update);
    }
  }

  async function handleDeleteDraft(draftId: string) {
    await deleteDraft(draftId);
    setDrafts((prev) => prev.filter((d) => d.id !== draftId));
  }

  const filtered = search.trim()
    ? events.filter((e) =>
        e.title.toLowerCase().includes(search.toLowerCase()) ||
        (e.city ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : events;

  const isLoading = loading && !refreshing;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Events</Text>
        <Pressable
          style={styles.createBtn}
          onPress={() => router.push('/events/create' as any)}
        >
          <Plus size={16} color={color.onInk} />
          <Text style={styles.createBtnText}>Create</Text>
        </Pressable>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Search size={14} color={color.mute} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search events or city…"
            placeholderTextColor={color.faint}
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')} hitSlop={8}>
              <Text style={styles.clearSearch}>✕</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Category chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chips}
        contentContainerStyle={styles.chipsContent}
      >
        {CATEGORIES.map((cat) => (
          <Pressable
            key={cat}
            style={[styles.chip, categoryFilter === cat && styles.chipActive]}
            onPress={() => setCategoryFilter(cat)}
          >
            <Text style={[styles.chipText, categoryFilter === cat && styles.chipTextActive]}>
              {cat}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* State pills */}
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

      {/* Main content */}
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => load()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor={color.signal}
            />
          }
        >
          {/* Pending invites banner */}
          {invites.length > 0 && (
            <Pressable
              style={styles.inviteBanner}
              onPress={() => router.push('/events/invites' as any)}
            >
              <Inbox size={16} color={color.signal} />
              <Text style={styles.inviteBannerText}>
                {invites.length} pending event invite{invites.length > 1 ? 's' : ''}
              </Text>
              <ChevronRight size={16} color={color.signal} />
            </Pressable>
          )}

          {/* Drafts */}
          {drafts.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <FileEdit size={14} color={color.mute} />
                <Text style={styles.sectionTitle}>Drafts</Text>
              </View>
              {drafts.slice(0, 3).map((d) => (
                <View key={d.id} style={styles.draftRow}>
                  <View style={styles.draftInfo}>
                    <Text style={styles.draftTitle} numberOfLines={1}>
                      {d.title || 'Untitled event'}
                    </Text>
                    <Text style={styles.draftMeta}>
                      {d.startsAt ? formatDate(d.startsAt) : 'No date set'} · Saved draft
                    </Text>
                  </View>
                  <Pressable
                    style={styles.draftResumeBtn}
                    onPress={() => router.push({ pathname: '/events/create' as any, params: { draftId: d.id } })}
                  >
                    <Text style={styles.draftResumeBtnText}>Resume</Text>
                  </Pressable>
                  <Pressable
                    style={styles.draftDeleteBtn}
                    onPress={() => handleDeleteDraft(d.id)}
                    hitSlop={8}
                  >
                    <Text style={styles.draftDeleteBtnText}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          {/* If searching — show results only */}
          {search.trim() ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Results for "{search}"</Text>
              {filtered.length === 0 ? (
                <View style={styles.emptySection}>
                  <CalendarX size={28} color={color.faint} />
                  <Text style={styles.emptySectionText}>No matching events</Text>
                </View>
              ) : (
                filtered.map((ev) => (
                  <EventDiscoveryCard
                    key={ev.id}
                    event={ev}
                    onRsvp={(status) => handleRsvp(ev.id, status)}
                    onPress={() => router.push(`/event/${ev.id}` as any)}
                  />
                ))
              )}
            </View>
          ) : (
            <>
              {/* Today */}
              {todayEvents.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <CalendarClock size={14} color={color.signal} />
                    <Text style={styles.sectionTitle}>Today</Text>
                  </View>
                  {todayEvents.map((ev) => (
                    <EventDiscoveryCard
                      key={ev.id}
                      event={ev}
                      onRsvp={(status) => handleRsvp(ev.id, status)}
                      onPress={() => router.push(`/event/${ev.id}` as any)}
                    />
                  ))}
                </View>
              )}

              {/* This weekend */}
              {weekendEvents.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <CalendarClock size={14} color={color.deep} />
                    <Text style={styles.sectionTitle}>This weekend</Text>
                  </View>
                  {weekendEvents.map((ev) => (
                    <EventDiscoveryCard
                      key={ev.id}
                      event={ev}
                      onRsvp={(status) => handleRsvp(ev.id, status)}
                      onPress={() => router.push(`/event/${ev.id}` as any)}
                    />
                  ))}
                </View>
              )}

              {/* Saved events */}
              {savedEvents.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <Bookmark size={14} color={color.mute} />
                    <Text style={styles.sectionTitle}>Saved</Text>
                  </View>
                  {savedEvents.slice(0, 3).map((ev) => (
                    <EventDiscoveryCard
                      key={ev.id}
                      event={ev}
                      onRsvp={(status) => handleRsvp(ev.id, status)}
                      onPress={() => router.push(`/event/${ev.id}` as any)}
                    />
                  ))}
                  {savedEvents.length > 3 && (
                    <Pressable
                      style={styles.seeAllBtn}
                      onPress={() => router.push('/events/saved' as any)}
                    >
                      <Text style={styles.seeAllText}>See all saved events</Text>
                      <ChevronRight size={14} color={color.signal} />
                    </Pressable>
                  )}
                </View>
              )}

              {/* All / filtered */}
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>
                    {stateFilter === 'all' ? 'All events' : stateFilter === 'open' ? 'Open events' : 'Happening now'}
                    {categoryFilter !== 'All' ? ` · ${categoryFilter}` : ''}
                  </Text>
                </View>
                {events.length === 0 ? (
                  <View style={styles.emptySection}>
                    <CalendarX size={32} color={color.faint} />
                    <Text style={styles.emptySectionTitle}>No events found</Text>
                    <Text style={styles.emptySectionText}>
                      Try a different filter, or create your own.
                    </Text>
                    <Pressable
                      style={styles.createEmptyBtn}
                      onPress={() => router.push('/events/create' as any)}
                    >
                      <Plus size={14} color={color.onInk} />
                      <Text style={styles.createEmptyBtnText}>Create an event</Text>
                    </Pressable>
                  </View>
                ) : (
                  events.map((ev) => (
                    <EventDiscoveryCard
                      key={ev.id}
                      event={ev}
                      onRsvp={(status) => handleRsvp(ev.id, status)}
                      onPress={() => router.push(`/event/${ev.id}` as any)}
                    />
                  ))
                )}
              </View>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:         { flex: 1, backgroundColor: color.paper },
  header:            { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised, gap: space.md },
  headerTitle:       { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  createBtn:         { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill },
  createBtnText:     { ...t.small, color: color.onInk, fontWeight: '700' },
  searchRow:         { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  searchBox:         { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, height: 40 },
  searchInput:       { flex: 1, ...t.body, color: color.ink },
  clearSearch:       { ...t.small, color: color.mute, paddingHorizontal: 4 },
  chips:             { maxHeight: 40 },
  chipsContent:      { paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center' },
  chip:              { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: color.haze },
  chipActive:        { backgroundColor: color.deep },
  chipText:          { ...t.small, color: color.mute, fontWeight: '600' },
  chipTextActive:    { color: color.onInk },
  pills:             { maxHeight: 40, marginTop: space.xs },
  pillsContent:      { paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center' },
  pill:              { paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: color.haze },
  pillActive:        { backgroundColor: color.ink },
  pillText:          { ...t.small, color: color.mute, fontWeight: '600' },
  pillTextActive:    { color: color.onInk },
  center:            { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  errorText:         { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn:          { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText:         { ...t.small, color: color.onInk, fontWeight: '700' },
  scroll:            { padding: space.lg, gap: space.xl, paddingBottom: 100 },
  inviteBanner:      { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: '#FFF5F5', borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: '#FECACA' },
  inviteBannerText:  { ...t.body, color: color.signal, fontWeight: '600', flex: 1 },
  section:           { gap: space.sm },
  sectionHeader:     { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  sectionTitle:      { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  draftRow:          { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.haze, borderStyle: 'dashed' },
  draftInfo:         { flex: 1 },
  draftTitle:        { ...t.body, color: color.ink, fontWeight: '600' },
  draftMeta:         { ...t.small, color: color.mute },
  draftResumeBtn:    { backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill },
  draftResumeBtnText:{ ...t.small, color: color.onInk, fontWeight: '700' },
  draftDeleteBtn:    { padding: 4 },
  draftDeleteBtnText:{ ...t.small, color: color.mute },
  emptySection:      { alignItems: 'center', paddingVertical: space.xl, gap: space.sm },
  emptySectionTitle: { ...t.body, color: color.ink, fontWeight: '700' },
  emptySectionText:  { ...t.small, color: color.mute, textAlign: 'center' },
  createEmptyBtn:    { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, marginTop: space.sm, ...shadow.card },
  createEmptyBtnText:{ ...t.small, color: color.onInk, fontWeight: '700' },
  seeAllBtn:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: space.sm },
  seeAllText:        { ...t.small, color: color.signal, fontWeight: '600' },
});
