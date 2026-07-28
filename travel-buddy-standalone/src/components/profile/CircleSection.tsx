/**
 * CircleSection — shows mutual connections on other users' public profiles.
 * Renders: heading, stacked avatar chips, "N people you both know", "See all" link.
 * Returns null when viewer is unauthenticated, viewing own profile, or no mutuals.
 */
import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, Image, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Users } from 'lucide-react-native';
import { getMutualFollows, type MutualFollowUser } from '../../services/follows.ts';
import { useSession } from '../../context/SessionContext.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

const MAX_AVATARS = 5;

interface Props {
  targetUserId: string;
}

export function CircleSection({ targetUserId }: Props) {
  const { isAuthed, userId: viewerId } = useSession();
  const [mutuals, setMutuals] = useState<MutualFollowUser[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isAuthed || !targetUserId || viewerId === targetUserId) {
      setReady(true);
      return;
    }
    let alive = true;
    getMutualFollows(targetUserId).then((result) => {
      if (!alive) return;
      setMutuals(result);
      setReady(true);
    });
    return () => { alive = false; };
  }, [isAuthed, targetUserId, viewerId]);

  // Don't render anything until the fetch settles (avoids layout jump)
  if (!ready || !isAuthed || viewerId === targetUserId) return null;
  if (mutuals.length === 0) return null;

  const visibleAvatars = mutuals.slice(0, MAX_AVATARS);
  const count = mutuals.length;
  const countLabel =
    count === 1
      ? '1 person you both know'
      : `${count >= 20 ? '20+' : count} people you both know`;

  return (
    <View style={cs.section}>
      <View style={cs.headerRow}>
        <Users size={13} color={color.mute} strokeWidth={1.8} />
        <Text style={cs.heading}>CIRCLE</Text>
      </View>

      <View style={cs.contentRow}>
        {/* Stacked avatar chips */}
        <View style={cs.avatarStack}>
          {visibleAvatars.map((u, i) => (
            <View
              key={u.id}
              style={[cs.avatarWrap, i > 0 && { marginLeft: -10 }, { zIndex: MAX_AVATARS - i }]}
            >
              {u.avatarUrl ? (
                <Image source={{ uri: u.avatarUrl }} style={cs.avatar} />
              ) : (
                <View style={[cs.avatar, cs.avatarFallback]}>
                  <Text style={cs.avatarInitial}>
                    {((u.displayName ?? u.handle ?? '?')[0] ?? '?').toUpperCase()}
                  </Text>
                </View>
              )}
            </View>
          ))}
        </View>

        {/* Label */}
        <Text style={cs.label} numberOfLines={2}>
          {countLabel}
        </Text>

        {/* See all */}
        <Pressable
          style={cs.seeAllBtn}
          onPress={() => router.push(`/mutual-connections/${targetUserId}` as any)}
          hitSlop={8}
          accessibilityLabel="See all mutual connections"
          accessibilityRole="button"
        >
          <Text style={cs.seeAllText}>See all →</Text>
        </Pressable>
      </View>
    </View>
  );
}

const cs = StyleSheet.create({
  section: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  heading: {
    fontSize: 10,
    fontWeight: '700',
    color: color.mute,
    letterSpacing: 1.2,
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  avatarStack: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  avatarWrap: {
    borderRadius: 16,
    borderWidth: 2,
    borderColor: color.paper,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: color.haze,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 11,
    fontWeight: '700',
    color: color.mute,
  },
  label: {
    flex: 1,
    fontSize: 13,
    color: color.ink,
    fontWeight: '500',
    lineHeight: 17,
  },
  seeAllBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexShrink: 0,
  },
  seeAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: color.signal,
  },
});
