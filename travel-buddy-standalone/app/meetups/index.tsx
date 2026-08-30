/**
 * Meetups list screen — /meetups
 *
 * Shows all meetups the user created or was invited to,
 * grouped into Upcoming and Past sections.
 * Header has a "Create Meetup" button using MeetupCreationSheet.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, RefreshControl,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { FEED_FOCUS_TTL_MS } from '../../src/hooks/usePosts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, CalendarClock, MapPin, Plus, CalendarX,
} from 'lucide-react-native';
import { getMyMeetups, type MeetupListItem, type MeetupStatus, type RsvpStatus } from '../../src/services/meetups';
import { localTodayKey } from '../../src/utils/localDate';
import { MeetupCreationSheet } from '../../src/components/MeetupCreationSheet';
import { RsvpBar } from '../../src/components/RsvpBar';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { useLayoverAwareBottomInset } from '../../src/hooks/useBottomInset';
import { LayoverSessionProvider } from '../../src/context/LayoverSessionContext';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(m: MeetupListItem): string {
  if (m.startsAt) {
    const d = new Date(m.startsAt);
    const datePart = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const timePart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${datePart} · ${timePart}`;
  }
  if (m.approximateDate) {
    return new Date(m.approximateDate + 'T12:00:00').toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
    });
  }
  return 'Date TBD';
}

function isUpcoming(m: MeetupListItem): boolean {
  if (m.status === 'cancelled') return false;
  if (m.startsAt) return new Date(m.startsAt) >= new Date();
  // Compare the local approximateDate against the LOCAL today, not UTC — at a
  // positive offset a meetup dated today was falling into "Past".
  if (m.approximateDate) return m.approximateDate >= localTodayKey();
  return true; // no date = assume upcoming
}

const STATUS_BADGE: Record<MeetupStatus, { label: string; bg: string; fg: string }> = {
  active:    { label: 'Active',     bg: '#E0F2FE', fg: '#0369A1' },
  confirmed: { label: 'Confirmed',  bg: '#DCFCE7', fg: '#16A34A' },
  draft:     { label: 'Draft',      bg: color.haze, fg: color.mute },
  cancelled: { label: 'Cancelled',  bg: '#FEE2E2', fg: '#DC2626' },
};

const RSVP_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  going:    { label: 'Going ✅',    bg: '#DCFCE7', fg: '#15803D' },
  maybe:    { label: 'Maybe 🤔',    bg: '#FEF3C7', fg: '#92400E' },
  declined: { label: "Can't go ❌", bg: '#FEE2E2', fg: '#DC2626' },
  pending:  { label: 'Invited',     bg: color.haze, fg: color.mute },
};

// ── MeetupRow ─────────────────────────────────────────────────────────────────

function MeetupRow({ meetup }: { meetup: MeetupListItem }) {
  const statusBadge = STATUS_BADGE[meetup.status] ?? STATUS_BADGE.active;
  const totalAttendees = meetup.counts.going + meetup.counts.maybe + meetup.counts.pending;

  const myBadgeKey = meetup.isCreator ? null : (meetup.myRsvp ?? 'pending');
  const myBadge = myBadgeKey ? RSVP_BADGE[myBadgeKey] : null;

  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push(`/meetup/${meetup.id}` as any)}
    >
      {/* Status stripe */}
      <View style={[styles.stripe, { backgroundColor: statusBadge.fg }]} />

      <View style={styles.rowBody}>
        {/* Title row */}
        <View style={styles.titleRow}>
          <Text style={styles.rowTitle} numberOfLines={1}>{meetup.title}</Text>
          <View style={[styles.badge, { backgroundColor: statusBadge.bg }]}>
            <Text style={[styles.badgeText, { color: statusBadge.fg }]}>{statusBadge.label}</Text>
          </View>
        </View>

        {/* Date + location */}
        <View style={styles.metaRow}>
          <CalendarClock size={13} color={color.mute} />
          <Text style={styles.meta}>{formatDate(meetup)}</Text>
          {meetup.locationName ? (
            <>
              <Text style={styles.metaDot}>·</Text>
              <MapPin size={13} color={color.mute} />
              <Text style={styles.meta} numberOfLines={1}>{meetup.locationName}</Text>
            </>
          ) : null}
        </View>

        {/* RSVP progress + my RSVP */}
        <View style={styles.footRow}>
          <RsvpBar
            style={styles.rsvpBar}
            going={meetup.counts.going}
            maybe={meetup.counts.maybe}
            pending={meetup.counts.pending}
            total={totalAttendees}
          />
          {meetup.isCreator ? (
            <View style={[styles.badge, { backgroundColor: '#E0F2FE' }]}>
              <Text style={[styles.badgeText, { color: '#0369A1' }]}>Host</Text>
            </View>
          ) : myBadge ? (
            <View style={[styles.badge, { backgroundColor: myBadge.bg }]}>
              <Text style={[styles.badgeText, { color: myBadge.fg }]}>{myBadge.label}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCount}>
        <Text style={styles.sectionCountText}>{count}</Text>
      </View>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

function MeetupsScreenInner() {
  const insets = useSafeAreaInsets();
  const navBarScrollHandler = useNavBarScrollHandler();
  const bottomInset = useLayoverAwareBottomInset();
  const { isAuthed, configured } = useSession();

  const [meetups, setMeetups] = useState<MeetupListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const lastLoadedAt = useRef(0);

  const load = useCallback(async () => {
    if (!configured || !isAuthed) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    const [upRes, pastRes] = await Promise.all([
      getMyMeetups('upcoming'),
      getMyMeetups('past'),
    ]);
    if (!upRes.ok && !pastRes.ok) {
      setError(upRes.message ?? 'Failed to load meetups');
    } else {
      const upcoming = upRes.data?.meetups ?? [];
      const past     = pastRes.data?.meetups ?? [];
      // Merge and deduplicate by id
      const seen = new Set<string>();
      const all: MeetupListItem[] = [];
      for (const m of [...upcoming, ...past]) {
        if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
      }
      setMeetups(all);
      lastLoadedAt.current = Date.now();
    }
    setLoading(false);
  }, [configured, isAuthed]);

  useFocusEffect(useCallback(() => {
    if (Date.now() - lastLoadedAt.current >= FEED_FOCUS_TTL_MS) {
      load();
    }
  }, [load]));

  const upcoming = meetups.filter(isUpcoming);
  const past     = meetups.filter((m) => !isUpcoming(m));

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Meetups</Text>
        <Pressable
          style={styles.createBtn}
          onPress={() => setShowCreate(true)}
        >
          <Plus size={16} color={color.onInk} />
          <Text style={styles.createBtnText}>Create</Text>
        </Pressable>
      </View>

      {/* Content */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : meetups.length === 0 ? (
        <View style={styles.emptyState}>
          <CalendarX size={40} color={color.faint} />
          <Text style={styles.emptyTitle}>No meetups yet</Text>
          <Text style={styles.emptySub}>
            Create a meetup to plan a get-together with friends or trip members.
          </Text>
          <Pressable style={styles.emptyBtn} onPress={() => setShowCreate(true)}>
            <Plus size={16} color={color.onInk} />
            <Text style={styles.emptyBtnText}>Create your first meetup</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.list, { paddingBottom: bottomInset }]}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={load} tintColor={color.signal} />
          }
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
        >
          {upcoming.length > 0 && (
            <>
              <SectionHeader title="Upcoming" count={upcoming.length} />
              {upcoming.map((m) => <MeetupRow key={m.id} meetup={m} />)}
            </>
          )}

          {past.length > 0 && (
            <>
              <SectionHeader title="Past" count={past.length} />
              {past.map((m) => <MeetupRow key={m.id} meetup={m} />)}
            </>
          )}
        </ScrollView>
      )}

      {/* Create meetup sheet */}
      {showCreate && (
        <MeetupCreationSheet
          onDismiss={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paperRaised,
    gap: space.md,
  },
  backBtn: {
    padding: 4,
  },
  headerTitle: {
    ...t.title,
    color: color.ink,
    fontWeight: '800',
    flex: 1,
  },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.ink,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  createBtnText: {
    ...t.small,
    color: color.onInk,
    fontWeight: '700',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xxl,
    gap: space.md,
  },
  errorText: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
  },
  retryText: {
    ...t.small,
    color: color.onInk,
    fontWeight: '700',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xxl,
    gap: space.md,
  },
  emptyTitle: {
    ...t.title,
    color: color.ink,
    fontSize: 20,
    fontWeight: '800',
  },
  emptySub: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    maxWidth: 280,
  },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.signal,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    marginTop: space.sm,
    ...shadow.card,
  },
  emptyBtnText: {
    ...t.body,
    color: color.onInk,
    fontWeight: '700',
  },
  list: {
    padding: space.lg,
    gap: space.md,
    paddingBottom: space.xxxl,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
  },
  sectionTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '700',
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionCount: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  sectionCountText: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadow.card,
  },
  stripe: {
    width: 4,
  },
  rowBody: {
    flex: 1,
    padding: space.md,
    gap: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  rowTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '700',
    flex: 1,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'nowrap',
  },
  meta: {
    ...t.small,
    color: color.mute,
  },
  metaDot: {
    ...t.small,
    color: color.faint,
  },
  rsvpBar: {
    flex: 1,
  },
  footRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
});

/**
 * LayoverSessionProvider owns a single getActiveLayoverSession call per focus
 * event, so both the pill clearance (useLayoverAwareBottomInset) and any future
 * pill-render on this screen share one fetch instead of each firing their own.
 */
export default function MeetupsScreen() {
  return (
    <LayoverSessionProvider>
      <MeetupsScreenInner />
    </LayoverSessionProvider>
  );
}
