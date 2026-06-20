import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, FlatList, ScrollView, Pressable, StyleSheet, Image } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { posts as editorialPosts, me } from '../../src/data/cebu';
import { pulseFeed } from '../../src/data/pulseFeed';
import { PostCard } from '../../src/components/PostCard';
import { PulseHeader } from '../../src/components/PulseHeader';
import { FitsCard, FlexibleStrip } from '../../src/components/PulseFits';
import { PulseFeedCard } from '../../src/components/PulseFeedCard';
import { PulseFilterSheet, PulseCreateMenu, PulseFAB } from '../../src/components/PulseCreate';
import { Chip } from '../../src/components/ui';
import { TravelEmptyState } from '../../src/components/primitives';
import { useCityPulse } from '../../src/hooks/useCityPulse';
import { useGlobalFeed } from '../../src/hooks/usePosts';
import { STATUS_LABEL } from '../../src/lib/availability';
import { filterPulseFeed } from '../../src/lib/recommend';
import { PULSE_FILTERS } from '../../src/types/models';
import type { PulseFilter, PulseFeedItem } from '../../src/types/models';
import type { PostRow } from '../../src/services/posts';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

const QUICK_FILTERS: PulseFilter[] = ['All', 'Plans', 'Posts', 'Questions', 'Hidden Gems', 'Itineraries', 'Circle'];
const CURRENT_CITY = 'cebu';

