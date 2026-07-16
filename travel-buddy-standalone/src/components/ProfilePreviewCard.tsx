import React, { useState, useEffect } from 'react';
import {
  View, Text, Pressable, Modal, Image, ActivityIndicator, StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { getPublicProfile, type PublicProfileCard } from '../services/profile';
import { color, space, radius, type as t, shadow } from '../theme/tokens';
import { primaryIdentityText, secondaryIdentityText } from '../lib/displayIdentity';

interface Props {
  username: string | null;
  visible: boolean;
  onClose: () => void;
}

export function ProfilePreviewCard({ username, visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [profile, setProfile] = useState<PublicProfileCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!visible || !username) {
      setProfile(null);
      setNotFound(false);
      return;
    }
    setLoading(true);
    setNotFound(false);
    getPublicProfile(username)
      .then((res) => {
        setLoading(false);
        if (res.ok && res.data) {
          setProfile(res.data);
        } else if (res.errorKind === 'not_found') {
          setNotFound(true);
        }
      })
      .catch(() => setLoading(false));
  }, [visible, username]);

  function handleViewProfile() {
    if (!username) return;
    onClose();
    router.push(`/u/${username}` as any);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]} onPress={() => {}}>
          <View style={s.handle} />
          <Pressable style={s.closeBtn} onPress={onClose} hitSlop={8}>
            <X size={20} color={color.mute} />
          </Pressable>

          {loading && (
            <View style={s.center}>
              <ActivityIndicator size="large" color={color.mute} />
            </View>
          )}

          {notFound && !loading && (
            <View style={s.center}>
              <Text style={s.emptyText}>User not found</Text>
            </View>
          )}

          {profile && !loading && (
            <View style={s.content}>
              {profile.avatarUrl ? (
                <Image source={{ uri: profile.avatarUrl }} style={s.avatar} />
              ) : (
                <View style={[s.avatar, s.avatarFallback]}>
                  <Text style={s.avatarInitial}>
                    {(primaryIdentityText({ displayName: profile.displayName, username: profile.username }).replace(/^@/, '')[0] ?? '?').toUpperCase()}
                  </Text>
                </View>
              )}

              <Text style={s.name} numberOfLines={1}>
                {primaryIdentityText({ displayName: profile.displayName, username: profile.username })}
              </Text>
              {secondaryIdentityText({ displayName: profile.displayName, username: profile.username }) && (
                <Text style={s.handleText} numberOfLines={1}>{secondaryIdentityText({ displayName: profile.displayName, username: profile.username })}</Text>
              )}

              {!!profile.bio && (
                <Text style={s.bio} numberOfLines={3}>{profile.bio}</Text>
              )}

              <View style={s.statsRow}>
                <View style={s.stat}>
                  <Text style={s.statNum}>{profile.tripCount ?? 0}</Text>
                  <Text style={s.statLabel}>Trips</Text>
                </View>
                <View style={s.statDivider} />
                <View style={s.stat}>
                  <Text style={s.statNum}>{profile.stampCount ?? 0}</Text>
                  <Text style={s.statLabel}>Stamps</Text>
                </View>
              </View>

              {!profile.private && (
                <Pressable
                  style={({ pressed }) => [s.viewBtn, pressed && { opacity: 0.8 }]}
                  onPress={handleViewProfile}
                >
                  <Text style={s.viewBtnText}>View full profile</Text>
                </Pressable>
              )}
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const AVATAR_SIZE = 80;

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.sm,
    paddingHorizontal: space.lg,
    minHeight: 260,
    ...shadow.card,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: space.lg,
  },
  closeBtn: {
    position: 'absolute',
    top: space.lg,
    right: space.lg,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
  },
  emptyText: { ...t.body, color: color.mute },
  content: {
    alignItems: 'center',
    gap: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: color.haze,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: { ...t.heading, color: color.mute, fontWeight: '700' },
  name: { ...t.bodyStrong, color: color.ink, fontWeight: '700', marginTop: space.xs, fontSize: 17 },
  handleText: { ...t.small, color: color.mute },
  bio: {
    ...t.body,
    color: color.ink,
    textAlign: 'center',
    marginTop: space.xs,
    paddingHorizontal: space.md,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    marginTop: space.sm,
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: color.haze,
    width: '100%',
    justifyContent: 'center',
  },
  stat: { alignItems: 'center', gap: 2 },
  statNum: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  statLabel: { ...t.small, color: color.mute, fontSize: 11 },
  statDivider: { width: 1, height: 24, backgroundColor: color.haze },
  viewBtn: {
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    paddingVertical: 12,
    marginTop: space.sm,
    width: '100%',
    alignItems: 'center',
  },
  viewBtnText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
});
