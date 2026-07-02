/**
 * Events tab — /(tabs)/events
 *
 * Sections: Today, This Weekend, Near Me (GPS-gated), Following, Saved,
 * Your Drafts, Pending Invites banner.
 * Filter bar: date presets, Free only, Verified host, category chips.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, RefreshControl, FlatList, Alert,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Plus, CalendarX, MapPin, Navigation, ChevronRight,
  Bookmark, Users, FileEdit, Bell, Filter, Check,
} from 'lucide-react-native';
import {
  listEvents, listFollowingEvents, getSavedEvents, getMyDrafts, getMyEventInvites,
  saveEvent, unsaveEvent,
  type EventListItem, type EventDraft, type EventInvite,
} from '../../src/services/events';
import { EventDiscoveryCard } from '../../src/components/EventDiscoveryCard';
import { useSession } from '../../src/context/SessionContext';
import { useActiveLocation } from '../../src/hooks/useActiveLocation';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

// ── Date preset helpers ───────────────────────────────────────────────────────

function todayRange(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now);   end.setHours(23, 59, 59, 999);
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() };
}

function weekendRange(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const day = now.getDay(); // 0=Sun,6=Sat
  const daysUntilSat = day === 6 ? 0 : (6 - day);
  const sat = new Date(now); sat.setDate(now.getDate() + daysUntilSat); sat.setHours(0, 0, 0, 0);
  const sun = new Date(sat); sun.setDate(sat.getDate() + 1); sun.setHours(23, 59, 59, 999);
  return { dateFrom: sat.toISOString(), dateTo: sun.toISOString() };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = ['All', 'Hiking', 'Food', 'Music', 'Art', 'Nightlife', 'Sports', 'Wellness', 'Travel'];

type DatePreset = 'all' | 'today' | 'weekend' | 'next7';
const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'all',     label: 'Any time' },
  { key: 'today',   label: 'Today' },
  { key: 'weekend', label: 'Weekend' },
  { key: 'next7',   label: 'Next 7 days' },
];

function next7Range(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const end = new Date(now); end.setDate(now.getDate() + 7); end.setHours(23, 59, 59, 999);
  return { dateFrom: now.toISOString(), dateTo: end.toISOString() };
}

function datePresetToRange(preset: DatePreset): { dateFrom?: string; dateTo?: string } {
  if (preset === 'today')   return todayRange();
  if (preset === 'weekend') return weekendRange();
  if (preset === 'next7')   return next7Range();
  return {};
}

function formatDraftDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function EventsTabScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, configured } = useSession();
  const { locationState, requestLocation } = useActiveLocation();

  const [refreshing, setRefreshing] = useState(false);

  // ── Discovery events ──────────────────────────────────────────────────────
  const [todayEvents, setTodayEvents]       = useState<EventListItem[]>([]);
  const [weekendEvents, setWeekendEvents]   = useState<EventListItem[]>([]);
  const [nearMeEvents, setNearMeEvents]     = useState<EventListItem[]>([]);
  const [followingEvents, setFollowingEvents] = useState<EventListItem[]>([]);
  const [savedEvents, setSavedEvents]       = useState<EventListItem[]>([]);
  const [drafts, setDrafts]                 = useState<EventDraft[]>([]);
  const [pendingInvites, setPendingInvites] = useState<EventInvite[]>([]);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState<string | null>(null);

  // ── Filters ────────────────────────────────────────────────────────────────
  const [showFilters, setShowFilters]     = useState(false);
  const [category, setCategory]           = useState('All');
  const [datePreset, setDatePreset]       = useState<DatePreset>('all');
  const [freeOnly, setFreeOnly]           = useState(false);
  const [verifiedHostOnly, setVerifiedHostOnly] = useState(false);

  // ── Near-me location request ───────────────────────────────────────────────
  const [nearMeRequested, setNearMeRequested] = useState(false);
  const [nearMeLoading, setNearMeLoading] = useState(false);

  // ── Optimistic save state ──────────────────────────────────────────────────
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  const activeFilters = (category !== 'All' ? 1 : 0) + (freeOnly ? 1 : 0) + (verifiedHostOnly ? 1 : 0) + (datePreset !== 'all' ? 1 : 0);

  const load = useCallback(async (isRefresh = false) => {
    if (!configured || !isAuthed) { setLoading(false); return; }
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    const cat = category !== 'All' ? category : undefined;
    const dateRange = datePresetToRange(datePreset);

    const [todayRes, weekendRes, followRes, savedRes, draftsRes, invitesRes] = await Promise.all([
      listEvents({ ...todayRange(), category: cat, free: freeOnly || undefined, verifiedHostOnly: verifiedHostOnly || undefined, limit: 10 }),
      listEvents({ ...weekendRange(), category: cat, free: freeOnly || undefined, verifiedHostOnly: verifiedHostOnly || undefined, limit: 10 }),
      listFollowingEvents({ limit: 10 }),
      getSavedEvents(1),
      getMyDrafts(),
      getMyEventInvites(),
    ]);

    if (todayRes.ok) setTodayEvents(todayRes.data?.events ?? []);
    if (weekendRes.ok) setWeekendEvents(weekendRes.data?.events ?? []);
    if (followRes.ok) setFollowingEvents(followRes.data?.events ?? []);
    if (savedRes.ok) {
      const evs = savedRes.data?.events ?? [];
      setSavedEvents(evs);
      setSavedIds(new Set(evs.map((e) => e.id)));
    }
    if (draftsRes.ok) setDrafts(draftsRes.data?.drafts ?? []);
    if (invitesRes.ok) setPendingInvites((invitesRes.data?.invites ?? []).filter((i) => i.status === 'pending'));

    if (!todayRes.ok && !weekendRes.ok) setError('Failed to load events');
    setLoading(false);
    setRefreshing(false);
  }, [configured, isAuthed, category, datePreset, freeOnly, verifiedHostOnly]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── Near-me load ───────────────────────────────────────────────────────────
  async function handleNearMeRequest() {
    if (!locationState.coords) {
      setNearMeRequested(true);
      await requestLocation();
      if (!locationState.coords) {
        Alert.alert(
          'Location not available',
          'Enable location in your device settings, or search by city instead.',
          [{ text: 'OK' }],
        );
        return;
      }
    }
    if (!locationState.coords) return;
    setNearMeLoading(true);
    const res = await listEvents({
      nearLat: locationState.coords.lat,
      nearLng: locationState.coords.lng,
      nearRadiusKm: 25,
      limit: 15,
    });
    if (res.ok) setNearMeEvents(res.data?.events ?? []);
    setNearMeLoading(false);
  }

  useEffect(() => {
    if (nearMeRequested && locationState.coords) {
      handleNearMeRequest();
      setNearMeRequested(false);
    }
  }, [locationState.coords, nearMeRequested]);

  // ── Save toggle ────────────────────────────────────────────────────────────
  async function handleSaveToggle(ev: EventListItem) {
    const isSaved = savedIds.has(ev.id);
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (isSaved) next.delete(ev.id); else next.add(ev.id);
      return next;
    });
    if (isSaved) {
      await unsaveEvent(ev.id);
      setSavedEvents((prev) => prev.filter((e) => e.id !== ev.id));
    } else {
      await saveEvent(ev.id);
    }
  }

  function renderSection(
    title: string,
    icon: React.ReactNode,
    items: EventListItem[],
    onSeeAll?: () => void,
  ) {
    if (items.length === 0) return null;
    return (
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <View style={styles.sectionTitleRow}>
            {icon}
            <Text style={styles.sectionTitle}>{title}</Text>
          </View>
          {onSeeAll && (
            <Pressable style={styles.seeAll} onPress={onSeeAll}>
              <Text style={styles.seeAllText}>See all</Text>
              <ChevronRight size={12} color={color.signal} />
            </Pressable>
          )}
        </View>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.hList}
          renderItem={({ item }) => (
            <View style={styles.hCard}>
              <EventDiscoveryCard
                event={item}
                onPress={() => router.push(`/event/${item.id}` as any)}
              />
            </View>
          )}
        />
      </View>
    );
  }

  const hasContent = todayEvents.length > 0 || weekendEvents.length > 0 || nearMeEvents.length > 0 || followingEvents.length > 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Events</Text>
        <View style={styles.headerActions}>
          <Pressable
            style={[styles.filterBtn, activeFilters > 0 && styles.filterBtnActive]}
            onPress={() => setShowFilters((v) => !v)}
          >
            <Filter size={14} color={activeFilters > 0 ? color.onInk : color.mute} />
            {activeFilters > 0 && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{activeFilters}</Text>
              </View>
            )}
          </Pressable>
          <Pressable
            style={styles.createBtn}
            onPress={() => router.push('/events/create' as any)}
          >
            <Plus size={16} color={color.onInk} />
            <Text style={styles.createBtnText}>Create</Text>
          </Pressable>
        </View>
      </View>

      {/* Filter drawer */}
      {showFilters && (
        <View style={styles.filterDrawer}>
          {/* Date presets */}
          <ScrollView
            horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {DATE_PRESETS.map((p) => (
              <Pressable
                key={p.key}
                style={[styles.chip, datePreset === p.key && styles.chipActive]}
                onPress={() => setDatePreset(p.key)}
              >
                <Text style={[styles.chipText, datePreset === p.key && styles.chipTextActive]}>{p.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Category chips */}
          <ScrollView
            horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {CATEGORIES.map((cat) => (
              <Pressable
                key={cat}
                style={[styles.chip, category === cat && styles.chipActive]}
                onPress={() => setCategory(cat)}
              >
                <Text style={[styles.chipText, category === cat && styles.chipTextActive]}>{cat}</Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Toggle filters */}
          <View style={styles.toggleRow}>
            <Pressable
              style={[styles.toggleChip, freeOnly && styles.toggleChipActive]}
              onPress={() => setFreeOnly((v) => !v)}
            >
              {freeOnly && <Check size={12} color={color.onInk} />}
              <Text style={[styles.toggleChipText, freeOnly && styles.toggleChipTextActive]}>Free</Text>
            </Pressable>
            <Pressable
              style={[styles.toggleChip, verifiedHostOnly && styles.toggleChipActive]}
              onPress={() => setVerifiedHostOnly((v) => !v)}
            >
              {verifiedHostOnly && <Check size={12} color={color.onInk} />}
              <Text style={[styles.toggleChipText, verifiedHostOnly && styles.toggleChipTextActive]}>Verified host</Text>
            </Pressable>
            {activeFilters > 0 && (
              <Pressable
                style={styles.clearFilters}
                onPress={() => { setCategory('All'); setDatePreset('all'); setFreeOnly(false); setVerifiedHostOnly(false); }}
              >
                <Text style={styles.clearFiltersText}>Clear all</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      {/* Invites banner */}
      {pendingInvites.length > 0 && (
        <Pressable
          style={styles.invitesBanner}
          onPress={() => router.push('/events/invites' as any)}
        >
          <Bell size={15} color="#7C3AED" />
          <Text style={styles.invitesBannerText}>
            {pendingInvites.length === 1
              ? 'You have 1 pending event invite'
              : `You have ${pendingInvites.length} pending event invites`}
          </Text>
          <ChevronRight size={14} color="#7C3AED" />
        </Pressable>
      )}

      {loading && !refreshing ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : error && !hasContent ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => load()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={color.signal} />
          }
        >

          {/* Drafts */}
          {drafts.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionTitleRow}>
                  <FileEdit size={15} color={color.mute} />
                  <Text style={styles.sectionTitle}>Your drafts</Text>
                </View>
              </View>
              {drafts.map((d) => (
                <Pressable
                  key={d.id}
                  style={styles.draftCard}
                  onPress={() => router.push({ pathname: '/events/create', params: { draftId: d.id } } as any)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.draftTitle} numberOfLines={1}>{d.title ?? 'Untitled draft'}</Text>
                    <Text style={styles.draftMeta}>Saved {formatDraftDate(d.updatedAt)}</Text>
                  </View>
                  <ChevronRight size={14} color={color.mute} />
                </Pressable>
              ))}
            </View>
          )}

          {/* Today */}
          {renderSection(
            'Today',
            <CalendarX size={15} color={color.mute} />,
            todayEvents,
            () => router.push({ pathname: '/events/index', params: { preset: 'today' } } as any),
          )}

          {/* This Weekend */}
          {renderSection(
            'This Weekend',
            <CalendarX size={15} color={color.mute} />,
            weekendEvents,
            () => router.push({ pathname: '/events/index', params: { preset: 'weekend' } } as any),
          )}

          {/* Near Me */}
          {nearMeEvents.length > 0
            ? renderSection(
                'Near Me',
                <Navigation size={15} color={color.signal} />,
                nearMeEvents,
              )
            : (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <View style={styles.sectionTitleRow}>
                    <Navigation size={15} color={color.mute} />
                    <Text style={styles.sectionTitle}>Near Me</Text>
                  </View>
                </View>
                <Pressable
                  style={styles.nearMePrompt}
                  onPress={handleNearMeRequest}
                  disabled={nearMeLoading}
                >
                  {nearMeLoading ? (
                    <ActivityIndicator size="small" color={color.signal} />
                  ) : (
                    <MapPin size={18} color={color.signal} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.nearMeTitle}>
                      {nearMeLoading ? 'Looking for events nearby…' : 'Find events near you'}
                    </Text>
                    {!nearMeLoading && (
                      <Text style={styles.nearMeSubtitle}>Tap to enable location and see what's happening close by</Text>
                    )}
                  </View>
                </Pressable>
              </View>
            )
          }

          {/* Following */}
          {renderSection(
            'From people you follow',
            <Users size={15} color={color.mute} />,
            followingEvents,
            () => router.push('/events/following' as any),
          )}

          {/* Saved */}
          {renderSection(
            'Saved',
            <Bookmark size={15} color={color.mute} />,
            savedEvents,
            () => router.push('/events/saved' as any),
          )}

          {/* Empty state when nothing loaded */}
          {!loading && !hasContent && drafts.length === 0 && (
            <View style={styles.emptyState}>
              <CalendarX size={44} color={color.faint} />
              <Text style={styles.emptyTitle}>No events yet</Text>
              <Text style={styles.emptySub}>
                Be the first — create an event for your city.
              </Text>
              <Pressable
                style={styles.emptyBtn}
                onPress={() => router.push('/events/create' as any)}
              >
                <Plus size={16} color={color.onInk} />
                <Text style={styles.emptyBtnText}>Create an event</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: color.paper },
  header:             { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised, gap: space.md },
  headerTitle:        { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  headerActions:      { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  filterBtn:          { padding: 8, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  filterBtnActive:    { backgroundColor: color.ink, borderColor: color.ink },
  filterBadge:        { position: 'absolute', top: 2, right: 2, backgroundColor: color.signal, borderRadius: 6, minWidth: 12, height: 12, alignItems: 'center', justifyContent: 'center' },
  filterBadgeText:    { fontSize: 8, color: color.onInk, fontWeight: '700' },
  createBtn:          { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill },
  createBtnText:      { ...t.small, color: color.onInk, fontWeight: '700' },

  filterDrawer:       { backgroundColor: color.paperRaised, borderBottomWidth: 1, borderBottomColor: color.haze, paddingVertical: space.sm, gap: 4 },
  chipRow:            { paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center' },
  chip:               { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: color.haze },
  chipActive:         { backgroundColor: color.ink },
  chipText:           { ...t.small, color: color.mute, fontWeight: '600' },
  chipTextActive:     { color: color.onInk },
  toggleRow:          { flexDirection: 'row', paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center', paddingBottom: space.sm },
  toggleChip:         { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  toggleChipActive:   { backgroundColor: color.signal, borderColor: color.signal },
  toggleChipText:     { ...t.small, color: color.mute, fontWeight: '600' },
  toggleChipTextActive: { color: color.onInk },
  clearFilters:       { marginLeft: 'auto' as any, paddingHorizontal: 12, paddingVertical: 6 },
  clearFiltersText:   { ...t.small, color: color.signal, fontWeight: '600' },

  invitesBanner:      { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, backgroundColor: '#F3E8FF', borderBottomWidth: 1, borderBottomColor: '#DDD6FE' },
  invitesBannerText:  { ...t.body, color: '#7C3AED', fontWeight: '600', flex: 1 },

  center:             { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  errorText:          { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn:           { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText:          { ...t.small, color: color.onInk, fontWeight: '700' },

  body:               { paddingBottom: 80 },

  section:            { paddingTop: space.lg },
  sectionHeader:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, marginBottom: space.sm },
  sectionTitleRow:    { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionTitle:       { ...t.body, color: color.ink, fontWeight: '700' },
  seeAll:             { flexDirection: 'row', alignItems: 'center', gap: 2 },
  seeAllText:         { ...t.small, color: color.signal, fontWeight: '600' },
  hList:              { paddingHorizontal: space.lg, gap: space.md, paddingRight: space.lg },
  hCard:              { width: 280 },

  draftCard:          { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.md },
  draftTitle:         { ...t.body, color: color.ink, fontWeight: '600' },
  draftMeta:          { ...t.small, color: color.faint },

  nearMePrompt:       { flexDirection: 'row', alignItems: 'center', gap: space.md, marginHorizontal: space.lg, padding: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, ...shadow.card },
  nearMeTitle:        { ...t.body, color: color.ink, fontWeight: '700' },
  nearMeSubtitle:     { ...t.small, color: color.mute, marginTop: 2 },

  emptyState:         { alignItems: 'center', paddingVertical: 80, paddingHorizontal: space.xxl, gap: space.md },
  emptyTitle:         { ...t.title, color: color.ink, fontSize: 20, fontWeight: '800' },
  emptySub:           { ...t.body, color: color.mute, textAlign: 'center', maxWidth: 280 },
  emptyBtn:           { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.pill, marginTop: space.sm, ...shadow.card },
  emptyBtnText:       { ...t.body, color: color.onInk, fontWeight: '700' },
});
