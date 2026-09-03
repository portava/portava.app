/**
 * SharedContextScreen — the "Shared Context · YOU TWO" surface (spec §17/§18,
 * TABLE 4 "YOU TWO", TABLE 17/18/19).
 *
 * Renders the viewer↔owner overlap between the signed-in traveler (ME) and the
 * passport being viewed (THEM) as a set of EXPLAINABLE FACTS with a qualitative
 * summary LABEL ("Strong travel overlap"). Per §18 / TABLE 18 this is
 * deliberately NOT a dating-style numeric match score: no percentage, no
 * "/100", no compatibility number is ever rendered — only the contributing
 * facts and the label they add up to.
 *
 * The "See What You Could Do" CTA (§18) is the identity→action bridge: it hands
 * the permission-checked Compass-handoff seed (coarse shared city, tonight's
 * overlap window, shared intents — never coordinates or private history) to the
 * Compass ask surface (`/(tabs)/ai`, the same prefill-message entry other
 * surfaces use), which combines both permitted passport projections with live
 * Map intelligence to propose real experiences (§19 / TABLE 19 / §35).
 */
import React from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Users,
  MapPin,
  Clock,
  Globe2,
  Sparkles,
  Plane,
  Camera,
  Navigation,
  Compass as CompassIcon,
  Heart,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import {
  useSharedContext,
  buildCompassPrompt,
  type UseSharedContextResult,
} from './useSharedContext.ts';
import type {
  SharedContextProjection,
  SharedContextFact,
  SharedContextFactKey,
} from '../../services/passportSharedContext.ts';

// The canonical Compass ask surface. Handing a prefillMessage grounds the reply
// in the shared-context seed — the same handoff pattern MediaActionRail and the
// Layover screen use to reach Compass.
const COMPASS_ROUTE = '/(tabs)/ai';

/** Lucide glyph per fact key — colour is paired with text so it is never the
 *  only signal (§27: "Color is never the only status indicator"). */
function factIcon(key: SharedContextFactKey) {
  switch (key) {
    case 'both_in_city':
      return MapPin;
    case 'both_free_tonight':
      return Clock;
    case 'mutual_follows':
      return Users;
    case 'shared_cities':
      return Globe2;
    case 'intent_overlap':
      return Heart;
    case 'shared_trips':
      return Plane;
    case 'both_going_to':
      return Navigation;
    case 'shared_moments':
      return Camera;
    default:
      return Sparkles;
  }
}

// ── Fact row ─────────────────────────────────────────────────────────────────

