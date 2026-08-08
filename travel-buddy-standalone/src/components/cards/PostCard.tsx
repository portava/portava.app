/**
 * PostCard — shared card consolidating PulseFeedCard (post type) and
 * DiscoveryCardMessage into one component with type-based rendering.
 * Preserves all existing interaction callbacks from both cards.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MapPin, MessageCircle, Bookmark } from 'lucide-react-native';
import { ActionStampIcon } from '../ui/ActionRowIcon.tsx';
import { POST_ACTION_ICON_SIZE } from '../PostActionRow.tsx';
import { CachedImage } from '../CachedImage.tsx';
import { color, space, radius, shadow, typography, layout } from '../../theme/tokens.ts';
import { VerifiedStamp } from '../ui/VerifiedStamp.tsx';
import { OfficialBadge } from '../OfficialBadge.tsx';
import { FeaturedBadge } from '../FeaturedBadge.tsx';

export type PostCardType = 'post' | 'question' | 'hidden_gem' | 'itinerary' | 'plan' | 'discovery_message';

export interface PostCardProps {
  id: string;
  type: PostCardType;
  title?: string | null;
  caption?: string | null;
  city?: string | null;
  imageUrl?: string | null;
  authorName?: string | null;
  authorHandle?: string | null;
  timeAgo?: string;
  likeCount?: number;
  commentCount?: number;
  likedByMe?: boolean;
  savedByMe?: boolean;
  tags?: string[];
  /** When true, renders a VerifiedStamp badge next to the author name in the simplified row. */
  authorVerified?: boolean;
  /** When true, renders the Portava Official gold-shield badge next to the author name. */
  authorIsOfficial?: boolean;
  onPress: () => void;
  onLike?: () => void;
  onSave?: () => void;
  onComment?: () => void;
  /**
   * Replaces the plain caption <Text> with a pre-rendered node.
   * Use when the caption contains rich-text spans (@mentions, #hashtags) that
   * must be rendered through RichText rather than a bare Text element.
   * When provided, the `caption` prop is ignored for display purposes.
   */
  captionNode?: React.ReactNode;
  /**
   * Extra content rendered at the bottom of the card body.
   * Use for type-specific action rows (buttons, feedback menus, engagement bars).
   * Caller is responsible for providing a flexDirection:'row' View when needed.
   */
  actionsSlot?: React.ReactNode;
  /**
   * Override the outer card container style.
   * Use `{ marginBottom: 0 }` when the parent feed supplies its own separator.
   */
  cardStyle?: object;
  /**
   * Replaces the built-in simplified author row.
   * Pass the full AuthorRow from PulseFeedCard to preserve overflow actions
   * (delete, share, report, hide-from-feed) and highlight/avatar interactions.
   */
  authorRow?: React.ReactNode;
  /**
   * Non-null when this post has been featured by Portava.
   * The string value is the feature category (e.g. "best_hidden_gem").
   * Renders a gold FeaturedBadge above the type badge.
   */
  featuredByPortava?: string | null;
  /**
   * Rendered below the caption/captionNode when the post is in a different
   * language than the viewer's preferred language.  Callers compose this from
   * <TranslationToggle> so the card stays unaware of translation logic.
   */
  translationToggleNode?: React.ReactNode;
}

const TYPE_BADGE: Record<PostCardType, { label: string; bg: string; fg: string } | null> = {
  post:              null,
  question:          { label: 'QUESTION',    bg: '#EFE7FA', fg: '#7A4DBF' },
  hidden_gem:        { label: 'HIDDEN GEM',  bg: '#E3F1EA', fg: '#2E7D5B' },
  itinerary:         { label: 'ITINERARY',   bg: '#E2EDF0', fg: '#0A3D4A' },
  plan:              { label: 'OPEN PLAN',   bg: '#E3F1EA', fg: '#2E7D5B' },
  discovery_message: null,
};

