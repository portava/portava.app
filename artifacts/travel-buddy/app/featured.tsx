/**
 * Featured Hub — "Featured by Portava" browsing screen.
 *
 * Shows all live featured posts grouped by category with horizontal scroll
 * rows, and a "This Week's Winners" banner at the top.
 *
 * Entry points: Discover tab header shortcut, profile trophy "View Featured" link.
 * Tapping any card opens the normal post-detail screen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, FlatList, ScrollView,
  ActivityIndicator, RefreshControl, Image,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Trophy, MapPin, RefreshCw } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../src/theme/tokens';
import { getFeaturedHub, type FeaturedGroup, type FeaturedPost } from '../src/services/featured';

// ── Category icon map ─────────────────────────────────────────────────────────

const CATEGORY_EMOJI: Record<string, string> = {
  best_video:       '🎬',
  best_hidden_gem:  '💎',
  best_nightlife:   '🌙',
  best_restaurant:  '🍽️',
  best_adventure:   '🧗',
  best_photo:       '📸',
};

// ── This Week's Winners banner ────────────────────────────────────────────────

function WinnerBanner({ posts }: { posts: FeaturedPost[] }) {
  if (posts.length === 0) return null;

  return (
    <View style={styles.bannerWrap}>
      <View style={styles.bannerHeader}>
        <Trophy size={16} color="#D97706" />
        <Text style={styles.bannerTitle}>This Week's Winners</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.bannerScroll}
      >
        {posts.map((post) => (
          <WinnerCard key={post.id} post={post} />
        ))}
      </ScrollView>
    </View>
  );
}

function WinnerCard({ post }: { post: FeaturedPost }) {
  const emoji = CATEGORY_EMOJI[post.category] ?? '🏆';

  function handlePress() {
    router.push(`/post/${post.postId}` as any);
  }

  return (
    <Pressable
      style={({ pressed }) => [styles.winnerCard, pressed && { opacity: 0.88 }]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Featured post by ${post.author.displayName}`}
    >
      {/* Thumbnail */}
      <View style={styles.winnerImageWrap}>
        {post.thumbnailUrl ? (
          <Image source={{ uri: post.thumbnailUrl }} style={styles.winnerImage} resizeMode="cover" />
        ) : (
          <View style={[styles.winnerImage, styles.winnerImageFallback]}>
            <Text style={styles.winnerImageEmoji}>{emoji}</Text>
          </View>
        )}
        {/* Category label overlay */}
        <View style={styles.winnerCategoryOverlay}>
          <Text style={styles.winnerCategoryText}>{emoji} {post.categoryLabel}</Text>
        </View>
      </View>

      {/* Author */}
      <View style={styles.winnerMeta}>
        <Text style={styles.winnerAuthor} numberOfLines={1}>
          @{post.author.username}
        </Text>
        {(post.locationCity || post.locationCountry) && (
          <View style={styles.winnerLocation}>
            <MapPin size={9} color={color.faint} />
            <Text style={styles.winnerLocationText} numberOfLines={1}>
              {[post.locationCity, post.locationCountry].filter(Boolean).join(', ')}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

// ── Category row ──────────────────────────────────────────────────────────────

function CategoryRow({ group }: { group: FeaturedGroup }) {
  const emoji = CATEGORY_EMOJI[group.category] ?? '🏆';

  return (
    <View style={styles.categorySection}>
      <View style={styles.categoryHeader}>
        <Text style={styles.categoryEmoji}>{emoji}</Text>
        <Text style={styles.categoryTitle}>{group.categoryLabel}</Text>
        <Text style={styles.categoryCount}>{group.posts.length}</Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.categoryScroll}
      >
        {group.posts.map((post) => (
          <CategoryCard key={post.id} post={post} />
        ))}
      </ScrollView>
    </View>
  );
}

function CategoryCard({ post }: { post: FeaturedPost }) {
  function handlePress() {
    router.push(`/post/${post.postId}` as any);
  }

  return (
    <Pressable
      style={({ pressed }) => [styles.categoryCard, pressed && { opacity: 0.88 }]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Post by ${post.author.displayName}`}
    >
      {/* Image */}
      <View style={styles.categoryImageWrap}>
        {post.thumbnailUrl ? (
          <Image source={{ uri: post.thumbnailUrl }} style={styles.categoryImage} resizeMode="cover" />
        ) : (
          <View style={[styles.categoryImage, styles.categoryImageFallback]}>
            <Text style={{ fontSize: 28 }}>{CATEGORY_EMOJI[post.category] ?? '🏆'}</Text>
          </View>
        )}
        {post.mediaType === 'video' && (
          <View style={styles.videoIndicator}>
            <Text style={styles.videoIndicatorText}>▶</Text>
          </View>
        )}
      </View>

      {/* Author + location */}
      <View style={styles.categoryMeta}>
        <Text style={styles.categoryAuthor} numberOfLines={1}>@{post.author.username}</Text>
        {post.locationCity ? (
          <Text style={styles.categoryLocation} numberOfLines={1}>{post.locationCity}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

// ── Fallback notice ───────────────────────────────────────────────────────────
//
// Shown when the API returns isFallback:true — portava_featured had no live
// rows and the server synthesised content from @Portava's own posts instead.

function FallbackNotice() {
  return (
    <View style={styles.fallbackNotice}>
      <Text style={styles.fallbackNoticeText}>
        ✨ Showcasing @Portava's top posts while new featured selections are being curated.
      </Text>
    </View>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>🏆</Text>
      <Text style={styles.emptyTitle}>Nothing featured yet</Text>
      <Text style={styles.emptyBody}>
        Check back soon — Portava features the best travel content every week.
      </Text>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function FeaturedHubScreen() {
  const insets = useSafeAreaInsets();
  const [groups, setGroups] = useState<FeaturedGroup[]>([]);
  const [winners, setWinners] = useState<FeaturedPost[]>([]);
  const [isFallback, setIsFallback] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    const result = await getFeaturedHub();
    if (result.ok && result.data) {
      setGroups(result.data.groups);
      setWinners(result.data.thisWeeksWinners);
      setIsFallback(result.data.isFallback === true);
    } else {
      setError(result.message ?? 'Could not load featured posts');
    }

    if (isRefresh) setRefreshing(false);
    else setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      // Silently refresh on re-focus (non-blocking)
      load();
    }, [load]),
  );

  const sections = [
    ...(isFallback ? [{ key: 'fallback-notice', render: () => <FallbackNotice /> }] : []),
    { key: 'winners', render: () => <WinnerBanner posts={winners} /> },
    ...groups.map((group) => ({ key: group.category, render: () => <CategoryRow group={group} /> })),
  ];

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Trophy size={18} color="#D97706" />
          <Text style={styles.headerTitle}>Featured by Portava</Text>
        </View>
        <View style={{ width: 38 }} />
      </View>

      {loading ? (
        <View style={styles.loader}>
          <ActivityIndicator size="large" color={color.mute} />
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <RefreshCw size={32} color={color.faint} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => load()}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </Pressable>
        </View>
      ) : groups.length === 0 && winners.length === 0 ? (
        <EmptyState />
      ) : (
        <FlatList
          data={sections}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => item.render()}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + space.xl }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor={color.mute}
            />
          }
        />
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const WINNER_CARD_W = 200;
const CATEGORY_CARD_W = 140;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.md, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  backBtn: { padding: 6 },
  headerCenter: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  headerTitle: { ...t.heading, color: color.ink, fontSize: 17 },

  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingTop: space.md },

  // ── Winners banner ──────────────────────────────────────────────────────────
  bannerWrap: {
    backgroundColor: '#FFFBEB',
    borderRadius: radius.lg,
    marginHorizontal: space.lg,
    marginBottom: space.lg,
    padding: space.md,
    borderWidth: 1,
    borderColor: '#FCD34D',
    ...shadow.card,
  },
  bannerHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.sm,
  },
  bannerTitle: { ...t.bodyStrong, color: '#92400E', fontSize: 14 },
  bannerScroll: { gap: space.md, paddingRight: space.sm },

  winnerCard: {
    width: WINNER_CARD_W,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
  },
  winnerImageWrap: { width: WINNER_CARD_W, height: 120, position: 'relative' },
  winnerImage: { width: '100%', height: '100%' },
  winnerImageFallback: { backgroundColor: '#FEF3C7', alignItems: 'center', justifyContent: 'center' },
  winnerImageEmoji: { fontSize: 36 },
  winnerCategoryOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(17,17,15,0.58)',
    paddingHorizontal: 8, paddingVertical: 5,
  },
  winnerCategoryText: { color: '#FDE68A', fontSize: 10, fontFamily: 'Courier', fontWeight: '700', letterSpacing: 0.3 },
  winnerMeta: { padding: space.sm, gap: 3 },
  winnerAuthor: { ...t.small, color: color.ink, fontWeight: '600' },
  winnerLocation: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  winnerLocationText: { ...t.small, color: color.faint, fontSize: 11 },

  // ── Category sections ───────────────────────────────────────────────────────
  categorySection: { marginBottom: space.xl },
  categoryHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: space.lg, marginBottom: space.md,
  },
  categoryEmoji: { fontSize: 18 },
  categoryTitle: { ...t.heading, color: color.ink, flex: 1 },
  categoryCount: {
    fontFamily: 'Courier', fontSize: 11, color: color.mute, fontWeight: '700',
    backgroundColor: color.haze, borderRadius: radius.pill,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  categoryScroll: { paddingHorizontal: space.lg, gap: space.md },

  categoryCard: {
    width: CATEGORY_CARD_W,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
  },
  categoryImageWrap: { width: CATEGORY_CARD_W, height: 120, position: 'relative' },
  categoryImage: { width: '100%', height: '100%' },
  categoryImageFallback: { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  categoryMeta: { padding: space.sm, gap: 2 },
  categoryAuthor: { ...t.small, color: color.ink, fontWeight: '600' },
  categoryLocation: { ...t.small, color: color.faint, fontSize: 11 },

  videoIndicator: {
    position: 'absolute', bottom: 6, right: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.pill,
    paddingHorizontal: 5, paddingVertical: 2,
  },
  videoIndicatorText: { color: '#fff', fontSize: 9 },

  // ── Fallback notice ─────────────────────────────────────────────────────────
  fallbackNotice: {
    marginHorizontal: space.lg,
    marginBottom: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: '#EFF6FF',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  fallbackNoticeText: { ...t.small, color: '#1E40AF', lineHeight: 18 },

  // ── Empty / error ───────────────────────────────────────────────────────────
  empty: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.md,
  },
  emptyIcon: { fontSize: 56 },
  emptyTitle: { ...t.heading, color: color.ink, textAlign: 'center' },
  emptyBody: { ...t.body, color: color.mute, textAlign: 'center' },

  errorWrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.md,
  },
  errorText: { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn: {
    paddingHorizontal: space.lg, paddingVertical: space.sm,
    backgroundColor: color.ink, borderRadius: radius.pill,
  },
  retryBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
});
