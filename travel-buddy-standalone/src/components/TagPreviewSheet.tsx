/**
 * TagPreviewSheet — bottom-sheet entity preview for @mention and #hashtag spans.
 *
 * Entity types:
 *   user    — fetches /api/users/by-handle/:handle; shows avatar, name, bio, followers, View CTA
 *   hashtag — fetches /api/hashtags/:slug; shows usage count, Follow/Unfollow, View feed CTA
 *   trip    — minimal card (no fetch); shows Plane icon + label + View trip CTA
 *   circle  — minimal card (no fetch); shows Users icon + label + View circle CTA
 *   event   — minimal card (no fetch); shows Calendar icon + label (no route yet)
 *   place   — minimal card (no fetch); shows MapPin icon + label + Discover CTA
 */
import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, Pressable, StyleSheet, ActivityIndicator, Image, Alert,
} from 'react-native';
import { Avatar } from './ui/Avatar.tsx';
import { closeThenNavigate } from '../lib/deferredNavigate.ts';
import {
  X, Hash, User, Plane, Users, Calendar, MapPin, Flag,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, shadow, avatar } from '../theme/tokens.ts';
import {
  getHashtag, getUserByHandle, followHashtag, unfollowHashtag, reportHashtag,
  type HashtagMeta, type UserPreview,
} from '../services/hashtag.ts';
import type { RichTextEntityType } from './RichText.tsx';
import { errorCopy } from '../lib/errorCopy.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

/** Entity types that can be previewed in this sheet (superset of RichTextEntityType). */
export type PreviewEntityType = RichTextEntityType | 'hashtag';

// ── Props ──────────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  type: PreviewEntityType;
  /** entity id — handle for users, slug for hashtags, UUID for everything else */
  id: string;
  /** display text from the span (used as fallback label for minimal cards) */
  label?: string;
  onClose: () => void;
  /** called when the user wants to navigate to the entity's full screen */
  onNavigate: () => void;
}

// ── Minimal entity card (for types without a quick-preview API) ────────────────

