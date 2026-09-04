/**
 * PassportHomePreviews — the §3 "high-priority previews" band for Passport Home
 * (TABLE 4: "YOU TWO → Shared context … RECENT STAMPS · FEATURED JOURNEY ·
 * NEXT TRIP · MEMORIES").
 *
 * One component serves both Passport Home contexts:
 *  - OWNER  (app/(tabs)/passport.tsx): the four travel previews near the top.
 *  - VIEWER (app/passport/[username].tsx): the same previews PLUS the two
 *    viewer-relationship affordances the spec puts first — a primary
 *    "Make a Plan" action (§18, gated on capabilities.actions.can_make_plan —
 *    the SERVER owns eligibility, the client only renders the flag, §30) and a
 *    "YOU TWO" Shared-Context entry that opens SharedContextScreen (§17).
 *
 * Everything is read from the single /passport/:userId/projection aggregate
 * (§4/§21/§30): the server has already privacy-filtered every array before it
 * reaches here, so the client never re-derives visibility. The band FAILS SOFT
 * — if the projection can't load it renders nothing rather than disrupting the
 * page. Media uses CachedImage (never a bare <Image source={{uri}}>).
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
  Award,
  Route as RouteIcon,
  CalendarClock,
  Camera,
  Users,
  Compass as CompassIcon,
  ChevronRight,
  MapPin,
  BadgeCheck,
} from 'lucide-react-native';
import { CachedImage } from '../CachedImage.tsx';
import { PP, fmtMonthYear } from '../../theme/passportTokens.ts';
import { space, radius, type as t, icon, avatar } from '../../theme/tokens.ts';
import { usePassportProjection, type UsePassportProjectionResult } from '../../hooks/usePassportProjection.ts';
import type {
  PassportStampView,
  PassportFeaturedJourneyView,
  PassportMemoryView,
  PlanProjection,
} from '../../services/passportProjection.ts';

// The canonical Compass ask surface — a prefillMessage grounds the reply in the
// make-a-plan intent (same handoff pattern SharedContextScreen uses).
const COMPASS_ROUTE = '/(tabs)/ai';

// ── Small helpers ─────────────────────────────────────────────────────────────

function placeLabel(city: string | null, country: string | null): string | null {
  const parts = [city, country].filter((x): x is string => !!x && x.length > 0);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function planDates(plan: PlanProjection): string | null {
  const s = fmtMonthYear(plan.startDate);
  const e = fmtMonthYear(plan.endDate);
  if (s && e && s !== e) return `${s} – ${e}`;
  return s || e || null;
}

// ── Section shell ─────────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return <Text style={s.sectionLabel}>{label}</Text>;
}

// ── Recent stamps (§3 · §12 verification-aware) ───────────────────────────────

function StampChip({ stamp }: { stamp: PassportStampView }) {
  const place = placeLabel(stamp.city, stamp.country);
  // §12: only a server-confirmed 'verified' stamp gets the verified mark; a
  // decorative/reported stamp must never visually impersonate a verified one.
  const verified = stamp.verification === 'verified';
  return (
    <View style={s.stampChip} accessibilityRole="image" accessibilityLabel={`${stamp.name ?? 'Stamp'}${place ? `, ${place}` : ''}`}>
      <View style={s.stampArt}>
        {stamp.artworkUrl ? (
          <CachedImage source={{ uri: stamp.artworkUrl }} style={s.stampArtImg} fallbackLabel="" />
        ) : (
          <Award size={icon.s20} color={PP.gold} />
        )}
      </View>
      <View style={s.stampNameRow}>
        <Text style={s.stampName} numberOfLines={1}>{stamp.name ?? place ?? 'Stamp'}</Text>
        {verified ? <BadgeCheck size={icon.s14} color="#22A06B" /> : null}
      </View>
      {place ? <Text style={s.stampPlace} numberOfLines={1}>{place}</Text> : null}
    </View>
  );
}

// ── Featured journey (§14) ────────────────────────────────────────────────────

function FeaturedJourneyCard({
  journey,
  isOwner,
}: {
  journey: PassportFeaturedJourneyView;
  isOwner: boolean;
}) {
  const place = placeLabel(journey.city, journey.country);
  // Journeys is an owner-only surface today; a viewer's card is display-only.
  const onPress = isOwner ? () => router.push('/passport/journeys' as never) : undefined;
  const Wrapper: any = onPress ? Pressable : View;
  return (
    <Wrapper
      style={s.card}
      onPress={onPress}
      testID="passport-preview-featured-journey"
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`Featured journey: ${journey.title}`}
    >
      <View style={s.cardIcon}><RouteIcon size={icon.s18} color={PP.ink} /></View>
      <View style={{ flex: 1 }}>
        <Text style={s.cardTitle} numberOfLines={1}>{journey.title}</Text>
        <Text style={s.cardSub} numberOfLines={1}>
          {[place, journey.durationLabel].filter(Boolean).join(' · ') || 'Featured journey'}
        </Text>
      </View>
      {onPress ? <ChevronRight size={icon.s18} color={PP.inkMuted} /> : null}
    </Wrapper>
  );
}

// ── Next trip (§16) ───────────────────────────────────────────────────────────

function NextTripCard({ plan }: { plan: PlanProjection }) {
  const place = placeLabel(plan.destinationCity, plan.destinationCountry);
  const dates = planDates(plan);
  return (
    <Pressable
      style={s.card}
      onPress={() => router.push(`/trip/${plan.tripId}` as never)}
      testID="passport-preview-next-trip"
      accessibilityRole="button"
      accessibilityLabel={`Next trip: ${plan.title}${place ? `, ${place}` : ''}`}
    >
      <View style={s.cardIcon}><CalendarClock size={icon.s18} color={PP.ink} /></View>
      <View style={{ flex: 1 }}>
        <Text style={s.cardTitle} numberOfLines={1}>{plan.title}</Text>
        <Text style={s.cardSub} numberOfLines={1}>
          {[place, dates].filter(Boolean).join(' · ') || 'Upcoming trip'}
        </Text>
      </View>
      <ChevronRight size={icon.s18} color={PP.inkMuted} />
    </Pressable>
  );
}

// ── Memory thumb (§15) ────────────────────────────────────────────────────────

function MemoryThumb({ memory }: { memory: PassportMemoryView }) {
  const place = placeLabel(memory.city, memory.country);
  return (
    <Pressable
      style={s.memoryThumb}
      onPress={() => router.push(`/memory/${memory.id}` as never)}
      accessibilityRole="button"
      accessibilityLabel={`Memory: ${memory.title ?? place ?? 'Memory'}`}
    >
      <View style={s.memoryImgWrap}>
        {memory.photoUrl ? (
          <CachedImage source={{ uri: memory.photoUrl }} style={s.memoryImg} fallbackLabel="" />
        ) : (
          <View style={[s.memoryImg, s.memoryImgEmpty]}><Camera size={icon.s18} color={PP.inkMuted} /></View>
        )}
      </View>
      <Text style={s.memoryTitle} numberOfLines={1}>{memory.title ?? place ?? 'Memory'}</Text>
    </Pressable>
  );
}

// ── Main band ─────────────────────────────────────────────────────────────────

export interface PassportHomePreviewsProps {
  /** The traveler whose Passport Home this is (owner id, or the viewed id). */
  userId: string | null | undefined;
  isOwner: boolean;
  /** Display name of the viewed traveler — used in the Compass/shared-context CTA. */
  otherName?: string | null;
  /**
   * Shared/injected projection. When provided, the internal fetch is skipped
   * (pass this from a parent that already loaded the aggregate, or from a test).
   */
  hookOverride?: UsePassportProjectionResult;
}

