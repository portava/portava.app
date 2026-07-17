/**
 * PassportIdentityCard — Passport document header.
 * Premium cream/ivory document card with vertical spine, gold-ring avatar,
 * Trust Score, Passport brand stamp + Bio in the lower area.
 * Edge-to-edge: no outer margins, no floating-card border-radius.
 *
 * PassportStatsRow — separate stats/counter section rendered below the card.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Image, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg';
import {
  ShieldCheck, Globe, MapPin, Camera,
  UserPlus, UserCheck, MoreHorizontal,
  Briefcase, Users, Stamp, PenLine, Bookmark,
} from 'lucide-react-native';
import type { OwnProfile, PublicProfile } from '../../types/models';
import { resolveAvatarUrl, fallbackInitials, truncateDisplayName } from '../../utils/identity';
import { primaryIdentityText, secondaryIdentityText } from '../../lib/displayIdentity';
import { isTravelBuddyVerified } from '../../lib/verification';
import { HighlightRing } from '../HighlightRing';
import { getPassportStats } from '../../services/passportStamps';
import type { PassportStats } from '../../services/passportStamps';
import { PP } from '../../theme/passportTokens';

type AnyProfile = OwnProfile | PublicProfile;

export interface StatItem { n: number | string; label: string; onPress?: () => void }

interface Props {
  profile: AnyProfile;
  isOwner: boolean;
  onMenuPress?: () => void;
  onAvatarPress?: () => void;
  /** Owner: change profile photo */
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
  /** Owner: tap "Add a bio" empty state → navigate to edit profile */
  onEditBio?: () => void;
  /** Owner: tap compact Saved shortcut → navigate to /saved */
  onSavedPress?: () => void;
}

const AVATAR_SIZE  = 76;
const GOLD         = '#B8974E';
const INK          = '#1C1C1A';
const MUTED        = '#8A7E6E';
const CREAM        = '#F5F0E8';
const GREEN_STAMP  = '#2D6A4F';
const NAVY         = '#1C3A6E';

// ─── Stat accent config ───────────────────────────────────────────────────────

type StatConfig = { color: string; bg: string; Icon: React.ComponentType<any> };
export const STAT_CFG: Record<string, StatConfig> = {
  Trips:     { color: '#7C3AED', bg: '#EDE9FE', Icon: Briefcase   },
  Followers: { color: '#DB2777', bg: '#FCE7F3', Icon: Users        },
  Following: { color: '#059669', bg: '#D1FAE5', Icon: UserPlus     },
  Countries: { color: '#2563EB', bg: '#DBEAFE', Icon: Globe        },
  Stamps:    { color: '#D97706', bg: '#FEF3C7', Icon: Stamp        },
};
const STAT_FALLBACK: StatConfig = { color: MUTED, bg: '#F3F4F6', Icon: Globe };

// ─── Passport brand stamp (lower-left identity mark) ─────────────────────────

function PortavaBrandStamp() {
  return (
    <Svg width={56} height={34} viewBox="0 0 110 72">
      <Rect x={2} y={2} width={106} height={68} rx={6} stroke={GOLD} strokeWidth={2} strokeDasharray="3 2" fill="none" />
      <Rect x={6} y={6} width={98} height={60} rx={4} stroke={GOLD} strokeWidth={1} fill="none" opacity={0.4} />
      <SvgText x="55" y="19" textAnchor="middle" fill={GOLD} fontSize="6.5" fontWeight="700">PORTAVA PASSPORT</SvgText>
      <Path d="M40 44 L50 34 L53 37 L47 43 L58 46 L55 49 L44 46 L46 52 L43 54 Z" fill={GOLD} opacity={0.65} />
      <SvgText x="55" y="61" textAnchor="middle" fill={GOLD} fontSize="6" fontWeight="700">★  EXPLORE MORE  ★</SvgText>
    </Svg>
  );
}

// ─── Passport-style verified stamp (replaces generic CheckCircle2) ─────────────

