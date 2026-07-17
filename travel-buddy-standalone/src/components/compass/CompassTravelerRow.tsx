/**
 * CompassTravelerRow — horizontal strip of Compass-matched traveler cards.
 *
 * Appears on:
 *   • Search screen empty state (below recent history)
 *   • Discovery → For You tab (above place cards)
 *
 * Self-hides when:
 *   - show_people_recommendations is false in compass_settings
 *   - the API returns 0 results
 *   - loading fails
 *
 * Each card shows avatar, name, shared interests, and a Follow button.
 * Private profiles show a "Request Follow" button instead.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, Image, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { Users, Sparkles, CheckCircle, MapPin, MoreHorizontal } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { primaryIdentityText, secondaryIdentityText } from '../../lib/displayIdentity.ts';
import {
  fetchCompassSettings,
  fetchCompassTravelerMatches,
  type CompassTravelerResult,
} from '../../services/compass.ts';
import { followUser } from '../../services/follows.ts';
import { reportContent } from '../../services/reports.ts';
import { blockUser } from '../../services/blocks.ts';

interface Props {
  city?: string | null;
  limit?: number;
}

function TravelerSkeleton() {
  return (
    <View style={[s.card, s.skeleton]}>
      <View style={[s.skBar, { width: 48, height: 48, borderRadius: 24, marginBottom: space.sm, alignSelf: 'center' }]} />
      <View style={[s.skBar, { width: 72, height: 10, marginBottom: 5 }]} />
      <View style={[s.skBar, { width: 56, height: 8, marginBottom: space.sm }]} />
      <View style={[s.skBar, { width: 68, height: 24, borderRadius: radius.md }]} />
    </View>
  );
}

function TravelerCard({ item }: { item: CompassTravelerResult }) {
  const d = item.data;
  const [followed, setFollowed] = useState(d.followStatus === 'following');
  const [requested, setRequested] = useState(d.followStatus === 'requested');
  const [inFlight, setInFlight] = useState(false);
  const [hidden, setHidden] = useState(false);

  const displayName = d.displayName
    ? primaryIdentityText({ displayName: d.displayName })
    : (d.isPrivate ? 'Private Traveler' : primaryIdentityText({ username: d.username }));
  const usernameSubline = secondaryIdentityText({ displayName: d.displayName, username: d.username });
  const initials = displayName.replace(/^@/, '').slice(0, 2).toUpperCase();

  const handleFollow = async () => {
    if (followed || requested || inFlight) return;
    setInFlight(true);
    const res = await followUser(d.userId);
    setInFlight(false);
    if (res.ok) {
      if (d.isPrivate) setRequested(true);
      else setFollowed(true);
    }
  };

  const handlePress = () => {
    if (!d.isPrivate || followed) {
      router.push(`/profile/${d.userId}` as any);
    }
  };

  const submitReport = async (reason_code: 'spam' | 'harassment' | 'impersonation' | 'other') => {
    const res = await reportContent({ target_type: 'user', target_id: d.userId, reason_code });
    Alert.alert(
      res.ok ? 'Report submitted' : 'Could not submit report',
      res.ok
        ? 'Thanks for helping keep the community safe.'
        : 'Something went wrong. Please try again later.',
    );
  };

  const handleOverflow = () => {
    Alert.alert(
      displayName,
      undefined,
      [
        {
          text: 'Report',
          onPress: () => {
            Alert.alert(
              'Report this traveler',
              'Why are you reporting this person?',
              [
                { text: 'Spam',          onPress: () => submitReport('spam') },
                { text: 'Harassment',    onPress: () => submitReport('harassment') },
                { text: 'Impersonation', onPress: () => submitReport('impersonation') },
                { text: 'Other',         onPress: () => submitReport('other') },
                { text: 'Cancel', style: 'cancel' as const },
              ],
            );
          },
        },
        {
          text: 'Block',
          style: 'destructive' as const,
          onPress: () => {
            Alert.alert(
              `Block ${displayName}?`,
              'They will not be able to see your profile or contact you.',
              [
                {
                  text: 'Block',
                  style: 'destructive' as const,
                  onPress: async () => {
                    const res = await blockUser(d.userId);
                    if (res.ok) setHidden(true);
                  },
                },
                { text: 'Cancel', style: 'cancel' as const },
              ],
            );
          },
        },
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );
  };

  const btnLabel = followed ? 'Following' : requested ? 'Requested' : d.isPrivate ? 'Request' : 'Follow';
  const btnDisabled = followed || requested || inFlight;

  if (hidden) return null;

  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
      onPress={handlePress}
    >
      {/* Avatar */}
      <View style={s.avatarWrap}>
        {d.avatarUrl ? (
          <Image source={{ uri: d.avatarUrl }} style={s.avatar} />
        ) : (
          <View style={[s.avatar, s.avatarPlaceholder]}>
            <Text style={s.avatarInitial}>{initials}</Text>
          </View>
        )}
        {d.verified && (
          <View style={s.verifiedBadge}>
            <CheckCircle size={11} color={color.success} fill={color.paper} />
          </View>
        )}
      </View>

      {/* Name */}
      <Text style={s.name} numberOfLines={1}>{displayName}</Text>

      {/* Username — hidden for unfollowed private profiles */}
      {usernameSubline && !d.isPrivate ? (
        <Text style={s.username} numberOfLines={1}>{usernameSubline}</Text>
      ) : null}

      {/* City — hidden for unfollowed private profiles */}
      {d.homeCity && !d.isPrivate ? (
        <View style={s.cityRow}>
          <MapPin size={8} color={color.faint} />
          <Text style={s.cityText} numberOfLines={1}>{d.homeCity}</Text>
        </View>
      ) : null}

      {/* Shared interests — hidden for unfollowed private profiles */}
      {!d.isPrivate && d.sharedInterests && d.sharedInterests.length > 0 ? (
        <View style={s.interestRow}>
          <Sparkles size={8} color={color.signal} />
          <Text style={s.interestText} numberOfLines={1}>
            {d.sharedInterests.slice(0, 2).join(', ')}
          </Text>
        </View>
      ) : (
        <View style={s.reasonRow}>
          <Text style={s.reasonText} numberOfLines={2}>{item.reason}</Text>
        </View>
      )}

      {/* Follow / Requested / Following button */}
      <Pressable
        style={({ pressed }) => [
          s.followBtn,
          (followed || requested) && s.followedBtn,
          (inFlight || btnDisabled) && { opacity: 0.7 },
          pressed && { opacity: 0.6 },
        ]}
        onPress={handleFollow}
        disabled={btnDisabled}
      >
        <Text style={[s.followText, (followed || requested) && s.followedText]}>
          {btnLabel}
        </Text>
      </Pressable>

      {/* Overflow — report / block */}
      <Pressable
        style={({ pressed }) => [s.overflowBtn, pressed && { opacity: 0.6 }]}
        hitSlop={8}
        onPress={handleOverflow}
        accessibilityLabel="More options"
      >
        <MoreHorizontal size={14} color={color.faint} />
      </Pressable>
    </Pressable>
  );
}

