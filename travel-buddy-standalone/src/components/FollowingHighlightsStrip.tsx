/**
 * FollowingHighlightsStrip — horizontal stories-style tray for the Explore tab.
 *
 * Shows avatars with gradient rings for followed users who have active highlights.
 * Tapping an avatar opens HighlightViewer for that user's highlights.
 * The ring mutes to grey once all highlights have been viewed in the current session.
 *
 * Poster rule: the avatar inside each ring always shows the user's avatarUrl.
 * The first highlight's mediaThumbnailUrl is used when rendering a thumbnail fallback
 * — never the raw mediaUrl for video highlights (which would break as an <Image> src).
 * A ▶ badge is overlaid on the ring when the user's first highlight is a video.
 */
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable,
} from 'react-native';
import { HighlightRing } from './HighlightRing.tsx';
import { HighlightViewer } from './HighlightViewer.tsx';
import { color, space } from '../theme/tokens.ts';
import type { HighlightFeedUser, HighlightErrorKind } from '../services/highlights.ts';
import { useSession } from '../context/SessionContext.tsx';
import { DisplayMediaImage } from './ui/DisplayMediaImage.tsx';

const AVATAR_SIZE = 52;

interface Props {
  users: HighlightFeedUser[];
  sessionViewedIds: Set<string>;
  onMarkViewed: (ids: string[]) => void;
  /**
   * §28.11. Non-null when the feed could not be READ. An unreadable feed and a
   * feed with nothing in it are different facts and must not be the same
   * picture: the server refuses with `degraded_unavailable` rather than
   * answering `{ users: [] }` from a follow-graph lookup that failed, and this
   * tray disappearing was that refusal being re-stated as the claim.
   */
  unreadable?: HighlightErrorKind | null;
  /** Retry the feed read. Only offered for a failure that can be retried. */
  onRetry?: () => void;
}

/**
 * Resolve the poster URI to render inside the ring for a user's first highlight.
 * Prefers mediaThumbnailUrl; falls back to mediaUrl only for image highlights.
 * Returns null for video highlights with no thumbnail (grey placeholder shown).
 */
function resolveRingPosterUri(user: HighlightFeedUser): string | null {
  // Prefer user avatar — it's always safe to render in an <Image>
  if (user.avatarUrl) return user.avatarUrl;

  const first = user.highlights[0];
  if (!first) return null;

  // For video highlights, only use a dedicated thumbnail — never the raw video URL
  if (first.mediaType.startsWith('video/')) {
    return first.mediaThumbnailUrl ?? null;
  }

  // Image highlights: thumbnail preferred, raw URL acceptable
  return first.mediaThumbnailUrl ?? first.mediaUrl;
}

export function FollowingHighlightsStrip({
  users, sessionViewedIds, onMarkViewed, unreadable = null, onRetry,
}: Props) {
  const { userId: currentUserId } = useSession();
  const [viewingUser, setViewingUser] = useState<HighlightFeedUser | null>(null);

  // §28.11. The read failed and we have nothing to show. Say that. Rendering
  // null here would put the same picture on screen as "nobody you follow has
  // posted", which is a claim about other people that we have no basis for.
  if (users.length === 0 && unreadable) {
    // `feature_disabled` is permanent on this build; everything else is worth
    // another try. Offering a retry that can never work is its own small lie.
    const retryable = unreadable !== 'feature_disabled';
    return (
      <View style={styles.wrapper}>
        <View style={styles.unreadableRow}>
          <Text style={styles.unreadableText} numberOfLines={2}>
            {unreadable === 'feature_disabled'
              ? 'Highlights are not available on this version.'
              : 'We could not load Highlights from people you follow.'}
          </Text>
          {retryable && onRetry ? (
            <Pressable
              onPress={onRetry}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Retry loading highlights"
            >
              <Text style={styles.unreadableRetry}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  if (users.length === 0) return null;

  const handleClose = () => {
    if (viewingUser) {
      onMarkViewed(viewingUser.highlights.map((h) => h.id));
    }
    setViewingUser(null);
  };

  return (
    <View style={styles.wrapper}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {users.map((u) => {
          const allViewed = u.highlights.every(
            (h) => h.viewedByMe || sessionViewedIds.has(h.id),
          );
          const label = u.handle ?? u.name ?? '';
          const firstHighlight = u.highlights[0];
          const mediaType = firstHighlight?.mediaType;
          const posterUri = resolveRingPosterUri(u);

          return (
            <Pressable
              key={u.userId}
              style={styles.item}
              onPress={() => setViewingUser(u)}
              accessibilityRole="button"
              accessibilityLabel={`View ${label}'s highlights`}
            >
              <HighlightRing hasActive allViewed={allViewed} size={AVATAR_SIZE} mediaType={mediaType}>
                {posterUri ? (
                  // posterUri may be a profile-media avatar or a post-media
                  // highlight thumbnail/still — both are private buckets, so
                  // this must go through the signed-URL hydration layer
                  // (DisplayMediaImage/useHydratedMedia) rather than binding
                  // straight to <Image>.
                  <DisplayMediaImage
                    uri={posterUri}
                    width={AVATAR_SIZE}
                    height={AVATAR_SIZE}
                    style={styles.avatar}
                    resizeMode="cover"
                    fallback={
                      <View style={[styles.avatar, styles.avatarFallback]}>
                        <Text style={styles.avatarInitial}>
                          {(u.name ?? u.handle ?? '?')[0].toUpperCase()}
                        </Text>
                      </View>
                    }
                    testID={`following-highlight-avatar-${u.userId}`}
                  />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarInitial}>
                      {(u.name ?? u.handle ?? '?')[0].toUpperCase()}
                    </Text>
                  </View>
                )}
              </HighlightRing>
              <Text
                style={[styles.name, allViewed && styles.nameMuted]}
                numberOfLines={1}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {viewingUser && (
        <HighlightViewer
          visible
          highlights={viewingUser.highlights}
          currentUserId={currentUserId ?? undefined}
          onClose={handleClose}
          onDeleted={handleClose}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.lg,
  },
  item: {
    alignItems: 'center',
    width: 64,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  avatarFallback: {
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 20,
    fontWeight: '700',
    color: color.mute,
  },
  name: {
    fontSize: 11,
    color: color.mute,
    marginTop: space.xs,
    maxWidth: 64,
    textAlign: 'center',
  },
  nameMuted: {
    color: color.faint,
  },
  unreadableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  unreadableText: {
    flex: 1,
    fontSize: 12,
    color: color.mute,
  },
  unreadableRetry: {
    fontSize: 12,
    fontWeight: '700',
    color: color.signal,
  },
});