function PassportVerifiedStamp() {
  return (
    <Svg
      width={22}
      height={22}
      viewBox="0 0 30 30"
      accessibilityLabel="Verified traveler"
    >
      {/* Outer dashed ring */}
      <Circle cx={15} cy={15} r={13} stroke={NAVY} strokeWidth={2} strokeDasharray="3 1.5" fill="none" />
      {/* Inner thin ring */}
      <Circle cx={15} cy={15} r={9.5} stroke={NAVY} strokeWidth={0.8} fill="none" opacity={0.55} />
      {/* Plane silhouette pointing upper-right */}
      <Path
        d="M7.5 16.5 L12 9 L14 11.5 L10.5 14.5 L18 16.8 L16 19.2 L9.5 17 L10.5 21 L8.5 22 Z"
        fill={NAVY}
        opacity={0.9}
      />
      {/* Decorative dots at bottom */}
      <SvgText x="15" y="27.5" textAnchor="middle" fill={NAVY} fontSize="3.5" fontWeight="800" opacity={0.6}>✦ ✦ ✦</SvgText>
    </Svg>
  );
}

// ─── Trust Score bar ──────────────────────────────────────────────────────────

function TrustScoreBar({ score, onPress }: { score: number; onPress?: () => void }) {
  const pct = Math.min(100, Math.max(0, score));
  return (
    <Pressable style={s.trustCard} onPress={onPress} disabled={!onPress} hitSlop={8}>
      <View style={s.trustCardRow}>
        <ShieldCheck size={14} color={GREEN_STAMP} strokeWidth={2.5} />
        <Text style={s.trustCardLabel}>TRUST SCORE</Text>
        <Text style={s.trustCardScore}>{Math.round(score)}</Text>
        <Text style={s.trustCardTotal}>/100</Text>
      </View>
      <View style={s.trustBarBg}>
        <View style={[s.trustBarFill, { width: `${pct}%` as any }]} />
      </View>
    </Pressable>
  );
}

// ─── Stat ticket ──────────────────────────────────────────────────────────────
// iconOnly=true  → icon bg + number, no label text  (scrolled / compact)
// iconOnly=false → label text + number, no icon bg  (expanded, default)

