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
  View, Text, Image, ScrollView, StyleSheet, Pressable,
} from 'react-native';
import { HighlightRing } from './HighlightRing.tsx';
import { HighlightViewer } from './HighlightViewer.tsx';
import { color, space } from '../theme/tokens.ts';
import type { HighlightFeedUser } from '../services/highlights.ts';
import { useSession } from '../context/SessionContext.tsx';

const AVATAR_SIZE = 52;

interface Props {
  users: HighlightFeedUser[];
  sessionViewedIds: Set<string>;
  onMarkViewed: (ids: string[]) => void;
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

export function FollowingHighlightsStrip({ users, sessionViewedIds, onMarkViewed }: Props) {
  const { userId: currentUserId } = useSession();
  const [viewingUser, setViewingUser] = useState<HighlightFeedUser | null>(null);

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
                  <Image
                    source={{ uri: posterUri }}
                    style={styles.avatar}
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
});
