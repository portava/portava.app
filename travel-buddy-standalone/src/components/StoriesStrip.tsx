/**
 * StoriesStrip — horizontal row of story rings shown at the top of feeds.
 * Shows "your story" ring first, then followed users with active stories.
 *
 * Poster rule: the avatar circle inside each ring always shows the user's
 * avatarUrl (never a raw video media_url, which would break as an <Image> src).
 * A ▶ badge is overlaid on the ring when the user's first story is a video.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as t, icon } from '../theme/tokens.ts';
import { HighlightRing } from './HighlightRing.tsx';
import { useSession } from '../context/SessionContext.tsx';
import { getStoriesFeed, type StoryFeedUser, type Story } from '../services/stories.ts';
import { AvatarImage } from './ui/DisplayMediaImage.tsx';

const RING_SIZE = 64;
const RING_GAP = space.md;

interface Props {
  onTapUser: (user: StoryFeedUser) => void;
  onTapSelf: () => void;
  style?: any;
}

/** Returns the MIME type of the first story, or undefined if none. */
function firstStoryMediaType(stories: Story[]): string | undefined {
  return stories[0]?.media_type ?? undefined;
}

export function StoriesStrip({ onTapUser, onTapSelf, style }: Props) {
  const { userId } = useSession();
  const [feedUsers, setFeedUsers] = useState<StoryFeedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const res = await getStoriesFeed();
    if (res.ok) setFeedUsers(res.users);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 60_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [load]);

  const selfEntry = feedUsers.find((u) => u.userId === userId);
  const others = feedUsers.filter((u) => u.userId !== userId);

  if (loading && feedUsers.length === 0) return null;

  return (
    <FlatList
      horizontal
      showsHorizontalScrollIndicator={false}
      data={[null, ...others]}
      keyExtractor={(item, i) => item ? item.userId : 'self'}
      contentContainerStyle={[s.container, style]}
      renderItem={({ item }) => {
        if (!item) {
          // Self ring
          return (
            <Pressable style={s.item} onPress={onTapSelf}>
              <View style={s.selfRing}>
                <HighlightRing
                  size={RING_SIZE}
                  allViewed={selfEntry != null}
                  hasActive={Boolean(selfEntry)}
                  isOwner
                  mediaType={selfEntry ? firstStoryMediaType(selfEntry.stories) : undefined}
                >
                  <AvatarImage
                    uri={selfEntry?.avatarUrl}
                    user={selfEntry ? { displayName: selfEntry.name, handle: selfEntry.handle } : null}
                    size={RING_SIZE}
                    style={s.avatarCircle}
                  />
                </HighlightRing>
                <View style={s.plusBadge}>
                  <Text style={s.plusText}>+</Text>
                </View>
              </View>
              <Text style={s.label} numberOfLines={1}>Your story</Text>
            </Pressable>
          );
        }

        const hasUnviewed = item.hasUnviewed;
        const mediaType = firstStoryMediaType(item.stories);
        return (
          <Pressable style={s.item} onPress={() => onTapUser(item)}>
            <HighlightRing
              size={RING_SIZE}
              allViewed={!hasUnviewed}
              hasActive
              mediaType={mediaType}
            >
              <AvatarImage
                uri={item.avatarUrl}
                user={{ displayName: item.name, handle: item.handle }}
                size={RING_SIZE}
                style={s.avatarCircle}
              />
            </HighlightRing>
            <Text style={s.label} numberOfLines={1}>{item.name ?? item.handle ?? 'Traveler'}</Text>
          </Pressable>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  container: { paddingHorizontal: space.md, paddingVertical: space.sm, gap: RING_GAP },
  item: { alignItems: 'center', width: RING_SIZE + 8, gap: 4 },
  selfRing: { position: 'relative' },
  avatarCircle: { backgroundColor: color.haze },
  plusBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: icon.action, height: icon.action, borderRadius: icon.action / 2,
    backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: color.paper,
  },
  plusText: { color: '#fff', fontSize: 14, fontWeight: '700', lineHeight: 16 },
  label: { ...t.small, color: color.mute, fontSize: 11, textAlign: 'center', maxWidth: RING_SIZE + 8 },
});
