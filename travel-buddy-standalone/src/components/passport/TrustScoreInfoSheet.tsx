/**
 * TrustScoreInfoSheet
 *
 * Bottom sheet explaining the trust score formula to the owner.
 * Shows each factor, its earned points, maximum, and an actionable hint when
 * the factor is not yet maxed.
 *
 * Rendered as a plain Modal so it requires no extra dependencies.
 */
import React from 'react';
import {
  View, Text, Modal, Pressable, ScrollView, StyleSheet,
} from 'react-native';
import { ShieldCheck, CheckCircle2, Circle, AlertTriangle, X, ChevronRight } from 'lucide-react-native';
import type { TrustScoreBreakdown, TrustScoreFactor } from '../../types/models.ts';
import { PP } from '../../theme/passportTokens.ts';
import { radius, space } from '../../theme/tokens.ts';

const TEAL = '#0D9B6F';
const TEAL_DIM = 'rgba(13,155,111,0.18)';
const TEAL_BG = 'rgba(13,155,111,0.08)';
const RED = '#EF4444';
const RED_BG = 'rgba(239,68,68,0.09)';
const INK = '#1C1C1A';
const MUTED = '#8A7E6E';
const CREAM = '#F5F0E8';
const SURFACE = '#FAF9F6';
const DIVIDER = 'rgba(28,28,26,0.08)';

interface Props {
  visible: boolean;
  onClose: () => void;
  score: number | null;
  label: string | null;
  breakdown: TrustScoreBreakdown | null;
}

function FactorRow({ factor }: { factor: TrustScoreFactor }) {
  const isPenalty = factor.maxPoints < 0;
  const isEarned = factor.points !== 0;
  const isMaxed = factor.maxed;

  const accentColor = isPenalty ? RED : isMaxed ? TEAL : MUTED;
  const bgColor = isPenalty ? RED_BG : isMaxed ? TEAL_BG : 'transparent';

  return (
    <View style={[fr.row, { backgroundColor: bgColor }]}>
      <View style={fr.iconCol}>
        {isPenalty ? (
          <AlertTriangle size={17} color={RED} strokeWidth={2} />
        ) : isMaxed ? (
          <CheckCircle2 size={17} color={TEAL} strokeWidth={2} />
        ) : (
          <Circle size={17} color={MUTED} strokeWidth={1.5} />
        )}
      </View>

      <View style={fr.body}>
        <Text style={[fr.label, { color: isEarned || isPenalty ? INK : MUTED }]}>
          {factor.label}
        </Text>
        {factor.hint ? (
          <Text style={fr.hint}>{factor.hint}</Text>
        ) : null}
      </View>

      <Text style={[fr.points, { color: accentColor }]}>
        {isPenalty
          ? `${factor.points}`
          : `+${factor.points} / ${factor.maxPoints}`}
      </Text>
    </View>
  );
}

/** Score tier label rows shown when there's no breakdown (public or error state). */
function TierGuide() {
  const tiers = [
    { range: '80–100', label: 'Trusted Traveler' },
    { range: '60–79', label: 'Community Member' },
    { range: '40–59', label: 'Growing Traveler' },
    { range: '20–39', label: 'New Explorer' },
    { range: '0–19',  label: 'Getting Started' },
  ];
  return (
    <View style={tg.wrap}>
      {tiers.map((t) => (
        <View key={t.range} style={tg.row}>
          <Text style={tg.range}>{t.range}</Text>
          <ChevronRight size={11} color={MUTED} strokeWidth={1.5} />
          <Text style={tg.tierLabel}>{t.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function TrustScoreInfoSheet({ visible, onClose, score, label, breakdown }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={s.sheet}>
        {/* Handle bar */}
        <View style={s.handle} />

        {/* Header */}
        <View style={s.header}>
          <View style={s.headerLeft}>
            <ShieldCheck size={20} color={TEAL} strokeWidth={2} />
            <Text style={s.title}>Trust Score</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12} style={s.closeBtn}>
            <X size={18} color={MUTED} strokeWidth={2} />
          </Pressable>
        </View>

        {/* Current score pill */}
        {score != null ? (
          <View style={s.scorePill}>
            <Text style={s.scoreNum}>{Math.round(score)}</Text>
            <Text style={s.scoreDenom}> / 100</Text>
            {label ? <Text style={s.scoreLabel}> · {label}</Text> : null}
          </View>
        ) : null}

        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {breakdown ? (
            <>
              <Text style={s.sectionTitle}>HOW YOUR SCORE IS CALCULATED</Text>
              <View style={s.factorsCard}>
                {breakdown.factors.map((f, i) => (
                  <View key={f.key}>
                    {i > 0 ? <View style={s.divider} /> : null}
                    <FactorRow factor={f} />
                  </View>
                ))}
              </View>
              <Text style={s.footerNote}>
                Scores update within minutes of a qualifying action. Safety flags are reviewed by the Portava team.
              </Text>
            </>
          ) : (
            <>
              <Text style={s.sectionTitle}>SCORE TIERS</Text>
              <TierGuide />
              <Text style={[s.sectionTitle, { marginTop: 20 }]}>HOW IT WORKS</Text>
              <Text style={s.bodyText}>
                Your Trust Score (0–100) reflects your overall standing in the Portava community.
                It is calculated from ID verification, passport stamps, account age, buddy reviews,
                and safety history.
              </Text>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    backgroundColor: SURFACE,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 40,
    maxHeight: '80%',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: DIVIDER,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: DIVIDER,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: INK,
    letterSpacing: -0.2,
  },
  closeBtn: {
    padding: 4,
  },
  scorePill: {
    flexDirection: 'row',
    alignItems: 'baseline',
    alignSelf: 'center',
    backgroundColor: TEAL_BG,
    borderRadius: 100,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginVertical: 14,
    borderWidth: 1,
    borderColor: TEAL_DIM,
  },
  scoreNum: {
    fontSize: 24,
    fontWeight: '800',
    color: TEAL,
    fontFamily: 'Courier',
  },
  scoreDenom: {
    fontSize: 14,
    color: MUTED,
    fontFamily: 'Courier',
  },
  scoreLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: TEAL,
  },
  scroll: {
    flexShrink: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: MUTED,
    marginBottom: 10,
    marginTop: 4,
  },
  factorsCard: {
    backgroundColor: '#fff',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: DIVIDER,
    overflow: 'hidden',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: DIVIDER,
    marginLeft: 44,
  },
  footerNote: {
    fontSize: 11,
    color: MUTED,
    marginTop: 14,
    lineHeight: 16,
  },
  bodyText: {
    fontSize: 13,
    color: INK,
    lineHeight: 19,
  },
});

const fr = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  iconCol: {
    width: 20,
    marginTop: 2,
    alignItems: 'center',
  },
  body: {
    flex: 1,
    gap: 3,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  hint: {
    fontSize: 12,
    color: MUTED,
    lineHeight: 16,
  },
  points: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Courier',
    minWidth: 52,
    textAlign: 'right',
    marginTop: 2,
  },
});

const tg = StyleSheet.create({
  wrap: {
    backgroundColor: '#fff',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: DIVIDER,
    overflow: 'hidden',
    paddingVertical: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  range: {
    fontSize: 13,
    fontWeight: '700',
    color: INK,
    width: 56,
    fontFamily: 'Courier',
  },
  tierLabel: {
    fontSize: 13,
    color: MUTED,
  },
});