export function PassportHomePreviews({
  userId,
  isOwner,
  otherName,
  hookOverride,
}: PassportHomePreviewsProps) {
  // Only self-fetch when no projection was handed in (avoids a double request in
  // the viewer screen, and keeps injected-data tests off the network).
  const internal = usePassportProjection(hookOverride ? null : userId);
  const hook = hookOverride ?? internal;
  const data = hook.data;

  // Fail soft: nothing to preview → render nothing (never disrupts the page).
  if (!data) return null;

  const stamps = data.recentStamps.slice(0, 8);
  const memories = data.memories.slice(0, 8);
  const nextTrip = data.upcomingPlans[0] ?? null;
  const featured = data.featuredJourney;
  const canMakePlan = !isOwner && data.actions.can_make_plan === true;
  const showSharedContext = !isOwner;
  const sc = data.sharedContext;

  // Owner with no previewable content yet → render nothing rather than an empty
  // shell (the owner's full sections/tabs live below).
  const hasAnyContent =
    stamps.length > 0 || memories.length > 0 || !!nextTrip || !!featured;
  if (isOwner && !hasAnyContent) return null;

  const ctaName = otherName?.trim() || 'this traveler';

  function openMakeAPlan(): void {
    router.push({
      pathname: COMPASS_ROUTE,
      params: { prefillMessage: `Help me make a plan to do something with ${ctaName}.` },
    } as never);
  }

  function openSharedContext(): void {
    const id = (userId ?? '').trim();
    if (!id) return;
    const name = otherName?.trim();
    router.push(
      `/passport/shared-context?userId=${encodeURIComponent(id)}${name ? `&name=${encodeURIComponent(name)}` : ''}` as never,
    );
  }

  return (
    <View style={s.root} testID="passport-home-previews">
      {/* ── Viewer primary action: Make a Plan (§18) ── */}
      {canMakePlan ? (
        <Pressable
          style={s.makePlanBtn}
          onPress={openMakeAPlan}
          testID="passport-make-a-plan"
          accessibilityRole="button"
          accessibilityLabel="Make a plan"
        >
          <CompassIcon size={icon.s18} color={PP.paper} />
          <Text style={s.makePlanText}>Make a Plan</Text>
        </Pressable>
      ) : null}

      {/* ── YOU TWO — Shared Context entry (§17) ── */}
      {showSharedContext ? (
        <Pressable
          style={s.youTwoCard}
          onPress={openSharedContext}
          testID="passport-shared-context-entry"
          accessibilityRole="button"
          accessibilityLabel="See what you could do — shared context"
        >
          <View style={s.youTwoIcon}><Users size={icon.s18} color={PP.paper} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.youTwoLabel}>YOU TWO</Text>
            <Text style={s.youTwoTitle} numberOfLines={1}>
              {sc && sc.factCount > 0 ? sc.summaryLabel : 'See what you could do'}
            </Text>
            {sc && sc.facts[0]?.label ? (
              <Text style={s.youTwoSub} numberOfLines={1}>{sc.facts[0].label}</Text>
            ) : (
              <Text style={s.youTwoSub} numberOfLines={1}>Shared context + things to do together</Text>
            )}
          </View>
          <ChevronRight size={icon.s18} color={PP.inkMuted} />
        </Pressable>
      ) : null}

      {/* ── Recent stamps (§3) ── */}
      {stamps.length > 0 ? (
        <View testID="passport-preview-stamps" style={s.section}>
          <SectionHeader label="RECENT STAMPS" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.hstrip}>
            {stamps.map((st, i) => (
              <StampChip key={`${st.name ?? 'stamp'}-${i}`} stamp={st} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* ── Featured journey (§14) ── */}
      {featured ? (
        <View style={s.section}>
          <SectionHeader label="FEATURED JOURNEY" />
          <FeaturedJourneyCard journey={featured} isOwner={isOwner} />
        </View>
      ) : null}

      {/* ── Next trip (§16) ── */}
      {nextTrip ? (
        <View style={s.section}>
          <SectionHeader label="NEXT TRIP" />
          <NextTripCard plan={nextTrip} />
        </View>
      ) : null}

      {/* ── Memories (§15) ── */}
      {memories.length > 0 ? (
        <View testID="passport-preview-memories" style={s.section}>
          <SectionHeader label="MEMORIES" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.hstrip}>
            {memories.map((m) => (
              <MemoryThumb key={m.id} memory={m} />
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

// ── Viewer Memories/Plans lists (F3) ──────────────────────────────────────────
//
// The public-passport tabs previously hardcoded empty Memories/Plans. That is a
// GAP, not privacy-correctness: the /projection aggregate already returns the
// items THIS viewer is permitted to see (per-item memory visibility §15;
// per-plan visibility §16 / TABLE 24, which defaults Plans to private/followers).
// These read-only lists render exactly those permitted items — so a permitted
// viewer (follower/crew) sees content, and an unpermitted/public viewer gets a
// clear empty state because the server returned nothing, not because the client
// dropped it.

export function PassportViewerMemoriesList({
  memories,
  loading,
}: {
  memories: PassportMemoryView[];
  loading?: boolean;
}) {
  if (loading && memories.length === 0) {
    return <View style={s.listCenter}><ActivityIndicator color={PP.ink} /></View>;
  }
  if (memories.length === 0) {
    return (
      <View style={s.listEmpty} testID="viewer-memories-empty">
        <Camera size={icon.s24} color={PP.inkMuted} />
        <Text style={s.listEmptyTitle}>No memories to show</Text>
        <Text style={s.listEmptySub}>
          Only memories this traveler has shared with you appear here.
        </Text>
      </View>
    );
  }
  return (
    <View style={s.memoryGrid} testID="viewer-memories-list">
      {memories.map((m) => (
        <View key={m.id} style={s.memoryGridItem}>
          <MemoryThumb memory={m} />
        </View>
      ))}
    </View>
  );
}

export function PassportViewerPlansList({
  plans,
  loading,
}: {
  plans: PlanProjection[];
  loading?: boolean;
}) {
  if (loading && plans.length === 0) {
    return <View style={s.listCenter}><ActivityIndicator color={PP.ink} /></View>;
  }
  if (plans.length === 0) {
    return (
      <View style={s.listEmpty} testID="viewer-plans-empty">
        <CalendarClock size={icon.s24} color={PP.inkMuted} />
        <Text style={s.listEmptyTitle}>No upcoming plans to show</Text>
        <Text style={s.listEmptySub}>
          Plans are private by default — you&apos;ll see the ones this traveler shares with you.
        </Text>
      </View>
    );
  }
  return (
    <View style={s.planList} testID="viewer-plans-list">
      {plans.map((plan) => {
        const place = placeLabel(plan.destinationCity, plan.destinationCountry);
        const dates = planDates(plan);
        return (
          <Pressable
            key={plan.tripId}
            style={s.card}
            onPress={() => router.push(`/trip/${plan.tripId}` as never)}
            accessibilityRole="button"
            accessibilityLabel={`Plan: ${plan.title}${place ? `, ${place}` : ''}`}
          >
            <View style={s.cardIcon}><MapPin size={icon.s18} color={PP.ink} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle} numberOfLines={1}>{plan.title}</Text>
              <Text style={s.cardSub} numberOfLines={1}>
                {[place, dates].filter(Boolean).join(' · ') || 'Upcoming trip'}
              </Text>
            </View>
            <ChevronRight size={icon.s18} color={PP.inkMuted} />
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { paddingHorizontal: 16, paddingTop: space.md, gap: space.md },
  section: { gap: space.sm },
  sectionLabel: {
    fontSize: 11, letterSpacing: 1.2, fontWeight: '700',
    color: PP.inkMuted, textTransform: 'uppercase',
  },
  hstrip: { gap: space.sm, paddingRight: space.sm },

  // Make a Plan
  makePlanBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, paddingVertical: 12, borderRadius: radius.pill,
    backgroundColor: PP.ink,
  },
  makePlanText: { ...t.bodyStrong, color: PP.paper, fontSize: 15 },

  // YOU TWO
  youTwoCard: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: PP.paper, borderRadius: radius.md,
    borderWidth: 1, borderColor: PP.border,
    paddingHorizontal: space.md, paddingVertical: space.md,
  },
  youTwoIcon: {
    width: avatar.s40, height: avatar.s40, borderRadius: avatar.s40 / 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: PP.ink,
  },
  youTwoLabel: { fontSize: 10, letterSpacing: 1.4, fontWeight: '700', color: PP.inkMuted },
  youTwoTitle: { ...t.bodyStrong, color: PP.ink, marginTop: 1 },
  youTwoSub: { ...t.small, color: PP.inkMuted, marginTop: 1 },

  // Cards (featured journey / next trip / plan row)
  card: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: PP.paper, borderRadius: radius.md,
    borderWidth: 1, borderColor: PP.borderLight,
    paddingHorizontal: space.md, paddingVertical: space.md,
  },
  cardIcon: {
    width: avatar.s40, height: avatar.s40, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', backgroundColor: PP.paperDeep,
  },
  cardTitle: { ...t.bodyStrong, color: PP.ink },
  cardSub: { ...t.small, color: PP.inkMuted, marginTop: 2 },

  // Stamp chip
  stampChip: {
    width: 96, alignItems: 'center', gap: 4,
    backgroundColor: PP.paper, borderRadius: radius.sm,
    borderWidth: 1, borderColor: PP.borderLight, padding: space.sm,
  },
  stampArt: {
    width: avatar.s48, height: avatar.s48, borderRadius: avatar.s48 / 2,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: PP.goldLight, overflow: 'hidden',
  },
  stampArtImg: { width: avatar.s48, height: avatar.s48, borderRadius: avatar.s48 / 2 },
  stampNameRow: { flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: 88 },
  stampName: { fontSize: 12, fontWeight: '700', color: PP.ink, flexShrink: 1 },
  stampPlace: { fontSize: 10, color: PP.inkMuted },

  // Memory thumb
  memoryThumb: { width: 112, gap: 4 },
  memoryImgWrap: { width: 112, height: 112, borderRadius: radius.sm, overflow: 'hidden' },
  memoryImg: { width: 112, height: 112, borderRadius: radius.sm },
  memoryImgEmpty: {
    backgroundColor: PP.paperDeep, alignItems: 'center', justifyContent: 'center',
  },
  memoryTitle: { fontSize: 12, fontWeight: '600', color: PP.ink },

  // Viewer lists
  listCenter: { paddingVertical: space.xxl, alignItems: 'center' },
  listEmpty: { paddingVertical: space.xxl, paddingHorizontal: space.xl, alignItems: 'center', gap: space.sm },
  listEmptyTitle: { ...t.bodyStrong, color: PP.ink, marginTop: space.xs },
  listEmptySub: { ...t.small, color: PP.inkMuted, textAlign: 'center' },
  memoryGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: space.md,
    paddingHorizontal: 16, paddingTop: space.sm,
  },
  memoryGridItem: {},
  planList: { paddingHorizontal: 16, paddingTop: space.sm, gap: space.sm },
});