function FactRow({ fact }: { fact: SharedContextFact }) {
  const Glyph = factIcon(fact.key);
  return (
    <View
      style={s.factRow}
      accessibilityRole="text"
      accessibilityLabel={`${fact.label}${fact.detail ? `, ${fact.detail}` : ''}`}
    >
      <View style={s.factIcon}>
        <Glyph size={icon.s18} color={color.deep} />
      </View>
      <View style={s.factText}>
        <Text style={s.factLabel} numberOfLines={2}>
          {fact.label}
        </Text>
        {fact.detail ? (
          <Text style={s.factDetail} numberOfLines={2}>
            {fact.detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({ ctx }: { ctx: SharedContextProjection }) {
  return (
    <View style={s.summaryCard} accessibilityLabel={`Shared context: ${ctx.summaryLabel}`}>
      <View style={s.summaryIcon}>
        <Users size={icon.s22} color={color.paper} />
      </View>
      {/* The qualitative label — NOT a numeric match score (§18 / TABLE 18). */}
      <Text style={s.summaryLabel}>{ctx.summaryLabel}</Text>
      <Text style={s.summarySub}>
        Based on what you&apos;re both comfortable sharing — never a match score.
      </Text>
    </View>
  );
}

// ── State views ──────────────────────────────────────────────────────────────

function LoadingView() {
  return (
    <View style={s.center}>
      <ActivityIndicator color={color.signal} />
      <Text style={s.centerText}>Finding what you share…</Text>
    </View>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={s.center}>
      <Users size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>Couldn&apos;t load shared context</Text>
      <Text style={s.centerText}>{message}</Text>
      <Pressable style={s.retryBtn} onPress={onRetry} accessibilityRole="button">
        <Text style={s.retryText}>Tap to retry</Text>
      </Pressable>
    </View>
  );
}

function EmptyView() {
  return (
    <View style={s.center}>
      <Users size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>No shared context yet</Text>
      <Text style={s.centerText}>
        As you follow the same people, visit the same cities, or plan
        overlapping trips, the context you two share will appear here.
      </Text>
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export interface SharedContextScreenProps {
  /** The OTHER traveler's id (the passport being viewed). */
  userId?: string;
  /** Optional display name of the other traveler, for the CTA prompt + header. */
  otherName?: string;
  /** Test seam: inject the hook result to bypass the network. */
  hookOverride?: UseSharedContextResult;
}

export default function SharedContextScreen({
  userId,
  otherName,
  hookOverride,
}: SharedContextScreenProps) {
  const insets = useSafeAreaInsets();
  const real = useSharedContext(userId);
  const hook = hookOverride ?? real;

  const { data, reason, loading, error } = hook;
  const hasOverlap = !!data && data.facts.length > 0;
  const canHandoff = !!data && data.compassHandoff.eligible;

  function openCompass(): void {
    if (!data) return;
    router.push({
      pathname: COMPASS_ROUTE,
      params: { prefillMessage: buildCompassPrompt(data, otherName) },
    } as never);
  }

  const headerTitle = otherName?.trim()
    ? `You & ${otherName.trim()}`
    : 'Shared Context';

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable
          style={s.backBtn}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={icon.s20} color={color.ink} />
        </Pressable>
        <View style={s.titleRow}>
          <Users size={icon.s16} color={color.deep} />
          <Text style={s.title} numberOfLines={1}>
            {headerTitle}
          </Text>
        </View>
        <View style={s.backBtn} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[
          s.scrollContent,
          { paddingBottom: insets.bottom + space.xxl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.subtitle}>What you two have in common</Text>

        {loading ? (
          <LoadingView />
        ) : error ? (
          <ErrorView message={error} onRetry={hook.reload} />
        ) : reason === 'self' ? (
          <View style={s.center}>
            <Users size={icon.s26} color={color.faint} />
            <Text style={s.centerTitle}>This is your own passport</Text>
            <Text style={s.centerText}>
              Shared context is calculated between you and another traveler.
            </Text>
          </View>
        ) : !hasOverlap ? (
          <EmptyView />
        ) : (
          <>
            <SummaryCard ctx={data} />

            {/* Explainable contributing facts (TABLE 17) */}
            <View style={s.facts}>
              {data.facts.map((f) => (
                <FactRow key={f.key} fact={f} />
              ))}
            </View>

            {/* §18 — See What You Could Do (Compass handoff) */}
            {canHandoff ? (
              <>
                <Pressable
                  style={s.ctaBtn}
                  onPress={openCompass}
                  accessibilityRole="button"
                  accessibilityLabel="See what you could do — ask Compass"
                >
                  <CompassIcon size={icon.s18} color={color.paper} />
                  <Text style={s.ctaText}>See What You Could Do</Text>
                </Pressable>
                <Text style={s.ctaHint}>
                  Compass turns what you share into a few things you could do
                  together.
                </Text>
              </>
            ) : (
              <Text style={s.ctaHint}>
                When you&apos;re both free and open to plans, Compass can suggest
                things to do together.
              </Text>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.sm,
  },
  backBtn: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  title: {
    ...t.title,
    fontSize: 17,
    color: color.ink,
  },
  subtitle: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.lg,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: space.sm },

  // Summary card
  summaryCard: {
    alignItems: 'center',
    marginHorizontal: space.lg,
    marginTop: space.md,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    gap: space.xs,
  },
  summaryIcon: {
    width: avatar.s48,
    height: avatar.s48,
    borderRadius: avatar.s48 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.deep,
    marginBottom: space.xs,
  },
  summaryLabel: {
    ...t.title,
    color: color.ink,
    textAlign: 'center',
  },
  summarySub: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    paddingHorizontal: space.md,
  },

  // Facts
  facts: {
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  factRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  factIcon: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
  },
  factText: {
    flex: 1,
    gap: 2,
  },
  factLabel: {
    ...t.bodyStrong,
    color: color.ink,
  },
  factDetail: {
    ...t.small,
    color: color.mute,
  },

  // CTA
  ctaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
  },
  ctaText: {
    ...t.bodyStrong,
    color: color.paper,
    fontSize: 15,
  },
  ctaHint: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    marginTop: space.sm,
    paddingHorizontal: space.xl,
  },

  // States
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: space.xxxl,
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  centerTitle: {
    ...t.bodyStrong,
    color: color.ink,
    marginTop: space.xs,
    textAlign: 'center',
  },
  centerText: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.signal,
    fontSize: 14,
  },
});
