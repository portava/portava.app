import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import Svg, { Path, Defs, Pattern, Rect, Circle, Text as SvgText } from 'react-native-svg';
import { Plane, MapPin, MoreHorizontal, Camera, ShieldCheck, Calendar } from 'lucide-react-native';
import type { OwnProfile, PublicProfile } from '../types/models.ts';
import { PassportMonogramWatermark, PassportInkStamp, PassportHeroBackdrop } from './PassportMarks.tsx';
import { isTravelBuddyVerified, getVerificationOwnerPrompt } from '../lib/verification.ts';
import { resolveAvatarUrl, fallbackInitials } from '../utils/identity.ts';
import { primaryIdentityText, secondaryIdentityText } from '../lib/displayIdentity.ts';
import { color, space, radius, type as t, shadow } from '../theme/tokens.ts';
import { HighlightRing } from './HighlightRing.tsx';

const INTEREST_LABEL: Record<string, string> = {
  nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
  culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
  photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
  business: 'Business', dating: 'Social', events: 'Events',
};

const STAMP_NAVY = '#1A3A5C';

function InlineVerifiedStamp({ size = 22 }: { size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 30 30"
      accessibilityLabel="Verified traveler"
      accessibilityRole="image"
      style={{ marginLeft: 2 }}
    >
      <Circle cx={15} cy={15} r={13} stroke={STAMP_NAVY} strokeWidth={2} strokeDasharray="3 1.5" fill="none" />
      <Circle cx={15} cy={15} r={9.5} stroke={STAMP_NAVY} strokeWidth={0.8} fill="none" opacity={0.55} />
      <Path
        d="M7.5 16.5 L12 9 L14 11.5 L10.5 14.5 L18 16.8 L16 19.2 L9.5 17 L10.5 21 L8.5 22 Z"
        fill={STAMP_NAVY}
        opacity={0.9}
      />
      <SvgText x="15" y="27.5" textAnchor="middle" fill={STAMP_NAVY} fontSize="3.5" fontWeight="800" opacity={0.6}>✦ ✦ ✦</SvgText>
    </Svg>
  );
}

function PhotoBackdrop() {
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox="0 0 120 120" pointerEvents="none">
      <Defs>
        <Pattern id="wave2" width="20" height="20" patternUnits="userSpaceOnUse">
          <Path d="M0,10 Q5,2 10,10 T20,10" stroke={color.deep} strokeWidth="0.4" fill="none" opacity="0.18" />
        </Pattern>
      </Defs>
      <Rect x="0" y="0" width="120" height="120" fill="url(#wave2)" />
      {[28, 22, 16].map((r) => (
        <Circle key={r} cx="60" cy="60" r={r} stroke={color.deep} strokeWidth="0.5" fill="none" opacity="0.16" />
      ))}
    </Svg>
  );
}

