import React, { useMemo, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { Play, Layers, MapPin, Pin, Plus, ChevronDown } from 'lucide-react-native';
import type { PassportPostcard } from '../types/models';

/**
 * Postcard Wall — the Passport's visual social grid (default tab).
 *
 * Presentation over the screen's already-loaded postcards. Tapping a tile
 * opens the EXISTING post viewer (/post/[id]) with likes, comments, share,
 * owner menu, visibility controls — no duplicate viewer. Owner-only
 * Add Postcard CTA opens the existing composer.
 *
 * Sorting: Newest / Oldest (createdAt) — the fields this data actually has.
 * Like counts live on the post record, so tiles show location + media type
 * chips only (no fake counts).
 */

const PAGE_SIZE = 16;

type SortKey = 'newest' | 'oldest';

export function PostcardWall({
  postcards,
  isOwner,
  onAddPostcard,
  onTileLongPress,
}: {
  postcards: PassportPostcard[];
  isOwner: boolean;
  onAddPostcard?: () => void;
  /** Owner wall management (pin / remove) via long-press. */
  onTileLongPress?: (card: PassportPostcard) => void;
}) {
  const { width } = useWindowDimensions();
  const [sort, setSort] = useState<SortKey>('newest');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const columns = width >= 600 ? 3 : 2;
  const gap = width < 350 ? 6 : 8;
  const pad = 12;
  const tileW = (Math.min(width, 760) - pad * 2 - gap * (columns - 1)) / columns;
  const tileH = tileW * 1.25; // 4:5

  const sorted = useMemo(() => {
    const list = postcards.slice();
    // pinned first, then by date
    list.sort((a, b) => {
      const pin = (b.pinnedAt ? 1 : 0) - (a.pinnedAt ? 1 : 0);
      if (pin !== 0) return pin;
      const cmp = (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
      return sort === 'newest' ? cmp : -cmp;
    });
    return list;
  }, [postcards, sort]);

  const shown = sorted.slice(0, visibleCount);
  const hasMore = sorted.length > visibleCount;

  return (
    <View style={styles.wrap}>
      {/* toolbar */}
      <View style={styles.toolbar}>
        <Text style={styles.title}>Postcard Wall</Text>
        <Pressable
          style={styles.sortBtn}
          onPress={() => setSort((s) => (s === 'newest' ? 'oldest' : 'newest'))}
          accessibilityRole="button"
          accessibilityLabel={`Sorted by ${sort}. Tap to change`}
        >
          <Text style={styles.sortText}>{sort === 'newest' ? 'Newest' : 'Oldest'}</Text>
          <ChevronDown size={14} color="#475467" />
        </Pressable>
      </View>

      {shown.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {isOwner ? 'Your Postcard Wall is waiting.' : 'No public Postcards yet.'}
          </Text>
          {isOwner ? (
            <Text style={styles.emptySub}>
              Share travel moments, discoveries, and memories from your adventures.
            </Text>
          ) : null}
          {isOwner && onAddPostcard ? (
            <Pressable
              style={styles.emptyCta}
              onPress={onAddPostcard}
              accessibilityRole="button"
              accessibilityLabel="Create your first Postcard"
            >
              <Text style={styles.emptyCtaText}>Create your first Postcard</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View style={[styles.grid, { paddingHorizontal: pad, gap }]}>
          {shown.map((card) => {
            const mediaUri =
              card.media?.find((m) => m.thumbnailUrl || m.url)?.thumbnailUrl ??
              card.media?.[0]?.url ??
              card.mediaUrl;
            const location = [card.locationCity || card.locationName, card.locationCountry]
              .filter(Boolean).join(', ');
            const isCarousel = (card.media?.length ?? 0) > 1;
            return (
              <Pressable
                key={card.id}
                style={[styles.tile, { width: tileW, height: tileH }]}
                onPress={() => card.postId && router.push(`/post/${card.postId}` as any)}
                onLongPress={onTileLongPress ? () => onTileLongPress(card) : undefined}
                accessibilityRole="button"
                accessibilityLabel={`Postcard${location ? ` from ${location}` : ''}`}
              >
                {mediaUri ? (
                  <Image source={{ uri: mediaUri }} style={styles.media} resizeMode="cover" />
                ) : (
                  <View style={[styles.media, styles.mediaFallback]}>
                    <MapPin size={20} color="#B08A45" strokeWidth={1.6} />
                  </View>
                )}
                {location ? (
                  <View style={styles.locChip}>
                    <Text style={styles.locChipText} numberOfLines={1}>{location}</Text>
                  </View>
                ) : null}
                {card.pinnedAt ? (
                  <View style={styles.pinBadge}>
                    <Pin size={12} color="#FFFFFF" strokeWidth={2.2} />
                  </View>
                ) : null}
                {card.hasVideo ? (
                  <View style={styles.typeBadge}>
                    <Play size={13} color="#FFFFFF" strokeWidth={2.2} />
                  </View>
                ) : isCarousel ? (
                  <View style={styles.typeBadge}>
                    <Layers size={13} color="#FFFFFF" strokeWidth={2.2} />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      )}

      {hasMore ? (
        <Pressable
          style={styles.moreBtn}
          onPress={() => setVisibleCount((c) => c + PAGE_SIZE)}
          accessibilityRole="button"
          accessibilityLabel="Show more postcards"
        >
          <Text style={styles.moreText}>Show more</Text>
        </Pressable>
      ) : null}

      {/* owner add-postcard CTA */}
      {isOwner && onAddPostcard && shown.length > 0 ? (
        <Pressable
          style={styles.addCta}
          onPress={onAddPostcard}
          accessibilityRole="button"
          accessibilityLabel="Add Postcard"
        >
          <View style={styles.addCircle}>
            <Plus size={20} color="#6945D8" strokeWidth={2.2} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.addTitle}>Add Postcard</Text>
            <Text style={styles.addSub}>Share a memory with your passport</Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 4 },
  toolbar: {
    height: 48, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#101828' },
  sortBtn: {
    minHeight: 32, paddingHorizontal: 10, borderRadius: 9,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderColor: '#EAECF0', backgroundColor: '#FFFFFF',
  },
  sortText: { fontSize: 12.5, fontWeight: '600', color: '#475467' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { borderRadius: 11, overflow: 'hidden', backgroundColor: '#F2F4F7', marginBottom: 0 },
  media: { width: '100%', height: '100%' },
  mediaFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#FCF6E8' },
  locChip: {
    position: 'absolute', top: 6, left: 6, maxWidth: '80%',
    minHeight: 24, paddingHorizontal: 8, borderRadius: 999,
    backgroundColor: 'rgba(16,24,40,0.55)', justifyContent: 'center',
  },
  locChipText: { fontSize: 11, fontWeight: '600', color: '#FFFFFF' },
  pinBadge: {
    position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(16,24,40,0.48)', alignItems: 'center', justifyContent: 'center',
  },
  typeBadge: {
    position: 'absolute', bottom: 6, right: 6, width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(16,24,40,0.48)', alignItems: 'center', justifyContent: 'center',
  },
  moreBtn: {
    marginTop: 12, marginHorizontal: 16, minHeight: 38, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#EAECF0', backgroundColor: '#FFFFFF',
  },
  moreText: { fontSize: 13, fontWeight: '600', color: '#475467' },
  addCta: {
    marginTop: 14, marginHorizontal: 16, minHeight: 74,
    borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: '#B9A7FF',
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14,
    backgroundColor: '#FFFFFF',
  },
  addCircle: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(105,69,216,0.08)', alignItems: 'center', justifyContent: 'center',
  },
  addTitle: { fontSize: 14, fontWeight: '600', color: '#101828' },
  addSub: { marginTop: 1, fontSize: 12, color: '#667085' },
  empty: {
    marginHorizontal: 16, marginTop: 4, borderRadius: 14,
    borderWidth: 1, borderColor: '#EAECF0', backgroundColor: '#FFFFFF',
    alignItems: 'center', paddingVertical: 26, paddingHorizontal: 20, gap: 6,
  },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: '#101828', textAlign: 'center' },
  emptySub: { fontSize: 13, lineHeight: 18, color: '#667085', textAlign: 'center' },
  emptyCta: {
    marginTop: 8, minHeight: 38, paddingHorizontal: 16, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#101828',
  },
  emptyCtaText: { fontSize: 13, fontWeight: '600', color: '#FFFFFF' },
});
