/**
 * Events tab — /(tabs)/events
 *
 * Sections: Today, Tomorrow, This Weekend, Near Me (GPS-gated), Following, Saved,
 * Your Drafts, Pending Invites banner, category-based rows.
 * Filter bar: date presets, city text input, radius chips, free/verified/capacity toggles,
 * category chips.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, RefreshControl, FlatList, Alert, TextInput,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Plus, CalendarX, MapPin, Navigation, ChevronRight,
  Bookmark, Users, FileEdit, Bell, Filter, Check, X,
} from 'lucide-react-native';
import {
  listEvents, listFollowingEvents, listCircleEvents, getSavedEvents, getMyDrafts, getMyEventInvites,
  saveEvent, unsaveEvent, deleteDraft,
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

function tomorrowRange(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() + 1); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setHours(23, 59, 59, 999);
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() };
}

function weekendRange(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const day = now.getDay();
  const daysUntilSat = day === 6 ? 0 : (6 - day);
  const sat = new Date(now); sat.setDate(now.getDate() + daysUntilSat); sat.setHours(0, 0, 0, 0);
  const sun = new Date(sat); sun.setDate(sat.getDate() + 1); sun.setHours(23, 59, 59, 999);
  return { dateFrom: sat.toISOString(), dateTo: sun.toISOString() };
}

function next7Range(): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const end = new Date(now); end.setDate(now.getDate() + 7); end.setHours(23, 59, 59, 999);
  return { dateFrom: now.toISOString(), dateTo: end.toISOString() };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = ['All', 'Hiking', 'Food', 'Music', 'Art', 'Nightlife', 'Sports', 'Wellness', 'Travel'];

// Categories shown as dedicated discovery rows (when no date filter is active)
const FEATURED_CATEGORIES = ['Hiking', 'Food', 'Music', 'Nightlife'];

type DatePreset = 'all' | 'today' | 'tomorrow' | 'weekend' | 'next7';
const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'all',      label: 'Any time' },
  { key: 'today',    label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'weekend',  label: 'Weekend' },
  { key: 'next7',    label: 'Next 7 days' },
];

const RADIUS_OPTIONS: { label: string; km: number }[] = [
  { label: '5 km',  km: 5 },
  { label: '25 km', km: 25 },
  { label: '50 km', km: 50 },
  { label: '100 km', km: 100 },
];

function datePresetToRange(preset: DatePreset): { dateFrom?: string; dateTo?: string } {
  if (preset === 'today')    return todayRange();
  if (preset === 'tomorrow') return tomorrowRange();
  if (preset === 'weekend')  return weekendRange();
  if (preset === 'next7')    return next7Range();
  return {};
}

function formatDraftDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const STEP_LABELS_MAP: Record<DatePreset, string> = {
  all:      'Upcoming',
  today:    'Today',
  tomorrow: 'Tomorrow',
  weekend:  'This Weekend',
  next7:    'Next 7 Days',
};

export default function EventsTabScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, configured } = useSession();
  const { locationState, requestLocation } = useActiveLocation();

  const [refreshing, setRefreshing] = useState(false);

  // ── Discovery events ──────────────────────────────────────────────────────
  const [todayEvents, setTodayEvents]         = useState<EventListItem[]>([]);
  const [tomorrowEvents, setTomorrowEvents]   = useState<EventListItem[]>([]);
  const [weekendEvents, setWeekendEvents]     = useState<EventListItem[]>([]);
  const [nearMeEvents, setNearMeEvents]       = useState<EventListItem[]>([]);
  const [followingEvents, setFollowingEvents] = useState<EventListItem[]>([]);
  const [circleEvents, setCircleEvents]       = useState<EventListItem[]>([]);
  const [savedEvents, setSavedEvents]         = useState<EventListItem[]>([]);
  const [drafts, setDrafts]                   = useState<EventDraft[]>([]);
  const [pendingInvites, setPendingInvites]   = useState<EventInvite[]>([]);
  const [categoryRows, setCategoryRows]       = useState<Record<string, EventListItem[]>>({});
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState<string | null>(null);

  // ── Filters ────────────────────────────────────────────────────────────────
  const [showFilters, setShowFilters]         = useState(false);
  const [category, setCategory]               = useState('All');
  const [datePreset, setDatePreset]           = useState<DatePreset>('all');
  const [cityInput, setCityInput]             = useState('');
  const [cityFilter, setCityFilter]           = useState('');
  const [radiusKm, setRadiusKm]               = useState(25);
  const [freeOnly, setFreeOnly]               = useState(false);
  const [verifiedHostOnly, setVerifiedHostOnly] = useState(false);
  const [capacityAvailable, setCapacityAvailable] = useState(false);

  // ── Near-me location request ───────────────────────────────────────────────
  const [nearMeRequested, setNearMeRequested] = useState(false);
  const [nearMeLoading, setNearMeLoading]     = useState(false);

  // ── Optimistic save state ──────────────────────────────────────────────────
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // Per-event in-flight lock — Set so different events can be saved concurrently
  const savingLockRef = useRef(new Set<string>());

  const activeFilters =
    (category !== 'All' ? 1 : 0) +
    (freeOnly ? 1 : 0) +
    (verifiedHostOnly ? 1 : 0) +
    (capacityAvailable ? 1 : 0) +
    (datePreset !== 'all' ? 1 : 0) +
    (cityFilter ? 1 : 0);

  const load = useCallback(async (isRefresh = false) => {
    if (!configured || !isAuthed) { setLoading(false); return; }
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    const cat = category !== 'All' ? category : undefined;
    const dateRange = datePresetToRange(datePreset);
    const city = cityFilter || undefined;
    const sharedFilters = {
      category: cat,
      city,
      free: freeOnly || undefined,
      verifiedHostOnly: verifiedHostOnly || undefined,
      capacityAvailable: capacityAvailable || undefined,
    };

    // When a specific preset is active, fetch only one range (avoid duplicate sections)
    const isPresetActive = datePreset !== 'all';
    const mainParams = isPresetActive ? dateRange : todayRange();

    const [mainRes, tomorrowRes, weekendRes, followRes, circleRes, savedRes, draftsRes, invitesRes] = await Promise.all([
      listEvents({ ...mainParams, ...sharedFilters, limit: 10 }),
      isPresetActive ? Promise.resolve({ ok: true as const, data: { events: [] as EventListItem[] } }) : listEvents({ ...tomorrowRange(), ...sharedFilters, limit: 10 }),
      isPresetActive ? Promise.resolve({ ok: true as const, data: { events: [] as EventListItem[] } }) : listEvents({ ...weekendRange(), ...sharedFilters, limit: 10 }),
      listFollowingEvents({ limit: 10 }),
      listCircleEvents({ limit: 10 }),
      getSavedEvents(1),
      getMyDrafts(),
      getMyEventInvites(),
    ]);

    if (mainRes.ok) setTodayEvents(mainRes.data?.events ?? []);
    if (tomorrowRes.ok) setTomorrowEvents(tomorrowRes.data?.events ?? []);
    if (weekendRes.ok) setWeekendEvents(weekendRes.data?.events ?? []);
    if (followRes.ok) setFollowingEvents(followRes.data?.events ?? []);
    if (circleRes.ok) setCircleEvents(circleRes.data?.events ?? []);
    if (savedRes.ok) {
      const evs = savedRes.data?.events ?? [];
      setSavedEvents(evs);
      setSavedIds(new Set(evs.map((e) => e.id)));
    }
    if (draftsRes.ok) setDrafts(draftsRes.data?.drafts ?? []);
    if (invitesRes.ok) setPendingInvites((invitesRes.data?.invites ?? []).filter((i) => i.status === 'pending'));

    // Category discovery rows — only when no category filter and no date preset
    if (datePreset === 'all' && category === 'All') {
      const catResults = await Promise.all(
        FEATURED_CATEGORIES.map((c) => listEvents({ category: c, free: freeOnly || undefined, city, limit: 8 })),
      );
      const rows: Record<string, EventListItem[]> = {};
      FEATURED_CATEGORIES.forEach((c, i) => {
        if (catResults[i].ok) rows[c] = catResults[i].data?.events ?? [];
      });
      setCategoryRows(rows);
    } else {
      setCategoryRows({});
    }

    if (!mainRes.ok && !weekendRes.ok) setError('Failed to load events');
    setLoading(false);
    setRefreshing(false);
  }, [configured, isAuthed, category, datePreset, cityFilter, freeOnly, verifiedHostOnly, capacityAvailable]);

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
      nearRadiusKm: radiusKm,
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
    if (savingLockRef.current.has(ev.id)) return;
    savingLockRef.current.add(ev.id);
    const wasSaved = savedIds.has(ev.id);
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (wasSaved) next.delete(ev.id); else next.add(ev.id);
      return next;
    });
    try {
      if (wasSaved) {
        await unsaveEvent(ev.id);
        setSavedEvents((prev) => prev.filter((e) => e.id !== ev.id));
      } else {
        await saveEvent(ev.id);
      }
    } finally {
      savingLockRef.current.delete(ev.id);
    }
  }

  // ── City search submit ─────────────────────────────────────────────────────
  function handleCitySubmit() {
    setCityFilter(cityInput.trim());
  }

  function clearCityFilter() {
    setCityInput('');
    setCityFilter('');
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
                isSaved={savedIds.has(item.id)}
                onToggleSave={() => handleSaveToggle(item)}
              />
            </View>
          )}
        />
      </View>
    );
  }

  const hasContent =
    todayEvents.length > 0 || tomorrowEvents.length > 0 ||
    weekendEvents.length > 0 || nearMeEvents.length > 0 ||
    followingEvents.length > 0 || circleEvents.length > 0 ||
    savedEvents.length > 0 ||
    Object.values(categoryRows).some((r) => r.length > 0);

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

          {/* City text input */}
          <View style={styles.cityRow}>
            <MapPin size={14} color={color.mute} />
            <TextInput
              style={styles.cityInput}
              placeholder="Filter by city (e.g. Paris)"
              placeholderTextColor={color.faint}
              value={cityInput}
              onChangeText={setCityInput}
              onSubmitEditing={handleCitySubmit}
              returnKeyType="search"
            />
            {cityInput.length > 0 && (
              <Pressable onPress={clearCityFilter} hitSlop={8}>
                <X size={14} color={color.mute} />
              </Pressable>
            )}
            {cityInput.length > 0 && cityInput !== cityFilter && (
              <Pressable style={styles.citySearchBtn} onPress={handleCitySubmit}>
                <Text style={styles.citySearchBtnText}>Search</Text>
              </Pressable>
            )}
          </View>

          {/* Radius chips — shown when near-me has results or location is available */}
          {(nearMeEvents.length > 0 || locationState.coords) && (
            <ScrollView
              horizontal showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              <Text style={styles.chipLabel}>Radius:</Text>
              {RADIUS_OPTIONS.map((r) => (
                <Pressable
                  key={r.km}
                  style={[styles.chip, radiusKm === r.km && styles.chipActive]}
                  onPress={() => { setRadiusKm(r.km); if (locationState.coords) handleNearMeRequest(); }}
                >
                  <Text style={[styles.chipText, radiusKm === r.km && styles.chipTextActive]}>{r.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

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
            <Pressable
              style={[styles.toggleChip, capacityAvailable && styles.toggleChipActive]}
              onPress={() => setCapacityAvailable((v) => !v)}
            >
              {capacityAvailable && <Check size={12} color={color.onInk} />}
              <Text style={[styles.toggleChipText, capacityAvailable && styles.toggleChipTextActive]}>Spots available</Text>
            </Pressable>
            {activeFilters > 0 && (
              <Pressable
                style={styles.clearFilters}
                onPress={() => {
                  setCategory('All');
                  setDatePreset('all');
                  setFreeOnly(false);
                  setVerifiedHostOnly(false);
                  setCapacityAvailable(false);
                  clearCityFilter();
                }}
              >
                <Text style={styles.clearFiltersText}>Clear all</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      {/* Active city filter pill */}
      {cityFilter ? (
        <View style={styles.activeCityPill}>
          <MapPin size={12} color={color.signal} />
          <Text style={styles.activeCityText}>{cityFilter}</Text>
          <Pressable onPress={clearCityFilter} hitSlop={8}>
            <X size={12} color={color.signal} />
          </Pressable>
        </View>
      ) : null}

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
                  <Pressable
                    hitSlop={12}
                    onPress={() =>
                      Alert.alert('Discard draft?', 'This draft will be permanently deleted.', [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Discard', style: 'destructive',
                          onPress: async () => {
                            await deleteDraft(d.id);
                            setDrafts((prev) => prev.filter((x) => x.id !== d.id));
                          },
                        },
                      ])
                    }
                    style={styles.draftDiscardBtn}
                  >
                    <Text style={styles.draftDiscardText}>Discard</Text>
                  </Pressable>
                  <ChevronRight size={14} color={color.mute} />
                </Pressable>
              ))}
            </View>
          )}

          {/* Today */}
          {renderSection(
            datePreset === 'all' ? 'Today' : STEP_LABELS_MAP[datePreset] ?? 'Today',
            <CalendarX size={15} color={color.mute} />,
            todayEvents,
          )}

          {/* Tomorrow — only when preset is 'all' */}
          {datePreset === 'all' && renderSection(
            'Tomorrow',
            <CalendarX size={15} color={color.mute} />,
            tomorrowEvents,
          )}

          {/* This Weekend — only shown when preset is 'all' */}
          {datePreset === 'all' && renderSection(
            'This Weekend',
            <CalendarX size={15} color={color.mute} />,
            weekendEvents,
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
          )}

          {/* Circle Events */}
          {renderSection(
            'Circle Events',
            <Users size={15} color={color.signal} />,
            circleEvents,
          )}

          {/* Category discovery rows — only when no category filter and no date preset */}
          {datePreset === 'all' && category === 'All' && FEATURED_CATEGORIES.map((cat) => {
            const items = categoryRows[cat] ?? [];
            if (items.length === 0) return null;
            return renderSection(
              cat,
              <CalendarX size={15} color={color.mute} />,
              items,
              () => { setCategory(cat); setShowFilters(true); },
            );
          })}

          {/* Saved */}
          {renderSection(
            'Saved',
            <Bookmark size={15} color={color.mute} />,
            savedEvents,
          )}

          {/* Empty states */}
          {!loading && !hasContent && drafts.length === 0 && (
            error ? (
              <View style={styles.emptyState}>
                <CalendarX size={44} color={color.faint} />
                <Text style={styles.emptyTitle}>Couldn't load events</Text>
                <Text style={styles.emptySub}>{error}</Text>
                <Pressable style={styles.emptyBtn} onPress={() => load(false)}>
                  <Text style={styles.emptyBtnText}>Try again</Text>
                </Pressable>
              </View>
            ) : !isAuthed ? (
              <View style={styles.emptyState}>
                <CalendarX size={44} color={color.faint} />
                <Text style={styles.emptyTitle}>Sign in to see events</Text>
                <Text style={styles.emptySub}>Discover events from travellers around you.</Text>
              </View>
            ) : nearMeRequested && !locationState.coords ? (
              <View style={styles.emptyState}>
                <MapPin size={44} color={color.faint} />
                <Text style={styles.emptyTitle}>Location not available</Text>
                <Text style={styles.emptySub}>
                  Enable location in your device settings to find events near you, or browse by city.
                </Text>
              </View>
            ) : (
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
            )
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
  chipLabel:          { ...t.small, color: color.mute, fontWeight: '600' },
  chip:               { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: color.haze },
  chipActive:         { backgroundColor: color.ink },
  chipText:           { ...t.small, color: color.mute, fontWeight: '600' },
  chipTextActive:     { color: color.onInk },

  cityRow:            { flexDirection: 'row', alignItems: 'center', marginHorizontal: space.lg, marginVertical: 4, paddingHorizontal: space.md, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper, gap: 8 },
  cityInput:          { flex: 1, ...t.small, color: color.ink, padding: 0 },
  citySearchBtn:      { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: color.signal, borderRadius: radius.pill },
  citySearchBtnText:  { ...t.stamp, color: color.onInk, fontWeight: '700' },

  activeCityPill:     { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginHorizontal: space.lg, marginTop: 6, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#EEF2FF', borderRadius: radius.pill, borderWidth: 1, borderColor: '#C7D2FE' },
  activeCityText:     { ...t.stamp, color: color.signal, fontWeight: '600' },

  toggleRow:          { flexDirection: 'row', paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center', paddingBottom: space.sm, flexWrap: 'wrap' },
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
  draftDiscardBtn:    { paddingHorizontal: space.sm, paddingVertical: 4 },
  draftDiscardText:   { ...t.small, color: '#DC2626', fontWeight: '600' },
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
