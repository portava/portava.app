/**
 * PassportIdentityCard — Passport document header.
 * Premium cream/ivory document card with vertical spine, gold-ring avatar,
 * Trust Score, decorative stamps.
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
  Bookmark, UserCircle2, UserPlus, UserCheck, CheckCircle2,
  Briefcase, Users, Stamp,
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
}

const AVATAR_SIZE  = 76;
const GOLD         = '#B8974E';
const INK          = '#1C1C1A';
const MUTED        = '#8A7E6E';
const CREAM        = '#F5F0E8';
const GREEN_STAMP  = '#2D6A4F';

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

// ─── Decorative SVG stamps ────────────────────────────────────────────────────

function AdventureStamp() {
  return (
    <Svg width={70} height={70} viewBox="0 0 90 90">
      <Circle cx={45} cy={45} r={42} stroke="#3B82F6" strokeWidth={2.5} strokeDasharray="4 2" fill="none" />
      <Circle cx={45} cy={45} r={36} stroke="#3B82F6" strokeWidth={1.2} fill="none" />
      <SvgText x="45" y="21" textAnchor="middle" fill="#3B82F6" fontSize="6" fontWeight="700">ADVENTURE IS</SvgText>
      <SvgText x="45" y="73" textAnchor="middle" fill="#3B82F6" fontSize="6" fontWeight="700">WORTHWHILE</SvgText>
      {/* Plane silhouette */}
      <Path d="M26 50 L37 39 L40 42 L34 48 L47 51 L44 54 L31 51 L33 57 L30 59 Z" fill="#3B82F6" opacity={0.8} />
    </Svg>
  );
}

function PortavaStamp() {
  return (
    <Svg width={96} height={58} viewBox="0 0 110 72">
      <Rect x={2} y={2} width={106} height={68} rx={6} stroke={GOLD} strokeWidth={2} strokeDasharray="3 2" fill="none" />
      <Rect x={6} y={6} width={98} height={60} rx={4} stroke={GOLD} strokeWidth={1} fill="none" opacity={0.4} />
      <SvgText x="55" y="19" textAnchor="middle" fill={GOLD} fontSize="6.5" fontWeight="700">PORTAVA PASSPORT</SvgText>
      <Path d="M40 44 L50 34 L53 37 L47 43 L58 46 L55 49 L44 46 L46 52 L43 54 Z" fill={GOLD} opacity={0.65} />
      <SvgText x="55" y="61" textAnchor="middle" fill={GOLD} fontSize="6" fontWeight="700">★  EXPLORE MORE  ★</SvgText>
    </Svg>
  );
}

function ArrivalStamp() {
  return (
    <Svg width={70} height={44} viewBox="0 0 80 52">
      <Rect x={1} y={1} width={78} height={50} rx={4} stroke={GREEN_STAMP} strokeWidth={1.5} strokeDasharray="2 2" fill="none" />
      <SvgText x="40" y="14" textAnchor="middle" fill={GREEN_STAMP} fontSize="5" fontWeight="600">2858 · ARRIVE</SvgText>
      <SvgText x="40" y="30" textAnchor="middle" fill={GREEN_STAMP} fontSize="10" fontWeight="800">ARRIVAL</SvgText>
      <SvgText x="40" y="44" textAnchor="middle" fill={GREEN_STAMP} fontSize="5.5" fontWeight="600">PASSPORT STAMP</SvgText>
    </Svg>
  );
}

// ─── Trust Score bar ──────────────────────────────────────────────────────────

