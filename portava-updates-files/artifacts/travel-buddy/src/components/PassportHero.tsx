import React, { useMemo } from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Path, Defs, Pattern, Rect } from 'react-native-svg';
import {
  MapPin, Camera, ShieldCheck, Globe, Users, User,
  Luggage, Stamp as StampIcon, Plane,
} from 'lucide-react-native';
import type { OwnProfile, PublicProfile } from '../types/models';
import { isTravelBuddyVerified, getVerificationOwnerPrompt } from '../lib/verification';
import { resolveDisplayName, resolveAvatarUrl, fallbackInitials } from '../utils/identity';
import { HighlightRing } from './HighlightRing';

/**
 * Portava Passport header — modern social-profile hierarchy on passport paper.
 *
 * Identity first (avatar / name / verified stamp / handle), social proof
 * second (identity line, location, compact trust, bio, stats), one primary
 * action third (Edit Profile / Follow). Management lives in the top-right
 * menu. Visual layer only — all values arrive via props/profile exactly as
 * before; no new data sources.
 */

const C = {
  paper: '#FFF9ED',
  text: '#101828',
  secondary: '#667085',
  muted: '#98A2B3',
  gold: '#B08A45',
  darkGold: '#8F6A2E',
  border: '#E8DFC9',
  neutralBorder: '#EAECF0',
  verificationBlue: '#2383F7',
  trustGreen: '#159447',
  purple: '#6945D8',
  pink: '#CF3669',
  green: '#169451',
  orange: '#F28A19',
  stampBlue: '#357ECC',
} as const;

const INTEREST_LABEL: Record<string, string> = {
  nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
  culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
  photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
  business: 'Business', dating: 'Social', events: 'Events',
};

