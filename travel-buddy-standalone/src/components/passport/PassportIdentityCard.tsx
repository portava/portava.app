/**
 * PassportIdentityCard — the dominant first-screen passport document element.
 * Replaces PassportHero + PassportVerificationStamp + CompactStatsRow in
 * the new layout. Handles both owner and visitor views.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Image, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MapPin, Calendar, Camera, MoreHorizontal, Plane, ShieldCheck } from 'lucide-react-native';
import type { OwnProfile, PublicProfile } from '../../types/models';
import { resolveAvatarUrl, fallbackInitials } from '../../utils/identity';
import { primaryIdentityText, secondaryIdentityText } from '../../lib/displayIdentity';
import { isTravelBuddyVerified } from '../../lib/verification';
import { HighlightRing } from '../HighlightRing';
import { PassportSecurityPattern } from './PassportSecurityPattern';
import { PassportVerifiedSeal } from './PassportVerifiedSeal';
import { PassportHeroBackdrop } from '../PassportMarks';
import { getPassportStats } from '../../services/passportStamps';
import type { PassportStats } from '../../services/passportStamps';
import { PP, PP_LABEL, PP_VALUE, countryFlag, passportNumber, fmtMonthYear } from '../../theme/passportTokens';
import { shadow } from '../../theme/tokens';

type AnyProfile = OwnProfile | PublicProfile;

interface StatItem { n: number | string; label: string; onPress?: () => void }

interface Props {
  profile: AnyProfile;
  isOwner: boolean;
  /** Called when owner taps the ⋯ menu button */
  onMenuPress?: () => void;
  /** Called when owner taps avatar camera overlay */
  onAvatarPress?: () => void;
  /** Called when owner taps the cover camera button */
  onChangeCover?: () => void;
  /** Whether cover is currently uploading */
  coverUploading?: boolean;
  /** Highlight ring props */
  hasHighlights?: boolean;
  allHighlightsViewed?: boolean;
  onHighlightRingPress?: () => void;
  onNewHighlightPress?: () => void;
  /** Trust score (owner only) */
  trustScore?: number | null;
  trustLabel?: string | null;
  onTrustInfo?: () => void;
  /** Visitor follow action */
  isFollowing?: boolean;
  followLoading?: boolean;
  onFollowPress?: () => void;
  /** Override stats for visitor view */
  overrideStats?: StatItem[];
  /** Navigate to a named tab */
  onStatPress?: (label: string) => void;
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={f.row}>
      <Text style={f.label}>{label}</Text>
      {children}
    </View>
  );
}

const f = StyleSheet.create({
  row: { gap: 2 },
  label: { ...PP_LABEL, fontSize: 8 },
});

function StatusChip({ text }: { text: string }) {
  return (
    <View style={sc.chip}>
      <Text style={sc.text}>{text}</Text>
    </View>
  );
}
const sc = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    backgroundColor: PP.inkFaint,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: PP.borderLight,
  },
  text: { ...PP_LABEL, fontSize: 8, color: PP.ink },
});

