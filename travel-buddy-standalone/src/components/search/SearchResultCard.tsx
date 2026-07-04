import React, { useState } from 'react';
import {
  View, Text, Pressable, ActivityIndicator, StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import {
  UserPlus, UserCheck, Calendar, MapPin, Hash, PlaneTakeoff,
  Sparkles, Users, FileText, Globe, Award, Bookmark, BookmarkCheck,
  Clock,
} from 'lucide-react-native';
import { UserAvatarButton } from '../interaction/UserAvatarButton';
import { followUser, unfollowUser } from '../../services/follows';
import { rsvpEvent } from '../../services/events';
import { saveItem, unsaveItem } from '../../services/collections';
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
    case 'places': case 'hidden_gems': return <MapPin size={size} color={c} />;
    case 'hashtags': return <Hash size={size} color={c} />;
    case 'posts': return <FileText size={size} color={c} />;
    case 'cities': case 'countries': return <Globe size={size} color={c} />;
    case 'stamps': return <Award size={size} color={c} />;
    default: return <Sparkles size={size} color={c} />;
  }
}

/**
 * Normalises backend destinationRoute values to actual in-app route paths.
 *
 * The backend emits paths from its own domain model which don't always match
 * the Expo Router file layout.  This is the single authoritative mapping table.
 */
function resolveRoute(destinationRoute: string | null, type: string): string | null {
  if (!destinationRoute) return null;

  // Travelers & buddies: backend emits /passport/:handle — app uses /u/:handle
  const passportMatch = destinationRoute.match(/^\/passport\/(.+)$/);
  if (passportMatch) return `/u/${passportMatch[1]}`;

  // Places and hidden gems both land on /gems/:id
  const hiddenGemMatch = destinationRoute.match(/^\/hidden-gem\/(.+)$/);
  if (hiddenGemMatch) return `/gems/${hiddenGemMatch[1]}`;

  const placeMatch = destinationRoute.match(/^\/place\/(.+)$/);
  if (placeMatch) return `/gems/${placeMatch[1]}`;

  // Cities and countries share /destination/:slug
  const cityMatch = destinationRoute.match(/^\/city\/(.+)$/);
  if (cityMatch) return `/destination/${cityMatch[1]}`;

  const countryMatch = destinationRoute.match(/^\/country\/(.+)$/);
  if (countryMatch) return `/destination/${countryMatch[1]}`;

  // Stamps: /stamps/:slug (plural backend) → /stamp/:stampId (singular app)
  const stampsMatch = destinationRoute.match(/^\/stamps\/(.+)$/);
  if (stampsMatch) return `/stamp/${stampsMatch[1]}`;

  // Circles: app has a singleton /circle screen with no parameterised route
  if (destinationRoute.startsWith('/circle/') || destinationRoute === '/circle') {
    return '/circle';
  }

  // Buddies with an un-normalised path: derive from id segment
  if (type === 'buddies' && !destinationRoute.startsWith('/u/')) {
    const seg = destinationRoute.match(/\/([^/]+)$/);
    if (seg) return `/u/${seg[1]}`;
  }

  // All other routes pass through verbatim (event, trip, plan, hashtag, post …)
  return destinationRoute;
}

interface Props {
  result: UnifiedSearchResult;
  onActionStateChange?: (resultId: string, updates: Record<string, boolean>) => void;
}