function fmtMemberSince(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

/** Clean passport hero card — avatar, display name, username, bio (2 lines), home, up to 3 interests. */
export function PassportHero({
  profile,
  isOwner,
  onMenuPress,
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
}: {
  profile: OwnProfile | PublicProfile;
  isOwner: boolean;
  onMenuPress?: () => void;
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
}) {
  const username = 'username' in profile ? profile.username : null;
  const identity = {
    displayName: 'displayName' in profile ? profile.displayName : null,
    name: 'name' in profile ? profile.name : null,
    username,
  };
  const resolvedName = primaryIdentityText(identity);
  const handleSubline = secondaryIdentityText(identity);
  const bio = profile.bio;
  const homeCity = profile.homeCity;
  const homeCountry = profile.homeCountry;
  const interests = profile.interests ?? [];
  const shown = interests.slice(0, 3);
  const extra = interests.length - 3;
  const avatarUrl = resolveAvatarUrl(profile.avatarUrl);
  const initials = fallbackInitials(profile);
  const isVerified = isTravelBuddyVerified(profile);
  const verificationStatus = 'verificationStatus' in profile ? profile.verificationStatus : undefined;
  const ownerPrompt = isOwner ? getVerificationOwnerPrompt(verificationStatus) : null;

  return (
    <View style={styles.card}>
      <PassportHeroBackdrop />
      {isVerified && <View style={styles.inkStamp}><PassportInkStamp rotate={-8} /></View>}

      {/* Top label */}
      <View style={styles.topRow}>
        <View style={styles.brandRow}>
          <Plane size={16} color={color.ink} />
          <Text style={styles.brand}>PORTAVA PASSPORT</Text>
        </View>
        {isOwner && onMenuPress ? (
          <Pressable
            onPress={onMenuPress}
            hitSlop={8}
            style={styles.menuBtn}
            accessibilityLabel="Profile menu"
            accessibilityRole="button"
          >
            <MoreHorizontal size={20} color={color.ink} />
          </Pressable>
        ) : !isOwner && onFollowPress !== undefined ? (
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Pressable
              onPress={onFollowPress}
              hitSlop={8}
              disabled={followLoading}
              style={[styles.followBtn, isFollowing && styles.followBtnActive]}
            >
              <Text style={[styles.followText, isFollowing && styles.followTextActive]}>
                {followLoading ? '…' : isFollowing ? 'Following' : '+ Follow'}
              </Text>
            </Pressable>
            {followContext ? (
              <Text style={styles.followContextLabel}>{followContext}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={styles.topDivider} />

      {/* Identity row */}
      <View style={styles.identityRow}>
        {/* Avatar wrapped with HighlightRing */}
        <View style={styles.photoBox}>
          <PassportMonogramWatermark size={130} />
          <PhotoBackdrop />
          <HighlightRing
            hasActive={hasHighlights ?? false}
            allViewed={allHighlightsViewed ?? false}
            size={72}
            ringWidth={3}
            gap={3}
            onPress={onHighlightRingPress ?? (isOwner && onAvatarPress ? onAvatarPress : undefined)}
          >
            <View style={styles.photoFrame}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.photo} />
              ) : (
                <View style={[styles.photo, styles.photoEmpty]}>
                  <Text style={styles.initials}>{initials}</Text>
                </View>
              )}
            </View>
          </HighlightRing>
          {isOwner && onNewHighlightPress && (
            <Pressable
              style={styles.cameraOverlay}
              onPress={onNewHighlightPress}
              accessibilityLabel="Edit profile photo or highlight"
              accessibilityHint="Opens a menu to change your display photo or add a new highlight"
            >
              <Camera size={14} color={color.onInk} />
            </Pressable>
          )}
        </View>

        {/* Details */}
        <View style={styles.details}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={2}>{resolvedName}</Text>
            {isVerified ? <InlineVerifiedStamp size={22} /> : null}
          </View>
          {handleSubline ? <Text style={styles.handle}>{handleSubline}</Text> : null}
          {bio ? <Text style={styles.bio} numberOfLines={2}>{bio}</Text> : null}
          {(homeCity || homeCountry) ? (
            <View style={styles.locRow}>
              <MapPin size={12} color={color.deep} />
              <Text style={styles.loc} numberOfLines={1}>
                {[homeCity, homeCountry].filter(Boolean).join(', ')}
              </Text>
            </View>
          ) : null}
          {shown.length > 0 && (
            <View style={styles.interests}>
              {shown.map((i) => (
                <View key={i} style={styles.chip}>
                  <Text style={styles.chipText}>{INTEREST_LABEL[i] ?? i}</Text>
                </View>
              ))}
              {extra > 0 && (
                <View style={styles.chip}>
                  <Text style={styles.chipText}>+{extra}</Text>
                </View>
              )}
            </View>
          )}

          {/* Compact badges row: Member since + Trust Score */}
          <View style={styles.badgesRow}>
            {profile.createdAt ? (
              <View style={styles.memberBadge}>
                <Calendar size={11} color={color.mute} />
                <Text style={styles.memberText}>
                  Member since {fmtMemberSince(profile.createdAt)}
                </Text>
              </View>
            ) : null}
            {trustScore != null ? (
              <Pressable
                style={styles.trustBadge}
                onPress={onTrustInfo}
                accessibilityRole="button"
                accessibilityLabel={`Trust Score ${Math.round(trustScore)} out of 100, ${trustLabel ?? 'Trusted Traveler'}`}
                hitSlop={6}
              >
                <ShieldCheck size={12} color="#0D9B6F" strokeWidth={2.5} />
                <Text style={styles.trustText}>
                  {`Trust ${Math.round(trustScore)} / 100 · ${trustLabel ?? 'Trusted Traveler'}`}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>

      {/* Owner-only verification prompt (unverified / pending / rejected / expired) */}
      {!isVerified && ownerPrompt && (
        <View style={styles.verifyPrompt}>
          <Text style={styles.verifyPromptText}>{ownerPrompt}</Text>
        </View>
      )}

      {/* MRZ strip */}
      <View style={styles.mrzRow}>
        <Text style={styles.mrzChevron}>‹‹‹‹‹</Text>
        <Text style={styles.mrz} numberOfLines={1}>
          {isVerified
            ? 'PORTAVA · VERIFIED TRAVEL ID · SOCIAL PASSPORT'
            : 'PORTAVA · SOCIAL PASSPORT'}
        </Text>
        <Text style={styles.mrzChevron}>›››››</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    margin: space.lg,
    borderRadius: radius.lg,
    backgroundColor: '#FBFAF6',
    borderWidth: 1.5,
    borderColor: color.haze,
    padding: space.lg,
    overflow: 'hidden',
    ...shadow.card,
  },
  inkStamp: { position: 'absolute', top: 50, right: 12, zIndex: 1 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  brand: { ...t.bodyStrong, color: color.ink, letterSpacing: 0.5, fontSize: 13 },
  topDivider: { height: 1, backgroundColor: color.haze, marginVertical: space.md },

  menuBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  followBtn: {
    borderWidth: 1, borderColor: color.ink, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: 5,
  },
  followBtnActive: { backgroundColor: color.ink },
  followText: { ...t.small, color: color.ink, fontWeight: '700' },
  followTextActive: { color: color.onInk },
  followContextLabel: { fontSize: 11, color: color.signal, fontWeight: '600' },

  identityRow: { flexDirection: 'row', gap: space.md },

  photoBox: { width: 110, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 4 },
  photoFrame: {
    width: 96, height: 110,
    borderRadius: 8, borderWidth: 2, borderColor: color.paper,
    backgroundColor: color.haze, overflow: 'hidden', ...shadow.card,
  },
  photo: { width: '100%', height: '100%' },
  photoEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0EDE8' },
  initials: { fontSize: 26, fontWeight: '700', color: color.mute, letterSpacing: 1 },
  cameraOverlay: {
    position: 'absolute', bottom: 4, right: 4,
    backgroundColor: color.ink, borderRadius: 12, padding: 5,
    borderWidth: 1.5, borderColor: color.paper,
  },

  details: { flex: 1, gap: 6 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { ...t.heading, color: color.ink, fontSize: 22, lineHeight: 28, flexShrink: 1 },
  handle: { ...t.small, color: color.mute, fontFamily: 'Courier', fontSize: 12 },
  bio: { ...t.body, color: color.ink, fontSize: 13, lineHeight: 18 },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  loc: { ...t.small, color: color.deep, fontWeight: '600', flex: 1, fontSize: 12 },
  interests: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 2 },
  chip: {
    backgroundColor: color.paperRaised, borderRadius: radius.pill,
    paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 1, borderColor: color.haze,
  },
  chipText: { fontSize: 11, color: color.ink, fontWeight: '600' },

  mrzRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, marginTop: space.md, paddingTop: space.md,
    borderTopWidth: 1, borderTopColor: color.haze,
  },
  mrz: { fontFamily: 'Courier', fontSize: 9, color: color.deep, letterSpacing: 1, fontWeight: '700', flex: 1, textAlign: 'center' },
  mrzChevron: { fontFamily: 'Courier', fontSize: 9, color: color.faint },
  verifyPrompt: {
    marginTop: space.sm, alignSelf: 'flex-start',
    backgroundColor: color.paperRaised, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: 4,
    borderWidth: 1, borderColor: color.haze,
  },
  verifyPromptText: { ...t.small, color: color.mute, fontWeight: '600', fontSize: 11 },

  badgesRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: 6,
  },
  memberBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: color.haze, borderRadius: radius.pill,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  memberText: { fontSize: 10, color: color.mute, fontWeight: '600' },
  trustBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(13,155,111,0.10)', borderRadius: radius.pill,
    paddingHorizontal: 8, paddingVertical: 4,
    borderWidth: 1, borderColor: 'rgba(13,155,111,0.30)',
  },
  trustText: { fontSize: 10, color: '#0D9B6F', fontWeight: '700' },
});
