/**
 * Location Memory Feed — /memory/location
 *
 * Shows all public memories tagged with the same city/country
 * (or canonicalLocationId when present). Reached by tapping a
 * location chip on a memory card or detail screen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, FlatList, StyleSheet,
  ActivityIndicator, Image,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, MapPin, BookImage } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { getMemoryFeed, type Memory, type MemoryFeedFilter } from '../../src/services/memories';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../../src/hooks/useNavBarCollapse';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

// ── Memory card row ────────────────────────────────────────────────────────────

function MemoryRow({ memory }: { memory: Memory }) {
  return (
    <Pressable
      style={row.wrap}
      onPress={() => router.push(`/memory/${memory.id}` as any)}
    >
      {memory.cover?.mediaUrl ? (
        <Image source={{ uri: memory.cover.mediaUrl }} style={row.thumb} />
      ) : (
        <View style={[row.thumb, row.thumbFallback]}>
          <BookImage size={20} color={color.onInk} />
        </View>
      )}
      <View style={row.body}>
        <Text style={row.title} numberOfLines={1}>
          {memory.title ?? 'Untitled Memory'}
        </Text>
        {memory.owner?.name ? (
          <Text style={row.owner} numberOfLines={1}>{memory.owner.name}</Text>
        ) : null}
        <Text style={row.date}>{formatDate(memory.createdAt)}</Text>
        {(memory.likeCount ?? 0) > 0 ? (
          <Text style={row.likes}>♥ {memory.likeCount}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const row = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: radius.md,
    backgroundColor: color.haze,
  },
  thumbFallback: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, gap: 3, justifyContent: 'center' },
  title: { ...t.bodyStrong, color: color.ink },
  owner: { ...t.small, color: color.mute },
  date: { ...t.small, color: color.faint },
  likes: { ...t.small, color: color.signal, fontWeight: '600' },
});

// ── Screen ─────────────────────────────────────────────────────────────────────

export default function LocationMemoryFeedScreen() {
  const insets = useSafeAreaInsets();
  const navBarScrollHandler = useNavBarScrollHandler();
  const {
    label,
    city,
    country,
    canonicalLocationId,
  } = useLocalSearchParams<{
    label?: string;
    city?: string;
    country?: string;
    canonicalLocationId?: string;
  }>();

  const displayLabel = label
    ?? [city, country].filter(Boolean).join(', ')
    ?? 'Location';

  const filter: MemoryFeedFilter = {
    city: city ?? null,
    country: country ?? null,
    canonicalLocationId: canonicalLocationId ?? null,
  };

  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  const loadPage = useCallback(async (before?: string | null) => {
    if (before) setLoadingMore(true);
    else { setLoading(true); setError(null); }

    const res = await getMemoryFeed(20, before ?? null, filter);

    if (before) setLoadingMore(false);
    else setLoading(false);

    if (res.ok) {
      if (before) {
        setMemories((prev) => {
          const next = [...prev, ...res.memories];
          setTotalCount(next.length);
          return next;
        });
      } else {
        setMemories(res.memories);
        setTotalCount(res.memories.length);
      }
      setCursor(res.nextCursor);
      setHasMore(!!res.nextCursor);
    } else {
      setError(res.message);
    }
  // filter is derived from search params — stable for the lifetime of this screen
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, country, canonicalLocationId]);

  useEffect(() => {
    loadPage();
  }, [loadPage]);

  // ── Header (always rendered) ───────────────────────────────────────────────

  const header = (
    <View style={[s.topBar, { paddingTop: insets.top + space.sm }]}>
      <Pressable onPress={() => router.back()} hitSlop={10}>
        <ArrowLeft size={22} color={color.ink} />
      </Pressable>
      <View style={s.topBarCenter}>
        <View style={s.locationLabel}>
          <MapPin size={14} color={color.signal} />
          <Text style={s.topTitle} numberOfLines={1}>{displayLabel}</Text>
        </View>
        <Text style={s.topSub}>
          {totalCount === null
            ? 'Memories from this place'
            : totalCount === 1
              ? '1 memory'
              : `${totalCount} memories`}
        </Text>
      </View>
      {/* right spacer to balance the back arrow */}
      <View style={{ width: 22 }} />
    </View>
  );

  if (loading) {
    return (
      <View style={s.container}>
        {header}
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={s.container}>
        {header}
        <View style={s.center}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable style={s.retryBtn} onPress={() => loadPage()}>
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {header}
      <FlatList
        data={memories}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MemoryRow memory={item} />}
        contentContainerStyle={s.list}
        showsVerticalScrollIndicator={false}
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
        ItemSeparatorComponent={() => <View style={s.divider} />}
        onEndReached={() => {
          if (hasMore && !loadingMore && cursor) loadPage(cursor);
        }}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          <>
            {loadingMore ? (
              <View style={s.footerLoader}>
                <ActivityIndicator size="small" color={color.signal} />
              </View>
            ) : null}
            <NavBarFiller />
          </>
        }
        ListEmptyComponent={
          <View style={s.emptyWrap}>
            <MapPin size={28} color={color.haze} />
            <Text style={s.emptyTitle}>No memories here yet</Text>
            <Text style={s.emptySub}>
              Be the first to share a memory from {displayLabel}.
            </Text>
          </View>
        }
      />
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.paper },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  topBarCenter: { flex: 1, alignItems: 'center', gap: 2 },
  locationLabel: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  topTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  topSub: { ...t.small, color: color.mute },

  list: { flexGrow: 1 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.haze, marginLeft: space.lg },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  errorText: { ...t.body, color: color.mute, textAlign: 'center', marginBottom: space.md },
  retryBtn: {
    paddingHorizontal: space.lg, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.haze,
  },
  retryText: { ...t.small, color: color.ink, fontWeight: '700' },

  emptyWrap: {
    paddingTop: 60, alignItems: 'center', gap: space.md,
    paddingHorizontal: space.xl,
  },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },

  footerLoader: { paddingVertical: space.xl, alignItems: 'center' },
});