export function PostCard({
  type, title, caption, captionNode, city, imageUrl, authorName, authorHandle, timeAgo,
  likeCount, commentCount, likedByMe, savedByMe, tags, authorVerified, authorIsOfficial,
  onPress, onLike, onSave, onComment, actionsSlot, cardStyle, authorRow, featuredByPortava,
  translationToggleNode,
}: PostCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const badge = TYPE_BADGE[type];
  const displayText = title ?? caption ?? null;
  const authorLine = authorHandle ? `@${authorHandle}` : authorName ?? null;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, cardStyle, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={displayText ?? 'Post'}
    >
      {/* Cover image */}
      {imageUrl && !imgFailed ? (
        <CachedImage
          source={{ uri: imageUrl }}
          style={styles.image}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />
      ) : null}

      <View style={styles.body}>
        {/* Featured by Portava badge — rendered above the type badge */}
        {featuredByPortava ? (
          <FeaturedBadge category={featuredByPortava} size="sm" />
        ) : null}

        {/* Type badge */}
        {badge ? (
          <View style={[styles.badge, { backgroundColor: badge.bg }]}>
            <Text style={[styles.badgeText, { color: badge.fg }]}>{badge.label}</Text>
          </View>
        ) : null}

        {/* Author row — use authorRow slot when provided (full overflow/highlight/delete),
            otherwise fall back to the built-in simplified display */}
        {authorRow ?? (authorLine || timeAgo ? (
          <View style={styles.authorRow}>
            {authorLine ? (
              <Text style={styles.author} numberOfLines={1}>{authorLine}</Text>
            ) : null}
            {authorIsOfficial ? <OfficialBadge size="sm" /> : authorVerified ? <VerifiedStamp size="sm" /> : null}
            {timeAgo ? <Text style={styles.timeAgo}>{timeAgo}</Text> : null}
            {city ? <Text style={styles.city}>· {city}</Text> : null}
          </View>
        ) : null)}

        {/* Post text — captionNode takes priority for rich-text rendering */}
        {captionNode ?? (displayText ? (
          <Text style={styles.text} numberOfLines={4}>{displayText}</Text>
        ) : null)}

        {/* Translation toggle — rendered by caller when content language differs from viewer's */}
        {translationToggleNode ?? null}

        {/* Tags */}
        {tags && tags.length > 0 ? (
          <View style={styles.tags}>
            {tags.slice(0, 3).map((tag) => (
              <View key={tag} style={styles.tag}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Engagement bar */}
        {(onLike || onComment || onSave) ? (
          <View style={styles.engagementBar}>
            {onLike ? (
              <Pressable style={styles.engagementBtn} onPress={(e) => { e.stopPropagation?.(); onLike(); }} hitSlop={8}>
                <ActionStampIcon active={likedByMe} />
                {likeCount != null ? <Text style={styles.engagementCount}>{likeCount}</Text> : null}
              </Pressable>
            ) : null}
            {onComment ? (
              <Pressable style={styles.engagementBtn} onPress={(e) => { e.stopPropagation?.(); onComment(); }} hitSlop={8}>
                <MessageCircle size={POST_ACTION_ICON_SIZE} color={color.mute} />
                {commentCount != null ? <Text style={styles.engagementCount}>{commentCount}</Text> : null}
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }} />
            {onSave ? (
              <Pressable style={styles.engagementBtn} onPress={(e) => { e.stopPropagation?.(); onSave(); }} hitSlop={8}>
                <Bookmark size={POST_ACTION_ICON_SIZE} color={savedByMe ? color.signal : color.mute} fill={savedByMe ? color.signal : 'none'} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* actionsSlot — type-specific action rows from the caller */}
        {actionsSlot ?? null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadow.card,
    marginBottom: space.md,
    borderWidth: 1,
    borderColor: color.haze,
  },
  image: {
    width: '100%',
    height: 180,
  },
  body: {
    padding: space.md,
    gap: space.sm,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  badgeText: {
    ...typography.metadata,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
  },
  author: {
    ...typography.label,
    color: color.ink,
  },
  timeAgo: {
    ...typography.caption,
    color: color.mute,
  },
  city: {
    ...typography.caption,
    color: color.faint,
  },
  text: {
    ...typography.body,
    color: color.ink,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  tag: {
    backgroundColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  tagText: {
    ...typography.metadata,
    color: color.mute,
  },
  engagementBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingTop: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
    marginTop: space.xs,
  },
  engagementBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  engagementCount: {
    ...typography.caption,
    color: color.mute,
  },
});
