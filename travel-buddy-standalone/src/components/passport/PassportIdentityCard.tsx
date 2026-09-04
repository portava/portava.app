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
  View, Text, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg';
import {
  ShieldCheck, Globe, MapPin, Camera,
  UserPlus, UserCheck, MoreHorizontal,
  Briefcase, Users, Stamp, PenLine, MessageCircle, CalendarPlus,
} from 'lucide-react-native';
import type { OwnProfile, PublicProfile } from '../../types/models.ts';
import { resolveAvatarUrl, fallbackInitials, truncateDisplayName } from '../../utils/identity.ts';
import { primaryIdentityText, secondaryIdentityText } from '../../lib/displayIdentity.ts';
import { AvatarImage } from '../ui/DisplayMediaImage.tsx';
import { isTravelBuddyVerified } from '../../lib/verification.ts';
import { VerifiedStamp } from '../ui/VerifiedStamp.tsx';
import { OfficialBadge } from '../OfficialBadge.tsx';
import { HighlightRing } from '../HighlightRing.tsx';
import { getPassportStats } from '../../services/passportStamps.ts';
import type { PassportStats } from '../../services/passportStamps.ts';
import { PP } from '../../theme/passportTokens.ts';
import { AvailabilityChip } from './AvailabilityChip.tsx';
import type { AvailabilityChipState } from '../../lib/availabilityChip.ts';
import { TravelerStateChip } from './TravelerStateChip.tsx';
import type { TravelerStateView } from '../../services/passportProjection.ts';
import { avatar } from '../../theme/tokens.ts';

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
  /** Public profile: opens/starts a Telegraph DM with this user. Hidden when not provided. */
  onMessagePress?: () => void;
  /** Owner: tap "Add a bio" empty state → navigate to edit profile */
  onEditBio?: () => void;
  /** Owner: primary Edit Profile button at the bottom of the card */
  onEditProfile?: () => void;
  /** Deprecated: Saved moved to the ⋯ menu; prop kept optional for
      backward compatibility with existing call sites. */
  onSavedPress?: () => void;
  /** Distinct countries visited — powers the faded WORLD TRAVELER stamp
      (shown at 5+). Owner: passport stats; public: derived from postcards. */
  countriesVisited?: number | null;
  /**
   * LEGACY chip state from resolveAvailabilityChip(); null = hide chip.
   * Ignored whenever `travelerState` is supplied (see below).
   */
  availabilityChip?: AvailabilityChipState | null;
  /** Called when the legacy chip is pressed. */
  onAvailabilityChipPress?: () => void;
  /**
   * §5 Current Traveler State from the SERVER projection
   * (`projection.travelerState`). When this prop is present — even as null —
   * the card renders the TravelerStateChip and never the legacy
   * AvailabilityStore-derived chip, so a screen that has the projection cannot
   * accidentally show both or fall back to client-derived policy (§4/§30).
   * `undefined` (prop omitted) keeps the legacy chip for callers without a
   * projection.
   */
  travelerState?: TravelerStateView | null;
  /** Owner: opens the ONE availability editor (F6). Viewer: read-only status. */
  onTravelerStatePress?: () => void;
  /**
   * Viewer: "Invite to trip" (§3 / TABLE 29 `can_invite_trip`). Rendered only
   * when provided — the screen resolves the capability from the projection and
   * omits the handler when the server says no (§30).
   */
  onInviteTripPress?: () => void;
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

// PassportVerifiedStamp removed — use shared VerifiedStamp component instead.

// ─── Trust Score bar ──────────────────────────────────────────────────────────