export interface PassportHeaderStats {
  trips: number;
  followers: number;
  following: number;
  stamps: number;
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

function formatCount(value: number | null | undefined): string {
  const v = value ?? 0;
  if (!Number.isFinite(v) || v < 0) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace('.0', '')}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace('.0', '')}K`;
  return String(v);
}

/** Guilloche-style paper texture, ~4% opacity. Decorative only. */
function PaperTexture() {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="xMidYMid slice" viewBox="0 0 360 260">
      <Defs>
        <Pattern id="pvg" width="26" height="26" patternUnits="userSpaceOnUse">
          <Path d="M0,13 Q6.5,4 13,13 T26,13" stroke={C.gold} strokeWidth="0.5" fill="none" opacity="0.04" />
          <Path d="M0,13 Q6.5,22 13,13 T26,13" stroke={C.gold} strokeWidth="0.5" fill="none" opacity="0.03" />
        </Pattern>
      </Defs>
      <Rect x="0" y="0" width="360" height="260" fill="url(#pvg)" />
    </Svg>
  );
}

export function PassportHero({
  profile,
  isOwner,
  onAvatarPress,
  isFollowing,
  followLoading,
  followContext,
  onFollowPress,
  hasHighlights,
  allHighlightsViewed,
  onHighlightRingPress,
  onNewHighlightPress,
  trustScore,
  trustLabel,
  onTrustInfo,
  onEditProfile,
  stats,
  onTripsPress,
  onStampsPress,
}: {
  profile: OwnProfile | PublicProfile;
  isOwner: boolean;
  onAvatarPress?: () => void;
  isFollowing?: boolean;
  followLoading?: boolean;
  followContext?: string;
  onFollowPress?: () => void;
  hasHighlights?: boolean;
  allHighlightsViewed?: boolean;
  onHighlightRingPress?: () => void;
  onNewHighlightPress?: () => void;
  trustScore?: number | null;
  trustLabel?: string | null;
  onTrustInfo?: () => void;
  /** Owner primary action. Hidden when not provided. */
  onEditProfile?: () => void;
  /** Stats strip rendered as a separate counter card. Hidden when not provided. */
  stats?: PassportHeaderStats;
  onTripsPress?: () => void;
  onStampsPress?: () => void;
}) {
  const { width } = useWindowDimensions();
  const compactStats = width < 360;

  const resolvedName = resolveDisplayName(profile);
  const username = 'username' in profile ? profile.username : null;
  const bio = profile.bio;
  const avatarUrl = resolveAvatarUrl(profile.avatarUrl);
  const initials = fallbackInitials(profile);
  const isVerified = isTravelBuddyVerified(profile);
  const verificationStatus = 'verificationStatus' in profile ? profile.verificationStatus : undefined;
  const ownerPrompt = isOwner ? getVerificationOwnerPrompt(verificationStatus) : null;
  const locationLabel = [profile.homeCity, profile.homeCountry].filter(Boolean).join(', ');
  const safeTrust = trustScore != null ? clamp(Math.round(trustScore), 0, 100) : null;

  const identityText = useMemo(() => {
    const tags = (profile.interests ?? [])
      .filter(Boolean)
      .slice(0, 3)
      .map((i) => INTEREST_LABEL[i] ?? i);
    return tags.length ? tags.join(' • ') : 'Traveler';
  }, [profile.interests]);

  const statItems = useMemo(() => {
    if (!stats) return [];
    return [
      { key: 'trips', label: 'Trips', value: formatCount(stats.trips), accent: C.purple, Icon: Luggage, onPress: onTripsPress },
      { key: 'followers', label: 'Followers', value: formatCount(stats.followers), accent: C.pink, Icon: Users, onPress: undefined },
      { key: 'following', label: 'Following', value: formatCount(stats.following), accent: C.green, Icon: User, onPress: undefined },
      { key: 'stamps', label: 'Stamps', value: formatCount(stats.stamps), accent: C.orange, Icon: StampIcon, onPress: onStampsPress },
    ];
  }, [stats, onTripsPress, onStampsPress]);

  return (
    <>
    <View style={styles.card}>
      {/* ── watermark layer: texture + two faint stamps only ── */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={StyleSheet.absoluteFill}
      >
        <PaperTexture />
        <View style={styles.adventureStamp}>
          <Text style={styles.adventureText}>ADVENTURE IS</Text>
          <Plane size={16} color={C.stampBlue} strokeWidth={1.7} />
          <Text style={styles.adventureText}>WORTHWHILE</Text>
        </View>
        <View style={styles.portavaStamp}>
          <Text style={styles.portavaStampTitle}>PORTAVA</Text>
          <Plane size={20} color={C.gold} strokeWidth={1.2} />
          <Text style={styles.portavaStampTitle}>EXPLORE MORE</Text>
        </View>
      </View>

      {/* passport micro-label */}
      <Text style={styles.microLabel}>PORTAVA PASSPORT</Text>

      {/* ── identity row: avatar left, name/handle right ── */}
      <View style={styles.identityRow}>
        <View style={styles.avatarWrap}>
          <View style={styles.avatarRing}>
            <HighlightRing
              hasActive={hasHighlights ?? false}
              allViewed={allHighlightsViewed ?? false}
              size={88}
              ringWidth={2.5}
              gap={2}
              onPress={onHighlightRingPress ?? (isOwner && onAvatarPress ? onAvatarPress : undefined)}
            >
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.initials}>{initials}</Text>
                </View>
              )}
            </HighlightRing>
          </View>
          {isOwner && onNewHighlightPress ? (
            <Pressable
              style={styles.cameraButton}
              onPress={onNewHighlightPress}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Change Profile Photo"
              accessibilityHint="Opens a menu to change your display photo or add a new highlight"
            >
              <Camera size={15} color={C.text} />
            </Pressable>
          ) : null}
        </View>

        <View style={styles.nameBlock}>
          <View style={styles.nameRow}>
            <Text style={styles.displayName} numberOfLines={1} ellipsizeMode="tail">
              {resolvedName}
            </Text>
            {isVerified ? (
              <View
                style={styles.verifiedPlaneStamp}
                accessibilityRole="image"
                accessibilityLabel="Verified traveler"
              >
                <Plane size={12} color={C.verificationBlue} strokeWidth={2.2} />
              </View>
            ) : null}
          </View>
          {username ? <Text style={styles.handle} numberOfLines={1}>@{username}</Text> : null}
          <Text style={styles.identityLine} numberOfLines={1}>{identityText}</Text>
          {locationLabel ? (
            <View style={styles.locationRow}>
              <MapPin size={13} color={C.secondary} strokeWidth={1.9} />
              <Text style={styles.locationText} numberOfLines={1}>{locationLabel}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* ── compact trust pill ── */}
      {safeTrust != null ? (
        <Pressable
          style={styles.trustPill}
          onPress={onTrustInfo}
          disabled={!onTrustInfo}
          accessibilityRole="button"
          accessibilityLabel={`Trust Score ${safeTrust} out of 100${trustLabel ? `, ${trustLabel}` : ''}`}
          hitSlop={6}
        >
          <ShieldCheck size={16} color={C.trustGreen} strokeWidth={2.2} />
          <View style={styles.trustBody}>
            <View style={styles.trustTextRow}>
              <Text style={styles.trustLabel}>Trust Score</Text>
              <Text style={styles.trustValue}>{safeTrust}<Text style={styles.trustOutOf}>/100</Text></Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${safeTrust}%` }]} />
            </View>
          </View>
        </Pressable>
      ) : null}

      {/* ── bio ── */}
      {bio ? <Text style={styles.bio} numberOfLines={3}>{bio}</Text> : null}
      {!isVerified && ownerPrompt ? (
        <Text style={styles.verifyPrompt}>{ownerPrompt}</Text>
      ) : null}

      {/* ── one primary action ── */}
      {isOwner ? (
        onEditProfile ? (
          <Pressable
            style={styles.primaryBtn}
            onPress={onEditProfile}
            accessibilityRole="button"
            accessibilityLabel="Edit Profile"
          >
            <Text style={styles.primaryBtnText}>Edit Profile</Text>
          </Pressable>
        ) : null
      ) : onFollowPress !== undefined ? (
        <View>
          <Pressable
            onPress={onFollowPress}
            disabled={followLoading}
            style={[styles.primaryBtn, !isFollowing && styles.primaryBtnFilled]}
            accessibilityRole="button"
            accessibilityLabel={isFollowing ? 'Following' : 'Follow User'}
          >
            <Text style={[styles.primaryBtnText, !isFollowing && styles.primaryBtnTextFilled]}>
              {followLoading ? '…' : isFollowing ? 'Following' : 'Follow'}
            </Text>
          </Pressable>
          {followContext ? <Text style={styles.followContextLabel}>{followContext}</Text> : null}
        </View>
      ) : null}
    </View>

      {/* ── stats counter — separate card, 4 metrics ── */}
      {statItems.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.statsTicket}
          contentContainerStyle={styles.statsContent}
        >
          {statItems.map(({ key, label, value, accent, Icon, onPress }) => (
            <Pressable
              key={key}
              disabled={!onPress}
              onPress={onPress}
              accessibilityRole={onPress ? 'button' : 'text'}
              accessibilityLabel={`${label}: ${value}`}
              style={styles.statItem}
            >
              {compactStats ? <Icon size={18} color={accent} strokeWidth={2} /> : null}
              <Text style={styles.statValue}>{value}</Text>
              {!compactStats ? <Text style={styles.statLabel}>{label}</Text> : null}
              <View style={[styles.statUnderline, { backgroundColor: accent }]} />
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 20,
    backgroundColor: C.paper,
    borderWidth: 1,
    borderColor: C.border,
    overflow: 'hidden',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 16,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },

  /* watermarks — 2 stamps max, faint */
  adventureStamp: {
    position: 'absolute', right: 74, top: 6, width: 66, height: 66, borderRadius: 33,
    borderWidth: 1.5, borderColor: 'rgba(53,126,204,0.35)',
    alignItems: 'center', justifyContent: 'center', opacity: 0.3,
    transform: [{ rotate: '-9deg' }],
  },
  adventureText: { fontSize: 6.5, fontWeight: '700', letterSpacing: 0.6, color: C.stampBlue },
  portavaStamp: {
    position: 'absolute', right: -6, bottom: 10, width: 96, height: 74, borderRadius: 8,
    borderWidth: 1.5, borderColor: 'rgba(176,138,69,0.30)',
    alignItems: 'center', justifyContent: 'center', gap: 2, opacity: 0.2,
    transform: [{ rotate: '-7deg' }],
  },
  portavaStampTitle: { fontSize: 7.5, fontWeight: '700', letterSpacing: 0.6, color: C.gold },

  microLabel: {
    fontSize: 10, fontWeight: '700', letterSpacing: 1.6, color: C.gold,
    marginBottom: 10,
  },

  /* identity row */
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatarWrap: { width: 100, height: 100 },
  avatarRing: {
    width: 100, height: 100, borderRadius: 50, padding: 3.5,
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.gold,
    alignItems: 'center', justifyContent: 'center',
  },
  avatar: { width: 78, height: 78, borderRadius: 39 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF1F4' },
  initials: { fontSize: 26, fontWeight: '700', color: C.secondary, letterSpacing: 1 },
  cameraButton: {
    position: 'absolute', right: 0, bottom: 0,
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.neutralBorder,
    shadowColor: '#000000', shadowOpacity: 0.08, shadowRadius: 5,
    shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },

  nameBlock: { flex: 1, minWidth: 0, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  displayName: {
    flexShrink: 1, fontSize: 26, lineHeight: 31, fontWeight: '700', color: C.text,
  },
  verifiedPlaneStamp: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: C.verificationBlue,
    backgroundColor: 'rgba(35,131,247,0.07)',
    transform: [{ rotate: '-8deg' }],
  },
  handle: { fontSize: 14, color: C.secondary },
  identityLine: { marginTop: 3, fontSize: 13.5, fontWeight: '600', color: C.text },
  locationRow: { marginTop: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  locationText: { flex: 1, fontSize: 13.5, color: C.secondary },

  /* compact trust pill */
  trustPill: {
    marginTop: 12, alignSelf: 'flex-start', minWidth: 190, maxWidth: 250,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 10, borderWidth: 1, borderColor: '#E6D4AE',
    backgroundColor: '#FFFCF5', paddingHorizontal: 10, paddingVertical: 7,
  },
  trustBody: { flex: 1, gap: 4 },
  trustTextRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  trustLabel: { fontSize: 12, fontWeight: '600', color: C.darkGold },
  trustValue: { fontSize: 14.5, fontWeight: '700', color: C.trustGreen },
  trustOutOf: { fontSize: 11.5, fontWeight: '500', color: C.secondary },
  progressTrack: { height: 2.5, borderRadius: 999, backgroundColor: '#E0E3DF', overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 999, backgroundColor: C.trustGreen },

  bio: { marginTop: 10, fontSize: 14.5, lineHeight: 20, color: C.text },
  verifyPrompt: { marginTop: 8, fontSize: 12, fontWeight: '600', color: C.darkGold },

  /* one primary action */
  primaryBtn: {
    marginTop: 14, minHeight: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: C.neutralBorder,
  },
  primaryBtnFilled: { backgroundColor: C.text, borderColor: C.text },
  primaryBtnText: { fontSize: 13.5, fontWeight: '600', color: C.text },
  primaryBtnTextFilled: { color: '#FFFFFF' },
  followContextLabel: { marginTop: 6, fontSize: 11, color: C.darkGold, fontWeight: '600', textAlign: 'center' },

  /* stats counter */
  statsTicket: {
    marginHorizontal: 16, marginTop: 10, borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1, borderColor: C.neutralBorder,
    shadowColor: '#000000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, shadowRadius: 8, elevation: 2,
  },
  statsContent: { minWidth: '100%' },
  statItem: {
    flexGrow: 1, flexBasis: 0, minWidth: 72, minHeight: 68, paddingVertical: 10,
    alignItems: 'center', justifyContent: 'center', gap: 1,
  },
  statValue: { fontSize: 17, lineHeight: 21, fontWeight: '700', color: C.text },
  statLabel: { fontSize: 12, lineHeight: 15, color: C.secondary },
  statUnderline: { marginTop: 5, width: 22, height: 2.5, borderRadius: 999 },
});