export function SearchResultCard({ result, onActionStateChange }: Props) {
  const route = resolveRoute(result.destinationRoute, result.type);
  const isPrivate = result.privacyState?.isPrivate ?? false;

  // ── Traveler follow state ──────────────────────────────────────────────────
  const [isFollowing, setIsFollowing] = useState(
    (result.actionState?.isFollowing as boolean | undefined) ?? false,
  );
  const [isRequestSent, setIsRequestSent] = useState(false);
  const [followToggling, setFollowToggling] = useState(false);

  // ── Event RSVP state ───────────────────────────────────────────────────────
  const [isAttending, setIsAttending] = useState(
    (result.actionState?.isAttending as boolean | undefined) ?? false,
  );
  const [rsvpToggling, setRsvpToggling] = useState(false);

  // ── Place / post save state ────────────────────────────────────────────────
  const [isSaved, setIsSaved] = useState(
    (result.actionState?.isSaved as boolean | undefined) ?? false,
  );
  const [saveToggling, setSaveToggling] = useState(false);

  const isTraveler = result.type === 'travelers' || result.type === 'buddies';
  const isEvent = result.type === 'events';
  const isSaveable = result.type === 'places' || result.type === 'hidden_gems' || result.type === 'posts';

  const label = TYPE_LABELS[result.type] ?? result.type;
  const badgeBg = TYPE_BADGE_BG[result.type] ?? color.haze;
  const badgeTextColor = TYPE_BADGE_TEXT[result.type] ?? color.mute;

  function navigate() {
    if (!route) return;
    router.push(route as any);
  }

  // ── Follow / request ────────────────────────────────────────────────────
  async function handleFollowToggle() {
    if (followToggling) return;
    setFollowToggling(true);

    if (isPrivate && !isFollowing) {
      // Private profile — send a follow request
      const res = await followUser(result.id);
      if (res.ok) {
        setIsRequestSent(true);
        onActionStateChange?.(result.id, { isRequestSent: true });
      }
      setFollowToggling(false);
      return;
    }

    const was = isFollowing;
    setIsFollowing(!was);
    const res = was ? await unfollowUser(result.id) : await followUser(result.id);
    if (!res.ok) {
      setIsFollowing(was);
    } else {
      onActionStateChange?.(result.id, { isFollowing: !was });
    }
    setFollowToggling(false);
  }

  // ── Event RSVP ──────────────────────────────────────────────────────────
  async function handleEventRsvp() {
    if (rsvpToggling || isAttending) {
      // Already attending — tap navigates to event detail
      navigate();
      return;
    }
    setRsvpToggling(true);
    setIsAttending(true);
    try {
      const res = await rsvpEvent(result.id, 'going');
      const ok = res && (res as any).ok !== false;
      if (ok) {
        onActionStateChange?.(result.id, { isAttending: true });
      } else {
        setIsAttending(false);
      }
    } catch {
      setIsAttending(false);
    } finally {
      setRsvpToggling(false);
    }
  }

  // ── Place / post save ────────────────────────────────────────────────────
  async function handleSaveToggle() {
    if (saveToggling) return;
    const was = isSaved;
    setSaveToggling(true);
    setIsSaved(!was);
    const entityType = result.type === 'posts' ? 'post' : 'place';
    const res = was
      ? await unsaveItem(entityType, result.id)
      : await saveItem(entityType, result.id);
    if (!res) {
      setIsSaved(was);
    } else {
      onActionStateChange?.(result.id, { isSaved: !was });
    }
    setSaveToggling(false);
  }

  return (
    <Pressable style={styles.row} onPress={navigate}>
      {/* Left — shared UserAvatarButton for travelers, icon square for others */}
      {isTraveler ? (
        <View style={styles.avatarCircle}>
          <UserAvatarButton
            userId={result.id}
            handle={result.subtitle ?? result.id}
            avatarUrl={result.avatarUrl}
            size={AVATAR_SIZE}
            disabled
          />
        </View>
      ) : (
        <View style={styles.avatarSquare}>
          <TypeIcon type={result.type} />
        </View>
      )}

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

      {/* Right — action buttons per type */}

      {/* Public traveler: Follow ↔ Following */}
      {isTraveler && !isPrivate && (
        <Pressable
          style={[styles.actionBtn, isFollowing && styles.actionBtnActive]}
          onPress={handleFollowToggle}
          disabled={followToggling}
          hitSlop={8}
        >
          {followToggling ? (
            <ActivityIndicator size="small" color={isFollowing ? color.mute : color.onInk} />
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
      )}

      {/* Private traveler (not yet following): Request / Requested */}
      {isTraveler && isPrivate && !isFollowing && (
        <Pressable
          style={[styles.actionBtn, isRequestSent && styles.actionBtnActive]}
          onPress={isRequestSent ? undefined : handleFollowToggle}
          disabled={followToggling || isRequestSent}
          hitSlop={8}
        >
          {followToggling ? (
            <ActivityIndicator size="small" color={color.onInk} />
          ) : isRequestSent ? (
            <>
              <Clock size={12} color={color.mute} />
              <Text style={styles.actionBtnActiveText}>Requested</Text>
            </>
          ) : (
            <Text style={styles.actionBtnText}>Request</Text>
          )}
        </Pressable>
      )}

      {/* Event: Join → calls RSVP; Attending → navigates to detail */}
      {isEvent && (
        <Pressable
          style={[styles.actionBtn, isAttending && styles.actionBtnActive]}
          onPress={handleEventRsvp}
          disabled={rsvpToggling}
          hitSlop={8}
        >
          {rsvpToggling ? (
            <ActivityIndicator size="small" color={isAttending ? color.mute : color.onInk} />
          ) : (
            <Text style={isAttending ? styles.actionBtnActiveText : styles.actionBtnText}>
              {isAttending ? 'Attending' : 'Join'}
            </Text>
          )}
        </Pressable>
      )}

      {/* Place / hidden gem / post: Save ↔ Saved bookmark */}
      {isSaveable && (
        <Pressable
          style={[styles.saveBtn, isSaved && styles.saveBtnActive]}
          onPress={handleSaveToggle}
          disabled={saveToggling}
          hitSlop={8}
        >
          {saveToggling ? (
            <ActivityIndicator size="small" color={isSaved ? color.signal : color.mute} />
          ) : isSaved ? (
            <BookmarkCheck size={16} color={color.signal} />
          ) : (
            <Bookmark size={16} color={color.mute} />
          )}
        </Pressable>
      )}
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
  saveBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  saveBtnActive: {
    borderColor: color.signal,
    backgroundColor: '#FFF0EE',
  },
});
