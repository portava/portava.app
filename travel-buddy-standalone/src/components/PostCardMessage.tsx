/**
 * PostCardMessage — renders a post_card system message as a rich inline card.
 *
 * Parses the JSON body (set by ShareSheet when a user shares a post into a
 * Telegraph thread) and shows:
 * - Author row (avatar + name/handle)
 * - Thumbnail (if the post had media)
 * - Content snippet
 * - Location (coarse city/country only — never exact coordinates)
 * - Like / comment counts
 * - Action row: View Post → opens /post/[id]
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import { router } from 'expo-router';
import { MapPin, Heart, MessageCircle, ExternalLink, User } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { TG } from '../theme/telegraphTokens.ts';

export interface PostCardPayload {
  postId: string;
  permalink?: string;
  authorName?: string;
  authorHandle?: string;
  authorAvatar?: string | null;
  snippet?: string;
  thumbnail?: string | null;
  city?: string | null;
  country?: string | null;
  likeCount?: number;
  commentCount?: number;
  caption?: string;
}

function parsePayload(body: string): PostCardPayload | null {
  try {
    const parsed = JSON.parse(body) as Partial<PostCardPayload>;
    if (typeof parsed.postId !== 'string' || !parsed.postId) return null;
    return parsed as PostCardPayload;
  } catch {
    return null;
  }
}

function locationLabel(p: PostCardPayload): string | null {
  const parts = [p.city, p.country].filter((x): x is string => Boolean(x));
  return parts.length ? parts.join(', ') : null;
}

interface Props {
  body: string;
  mine: boolean;
}

export function PostCardMessage({ body, mine }: Props) {
  const payload = parsePayload(body);

  if (!payload) {
    return (
      <View style={[card.wrap, mine && card.wrapMine]}>
        <Text style={[card.fallback, mine && { color: color.onInk + 'AA' }]}>Shared post</Text>
      </View>
    );
  }

  const loc = locationLabel(payload);
  const authorLabel =
    payload.authorName ||
    (payload.authorHandle ? `@${payload.authorHandle}` : 'A traveler');

  const openPost = () =>
    router.push(`/post/${encodeURIComponent(payload.postId)}` as any);

  return (
    <View style={[card.wrap, mine && card.wrapMine]}>
      {/* Header — brand + author */}
      <View style={card.header}>
        <View style={card.brandBadge}>
          <ExternalLink size={11} color={color.onInk} />
        </View>
        <Text style={[card.brandLabel, mine && { color: color.onInk + 'BB' }]}>POST</Text>
      </View>

      {/* Author row */}
      <View style={card.authorRow}>
        {payload.authorAvatar ? (
          <Image source={{ uri: payload.authorAvatar }} style={card.avatar} />
        ) : (
          <View style={card.avatarFallback}>
            <User size={12} color={mine ? color.onInk : color.mute} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={[card.authorName, mine && card.authorNameMine]} numberOfLines={1}>
            {authorLabel}
          </Text>
          {payload.authorHandle && payload.authorName ? (
            <Text style={[card.authorHandle, mine && card.authorHandleMine]} numberOfLines={1}>
              @{payload.authorHandle}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Thumbnail */}
      {payload.thumbnail ? (
        <Image source={{ uri: payload.thumbnail }} style={card.thumbnail} resizeMode="cover" />
      ) : null}

      {/* Snippet */}
      {payload.snippet ? (
        <Text style={[card.snippet, mine && card.snippetMine]} numberOfLines={3}>
          {payload.snippet}
        </Text>
      ) : null}

      {/* Location + counts */}
      <View style={card.metaRow}>
        {loc ? (
          <>
            <MapPin size={11} color={mine ? color.onInk + 'AA' : color.mute} />
            <Text style={[card.meta, mine && card.metaMine]} numberOfLines={1}>{loc}</Text>
          </>
        ) : null}
        {typeof payload.likeCount === 'number' ? (
          <View style={card.count}>
            <Heart size={10} color={mine ? color.onInk + 'AA' : color.mute} />
            <Text style={[card.meta, mine && card.metaMine]}>{payload.likeCount}</Text>
          </View>
        ) : null}
        {typeof payload.commentCount === 'number' ? (
          <View style={card.count}>
            <MessageCircle size={10} color={mine ? color.onInk + 'AA' : color.mute} />
            <Text style={[card.meta, mine && card.metaMine]}>{payload.commentCount}</Text>
          </View>
        ) : null}
      </View>

      {/* Caption from sender */}
      {payload.caption ? (
        <Text style={[card.caption, mine && card.captionMine]} numberOfLines={2}>
          "{payload.caption}"
        </Text>
      ) : null}

      {/* Action */}
      <View style={card.actions}>
        <Pressable style={card.actionBtn} onPress={openPost}>
          <ExternalLink size={11} color={mine ? color.onInk : color.signal} />
          <Text style={[card.actionLabel, mine && card.actionLabelMine]}>View Post</Text>
        </Pressable>
      </View>
    </View>
  );
}

const card = StyleSheet.create({
  wrap: {
    backgroundColor: TG.surfaceRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: TG.recvBorder,
    borderBottomLeftRadius: 4,
    padding: space.md,
    gap: 6,
    maxWidth: 280,
  },
  wrapMine: {
    backgroundColor: color.signal,
    borderColor: color.signal,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: 4,
  },
  fallback: { ...t.small, color: color.mute, fontStyle: 'italic' },

  header: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  brandBadge: { width: 18, height: 18, borderRadius: 5, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  brandLabel: { ...t.stamp, fontFamily: 'Courier', fontSize: 9, color: color.signal, letterSpacing: 1, flex: 1 },

  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  avatar: { width: 26, height: 26, borderRadius: 13, backgroundColor: color.haze },
  avatarFallback: { width: 26, height: 26, borderRadius: 13, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  authorName: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 13 },
  authorNameMine: { color: color.onInk },
  authorHandle: { ...t.small, color: color.mute, fontSize: 11 },
  authorHandleMine: { color: color.onInk + 'BB' },

  thumbnail: { width: '100%', height: 110, borderRadius: radius.sm, backgroundColor: color.haze },

  snippet: { ...t.small, color: color.ink, fontSize: 13, lineHeight: 17 },
  snippetMine: { color: color.onInk },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  meta: { ...t.small, color: color.mute, fontSize: 11 },
  metaMine: { color: color.onInk + 'BB' },
  count: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 4 },

  caption: { ...t.small, color: color.faint, fontSize: 11, fontStyle: 'italic', lineHeight: 15 },
  captionMine: { color: color.onInk + '99' },

  actions: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze, marginTop: 2, paddingTop: 6 },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 4 },
  actionLabel: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 10 },
  actionLabelMine: { color: color.onInk },
});
