/**
 * CrewMemberCard
 *
 * Renders a single crew member's privacy-safe location status card.
 * No exact coordinates are ever displayed; statusLabel drives the UI.
 *
 * When isBlockedByViewer=true, ALL location signals (Safe Return, live share,
 * area label, plan check-in) are withheld regardless of what the server sent.
 */
import React, { useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { UserIdentityLink } from '../interaction/UserIdentityLink.tsx';
import {
  Shield, MapPin, Navigation, Eye, EyeOff, Clock, CheckCircle2,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { CrewMemberCard as CrewMemberCardType, CrewStatusLabel } from '../../services/tripCrewLocation.ts';
import { UserOverflowMenu } from '../interaction/UserOverflowMenu.tsx';

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

function getStatusConfig(status: CrewStatusLabel, liveShareExpiresAt?: string | null): StatusConfig {
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

  const status = getStatusConfig(effectiveStatusLabel, isBlockedByViewer ? null : member.liveShareExpiresAt);

  return (
    <View style={s.card}>
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
        {member.avatarUrl ? (
          <Image source={{ uri: member.avatarUrl }} style={s.avatar} />
        ) : (
          <View style={[s.avatar, s.avatarFallback]}>
            <Text style={s.avatarInitial}>
              {(member.name?.[0] ?? member.handle?.[0] ?? '?').toUpperCase()}
            </Text>
          </View>
        )}
        {effectiveLiveShare && <View style={s.liveDot} />}
        {member.ghostMode && !isBlockedByViewer && <View style={s.ghostDot} />}
      </View>

      {/* Info */}
      <View style={s.body}>
        <Text style={s.name} numberOfLines={1}>{member.name ?? member.handle ?? 'Unknown'}</Text>
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
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.haze },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { ...t.small, fontWeight: '700', color: color.ink },
  liveDot: {
    position: 'absolute', right: -1, bottom: -1,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: color.signal, borderWidth: 2, borderColor: color.paperRaised,
  },
  ghostDot: {
    position: 'absolute', right: -1, bottom: -1,
    width: 12, height: 12, borderRadius: 6,
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
