/**
 * PassportIdentityCard — Minimalist white/cream profile style.
 * No gradient backgrounds, clean spacing, subtle lines.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Image, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { Settings, ShieldCheck, Camera, Plus } from 'lucide-react-native';
import type { OwnProfile, PublicProfile } from '../../types/models';
import { resolveAvatarUrl, fallbackInitials } from '../../utils/identity';
import { primaryIdentityText, secondaryIdentityText } from '../../lib/displayIdentity';
import { isTravelBuddyVerified } from '../../lib/verification';
import { HighlightRing } from '../HighlightRing';
import { getPassportStats } from '../../services/passportStamps';
import type { PassportStats } from '../../services/passportStamps';
import { PP, PP_LABEL, PP_VALUE } from '../../theme/passportTokens';

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
  const resolvedName = primaryIdentityText(identity);
  const handleSubline = secondaryIdentityText(identity);
  const avatarUrl = resolveAvatarUrl(profile.avatarUrl);
  const initials = fallbackInitials(profile);
  const isVerified = isTravelBuddyVerified(profile);
  const verificationStatus = 'verificationStatus' in profile ? profile.verificationStatus : 'unverified';
  
  // Stats row matching the mockup: TRIPS, FOLLOWERS, FOLLOWING, STAMPS
  const ownStats: StatItem[] = [
    {
      n: 'tripCount' in profile ? (profile.tripCount ?? 0) : 0,
      label: 'TRIPS',
      onPress: () => onStatPress?.('Trips'),
    },
    {
      n: 'followersCount' in profile ? (profile.followersCount ?? 0) : 0,
      label: 'FOLLOWERS',
      onPress: () => onStatPress?.('Followers'),
    },
    {
      n: 'followingCount' in profile ? (profile.followingCount ?? 0) : 0,
      label: 'FOLLOWING',
    },
    {
      n: liveStats?.totalStamps ?? 0,
      label: 'STAMPS',
      onPress: () => onStatPress?.('Stamps'),
    }
  ];
  const stats = overrideStats ?? ownStats;

  return (
    <View style={s.card}>
      {/* Top Bar: Cover Change (Owner) & Follow/Settings */}
      <View style={s.topBar}>
        <View style={s.topLeft}>
          {isOwner && onChangeCover ? (
            <Pressable style={s.iconBtn} onPress={onChangeCover} hitSlop={12} accessibilityLabel="Change cover photo">
              {coverUploading ? (
                <ActivityIndicator size="small" color={PP.inkMuted} />
              ) : (
                <Camera size={20} color={PP.inkMuted} strokeWidth={1.5} />
              )}
            </Pressable>
          ) : null}
        </View>

        <View style={s.topRight}>
          {!isOwner && onFollowPress ? (
            <Pressable
              style={[s.followBtn, isFollowing && s.followBtnActive]}
              onPress={onFollowPress}
              disabled={followLoading}
              hitSlop={12}
            >
              <Text style={[s.followText, isFollowing && s.followTextActive]}>
                {followLoading ? '…' : isFollowing ? 'Following' : 'Follow'}
              </Text>
            </Pressable>
          ) : null}

          {isOwner && onMenuPress ? (
            <Pressable style={s.iconBtn} onPress={onMenuPress} hitSlop={12} accessibilityLabel="Menu">
              <Settings size={20} color={PP.ink} strokeWidth={1.5} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Main Profile Info */}
      <View style={s.profileTop}>
        <View style={s.avatarWrap}>
          <HighlightRing
            hasActive={hasHighlights ?? false}
            allViewed={allHighlightsViewed ?? false}
            size={96}
            ringWidth={2}
            gap={4}
            onPress={onHighlightRingPress}
          >
            <Pressable style={s.photoFrame} onPress={onAvatarPress} disabled={!onAvatarPress}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={s.photo} />
              ) : (
                <View style={[s.photo, s.photoFallback]}>
                  <Text style={s.initials}>{initials}</Text>
                </View>
              )}
            </Pressable>
          </HighlightRing>
          
          {isOwner && onNewHighlightPress ? (
            <Pressable style={s.addHighlightBtn} onPress={onNewHighlightPress} hitSlop={12} accessibilityLabel="Add Highlight">
              <Plus size={16} color="#FFFFFF" strokeWidth={3} />
            </Pressable>
          ) : null}

          {isVerified && (
            <View style={s.verifiedBadge}>
              <ShieldCheck size={14} color="#FFFFFF" strokeWidth={2.5} />
            </View>
          )}
        </View>

        <View style={s.nameContainer}>
          <Text style={s.displayName}>{resolvedName}</Text>
          {handleSubline && <Text style={s.handle}>{handleSubline}</Text>}
          
          {/* Trust Score & Verification Status */}
          {trustScore != null ? (
            <Pressable style={s.trustWrap} onPress={onTrustInfo} hitSlop={12} disabled={!onTrustInfo}>
               <Text style={s.trustText}>Trust Score: {Math.round(trustScore)}/100</Text>
               <View style={s.trustDot} />
               <Text style={s.verifiedText}>Travel Buddy Verified</Text>
            </Pressable>
          ) : (
             <Text style={s.verifiedText}>{isVerified ? 'Travel Buddy Verified' : 'Traveler'}</Text>
          )}
        </View>
      </View>

      {/* Stats Row */}
      <View style={s.statsRow}>
        {stats.map((item, i) => (
          <View key={item.label} style={s.statItem}>
            <Pressable onPress={item.onPress} disabled={!item.onPress} style={s.statPressable} hitSlop={8}>
              <Text style={s.statN}>{item.n}</Text>
              <Text style={s.statL}>{item.label}</Text>
            </Pressable>
          </View>
        ))}
      </View>

      {/* Bio / Description */}
      {('bio' in profile && profile.bio) ? (
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
    paddingHorizontal: 20,
    paddingBottom: 24,
    paddingTop: 12,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  topLeft: {
    alignItems: 'flex-start',
  },
  topRight: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 12,
  },
  iconBtn: {
    padding: 4,
  },
  followBtn: {
    borderWidth: 1.5, borderColor: PP.ink, borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 6,
    backgroundColor: 'transparent',
  },
  followBtnActive: { backgroundColor: PP.ink },
  followText: { fontSize: 13, fontWeight: '600', color: PP.ink },
  followTextActive: { color: PP.paper },
  profileTop: {
    alignItems: 'center',
  },
  avatarWrap: {
    position: 'relative',
    marginBottom: 16,
  },
  photoFrame: {
    width: 96, height: 96,
    borderRadius: 48,
    backgroundColor: PP.paperDeep,
    overflow: 'hidden',
  },
  photo: { width: '100%', height: '100%' },
  photoFallback: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 32, fontWeight: '500', color: PP.inkMuted },
  verifiedBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: '#0D9B6F',
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: PP.paper,
  },
  addHighlightBtn: {
    position: 'absolute',
    top: 0,
    right: 0,
    backgroundColor: PP.ink,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: PP.paper,
  },
  nameContainer: {
    alignItems: 'center',
    gap: 4,
  },
  displayName: {
    fontSize: 24,
    fontWeight: '700',
    color: PP.ink,
    letterSpacing: -0.5,
  },
  handle: {
    fontSize: 14,
    color: PP.inkMuted,
  },
  trustWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  trustText: {
    fontSize: 12,
    color: PP.inkMuted,
    fontWeight: '500',
  },
  trustDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: PP.inkMuted,
  },
  verifiedText: {
    fontSize: 12,
    color: '#0D9B6F',
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 24,
    gap: 40,
  },
  statItem: {
    alignItems: 'center',
  },
  statPressable: {
    alignItems: 'center',
  },
  statN: {
    fontSize: 18,
    fontWeight: '700',
    color: PP.ink,
  },
  statL: {
    fontSize: 10,
    color: PP.inkMuted,
    marginTop: 4,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  bioWrap: {
    marginTop: 24,
    alignItems: 'center',
  },
  bioText: {
    fontSize: 14,
    lineHeight: 20,
    color: PP.ink,
    textAlign: 'center',
    maxWidth: '85%',
  }
});
