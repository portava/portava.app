/**
 * TagPreviewSheet — bottom-sheet that shows a mini-card for a @mention or #hashtag.
 *
 * - User preview: avatar, name, handle, bio, follower count, Follow CTA
 * - Hashtag preview: slug, usage count, Follow/Unfollow CTA
 * - "View full page" navigates to the entity's screen (handled by parent via onNavigate)
 */
import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, Pressable, StyleSheet, ActivityIndicator,
  Image,
} from 'react-native';
import { X, Hash, User } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, shadow } from '../theme/tokens';
import {
  getHashtag, getUserByHandle, followHashtag, unfollowHashtag,
  type HashtagMeta, type UserPreview,
} from '../services/hashtag';

interface Props {
  visible: boolean;
  type: 'user' | 'hashtag';
  /** handle (without @) for users, slug (without #) for hashtags */
  id: string;
  onClose: () => void;
  onNavigate: () => void;
}

export function TagPreviewSheet({ visible, type, id, onClose, onNavigate }: Props) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hashtagData, setHashtagData] = useState<HashtagMeta | null>(null);
  const [userData, setUserData] = useState<UserPreview | null>(null);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);

  useEffect(() => {
    if (!visible || !id) return;
    setError(null);
    setHashtagData(null);
    setUserData(null);

    setLoading(true);
    if (type === 'hashtag') {
      getHashtag(id).then((res) => {
        setLoading(false);
        if (res.ok && res.data) {
          setHashtagData(res.data);
          setFollowing(res.data.isFollowing);
        } else {
          setError(res.error ?? 'Could not load hashtag');
        }
      });
    } else {
      getUserByHandle(id).then((res) => {
        setLoading(false);
        if (res.ok && res.data) {
          setUserData(res.data);
          setFollowing(res.data.isFollowing ?? false);
        } else {
          setError(res.error ?? 'Could not load user');
        }
      });
    }
  }, [visible, type, id]);

  async function handleFollow() {
    if (followBusy || type !== 'hashtag') return;
    setFollowBusy(true);
    const res = following
      ? await unfollowHashtag(id)
      : await followHashtag(id);
    if (res.ok) setFollowing((v) => !v);
    setFollowBusy(false);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
        <View style={s.grab} />

        <View style={s.header}>
          <Text style={s.headerLabel}>
            {type === 'hashtag' ? 'Hashtag' : 'User'}
          </Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <X size={18} color={color.ink} />
          </Pressable>
        </View>

        {loading && (
          <View style={s.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        )}

        {!loading && error && (
          <View style={s.center}>
            <Text style={s.errorText}>{error}</Text>
          </View>
        )}

        {!loading && !error && type === 'hashtag' && hashtagData && (
          <HashtagCard
            data={hashtagData}
            following={following}
            followBusy={followBusy}
            onFollow={handleFollow}
            onNavigate={onNavigate}
          />
        )}

        {!loading && !error && type === 'user' && userData && (
          <UserCard data={userData} onNavigate={onNavigate} />
        )}
      </View>
    </Modal>
  );
}

function HashtagCard({
  data, following, followBusy, onFollow, onNavigate,
}: {
  data: HashtagMeta;
  following: boolean;
  followBusy: boolean;
  onFollow: () => void;
  onNavigate: () => void;
}) {
  return (
    <View style={s.card}>
      <View style={s.hashtagIconWrap}>
        <Hash size={28} color={color.deep} />
      </View>
      <Text style={s.hashtagSlug}>#{data.slug}</Text>
      <Text style={s.hashtagCount}>
        {data.usageCount.toLocaleString()} {data.usageCount === 1 ? 'post' : 'posts'}
      </Text>

      <View style={s.ctaRow}>
        <Pressable
          style={[s.followBtn, following && s.followBtnActive]}
          onPress={onFollow}
          disabled={followBusy}
        >
          {followBusy
            ? <ActivityIndicator size="small" color={following ? color.deep : color.onInk} />
            : <Text style={[s.followBtnText, following && s.followBtnTextActive]}>
                {following ? 'Following' : 'Follow'}
              </Text>
          }
        </Pressable>
        <Pressable style={s.viewBtn} onPress={onNavigate}>
          <Text style={s.viewBtnText}>View feed</Text>
        </Pressable>
      </View>
    </View>
  );
}

function UserCard({ data, onNavigate }: { data: UserPreview; onNavigate: () => void }) {
  const initials = (data.name ?? data.handle)
    .split(' ')
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <View style={s.card}>
      <View style={s.userRow}>
        {data.avatarUrl ? (
          <Image source={{ uri: data.avatarUrl }} style={s.avatar} />
        ) : (
          <View style={[s.avatar, s.avatarFallback]}>
            <Text style={s.avatarInitial}>{initials}</Text>
          </View>
        )}
        <View style={s.userInfo}>
          <Text style={s.userName}>{data.name ?? data.handle}</Text>
          <Text style={s.userHandle}>@{data.handle}</Text>
          {data.followersCount != null && (
            <Text style={s.userMeta}>
              {data.followersCount.toLocaleString()} followers
            </Text>
          )}
        </View>
      </View>

      {!!data.bio && (
        <Text style={s.userBio} numberOfLines={3}>{data.bio}</Text>
      )}

      <Pressable style={s.viewBtnFull} onPress={onNavigate}>
        <Text style={s.viewBtnFullText}>View profile</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.45)',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    ...shadow.float,
  },
  grab: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center', marginTop: 10, marginBottom: 4,
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  headerLabel: { ...t.small, color: color.mute, fontWeight: '600' },
  center: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: space.xxxl,
  },
  errorText: { ...t.small, color: color.faint, textAlign: 'center' },

  card: { paddingHorizontal: space.lg, paddingBottom: space.lg, alignItems: 'center', gap: space.md },

  hashtagIconWrap: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: color.deep + '15',
    alignItems: 'center', justifyContent: 'center',
  },
  hashtagSlug: { ...t.title, color: color.ink, textAlign: 'center' },
  hashtagCount: { ...t.small, color: color.mute },

  ctaRow: { flexDirection: 'row', gap: space.sm, width: '100%', paddingTop: space.xs },
  followBtn: {
    flex: 1, paddingVertical: 12, borderRadius: radius.pill,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
  },
  followBtnActive: { backgroundColor: color.deep + '18', borderWidth: 1.5, borderColor: color.deep },
  followBtnText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  followBtnTextActive: { color: color.deep },
  viewBtn: {
    flex: 1, paddingVertical: 12, borderRadius: radius.pill,
    backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  viewBtnText: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },

  userRow: { flexDirection: 'row', gap: space.md, alignItems: 'center', alignSelf: 'stretch' },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: color.haze },
  avatarFallback: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { fontSize: 20, fontWeight: '700', color: color.onInk },
  userInfo: { flex: 1, gap: 2 },
  userName: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  userHandle: { ...t.small, color: color.mute },
  userMeta: { ...t.small, color: color.faint },
  userBio: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 20 },
  viewBtnFull: {
    width: '100%', paddingVertical: 12, borderRadius: radius.pill,
    backgroundColor: color.ink, alignItems: 'center',
  },
  viewBtnFullText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
});
