import React, { useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, LayoutAnimation,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Shield, Star, ChevronDown, ChevronUp } from 'lucide-react-native';
import { TravelButton, TravelCard } from '../../../src/components/primitives';
import { Stamp } from '../../../src/components/ui';
import { color, space, radius, type as t, shadow, avatar } from '../../../src/theme/tokens';

const CATEGORIES = [
  { icon: '✈️', label: 'Arrival Support', desc: 'Airport pickup, SIM card, first-day orientation' },
  { icon: '🗺️', label: 'City Tours', desc: 'Neighbourhoods, history, hidden spots' },
  { icon: '🌙', label: 'Nightlife', desc: 'Venues, safe exits, local insider access' },
  { icon: '🍜', label: 'Food & Markets', desc: 'Street food, local markets, restaurant picks' },
  { icon: '📸', label: 'Content & Photo', desc: 'Filming spots, photography guidance' },
  { icon: '🌿', label: 'Nature & Adventure', desc: 'Hikes, beaches, outdoor excursions' },
  { icon: '🎭', label: 'Culture & Arts', desc: 'Museums, festivals, local culture' },
  { icon: '🛍️', label: 'Shopping', desc: 'Local finds, bargaining, souvenirs' },
];

const FAQS = [
  {
    q: 'Is Rent a Buddy a dating or escort service?',
    a: 'No. This is strictly a local guide and companionship service for travellers. All activities must be non-romantic, non-sexual, and non-adult in nature. Violation of this policy results in immediate removal.',
  },
  {
    q: 'How much can I earn?',
    a: 'Earnings vary by city, category, and experience. Estimates shown are based on active Buddies in popular cities. Actual earnings depend on bookings you receive. Figures are estimates only — payouts are not yet connected.',
  },
  {
    q: 'How does payment work?',
    a: 'Payouts are in development. For now, you set your rates and track estimates. Cash bookings are tracked in the app. Full payout infrastructure is coming soon.',
  },
  {
    q: 'How does verification work?',
    a: 'Applications are reviewed by our team within 3–5 business days. We review your profile, languages, and categories. Approved Buddies receive a verified badge.',
  },
  {
    q: 'What safety tools are available?',
    a: 'Every active booking has a safety screen: Report Traveler, End Booking Early, Flag Unpaid Cash, and an Emergency Button. Trust Scores are visible for all travellers.',
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      onPress={() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setOpen((v) => !v);
      }}
      style={faq.row}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
    >
      <View style={faq.header}>
        <Text style={faq.q}>{q}</Text>
        {open
          ? <ChevronUp size={16} color={color.mute} />
          : <ChevronDown size={16} color={color.mute} />}
      </View>
      {open && <Text style={faq.a}>{a}</Text>}
    </Pressable>
  );
}

