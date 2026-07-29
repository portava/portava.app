import React, { useState } from 'react';
import { View, Text, Image, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { UserCheck, UserPlus, Lock, User, Users, PlaneTakeoff, Sparkles } from 'lucide-react-native';
import { followUser, unfollowUser, type TravelerSearchResult } from '../services/follows.ts';
import { SaveButton } from './SaveButton.tsx';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { HighlightRing } from './HighlightRing.tsx';
import { HighlightViewer } from './HighlightViewer.tsx';
import { useHighlightRingState } from '../hooks/useHighlightRingState.ts';
import { UserAvatarButton } from './interaction/UserAvatarButton.tsx';
import { UserNameButton } from './interaction/UserNameButton.tsx';
import { UserOverflowMenu } from './interaction/UserOverflowMenu.tsx';
import { primaryIdentityText, secondaryIdentityText } from '../lib/displayIdentity.ts';

function rowSignalIcon(signal: string) {
  const lower = signal.toLowerCase();
  if (lower.includes('follow')) return <User size={10} color={color.signal} />;
  if (lower.includes('mutual')) return <Users size={10} color={color.signal} />;
  if (lower.includes('style') || lower.includes('interest')) return <Sparkles size={10} color={color.signal} />;
  return <PlaneTakeoff size={10} color={color.signal} />;
}

function RowReasonLines({ reason }: { reason: string }) {
  const parts = reason.split(' · ');
  return (
    <View style={styles.reasonMulti}>
      {parts.map((part, i) => (
        <View key={i} style={styles.reasonRow}>
          {rowSignalIcon(part)}
          <Text style={styles.reasonText} numberOfLines={1}>{part}</Text>
        </View>
      ))}
    </View>
  );
}

interface Props {
  user: TravelerSearchResult;
  isOwnProfile?: boolean;
  onFollowed?: (userId: string) => void;
  onBlockSuccess?: (userId: string) => void;
}

export function TravelerRow({ user, isOwnProfile = false, onFollowed, onBlockSuccess }: Props) {
  const [isFollowing, setIsFollowing] = useState(user.isFollowing);
  const [followerCount, setFollowerCount] = useState(user.followerCount);

  // Re-sync local mirrors when a fresh search/suggestion result comes in for
  // this same user (e.g. re-running a search after their follower count
  // changed) — this component instance can be reused across result sets
  // with the same `user.id` but a stale locally-held count/isFollowing.
  const lastSyncedUserRef = React.useRef(user);
  if (lastSyncedUserRef.current !== user) {
    lastSyncedUserRef.current = user;
    if (followerCount !== user.followerCount) setFollowerCount(user.followerCount);
    if (isFollowing !== user.isFollowing) setIsFollowing(user.isFollowing);
  }
  const [toggling, setToggling] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  // For private accounts: tracks whether the viewer has sent a follow request.
  // Initialised from the server-provided friendRequestPending field so the
  // "Pending" state survives app restarts without an extra round-trip.
  const [requestSent, setRequestSent] = useState(user.friendRequestPending ?? false);
  const [requesting, setRequesting] = useState(false);
  const ringState = useHighlightRingState(user.id);

  if (hidden) return null;

  async function handleToggle() {
    if (toggling) return;
    const wasFollowing = isFollowing;
    setToggling(true);
    setIsFollowing(!wasFollowing);
    setFollowerCount((c) => wasFollowing ? Math.max(0, c - 1) : c + 1);

    const res = wasFollowing
      ? await unfollowUser(user.id)
      : await followUser(user.id);

    if (!res.ok) {
      setIsFollowing(wasFollowing);
      setFollowerCount((c) => wasFollowing ? c + 1 : Math.max(0, c - 1));
    } else if (!wasFollowing) {
      onFollowed?.(user.id);
    }
    setToggling(false);
  }

  // Sends a follow request to a private account. The server converts the
  // follow call into a friend_request row and returns { friendRequest: true }.
  async function handleRequest() {
    if (requesting || requestSent) return;
    setRequesting(true);
    const res = await followUser(user.id);
    setRequesting(false);
    if (res.ok) {
      setRequestSent(true);
      onFollowed?.(user.id);
    }
  }

  function handleBlockSuccess(userId: string) {
    setHidden(true);
    onBlockSuccess?.(userId);
  }

  const displayName = primaryIdentityText({ displayName: user.displayName, username: user.username });
  const handleSubline = secondaryIdentityText({ displayName: user.displayName, username: user.username });

  return (
    <>
    <View style={styles.row}>
      <HighlightRing
        hasActive={ringState?.hasActive ?? false}
        allViewed={ringState?.allViewed ?? false}
        size={48}
        ringWidth={2}
        gap={2}
        onPress={ringState?.hasActive ? () => setViewerOpen(true) : undefined}
      >
        <UserAvatarButton
          userId={user.id}
          handle={user.username}
          avatarUrl={user.avatarUrl}
          size={48}
        />
      </HighlightRing>

      <View style={styles.info}>
        <UserNameButton
          userId={user.id}
          handle={user.username}
          displayName={displayName}
          style={styles.name}
          verified={user.verified}
          isOfficial={user.isOfficial}
        />
        {handleSubline ? (
          <Text style={styles.handle} numberOfLines={1}>{handleSubline}</Text>
        ) : null}
        {user.isPrivate ? (
          <View style={styles.privateBadge}>
            <Lock size={10} color={color.mute} />
            <Text style={styles.privateText}>Private</Text>
          </View>
        ) : (
          <Text style={styles.followers}>
            {followerCount === 1 ? '1 follower' : `${followerCount} followers`}
          </Text>
        )}
        {user.reason ? <RowReasonLines reason={user.reason} /> : null}
      </View>

      {!isOwnProfile && user.isPrivate ? (
        // Private account: show "Request" → "Pending" instead of Follow/Following.
        requestSent ? (
          <View style={[styles.followBtn, styles.followingBtn]}>
            <UserCheck size={13} color={color.mute} />
            <Text style={styles.followingText}>Pending</Text>
          </View>
        ) : (
          <Pressable
            style={styles.followBtn}
            onPress={handleRequest}
            disabled={requesting}
          >
            {requesting ? (
              <ActivityIndicator size="small" color={color.onInk} />
            ) : (
              <>
                <UserPlus size={13} color={color.onInk} />
                <Text style={styles.followText}>Follow</Text>
              </>
            )}
          </Pressable>
        )
      ) : !isOwnProfile ? (
        <Pressable
          style={[styles.followBtn, isFollowing && styles.followingBtn]}
          onPress={handleToggle}
          disabled={toggling}
        >
          {toggling ? (
            <ActivityIndicator size="small" color={isFollowing ? color.mute : color.onInk} />
          ) : isFollowing ? (
            <>
              <UserCheck size={13} color={color.mute} />
              <Text style={styles.followingText}>Following</Text>
            </>
          ) : (
            <>
              <UserPlus size={13} color={color.onInk} />
              <Text style={styles.followText}>Follow</Text>
            </>
          )}
        </Pressable>
      ) : null}

      {!isOwnProfile && (
        <SaveButton entityType="profile" entityId={user.id} />
      )}
      {!isOwnProfile && (
        <UserOverflowMenu
          userId={user.id}
          displayName={displayName}
          onBlockSuccess={handleBlockSuccess}
        />
      )}
    </View>
    <HighlightViewer
      visible={viewerOpen}
      highlights={ringState?.highlights ?? []}
      onClose={() => setViewerOpen(false)}
    />
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  handle: {
    fontFamily: 'Courier',
    fontSize: 12,
    color: color.mute,
  },
  followers: {
    fontSize: 11,
    color: color.faint,
    marginTop: 1,
  },
  reasonMulti: {
    marginTop: 2,
    gap: 2,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  reasonText: {
    fontSize: 11,
    color: color.signal,
    flexShrink: 1,
  },
  privateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 2,
  },
  privateText: {
    fontSize: 11,
    color: color.mute,
    fontStyle: 'italic',
  },
  saveProfileBtn: { padding: 4 },
  followBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: color.signal,
    paddingHorizontal: space.md,
    paddingVertical: space.sm - 1,
    borderRadius: radius.pill,
    minWidth: 84,
    justifyContent: 'center',
  },
  followingBtn: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  followText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 12,
  },
  followingText: {
    ...t.bodyStrong,
    color: color.mute,
    fontSize: 12,
  },
});