export function CompassTravelerRow({ city, limit = 6 }: Props) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<CompassTravelerResult[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Settings gate — skip traveler API call if setting is off
      const settingsRes = await fetchCompassSettings();
      if (!cancelled && settingsRes.ok && settingsRes.data?.show_people_recommendations === false) {
        setLoading(false);
        return;
      }

      const res = await fetchCompassTravelerMatches({ city, limit });
      if (!cancelled) {
        setItems((res.ok && !res.disabled) ? (res.data ?? []) : []);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [city, limit]);

  if (loading) {
    return (
      <View style={s.wrap}>
        <View style={s.header}>
          <Users size={13} color={color.signal} />
          <Text style={s.headerText}>Travelers You May Vibe With</Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.strip}>
          <TravelerSkeleton />
          <TravelerSkeleton />
          <TravelerSkeleton />
        </ScrollView>
      </View>
    );
  }

  if (items.length === 0) return null;

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <Users size={13} color={color.signal} />
        <Text style={s.headerText}>Travelers You May Vibe With</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.strip}>
        {items.map((item) => (
          <TravelerCard key={item.id} item={item} />
        ))}
      </ScrollView>
    </View>
  );
}

const CARD_W = 120;

const s = StyleSheet.create({
  wrap: {
    marginBottom: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  headerText: {
    ...t.bodyStrong,
    fontSize: 13,
    color: color.ink,
  },
  strip: {
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  card: {
    width: CARD_W,
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
    gap: space.xs,
    alignItems: 'center',
  },
  skeleton: {
    opacity: 0.5,
  },
  skBar: {
    backgroundColor: color.haze,
    borderRadius: 4,
  },
  avatarWrap: {
    position: 'relative',
    marginBottom: space.xs,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  avatarPlaceholder: {
    backgroundColor: color.signal + '20',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    ...t.bodyStrong,
    color: color.signal,
    fontSize: 16,
  },
  verifiedBadge: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    backgroundColor: color.paper,
    borderRadius: 8,
    padding: 1,
  },
  name: {
    ...t.bodyStrong,
    fontSize: 12,
    color: color.ink,
    textAlign: 'center',
  },
  username: {
    ...t.small,
    fontSize: 10,
    color: color.mute,
    textAlign: 'center',
  },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  cityText: {
    ...t.small,
    fontSize: 9,
    color: color.faint,
  },
  interestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  interestText: {
    ...t.small,
    fontSize: 9,
    color: color.signal,
    fontStyle: 'italic',
    flex: 1,
    textAlign: 'center',
  },
  reasonRow: {
    paddingHorizontal: 2,
  },
  reasonText: {
    ...t.small,
    fontSize: 9,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 13,
    fontStyle: 'italic',
  },
  followBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    marginTop: space.xs,
  },
  followedBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: color.haze,
  },
  followText: {
    ...t.small,
    fontSize: 11,
    color: color.onInk,
    fontWeight: '600',
  },
  followedText: {
    color: color.mute,
  },
  overflowBtn: {
    position: 'absolute',
    top: space.xs,
    right: space.xs,
    padding: 3,
  },
});
