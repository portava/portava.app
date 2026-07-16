/**
 * FollowingHighlightsStrip — horizontal stories-style tray for the Explore tab.
 *
 * Shows avatars with gradient rings for followed users who have active highlights.
 * Tapping an avatar opens HighlightViewer for that user's highlights.
 * The ring mutes to grey once all highlights have been viewed in the current session.
 */
import React, { useState } from 'react';
import {
  View, Text, Image, ScrollView, StyleSheet, Pressable,
} from 'react-native';
import { HighlightRing } from './HighlightRing';
import { HighlightViewer } from './HighlightViewer';
import { color, space } from '../theme/tokens';
import type { HighlightFeedUser } from '../services/highlights';
import { useSession } from '../context/SessionContext';

const AVATAR_SIZE = 52;

interface Props {
  users: HighlightFeedUser[];
  sessionViewedIds: Set<string>;
  onMarkViewed: (ids: string[]) => void;
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
          return (
            <Pressable
              key={u.userId}
              style={styles.item}
              onPress={() => setViewingUser(u)}
              accessibilityRole="button"
              accessibilityLabel={`View ${label}'s highlights`}
            >
              <HighlightRing hasActive allViewed={allViewed} size={AVATAR_SIZE}>
                {u.avatarUrl ? (
                  <Image
                    source={{ uri: u.avatarUrl }}
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
