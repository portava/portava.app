import React, { useState } from 'react';
import {
  View, Text, Pressable, ActivityIndicator, StyleSheet, Image,
} from 'react-native';
import { router } from 'expo-router';
import {
  UserPlus, UserCheck, MapPin, Bookmark, BookmarkCheck,
  Clock, Lock, Star,
} from 'lucide-react-native';
import { getPlaceCategoryFallback } from '../../utils/placeCategoryFallback.ts';
import { UserAvatarButton } from '../interaction/UserAvatarButton.tsx';
import { followUser, unfollowUser } from '../../services/follows.ts';
import { rsvpEvent } from '../../services/events.ts';
import { saveItem, unsaveItem } from '../../services/collections.ts';
import type { UnifiedSearchResult } from '../../services/discovery.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { TypeIcon, resolveRoute } from './searchNav.tsx';

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

// TypeIcon + resolveRoute now live in ./searchNav (shared with the
// typeahead SearchSuggestionsPanel so both surfaces stay in lockstep).

// ── Place image with category emoji fallback ──────────────────────────────────

function PlaceImageThumbnail({ imageUrl, category, size }: {
  imageUrl: string | null;
  category: string;
  size: number;
}) {
  const fallback = getPlaceCategoryFallback(category);
  const [imgFailed, setImgFailed] = React.useState(false);
  if (imageUrl && !imgFailed) {
    return (
      <View style={[thumbStyles.wrap, { width: size, height: size }]} testID="place-result-image">
        <Image
          source={{ uri: imageUrl }}
          style={{ width: size, height: size }}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />
      </View>
    );
  }
  return (
    <View
      style={[
        thumbStyles.wrap,
        thumbStyles.fallback,
        { width: size, height: size, backgroundColor: fallback.color + '20' },
      ]}
      testID="place-result-fallback"
    >
      <Text style={{ fontSize: size * 0.38 }}>{fallback.emoji}</Text>
    </View>
  );
}

/** Renders an initials pill consistent with the shared avatar style. */
function InitialsFallback({ initials, size }: { initials: string; size: number }) {
  return (
    <View style={[styles.initialsCircle, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.initialsText, { fontSize: size * 0.36 }]}>
        {initials}
      </Text>
    </View>
  );
}

interface Props {
  result: UnifiedSearchResult;
  onActionStateChange?: (resultId: string, updates: Record<string, boolean>) => void;
}

