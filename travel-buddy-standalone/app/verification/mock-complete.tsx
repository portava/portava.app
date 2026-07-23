/**
 * Mock-complete screen — DEV ONLY (Phase V-2).
 *
 * Renders when the mock provider redirects back with ?mockSession=<id>.
 * Shows Approve / Fail Document / Fail Selfie / Fail Underage buttons that
 * POST to /api/verification/webhook and then navigate to the pending screen.
 *
 * This screen MUST NOT render in production builds.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t } from '../../src/theme/tokens.ts';
import { triggerMockWebhook } from '../../src/services/verification.ts';
import type { TestHint } from '../../src/services/verification.ts';

// ── Hard production gate ──────────────────────────────────────────────────────
// __DEV__ is set by Metro/Expo at compile time; false in production EAS builds.
if (!__DEV__) {
  throw new Error('mock-complete screen must never render in production builds');
}

const OUTCOMES: { hint: TestHint; label: string; color: string; bg: string }[] = [
  { hint: 'approve',       label: '✓  Approve',          color: '#fff',    bg: '#059669' },
  { hint: 'fail_document', label: '✕  Fail — Document',  color: '#fff',    bg: '#DC2626' },
  { hint: 'fail_selfie',   label: '✕  Fail — Selfie',    color: '#fff',    bg: '#B91C1C' },
  { hint: 'fail_underage', label: '⚠  Fail — Underage',  color: '#fff',    bg: '#D97706' },
];

export default function MockCompleteScreen() {
  const insets = useSafeAreaInsets();
  const { mockSession, level } = useLocalSearchParams<{ mockSession?: string; level?: string }>();
  const [busy, setBusy] = useState<TestHint | null>(null);

  async function trigger(hint: TestHint) {
    if (!mockSession) {
      Alert.alert('Missing mockSession param');
      return;
    }
    setBusy(hint);
    const res = await triggerMockWebhook(mockSession, hint);
    setBusy(null);

    if (!res.ok) {
      Alert.alert('Webhook trigger failed', res.error);
      return;
    }

    // Navigate to pending screen to poll for result
    router.replace({
      pathname: '/verification/pending' as any,
      params: { providerSessionId: mockSession },
    });
  }

  return (
    <View style={[s.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <View style={s.devBanner}>
        <Text style={s.devBannerText}>🛠  DEV / MOCK PROVIDER</Text>
      </View>

      <Text style={s.title}>Mock Verification</Text>
      <Text style={s.sub}>
        Session: <Text style={s.code}>{mockSession ?? '(none)'}</Text>{'\n'}
        Level: <Text style={s.code}>{level ?? '?'}</Text>
      </Text>
      <Text style={s.sub}>Choose an outcome to POST to /api/verification/webhook:</Text>

      <View style={s.btns}>
        {OUTCOMES.map((o) => (
          <Pressable
            key={o.hint}
            style={[s.btn, { backgroundColor: o.bg }, busy === o.hint && s.btnBusy]}
            onPress={() => trigger(o.hint)}
            disabled={busy !== null}
          >
            {busy === o.hint
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={[s.btnText, { color: o.color }]}>{o.label}</Text>
            }
          </Pressable>
        ))}
      </View>

      <Pressable style={s.cancelBtn} onPress={() => router.back()}>
        <Text style={s.cancelText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  root:     { flex: 1, backgroundColor: '#0F172A', paddingHorizontal: space.xl, gap: space.lg },
  devBanner: {
    backgroundColor: '#FEF3C7', borderRadius: radius.sm,
    paddingHorizontal: space.md, paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  devBannerText: { ...t.stamp, fontSize: 10, color: '#92400E', fontWeight: '700', letterSpacing: 1 },
  title: { ...t.heading, color: '#F8FAFC', fontWeight: '800' },
  sub:   { ...t.small, color: '#94A3B8', lineHeight: 20 },
  code:  { fontFamily: 'Courier', color: '#38BDF8' },
  btns:  { gap: space.sm },
  btn: {
    borderRadius: radius.md, paddingVertical: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  btnBusy:   { opacity: 0.7 },
  btnText:   { ...t.bodyStrong, fontWeight: '700', fontSize: 15 },
  cancelBtn: { alignItems: 'center', paddingVertical: 14 },
  cancelText:{ ...t.body, color: '#64748B' },
});
