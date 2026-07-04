import React, { useState } from 'react';
import {
  View, Text, Image, Pressable, ActivityIndicator, StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import {
  UserPlus, UserCheck, Calendar, MapPin, Hash, PlaneTakeoff,
  Sparkles, Users, FileText, Globe, Award,
} from 'lucide-react-native';
import { followUser, unfollowUser } from '../../services/follows';
import type { UnifiedSearchResult } from '../../services/discovery';
import { color, space, radius, type as t } from '../../theme/tokens';

export type { UnifiedSearchResult };

const TYPE_LABELS: Record<string, string> = {
  travelers: 'Traveler',
  buddies: 'Buddy',
  events: 'Event',
  trips: 'Trip',
  plans: 'Plan',
  places: 'Place',
  hidden_gems: 'Hidden Gem',
  hashtags: 'Hashtag',
  posts: 'Post',
  circles: 'Circle',
  cities: 'City',
  countries: 'Country',
  stamps: 'Stamp',
};

const TYPE_BADGE_BG: Record<string, string> = {
  travelers: '#E8F5E9',
  buddies: '#FFF3E0',
  events: '#E3F2FD',
  trips: '#FCE4EC',
  plans: '#FCE4EC',
  places: '#F3E5F5',
  hidden_gems: '#E8EAF6',
  hashtags: '#E8E5DE',
  posts: '#E8E5DE',
  circles: '#E1F5FE',
  cities: '#E8F5E9',
  countries: '#E8F5E9',
  stamps: '#FFF8E1',
};

const TYPE_BADGE_TEXT: Record<string, string> = {
  travelers: '#2E7D5B',
  buddies: '#C8851A',
  events: '#0A3D4A',
  trips: '#C0392B',
  plans: '#C0392B',
  places: '#6A1B9A',
  hidden_gems: '#3949AB',
  hashtags: '#6B6862',
  posts: '#6B6862',
  circles: '#0277BD',
  cities: '#2E7D5B',
  countries: '#2E7D5B',
  stamps: '#F57F17',
};

function TypeIcon({ type, size = 15 }: { type: string; size?: number }) {
  const c = color.deep;
  switch (type) {
    case 'travelers': case 'buddies': case 'circles': return <Users size={size} color={c} />;
    case 'events': case 'plans': return <Calendar size={size} color={c} />;
    case 'trips': return <PlaneTakeoff size={size} color={c} />;
    case 'places': return <MapPin size={size} color={c} />;
    case 'hidden_gems': return <Sparkles size={size} color={c} />;
    case 'hashtags': return <Hash size={size} color={c} />;
    case 'posts': return <FileText size={size} color={c} />;
    case 'cities': case 'countries': return <Globe size={size} color={c} />;
    case 'stamps': return <Award size={size} color={c} />;
    default: return <MapPin size={size} color={c} />;
  }
}

function resolveRoute(destinationRoute: string | null): string | null {
  if (!destinationRoute) return null;
  const placeMatch = destinationRoute.match(/^\/place\/(.+)$/);
  if (placeMatch) return `/gems/${placeMatch[1]}`;
  const hiddenGemMatch = destinationRoute.match(/^\/hidden-gem\/(.+)$/);
  if (hiddenGemMatch) return `/gems/${hiddenGemMatch[1]}`;
  return destinationRoute;
}

interface Props {
  result: UnifiedSearchResult;
  onActionStateChange?: (resultId: string, updates: Record<string, boolean>) => void;
}

export function SearchResultCard({ result, onActionStateChange }: Props) {
  const [imgError, setImgError] = useState(false);
  const [isFollowing, setIsFollowing] = useState(
    (result.actionState?.isFollowing as boolean | undefined) ?? false,
  );
  const [toggling, setToggling] = useState(false);

  const route = resolveRoute(result.destinationRoute);
  const isPrivate = result.privacyState?.isPrivate ?? false;
  const isAttending = (result.actionState?.isAttending as boolean | undefined) ?? false;

  const label = TYPE_LABELS[result.type] ?? result.type;
  const badgeBg = TYPE_BADGE_BG[result.type] ?? color.haze;
  const badgeTextColor = TYPE_BADGE_TEXT[result.type] ?? color.mute;

  const isTraveler = result.type === 'travelers' || result.type === 'buddies';
  const isEvent = result.type === 'events';

  const mediaUrl = isTraveler ? result.avatarUrl : result.imageUrl;
  const hasMedia = !!mediaUrl && !imgError;

  function navigate() {
    if (!route) return;
    router.push(route as any);
  }

  async function handleFollowToggle() {
    if (toggling) return;
    const was = isFollowing;
    setToggling(true);
    setIsFollowing(!was);
    const res = was ? await unfollowUser(result.id) : await followUser(result.id);
    if (!res.ok) {
      setIsFollowing(was);
    } else {
      onActionStateChange?.(result.id, { isFollowing: !was });
    }
    setToggling(false);
  }

  return (
    <Pressable style={styles.row} onPress={navigate}>
      {/* Left — avatar or icon */}
      <View style={isTraveler ? styles.avatarCircle : styles.avatarSquare}>
        {hasMedia ? (
          <Image
            source={{ uri: mediaUrl! }}
            style={isTraveler ? styles.avatarImg : styles.coverImg}
            onError={() => setImgError(true)}
          />
        ) : (
          <View style={[styles.avatarFallback, isTraveler && styles.avatarFallbackCircle]}>
            {isTraveler ? (
              <Text style={styles.initials}>
                {result.fallbackInitials ?? '?'}
              </Text>
            ) : (
              <TypeIcon type={result.type} />
            )}
          </View>
        )}
      </View>

      {/* Centre — text */}
      <View style={styles.content}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
            {result.title}
          </Text>
          <View style={[styles.badge, { backgroundColor: badgeBg }]}>
            <Text style={[styles.badgeText, { color: badgeTextColor }]}>{label}</Text>
          </View>
        </View>

        {!!result.subtitle && (
          <Text style={styles.subtitle} numberOfLines={1}>{result.subtitle}</Text>
        )}

        {!!result.locationPreview && (
          <View style={styles.locationRow}>
            <MapPin size={10} color={color.faint} />
            <Text style={styles.locationText} numberOfLines={1}>{result.locationPreview}</Text>
          </View>
        )}

        {!!result.matchedReason && (
          <Text style={styles.reason} numberOfLines={1}>{result.matchedReason}</Text>
        )}
      </View>

      {/* Right — action button */}
      {isTraveler && !isPrivate ? (
        <Pressable
          style={[styles.actionBtn, isFollowing && styles.actionBtnActive]}
          onPress={handleFollowToggle}
          disabled={toggling}
          hitSlop={8}
        >
          {toggling ? (
            <ActivityIndicator
              size="small"
              color={isFollowing ? color.mute : color.onInk}
            />
          ) : isFollowing ? (
            <>
              <UserCheck size={12} color={color.mute} />
              <Text style={styles.actionBtnActiveText}>Following</Text>
            </>
          ) : (
            <>
              <UserPlus size={12} color={color.onInk} />
              <Text style={styles.actionBtnText}>Follow</Text>
            </>
          )}
        </Pressable>
      ) : isTraveler && isPrivate && !isFollowing ? (
        <Pressable style={[styles.actionBtn, styles.actionBtnOutline]} onPress={navigate} hitSlop={8}>
          <Text style={styles.actionBtnOutlineText}>Request</Text>
        </Pressable>
      ) : isEvent ? (
        <Pressable
          style={[styles.actionBtn, isAttending && styles.actionBtnActive]}
          onPress={navigate}
          hitSlop={8}
        >
          <Text style={isAttending ? styles.actionBtnActiveText : styles.actionBtnText}>
            {isAttending ? 'Attending' : 'Join'}
          </Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const AVATAR_SIZE = 44;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  avatarCircle: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    overflow: 'hidden',
    backgroundColor: color.haze,
  },
  avatarSquare: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImg: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  coverImg: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: radius.sm,
  },
  avatarFallback: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: radius.sm,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFallbackCircle: {
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: color.deep,
  },
  initials: {
    ...t.stamp,
    color: color.onInk,
    fontSize: 15,
  },
  content: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
    flexShrink: 1,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    flexShrink: 0,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700' as const,
    letterSpacing: 0.3,
  },
  subtitle: {
    ...t.small,
    color: color.mute,
    marginTop: 0,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 1,
  },
  locationText: {
    fontSize: 11,
    color: color.faint,
    flexShrink: 1,
  },
  reason: {
    fontSize: 11,
    color: color.signal,
    marginTop: 1,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: color.signal,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    minWidth: 72,
    justifyContent: 'center',
    flexShrink: 0,
  },
  actionBtnActive: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  actionBtnOutline: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  actionBtnText: {
    ...t.stamp,
    color: color.onInk,
    fontSize: 11,
  },
  actionBtnActiveText: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
  },
  actionBtnOutlineText: {
    ...t.stamp,
    color: color.ink,
    fontSize: 11,
  },
});