export function PassportIdentityCard({
  profile, isOwner, onMenuPress, onAvatarPress, onChangeCover, coverUploading,
  hasHighlights, allHighlightsViewed, onHighlightRingPress, onNewHighlightPress,
  trustScore, trustLabel, onTrustInfo, isFollowing, followLoading, onFollowPress,
  overrideStats, onStatPress,
}: Props) {
  const [coverError, setCoverError] = useState(false);
  const [liveStats, setLiveStats] = useState<PassportStats | null>(null);

  // Fetch owner stats
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
  const coverPhotoUrl = 'coverPhotoUrl' in profile ? profile.coverPhotoUrl : null;
  const homeCity = profile.homeCity;
  const homeCountry = profile.homeCountry;
  const createdAt = profile.createdAt;
  const userId = profile.id ?? '';

  const flagInfo = countryFlag(homeCountry);

  // Stats row
  const ownStats: StatItem[] = [
    {
      n: liveStats?.cities ?? 0,
      label: 'Cities',
      onPress: () => onStatPress?.('Cities'),
    },
    {
      n: 'tripCount' in profile ? (profile.tripCount ?? 0) : 0,
      label: 'Trips',
      onPress: () => onStatPress?.('Trips'),
    },
    {
      n: liveStats?.totalStamps ?? 0,
      label: 'Stamps',
    },
    {
      n: 'followersCount' in profile ? (profile.followersCount ?? 0) : 0,
      label: 'Followers',
      onPress: () => onStatPress?.('Followers'),
    },
  ];
  const stats = overrideStats ?? ownStats;

  // Passport number (decorative, derived from user id)
  const ppNo = passportNumber(userId);

  return (
    <View style={s.card}>
      {/* Background texture */}
      <PassportSecurityPattern opacity={0.7} />

      {/* ── Top bar ── */}
      <View style={s.topBar}>
        <View style={s.topBarLeft}>
          {flagInfo ? (
            <Text style={s.flag}>{flagInfo.flag}</Text>
          ) : (
            <Plane size={13} color={PP.ink} />
          )}
          <Text style={s.brand}>TRAVEL BUDDY PASSPORT</Text>
        </View>
        {isOwner && onMenuPress ? (
          <Pressable style={s.menuBtn} onPress={onMenuPress} hitSlop={8} accessibilityLabel="Profile menu">
            <MoreHorizontal size={18} color={PP.ink} />
          </Pressable>
        ) : !isOwner && onFollowPress !== undefined ? (
          <Pressable
            style={[s.followBtn, isFollowing && s.followBtnActive]}
            onPress={onFollowPress}
            disabled={followLoading}
            hitSlop={8}
          >
            <Text style={[s.followText, isFollowing && s.followTextActive]}>
              {followLoading ? '…' : isFollowing ? 'Following' : '+ Follow'}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* ── Top green rule ── */}
      <View style={s.topRule} />

      {/* ── Cover photo band ── */}
      <View style={s.coverBand}>
        {coverPhotoUrl && !coverError ? (
          <Image
            source={{ uri: coverPhotoUrl }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            onError={() => setCoverError(true)}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, s.coverFallback]}>
            <PassportHeroBackdrop />
          </View>
        )}
        {coverUploading && (
          <View style={s.coverUploadOverlay}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        )}
        {/* Gradient fade to paper */}
        <LinearGradient
          colors={['transparent', PP.paper]}
          style={s.coverFade}
          pointerEvents="none"
        />
        {/* Cover edit button (owner only) */}
        {isOwner && onChangeCover ? (
          <Pressable
            style={s.coverCameraBtn}
            onPress={onChangeCover}
            disabled={coverUploading}
            hitSlop={8}
            accessibilityLabel="Change cover photo"
          >
            {coverUploading
              ? <ActivityIndicator size="small" color="#fff" />
              : <Camera size={13} color="#fff" />}
          </Pressable>
        ) : null}
      </View>

      {/* ── Portrait + Seal row ── */}
      <View style={s.portraitRow}>
        {/* Avatar */}
        <View style={s.avatarWrap}>
          <HighlightRing
            hasActive={hasHighlights ?? false}
            allViewed={allHighlightsViewed ?? false}
            size={80}
            ringWidth={2.5}
            gap={2}
            onPress={onHighlightRingPress}
          >
            <View style={s.photoFrame}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={s.photo} />
              ) : (
                <View style={[s.photo, s.photoFallback]}>
                  <Text style={s.initials}>{initials}</Text>
                </View>
              )}
            </View>
          </HighlightRing>
          {isOwner && onNewHighlightPress ? (
            <Pressable
              style={s.avatarCameraBtn}
              onPress={onNewHighlightPress}
              accessibilityLabel="Edit photo or add highlight"
            >
              <Camera size={11} color="#fff" />
            </Pressable>
          ) : null}
        </View>

        {/* Verified seal overlay */}
        {isVerified ? (
          <View style={s.sealWrap}>
            <PassportVerifiedSeal
              status={verificationStatus}
              verifiedSince={'verifiedAt' in profile ? profile.verifiedAt : null}
              size={88}
            />
          </View>
        ) : null}
      </View>

      {/* ── Identity fields ── */}
      <View style={s.identityBlock}>
        {/* Name + handle */}
        <View style={s.nameRow}>
          <Text style={s.displayName} numberOfLines={1}>{resolvedName}</Text>
          {handleSubline ? <Text style={s.handle}>{handleSubline}</Text> : null}
        </View>

        {/* Two-column fields grid */}
        <View style={s.fieldsGrid}>
          <View style={s.fieldCol}>
            <FieldRow label="Home">
              <Text style={[PP_VALUE, { fontSize: 13 }]} numberOfLines={1}>
                {[homeCity, homeCountry ? (flagInfo?.code ?? homeCountry) : null]
                  .filter(Boolean).join(', ') || '—'}
              </Text>
            </FieldRow>
          </View>
          <View style={s.fieldCol}>
            <FieldRow label="Member Since">
              <View style={s.memberSince}>
                <Calendar size={11} color={PP.inkMuted} />
                <Text style={[PP_VALUE, { fontSize: 12 }]}>
                  {fmtMonthYear(createdAt) || '—'}
                </Text>
              </View>
            </FieldRow>
          </View>

          {/* Trust Score (owner only, when available) */}
          {trustScore != null ? (
            <View style={s.fieldColFull}>
              <Pressable style={s.trustRow} onPress={onTrustInfo} accessibilityRole="button">
                <ShieldCheck size={13} color="#0D9B6F" strokeWidth={2} />
                <Text style={[PP_LABEL, { color: '#0D9B6F', letterSpacing: 1 }]}>
                  TRUST SCORE
                </Text>
                <Text style={s.trustScore}>{Math.round(trustScore)}</Text>
                <Text style={[PP_LABEL, { color: PP.inkMuted, letterSpacing: 1 }]}>/ 100</Text>
                {trustLabel ? (
                  <Text style={[PP_LABEL, { color: PP.inkMuted }]}>· {trustLabel}</Text>
                ) : null}
              </Pressable>
            </View>
          ) : null}

          {/* Verification status chip (non-owner, non-verified) */}
          {!isOwner && !isVerified && (
            <View style={s.fieldCol}>
              <FieldRow label="Status">
                <StatusChip text={verificationStatus === 'pending' ? 'Pending' : 'Traveler'} />
              </FieldRow>
            </View>
          )}
          {isOwner && !isVerified && (
            <View style={s.fieldCol}>
              <FieldRow label="Status">
                <StatusChip text={verificationStatus === 'pending' ? 'Pending Review' : 'Unverified'} />
              </FieldRow>
            </View>
          )}
        </View>

        {/* ── Stats ruled row ── */}
        <View style={s.statsWrap}>
          <View style={s.statsRule} />
          <View style={s.statsRow}>
            {stats.map((item, i) => (
              <React.Fragment key={item.label}>
                {i > 0 && <View style={s.statsDivider} />}
                <Pressable
                  style={s.statsCell}
                  onPress={item.onPress}
                  disabled={!item.onPress}
                >
                  <Text style={s.statsN}>{item.n}</Text>
                  <Text style={s.statsL}>{item.label.toUpperCase()}</Text>
                </Pressable>
              </React.Fragment>
            ))}
          </View>
          <View style={s.statsRule} />
        </View>
      </View>

      {/* ── Bottom MRZ stripe ── */}
      <View style={s.mrzStripe}>
        <Text style={s.mrzText} numberOfLines={1}>
          {'PASSPORT NO. ' + ppNo + '  ·  TRAVEL BUDDY  ·  '}
          {isVerified ? 'VERIFIED TRAVELER  ·  SOCIAL PASSPORT' : 'SOCIAL PASSPORT'}
        </Text>
      </View>
    </View>
  );
}

