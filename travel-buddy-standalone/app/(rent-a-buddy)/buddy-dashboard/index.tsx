import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, Switch, RefreshControl, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Calendar, Star, TrendingUp, Shield, Bell, Clock,
  ChevronRight, CheckCircle, Circle, ArrowLeft,
} from 'lucide-react-native';
import {
  TravelCard, TravelSectionHeader, TravelLoadingState, TravelErrorState,
  TravelEmptyState, TravelButton,
} from '../../../src/components/primitives';
import { Stamp } from '../../../src/components/ui';
import { color, space, radius, type as t, shadow, avatar } from '../../../src/theme/tokens';
import * as rentABuddy from '../../../src/services/rentABuddy';
import type { BuddyDashboardSummary, BuddyBooking, ChecklistItem } from '../../../src/services/rentABuddy';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

function StatusBanner({ status }: { status: string }) {
  if (status === 'active') return null;
  const map: Record<string, { color: string; bg: string; label: string; sub: string }> = {
    pending: {
      color: color.warn, bg: '#FFF8ED',
      label: 'Application under review',
      sub: 'Our team is reviewing your application (3–5 days). You\'ll be notified when approved.',
    },
    under_review: {
      color: color.warn, bg: '#FFF8ED',
      label: 'Under review',
      sub: 'Your profile is being reviewed for quality and safety. Almost there!',
    },
    paused: {
      color: color.mute, bg: color.haze,
      label: 'Profile paused',
      sub: 'Your profile is hidden from search. Toggle "Available Now" or update your availability to resume.',
    },
    limited: {
      color: color.warn, bg: '#FFF8ED',
      label: 'Limited access',
      sub: 'Some features are restricted. Contact support if you believe this is an error.',
    },
    rejected: {
      color: '#C0392B', bg: '#FFF0EE',
      label: 'Application not approved',
      sub: 'Your application was not approved at this time. You may re-apply after 30 days.',
    },
    suspended: {
      color: '#C0392B', bg: '#FFF0EE',
      label: 'Account suspended',
      sub: 'Your Buddy account has been suspended. Contact support for assistance.',
    },
  };
  const cfg = map[status] ?? map.pending;
  return (
    <View style={[banner.wrap, { backgroundColor: cfg.bg, borderLeftColor: cfg.color }]}>
      <Text style={[banner.title, { color: cfg.color }]}>{cfg.label}</Text>
      <Text style={banner.sub}>{cfg.sub}</Text>
    </View>
  );
}

function StatCard({
  label, value, sub, icon: Icon, iconColor,
}: {
  label: string; value: string; sub?: string; icon: any; iconColor: string;
}) {
  return (
    <View style={stat.card}>
      <View style={[stat.iconWrap, { backgroundColor: iconColor + '22' }]}>
        <Icon size={18} color={iconColor} />
      </View>
      <Text style={stat.value}>{value}</Text>
      <Text style={stat.label}>{label}</Text>
      {sub ? <Text style={stat.sub}>{sub}</Text> : null}
    </View>
  );
}

function NavTile({ label, sub, onPress, badge }: { label: string; sub: string; onPress: () => void; badge?: number }) {
  return (
    <Pressable
      style={({ pressed }) => [tile.wrap, pressed && { opacity: 0.85 }]}
      onPress={onPress}
    >
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text style={tile.title}>{label}</Text>
          {badge != null && badge > 0 && (
            <View style={tile.badge}>
              <Text style={tile.badgeText}>{badge}</Text>
            </View>
          )}
        </View>
        <Text style={tile.sub}>{sub}</Text>
      </View>
      <ChevronRight size={16} color={color.mute} />
    </Pressable>
  );
}