function MinimalCard({
  icon: Icon, iconBg, iconColor, title, subtitle, ctaLabel, onNavigate, onClose,
}: {
  icon: React.ComponentType<{ size: number; color: string }>;
  iconBg: string;
  iconColor: string;
  title: string;
  subtitle?: string;
  ctaLabel?: string;
  onNavigate?: () => void;
  onClose: () => void;
}) {
  return (
    <View style={s.card}>
      <View style={[s.typeIconWrap, { backgroundColor: iconBg }]}>
        <Icon size={28} color={iconColor} />
      </View>
      <Text style={s.entityTitle} numberOfLines={2}>{title}</Text>
      {subtitle && <Text style={s.entitySub}>{subtitle}</Text>}
      <View style={s.ctaRow}>
        {ctaLabel && onNavigate ? (
          <Pressable style={s.viewBtnFull} onPress={onNavigate}>
            <Text style={s.viewBtnFullText}>{ctaLabel}</Text>
          </Pressable>
        ) : (
          <Pressable style={s.dimBtnFull} onPress={onClose}>
            <Text style={s.dimBtnText}>Close</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ── Hashtag card ──────────────────────────────────────────────────────────────

function HashtagCard({
  data, following, followBusy, onFollow, onNavigate,
}: {
  data: HashtagMeta;
  following: boolean;
  followBusy: boolean;
  onFollow: () => void;
  onNavigate: () => void;
}) {
  const [reportBusy, setReportBusy] = useState(false);

  function handleReport() {
    Alert.alert(
      'Report hashtag',
      `Why are you reporting #${data.slug}?`,
      [
        {
          text: 'Spam',
          onPress: () => submitReport('spam'),
        },
        {
          text: 'Misleading',
          onPress: () => submitReport('misleading'),
        },
        {
          text: 'Abusive',
          onPress: () => submitReport('abusive'),
        },
        { text: 'Cancel', style: 'cancel' },
      ],
      { cancelable: true },
    );
  }

  async function submitReport(reason: 'spam' | 'misleading' | 'abusive') {
    setReportBusy(true);
    const res = await reportHashtag(data.slug, reason);
    setReportBusy(false);
    if (res.ok) {
      Alert.alert('Report submitted', 'Thanks for helping keep Portava safe.');
    } else {
      Alert.alert('Could not submit report', errorCopy(res.error, 'Please try again.'));
    }
  }

  return (
    <View style={s.card}>
      <View style={[s.typeIconWrap, { backgroundColor: color.deep + '15' }]}>
        <Hash size={28} color={color.deep} />
      </View>
      <Text style={s.hashtagSlug}>#{data.slug}</Text>
      <Text style={s.entitySub}>
        {data.usageCount.toLocaleString()} {data.usageCount === 1 ? 'post' : 'posts'}
        {data.topCity ? `  ·  top city: ${data.topCity}` : ''}
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
      <Pressable style={s.reportBtn} onPress={handleReport} disabled={reportBusy}>
        {reportBusy
          ? <ActivityIndicator size="small" color={color.faint} />
          : <>
              <Flag size={12} color={color.faint} />
              <Text style={s.reportBtnText}>Report hashtag</Text>
            </>
        }
      </Pressable>
    </View>
  );
}

// ── User card ─────────────────────────────────────────────────────────────────

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
        <Avatar uri={data.avatarUrl} name={data.name ?? data.handle} size={56} />
        <View style={s.userInfo}>
          <Text style={s.userName}>{data.name ?? data.handle}</Text>
          <Text style={s.userHandle}>@{data.handle}</Text>
          {data.followersCount != null && (
            <Text style={s.entitySub}>{data.followersCount.toLocaleString()} followers</Text>
          )}
        </View>
      </View>
      {!!data.bio && <Text style={s.userBio} numberOfLines={3}>{data.bio}</Text>}
      <Pressable style={s.viewBtnFull} onPress={onNavigate}>
        <Text style={s.viewBtnFullText}>View profile</Text>
      </Pressable>
    </View>
  );
}

// ── Root sheet ────────────────────────────────────────────────────────────────

export function TagPreviewSheet({ visible, type, id, label, onClose, onNavigate }: Props) {
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

    if (type === 'hashtag') {
      setLoading(true);
      getHashtag(id).then((res) => {
        setLoading(false);
        if (res.ok && res.data) {
          setHashtagData(res.data);
          setFollowing(res.data.isFollowing);
        } else {
          setError(res.error ?? 'Could not load hashtag');
        }
      });
    } else if (type === 'user') {
      setLoading(true);
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
    // other types use minimal cards — no fetch required
  }, [visible, type, id]);

  async function handleFollow() {
    if (followBusy || type !== 'hashtag') return;
    setFollowBusy(true);
    const res = following ? await unfollowHashtag(id) : await followHashtag(id);
    if (res.ok) setFollowing((v) => !v);
    setFollowBusy(false);
  }

  /** Strip the @ prefix from a displayText label for plain entity names. */
  function stripPrefix(raw: string | undefined) {
    if (!raw) return '';
    return raw.replace(/^[@#]/, '').trim();
  }

  function renderContent() {
    if (loading) {
      return (
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      );
    }
    if (error) {
      return (
        <View style={s.center}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      );
    }

    switch (type) {
      case 'hashtag':
        return hashtagData ? (
          <HashtagCard
            data={hashtagData}
            following={following}
            followBusy={followBusy}
            onFollow={handleFollow}
            onNavigate={onNavigate}
          />
        ) : null;

      case 'user':
        return userData ? (
          <UserCard data={userData} onNavigate={onNavigate} />
        ) : null;

      case 'trip':
        return (
          <MinimalCard
            icon={Plane}
            iconBg={color.deep + '18'}
            iconColor={color.deep}
            title={stripPrefix(label) || 'Trip'}
            subtitle="Trip"
            ctaLabel="View trip"
            onNavigate={onNavigate}
            onClose={onClose}
          />
        );

      case 'circle':
        return (
          <MinimalCard
            icon={Users}
            iconBg={color.warn + '18'}
            iconColor={color.warn}
            title={stripPrefix(label) || 'Circle'}
            subtitle="Circle"
            ctaLabel="View circle"
            onNavigate={onNavigate}
            onClose={onClose}
          />
        );

      case 'event':
        return (
          <MinimalCard
            icon={Calendar}
            iconBg={'#8B5CF6' + '18'}
            iconColor="#8B5CF6"
            title={stripPrefix(label) || 'Event'}
            subtitle="Event"
            onClose={onClose}
          />
        );

      case 'place':
        return (
          <MinimalCard
            icon={MapPin}
            iconBg={color.success + '18'}
            iconColor={color.success}
            title={stripPrefix(label) || 'Place'}
            subtitle="Place"
            ctaLabel="Discover"
            onNavigate={() => { closeThenNavigate(onClose, '/(tabs)/discovery'); }}
            onClose={onClose}
          />
        );

      default:
        return null;
    }
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
            {type === 'hashtag' ? 'Hashtag' :
             type === 'user'    ? 'User' :
             type === 'trip'    ? 'Trip' :
             type === 'circle'  ? 'Circle' :
             type === 'event'   ? 'Event' : 'Place'}
          </Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <X size={18} color={color.ink} />
          </Pressable>
        </View>
        {renderContent()}
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,17,15,0.45)' },
  sheet: {
    backgroundColor: color.paperRaised, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    ...shadow.float,
  },
  grab: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze,
    alignSelf: 'center', marginTop: 10, marginBottom: 4,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  headerLabel: { ...t.small, color: color.mute, fontWeight: '600' },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: space.xxxl },
  errorText: { ...t.small, color: color.faint, textAlign: 'center' },

  card: { paddingHorizontal: space.lg, paddingBottom: space.lg, alignItems: 'center', gap: space.md },

  typeIconWrap: {
    width: avatar.s64, height: avatar.s64, borderRadius: avatar.s64 / 2,
    alignItems: 'center', justifyContent: 'center',
  },
  hashtagSlug: { ...t.title, color: color.ink, textAlign: 'center' },
  entityTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center', fontWeight: '700' },
  entitySub: { ...t.small, color: color.mute },

  reportBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: space.xs, opacity: 0.6,
  },
  reportBtnText: { ...t.small, color: color.faint },

  ctaRow: { flexDirection: 'row', gap: space.sm, width: '100%', paddingTop: space.xs },
  followBtn: {
    flex: 1, paddingVertical: 12, borderRadius: radius.pill,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
  },
  followBtnActive: {
    backgroundColor: color.deep + '18', borderWidth: 1.5, borderColor: color.deep,
  },
  followBtnText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  followBtnTextActive: { color: color.deep },
  viewBtn: {
    flex: 1, paddingVertical: 12, borderRadius: radius.pill,
    backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  viewBtnText: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },

  viewBtnFull: {
    width: '100%', paddingVertical: 12, borderRadius: radius.pill,
    backgroundColor: color.ink, alignItems: 'center',
  },
  viewBtnFullText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  dimBtnFull: {
    width: '100%', paddingVertical: 12, borderRadius: radius.pill,
    backgroundColor: color.haze, alignItems: 'center',
  },
  dimBtnText: { ...t.bodyStrong, color: color.mute, fontWeight: '600' },

  userRow: { flexDirection: 'row', gap: space.md, alignItems: 'center', alignSelf: 'stretch' },
  avatar: { width: avatar.s56, height: avatar.s56, borderRadius: avatar.s56 / 2, backgroundColor: color.haze },
  userInfo: { flex: 1, gap: 2 },
  userName: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  userHandle: { ...t.small, color: color.mute },
  userBio: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 20, alignSelf: 'stretch' },
});
