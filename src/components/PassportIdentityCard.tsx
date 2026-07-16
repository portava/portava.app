/**
 * PassportIdentityCard — Portava Passport header redesign.
 *
 * Visual redesign only. Preserves the original props contract and every
 * existing handler (avatar, cover, highlights, follow, menu, trust, stats).
 * New OPTIONAL props (all backward-compatible — omitting them hides the UI):
 *   countriesCount  — value for the Countries stat (from map payload)
 *   onEditPress     — owner-only Edit Profile compact card
 *   onSavedPress    — owner-only Saved compact card
 *
 * Data rules per spec: no hardcoded identity/stat values; decorative stamps
 * and spine are visual-only (pointerEvents="none"); no dead-end controls —
 * interactive elements render only when a real handler is supplied.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Image, Pressable, StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import {
  Settings, ShieldCheck, Camera, Plus, Bookmark, PenLine, MapPin, Plane,
} from 'lucide-react-native';
import type { OwnProfile, PublicProfile } from '../../types/models';
import { resolveAvatarUrl, fallbackInitials } from '../../utils/identity';
import { primaryIdentityText, secondaryIdentityText } from '../../lib/displayIdentity';
import { isTravelBuddyVerified } from '../../lib/verification';
import { HighlightRing } from '../HighlightRing';
import { getPassportStats } from '../../services/passportStamps';
import type { PassportStats } from '../../services/passportStamps';
import { PP } from '../../theme/passportTokens';

type AnyProfile = OwnProfile | PublicProfile;

interface StatItem { n: number | string; label: string; onPress?: () => void; accent?: string }

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
  /** Countries-visited count (map payload). Stat hidden when absent. */
  countriesCount?: number | null;
  /** Owner-only Edit Profile action. Button hidden when absent. */
  onEditPress?: () => void;
  /** Owner-only Saved action. Button hidden when absent. */
  onSavedPress?: () => void;
}

/* Passport-paper palette (spec §23) — layered over shared PP tokens. */
const PX = {
  paper:  '#FCF8EE',
  border: '#E6D8BE',
  gold:   '#A9864A',
  ink:    '#101828',
  sub:    '#667085',
  green:  '#16A34A',
  blue:   '#2583F7',
  purple: '#6D4AFF',
  pink:   '#D83C72',
  orange: '#F28C28',
  light:  '#E9E4DA',
  white:  '#FFFFFF',
} as const;

const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' });

function fmt(n: number | string): string {
  if (typeof n !== 'number') return String(n);
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
}

