import React from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable } from 'react-native';
import { ShieldCheck, Shield } from 'lucide-react-native';
import { color, space, radius, dot } from '../theme/tokens.ts';
import { VERIFY_TEAL, VERIFY_TEAL_DIM, VERIFY_TEAL_BG } from './PassportVerificationStamp.tsx';

export interface VerificationLevelStatus {
  basicVerified: boolean;
  trustedTraveler: boolean;
  hostVerified: boolean;
  buddyVerified: boolean;
}

interface LevelCardProps {
  icon: React.ReactNode;
  label: string;
  subtitle: string;
  statusLabel: string;
  active: boolean;
}

function LevelCard({ icon, label, subtitle, statusLabel, active }: LevelCardProps) {
  return (
    <View style={[s.card, active && s.cardActive]}>
      <View style={[s.iconWrap, active && s.iconWrapActive]}>
        {icon}
      </View>
      <Text style={s.label} numberOfLines={1}>{label}</Text>
      <Text style={s.subtitle} numberOfLines={2}>{subtitle}</Text>
      <View style={s.statusRow}>
        <View style={[s.statusDot, active && s.statusDotActive]} />
        <Text style={[s.statusText, active && s.statusTextActive]} numberOfLines={1}>
          {statusLabel}
        </Text>
      </View>
    </View>
  );
}

interface Props {
  levels: VerificationLevelStatus;
  onLearnMore?: () => void;
}

export function VerificationLevelsRail({ levels, onLearnMore }: Props) {
  return (
    <View style={s.section}>
      <View style={s.header}>
        <Text style={s.sectionTitle}>Verification Levels</Text>
        {onLearnMore ? (
          <Pressable onPress={onLearnMore} hitSlop={8}>
            <Text style={s.learnMore}>Learn more</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.rail}
      >
        <LevelCard
          icon={<ShieldCheck size={18} color={levels.basicVerified ? VERIFY_TEAL : color.mute} strokeWidth={1.5} />}
          label="Basic Verified"
          subtitle="ID & selfie verified"
          statusLabel={levels.basicVerified ? 'Verified' : 'Not started'}
          active={levels.basicVerified}
        />
        <LevelCard
          icon={<ShieldCheck size={18} color={levels.trustedTraveler ? VERIFY_TEAL : color.mute} strokeWidth={1.5} />}
          label="Trusted Traveler"
          subtitle="Home country locked"
          statusLabel={levels.trustedTraveler ? 'All good' : 'Locked'}
          active={levels.trustedTraveler}
        />
        <LevelCard
          icon={<Shield size={18} color={levels.hostVerified ? '#8B5CF6' : color.mute} strokeWidth={1.5} />}
          label="Host Verified"
          subtitle="For event hosts"
          statusLabel={levels.hostVerified ? 'Verified' : 'Not active'}
          active={levels.hostVerified}
        />
        <LevelCard
          icon={<Shield size={18} color={levels.buddyVerified ? color.warn : color.mute} strokeWidth={1.5} />}
          label="Buddy Verified"
          subtitle="For Rent a Buddy"
          statusLabel={levels.buddyVerified ? 'Verified' : 'Not active'}
          active={levels.buddyVerified}
        />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  section: {
    marginTop: space.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: space.lg,
    marginBottom: space.md,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: color.ink,
    letterSpacing: -0.2,
  },
  learnMore: {
    fontSize: 13,
    fontWeight: '600',
    color: color.deep,
  },
  rail: {
    paddingHorizontal: space.lg,
    gap: space.sm,
    paddingBottom: 4,
  },
  card: {
    width: 128,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: 12,
    gap: 5,
  },
  cardActive: {
    borderColor: VERIFY_TEAL_DIM,
    backgroundColor: VERIFY_TEAL_BG,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  iconWrapActive: {
    backgroundColor: VERIFY_TEAL_BG,
    borderWidth: 1,
    borderColor: VERIFY_TEAL_DIM,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: color.ink,
    letterSpacing: 0.1,
  },
  subtitle: {
    fontSize: 11,
    color: color.mute,
    lineHeight: 15,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 3,
  },
  statusDot: {
    width: dot.s6, height: dot.s6,
    borderRadius: dot.s6 / 2,
    backgroundColor: color.faint,
  },
  statusDotActive: {
    backgroundColor: VERIFY_TEAL,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
    color: color.mute,
  },
  statusTextActive: {
    color: VERIFY_TEAL,
  },
});
