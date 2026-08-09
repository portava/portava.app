import React from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet,
} from 'react-native';
import { ShieldCheck, Plane } from 'lucide-react-native';
import { color, space, radius, avatar, icon } from '../theme/tokens.ts';
import type { PassportStamp } from '../types/models.ts';
import { VERIFY_TEAL, VERIFY_TEAL_BG } from './PassportVerificationStamp.tsx';

interface Props {
  stamps: PassportStamp[];
  remainingCount?: number;
  isVerified?: boolean;
  verifiedSince?: string | null;
  isOwner?: boolean;
  onViewAll?: () => void;
  onStampPress?: (stamp: PassportStamp) => void;
  onVerificationStampPress?: () => void;
}

function fmtEarned(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
  } catch {
    return '';
  }
}

function stampBgColor(kind: PassportStamp['kind']): string {
  switch (kind) {
    case 'city':   return '#0A3D4A';
    case 'plan':   return '#1A2A4A';
    case 'gem':    return '#2A1A3A';
    case 'safe':   return '#0A3A2A';
    case 'host':   return '#3A2A0A';
    case 'perk':   return '#3A0A1A';
    default:       return '#1A1A2A';
  }
}

function MiniVerificationCard({ verifiedSince, onPress }: {
  verifiedSince?: string | null;
  onPress?: () => void;
}) {
  return (
    <Pressable
      style={vs.card}
      onPress={onPress}
      accessibilityLabel="Verified Traveler stamp"
    >
      <View style={vs.iconWrap}>
        <ShieldCheck size={24} color={VERIFY_TEAL} strokeWidth={2} />
      </View>
      <Text style={vs.title}>VERIFIED{'\n'}TRAVELER</Text>
      <Text style={vs.stars}>★★★★★</Text>
      {verifiedSince ? (
        <Text style={vs.since}>{fmtEarned(verifiedSince)}</Text>
      ) : null}
    </Pressable>
  );
}

function DestinationCard({ stamp, onPress }: {
  stamp: PassportStamp;
  onPress?: () => void;
}) {
  const bg = stampBgColor(stamp.kind);
  return (
    <Pressable
      style={[dc.card, { backgroundColor: bg }]}
      onPress={onPress}
      accessibilityLabel={stamp.label + ' stamp'}
    >
      <Text style={dc.label} numberOfLines={2}>{stamp.label}</Text>
      <View style={dc.artwork}>
        <View style={dc.innerRing} />
      </View>
      <Text style={dc.date}>{fmtEarned(stamp.earnedAt)}</Text>
    </Pressable>
  );
}

function CollectCard({ remaining }: { remaining: number }) {
  return (
    <View style={cc.card}>
      <Plane size={22} color={color.mute} />
      <Text style={cc.count}>{remaining}</Text>
      <Text style={cc.label}>stamps to{'\n'}collect</Text>
    </View>
  );
}

export function PassportStampsRail({
  stamps, remainingCount, isVerified, verifiedSince,
  onViewAll, onStampPress, onVerificationStampPress,
}: Props) {
  const visibleStamps = stamps.filter((s) => !s.locked).slice(0, 6);
  const remaining = remainingCount ?? stamps.filter((s) => s.locked).length;

  return (
    <View style={st.section}>
      <View style={st.header}>
        <Text style={st.sectionTitle}>My Stamps</Text>
        {onViewAll ? (
          <Pressable onPress={onViewAll} hitSlop={8} accessibilityLabel="View all stamps">
            <Text style={st.viewAll}>View all</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={st.rail}
      >
        {isVerified ? (
          <MiniVerificationCard
            verifiedSince={verifiedSince}
            onPress={onVerificationStampPress}
          />
        ) : null}
        {visibleStamps.map((stamp) => (
          <DestinationCard
            key={stamp.id}
            stamp={stamp}
            onPress={() => onStampPress?.(stamp)}
          />
        ))}
        {remaining > 0 ? (
          <CollectCard remaining={remaining} />
        ) : null}
        {!isVerified && visibleStamps.length === 0 ? (
          <View style={st.empty}>
            <Text style={st.emptyText}>Collect stamps by visiting places, joining plans, and getting verified.</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const CARD_HEIGHT = 116;
const CARD_WIDTH = 80;

const st = StyleSheet.create({
  section: {
    marginTop: space.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    marginBottom: space.md,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: color.ink,
    letterSpacing: -0.3,
  },
  viewAll: {
    fontSize: 13,
    fontWeight: '600',
    color: VERIFY_TEAL,
  },
  rail: {
    paddingLeft: space.lg,
    paddingRight: space.lg,
    gap: space.sm,
    alignItems: 'center',
  },
  empty: {
    width: 200,
    height: CARD_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: space.md,
  },
  emptyText: {
    fontSize: 12,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 17,
  },
});

const vs = StyleSheet.create({
  card: {
    width: CARD_WIDTH + 8,
    height: CARD_HEIGHT + 4,
    borderRadius: radius.md,
    backgroundColor: VERIFY_TEAL_BG,
    borderWidth: 1.5,
    borderColor: VERIFY_TEAL,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
  iconWrap: {
    width: avatar.md, height: avatar.md,
    borderRadius: avatar.md / 2,
    backgroundColor: 'rgba(13,155,111,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: 'Courier',
    fontSize: 8,
    fontWeight: '800',
    color: VERIFY_TEAL,
    textAlign: 'center',
    letterSpacing: 0.5,
    lineHeight: 11,
  },
  stars: {
    fontSize: 10,
    color: VERIFY_TEAL,
    letterSpacing: 1,
  },
  since: {
    fontFamily: 'Courier',
    fontSize: 7,
    color: 'rgba(13,155,111,0.7)',
    letterSpacing: 0.4,
  },
});

const dc = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  label: {
    fontFamily: 'Courier',
    fontSize: 9,
    fontWeight: '800',
    color: '#FAF9F6',
    textAlign: 'center',
    letterSpacing: 0.6,
    lineHeight: 12,
  },
  artwork: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  innerRing: {
    width: icon.xl, height: icon.xl,
    borderRadius: icon.xl / 2,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  date: {
    fontFamily: 'Courier',
    fontSize: 7,
    color: 'rgba(250,249,246,0.55)',
    textAlign: 'center',
    letterSpacing: 0.3,
  },
});

const cc = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.haze,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  count: {
    fontSize: 20,
    fontWeight: '800',
    color: color.mute,
    letterSpacing: -0.5,
  },
  label: {
    fontFamily: 'Courier',
    fontSize: 8,
    color: color.faint,
    textAlign: 'center',
    letterSpacing: 0.4,
    lineHeight: 11,
  },
});
