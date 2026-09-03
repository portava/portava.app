/**
 * PlansScreen — the Plans Passport surface (spec §16 + TABLE 24).
 *
 * Renders `projection.upcomingPlans` (already visibility-filtered server-side).
 *
 *   • OWN passport (self): each plan carries a PER-PLAN visibility control
 *     (Private / Buddies / Invite / Public) — TABLE 24 defaults plans to
 *     private/followers, and the owner chooses who sees each one. Changes are
 *     written per-plan via the trips API.
 *   • ANOTHER passport: the visible plans are read-only. Trip overlap is
 *     computed against the viewer's own plans ("You'll both be in Bangkok Sep
 *     14–17", §16) and a "Connect for {city}" action is offered when the
 *     server-projected `can_make_plan` flag permits it (§30 — the client never
 *     re-derives that policy).
 *
 * The screen draws its own header (root Stack is headerShown:false), matching
 * the sibling My World surface.
 */
import React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  CalendarClock,
  MapPin,
  Lock,
  Users,
  Globe2,
  Ticket,
  Sparkles,
  Plane,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import type { TripVisibility } from '../../types/models.ts';
import type { PlanProjection } from '../../services/passportProjection.ts';
import {
  usePassportPlans,
  formatTripDateRange,
  type TripOverlap,
  type UsePassportPlansResult,
} from './usePassportPlans.ts';

const VIS_OPTIONS: { value: TripVisibility; label: string; Icon: typeof Lock }[] = [
  { value: 'private', label: 'Private', Icon: Lock },
  { value: 'buddies', label: 'Buddies', Icon: Users },
  { value: 'invite', label: 'Invite', Icon: Ticket },
  { value: 'public', label: 'Public', Icon: Globe2 },
];

function visibilityLabel(v: string): string {
  return VIS_OPTIONS.find((o) => o.value === v)?.label ?? 'Private';
}

// ── Per-plan visibility control (owner only) ─────────────────────────────────

