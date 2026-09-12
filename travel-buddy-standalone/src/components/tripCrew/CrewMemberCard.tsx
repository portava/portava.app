/**
 * CrewMemberCard
 *
 * Renders a single crew member's privacy-safe location status card.
 * No exact coordinates are ever displayed; statusLabel drives the UI.
 *
 * When isBlockedByViewer=true, ALL location signals (Safe Return, live share,
 * area label, plan check-in) are withheld regardless of what the server sent.
 *
 * FRESHNESS IS THE SERVER'S VERDICT, AND THE CARD SAYS IT (Trips spec §10.2).
 * `statusLabel === 'live_sharing_active'` is a fact about the GRANT — the
 * member chose to share with you for a while — not about the position. Until
 * census-trips §58 this card wrote "Live" from the grant alone, so a share over
 * a three-hour-old fix read exactly like one over a fix from a minute ago. Now
 * the badge says "Live" only when the server's `freshnessClass` is LIVE /
 * RECENT; a grant over a LAST_KNOWN / OFFLINE position reads "Sharing · last
 * known", the presence line carries the class and its age, and the row's
 * accessibility label speaks the same words (features/trips/crew/presence.ts).
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Avatar } from '../ui/Avatar.tsx';
import { UserIdentityLink } from '../interaction/UserIdentityLink.tsx';
import {
  Shield, MapPin, Navigation, Eye, EyeOff, Clock, CheckCircle2,
} from 'lucide-react-native';
import { color, space, radius, type as t, dot} from '../../theme/tokens.ts';
import type { CrewMemberCard as CrewMemberCardType, CrewStatusLabel } from '../../services/tripCrewLocation.ts';
import { UserOverflowMenu } from '../interaction/UserOverflowMenu.tsx';
import { presenceAccessibleLabel, presenceIsCurrent, presenceLine } from '../../features/trips/crew/presence.ts';

interface Props {
  member: CrewMemberCardType;
  isBlockedByViewer?: boolean;
  onBlockSuccess?: (userId: string) => void;
}

type StatusConfig = {
  label: string;
  color: string;
  icon: React.ReactNode;
};

function getStatusConfig(status: CrewStatusLabel, liveShareExpiresAt?: string | null, positionIsCurrent = false): StatusConfig {
  switch (status) {
    case 'location_hidden':
      return { label: 'Location hidden', color: color.mute, icon: <EyeOff size={12} color={color.mute} /> };
    case 'not_shared':
      return { label: 'Not sharing', color: color.faint, icon: <EyeOff size={12} color={color.faint} /> };
    case 'city_only':
      return { label: 'City only', color: color.mute, icon: <MapPin size={12} color={color.mute} /> };
    case 'neighborhood':
      return { label: 'Neighborhood', color: color.deep, icon: <MapPin size={12} color={color.deep} /> };
    case 'nearby':
      return { label: 'Nearby', color: color.deep, icon: <Navigation size={12} color={color.deep} /> };
    case 'arrived':
      return { label: 'Arrived', color: color.success, icon: <CheckCircle2 size={12} color={color.success} /> };
    case 'safe_return_active':
      return { label: 'Safe Return on', color: '#7A4DBF', icon: <Shield size={12} color="#7A4DBF" /> };
    case 'live_sharing_active': {
      const expiry = liveShareExpiresAt ? formatExpiry(liveShareExpiresAt) : null;
      // §10.2: the grant is active; whether the POSITION is current is the
      // server's call. Without it, "Live" is a claim this card cannot make.
      if (!positionIsCurrent) {
        return {
          label: expiry ? `Sharing · last known · ${expiry}` : 'Sharing · last known',
          color: color.mute,
          icon: <Navigation size={12} color={color.mute} />,
        };
      }
      return {
        label: expiry ? `Live · ${expiry}` : 'Live sharing',
        color: color.signal,
        icon: <Navigation size={12} color={color.signal} />,
      };
    }
    default:
      return { label: 'Unknown', color: color.faint, icon: <MapPin size={12} color={color.faint} /> };
  }
}

function formatExpiry(iso: string): string | null {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return null;
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `${mins}m left`;
  return `${Math.ceil(mins / 60)}h left`;
}

export function CrewMemberCard({ member, isBlockedByViewer = false, onBlockSuccess }: Props) {
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  const effectiveStatusLabel: CrewStatusLabel = isBlockedByViewer ? 'location_hidden' : member.statusLabel;
  const effectiveLiveShare = isBlockedByViewer ? false : member.liveShareActive;
  const effectiveSafeReturn = isBlockedByViewer ? false : member.safeReturnActive;
  const effectiveAreaLabel = isBlockedByViewer ? null : member.areaLabel;
  const effectivePlanCheckIn = isBlockedByViewer ? null : member.planCheckInStatus;

  const positionIsCurrent = !isBlockedByViewer && presenceIsCurrent(member);
  const status = getStatusConfig(effectiveStatusLabel, isBlockedByViewer ? null : member.liveShareExpiresAt, positionIsCurrent);
  const displayName = member.name ?? member.handle ?? 'Unknown';
  // Shown only while the member shares something and the server judged the
  // position; a hidden or blocked member has no position line to speak of.
  const showPresence = !isBlockedByViewer && effectiveStatusLabel !== 'location_hidden' && effectiveStatusLabel !== 'not_shared';
  const line = showPresence ? presenceLine(member) : null;
  const lineColor = !positionIsCurrent ? color.mute : member.freshnessClass === 'LIVE' ? color.signal : color.deep;
  const a11y = showPresence
    ? `${presenceAccessibleLabel(displayName, member)}, ${status.label}`
    : `${displayName}, ${status.label}`;

  return (
    <View style={s.card} accessible accessibilityLabel={a11y} testID={`crew-member-card-${member.userId ?? 'unknown'}`}>
      {/* Avatar + Name — tappable identity area.
          style preserves the card's horizontal row layout (Pressable defaults
          to column, which would stack avatar on top of name). */}
      <UserIdentityLink
        userId={member.userId ?? ''}
        handle={member.handle ?? null}
        style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 12 }}
        testID={`crew-member-identity-${member.userId ?? 'unknown'}`}
      >
      <View style={s.avatarWrap}>
        <Avatar uri={member.avatarUrl} name={member.name ?? member.handle} size={40} />
        {effectiveLiveShare && positionIsCurrent && <View style={s.liveDot} testID="crew-member-live-dot" />}
        {member.ghostMode && !isBlockedByViewer && <View style={s.ghostDot} />}
      </View>

      {/* Info */}
      <View style={s.body}>
        <Text style={s.name} numberOfLines={1}>{displayName}</Text>
        {line ? (
          <View style={s.areaRow}>
            <Clock size={11} color={lineColor} />
            <Text style={[s.areaLabel, { color: lineColor }]} testID="crew-member-presence-line">{line}</Text>
          </View>
        ) : null}
        {effectiveAreaLabel ? (
          <View style={s.areaRow}>
            <MapPin size={11} color={color.mute} />
            <Text style={s.areaLabel} numberOfLines={1}>{effectiveAreaLabel}</Text>
          </View>
        ) : null}
        {effectivePlanCheckIn ? (
          <View style={s.areaRow}>
            <CheckCircle2 size={11} color={color.success} />
            <Text style={[s.areaLabel, { color: color.success }]}>
              {effectivePlanCheckIn === 'arrived' ? 'Arrived at plan' : effectivePlanCheckIn}
            </Text>
          </View>
        ) : null}
        {effectiveSafeReturn ? (
          <View style={s.areaRow}>
            <Shield size={11} color="#7A4DBF" />
            <Text style={[s.areaLabel, { color: '#7A4DBF' }]}>Safe Return active</Text>
          </View>
        ) : null}
      </View>
      </UserIdentityLink>

      {/* Status badge */}
      <View style={[s.badge, { borderColor: status.color + '33', backgroundColor: status.color + '11' }]}>
        {status.icon}
        <Text style={[s.badgeText, { color: status.color }]}>{status.label}</Text>
      </View>

      {/* Overflow menu — hidden when already blocked */}
      {member.userId && !isBlockedByViewer && (
        <UserOverflowMenu
          userId={member.userId}
          displayName={member.name ?? member.handle ?? 'Crew member'}
          onBlockSuccess={(uid) => { setHidden(true); onBlockSuccess?.(uid); }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  avatarWrap: { position: 'relative' },
  liveDot: {
    position: 'absolute', right: -1, bottom: -1,
    width: dot.s12, height: dot.s12, borderRadius: dot.s12 / 2,
    backgroundColor: color.signal, borderWidth: 2, borderColor: color.paperRaised,
  },
  ghostDot: {
    position: 'absolute', right: -1, bottom: -1,
    width: dot.s12, height: dot.s12, borderRadius: dot.s12 / 2,
    backgroundColor: color.mute, borderWidth: 2, borderColor: color.paperRaised,
  },
  body: { flex: 1, minWidth: 0 },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  areaRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  areaLabel: { ...t.small, color: color.mute, fontSize: 11 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: radius.pill, borderWidth: 1,
    maxWidth: 130,
  },
  badgeText: { ...t.small, fontWeight: '700', fontSize: 11 },
});