function TrustScoreBar({
  score,
  label,
  onPress,
}: {
  score: number | null;
  /**
   * Server-projected qualitative label (§9/§10 — "Strong", "New Traveler ·
   * Verified"). A viewer's projection carries the label but usually NOT the
   * number (the score is exposed only where the server chose to, §9), so the
   * label is what is rendered when `score` is null. Verbatim: the client
   * never re-derives a standing from a number (§11).
   */
  label?: string | null;
  onPress?: () => void;
}) {
  // null score + no label = account has no trust score yet — still show the
  // pill (honest empty state) so the trust system is always visible on the
  // owner's passport.
  const pct = score != null ? Math.min(100, Math.max(0, score)) : 0;
  return (
    <Pressable
      style={s.trustCard}
      onPress={onPress}
      disabled={!onPress}
      hitSlop={8}
      testID="passport-trust-bar"
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={
        score != null ? `Trust score ${Math.round(score)} of 100` : label ? `Trust: ${label}` : 'Trust score not yet rated'
      }
    >
      <View style={s.trustCardRow}>
        <ShieldCheck size={14} color={GREEN_STAMP} strokeWidth={2.5} />
        <Text style={s.trustCardLabel}>{score != null ? 'TRUST SCORE' : 'TRUST'}</Text>
        {score != null ? (
          <>
            <Text style={s.trustCardScore}>{Math.round(score)}</Text>
            <Text style={s.trustCardTotal}>/100</Text>
          </>
        ) : label ? (
          <Text style={s.trustCardScore} numberOfLines={1} testID="passport-trust-label">{label}</Text>
        ) : (
          <Text style={s.trustCardTotal}>Not yet rated</Text>
        )}
      </View>
      {score != null ? (
        <View style={s.trustBarBg}>
          <View style={[s.trustBarFill, { width: `${pct}%` as any }]} />
        </View>
      ) : null}
    </Pressable>
  );
}

// ─── World Traveler achievement stamp ─────────────────────────────────────────
// Faded rotated ink stamp, earned at 5+ countries. Watermark only —
// pointerEvents none, never blocks the controls beneath it.

export const WORLD_TRAVELER_MIN_COUNTRIES = 5;

function WorldTravelerStamp() {
  return (
    <View style={s.worldStamp} pointerEvents="none" accessibilityLabel="World Traveler stamp — 5 or more countries visited">
      <Svg width={78} height={78} viewBox="0 0 80 80">
        <Circle cx={40} cy={40} r={37} stroke={GREEN_STAMP} strokeWidth={2.5} strokeDasharray="4 2" fill="none" />
        <Circle cx={40} cy={40} r={29.5} stroke={GREEN_STAMP} strokeWidth={1} fill="none" opacity={0.7} />
        <SvgText x="40" y="27" textAnchor="middle" fill={GREEN_STAMP} fontSize="8" fontWeight="800" letterSpacing="1">★ WORLD ★</SvgText>
        <Circle cx={40} cy={39} r={8} stroke={GREEN_STAMP} strokeWidth={1.4} fill="none" />
        <Path d="M32 39 H48" stroke={GREEN_STAMP} strokeWidth={1.1} />
        <Path d="M40 31 C36.5 34.5 36.5 43.5 40 47 C43.5 43.5 43.5 34.5 40 31 Z" stroke={GREEN_STAMP} strokeWidth={1.1} fill="none" />
        <SvgText x="40" y="59" textAnchor="middle" fill={GREEN_STAMP} fontSize="8" fontWeight="800" letterSpacing="1">TRAVELER</SvgText>
        <SvgText x="40" y="68" textAnchor="middle" fill={GREEN_STAMP} fontSize="5.5" fontWeight="700" letterSpacing="0.5">5+ COUNTRIES</SvgText>
      </Svg>
    </View>
  );
}

// ─── Stat ticket ──────────────────────────────────────────────────────────────
// iconOnly=true  → icon bg + number, no label text  (scrolled / compact)
// iconOnly=false → label text + number, no icon bg  (expanded, default)