function VisibilityControl({
  current,
  onChange,
}: {
  current: string;
  onChange: (v: TripVisibility) => void;
}) {
  return (
    <View style={s.visRow} accessibilityLabel={`Plan visibility: ${visibilityLabel(current)}`}>
      {VIS_OPTIONS.map(({ value, label, Icon }) => {
        const active = value === current;
        return (
          <Pressable
            key={value}
            style={[s.visPill, active && s.visPillActive]}
            onPress={() => {
              if (!active) onChange(value);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Set visibility to ${label}`}
          >
            <Icon size={icon.s14} color={active ? color.paper : color.mute} />
            <Text style={[s.visPillText, active && s.visPillTextActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Plan card ────────────────────────────────────────────────────────────────

function PlanCard({
  plan,
  editable,
  onChangeVisibility,
}: {
  plan: PlanProjection;
  editable: boolean;
  onChangeVisibility?: (v: TripVisibility) => void;
}) {
  const place = [plan.destinationCity, plan.destinationCountry].filter(Boolean).join(', ');
  const dates = formatTripDateRange(plan.startDate, plan.endDate);
  return (
    <View style={s.planCard}>
      <View style={s.planHeader}>
        <View style={s.planIcon}>
          <Plane size={icon.s16} color={color.deep} />
        </View>
        <View style={s.planTitleWrap}>
          <Text style={s.planTitle} numberOfLines={1}>
            {plan.title}
          </Text>
          {place ? (
            <View style={s.planMetaRow}>
              <MapPin size={icon.s14} color={color.mute} />
              <Text style={s.planMeta} numberOfLines={1}>
                {place}
              </Text>
            </View>
          ) : null}
        </View>
        {!editable ? (
          <View style={s.visBadge}>
            <Text style={s.visBadgeText}>{visibilityLabel(plan.visibility)}</Text>
          </View>
        ) : null}
      </View>

      {dates ? (
        <View style={s.planDates}>
          <CalendarClock size={icon.s14} color={color.mute} />
          <Text style={s.planDatesText}>{dates}</Text>
        </View>
      ) : null}

      {editable && onChangeVisibility ? (
        <>
          <Text style={s.visLabel}>Who can see this plan</Text>
          <VisibilityControl current={plan.visibility} onChange={onChangeVisibility} />
        </>
      ) : null}
    </View>
  );
}

// ── Overlap banner (other viewer) ────────────────────────────────────────────

function OverlapCard({
  overlap,
  canConnect,
  onConnect,
}: {
  overlap: TripOverlap;
  canConnect: boolean;
  onConnect: () => void;
}) {
  return (
    <View style={s.overlapCard}>
      <View style={s.overlapHeader}>
        <Sparkles size={icon.s18} color={color.deep} />
        <Text style={s.overlapText}>{overlap.label}</Text>
      </View>
      {canConnect ? (
        <Pressable
          style={s.connectBtn}
          onPress={onConnect}
          accessibilityRole="button"
          accessibilityLabel={`Connect for ${overlap.city}`}
        >
          <Text style={s.connectText}>Connect for {overlap.city}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── States ───────────────────────────────────────────────────────────────────

function LoadingView() {
  return (
    <View style={s.center}>
      <ActivityIndicator color={color.signal} />
      <Text style={s.centerText}>Loading plans…</Text>
    </View>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={s.center}>
      <CalendarClock size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>Couldn&apos;t load plans</Text>
      <Text style={s.centerText}>{message}</Text>
      <Pressable style={s.retryBtn} onPress={onRetry} accessibilityRole="button" accessibilityLabel="Tap to retry">
        <Text style={s.retryText}>Tap to retry</Text>
      </Pressable>
    </View>
  );
}

function EmptyView({ isSelf }: { isSelf: boolean }) {
  return (
    <View style={s.center}>
      <Plane size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>{isSelf ? 'No upcoming plans yet' : 'No shared plans'}</Text>
      <Text style={s.centerText}>
        {isSelf
          ? 'Add a trip to your passport and choose who can see it. Plans stay private until you share them.'
          : 'There are no upcoming plans you can see here.'}
      </Text>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export interface PlansScreenProps {
  /** Passport being viewed (UUID/@handle); null ⇒ own plans. */
  targetUserId: string | null;
  /** Signed-in viewer's id (self detection + overlap). */
  viewerUserId: string | null;
  /** Connect handoff (§18). Defaults to the Telegraph "new" coordination flow. */
  onConnect?: (overlap: TripOverlap) => void;
  /** Test seam: inject a prebuilt hook result to bypass the network. */
  stateOverride?: UsePassportPlansResult;
}

function defaultConnect(targetUserId: string | null, overlap: TripOverlap): void {
  router.push({
    pathname: '/telegraph/new',
    params: { userId: targetUserId ?? '', city: overlap.city },
  } as never);
}

export default function PlansScreen({ targetUserId, viewerUserId, onConnect, stateOverride }: PlansScreenProps) {
  const insets = useSafeAreaInsets();
  const hook = usePassportPlans({ targetUserId, viewerUserId });
  const vm = stateOverride ?? hook;

  const connect = (overlap: TripOverlap) => {
    if (onConnect) onConnect(overlap);
    else defaultConnect(targetUserId, overlap);
  };

  const showEmpty = !vm.loading && !vm.error && vm.plans.length === 0 && vm.overlaps.length === 0;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
          <ArrowLeft size={icon.s20} color={color.ink} />
        </Pressable>
        <View style={s.titleRow}>
          <CalendarClock size={icon.s16} color={color.deep} />
          <Text style={s.title} numberOfLines={1}>
            Plans
          </Text>
        </View>
        <View style={s.backBtn} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + space.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.subtitle}>
          {vm.isSelf ? 'Where your story is headed' : "Upcoming travel you're permitted to see"}
        </Text>

        {vm.loading ? (
          <LoadingView />
        ) : vm.error ? (
          <ErrorView message={vm.error} onRetry={vm.reload} />
        ) : showEmpty ? (
          <EmptyView isSelf={vm.isSelf} />
        ) : (
          <>
            {/* Trip overlap (other viewer) */}
            {vm.overlaps.length > 0 ? (
              <View style={s.overlaps}>
                {vm.overlaps.map((o) => (
                  <OverlapCard key={o.tripId} overlap={o} canConnect={vm.canMakePlan} onConnect={() => connect(o)} />
                ))}
              </View>
            ) : null}

            {/* Owner privacy note */}
            {vm.isSelf ? (
              <View style={s.privacyNote}>
                <Lock size={icon.s14} color={color.mute} />
                <Text style={s.privacyText}>
                  Plans are private by default. You choose who can see each one.
                </Text>
              </View>
            ) : null}

            {vm.mutationError ? <Text style={s.mutationError}>{vm.mutationError}</Text> : null}

            {/* Plans list */}
            <View style={s.plans}>
              {vm.plans.map((p) => (
                <PlanCard
                  key={p.tripId}
                  plan={p}
                  editable={vm.isSelf}
                  onChangeVisibility={vm.isSelf ? (v) => vm.updatePlanVisibility(p.tripId, v) : undefined}
                />
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
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
  titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs },
  title: { ...t.title, fontSize: 17, color: color.ink },
  subtitle: { ...t.small, color: color.mute, textAlign: 'center', paddingVertical: space.xs, paddingHorizontal: space.lg },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: space.sm },

  // Overlaps
  overlaps: { paddingHorizontal: space.lg, marginTop: space.sm, gap: space.sm },
  overlapCard: {
    backgroundColor: 'rgba(10,61,74,0.06)',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(10,61,74,0.18)',
    padding: space.md,
    gap: space.sm,
  },
  overlapHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  overlapText: { ...t.bodyStrong, color: color.deep, flexShrink: 1 },
  connectBtn: {
    alignSelf: 'flex-start',
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: color.deep,
  },
  connectText: { ...t.bodyStrong, color: color.paper, fontSize: 14 },

  // Privacy note
  privacyNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    marginTop: space.md,
    paddingHorizontal: space.lg,
  },
  privacyText: { ...t.small, color: color.mute, fontSize: 12, flexShrink: 1, textAlign: 'center' },
  mutationError: { ...t.small, color: color.signal, textAlign: 'center', marginTop: space.sm },

  // Plans
  plans: { marginTop: space.lg, paddingHorizontal: space.lg, gap: space.md },
  planCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
  },
  planHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  planIcon: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(10,61,74,0.08)',
  },
  planTitleWrap: { flex: 1, gap: 2 },
  planTitle: { ...t.heading, color: color.ink, fontSize: 16 },
  planMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  planMeta: { ...t.small, color: color.mute, flexShrink: 1 },
  visBadge: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
  },
  visBadgeText: { ...t.small, color: color.mute, fontSize: 11, fontWeight: '700' },
  planDates: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  planDatesText: { ...t.small, color: color.mute, fontFamily: 'Courier' },

  visLabel: { ...t.small, color: color.faint, fontSize: 12, marginTop: space.xs },
  visRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  visPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  visPillActive: { backgroundColor: color.deep, borderColor: color.deep },
  visPillText: { ...t.small, color: color.mute, fontSize: 12, fontWeight: '600' },
  visPillTextActive: { color: color.paper },

  // States
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: space.xxxl, paddingHorizontal: space.xl, gap: space.sm },
  centerTitle: { ...t.bodyStrong, color: color.ink, marginTop: space.xs },
  centerText: { ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn: {
    marginTop: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  retryText: { ...t.bodyStrong, color: color.signal, fontSize: 14 },
});