export default function BuddyDashboard() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BuddyDashboardSummary | null>(null);
  const [upcoming, setUpcoming] = useState<BuddyBooking[]>([]);
  const [availableNow, setAvailableNow] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [checklistComplete, setChecklistComplete] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const [dashRes, reqRes, clRes, availRes] = await Promise.all([
      rentABuddy.getBuddyDashboard(),
      rentABuddy.getDashboardRequests(),
      rentABuddy.getProfileChecklist(),
      rentABuddy.getDashboardAvailability(),
    ]);
    if (!silent) setLoading(false);
    if (dashRes.ok) {
      setSummary(dashRes.data);
    } else {
      setError(dashRes.error);
    }
    // Hydrate the header switch from the saved setting so it reflects reality.
    if (availRes.ok && availRes.data?.settings) {
      setAvailableNow(availRes.data.settings.availableNow === true);
    }
    if (reqRes.ok) {
      setUpcoming(reqRes.data.requests.slice(0, 3));
    }
    if (clRes.ok && clRes.data) {
      setChecklist(clRes.data.checklist);
      setChecklistComplete(clRes.data.allComplete);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  if (loading) return <TravelLoadingState label="Loading your dashboard…" />;
  if (error) return <TravelErrorState title="Couldn't load dashboard" sub={error} onRetry={() => load()} />;

  const status = summary?.profile?.status ?? 'pending';
  const isActive = status === 'active';

  // Non-active statuses get a status screen instead of the full dashboard
  if (status === 'pending') {
    return (
      <View style={[statusScreen.wrap, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Text style={statusScreen.emoji}>⏳</Text>
        <Text style={statusScreen.title}>Application under review</Text>
        <Text style={statusScreen.body}>
          Your Buddy application is being reviewed by our team. This usually takes
          1–3 business days. We'll notify you as soon as a decision is made.
        </Text>
        <TravelButton
          label="Back"
          variant="secondary"
          onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)}
        />
      </View>
    );
  }

  if (status === 'rejected') {
    return (
      <View style={[statusScreen.wrap, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Text style={statusScreen.emoji}>🚫</Text>
        <Text style={statusScreen.title}>Application not approved</Text>
        <Text style={statusScreen.body}>
          Unfortunately your application wasn't approved at this time.
          Review our Buddy guidelines and you may re-apply after 30 days.
        </Text>
        <TravelButton
          label="View guidelines"
          variant="secondary"
          onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/safety' as any)}
        />
        <TravelButton
          label="Back"
          variant="ghost"
          onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)}
        />
      </View>
    );
  }

  if (status === 'suspended') {
    return (
      <View style={[statusScreen.wrap, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Text style={statusScreen.emoji}>⛔</Text>
        <Text style={statusScreen.title}>Account suspended</Text>
        <Text style={statusScreen.body}>
          Your Buddy account has been suspended. Please contact support for more
          information and next steps.
        </Text>
        <TravelButton
          label="Contact support"
          variant="primary"
          onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/safety' as any)}
        />
        <TravelButton
          label="Back"
          variant="ghost"
          onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={s.scroll}
      contentContainerStyle={{ paddingBottom: insets.bottom + 48 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.signal} />}
    >
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)} style={s.backBtn}>
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Stamp label="BUDDY DASHBOARD" tone="onInk" rotate={-1} />
          <Text style={s.headerName} numberOfLines={1}>
            {summary?.profile?.displayName ?? 'My Dashboard'}
          </Text>
        </View>
        <View style={s.availRow}>
          <Text style={s.availLabel}>Available Now</Text>
          <Switch
            value={availableNow}
            onValueChange={async (v) => {
              // Persist to the real availability setting; revert on failure.
              setAvailableNow(v);
              const res = await rentABuddy.setAvailabilitySettings({ availableNow: v });
              if (!res.ok) {
                setAvailableNow(!v);
                Alert.alert('Could not update', bookingErrorCopy(res.error, 'Please try again.'));
              }
            }}
            trackColor={{ false: color.haze, true: color.success }}
            thumbColor={color.onInk}
          />
        </View>
      </View>

      <StatusBanner status={status} />

      {/* Stats */}
      <View style={s.statsRow}>
        <StatCard
          label="Pending requests"
          value={String(summary?.pendingRequests ?? 0)}
          icon={Bell}
          iconColor={color.signal}
        />
        <StatCard
          label="Upcoming bookings"
          value={String(summary?.upcomingBookings ?? 0)}
          icon={Calendar}
          iconColor={color.deep}
        />
        <StatCard
          label="Rating"
          value={summary?.averageRating != null ? summary.averageRating.toFixed(1) : '—'}
          sub={`${summary?.reviewCount ?? 0} reviews`}
          icon={Star}
          iconColor={color.warn}
        />
        <StatCard
          label="Est. earnings"
          value={summary?.totalEarningsUsd != null ? `$${summary.totalEarningsUsd.toFixed(0)}` : '—'}
          sub="All time · estimated"
          icon={TrendingUp}
          iconColor={color.success}
        />
      </View>

      {/* Upcoming bookings */}
      <TravelSectionHeader
        title="Upcoming bookings"
        onAction={isActive ? () => router.push('/(rent-a-buddy)/buddy-dashboard/requests' as any) : undefined}
        actionLabel="See all"
      />
      {upcoming.length === 0 ? (
        <TravelEmptyState
          title="No upcoming bookings"
          sub="New booking requests will appear here."
        />
      ) : (
        <View style={s.cardList}>
          {upcoming.map((bk) => (
            <TravelCard key={bk.id} style={{ padding: space.md }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View>
                  <Text style={s.bkDate}>{new Date(bk.bookingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' })}</Text>
                  <Text style={s.bkCat}>{bk.category} · {bk.durationH}h · {bk.groupSize} pax</Text>
                </View>
                <View style={[s.statusPill, { backgroundColor: bk.status === 'scheduled' ? '#E8F5EE' : '#FFF8ED' }]}>
                  <Text style={[s.statusText, { color: bk.status === 'scheduled' ? color.success : color.warn }]}>
                    {bk.status.toUpperCase()}
                  </Text>
                </View>
              </View>
              {bk.notes ? <Text style={s.bkNote} numberOfLines={2}>{bk.notes}</Text> : null}
            </TravelCard>
          ))}
        </View>
      )}

      {/* Navigation tiles */}
      <TravelSectionHeader title="Manage" />
      <View style={s.cardList}>
        <NavTile
          label="Booking requests"
          sub="Review and respond to incoming bookings"
          badge={summary?.pendingRequests ?? 0}
          onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/requests' as any)}
        />
        <NavTile
          label="Requests Inbox"
          sub="Open traveller requests matching your profile — send offers"
          onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/requests-inbox' as any)}
        />
        <NavTile
          label="Availability"
          sub="Set your weekly schedule and blocked dates"
          onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/availability' as any)}
        />
        <NavTile
          label="Meetup spot"
          sub="Pin the approximate area where you meet travellers"
          onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/meetup-pin' as any)}
        />
        <NavTile
          label="Packages"
          sub="Create and manage your service packages"
          onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/packages' as any)}
        />
        <NavTile
          label="Add-ons"
          sub="Extras travellers can add to any booking"
          onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/addons' as any)}
        />
        <NavTile
          label="Earnings"
          sub="Track estimated earnings and cash balance"
          onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/earnings' as any)}
        />
        <NavTile
          label="Safety tools"
          sub="Report, end booking early, emergency button"
          onPress={() => router.push('/(rent-a-buddy)/buddy-dashboard/safety' as any)}
        />
      </View>

      {/* Profile checklist */}
      <TravelSectionHeader
        title={checklistComplete ? 'Profile complete ✓' : 'Profile checklist'}
      />
      <TravelCard style={{ marginHorizontal: space.lg, marginBottom: space.xl }}>
        {checklist.length === 0 ? (
          <View style={cl.row}>
            <Text style={[cl.label, { color: color.mute }]}>Loading checklist…</Text>
          </View>
        ) : (
          checklist.map((item, i) => (
            <View key={item.key} style={[cl.row, i < checklist.length - 1 && cl.divider]}>
              {item.done
                ? <CheckCircle size={18} color={color.success} />
                : <Circle size={18} color={color.haze} />}
              <Text style={[cl.label, item.done && cl.done]}>{item.label}</Text>
            </View>
          ))
        )}
      </TravelCard>
    </ScrollView>
  );
}

const banner = StyleSheet.create({
  wrap: {
    marginHorizontal: space.lg, marginTop: space.lg,
    padding: space.lg, borderRadius: radius.md,
    borderLeftWidth: 4,
  },
  title: { ...t.bodyStrong, marginBottom: 2 },
  sub: { ...t.small, color: color.mute, lineHeight: 17 },
});

const stat = StyleSheet.create({
  card: {
    flex: 1, backgroundColor: color.paperRaised,
    borderRadius: radius.md, padding: space.md,
    alignItems: 'center', gap: 3,
    borderWidth: 1, borderColor: color.haze, ...shadow.card,
  },
  iconWrap: { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  value: { ...t.heading, color: color.ink, fontSize: 20 },
  label: { fontFamily: 'Courier', fontSize: 9, color: color.mute, letterSpacing: 1, textAlign: 'center' },
  sub: { ...t.small, color: color.haze, textAlign: 'center', fontSize: 11 },
});

const tile = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md, padding: space.lg,
    borderWidth: 1, borderColor: color.haze, gap: space.md, ...shadow.card,
  },
  title: { ...t.bodyStrong, color: color.ink },
  sub: { ...t.small, color: color.mute, marginTop: 2 },
  badge: {
    minWidth: 20, height: 20, borderRadius: 10,
    backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5,
  },
  badgeText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.onInk },
});

const cl = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.lg },
  divider: { borderBottomWidth: 1, borderBottomColor: color.haze },
  label: { ...t.body, color: color.ink, flex: 1 },
  done: { color: color.mute, textDecorationLine: 'line-through' },
});

const statusScreen = StyleSheet.create({
  wrap: {
    flex: 1, backgroundColor: color.paper,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.lg,
  },
  emoji: { fontSize: 56 },
  title: { ...t.heading, color: color.ink, textAlign: 'center' },
  body: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
});

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: color.paper },
  header: {
    backgroundColor: color.ink, flexDirection: 'row',
    alignItems: 'flex-start', paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.md,
  },
  backBtn: { paddingTop: 2 },
  headerName: { ...t.heading, color: color.onInk, marginTop: space.xs },
  availRow: { alignItems: 'flex-end', gap: 4 },
  availLabel: { fontFamily: 'Courier', fontSize: 9, color: color.onInkMute, letterSpacing: 1 },
  statsRow: {
    flexDirection: 'row', flexWrap: 'wrap',
    paddingHorizontal: space.lg, marginTop: space.xl, gap: space.sm,
  },
  cardList: { paddingHorizontal: space.lg, gap: space.sm, marginBottom: space.sm },
  bkDate: { ...t.bodyStrong, color: color.ink },
  bkCat: { ...t.small, color: color.mute, marginTop: 2 },
  bkNote: { ...t.small, color: color.haze, marginTop: space.xs },
  statusPill: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
  statusText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
});
