/**
 * Verification pending screen — Phase V-2.
 *
 * Polls GET /api/verification/status every 3 s until the status resolves
 * (verified, failed) or 2 minutes elapse.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShieldCheck, Clock } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens.ts';
import { getVerificationStatus } from '../../src/services/verification.ts';
import type { NormalizedVerificationStatus, NormalizedFailureReason } from '../../src/services/verification.ts';

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_MS      = 2 * 60 * 1_000; // 2 minutes

type State = 'polling' | 'timeout' | 'resolved';

export default function VerificationPendingScreen() {
  const insets = useSafeAreaInsets();
  const { providerSessionId } = useLocalSearchParams<{ providerSessionId?: string }>();

  const [uiState, setUiState]   = useState<State>('polling');
  const startRef  = useRef(Date.now());
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(async () => {
      const elapsed = Date.now() - startRef.current;
      if (elapsed >= MAX_POLL_MS) {
        clearInterval(timerRef.current!);
        setUiState('timeout');
        return;
      }

      const res = await getVerificationStatus();
      if (!res.ok) return; // network error — keep polling

      const { verificationRow, verificationLevel } = res.result;
      const status: NormalizedVerificationStatus | undefined = verificationRow?.status;

      if (status === 'verified' || verificationLevel !== 'none') {
        clearInterval(timerRef.current!);
        setUiState('resolved');
        router.replace({
          pathname: '/verification/result' as any,
          params: { outcome: 'success', level: verificationLevel },
        });
      } else if (status === 'failed') {
        const reason: NormalizedFailureReason = verificationRow?.failureReason ?? 'other';
        clearInterval(timerRef.current!);
        setUiState('resolved');
        router.replace({
          pathname: '/verification/result' as any,
          params: { outcome: 'failed', reason },
        });
      }
      // 'processing' | 'pending' | 'created' → keep polling
    }, POLL_INTERVAL_MS);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  if (uiState === 'timeout') {
    return (
      <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom + 16 }]}>
        <Clock size={48} color={color.mute} style={{ alignSelf: 'center', marginTop: 60 }} />
        <Text style={s.title}>Still processing…</Text>
        <Text style={s.sub}>
          Verification is taking longer than expected. Your badge will appear on your
          profile automatically once it's approved — no need to stay on this screen.
        </Text>
        <Pressable style={s.btn} onPress={() => router.replace('/(tabs)/passport' as any)}>
          <Text style={s.btnText}>Back to passport</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.center}>
        <View style={s.iconWrap}>
          <ShieldCheck size={40} color="#0897B7" strokeWidth={1.5} />
        </View>
        <ActivityIndicator color={color.signal} size="large" style={{ marginTop: space.md }} />
        <Text style={s.title}>Verifying your identity…</Text>
        <Text style={s.sub}>This usually takes less than a minute. Don't close the app.</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root:    { flex: 1, backgroundColor: color.paper, paddingHorizontal: space.xl },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  iconWrap: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(8,151,183,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  title: { ...t.heading, color: color.ink, textAlign: 'center', marginTop: space.lg },
  sub:   { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
  btn: {
    marginTop: space.xl,
    backgroundColor: color.signal, borderRadius: radius.pill,
    paddingVertical: 14, paddingHorizontal: space.xl, alignSelf: 'center',
  },
  btnText: { ...t.bodyStrong, color: '#fff', fontWeight: '700' },
});
