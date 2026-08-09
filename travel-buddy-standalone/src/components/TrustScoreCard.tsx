import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { ShieldCheck, Info } from 'lucide-react-native';
import { color, space, radius, avatar } from '../theme/tokens.ts';
import { VERIFY_TEAL, VERIFY_TEAL_DIM, VERIFY_TEAL_BG } from './PassportVerificationStamp.tsx';

interface Props {
  score: number;
  label?: string;
  onInfoPress?: () => void;
}

function fmtScore(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n)) : '—';
}

export function TrustScoreCard({ score, label = 'Trusted Traveler', onInfoPress }: Props) {
  return (
    <View style={s.card}>
      <View style={s.headerRow}>
        <Text style={s.title}>TRUST SCORE</Text>
        <Pressable onPress={onInfoPress} hitSlop={10} disabled={!onInfoPress}>
          <Info size={12} color="rgba(250,249,246,0.35)" />
        </Pressable>
      </View>
      <View style={s.scoreRow}>
        <View style={s.iconWrap}>
          <ShieldCheck size={26} color={VERIFY_TEAL} strokeWidth={1.5} />
        </View>
        <View style={s.nums}>
          <Text style={s.scoreText}>
            <Text style={s.scoreNum}>{fmtScore(score)}</Text>
            <Text style={s.scoreDenom}> / 100</Text>
          </Text>
        </View>
      </View>
      <Text style={s.label} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#0D110F',
    borderWidth: 1.5,
    borderColor: VERIFY_TEAL_DIM,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontFamily: 'Courier',
    fontSize: 8,
    letterSpacing: 1.5,
    fontWeight: '700',
    color: 'rgba(250,249,246,0.55)',
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  iconWrap: {
    width: avatar.md, height: avatar.md,
    borderRadius: avatar.md / 2,
    backgroundColor: VERIFY_TEAL_BG,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: VERIFY_TEAL_DIM,
  },
  nums: {
    gap: 1,
  },
  scoreText: {
    fontFamily: 'Courier',
  },
  scoreNum: {
    fontSize: 22,
    fontWeight: '700',
    color: VERIFY_TEAL,
    fontFamily: 'Courier',
  },
  scoreDenom: {
    fontSize: 13,
    color: 'rgba(250,249,246,0.45)',
    fontFamily: 'Courier',
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(250,249,246,0.55)',
    letterSpacing: 0.1,
  },
});