function TrustScoreBar({ score, onPress }: { score: number; onPress?: () => void }) {
  const pct = Math.min(100, Math.max(0, score));
  return (
    <Pressable style={s.trustCard} onPress={onPress} disabled={!onPress} hitSlop={8}>
      <View style={s.trustCardRow}>
        <ShieldCheck size={13} color={GREEN_STAMP} strokeWidth={2.5} />
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

// ─── Stat ticket with icon ────────────────────────────────────────────────────

export function StatTicket({ n, label, onPress }: StatItem) {
  const cfg = STAT_CFG[label] ?? STAT_FALLBACK;
  const { Icon, color, bg } = cfg;
  return (
    <Pressable style={st.statTicket} onPress={onPress} disabled={!onPress} hitSlop={6}>
      <View style={[st.statIconBg, { backgroundColor: bg }]}>
        <Icon size={16} color={color} strokeWidth={1.8} />
      </View>
      <Text style={[st.statN, { color }]}>{n}</Text>
      <Text style={st.statL}>{label}</Text>
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
}

export function PassportStatsRow({ profile, isOwner, overrideStats, onStatPress }: StatsRowProps) {
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
          <StatTicket key={item.label} {...item} />
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
}: Props) {
  const username      = 'username' in profile ? profile.username : null;
  const identity      = {
    displayName: 'displayName' in profile ? profile.displayName : null,
    name:        'name'        in profile ? profile.name        : null,
    username,
  };
  const resolvedName  = primaryIdentityText(identity);
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

          {/* Columns */}
          <View style={s.columns}>

            {/* LEFT COLUMN */}
            <View style={s.leftCol}>
              <View style={s.adventureStampWrap}><AdventureStamp /></View>

              {/* Avatar area */}
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
                      <Camera size={13} color="#fff" strokeWidth={2} />
                    )}
                  </Pressable>
                ) : null}
              </View>

              <View style={s.arrivalStampWrap}><ArrivalStamp /></View>
            </View>

            {/* RIGHT COLUMN */}
            <View style={s.rightCol}>
              <View style={s.portavaStampWrap}><PortavaStamp /></View>

              <Text style={s.travelerLabel}>TRAVELER ★</Text>

              <View style={s.nameRow}>
                <Text style={s.displayName} numberOfLines={1}>
                  {resolvedName.toUpperCase()}
                </Text>
                {isVerified ? (
                  <CheckCircle2 size={18} color="#2563EB" fill="#2563EB" strokeWidth={0} style={s.verifiedCheck} />
                ) : null}
              </View>

              {handleSubline ? (
                <Text style={s.handle}>{handleSubline}</Text>
              ) : null}

              {/* Trust Score — compact, inside identity area */}
              {trustScore != null ? (
                <TrustScoreBar score={trustScore} onPress={onTrustInfo} />
              ) : null}

              {/* Verified pill */}
              {isVerified ? (
                <View style={s.verifiedPill}>
                  <CheckCircle2 size={11} color="#2563EB" fill="#2563EB" strokeWidth={0} />
                  <Text style={s.verifiedPillText}>Verified</Text>
                </View>
              ) : null}

              {/* Interests tags */}
              {interests.length > 0 ? (
                <View style={s.tagsRow}>
                  <Globe size={12} color={MUTED} strokeWidth={1.8} />
                  <Text style={s.tagsText} numberOfLines={1}>
                    {interests.join(' · ')}
                  </Text>
                </View>
              ) : null}

              {/* Location */}
              {locationLine ? (
                <View style={s.locationRow}>
                  <MapPin size={12} color={MUTED} strokeWidth={1.8} />
                  <Text style={s.locationText} numberOfLines={1}>{locationLine}</Text>
                </View>
              ) : null}

              {/* Owner actions */}
              {isOwner ? (
                <View style={s.ownerActions}>
                  <Pressable style={s.actionCard} onPress={() => {}} hitSlop={8} accessibilityLabel="Saved">
                    <Bookmark size={15} color={INK} strokeWidth={1.8} />
                    <Text style={s.actionCardText}>Saved</Text>
                  </Pressable>
                  <Pressable style={s.actionCard} onPress={onMenuPress} hitSlop={8} accessibilityLabel="Edit Profile">
                    <UserCircle2 size={15} color={INK} strokeWidth={1.8} />
                    <Text style={s.actionCardText}>Edit Profile</Text>
                  </Pressable>
                </View>
              ) : (
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
                        <UserCheck size={13} color="#fff" strokeWidth={2} />
                        <Text style={s.followPillText}>Following</Text>
                      </>
                    ) : (
                      <>
                        <UserPlus size={13} color="#fff" strokeWidth={2} />
                        <Text style={s.followPillText}>Follow</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              )}
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
  // Internal content retains its own padding.
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
    paddingBottom: 12,
  },
  columns: {
    flexDirection: 'row',
    gap: 8,
  },

  /* Left column */
  leftCol: {
    alignItems: 'center',
    gap: 8,
    paddingTop: 4,
  },
  adventureStampWrap: {
    opacity: 0.9,
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
  arrivalStampWrap: {
    opacity: 0.9,
    marginTop: 4,
  },

  /* Right column */
  rightCol: {
    flex: 1,
    gap: 4,
    paddingTop: 2,
  },
  portavaStampWrap: {
    alignSelf: 'flex-end',
    opacity: 0.85,
    marginBottom: 2,
  },
  travelerLabel: {
    fontSize: 8,
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
    fontSize: 22,
    fontWeight: '800',
    color: INK,
    letterSpacing: -0.5,
    flexShrink: 1,
  },
  verifiedCheck: {
    flexShrink: 0,
  },
  handle: {
    fontSize: 13,
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
    fontSize: 8,
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
    fontSize: 10,
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

  /* Verified pill */
  verifiedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: '#EFF6FF',
    borderRadius: 20,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  verifiedPillText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#2563EB',
  },

  /* Interests tags */
  tagsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  tagsText: {
    fontSize: 11,
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
    fontSize: 11,
    color: MUTED,
    flex: 1,
  },

  /* Owner actions */
  ownerActions: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  actionCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 7,
    paddingHorizontal: 6,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(28,28,26,0.12)',
  },
  actionCardText: {
    fontSize: 11,
    fontWeight: '600',
    color: INK,
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
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
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
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  statN: {
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  statL: {
    fontSize: 9,
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