const COVER_H = 108;
const AVATAR_SIZE = 80;
const FRAME_SIZE = AVATAR_SIZE + 4;

const s = StyleSheet.create({
  card: {
    backgroundColor: PP.paper,
    overflow: 'hidden',
    // Subtle elevation
    shadowColor: PP.ink,
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 7,
    marginBottom: 2,
  },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 9,
    zIndex: 2,
  },
  topBarLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flag: { fontSize: 16 },
  brand: { ...PP_LABEL, letterSpacing: 1.2, fontSize: 9 },
  topRule: { height: 2, backgroundColor: PP.ink, marginBottom: 0 },

  menuBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: PP.paperDeep,
    borderWidth: 1, borderColor: PP.border,
    alignItems: 'center', justifyContent: 'center',
  },
  followBtn: {
    borderWidth: 1.5, borderColor: PP.ink, borderRadius: 20,
    paddingHorizontal: 12, paddingVertical: 5,
    backgroundColor: 'transparent',
  },
  followBtnActive: { backgroundColor: PP.ink },
  followText: { ...PP_LABEL, color: PP.ink, letterSpacing: 1 },
  followTextActive: { color: PP.paper },

  // Cover band
  coverBand: {
    height: COVER_H,
    backgroundColor: PP.paperDeep,
    overflow: 'hidden',
  },
  coverFallback: { backgroundColor: PP.paperDeep },
  coverFade: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: 48,
  },
  coverUploadOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  coverCameraBtn: {
    position: 'absolute', bottom: 10, right: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 14, padding: 6,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
  },

  // Portrait row
  portraitRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginTop: -(FRAME_SIZE / 2 + 4),
    zIndex: 2,
  },
  avatarWrap: { position: 'relative' },
  photoFrame: {
    width: FRAME_SIZE, height: FRAME_SIZE + 8,
    borderRadius: 8,
    borderWidth: 2, borderColor: PP.paper,
    backgroundColor: PP.paperDeep,
    overflow: 'hidden',
    ...shadow.card,
  },
  photo: { width: '100%', height: '100%' },
  photoFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: PP.paperDeep },
  initials: { fontSize: 22, fontWeight: '800', color: PP.inkMuted, letterSpacing: 1 },
  avatarCameraBtn: {
    position: 'absolute', bottom: 2, right: -2,
    backgroundColor: PP.ink, borderRadius: 10, padding: 4,
    borderWidth: 1.5, borderColor: PP.paper,
  },

  // Seal
  sealWrap: {
    transform: [{ rotate: '10deg' }],
    marginBottom: 6,
    borderRadius: 999,
    overflow: 'hidden',
    // subtle shadow around the seal
    shadowColor: PP.seal,
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 3,
  },

  // Identity block
  identityBlock: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 0,
    gap: 8,
  },
  nameRow: { gap: 1 },
  displayName: {
    fontSize: 22, fontWeight: '800', color: PP.ink,
    letterSpacing: -0.4, lineHeight: 26,
  },
  handle: {
    fontFamily: 'Courier', fontSize: 11,
    color: PP.inkMuted, letterSpacing: 0.5,
  },

  // Fields grid
  fieldsGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    gap: 10, marginTop: 4,
  },
  fieldCol: { flex: 1, minWidth: 120 },
  fieldColFull: { width: '100%' },

  memberSince: { flexDirection: 'row', alignItems: 'center', gap: 3 },

  trustRow: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(13,155,111,0.08)',
    borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5,
    borderWidth: 1, borderColor: 'rgba(13,155,111,0.2)',
    alignSelf: 'flex-start',
  },
  trustScore: {
    fontSize: 16, fontWeight: '800', color: '#0D9B6F', letterSpacing: -0.5,
  },

  // Stats row
  statsWrap: { marginTop: 8, gap: 0 },
  statsRule: { height: 1, backgroundColor: PP.borderLight },
  statsRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 8,
  },
  statsCell: { flex: 1, alignItems: 'center', gap: 1 },
  statsDivider: { width: 1, height: 22, backgroundColor: PP.borderLight },
  statsN: { fontSize: 16, fontWeight: '800', color: PP.ink, letterSpacing: -0.5 },
  statsL: { ...PP_LABEL, fontSize: 7.5 },

  // MRZ
  mrzStripe: {
    backgroundColor: PP.ink, paddingVertical: 7, paddingHorizontal: 16,
    marginTop: 12,
  },
  mrzText: {
    fontFamily: 'Courier', fontSize: 8,
    color: 'rgba(248,243,232,0.65)',
    letterSpacing: 0.8,
    textAlign: 'center',
  },
});