export function PassportIdentityCard({
  profile, isOwner, onMenuPress, onAvatarPress, onChangeCover, coverUploading,
  hasHighlights, allHighlightsViewed, onHighlightRingPress, onNewHighlightPress,
  trustScore, trustLabel, onTrustInfo, isFollowing, followLoading, onFollowPress,
  overrideStats, onStatPress, countriesCount, onEditPress, onSavedPress,
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

  /* Traveler identity tags — real profile data, graceful fallback (spec §14). */
  const tags: string[] =
    'travelStyles' in profile && Array.isArray((profile as any).travelStyles) && (profile as any).travelStyles.length
      ? (profile as any).travelStyles.slice(0, 3)
      : 'travelStyle' in profile && (profile as any).travelStyle
        ? [(profile as any).travelStyle]
        : [];

  /* Home location — existing profile fields only, never live GPS (spec §15). */
  const homeCity = 'homeCity' in profile ? (profile as any).homeCity : null;
  const homeCountry = 'homeCountry' in profile ? (profile as any).homeCountry : null;
  const locationText = [homeCity, homeCountry].filter(Boolean).join(', ');

  /* Stats ticket (spec §18–20): Trips, Followers, Following, [Countries], Stamps. */
  const ownStats: StatItem[] = [
    {
      n: 'tripCount' in profile ? (profile.tripCount ?? 0) : 0,
      label: 'Trips',
      accent: PX.purple,
      onPress: () => onStatPress?.('Trips'),
    },
    {
      n: 'followersCount' in profile ? (profile.followersCount ?? 0) : 0,
      label: 'Followers',
      accent: PX.pink,
      onPress: () => onStatPress?.('Followers'),
    },
    {
      n: 'followingCount' in profile ? (profile.followingCount ?? 0) : 0,
      label: 'Following',
      accent: PX.green,
      onPress: () => onStatPress?.('Following'),
    },
    ...(countriesCount != null
      ? [{
          n: countriesCount,
          label: 'Countries',
          accent: PX.blue,
          onPress: () => onStatPress?.('Countries'),
        } as StatItem]
      : []),
    {
      n: liveStats?.totalStamps ?? 0,
      label: 'Stamps',
      accent: PX.orange,
      onPress: () => onStatPress?.('Stamps'),
    },
  ];
  const stats = overrideStats ?? ownStats;

  const score = trustScore != null ? Math.max(0, Math.min(100, Math.round(trustScore))) : null;

  return (
    <View style={s.card}>
      {/* ── Passport security texture — decorative only (spec §4) ── */}
      <View pointerEvents="none" style={s.texture}>
        <View style={[s.texCircle, { top: -60, right: -40, width: 220, height: 220 }]} />
        <View style={[s.texCircle, { top: -20, right: 10, width: 140, height: 140 }]} />
        <View style={[s.texCircle, { bottom: -80, left: 40, width: 260, height: 260 }]} />
        <View style={[s.texLine, { top: 84 }]} />
        <View style={[s.texLine, { top: 96 }]} />
      </View>

      {/* ── Decorative passport stamps — visual only (spec §7) ── */}
      <View pointerEvents="none" style={s.decoStampTR}>
        <Text style={s.decoStampTRText}>PORTAVA PASSPORT</Text>
        <View style={s.decoStampTRRow}>
          <Plane size={9} color={PX.gold} strokeWidth={1.5} />
          <Text style={s.decoStampTRText}>EXPLORE MORE</Text>
        </View>
      </View>
      <View pointerEvents="none" style={s.decoStampBL}>
        <Text style={s.decoStampBLText}>ADVENTURE</Text>
        <Text style={s.decoStampBLText}>IS WORTHWHILE</Text>
      </View>

      {/* ── Left passport spine (spec §5) ── */}
      <View pointerEvents="none" style={s.spine}>
        <Plane size={11} color={PX.gold} strokeWidth={1.5} style={s.spinePlane} />
        <Text numberOfLines={1} style={s.spineText}>PORTAVA PASSPORT</Text>
      </View>

      <View style={s.inner}>
        {/* ── Top bar — existing controls preserved ── */}
        <View style={s.topBar}>
          <View style={s.topLeft}>
            {isOwner && onChangeCover ? (
              <Pressable style={s.iconBtn} onPress={onChangeCover} hitSlop={12} accessibilityLabel="Change cover photo">
                {coverUploading ? (
                  <ActivityIndicator size="small" color={PP.inkMuted} />
                ) : (
                  <Camera size={18} color={PX.sub} strokeWidth={1.5} />
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
                <Settings size={18} color={PX.ink} strokeWidth={1.5} />
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* ── Identity row: avatar + name block (spec §6, §8–11) ── */}
        <View style={s.profileTop}>
          <View style={s.avatarWrap}>
            <View style={s.avatarGoldRing}>
              <HighlightRing
                hasActive={hasHighlights ?? false}
                allViewed={allHighlightsViewed ?? false}
                size={104}
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
            </View>

            {isOwner && onNewHighlightPress ? (
              <Pressable style={s.addHighlightBtn} onPress={onNewHighlightPress} hitSlop={12} accessibilityLabel="Add Highlight">
                <Plus size={15} color={PX.white} strokeWidth={3} />
              </Pressable>
            ) : null}

            {isVerified && (
              <View style={s.verifiedBadge}>
                <ShieldCheck size={13} color={PX.white} strokeWidth={2.5} />
              </View>
            )}
          </View>

          <View style={s.nameContainer}>
            <Text style={s.travelerLabel}>TRAVELER ✦</Text>
            <View style={s.nameRow}>
              <Text style={s.displayName} numberOfLines={1}>{resolvedName}</Text>
              {isVerified && (
                <View style={s.nameBadge}>
                  <ShieldCheck size={12} color={PX.white} strokeWidth={2.5} />
                </View>
              )}
            </View>
            {handleSubline ? <Text style={s.handle}>{handleSubline}</Text> : null}

            {tags.length > 0 && (
              <Text style={s.tagsRow} numberOfLines={1}>
                {tags.join('  •  ')}
              </Text>
            )}

            {locationText ? (
              <View style={s.locationRow}>
                <MapPin size={12} color={PX.sub} strokeWidth={1.75} />
                <Text style={s.locationText} numberOfLines={1}>{locationText}</Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* ── Trust Score pill (spec §12) — real value only ── */}
        {score != null ? (
          <Pressable style={s.trustCard} onPress={onTrustInfo} hitSlop={8} disabled={!onTrustInfo}>
            <View style={s.trustShield}>
              <ShieldCheck size={16} color={PX.green} strokeWidth={2} />
            </View>
            <View style={s.trustBody}>
              <View style={s.trustHead}>
                <Text style={s.trustLabelText}>TRUST SCORE</Text>
                {trustLabel ? <Text style={s.trustTier}>{trustLabel}</Text> : null}
              </View>
              <Text style={s.trustValue}>
                {score}
                <Text style={s.trustDenom}> / 100</Text>
              </Text>
              <View style={s.trustBar}>
                <View style={[s.trustFill, { width: `${score}%` }]} />
              </View>
            </View>
          </Pressable>
        ) : isVerified ? (
          <Text style={s.verifiedFallback}>Travel Buddy Verified</Text>
        ) : null}

        {/* ── Owner actions: Saved / Edit Profile (spec §16–17) ── */}
        {isOwner && (onSavedPress || onEditPress) ? (
          <View style={s.actionsRow}>
            {onSavedPress ? (
              <Pressable style={s.actionCard} onPress={onSavedPress} hitSlop={8} accessibilityLabel="Saved">
                <Bookmark size={17} color={PX.ink} strokeWidth={1.75} />
                <Text style={s.actionLabel}>Saved</Text>
              </Pressable>
            ) : null}
            {onEditPress ? (
              <Pressable style={s.actionCard} onPress={onEditPress} hitSlop={8} accessibilityLabel="Edit Profile">
                <PenLine size={17} color={PX.ink} strokeWidth={1.75} />
                <Text style={s.actionLabel}>Edit Profile</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* ── Stats ticket (spec §18–20) ── */}
        <View style={s.ticket}>
          <View style={s.ticketNotchL} />
          <View style={s.ticketNotchR} />
          {stats.map((item) => (
            <Pressable
              key={item.label}
              onPress={item.onPress}
              disabled={!item.onPress}
              style={s.statCell}
              hitSlop={6}
            >
              <Text style={s.statN} numberOfLines={1}>{fmt(item.n)}</Text>
              <Text style={s.statL} numberOfLines={1}>{item.label}</Text>
              <View style={[s.statUnderline, { backgroundColor: item.accent ?? PX.gold }]} />
            </Pressable>
          ))}
        </View>

        {/* ── Bio — preserved from original ── */}
        {('bio' in profile && profile.bio) ? (
          <View style={s.bioWrap}>
            <Text style={s.bioText}>{profile.bio}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const SPINE_W = 26;

const s = StyleSheet.create({
  /* ── Card shell (spec §3) ── */
  card: {
    backgroundColor: PX.paper,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: PX.border,
    marginHorizontal: 12,
    marginTop: 4,
    overflow: 'hidden',
    shadowColor: '#8A7A5A',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  inner: {
    paddingLeft: SPINE_W + 12,
    paddingRight: 16,
    paddingTop: 10,
    paddingBottom: 18,
  },

  /* ── Security texture (spec §4, 3–8% opacity) ── */
  texture: { ...StyleSheet.absoluteFillObject },
  texCircle: {
    position: 'absolute',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(169,134,74,0.06)',
  },
  texLine: {
    position: 'absolute',
    left: SPINE_W + 8,
    right: 12,
    height: 1,
    backgroundColor: 'rgba(169,134,74,0.05)',
  },

  /* ── Decorative stamps (spec §7) ── */
  decoStampTR: {
    position: 'absolute',
    top: 40,
    right: 14,
    borderWidth: 1,
    borderColor: PX.gold,
    borderRadius: 4,
    borderStyle: 'dashed',
    paddingHorizontal: 6,
    paddingVertical: 3,
    opacity: 0.16,
    transform: [{ rotate: '-7deg' }],
    alignItems: 'center',
  },
  decoStampTRRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  decoStampTRText: { fontSize: 7, letterSpacing: 1, fontWeight: '700', color: PX.gold },
  decoStampBL: {
    position: 'absolute',
    bottom: 14,
    left: SPINE_W + 8,
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 1.5,
    borderColor: PX.blue,
    borderStyle: 'dashed',
    opacity: 0.10,
    transform: [{ rotate: '10deg' }],
    alignItems: 'center',
    justifyContent: 'center',
  },
  decoStampBLText: { fontSize: 7, letterSpacing: 0.8, fontWeight: '700', color: PX.blue },

  /* ── Spine (spec §5) ── */
  spine: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: SPINE_W,
    borderRightWidth: 1,
    borderRightColor: PX.border,
    backgroundColor: 'rgba(169,134,74,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinePlane: { position: 'absolute', top: 14 },
  spineText: {
    color: PX.gold,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 2.5,
    width: 240,
    textAlign: 'center',
    transform: [{ rotate: '-90deg' }],
  },

  /* ── Top bar ── */
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  topLeft: { alignItems: 'flex-start' },
  topRight: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: PX.white,
    borderWidth: 1, borderColor: PX.light,
    alignItems: 'center', justifyContent: 'center',
  },
  followBtn: {
    borderWidth: 1.5, borderColor: PX.ink, borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 6,
    backgroundColor: 'transparent',
  },
  followBtnActive: { backgroundColor: PX.ink },
  followText: { fontSize: 13, fontWeight: '600', color: PX.ink },
  followTextActive: { color: PX.paper },

  /* ── Identity ── */
  profileTop: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 12 },
  avatarWrap: { position: 'relative' },
  avatarGoldRing: {
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: PX.gold,
    padding: 2,
    backgroundColor: PX.white,
  },
  photoFrame: {
    borderRadius: 999,
    borderWidth: 4,
    borderColor: PX.white,
    overflow: 'hidden',
  },
  photo: { width: 92, height: 92, borderRadius: 999 },
  photoFallback: { backgroundColor: PP.paperDeep, alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 30, fontWeight: '700', color: PX.gold },
  addHighlightBtn: {
    position: 'absolute', bottom: 0, right: 0,
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: PX.ink,
    borderWidth: 2, borderColor: PX.paper,
    alignItems: 'center', justifyContent: 'center',
  },
  verifiedBadge: {
    position: 'absolute', top: 0, right: 0,
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: PX.blue,
    borderWidth: 2, borderColor: PX.paper,
    alignItems: 'center', justifyContent: 'center',
  },
  nameContainer: { flex: 1, minWidth: 0 },
  travelerLabel: { fontSize: 10, letterSpacing: 2, fontWeight: '700', color: PX.gold, marginBottom: 3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  displayName: {
    fontSize: 29,
    fontWeight: '700',
    color: PX.ink,
    fontFamily: SERIF,
    letterSpacing: 0.5,
    flexShrink: 1,
  },
  nameBadge: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: PX.blue,
    alignItems: 'center', justifyContent: 'center',
  },
  handle: { fontSize: 14, color: PX.sub, marginTop: 2 },
  tagsRow: { fontSize: 13, fontWeight: '600', color: PX.ink, marginTop: 8 },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  locationText: { fontSize: 13, color: PX.sub },

  /* ── Trust card (spec §12) ── */
  trustCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: PX.white,
    borderWidth: 1,
    borderColor: PX.light,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  trustShield: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(22,163,74,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  trustBody: { flex: 1 },
  trustHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  trustLabelText: { fontSize: 9, letterSpacing: 1.5, fontWeight: '700', color: PX.sub },
  trustTier: { fontSize: 10, fontWeight: '700', color: PX.gold, letterSpacing: 0.5 },
  trustValue: { fontSize: 19, fontWeight: '800', color: PX.ink, marginTop: 1 },
  trustDenom: { fontSize: 12, fontWeight: '600', color: PX.sub },
  trustBar: {
    height: 4, borderRadius: 2,
    backgroundColor: 'rgba(22,163,74,0.12)',
    marginTop: 5,
    overflow: 'hidden',
  },
  trustFill: { height: 4, borderRadius: 2, backgroundColor: PX.green },
  verifiedFallback: { fontSize: 13, fontWeight: '600', color: PX.blue, marginBottom: 12 },

  /* ── Owner actions (spec §16–17) ── */
  actionsRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  actionCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: PX.white,
    borderWidth: 1,
    borderColor: PX.light,
    borderRadius: 14,
    paddingVertical: 12,
  },
  actionLabel: { fontSize: 13, fontWeight: '600', color: PX.ink },

  /* ── Stats ticket (spec §18–19) ── */
  ticket: {
    flexDirection: 'row',
    backgroundColor: PX.white,
    borderWidth: 1,
    borderColor: PX.light,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 4,
    position: 'relative',
  },
  ticketNotchL: {
    position: 'absolute', left: -7, top: '50%', marginTop: -7,
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: PX.paper,
    borderWidth: 1, borderColor: PX.light,
  },
  ticketNotchR: {
    position: 'absolute', right: -7, top: '50%', marginTop: -7,
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: PX.paper,
    borderWidth: 1, borderColor: PX.light,
  },
  statCell: { flex: 1, alignItems: 'center', gap: 2 },
  statN: { fontSize: 17, fontWeight: '800', color: PX.ink },
  statL: { fontSize: 10, fontWeight: '600', color: PX.sub, textTransform: 'uppercase', letterSpacing: 0.4 },
  statUnderline: { width: 18, height: 2.5, borderRadius: 2, marginTop: 2 },

  /* ── Bio ── */
  bioWrap: { marginTop: 12 },
  bioText: { fontSize: 14, lineHeight: 20, color: PP.inkLight },
});
