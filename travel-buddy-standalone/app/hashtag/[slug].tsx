/**
 * Hashtag Feed — /hashtag/:slug
 *
 * Shows all content tagged with a given hashtag across tabs:
 *   Top | Recent | Events | People | Places | Circles | Trips
 *
 * Scope filter: Global | Current City | Nearby
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, Pressable, FlatList, StyleSheet, ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import { Avatar } from '../../src/components/ui/Avatar';
import { CachedImage } from '../../src/components/CachedImage';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, Hash, MapPin, Calendar, Users, Map, Plane, Flag,
} from 'lucide-react-native';
import { SaveButton } from '../../src/components/SaveButton';
import { color, space, radius, type as t, shadow, avatar } from '../../src/theme/tokens';
import {
  getHashtag, getHashtagFeed, followHashtag, unfollowHashtag, reportHashtag,
  type HashtagMeta, type FeedItem, type FeedTab, type FeedScope,
  type FeedPostItem, type FeedUserItem, type FeedEventItem,
  type FeedPlaceItem, type FeedCircleItem, type FeedTripItem,
  type HashtagReportReason,
} from '../../src/services/hashtag';
import { RichText } from '../../src/components/RichText';
import { useLocationContext } from '../../src/context/LocationContext';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../../src/hooks/useNavBarCollapse';

// ── Tab config ─────────────────────────────────────────────────────────────────

const TABS: { key: FeedTab; label: string }[] = [
  { key: 'top',     label: 'Top' },
  { key: 'recent',  label: 'Recent' },
  { key: 'events',  label: 'Events' },
  { key: 'people',  label: 'People' },
  { key: 'places',  label: 'Places' },
  { key: 'circles', label: 'Circles' },
  { key: 'trips',   label: 'Trips' },
];

const SCOPES: { key: FeedScope; label: string }[] = [
  { key: 'global',  label: 'Global' },
  { key: 'city',    label: 'Current City' },
  { key: 'nearby',  label: 'Nearby' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── Feed item renderers ────────────────────────────────────────────────────────

function PostRow({ item }: { item: FeedPostItem }) {
  return (
    <Pressable
      style={fr.row}
      onPress={() => router.push(`/post/${item.id}` as any)}
    >
      {item.mediaUrls.length > 0 && (
        <CachedImage source={{ uri: item.mediaUrls[0] }} style={fr.postThumb} fallbackLabel="" />
      )}
      <View style={fr.postBody}>
        {item.author && (
          <Pressable
            style={fr.authorRow}
            onPress={() => router.push(`/u/${item.author!.handle}` as any)}
          >
            <Avatar
              uri={item.author.avatarUrl}
              name={item.author.name ?? item.author.handle}
              size={24}
            />
            <Text style={fr.authorName}>{item.author.name ?? item.author.handle}</Text>
            <Text style={fr.meta}>{timeAgo(item.createdAt)}</Text>
          </Pressable>
        )}
        <RichText content={item.content} tags={item.tags} hashtagUsages={item.hashtagUsages} style={fr.postContent} numberOfLines={3} />
        <View style={fr.statRow}>
          <Text style={fr.stat}>♡ {item.likeCount}</Text>
          <Text style={fr.stat}>💬 {item.commentCount}</Text>
        </View>
      </View>
    </Pressable>
  );
}

function UserRow({ item }: { item: FeedUserItem }) {
  return (
    <Pressable
      style={fr.row}
      onPress={() => router.push(`/u/${item.handle}` as any)}
    >
      <Avatar uri={item.avatarUrl} name={item.name ?? item.handle} size={44} />
      <View style={fr.rowInfo}>
        <Text style={fr.rowTitle}>{item.name ?? item.handle}</Text>
        <Text style={fr.rowSub}>@{item.handle}</Text>
      </View>
    </Pressable>
  );
}

function EventRow({ item }: { item: FeedEventItem }) {
  const dateStr = item.startAt
    ? new Date(item.startAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;
  return (
    <View style={fr.row}>
      <View style={[fr.typeIcon, { backgroundColor: '#8B5CF6' + '18' }]}>
        <Calendar size={18} color="#8B5CF6" />
      </View>
      <View style={fr.rowInfo}>
        <Text style={fr.rowTitle} numberOfLines={1}>{item.name}</Text>
        {(item.location || dateStr) && (
          <Text style={fr.rowSub} numberOfLines={1}>
            {[dateStr, item.location].filter(Boolean).join(' · ')}
          </Text>
        )}
      </View>
    </View>
  );
}

function PlaceRow({ item }: { item: FeedPlaceItem }) {
  return (
    <View style={fr.row}>
      {item.imageUrl ? (
        <CachedImage source={{ uri: item.imageUrl }} style={fr.placeThumb} fallbackLabel="" />
      ) : (
        <View style={[fr.typeIcon, { backgroundColor: color.success + '18' }]}>
          <MapPin size={18} color={color.success} />
        </View>
      )}
      <View style={fr.rowInfo}>
        <Text style={fr.rowTitle} numberOfLines={1}>{item.name}</Text>
        {(item.city || item.placeType) && (
          <Text style={fr.rowSub} numberOfLines={1}>
            {[item.city, item.placeType].filter(Boolean).join(' · ')}
          </Text>
        )}
      </View>
    </View>
  );
}

function CircleRow({ item }: { item: FeedCircleItem }) {
  return (
    <View style={fr.row}>
      <View style={[fr.typeIcon, { backgroundColor: color.warn + '18' }]}>
        <Users size={18} color={color.warn} />
      </View>
      <View style={fr.rowInfo}>
        <Text style={fr.rowTitle} numberOfLines={1}>{item.name}</Text>
        <Text style={fr.rowSub}>Circle</Text>
      </View>
    </View>
  );
}

function TripRow({ item }: { item: FeedTripItem }) {
  return (
    <Pressable
      style={fr.row}
      onPress={() => router.push(`/trip/${item.id}` as any)}
    >
      <View style={[fr.typeIcon, { backgroundColor: color.deep + '18' }]}>
        <Plane size={18} color={color.deep} />
      </View>
      <View style={fr.rowInfo}>
        <Text style={fr.rowTitle} numberOfLines={1}>{item.name}</Text>
        {item.destination && (
          <Text style={fr.rowSub} numberOfLines={1}>{item.destination}</Text>
        )}
      </View>
    </Pressable>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  if (item.type === 'post')    return <PostRow   item={item as FeedPostItem} />;
  if (item.type === 'user')    return <UserRow   item={item as FeedUserItem} />;
  if (item.type === 'event')   return <EventRow  item={item as FeedEventItem} />;
  if (item.type === 'place')   return <PlaceRow  item={item as FeedPlaceItem} />;
  if (item.type === 'circle')  return <CircleRow item={item as FeedCircleItem} />;
  if (item.type === 'trip')    return <TripRow   item={item as FeedTripItem} />;
  return null;
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function HashtagFeedScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const insets = useSafeAreaInsets();
  const { locationState } = useLocationContext();
  const navBarScrollHandler = useNavBarScrollHandler();

  const [meta, setMeta] = useState<HashtagMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);

  const [activeTab, setActiveTab] = useState<FeedTab>('recent');
  const [scope, setScope] = useState<FeedScope>('global');

  const [items, setItems] = useState<FeedItem[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!slug) return;
    setMetaLoading(true);
    getHashtag(slug).then((res) => {
      setMetaLoading(false);
      if (res.ok && res.data) {
        setMeta(res.data);
        setFollowing(res.data.isFollowing);
      } else {
        setUnavailable(true);
      }
    });
  }, [slug]);

  const loadFeed = useCallback(
    async (tab: FeedTab, sc: FeedScope, before?: string | null) => {
      if (!slug) return;
      if (before) {
        setLoadingMore(true);
      } else {
        setFeedLoading(true);
        setFeedError(null);
      }
      // Pass city for scoped requests — locationState.place.city comes from GPS or manual selection.
      const city = (sc === 'city' || sc === 'nearby') ? (locationState.place.city ?? null) : null;
      const res = await getHashtagFeed(slug, tab, sc, city, before ?? null);
      if (before) {
        setLoadingMore(false);
      } else {
        setFeedLoading(false);
      }
      if (res.ok && res.data) {
        if (before) {
          setItems((prev) => [...prev, ...res.data!.items]);
        } else {
          setItems(res.data.items);
        }
        setHasMore(res.data.hasMore);
        // Use the backend-provided cursor (oldest usage row's created_at).
        // This works across all tabs — post/people/places/circles/trips/events —
        // because the cursor comes from hashtag_usage.created_at, not the entity.
        setCursor(res.data.nextCursor ?? null);
      } else {
        setFeedError(res.error ?? 'Failed to load feed');
      }
    },
    [slug, locationState.place.city],
  );

  useEffect(() => {
    if (!meta) return;
    setItems([]);
    setCursor(null);
    loadFeed(activeTab, scope);
  }, [meta, activeTab, scope, loadFeed]);

  async function handleReport() {
    if (reportBusy || !slug) return;
    Alert.alert(
      `Report #${slug}`,
      'Why are you reporting this hashtag?',
      [
        { text: 'Spam', onPress: () => submitReport('spam') },
        { text: 'Misleading', onPress: () => submitReport('misleading') },
        { text: 'Abusive content', onPress: () => submitReport('abusive') },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }

  async function submitReport(reason: HashtagReportReason) {
    if (!slug) return;
    setReportBusy(true);
    const res = await reportHashtag(slug, reason);
    setReportBusy(false);
    if (res.ok) {
      Alert.alert('Reported', 'Thank you — your report has been submitted.');
    } else {
      Alert.alert('Failed', res.error ?? 'Could not submit report. Please try again.');
    }
  }

  async function handleFollow() {
    if (followBusy || !slug) return;
    setFollowBusy(true);
    const res = following ? await unfollowHashtag(slug) : await followHashtag(slug);
    if (res.ok) {
      setFollowing((v) => !v);
      setMeta((prev) =>
        prev
          ? { ...prev, usageCount: prev.usageCount }
          : prev,
      );
    }
    setFollowBusy(false);
  }

  if (metaLoading) {
    return (
      <View style={[s.container, { paddingTop: insets.top }]}>
        <View style={s.topBar}>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
        </View>
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      </View>
    );
  }

  if (unavailable || !meta) {
    return (
      <View style={[s.container, { paddingTop: insets.top }]}>
        <View style={s.topBar}>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
        </View>
        <View style={s.center}>
          <View style={s.unavailWrap}>
            <Hash size={32} color={color.haze} />
            <Text style={s.unavailTitle}>This hashtag is unavailable</Text>
            <Text style={s.unavailSub}>
              It may have been removed or blocked.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      {/* Top bar */}
      <View style={s.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <View style={s.topBarCenter}>
          <Text style={s.topTitle}>#{meta.slug}</Text>
          <Text style={s.topSub}>
            {meta.usageCount.toLocaleString()} {meta.usageCount === 1 ? 'post' : 'posts'}
          </Text>
        </View>
        <Pressable
          style={[s.followBtn, following && s.followBtnActive]}
          onPress={handleFollow}
          disabled={followBusy}
        >
          {followBusy
            ? <ActivityIndicator size="small" color={following ? color.deep : color.onInk} />
            : <Text style={[s.followBtnText, following && s.followBtnTextActive]}>
                {following ? 'Following' : 'Follow'}
              </Text>
          }
        </Pressable>
        {meta && <SaveButton entityType="hashtag" entityId={meta.id} size={18} />}
        <Pressable onPress={handleReport} hitSlop={10} disabled={reportBusy} style={s.reportBtn}>
          <Flag size={18} color={color.haze} />
        </Pressable>
      </View>

      {/* Scope pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.scopeRow}
        style={s.scopeScroll}
      >
        {SCOPES.map(({ key, label }) => (
          <Pressable
            key={key}
            style={[s.scopePill, scope === key && s.scopePillActive]}
            onPress={() => setScope(key)}
          >
            <Text style={[s.scopePillText, scope === key && s.scopePillTextActive]}>
              {label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.tabRow}
        style={s.tabScroll}
      >
        {TABS.map(({ key, label }) => (
          <Pressable
            key={key}
            style={[s.tab, activeTab === key && s.tabActive]}
            onPress={() => setActiveTab(key)}
          >
            <Text style={[s.tabText, activeTab === key && s.tabTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Feed */}
      {feedLoading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : feedError ? (
        <View style={s.center}>
          <Text style={s.errorText}>{feedError}</Text>
          <Pressable style={s.retryBtn} onPress={() => loadFeed(activeTab, scope)}>
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => `${item.type}-${item.id}`}
          renderItem={({ item }) => <FeedRow item={item} />}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
          ItemSeparatorComponent={() => <View style={s.divider} />}
          onEndReached={() => {
            if (hasMore && !loadingMore && cursor) {
              loadFeed(activeTab, scope, cursor);
            }
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
              <Hash size={28} color={color.haze} />
              <Text style={s.emptyTitle}>No {activeTab} content yet</Text>
              <Text style={s.emptySub}>
                Be the first to use #{meta.slug} in a post.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

// ── Feed row styles ─────────────────────────────────────────────────────────────

const fr = StyleSheet.create({
  row: {
    flexDirection: 'row', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    alignItems: 'flex-start',
  },
  postThumb: { width: 60, height: 60, borderRadius: radius.sm, backgroundColor: color.haze },
  postBody: { flex: 1, gap: 4 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  authorName: { ...t.small, color: color.ink, fontWeight: '600' },
  meta: { ...t.small, color: color.faint },
  postContent: { ...t.body, color: color.ink, lineHeight: 20 },
  statRow: { flexDirection: 'row', gap: space.md, marginTop: 2 },
  stat: { ...t.small, color: color.mute },

  avatarLgInitial: { fontSize: 16, fontWeight: '700', color: color.onInk },

  rowInfo: { flex: 1, gap: 3, justifyContent: 'center' },
  rowTitle: { ...t.bodyStrong, color: color.ink },
  rowSub: { ...t.small, color: color.mute },

  typeIcon: {
    width: avatar.lgXl, height: avatar.lgXl, borderRadius: avatar.lgXl / 2,
    alignItems: 'center', justifyContent: 'center',
  },
  placeThumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: color.haze },
});

// ── Screen styles ──────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.paper },

  topBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md,
  },
  topBarCenter: { flex: 1, alignItems: 'center', gap: 2 },
  topTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  topSub: { ...t.small, color: color.mute },

  followBtn: {
    paddingHorizontal: space.md, paddingVertical: 7,
    borderRadius: radius.pill, backgroundColor: color.deep,
  },
  followBtnActive: {
    backgroundColor: 'transparent', borderWidth: 1.5, borderColor: color.deep,
  },
  followBtnText: { ...t.small, color: color.onInk, fontWeight: '700', fontSize: 12 },
  followBtnTextActive: { color: color.deep },
  reportBtn: { padding: 4 },

  scopeScroll: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze },
  scopeRow: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  scopePill: {
    paddingHorizontal: space.md, paddingVertical: 5,
    borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.haze,
  },
  scopePillActive: { borderColor: color.signal, backgroundColor: color.signal + '12' },
  scopePillText: { ...t.small, color: color.mute, fontWeight: '600' },
  scopePillTextActive: { color: color.signal },

  tabScroll: { borderBottomWidth: 1.5, borderBottomColor: color.haze },
  tabRow: { paddingHorizontal: space.lg, gap: 0 },
  tab: { paddingHorizontal: space.md, paddingVertical: space.md },
  tabActive: { borderBottomWidth: 2, borderBottomColor: color.ink },
  tabText: { ...t.small, color: color.mute, fontWeight: '600' },
  tabTextActive: { color: color.ink },

  list: { flexGrow: 1, paddingBottom: 40 },
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

  unavailWrap: { alignItems: 'center', gap: space.md },
  unavailTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  unavailSub: { ...t.small, color: color.mute, textAlign: 'center' },

  footerLoader: { paddingVertical: space.xl, alignItems: 'center' },
});
