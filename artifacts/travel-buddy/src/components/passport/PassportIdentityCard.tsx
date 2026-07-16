/**
 * PassportIdentityCard — Modern cover-photo profile header.
 * Cover banner with overlapping avatar, clean stats row with dividers.
 * All data wiring and handlers preserved exactly.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Image, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Settings, ShieldCheck, Camera, Plus, UserCheck, UserPlus } from 'lucide-react-native';
import type { OwnProfile, PublicProfile } from '../../types/models';
import { resolveAvatarUrl, fallbackInitials } from '../../utils/identity';
import { primaryIdentityText, secondaryIdentityText } from '../../lib/displayIdentity';
import { isTravelBuddyVerified } from '../../lib/verification';
import { HighlightRing } from '../HighlightRing';
import { getPassportStats } from '../../services/passportStamps';
import type { PassportStats } from '../../services/passportStamps';
import { PP } from '../../theme/passportTokens';

type AnyProfile = OwnProfile | PublicProfile;

interface StatItem { n: number | string; label: string; onPress?: () => void }

interface Props {
  profile: AnyProfile;
  isOwner: boolean;
  onMenuPress?: () => void;
  onAvatarPress?: () => void;
  onChangeCover?: () => void;
  coverUploading?: boolean;
  hasHighlights?: boolean;
  allHighlightsViewed?: boolean;
  onHighlightRingPress?: () => void;
  onNewHighlightPress?: () => void;
  trustScore?: number | null;
  trustLabel?: string | null;
  onTrustInfo?: () => void;
  isFollowing?: boolean;
  followLoading?: boolean;
  onFollowPress?: () => void;
  overrideStats?: StatItem[];
  onStatPress?: (label: string) => void;
}

const COVER_HEIGHT = 168;
const AVATAR_SIZE  = 88;
const AVATAR_OVERLAP = AVATAR_SIZE / 2;

export function PassportIdentityCard({
  profile, isOwner, onMenuPress, onAvatarPress, onChangeCover, coverUploading,
  hasHighlights, allHighlightsViewed, onHighlightRingPress, onNewHighlightPress,
  trustScore, trustLabel, onTrustInfo, isFollowing, followLoading, onFollowPress,
  overrideStats, onStatPress,
}: Props) {
  const [liveStats, setLiveStats] = useState<PassportStats | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    getPassportStats()
      .then((res) => { if (res.ok) setLiveStats(res.data); })
      .catch(() => {});
  }, [isOwner]);

  const username = 'username' in profile ? profile.username : null;
  const identity = {
    displayName: 'displayName' in profile ? profile.displayName : null,
    name: 'name' in profile ? profile.name : null,
    username,
  };
  const resolvedName  = primaryIdentityText(identity);
  const handleSubline = secondaryIdentityText(identity);
  const avatarUrl     = resolveAvatarUrl(profile.avatarUrl);
  const coverUrl      = 'coverUrl' in profile ? (profile as any).coverUrl : null;
  const initials      = fallbackInitials(profile);
  const isVerified    = isTravelBuddyVerified(profile);

  const ownStats: StatItem[] = [
    {
      n: 'tripCount' in profile ? (profile.tripCount ?? 0) : 0,
      label: 'Trips',
      onPress: () => onStatPress?.('Trips'),
    },
    {
      n: 'followersCount' in profile ? (profile.followersCount ?? 0) : 0,
      label: 'Followers',
      onPress: () => onStatPress?.('Followers'),
    },
    {
      n: 'followingCount' in profile ? (profile.followingCount ?? 0) : 0,
      label: 'Following',
    },
    {
      n: liveStats?.totalStamps ?? 0,
      label: 'Stamps',
      onPress: () => onStatPress?.('Stamps'),
    },
  ];
  const stats = overrideStats ?? ownStats;

  return (
    <View style={s.card}>
      {/* ── Cover banner ─────────────────────────────────────── */}
      <View style={s.coverWrap}>
        {coverUrl ? (
          <Image source={{ uri: coverUrl }} style={s.coverImg} />
        ) : (
          <View style={s.coverPlaceholder} />
        )}

        {/* Gradient scrim so icons stay legible */}
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.35)']}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />

        {/* Top-right banner actions */}
        <View style={s.bannerActions}>
          {!isOwner && onFollowPress ? (
            <Pressable
              style={[s.followBtn, isFollowing && s.followBtnActive]}
              onPress={onFollowPress}
              disabled={followLoading}
              hitSlop={12}
            >
              {followLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : isFollowing ? (
                <>
                  <UserCheck size={13} color="#fff" strokeWidth={2} />
                  <Text style={s.followBtnText}>Following</Text>
                </>
              ) : (
                <>
                  <UserPlus size={13} color="#fff" strokeWidth={2} />
                  <Text style={s.followBtnText}>Follow</Text>
                </>
              )}
            </Pressable>
          ) : null}

          {isOwner && onMenuPress ? (
            <Pressable style={s.bannerIconBtn} onPress={onMenuPress} hitSlop={12} accessibilityLabel="Menu">
              <Settings size={18} color="#fff" strokeWidth={1.8} />
            </Pressable>
          ) : null}
        </View>

        {/* Camera button — bottom-right of cover */}
        {isOwner && onChangeCover ? (
          <Pressable
            style={s.cameraBtn}
            onPress={onChangeCover}
            hitSlop={12}
            accessibilityLabel="Change cover photo"
          >
            {coverUploading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Camera size={15} color="#fff" strokeWidth={2} />
            )}
          </Pressable>
        ) : null}
      </View>

      {/* ── Avatar row (overlaps cover) ───────────────────────── */}
      <View style={[s.avatarRow, { marginTop: -AVATAR_OVERLAP }]}>
        <View style={s.avatarWrap}>
          <HighlightRing
            hasActive={hasHighlights ?? false}
            allViewed={allHighlightsViewed ?? false}
            size={AVATAR_SIZE}
            ringWidth={2.5}
            gap={3}
            onPress={onHighlightRingPress}
          >
            <Pressable
              style={s.photoFrame}
              onPress={onAvatarPress}
              disabled={!onAvatarPress}
            >
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={s.photo} />
              ) : (
                <View style={[s.photo, s.photoFallback]}>
                  <Text style={s.initials}>{initials}</Text>
                </View>
              )}
            </Pressable>
          </HighlightRing>

          {/* Add-highlight badge */}
          {isOwner && onNewHighlightPress ? (
            <Pressable
              style={s.addHighlightBtn}
              onPress={onNewHighlightPress}
              hitSlop={12}
              accessibilityLabel="Add Highlight"
            >
              <Plus size={13} color="#fff" strokeWidth={3} />
            </Pressable>
          ) : null}

          {/* Verified badge */}
          {isVerified && (
            <View style={s.verifiedBadge}>
              <ShieldCheck size={12} color="#fff" strokeWidth={2.5} />
            </View>
          )}
        </View>
      </View>

      {/* ── Name / handle / trust ────────────────────────────── */}
      <View style={s.nameBlock}>
        <Text style={s.displayName} numberOfLines={1}>{resolvedName}</Text>
        {handleSubline ? (
          <Text style={s.handle}>{handleSubline}</Text>
        ) : null}

        {trustScore != null ? (
          <Pressable style={s.trustRow} onPress={onTrustInfo} hitSlop={12} disabled={!onTrustInfo}>
            <View style={s.trustPill}>
              <ShieldCheck size={11} color="#0D9B6F" strokeWidth={2.5} />
              <Text style={s.trustPillText}>Trust {Math.round(trustScore)}</Text>
            </View>
            <Text style={s.verifiedLabel}>Travel Buddy Verified</Text>
          </Pressable>
        ) : (
          <Text style={s.verifiedLabel}>{isVerified ? 'Travel Buddy Verified' : 'Traveler'}</Text>
        )}
      </View>

      {/* ── Stats row ─────────────────────────────────────────── */}
      <View style={s.statsRow}>
        {stats.map((item, i) => (
          <React.Fragment key={item.label}>
            {i > 0 && <View style={s.statDivider} />}
            <Pressable
              style={s.statItem}
              onPress={item.onPress}
              disabled={!item.onPress}
              hitSlop={8}
            >
              <Text style={s.statN}>{item.n}</Text>
              <Text style={s.statL}>{item.label}</Text>
            </Pressable>
          </React.Fragment>
        ))}
      </View>

      {/* ── Bio ───────────────────────────────────────────────── */}
      {'bio' in profile && profile.bio ? (
        <View style={s.bioWrap}>
          <Text style={s.bioText}>{profile.bio}</Text>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: PP.paper,
    paddingBottom: 20,
  },

  /* Cover */
  coverWrap: {
    height: COVER_HEIGHT,
    backgroundColor: '#E8E4DE',
    overflow: 'hidden',
  },
  coverImg: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  coverPlaceholder: {
    flex: 1,
    backgroundColor: '#D8D2C8',
  },
  bannerActions: {
    position: 'absolute',
    top: 12,
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  bannerIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.32)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  followBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.38)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  followBtnActive: {
    backgroundColor: 'rgba(13,155,111,0.82)',
    borderColor: 'rgba(13,155,111,0.6)',
  },
  followBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  },
  cameraBtn: {
    position: 'absolute',
    bottom: 10,
    right: 14,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.38)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
  },

  /* Avatar */
  avatarRow: {
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  avatarWrap: {
    position: 'relative',
  },
  photoFrame: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: '#D8D2C8',
    overflow: 'hidden',
    borderWidth: 3,
    borderColor: PP.paper,
  },
  photo: { width: '100%', height: '100%' },
  photoFallback: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 28, fontWeight: '500', color: PP.inkMuted },
  verifiedBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    backgroundColor: '#0D9B6F',
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: PP.paper,
  },
  addHighlightBtn: {
    position: 'absolute',
    top: 2,
    right: 2,
    backgroundColor: PP.ink,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: PP.paper,
  },

  /* Name block */
  nameBlock: {
    paddingHorizontal: 20,
    marginTop: 12,
    gap: 3,
  },
  displayName: {
    fontSize: 22,
    fontWeight: '700',
    color: PP.ink,
    letterSpacing: -0.4,
  },
  handle: {
    fontSize: 14,
    color: PP.inkMuted,
    fontWeight: '400',
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  trustPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#E8F5F0',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  trustPillText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0D9B6F',
  },
  verifiedLabel: {
    fontSize: 12,
    color: '#0D9B6F',
    fontWeight: '500',
    marginTop: 4,
  },

  /* Stats */
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    marginHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#E4DFD9',
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
    backgroundColor: '#D8D2C8',
    marginHorizontal: 24,
  },
  statItem: {
    alignItems: 'center',
    minWidth: 48,
  },
  statN: {
    fontSize: 20,
    fontWeight: '700',
    color: PP.ink,
    letterSpacing: -0.5,
  },
  statL: {
    fontSize: 11,
    color: PP.inkMuted,
    marginTop: 2,
    fontWeight: '500',
  },

  /* Bio */
  bioWrap: {
    marginTop: 14,
    paddingHorizontal: 20,
  },
  bioText: {
    fontSize: 14,
    lineHeight: 21,
    color: PP.ink,
  },
});