export function StatTicket({ n, label, onPress, iconOnly, loading }: StatItem & { iconOnly?: boolean; loading?: boolean }) {
  const cfg = STAT_CFG[label] ?? STAT_FALLBACK;
  const { Icon, color, bg } = cfg;
  return (
    <Pressable style={st.statTicket} onPress={onPress} disabled={!onPress} hitSlop={6}>
      {iconOnly ? (
        <View style={[st.statIconBg, { backgroundColor: bg }]}>
          <Icon size={18} color={color} strokeWidth={1.8} />
        </View>
      ) : null}
      {loading ? (
        <View testID={`passport-stat-skeleton-${label}`} style={st.statSkeleton} />
      ) : (
        <Text style={[st.statN, { color }]}>{n}</Text>
      )}
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
  /** Reports loaded owner stats up to the screen (e.g. for the World
      Traveler stamp) — avoids a duplicate getPassportStats call. */
  onStatsLoaded?: (stats: PassportStats) => void;
}

export function PassportStatsRow({ profile, isOwner, overrideStats, onStatPress, iconOnly, onStatsLoaded }: StatsRowProps) {
  const onStatsLoadedRef = React.useRef(onStatsLoaded);
  onStatsLoadedRef.current = onStatsLoaded;
  const [liveStats, setLiveStats] = useState<PassportStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(isOwner);

  useEffect(() => {
    if (!isOwner) {
      setStatsLoading(false);
      return;
    }
    setStatsLoading(true);
    getPassportStats()
      .then((res) => {
        if (res.ok) {
          setLiveStats(res.data);
          onStatsLoadedRef.current?.(res.data);
        }
      })
      .catch(() => {})
      .finally(() => setStatsLoading(false));
  }, [isOwner]);

  // liveStats (from getPassportStats) is the authoritative source for all counts
  // when isOwner — it includes tripCount/followersCount/followingCount as of the
  // same fetch that returns stamp/country stats, avoiding a separate profile call.
  // Fall back to the profile prop values (populated from /api/me/profile) in case
  // the stats fetch hasn't resolved yet or the flag is disabled (returns 0).
  const ownStats: StatItem[] = [
    { n: formatStatN(liveStats?.tripCount      ?? ('tripCount'      in profile ? (profile.tripCount      ?? 0) : 0)), label: 'Trips',     onPress: () => onStatPress?.('Trips')     },
    { n: formatStatN(liveStats?.followersCount ?? ('followersCount' in profile ? (profile.followersCount ?? 0) : 0)), label: 'Followers', onPress: () => onStatPress?.('Followers') },
    { n: formatStatN(liveStats?.followingCount ?? ('followingCount' in profile ? (profile.followingCount ?? 0) : 0)), label: 'Following', onPress: () => onStatPress?.('Following') },
    { n: liveStats?.countries    ?? 0,                                                                                 label: 'Countries', onPress: () => onStatPress?.('Countries') },
    { n: liveStats?.totalStamps  ?? 0,                                                                                 label: 'Stamps',    onPress: () => onStatPress?.('Stamps')    },
  ];
  const stats = overrideStats ?? ownStats;
  const showStatsLoading = isOwner && !overrideStats && statsLoading;

  return (
    <View style={st.section}>
      <View style={st.statsRow}>
        {stats.map((item) => (
          <StatTicket key={item.label} {...item} iconOnly={iconOnly} loading={showStatsLoading} />
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
  isFollowing, followLoading, onFollowPress, onMessagePress,
  onEditBio, onEditProfile, onSavedPress, countriesVisited,
  availabilityChip, onAvailabilityChipPress,
  travelerState, onTravelerStatePress, onInviteTripPress,
}: Props) {
  const username      = 'username' in profile ? profile.username : null;
  const identity      = {
    displayName: 'displayName' in profile ? profile.displayName : null,
    name:        'name'        in profile ? profile.name        : null,
    username,
  };
  // Cap at the 30-char display-name limit — legacy accounts created before
  // the limit may still have longer names stored in the DB.
  const resolvedName  = truncateDisplayName(primaryIdentityText(identity));
  const handleSubline = secondaryIdentityText(identity);
  const avatarUrl     = resolveAvatarUrl(profile.avatarUrl);
  const initials      = fallbackInitials(profile);
  const isVerified    = isTravelBuddyVerified(profile);
  const isOfficial    = (profile as { isOfficial?: boolean }).isOfficial === true;

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

          {/* ── World Traveler stamp — faded watermark, earned at 5+ countries ── */}
          {(countriesVisited ?? 0) >= WORLD_TRAVELER_MIN_COUNTRIES ? (
            <WorldTravelerStamp />
          ) : null}

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
                      <AvatarImage
                        uri={avatarUrl}
                        user={profile}
                        size={AVATAR_SIZE}
                        style={s.avatarImg}
                      />
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

              {/* Name row — verified stamp replaces CheckCircle2.
                  Mixed case per the approved identity design. */}
              <View style={s.nameRow}>
                <Text style={s.displayName} numberOfLines={1}>
                  {resolvedName}
                </Text>
                {isOfficial ? <OfficialBadge size="md" /> : isVerified ? <VerifiedStamp size="md" /> : null}
              </View>

              {handleSubline ? (
                <Text style={s.handle}>{handleSubline}</Text>
              ) : null}

              {/* §5 Current traveler state — below handle, above trust/tags/actions.
                  When the screen has the server projection it passes
                  `travelerState` (possibly null) and ONLY the projection chip
                  renders; the legacy AvailabilityStore-derived chip is reserved
                  for callers with no projection at all. */}
              {travelerState !== undefined ? (
                <TravelerStateChip state={travelerState} onPress={onTravelerStatePress} />
              ) : (
                <AvailabilityChip
                  chipState={availabilityChip ?? null}
                  onPress={onAvailabilityChipPress}
                />
              )}

              {/* Trust — compact, inside identity area (§3 "concise score/label
                  with drill-down"). Always visible for the owner (honest "Not
                  yet rated" state); for a viewer it renders whatever the server
                  projected: the number where permitted, else the label. */}
              {trustScore != null || !!trustLabel || isOwner ? (
                <TrustScoreBar score={trustScore ?? null} label={trustLabel ?? null} onPress={onTrustInfo} />
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

              {/* Saved shortcut removed from the header — Saved stays
                  reachable via the ⋯ menu (OwnerActionMenu), so no
                  functionality is lost. */}

              {/* Viewer actions (§3 "Follow, Make a Plan, Message, More"). Each
                  pill is INDEPENDENTLY gated on its own handler, and the screen
                  supplies a handler only when the server projection's
                  capabilities.actions permits it (F7 / §30). A private profile's
                  PrivateProfileWall owns the CTA, so it passes none of these. */}
              {!isOwner && (onFollowPress !== undefined || !!onMessagePress || !!onInviteTripPress) ? (
                <View style={s.publicActions}>
                  {onFollowPress !== undefined ? (
                    <Pressable
                      style={[s.followPill, isFollowing && s.followPillActive]}
                      onPress={onFollowPress}
                      disabled={followLoading}
                      hitSlop={8}
                      testID="passport-follow-pill"
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
                  ) : null}
                  {onMessagePress ? (
                    <Pressable
                      style={s.messagePill}
                      onPress={onMessagePress}
                      hitSlop={8}
                      accessibilityLabel="Message"
                      testID="passport-message-pill"
                    >
                      <MessageCircle size={14} color={PP.ink} strokeWidth={2} />
                      <Text style={s.messagePillText}>Message</Text>
                    </Pressable>
                  ) : null}
                  {onInviteTripPress ? (
                    <Pressable
                      style={s.messagePill}
                      onPress={onInviteTripPress}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Invite to trip"
                      testID="passport-invite-trip-pill"
                    >
                      <CalendarPlus size={14} color={PP.ink} strokeWidth={2} />
                      <Text style={s.messagePillText}>Invite to trip</Text>
                    </Pressable>
                  ) : null}
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

          {/* ── Owner: primary Edit Profile action (approved design) ── */}
          {isOwner && onEditProfile ? (
            <Pressable
              style={s.editProfileBtn}
              onPress={onEditProfile}
              accessibilityRole="button"
              accessibilityLabel="Edit Profile"
            >
              <PenLine size={14} color={CREAM} strokeWidth={2} />
              <Text style={s.editProfileText}>Edit Profile</Text>
            </Pressable>
          ) : null}

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
    width: avatar.s34, height: avatar.s34,
    borderRadius: avatar.s34 / 2,
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
    // Vertically center the avatar against the identity info column.
    alignItems: 'center',
  },

  /* Left column — avatar only */
  leftCol: {
    alignItems: 'center',
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
    width: avatar.s28, height: avatar.s28,
    borderRadius: avatar.s28 / 2,
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
    flexWrap: 'wrap',
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
  messagePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: PP.ink,
  },
  messagePillText: {
    fontSize: 13,
    fontWeight: '600',
    color: PP.ink,
  },
  followPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
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

  /* World Traveler faded stamp — watermark behind content */
  worldStamp: {
    position: 'absolute',
    top: 40,
    right: 12,
    opacity: 0.3,
    transform: [{ rotate: '-14deg' }],
    zIndex: 0,
  },

  /* Owner: primary Edit Profile button */
  editProfileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    marginTop: 12,
    borderRadius: 10,
    backgroundColor: INK,
  },
  editProfileText: {
    fontSize: 14,
    fontWeight: '700',
    color: CREAM,
  },
});

// ─── Stats row styles (separate section below the card) ───────────────────────

const st = StyleSheet.create({
  // Stats as a separate "ticket" card per the approved design.
  section: {
    marginHorizontal: 12,
    marginTop: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PP.borderLight,
    backgroundColor: PP.paper,
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
  statSkeleton: {
    width: 30,
    height: 20,
    borderRadius: 5,
    backgroundColor: '#E7E1D8',
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
