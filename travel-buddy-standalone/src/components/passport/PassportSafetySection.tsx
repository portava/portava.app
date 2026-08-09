/**
 * PassportSafetySection — Safety & Trust dossier block.
 * Shows verification levels + trust score in passport document style.
 * Only shows truthful backend data — never fabricates verification states.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ShieldCheck, Shield } from 'lucide-react-native';
import type { VerificationLevelStatus } from '../VerificationLevelsRail.tsx';
import { PP, PP_LABEL } from '../../theme/passportTokens.ts';
import { dot } from '../../theme/tokens.ts';

interface Props {
  levels: VerificationLevelStatus;
  trustScore?: number | null;
  trustLabel?: string | null;
  noSafetyFlags?: boolean;
  isOwner?: boolean;
  onPrivacySettings?: () => void;
}

interface LevelRowProps {
  label: string;
  subtitle: string;
  active: boolean;
  icon: React.ReactNode;
}

function LevelRow({ label, subtitle, active, icon }: LevelRowProps) {
  return (
    <View style={r.row}>
      <View style={[r.iconWrap, active && r.iconWrapActive]}>
        {icon}
      </View>
      <View style={r.text}>
        <Text style={r.label}>{label}</Text>
        <Text style={r.sub}>{subtitle}</Text>
      </View>
      <View style={[r.badge, active && r.badgeActive]}>
        <Text style={[r.badgeText, active && r.badgeTextActive]}>
          {active ? 'Verified' : 'Not yet'}
        </Text>
      </View>
    </View>
  );
}

const TEAL = '#0D9B6F';

const r = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: PP.borderLight,
  },
  iconWrap: {
    width: 30, height: 30, borderRadius: 8,
    backgroundColor: PP.paperDeep,
    borderWidth: 1, borderColor: PP.borderLight,
    alignItems: 'center', justifyContent: 'center',
  },
  iconWrapActive: {
    backgroundColor: 'rgba(13,155,111,0.10)',
    borderColor: 'rgba(13,155,111,0.25)',
  },
  text: { flex: 1 },
  label: { fontSize: 12, fontWeight: '700', color: PP.ink, letterSpacing: 0.1 },
  sub: { fontSize: 10, color: PP.inkMuted, lineHeight: 14, marginTop: 1 },
  badge: {
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 10, backgroundColor: PP.paperDeep,
    borderWidth: 1, borderColor: PP.borderLight,
  },
  badgeActive: {
    backgroundColor: 'rgba(13,155,111,0.10)',
    borderColor: 'rgba(13,155,111,0.30)',
  },
  badgeText: { ...PP_LABEL, fontSize: 8, color: PP.inkMuted, letterSpacing: 0.8 },
  badgeTextActive: { color: TEAL },
});

export function PassportSafetySection({
  levels, trustScore, trustLabel, noSafetyFlags = true, isOwner, onPrivacySettings,
}: Props) {
  const hasAnyActive = levels.basicVerified || levels.trustedTraveler
    || levels.hostVerified || levels.buddyVerified;

  return (
    <View style={s.section}>
      {/* Section heading */}
      <View style={s.heading}>
        <View style={s.headingLeft}>
          <Text style={s.headingTitle}>SAFETY & TRUST</Text>
          <View style={s.headingRule} />
        </View>
        {isOwner && onPrivacySettings ? (
          <Pressable onPress={onPrivacySettings} hitSlop={8}>
            <Text style={s.settingsLink}>Privacy Settings</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Trust Score row */}
      {trustScore != null ? (
        <View style={s.trustRow}>
          <ShieldCheck size={16} color={TEAL} strokeWidth={2} />
          <Text style={s.trustLabel}>TRUST SCORE</Text>
          <Text style={s.trustScore}>{Math.round(trustScore)}</Text>
          <Text style={s.trustMax}>/100</Text>
          {trustLabel ? (
            <Text style={s.trustLabelText}> · {trustLabel}</Text>
          ) : null}
        </View>
      ) : null}

      {/* Verification levels */}
      <View style={s.levels}>
        <LevelRow
          label="Basic Verified"
          subtitle="ID & selfie verified"
          active={levels.basicVerified}
          icon={<ShieldCheck size={14} color={levels.basicVerified ? TEAL : PP.inkMuted} strokeWidth={1.5} />}
        />
        <LevelRow
          label="Trusted Traveler"
          subtitle="Home country locked in"
          active={levels.trustedTraveler}
          icon={<ShieldCheck size={14} color={levels.trustedTraveler ? TEAL : PP.inkMuted} strokeWidth={1.5} />}
        />
        <LevelRow
          label="Host Verified"
          subtitle="For event & trip hosting"
          active={levels.hostVerified}
          icon={<Shield size={14} color={levels.hostVerified ? '#8B5CF6' : PP.inkMuted} strokeWidth={1.5} />}
        />
        <LevelRow
          label="Buddy Verified"
          subtitle="For Rent a Buddy marketplace"
          active={levels.buddyVerified}
          icon={<Shield size={14} color={levels.buddyVerified ? '#C8851A' : PP.inkMuted} strokeWidth={1.5} />}
        />
      </View>

      {/* Safety flags summary (public-safe — never exposes count) */}
      <View style={s.flagsRow}>
        <View style={[s.flagDot, noSafetyFlags && s.flagDotOk]} />
        <Text style={s.flagsText}>
          {noSafetyFlags ? 'No active safety flags' : 'Safety record under review'}
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  section: {
    marginHorizontal: 16,
    backgroundColor: PP.paper,
    borderRadius: 10,
    borderWidth: 1, borderColor: PP.borderLight,
    padding: 14,
    gap: 12,
  },
  heading: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  headingLeft: {
    flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1,
  },
  headingTitle: { ...PP_LABEL, fontSize: 10, color: PP.ink, letterSpacing: 2 },
  headingRule: { flex: 1, height: 1, backgroundColor: PP.borderLight },
  settingsLink: { ...PP_LABEL, fontSize: 9, color: PP.inkLight, letterSpacing: 1 },

  trustRow: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(13,155,111,0.07)',
    borderRadius: 8, padding: 10,
    borderWidth: 1, borderColor: 'rgba(13,155,111,0.15)',
  },
  trustLabel: { ...PP_LABEL, color: TEAL, letterSpacing: 1.5, flex: 1 },
  trustScore: { fontSize: 20, fontWeight: '800', color: TEAL },
  trustMax: { fontSize: 11, color: TEAL, opacity: 0.7, fontWeight: '600' },
  trustLabelText: { fontSize: 11, color: TEAL, opacity: 0.8 },

  levels: { gap: 0 },

  flagsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingTop: 4,
  },
  flagDot: {
    width: dot.md, height: dot.md, borderRadius: dot.md / 2,
    backgroundColor: PP.inkMuted,
  },
  flagDotOk: { backgroundColor: TEAL },
  flagsText: { fontSize: 11, color: PP.inkMuted, fontWeight: '500' },
});
