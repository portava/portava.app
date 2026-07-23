/**
 * Verification result screen — Phase V-2.
 *
 * Shows success (badge + verified date) or failure with normalized reason
 * and appropriate retry / no-retry messaging.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens.ts';
import { VerifiedBadge } from '../../src/components/VerifiedBadge.tsx';
import type { VerificationLevel, NormalizedFailureReason } from '../../src/services/verification.ts';

// ── Failure copy ──────────────────────────────────────────────────────────────

const FAILURE_COPY: Record<NormalizedFailureReason, { title: string; body: string; canRetry: boolean }> = {
  document_invalid: {
    title: 'Document not accepted',
    body: 'We could not read your document clearly. Make sure it is not expired, the photo is clear and unobstructed, and all edges are visible.',
    canRetry: true,
  },
  selfie_mismatch: {
    title: 'Selfie did not match',
    body: 'The liveness check could not confirm a match with your document. Try again in good lighting and without glasses.',
    canRetry: true,
  },
  underage: {
    title: 'Age requirement not met',
    body: "Portava requires users to be 18 or older to get verified. If you believe this is an error, contact support. You may continue using Portava without a verified badge.",
    canRetry: false, // never show retry for underage
  },
  abandoned: {
    title: 'Session expired',
    body: 'The verification session timed out before completion. Start a new session when you are ready.',
    canRetry: true,
  },
  provider_error: {
    title: 'Something went wrong',
    body: 'Our verification provider ran into a temporary issue. Please try again in a few minutes.',
    canRetry: true,
  },
  other: {
    title: 'Verification unsuccessful',
    body: 'Verification could not be completed. Please try again or contact support if the problem persists.',
    canRetry: true,
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function VerificationResultScreen() {
  const insets = useSafeAreaInsets();
  const { outcome, level, reason } = useLocalSearchParams<{
    outcome: 'success' | 'failed';
    level?: VerificationLevel;
    reason?: NormalizedFailureReason;
  }>();

  const isSuccess = outcome === 'success';
  const failInfo  = reason ? (FAILURE_COPY[reason] ?? FAILURE_COPY.other) : FAILURE_COPY.other;

  const handleRetry = () => {
    router.replace('/verification' as any);
  };

  const handleDone = () => {
    // Navigate back to passport, replacing the entire verification stack
    router.replace('/(tabs)/passport' as any);
  };

  if (isSuccess) {
    return (
      <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom + 24 }]}>
        <ScrollView contentContainerStyle={s.centerContent} showsVerticalScrollIndicator={false}>
          <View style={s.successIconWrap}>
            <CheckCircle2 size={48} color="#059669" strokeWidth={1.5} />
          </View>

          <Text style={s.successTitle}>You're verified!</Text>

          <View style={s.badgeRow}>
            <Text style={s.badgeLabel}>Your new badge</Text>
            <VerifiedBadge
              level={level ?? 'id_verified'}
              size={22}
            />
          </View>

          <Text style={s.successSub}>
            {level === 'id_selfie_verified'
              ? 'Your gold badge confirms your ID and selfie match — the highest trust tier on Portava.'
              : 'Your teal badge confirms your government-issued ID. Upgrade to ID + Selfie for the gold badge anytime.'}
          </Text>

          <Text style={s.tip}>
            Your badge is now visible on your Passport and Rent-a-Buddy listing. Other travelers can see it when they view your profile.
          </Text>
        </ScrollView>

        <Pressable style={s.primaryBtn} onPress={handleDone}>
          <Text style={s.primaryBtnText}>Back to my passport</Text>
        </Pressable>
      </View>
    );
  }

  // Failure
  const isUnderage = reason === 'underage';

  return (
    <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom + 24 }]}>
      <ScrollView contentContainerStyle={s.centerContent} showsVerticalScrollIndicator={false}>
        <View style={[s.failIconWrap, isUnderage && s.failIconWrapAmber]}>
          {isUnderage
            ? <AlertTriangle size={48} color="#D97706" strokeWidth={1.5} />
            : <XCircle size={48} color="#EF4444" strokeWidth={1.5} />}
        </View>

        <Text style={s.failTitle}>{failInfo.title}</Text>
        <Text style={s.failBody}>{failInfo.body}</Text>

        {isUnderage && (
          <View style={s.ageNotice}>
            <Text style={s.ageNoticeText}>
              Portava is for users 18 and over. Your account remains active — you just won't have a verified badge.
            </Text>
          </View>
        )}
      </ScrollView>

      <View style={s.footerBtns}>
        {failInfo.canRetry && (
          <Pressable style={s.primaryBtn} onPress={handleRetry}>
            <Text style={s.primaryBtnText}>Try again</Text>
          </Pressable>
        )}
        <Pressable style={[s.secondaryBtn, failInfo.canRetry && s.secondaryBtnWithPrimary]} onPress={handleDone}>
          <Text style={s.secondaryBtnText}>Back to passport</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper, paddingHorizontal: space.xl },

  centerContent: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, paddingTop: 60 },

  successIconWrap: {
    width: 90, height: 90, borderRadius: 45,
    backgroundColor: 'rgba(5,150,105,0.08)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: space.sm,
  },
  successTitle: { ...t.heading, color: color.ink, textAlign: 'center', fontSize: 24, fontWeight: '700' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  badgeLabel: { ...t.body, color: color.mute },
  successSub: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
  tip: {
    ...t.small, color: color.mute, textAlign: 'center', lineHeight: 18,
    paddingHorizontal: space.sm,
  },

  failIconWrap: {
    width: 90, height: 90, borderRadius: 45,
    backgroundColor: 'rgba(239,68,68,0.08)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: space.sm,
  },
  failIconWrapAmber: { backgroundColor: 'rgba(217,119,6,0.08)' },
  failTitle: { ...t.heading, color: color.ink, textAlign: 'center', fontWeight: '700' },
  failBody:  { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
  ageNotice: {
    backgroundColor: 'rgba(217,119,6,0.08)',
    borderRadius: radius.md,
    padding: space.md,
    borderLeftWidth: 3, borderLeftColor: '#D97706',
  },
  ageNoticeText: { ...t.small, color: '#92400E', lineHeight: 18 },

  footerBtns: { gap: space.sm, paddingTop: space.md },
  primaryBtn: {
    backgroundColor: color.signal, borderRadius: radius.pill,
    paddingVertical: 15, alignItems: 'center',
  },
  primaryBtnText: { ...t.bodyStrong, color: '#fff', fontWeight: '700' },
  secondaryBtn: { alignItems: 'center', paddingVertical: 14 },
  secondaryBtnWithPrimary: { marginTop: 0 },
  secondaryBtnText: { ...t.body, color: color.mute },
});
