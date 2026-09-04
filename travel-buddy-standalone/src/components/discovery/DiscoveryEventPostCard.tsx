/**
 * DiscoveryEventPostCard — compact card for a "Live from events" post in Discovery.
 *
 * Receives a DiscoveryEventPost and renders:
 *   - Post content excerpt (up to 120 chars)
 *   - Optional media thumbnail
 *   - Venue/event label badge
 *   - Location city + recency label
 *   - Like count
 *
 * Navigates to /post/[id] on tap.
 * Visual reference: PostcardTile — same spacing/typography tokens but a different
 * data shape, so PostcardTile is NOT imported or wrapped here.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { MapPin, Music2 } from 'lucide-react-native';
import { StampIcon } from '../stamps/StampIcon.tsx';
import { color, space, radius, shadow } from '../../theme/tokens.ts';
import type { DiscoveryEventPost } from '../../types/discovery.ts';
import { DisplayMediaImage } from '../ui/DisplayMediaImage.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function recencyLabel(createdAt: string): string {
  const diffMs = Date.now() - new Date(createdAt).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  post: DiscoveryEventPost;
  /**
   * Called just before navigation when the card is tapped. The Discovery feed
   * rail uses it to report a 'discovery' rank outcome for this post; other
   * callers may omit it. Navigation happens regardless.
   */
  onOpen?: () => void;
}

export function DiscoveryEventPostCard({ post, onOpen }: Props) {
  const thumbnail = post.mediaUrls[0] ?? null;
  const label = post.linkedEventTitle ?? post.venueLabel ?? post.venueName ?? null;

  return (
    <Pressable
      style={s.card}
      onPress={() => { onOpen?.(); router.push(`/post/${post.id}` as any); }}
      accessibilityRole="button"
      accessibilityLabel={`Post from ${label ?? 'event'}: ${post.content.slice(0, 60)}`}
    >
      {/* Media thumbnail — shown only when media is present */}
      <DisplayMediaImage
        uri={thumbnail}
        width={CARD_WIDTH}
        height={110}
        style={s.thumbnail}
        fallbackIcon={<Music2 size={24} color={color.mute} />}
        fallbackBg={color.haze}
        alt={post.linkedEventTitle ?? post.venueLabel ?? 'Post media'}
      />

      {/* Text body */}
      <View style={s.body}>
        {/* Venue / event badge */}
        {label ? (
          <View style={s.badge}>
            <Music2 size={10} color={color.signal} />
            <Text style={s.badgeText} numberOfLines={1}>{label}</Text>
          </View>
        ) : null}

        {/* Content excerpt */}
        {post.content ? (
          <Text style={s.content} numberOfLines={3}>
            {truncate(post.content)}
          </Text>
        ) : null}

        {/* Footer row: city + recency + likes */}
        <View style={s.footer}>
          {post.locationCity ? (
            <View style={s.cityRow}>
              <MapPin size={10} color={color.mute} />
              <Text style={s.city} numberOfLines={1}>{post.locationCity}</Text>
            </View>
          ) : null}
          <Text style={s.recency}>{recencyLabel(post.createdAt)}</Text>
          {post.likeCount > 0 ? (
            <View style={s.likeRow}>
              <StampIcon size={10} color={color.mute} />
              <Text style={s.likeCount}>{post.likeCount}</Text>
            </View>
          ) : null}
        </View>

      </View>
    </Pressable>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const CARD_WIDTH = 200;

const s = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    overflow: 'hidden',
    ...shadow.card,
    marginRight: space.md,
  },
  thumbnail: {
    width: CARD_WIDTH,
    height: 110,
    backgroundColor: color.haze,
  },
  thumbnailPlaceholder: {
    width: CARD_WIDTH,
    height: 110,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: space.sm,
    gap: 4,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: color.haze,
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  badgeText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600',
    color: color.signal,
    maxWidth: 140,
  },
  content: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400',
    color: color.ink,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
    marginTop: 2,
  },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  city: {
    fontSize: 11,
    lineHeight: 14,
    color: color.mute,
    maxWidth: 80,
  },
  recency: {
    fontSize: 11,
    lineHeight: 14,
    color: color.mute,
  },
  likeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 'auto',
  },
  likeCount: {
    fontSize: 11,
    lineHeight: 14,
    color: color.mute,
  },
});