/** Convert a real PostRow from the API into a PulseFeedItem for the Pulse Wall. */
function postRowToFeedItem(p: PostRow): PulseFeedItem {
  return {
    id: p.id,
    type: 'post',
    city: 'Cebu',
    author: p.author
      ? { id: p.authorId, name: p.author.name ?? p.author.handle, avatarUrl: p.author.avatarUrl ?? '' }
      : { id: p.authorId, name: 'Traveler', avatarUrl: '' },
    createdAt: p.createdAt,
    timeAgo: timeAgo(p.createdAt),
    tags: [],
    mediaUrl: p.mediaUrls[0],
    caption: p.content,
    source: 'user',
    visibility: p.visibility === 'trip_only' ? 'private' : (p.visibility as 'public' | 'private'),
  };
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Pulse() {
  const [active, setActive] = useState<PulseFilter[]>(['All']);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const { buckets, status } = useCityPulse({ currentCitySlug: CURRENT_CITY, interests: me.interests });

  // Real backend posts — refetch on screen focus so newly created posts appear immediately.
  const realFeed = useGlobalFeed();
  useFocusEffect(
    useCallback(() => {
      realFeed.reload();
    }, [realFeed.reload]),
  );

  const fits = [...buckets.fitsAvailability, ...buckets.openNearby];
  const noFits = fits.length === 0;

  // Merge real posts (prepended) with mock feed, then filter.
  const realItems = useMemo<PulseFeedItem[]>(
    () => (realFeed.data ?? []).map(postRowToFeedItem),
    [realFeed.data],
  );
  const mockFeed = useMemo(() => filterPulseFeed(pulseFeed, active), [active]);
  const feed = useMemo<PulseFeedItem[]>(() => {
    // When filtering by Posts, show only real + mock posts. Otherwise prepend real posts.
    const filteredReal = active.includes('All') || active.includes('Posts')
      ? realItems
      : realItems.filter(() => false); // real posts have type='post'; hide when other filters active
    return [...filteredReal, ...mockFeed];
  }, [realItems, mockFeed, active]);

  const filterCount = active.filter((f) => f !== 'All').length;

  function toggleQuick(f: PulseFilter) {
    if (f === 'All') { setActive(['All']); return; }
    setActive((prev) => {
      const without = prev.filter((x) => x !== 'All');
      return without.includes(f) ? (without.filter((x) => x !== f).length ? without.filter((x) => x !== f) : ['All']) : [...without, f];
    });
  }
  function toggleSheet(f: PulseFilter) {
    if (f === 'All') { setActive(['All']); return; }
    setActive((prev) => {
      const without = prev.filter((x) => x !== 'All');
      return without.includes(f) ? (without.filter((x) => x !== f).length ? without.filter((x) => x !== f) : ['All']) : [...without, f];
    });
  }

  const Header = (
    <View>
      {/* Fits your time */}
      <View style={styles.fitsHead}>
        <Text style={styles.sectionTitle}>Fits your time</Text>
        <View style={styles.insideBadge}><Text style={styles.insideText}>Inside your availability</Text></View>
        <View style={{ flex: 1 }} />
        {fits.length > 0 && (
          <Pressable onPress={() => router.push('/(tabs)/trips')}><Text style={styles.viewAll}>View all ({fits.length})</Text></Pressable>
        )}
      </View>
      {noFits ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{status === 'not_set' ? 'Set your availability to see better matches.' : 'No plans fit your availability yet.'}</Text>
          <Text style={styles.emptySub}>Check flexible options below or create a plan.</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fitsStrip}>
          {fits.map((e) => <FitsCard key={e.id} ev={e} />)}
        </ScrollView>
      )}

      {/* When you're flexible */}
      <FlexibleStrip events={buckets.flexible} />

      {/* Pulse Wall title + quick filter chips */}
      <Text style={styles.wallTitle}>Pulse Wall</Text>
      <FlatList
        data={QUICK_FILTERS}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(x) => x}
        contentContainerStyle={styles.filterRow}
        renderItem={({ item }) => (
          <Chip label={item} active={active.includes(item)} onPress={() => toggleQuick(item)} />
        )}
      />
    </View>
  );

  const Footer = (
    <View>
      {feed.length === 0 ? (
        <TravelEmptyState title="No results for these filters" sub="Try clearing a filter or switch to All." action="Clear filters" onAction={() => setActive(['All'])} />
      ) : null}
      {/* Editorial inspiration — labeled separately, not live activity */}
      <Text style={styles.inspoLabel}>INSPIRATION · EDITORIAL</Text>
      {editorialPosts.slice(0, 3).map((p) => (
        <View key={p.id} style={{ paddingHorizontal: space.lg, marginBottom: space.lg }}><PostCard post={p} /></View>
      ))}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <PulseHeader
        city="Cebu"
        availabilityText={status === 'not_set' ? 'Availability not set' : STATUS_LABEL[status]}
        filterCount={filterCount}
        onSearch={() => router.push('/(tabs)/discovery')}
        onFilter={() => setSheetOpen(true)}
        onCreate={() => setCreateOpen(true)}
      />
      <FlatList
        data={feed}
        keyExtractor={(it) => it.id}
        ListHeaderComponent={Header}
        ListFooterComponent={Footer}
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: space.lg }}>
            <PulseFeedCard item={item} />
          </View>
        )}
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      />

      <PulseFAB onPress={() => setCreateOpen(true)} />
      <PulseFilterSheet
        visible={sheetOpen}
        active={active.filter((f) => f !== 'All')}
        onToggle={toggleSheet}
        onClear={() => setActive(['All'])}
        onClose={() => setSheetOpen(false)}
      />
      <PulseCreateMenu visible={createOpen} onClose={() => setCreateOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  fitsHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, marginTop: space.lg, marginBottom: space.md, flexWrap: 'wrap' },
  sectionTitle: { ...t.title, color: color.ink, fontSize: 20 },
  insideBadge: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: 999, paddingHorizontal: space.sm, paddingVertical: 3 },
  insideText: { ...t.small, color: color.deep, fontSize: 11, fontWeight: '600' },
  viewAll: { ...t.small, color: color.signal, fontWeight: '700' },
  fitsStrip: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.sm },
  empty: { marginHorizontal: space.lg, padding: space.lg, borderRadius: 14, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  emptyTitle: { ...t.bodyStrong, color: color.ink },
  emptySub: { ...t.small, color: color.mute, marginTop: 4 },
  wallTitle: { ...t.title, color: color.ink, fontSize: 20, paddingHorizontal: space.lg, marginTop: space.xxl, marginBottom: space.md },
  filterRow: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  inspoLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.faint, letterSpacing: 1.5, paddingHorizontal: space.lg, marginTop: space.xxl, marginBottom: space.md },
});