export function SearchResultCard({ result, onActionStateChange }: Props) {
  const route = resolveRoute(result);
  const isPrivate = result.privacyState?.isPrivate ?? false;
  const canAccess = result.accessState?.canAccess ?? true;

  // ── Traveler follow state ──────────────────────────────────────────────────
  const [isFollowing, setIsFollowing] = useState(
    (result.actionState?.isFollowing as boolean | undefined) ?? false,
  );
  // Initialised from backend in case a prior request was already sent
  const [isRequestSent, setIsRequestSent] = useState(
    (result.actionState?.isRequestSent as boolean | undefined) ?? false,
  );
  const [followToggling, setFollowToggling] = useState(false);

  // ── Event RSVP state ───────────────────────────────────────────────────────
  const [isAttending, setIsAttending] = useState(
    (result.actionState?.isAttending as boolean | undefined) ?? false,
  );
  const [isWaitlisted, setIsWaitlisted] = useState(
    (result.actionState?.isWaitlisted as boolean | undefined) ?? false,
  );
  const [rsvpToggling, setRsvpToggling] = useState(false);

  // ── Trip join state ────────────────────────────────────────────────────────
  // Trips have no server-side join API in the current mobile services layer.
  // isMember is initialised from backend actionState for future-proofing; the
  // "Join" button navigates to the trip detail where joining is handled in context.
  const [isTripMember] = useState(
    (result.actionState?.isMember as boolean | undefined) ?? false,
  );

  // ── Place / post save state ────────────────────────────────────────────────
  const [isSaved, setIsSaved] = useState(
    (result.actionState?.isSaved as boolean | undefined) ?? false,
  );
  const [saveToggling, setSaveToggling] = useState(false);

  const isTraveler = result.type === 'travelers' || result.type === 'buddies';
  const isEvent = result.type === 'events';
  const isTrip = result.type === 'trips' || result.type === 'plans';
  const isPlace = result.type === 'places' || result.type === 'hidden_gems';
  const isSaveable = result.type === 'places' || result.type === 'hidden_gems' || result.type === 'posts';

  const placeCategory = (result.metadata?.category as string | undefined) ?? 'places';
  const placeRating = result.metadata?.rating != null ? Number(result.metadata.rating) : null;
  const placeIsOpen = result.metadata?.isOpenNow as boolean | undefined;

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
  async function handleEventJoin() {
    if (rsvpToggling) return;
    if (isAttending || isWaitlisted) {
      navigate();
      return;
    }
    setRsvpToggling(true);
    setIsAttending(true);
    try {
      const res = await rsvpEvent(result.id, 'going');
      if (!res.ok) {
        setIsAttending(false);
        return;
      }
      if (res.data && (res.data as any).status === 'waitlisted') {
        setIsAttending(false);
        setIsWaitlisted(true);
        onActionStateChange?.(result.id, { isWaitlisted: true });
      } else {
        onActionStateChange?.(result.id, { isAttending: true });
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

  // ── Invite-only: content inaccessible to viewer ────────────────────────
  const showRequestAccess = !canAccess && (isEvent || isTrip);

  // ── Traveler avatar: use UserAvatarButton (shared component) with initials
  // fallback via the children prop. When avatarUrl is present the component
  // renders the image normally; when absent we supply an InitialsFallback child
  // so the shared component renders it instead of the default 👤 icon.
  const initialsChild = isTraveler && !result.avatarUrl && result.fallbackInitials
    ? <InitialsFallback initials={result.fallbackInitials} size={AVATAR_SIZE} />
    : undefined;

  // Null route means the backend returned a result with no valid destination —
  // the item may have been deleted since it was indexed.
  if (!route) {
    return (
      <View style={[styles.row, styles.rowUnavailable]}>
        <View style={styles.avatarSquare}>
          <TypeIcon type={result.type} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, styles.unavailableText]} numberOfLines={1}>
            {result.title ?? 'Unavailable'}
          </Text>
          <Text style={styles.unavailableHint}>No longer available</Text>
        </View>
      </View>
    );
  }

  return (
    <Pressable style={styles.row} onPress={navigate}>
      {/* Left — UserAvatarButton for travelers/buddies, image+fallback for places, icon for others */}
      {isTraveler ? (
        <View style={styles.avatarCircle}>
          <UserAvatarButton
            userId={result.id}
            handle={result.subtitle ?? result.id}
            avatarUrl={result.avatarUrl}
            size={AVATAR_SIZE}
            disabled
          >
            {initialsChild}
          </UserAvatarButton>
        </View>
      ) : isPlace ? (
        <PlaceImageThumbnail
          imageUrl={result.imageUrl}
          category={placeCategory}
          size={AVATAR_SIZE}
        />
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

        {/* Rating / open status for place results */}
        {isPlace && (placeRating != null || placeIsOpen != null) && (
          <View style={styles.placeMetaRow}>
            {placeRating != null && (
              <>
                <Star size={10} color="#F59E0B" fill="#F59E0B" />
                <Text style={styles.placeRatingText}>{placeRating.toFixed(1)}</Text>
              </>
            )}
            {placeIsOpen != null && (
              <View style={[
                styles.placeOpenBadge,
                { backgroundColor: placeIsOpen ? '#16A34A18' : '#DC262618' },
              ]}>
                <Text style={[
                  styles.placeOpenText,
                  { color: placeIsOpen ? '#16A34A' : '#DC2626' },
                ]}>
                  {placeIsOpen ? 'Open' : 'Closed'}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Right — type-specific action buttons */}

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

      {/* Invite-only event or trip: Request Access → navigates to detail */}
      {showRequestAccess && (
        <Pressable style={styles.actionBtnOutline} onPress={navigate} hitSlop={8}>
          <Lock size={11} color={color.mute} />
          <Text style={styles.actionBtnOutlineText}>Request</Text>
        </Pressable>
      )}

      {/* Accessible event: Join → RSVP API; Attending / Waitlisted → navigates */}
      {isEvent && !showRequestAccess && (
        <Pressable
          style={[
            styles.actionBtn,
            (isAttending || isWaitlisted) && styles.actionBtnActive,
          ]}
          onPress={handleEventJoin}
          disabled={rsvpToggling}
          hitSlop={8}
        >
          {rsvpToggling ? (
            <ActivityIndicator
              size="small"
              color={(isAttending || isWaitlisted) ? color.mute : color.onInk}
            />
          ) : (
            <Text style={(isAttending || isWaitlisted) ? styles.actionBtnActiveText : styles.actionBtnText}>
              {isAttending ? 'Attending' : isWaitlisted ? 'Waitlisted' : 'Join'}
            </Text>
          )}
        </Pressable>
      )}

      {/* Trip/plan (accessible): Join navigates to trip detail.
          The mobile services layer has no public requestToJoin endpoint for trips;
          joining is handled contextually on the trip detail screen. */}
      {isTrip && !showRequestAccess && (
        <Pressable
          style={[styles.actionBtnOutline, isTripMember && styles.actionBtnActive]}
          onPress={navigate}
          hitSlop={8}
        >
          <Text style={isTripMember ? styles.actionBtnActiveText : styles.actionBtnOutlineText}>
            {isTripMember ? 'Joined' : 'Join'}
          </Text>
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

const thumbStyles = StyleSheet.create({
  wrap:     { borderRadius: 8, overflow: 'hidden' },
  fallback: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E8E8E8' },
});

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
  initialsCircle: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initialsText: {
    color: color.onInk,
    fontWeight: '700' as const,
    letterSpacing: 0.5,
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
  placeMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  placeRatingText: { fontSize: 11, color: '#1A1A2E', fontWeight: '600' as const },
  placeOpenBadge:  { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  placeOpenText:   { fontSize: 10, fontWeight: '600' as const },
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    minWidth: 60,
    justifyContent: 'center',
    flexShrink: 0,
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
  rowUnavailable: {
    opacity: 0.5,
  },
  unavailableText: {
    color: color.mute,
  },
  unavailableHint: {
    ...t.small,
    color: color.faint,
    fontSize: 11,
    marginTop: 2,
  },
});