export default function BecomeABuddy() {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={s.scroll}
      contentContainerStyle={{ paddingBottom: insets.bottom + 48 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Hero */}
      <View style={[s.hero, { paddingTop: insets.top + space.md }]}>
        <Pressable
          onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)}
          style={s.back}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <Stamp label="RENT A BUDDY" tone="onInk" rotate={-1} style={{ marginBottom: space.md }} />
        <Text style={s.heroTitle}>Become a Buddy</Text>
        <Text style={s.heroSub}>
          Share your city with travellers. Set your own schedule, earn on your terms.
        </Text>
      </View>

      {/* Earnings estimate */}
      <View style={s.section}>
        <TravelCard style={{ padding: space.xl }}>
          <Text style={s.kicker}>ESTIMATED EARNINGS</Text>
          <Text style={s.earnAmt}>$20 – $80 / hour</Text>
          <Text style={s.earnNote}>
            Based on active Buddies in popular cities. Actual earnings vary by city, category, and booking volume.
            Payouts are not yet connected — these are estimates only.
          </Text>
        </TravelCard>
      </View>

      {/* What Buddies offer */}
      <View style={s.section}>
        <Text style={s.secTitle}>What you can offer</Text>
        <View style={s.grid}>
          {CATEGORIES.map((c) => (
            <View key={c.label} style={s.catCard}>
              <Text style={s.catIcon}>{c.icon}</Text>
              <Text style={s.catLabel}>{c.label}</Text>
              <Text style={s.catDesc}>{c.desc}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Safety pillars */}
      <View style={s.section}>
        <Text style={s.secTitle}>Safety-first platform</Text>
        <View style={s.pillars}>
          {[
            {
              icon: '🚫',
              title: 'Strict non-dating policy',
              body: 'No romantic, sexual, or adult-service activities — ever. Violations are removed immediately and permanently.',
            },
            {
              icon: '⭐',
              title: 'Trust Scores visible',
              body: 'Every traveller has a Trust Score you can see before accepting. Read their reviews first.',
            },
            {
              icon: '🛡️',
              title: 'Safety tools in every booking',
              body: 'End Booking Early, Report Traveller, and an Emergency Button available during every active booking.',
            },
          ].map(({ icon, title, body }) => (
            <View key={title} style={s.pillarRow}>
              <Text style={s.pillarEmoji}>{icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.pillarTitle}>{title}</Text>
                <Text style={s.pillarBody}>{body}</Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      {/* How it works */}
      <View style={s.section}>
        <Text style={s.secTitle}>How it works</Text>
        {[
          { n: '1', title: 'Apply', body: 'Fill out a short form: your city, languages, categories, and rates.' },
          { n: '2', title: 'Review (3–5 days)', body: 'Our team reviews your application and activates your profile.' },
          { n: '3', title: 'Get bookings', body: 'Travellers find you via search. Accept requests from your dashboard.' },
          { n: '4', title: 'Track earnings', body: 'Monitor estimated earnings in your dashboard. Cash payout tools coming soon.' },
        ].map((step) => (
          <View key={step.n} style={s.stepRow}>
            <View style={s.stepBadge}>
              <Text style={s.stepN}>{step.n}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.stepTitle}>{step.title}</Text>
              <Text style={s.stepBody}>{step.body}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* FAQ */}
      <View style={s.section}>
        <Text style={s.secTitle}>Frequently asked</Text>
        <TravelCard padded={false}>
          {FAQS.map((f, i) => (
            <View
              key={i}
              style={i < FAQS.length - 1 ? { borderBottomWidth: 1, borderBottomColor: color.haze } : undefined}
            >
              <FaqItem q={f.q} a={f.a} />
            </View>
          ))}
        </TravelCard>
      </View>

      {/* CTA */}
      <View style={s.ctaSection}>
        <TravelButton
          label="Apply to become a Buddy"
          onPress={() => router.push('/(rent-a-buddy)/become/apply' as any)}
          variant="primary"
          full
        />
        <Text style={s.policyNote}>
          By applying you confirm your services will be strictly non-romantic and non-adult in nature.
          See Community Guidelines for full policy.
        </Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: color.paper },
  hero: {
    backgroundColor: color.ink,
    paddingHorizontal: space.xl,
    paddingBottom: space.xxl,
  },
  back: { marginBottom: space.xl },
  heroTitle: { ...t.hero, color: color.onInk, marginBottom: space.sm },
  heroSub: { ...t.body, color: color.onInkMute, lineHeight: 22 },
  section: { paddingHorizontal: space.lg, marginTop: space.xxl },
  secTitle: { ...t.heading, color: color.ink, marginBottom: space.lg },
  kicker: {
    fontFamily: 'Courier', fontSize: 10, fontWeight: '700',
    color: color.deep, letterSpacing: 2, marginBottom: space.sm,
  },
  earnAmt: { ...t.hero, color: color.ink, marginBottom: space.xs },
  earnNote: { ...t.small, color: color.mute, lineHeight: 18 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  catCard: {
    width: '47%',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: 4,
    ...shadow.card,
  },
  catIcon: { fontSize: 20 },
  catLabel: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  catDesc: { ...t.small, color: color.mute, lineHeight: 16 },
  pillars: { gap: space.lg },
  pillarRow: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  pillarEmoji: { fontSize: 22, width: 32, textAlign: 'center', marginTop: 1 },
  pillarTitle: { ...t.bodyStrong, color: color.ink, marginBottom: 2 },
  pillarBody: { ...t.small, color: color.mute, lineHeight: 17 },
  stepRow: {
    flexDirection: 'row', gap: space.md,
    alignItems: 'flex-start', marginBottom: space.lg,
  },
  stepBadge: {
    width: avatar.xsSm, height: avatar.xsSm, borderRadius: avatar.xsSm / 2,
    backgroundColor: color.signal,
    alignItems: 'center', justifyContent: 'center',
  },
  stepN: { fontFamily: 'Courier', fontSize: 13, fontWeight: '700', color: color.onInk },
  stepTitle: { ...t.bodyStrong, color: color.ink },
  stepBody: { ...t.small, color: color.mute, lineHeight: 17, marginTop: 2 },
  ctaSection: { paddingHorizontal: space.lg, marginTop: space.xxl, gap: space.md },
  policyNote: { ...t.small, color: color.haze, textAlign: 'center', lineHeight: 17 },
});

const faq = StyleSheet.create({
  row: { paddingHorizontal: space.lg, paddingVertical: space.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  q: { ...t.bodyStrong, color: color.ink, flex: 1, flexShrink: 1 },
  a: { ...t.small, color: color.mute, lineHeight: 18, marginTop: space.sm },
});
