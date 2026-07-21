/**
 * Destination page — /destination/[slug]
 *
 * Minimal REAL destination page (replaces the "coming soon" placeholder that
 * dead-ended the destination chip on every post card). Built entirely from
 * existing services — no new backend:
 *   - Hidden Gems for the city  (listGems)
 *   - Upcoming events           (listEvents)
 *   - Recent traveler posts     (getPulseData)
 *
 * Each section loads independently: one failing section never takes down the
 * screen (spec §51). Empty sections hide; if everything is empty the page
 * says so honestly and offers Discover.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, Image, Pressable, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, MapPin, Gem, CalendarDays, Compass } from 'lucide-react-native';
import { listGems, type HiddenGem } from '../../src/services/hiddenGems';
import { listEvents, type EventListItem } from '../../src/services/events';
import { getPulseData, type PulsePost } from '../../src/services/pulse';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { usePlainBottomInset } from '../../src/hooks/useBottomInset';
import { CityConfidenceBadge } from '../../src/components/compass/CityConfidenceBadge';

type SectionState<T> = { status: 'loading' | 'ready' | 'error'; items: T[] };

function fmtEventDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch { return ''; }
}

export default function Destination() {
  const plainInset = usePlainBottomInset();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const cityName = slug
    ? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Destination';

  const [gems, setGems] = useState<SectionState<HiddenGem>>({ status: 'loading', items: [] });
  const [events, setEvents] = useState<SectionState<EventListItem>>({ status: 'loading', items: [] });
  const [posts, setPosts] = useState<SectionState<PulsePost>>({ status: 'loading', items: [] });

  const loadGems = useCallback(async () => {
    setGems({ status: 'loading', items: [] });
    try {
      const items = await listGems({ city: cityName, limit: 10 });
      setGems({ status: 'ready', items: items ?? [] });
    } catch {
      setGems({ status: 'error', items: [] });
    }
  }, [cityName]);

  const loadEvents = useCallback(async () => {
    setEvents({ status: 'loading', items: [] });
    try {
      const res = await listEvents({ city: cityName, limit: 10 });
      if (res.ok && res.data) setEvents({ status: 'ready', items: res.data.events ?? [] });
      else setEvents({ status: 'error', items: [] });
    } catch {
      setEvents({ status: 'error', items: [] });
    }
  }, [cityName]);

  const loadPosts = useCallback(async () => {
    setPosts({ status: 'loading', items: [] });
    try {
      const res = await getPulseData({ city: cityName, limit: 12 });
      if (res.ok) setPosts({ status: 'ready', items: res.data.posts ?? [] });
      else setPosts({ status: 'error', items: [] });
    } catch {
      setPosts({ status: 'error', items: [] });
    }
  }, [cityName]);

  useEffect(() => { loadGems(); loadEvents(); loadPosts(); }, [loadGems, loadEvents, loadPosts]);

  const anyLoading = gems.status === 'loading' || events.status === 'loading' || posts.status === 'loading';
  const allEmpty =
    !anyLoading &&
    gems.items.length === 0 && events.items.length === 0 && posts.items.length === 0 &&
    gems.status !== 'error' && events.status !== 'error' && posts.status !== 'error';

  const SectionError = ({ onRetry }: { onRetry: () => void }) => (
    <Pressable style={s.sectionError} onPress={onRetry} accessibilityRole="button">
      <Text style={s.sectionErrorText}>Couldn't load — tap to retry</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={s.back} accessibilityLabel="Back">
          <ChevronLeft size={24} color={color.ink} />
        </Pressable>
        <Text style={s.title} numberOfLines={1}>{cityName}</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: plainInset }} showsVerticalScrollIndicator={false}>
        {/* City hero strip */}
        <View style={s.hero}>
          <MapPin size={16} color={color.deep} />
          <Text style={s.heroText}>Traveler guide to {cityName}</Text>
        </View>

        {/* Local data depth honesty signal */}
        <CityConfidenceBadge city={slug ? cityName : null} />

        {/* ── Hidden Gems ── */}
        {gems.status === 'error' ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Hidden Gems</Text>
            <SectionError onRetry={loadGems} />
          </View>
        ) : gems.status === 'loading' ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Hidden Gems</Text>
            <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.md }} />
          </View>
        ) : gems.items.length > 0 ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Hidden Gems</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rail}>
              {gems.items.map((g) => (
                <Pressable
                  key={g.id}
                  style={s.gemCard}
                  onPress={() => router.push(`/gems/${g.id}` as any)}
                  accessibilityRole="button"
                  accessibilityLabel={`Hidden gem: ${g.name}`}
                >
                  <View style={s.gemIcon}><Gem size={16} color={color.deep} /></View>
                  <Text style={s.gemName} numberOfLines={2}>{g.name}</Text>
                  {g.neighborhood ? <Text style={s.gemMeta} numberOfLines={1}>{g.neighborhood}</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {/* ── Upcoming events ── */}
        {events.status === 'error' ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Events</Text>
            <SectionError onRetry={loadEvents} />
          </View>
        ) : events.status === 'loading' ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Events</Text>
            <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.md }} />
          </View>
        ) : events.items.length > 0 ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Events</Text>
            {events.items.slice(0, 6).map((ev) => (
              <Pressable
                key={ev.id}
                style={s.eventRow}
                onPress={() => router.push(`/event/${ev.id}` as any)}
                accessibilityRole="button"
                accessibilityLabel={`Event: ${ev.title}`}
              >
                {ev.coverUrl ? (
                  <Image source={{ uri: ev.coverUrl }} style={s.eventThumb} />
                ) : (
                  <View style={[s.eventThumb, s.eventThumbFallback]}>
                    <CalendarDays size={16} color={color.mute} />
                  </View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.eventTitle} numberOfLines={1}>{ev.title}</Text>
                  <Text style={s.eventMeta} numberOfLines={1}>
                    {[fmtEventDate(ev.startsAt), ev.locationName].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* ── Recent traveler posts ── */}
        {posts.status === 'error' ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>From Travelers</Text>
            <SectionError onRetry={loadPosts} />
          </View>
        ) : posts.status === 'loading' ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>From Travelers</Text>
            <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.md }} />
          </View>
        ) : posts.items.length > 0 ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>From Travelers</Text>
            <View style={s.postGrid}>
              {posts.items.filter((p) => p.mediaUrls?.[0] || p.media?.[0]).slice(0, 6).map((p) => {
                const uri = p.media?.[0]?.thumbnail_url ?? p.media?.[0]?.url ?? p.mediaUrls?.[0];
                return (
                  <Pressable
                    key={p.id}
                    style={s.postTile}
                    onPress={() => router.push(`/post/${p.id}` as any)}
                    accessibilityRole="button"
                    accessibilityLabel="Traveler post"
                  >
                    {uri ? <Image source={{ uri }} style={s.postImg} /> : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        {/* ── Honest all-empty state ── */}
        {allEmpty ? (
          <View style={s.empty}>
            <View style={s.emptyIcon}><MapPin size={30} color={color.deep} /></View>
            <Text style={s.emptyTitle}>Quiet in {cityName} — for now</Text>
            <Text style={s.emptySub}>
              No gems, events, or traveler posts here yet. Be the first to put {cityName} on the map.
            </Text>
          </View>
        ) : null}

        {/* Explore more */}
        <Pressable
          style={s.discoverBtn}
          onPress={() => router.push('/(tabs)/discovery' as any)}
          accessibilityRole="button"
          accessibilityLabel="Explore more in Discover"
        >
          <Compass size={16} color={color.onInk} />
          <Text style={s.discoverText}>Explore more in Discover</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: 56, paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
  },
  back: { padding: 4 },
  title: { ...t.bodyStrong, color: color.ink, flex: 1, textAlign: 'center', fontSize: 16 },

  hero: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  heroText: { ...t.small, color: color.mute },

  section: { paddingTop: space.md },
  sectionTitle: { ...t.heading, color: color.ink, fontSize: 17, paddingHorizontal: space.lg, marginBottom: space.sm },
  sectionError: {
    marginHorizontal: space.lg, paddingVertical: space.md, alignItems: 'center',
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, backgroundColor: color.paperRaised,
  },
  sectionErrorText: { ...t.small, color: color.mute },

  rail: { paddingHorizontal: space.lg, gap: space.sm },
  gemCard: {
    width: 132, padding: space.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, gap: 6,
  },
  gemIcon: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: color.paper,
    borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  gemName: { ...t.small, fontWeight: '700', color: color.ink, lineHeight: 17 },
  gemMeta: { ...t.small, color: color.mute, fontSize: 11 },

  eventRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: 8,
  },
  eventThumb: { width: 48, height: 48, borderRadius: radius.sm, backgroundColor: color.haze },
  eventThumbFallback: { alignItems: 'center', justifyContent: 'center' },
  eventTitle: { ...t.body, fontWeight: '600', color: color.ink },
  eventMeta: { ...t.small, color: color.mute, marginTop: 1 },

  postGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: space.lg },
  postTile: {
    width: '31.5%', aspectRatio: 1, borderRadius: radius.sm,
    overflow: 'hidden', backgroundColor: color.haze,
  },
  postImg: { width: '100%', height: '100%' },

  empty: { alignItems: 'center', paddingVertical: space.xxl, paddingHorizontal: space.xl, gap: space.sm },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: color.paperRaised,
    borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: { ...t.bodyStrong, color: color.ink, fontSize: 16, textAlign: 'center' },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 20 },

  discoverBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginHorizontal: space.lg, marginTop: space.lg, minHeight: 44,
    borderRadius: radius.pill, backgroundColor: color.signal,
  },
  discoverText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
});