export function StatTicket({ n, label, onPress, iconOnly }: StatItem & { iconOnly?: boolean }) {
  const cfg = STAT_CFG[label] ?? STAT_FALLBACK;
  const { Icon, color, bg } = cfg;
  return (
    <Pressable style={st.statTicket} onPress={onPress} disabled={!onPress} hitSlop={6}>
      {iconOnly ? (
        <View style={[st.statIconBg, { backgroundColor: bg }]}>
          <Icon size={18} color={color} strokeWidth={1.8} />
        </View>
      ) : null}
      <Text style={[st.statN, { color }]}>{n}</Text>
      {!iconOnly ? (
        <Text style={st.statL}>{label}</Text>
      ) : null}
      <View style={[st.statUnderline, { backgroundColor: color }]} />
    </Pressable>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatStatN(n: number | string): string {
  if (typeof n === 'string') return n;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

// ─── Separate stats/counter row (rendered below the card by the screen) ───────

interface StatsRowProps {
  profile: AnyProfile;
  isOwner: boolean;
  overrideStats?: StatItem[];
  onStatPress?: (label: string) => void;
  /** When true: show icon + count, hide label. When false/undefined: show label + count, hide icon. */
  iconOnly?: boolean;
}

export function PassportStatsRow({ profile, isOwner, overrideStats, onStatPress, iconOnly }: StatsRowProps) {
  const [liveStats, setLiveStats] = useState<PassportStats | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    getPassportStats()
      .then((res) => { if (res.ok) setLiveStats(res.data); })
      .catch(() => {});
  }, [isOwner]);

  const ownStats: StatItem[] = [
    { n: formatStatN('tripCount'      in profile ? (profile.tripCount      ?? 0) : 0), label: 'Trips',     onPress: () => onStatPress?.('Trips')     },
    { n: formatStatN('followersCount' in profile ? (profile.followersCount ?? 0) : 0), label: 'Followers', onPress: () => onStatPress?.('Followers') },
    { n: formatStatN('followingCount' in profile ? (profile.followingCount ?? 0) : 0), label: 'Following', onPress: () => onStatPress?.('Following') },
    { n: liveStats?.countries ?? 0,                                                     label: 'Countries', onPress: () => onStatPress?.('Countries') },
    { n: liveStats?.totalStamps ?? 0,                                                   label: 'Stamps',    onPress: () => onStatPress?.('Stamps')    },
  ];
  const stats = overrideStats ?? ownStats;

  return (
    <View style={st.section}>
      <View style={st.statsRow}>
        {stats.map((item) => (
          <StatTicket key={item.label} {...item} iconOnly={iconOnly} />
        ))}
      </View>
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PassportIdentityCard({
  profile, isOwner,
  onMenuPress, onAvatarPress, onChangeCover, coverUploading,
  hasHighlights, allHighlightsViewed, onHighlightRingPress, onNewHighlightPress,
  trustScore, trustLabel, onTrustInfo,
  isFollowing, followLoading, onFollowPress,
  onEditBio, onSavedPress,
}: Props) {
  const username      = 'username' in profile ? profile.username : null;
  const identity      = {
    displayName: 'displayName' in profile ? profile.displayName : null,
    name:        'name'        in profile ? profile.name        : null,
    username,
  };
  // Cap at the 40-char display-name limit — legacy accounts created before
  // the limit may still have longer names stored in the DB.
  const resolvedName  = truncateDisplayName(primaryIdentityText(identity));
  const handleSubline = secondaryIdentityText(identity);
  const avatarUrl     = resolveAvatarUrl(profile.avatarUrl);
  const initials      = fallbackInitials(profile);
  const isVerified    = isTravelBuddyVerified(profile);

  // Location: prefer currentCity, then homeCity + homeCountry
  const homeCity    = 'homeCity'    in profile ? (profile.homeCity    ?? null) : null;
  const homeCountry = 'homeCountry' in profile ? (profile.homeCountry ?? null) : null;
  const currentCity = 'currentCity' in profile ? (profile.currentCity ?? null) : null;
  const locationLine = currentCity ?? (homeCity && homeCountry ? `${homeCity}, ${homeCountry}` : homeCity ?? homeCountry ?? null);

  // Interests as pill tags
  const interests: string[] = 'interests' in profile && Array.isArray(profile.interests)
    ? (profile.interests as string[]).slice(0, 3)
    : [];

  // Bio — real backend value, not placeholder
  const bio = 'bio' in profile ? (profile.bio ?? null) : null;

  return (
    <View style={s.card}>
      <View style={s.cardInner}>

        {/* ── Left spine ──────────────────────────────────────── */}
        <View style={s.spine}>
          <View style={s.spineTextWrap}>
            <Text style={s.spineText}>PORTAVA PASSPORT</Text>
          </View>
          <View style={s.spineIcon}>
            <Svg width={14} height={14} viewBox="0 0 24 24">
              <Path d="M21 3l-7 7M21 3H13M21 3v8M3 21l7-7M3 21h8M3 21v-8" stroke={MUTED} strokeWidth={1.5} strokeLinecap="round" fill="none" opacity={0.6} />
            </Svg>
          </View>
        </View>

        {/* ── Card body ───────────────────────────────────────── */}
        <View style={s.body}>

          {/* ── ⋯ menu — top-right, always visible ── */}
          {onMenuPress ? (
            <Pressable
              style={s.menuBtn}
              onPress={onMenuPress}
              hitSlop={10}
              accessibilityLabel={isOwner ? 'Passport menu' : 'More options'}
            >
              <MoreHorizontal size={20} color={INK} strokeWidth={2} />
            </Pressable>
          ) : null}

          {/* Columns */}
          <View style={s.columns}>

            {/* LEFT COLUMN — avatar only */}
            <View style={s.leftCol}>
              <View style={s.avatarOuter}>
                <View style={s.goldRing}>
                  <HighlightRing
                    hasActive={hasHighlights ?? false}
                    allViewed={allHighlightsViewed ?? false}
                    size={AVATAR_SIZE}
                    ringWidth={2}
                    gap={2}
                    onPress={onHighlightRingPress}
                  >
                    <Pressable
                      style={s.avatarPressable}
                      onPress={onAvatarPress}
                      disabled={!onAvatarPress}
                    >
                      {avatarUrl ? (
                        <Image source={{ uri: avatarUrl }} style={s.avatarImg} />
                      ) : (
                        <View style={[s.avatarImg, s.avatarFallback]}>
                          <Text style={s.initials}>{initials}</Text>
                        </View>
                      )}
                    </Pressable>
                  </HighlightRing>
                </View>

                {/* Camera button — owner only */}
                {isOwner && onChangeCover ? (
                  <Pressable
                    style={s.cameraBtn}
                    onPress={onChangeCover}
                    hitSlop={12}
                    accessibilityLabel="Change profile photo"
                  >
                    {coverUploading ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Camera size={15} color="#fff" strokeWidth={2} />
                    )}
                  </Pressable>
                ) : null}
              </View>
            </View>

            {/* RIGHT COLUMN — identity info */}
            <View style={s.rightCol}>
              <Text style={s.travelerLabel}>TRAVELER ★</Text>

              {/* Name row — verified stamp replaces CheckCircle2 */}
              <View style={s.nameRow}>
                <Text style={s.displayName} numberOfLines={1}>
                  {resolvedName.toUpperCase()}
                </Text>
                {isVerified ? <PassportVerifiedStamp /> : null}
              </View>

              {handleSubline ? (
                <Text style={s.handle}>{handleSubline}</Text>
              ) : null}

              {/* Trust Score — compact, inside identity area */}
              {trustScore != null ? (
                <TrustScoreBar score={trustScore} onPress={onTrustInfo} />
              ) : null}

              {/* Interests tags */}
              {interests.length > 0 ? (
                <View style={s.tagsRow}>
                  <Globe size={14} color={MUTED} strokeWidth={1.8} />
                  <Text style={s.tagsText} numberOfLines={1}>
                    {interests.join(' · ')}
                  </Text>
                </View>
              ) : null}

              {/* Location */}
              {locationLine ? (
                <View style={s.locationRow}>
                  <MapPin size={14} color={MUTED} strokeWidth={1.8} />
                  <Text style={s.locationText} numberOfLines={1}>{locationLine}</Text>
                </View>
              ) : null}

              {/* Owner: Saved shortcut */}
              {isOwner && onSavedPress ? (
                <View style={s.publicActions}>
                  <Pressable
                    style={s.savedPill}
                    onPress={onSavedPress}
                    hitSlop={8}
                    accessibilityLabel="Saved"
                    testID="saved-btn"
                  >
                    <Bookmark size={14} color={INK} strokeWidth={2} />
                    <Text style={s.savedPillText}>Saved</Text>
                  </Pressable>
                </View>
              ) : null}

              {/* Public: Follow pill */}
              {!isOwner ? (
                <View style={s.publicActions}>
                  <Pressable
                    style={[s.followPill, isFollowing && s.followPillActive]}
                    onPress={onFollowPress}
                    disabled={followLoading}
                    hitSlop={8}
                  >
                    {followLoading ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : isFollowing ? (
                      <>
                        <UserCheck size={14} color="#fff" strokeWidth={2} />
                        <Text style={s.followPillText}>Following</Text>
                      </>
                    ) : (
                      <>
                        <UserPlus size={14} color="#fff" strokeWidth={2} />
                        <Text style={s.followPillText}>Follow</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>

          {/* ── Passport stamp + Bio — lower area ──────────────── */}
          <View style={s.bioSection}>
            <View style={s.stampWrap}>
              <PortavaBrandStamp />
            </View>
            <View style={s.bioContent}>
              {bio ? (
                <Text style={s.bioText} numberOfLines={3}>{bio}</Text>
              ) : isOwner ? (
                <Pressable
                  style={s.addBioBtn}
                  onPress={onEditBio}
                  disabled={!onEditBio}
                  hitSlop={8}
                  accessibilityLabel="Add a bio"
                >
                  <PenLine size={13} color={MUTED} strokeWidth={1.8} />
                  <Text style={s.addBioText}>Add a bio</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

        </View>
      </View>
    </View>
  );
}

// ─── Card styles ──────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  // Edge-to-edge: no horizontal margins, no outer border-radius, no floating shadow.
  card: {
    backgroundColor: CREAM,
    overflow: 'hidden',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(184,151,78,0.22)',
  },
  cardInner: {
    flexDirection: 'row',
  },

  /* Spine */
  spine: {
    width: 28,
    backgroundColor: '#E8E0D0',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  spineTextWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spineText: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 2,
    color: MUTED,
    textTransform: 'uppercase',
    transform: [{ rotate: '-90deg' }],
    width: 200,
    textAlign: 'center',
  },
  spineIcon: {
    marginBottom: 4,
  },

  /* Body */
  body: {
    flex: 1,
    paddingTop: 10,
    paddingHorizontal: 10,
    paddingBottom: 14,
  },

  /* ⋯ menu button — absolute top-right */
  menuBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(28,28,26,0.1)',
    zIndex: 2,
  },

  columns: {
    flexDirection: 'row',
    gap: 8,
  },

  /* Left column — avatar only */
  leftCol: {
    alignItems: 'center',
    paddingTop: 4,
  },
  avatarOuter: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  goldRing: {
    borderRadius: (AVATAR_SIZE + 12) / 2,
    borderWidth: 2.5,
    borderColor: GOLD,
    padding: 2,
  },
  avatarPressable: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    overflow: 'hidden',
    backgroundColor: '#D8D2C8',
  },
  avatarImg: {
    width: '100%',
    height: '100%',
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontSize: 24,
    fontWeight: '500',
    color: PP.inkMuted,
  },
  cameraBtn: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: INK,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: CREAM,
  },

  /* Right column — paddingRight clears the absolute ⋯ menu button */
  rightCol: {
    flex: 1,
    gap: 4,
    paddingTop: 2,
    paddingRight: 44,
  },
  travelerLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    color: MUTED,
    textTransform: 'uppercase',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexWrap: 'nowrap',
  },
  displayName: {
    fontSize: 26,
    fontWeight: '800',
    color: INK,
    letterSpacing: -0.5,
    flexShrink: 1,
  },
  handle: {
    fontSize: 14,
    color: MUTED,
    fontWeight: '400',
    marginTop: -2,
  },

  /* Trust Score */
  trustCard: {
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: 'rgba(45,106,79,0.15)',
    gap: 4,
  },
  trustCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  trustCardLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: GREEN_STAMP,
    flex: 1,
  },
  trustCardScore: {
    fontSize: 13,
    fontWeight: '800',
    color: GREEN_STAMP,
  },
  trustCardTotal: {
    fontSize: 11,
    color: MUTED,
  },
  trustBarBg: {
    height: 4,
    backgroundColor: 'rgba(45,106,79,0.12)',
    borderRadius: 2,
  },
  trustBarFill: {
    height: 4,
    backgroundColor: GREEN_STAMP,
    borderRadius: 2,
  },

  /* Interests tags */
  tagsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  tagsText: {
    fontSize: 13,
    color: MUTED,
    flex: 1,
  },

  /* Location */
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  locationText: {
    fontSize: 13,
    color: MUTED,
    flex: 1,
  },

  /* Public follow */
  publicActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  followPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: INK,
  },
  followPillActive: {
    backgroundColor: '#0D9B6F',
  },
  followPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  },

  /* Owner: Saved shortcut pill */
  savedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: 'rgba(28,28,26,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(28,28,26,0.14)',
  },
  savedPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: INK,
  },

  /* ── Passport stamp + Bio — lower identity area ── */
  bioSection: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(184,151,78,0.25)',
  },
  stampWrap: {
    opacity: 0.72,
    marginTop: 2,
  },
  bioContent: {
    flex: 1,
    justifyContent: 'center',
  },
  bioText: {
    fontSize: 13,
    lineHeight: 19,
    color: INK,
    fontStyle: 'italic',
    opacity: 0.82,
  },
  addBioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  addBioText: {
    fontSize: 13,
    color: MUTED,
    fontWeight: '500',
  },
});

// ─── Stats row styles (separate section below the card) ───────────────────────

const st = StyleSheet.create({
  section: {
    backgroundColor: PP.paper,
    borderBottomWidth: 1,
    borderBottomColor: PP.borderLight,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  statTicket: {
    alignItems: 'center',
    gap: 2,
    minWidth: 44,
  },
  statIconBg: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  statN: {
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  statL: {
    fontSize: 11,
    color: MUTED,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  statUnderline: {
    height: 2,
    width: 18,
    borderRadius: 1,
    marginTop: 2,
  },
});
