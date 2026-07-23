/**
 * Verification intro screen — Phase V-2.
 *
 * Shows what verification is, the two tiers (id / id_selfie), and the
 * privacy commitments. User picks a level and taps "Start verification".
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet,
  ActivityIndicator, Linking, Alert, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, ShieldCheck, CheckCircle2, Lock, Eye, Clock } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens.ts';
import { createVerificationSession } from '../../src/services/verification.ts';

// ─────────────────────────────────────────────────────────────────────────────

type Level = 'id' | 'id_selfie';

const LEVELS: { key: Level; title: string; sub: string; icon: React.ReactNode }[] = [
  {
    key: 'id',
    title: 'ID Verification',
    sub: 'Confirm your identity with a government-issued document.',
    icon: <ShieldCheck size={20} color="#0897B7" />,
  },
  {
    key: 'id_selfie',
    title: 'ID + Selfie Match',
    sub: 'Highest trust tier — your document and a liveness check.',
    icon: <ShieldCheck size={20} color="#D9A441" />,
  },
];

const PRIVACY_POINTS = [
  'We never store your ID document, document number, or photos.',
  'We never store your date of birth.',
  'Verification is processed by a certified identity provider.',
  'Your badge is permanent once verified — you only need to do this once.',
];

// ─────────────────────────────────────────────────────────────────────────────

export default function VerificationIntroScreen() {
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<Level>('id_selfie');
  const [loading, setLoading] = useState(false);

  async function handleStart() {
    setLoading(true);
    const res = await createVerificationSession(selected);
    setLoading(false);

    if (!res.ok) {
      Alert.alert('Could not start verification', res.error);
      return;
    }

    const { redirectUrl, providerSessionId } = res.result;

    // Mock provider: redirectUrl is a deep link portava://app/verification/mock-complete?mockSession=...
    // Real providers: open the hosted flow URL in an in-app browser.
    if (redirectUrl.includes('mockSession=')) {
      // Extract mockSession param and navigate within the app (dev only)
      const mockSession = new URL(redirectUrl, 'portava://app').searchParams.get('mockSession') ?? providerSessionId;
      router.push({
        pathname: '/verification/mock-complete' as any,
        params: { mockSession, level: selected },
      });
    } else {
      // Real provider — open hosted flow then navigate to pending.
      await Linking.openURL(redirectUrl).catch(() => {});
      router.replace({
        pathname: '/verification/pending' as any,
        params: { providerSessionId },
      });
    }
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={s.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Get Verified</Text>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {/* Hero */}
        <View style={s.hero}>
          <View style={s.heroIcon}>
            <ShieldCheck size={36} color="#0897B7" strokeWidth={1.5} />
          </View>
          <Text style={s.heroTitle}>Portava Verification</Text>
          <Text style={s.heroSub}>
            A verified badge helps other travelers trust you. It takes about 2 minutes
            and you only need to do it once.
          </Text>
        </View>

        {/* Level picker */}
        <Text style={s.sectionLabel}>CHOOSE YOUR LEVEL</Text>
        {LEVELS.map((lvl) => (
          <Pressable
            key={lvl.key}
            style={[s.levelCard, selected === lvl.key && s.levelCardSelected]}
            onPress={() => setSelected(lvl.key)}
          >
            <View style={s.levelIconWrap}>{lvl.icon}</View>
            <View style={s.levelText}>
              <Text style={[s.levelTitle, selected === lvl.key && s.levelTitleSelected]}>{lvl.title}</Text>
              <Text style={s.levelSub}>{lvl.sub}</Text>
            </View>
            {selected === lvl.key && (
              <CheckCircle2 size={18} color={color.signal} />
            )}
          </Pressable>
        ))}

        {/* Privacy commitments */}
        <Text style={s.sectionLabel}>YOUR PRIVACY</Text>
        <View style={s.privacyCard}>
          <View style={s.privacyIconRow}>
            <Lock size={14} color={color.mute} />
            <Eye size={14} color={color.mute} />
            <Clock size={14} color={color.mute} />
          </View>
          {PRIVACY_POINTS.map((point) => (
            <View key={point} style={s.privacyRow}>
              <Text style={s.privacyBullet}>•</Text>
              <Text style={s.privacyText}>{point}</Text>
            </View>
          ))}
        </View>

        {/* What happens next */}
        <Text style={s.sectionLabel}>WHAT HAPPENS NEXT</Text>
        <Text style={s.stepText}>
          1. You'll be taken to our verification partner's secure page.{'\n'}
          2. Follow the on-screen steps (takes 1–2 min).{'\n'}
          3. Return here — your badge will appear on your profile automatically.
        </Text>

        <View style={{ height: insets.bottom + 100 }} />
      </ScrollView>

      {/* CTA */}
      <View style={[s.footer, { paddingBottom: insets.bottom + 16 }]}>
        <Pressable
          style={[s.cta, loading && s.ctaDisabled]}
          onPress={handleStart}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={s.ctaText}>Start verification</Text>
          }
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root:  { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
  },
  backBtn:     { width: 38, alignItems: 'flex-start' },
  headerTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },

  scroll: { paddingHorizontal: space.lg, paddingTop: space.xl },

  hero:     { alignItems: 'center', gap: space.sm, marginBottom: space.xl },
  heroIcon: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: 'rgba(8,151,183,0.08)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: space.sm,
  },
  heroTitle: { ...t.heading, color: color.ink, textAlign: 'center' },
  heroSub:   { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },

  sectionLabel: {
    ...t.stamp, fontSize: 10, letterSpacing: 1.2, color: color.mute,
    marginBottom: space.sm, marginTop: space.lg,
  },

  levelCard: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5, borderColor: color.haze,
    backgroundColor: color.paperRaised,
    marginBottom: space.sm,
  },
  levelCardSelected: {
    borderColor: color.signal,
    backgroundColor: `${color.signal}08`,
  },
  levelIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: color.paper,
    alignItems: 'center', justifyContent: 'center',
  },
  levelText:           { flex: 1 },
  levelTitle:          { ...t.bodyStrong, color: color.ink, fontWeight: '600' },
  levelTitleSelected:  { color: color.signal },
  levelSub:            { ...t.small, color: color.mute, marginTop: 2, lineHeight: 18 },

  privacyCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.xs,
  },
  privacyIconRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.xs },
  privacyRow:     { flexDirection: 'row', gap: space.xs, alignItems: 'flex-start' },
  privacyBullet:  { ...t.small, color: color.mute, marginTop: 1 },
  privacyText:    { ...t.small, color: color.mute, flex: 1, lineHeight: 18 },

  stepText: { ...t.body, color: color.mute, lineHeight: 22 },

  footer: {
    paddingHorizontal: space.lg, paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze,
    backgroundColor: color.paper,
  },
  cta: {
    backgroundColor: color.signal, borderRadius: radius.pill,
    paddingVertical: 15, alignItems: 'center',
  },
  ctaDisabled: { opacity: 0.6 },
  ctaText:     { ...t.bodyStrong, color: '#fff', fontWeight: '700' },
});
