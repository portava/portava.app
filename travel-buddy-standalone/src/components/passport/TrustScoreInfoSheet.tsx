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
import { ShieldCheck, CheckCircle2, Circle, AlertTriangle, X } from 'lucide-react-native';
import type { TrustScoreBreakdown, TrustScoreFactor } from '../../types/models.ts';
import { PP } from '../../theme/passportTokens.ts';
import { radius, space } from '../../theme/tokens.ts';
import { BASIS_NOTE } from '../../features/passport/useTrustProjection.ts';

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

/**
 * What a standing RESTS ON — the explanation the app already ships.
 *
 * These are the user-facing sentences of `BASIS_NOTE` in
 * `src/features/passport/useTrustProjection.ts`, which `TrustScreen` already
 * prints beside each domain row.
 *
 * They replace the former `TierGuide`, whose five band names ("Trusted
 * Traveler", "Community Member", "Growing Traveler", "New Explorer", "Getting
 * Started") were a SECOND standing vocabulary that disagreed with the server's
 * own words on the same screen. The server owns the word — `presentationWord`
 * in `artifacts/api-server/src/services/passport/PassportProjectionService.ts`
 * returns Excellent / Strong / Established / Building / New on different
 * boundaries — so a 62 was "Established" to the server and "Community Member"
 * to the guide that existed to explain it. The guide is gone; the server's word
 * is rendered verbatim and this block explains what it rests on.
 *
 * Only the two sentences that describe a BASIS are listed. `BASIS_NOTE`'s
 * `unavailable` copy ("Trust records are unavailable right now.") is a live
 * outage state, not a basis, and stating it here when records are readable
 * would report an outage as a fact — the failure mode #471 removed elsewhere.
 * `measured` and `not_applicable` map to `null` by design: an annotation
 * printed on every row is decoration, not a distinction.
 *
 * IMPORTED from `BASIS_NOTE` rather than re-typed, so a third vocabulary is
 * impossible rather than merely detectable.
 * `TrustScoreInfoSheet.basis.component.test.tsx` still reads the sentences back
 * out of `deriveTrustView`, which keeps the assertion honest if the constant is
 * ever re-inlined.
 */
const BASIS_LINES: readonly string[] = [
  BASIS_NOTE.partial,
  BASIS_NOTE.substituted,
].filter((s): s is string => typeof s === 'string' && s.length > 0);

function BasisGuide() {
  return (
    <View style={bg.wrap}>
      {BASIS_LINES.map((line, i) => (
        <View key={line}>
          {i > 0 ? <View style={s.divider} /> : null}
          <View style={bg.row}>
            <Text style={bg.line}>{line}</Text>
          </View>
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
      <Pressable style={s.backdrop} onPress={onClose} testID="trust-sheet-backdrop" />
      <View style={s.sheet}>
        {/* Handle bar */}
        <View style={s.handle} />

        {/* Header */}
        <View style={s.header}>
          <View style={s.headerLeft}>
            <ShieldCheck size={20} color={TEAL} strokeWidth={2} />
            <Text style={s.title}>Trust Score</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12} style={s.closeBtn} testID="trust-sheet-close">
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
              <Text style={s.sectionTitle}>HOW IT WORKS</Text>
              <Text style={s.bodyText}>
                Your Trust Score (0–100) reflects your overall standing in the Portava community.
                It is calculated from ID verification, passport stamps, account age, buddy reviews,
                and safety history.
              </Text>
              <Text style={[s.sectionTitle, { marginTop: 20 }]}>WHAT A STANDING RESTS ON</Text>
              <Text style={s.bodyText}>
                Each area of your Passport carries the standing Portava measured for it. Where a
                standing is not a direct measurement, the Passport says so beside the word:
              </Text>
              <View style={{ marginTop: 10 }}>
                <BasisGuide />
              </View>
              <Text style={s.footerNote}>
                A standing shown without a note was measured from your own record.
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

const bg = StyleSheet.create({
  wrap: {
    backgroundColor: '#fff',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: DIVIDER,
    overflow: 'hidden',
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  line: {
    fontSize: 13,
    color: INK,
    lineHeight: 18,
  },
});
