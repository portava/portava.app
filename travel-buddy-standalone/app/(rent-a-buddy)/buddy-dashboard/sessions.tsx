/**
 * Buddy — My sessions (testing mode, lane tm-rab, WP-01 / PLAT-F45).
 *
 * The buddy side of running a booking. Before this screen an ACCEPTED booking
 * disappeared from every buddy screen (the requests list shows only bookings
 * awaiting an answer), so there was nowhere to press Start, and nothing in the
 * app called startBooking or completeBooking at all.
 *
 * Lists the buddy's accepted, in-progress and awaiting-confirmation bookings
 * (listMyBuddySessions — one failed status read fails the whole list, so a
 * partial list is never shown as complete). Start / Complete are offered per
 * `lifecycleActions`, which mirrors the server's guards; the server re-checks.
 *
 * States: loading · error with retry · "no buddy profile" · a gate refusal as
 * its own state · a true empty.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, Alert, RefreshControl, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Play, CheckCircle, ChevronRight } from 'lucide-react-native';
import { color, space, radius, type as t, layout } from '../../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState, TravelEmptyState } from '../../../src/components/primitives';
import {
  listMyBuddySessions, startBooking, completeBooking, bookingErrorCopy, type BuddyBooking,
} from '../../../src/services/rentABuddy';
import { lifecycleActions, bookingStatusLabel } from '../../../src/services/rentABuddyLifecycle';
import { describeGateRefusal, type GateRefusal } from '../../../src/services/rentABuddyGates';
import { RabGateRefusalState } from '../../../src/components/rentabuddy/RabGateRefusalState';

export default function BuddySessions() {
  const insets = useSafeAreaInsets();
  const [sessions, setSessions] = useState<BuddyBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noProfile, setNoProfile] = useState(false);
  const [gate, setGate] = useState<GateRefusal | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const lock = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null); setNoProfile(false); setGate(null);
    const res = await listMyBuddySessions();
    if (!silent) setLoading(false);
    if (res.ok) { setSessions(res.data); return; }
    if (res.error === 'not_found') { setNoProfile(true); return; }
    const g = describeGateRefusal(res.error, res.gate);
    if (g) { setGate(g); return; }
    setError(bookingErrorCopy(res.error, "Couldn't load your sessions."));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  const act = useCallback(async (booking: BuddyBooking, kind: 'start' | 'complete') => {
    if (lock.current) return;
    lock.current = true;
    setActing(booking.id);
    try {
      const res = kind === 'start' ? await startBooking(booking.id) : await completeBooking(booking.id);
      if (res.ok) {
        Alert.alert(
          kind === 'start' ? 'Session started' : 'Marked complete',
          kind === 'start'
            ? 'The traveller can see the session is live.'
            : 'The traveller now confirms it went ahead (they have 24 hours to confirm or raise a problem).',
        );
        await load(true);
        return;
      }
      const g = describeGateRefusal(res.error, res.gate);
      if (g) { setGate(g); return; }
      Alert.alert("That didn't go through", bookingErrorCopy(res.error, kind === 'start' ? 'Could not start the session.' : 'Could not complete the session.'));
    } finally {
      lock.current = false;
      setActing(null);
    }
  }, [load]);

  const confirmAct = (booking: BuddyBooking, kind: 'start' | 'complete') => {
    Alert.alert(
      kind === 'start' ? 'Start the session?' : 'Mark the session complete?',
      kind === 'start'
        ? 'Start only once you and the traveller have met at the public meetup point.'
        : 'Only once the meetup has actually finished.',
      [
        { text: 'Not yet', style: 'cancel' },
        { text: kind === 'start' ? 'Start session' : 'Complete', onPress: () => { void act(booking, kind); } },
      ],
    );
  };

  const header = (
    <View style={[s.header, { paddingTop: insets.top + space.md }]}>
      <Pressable onPress={() => (router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/buddy-dashboard' as any))} hitSlop={10}>
        <ArrowLeft size={20} color={color.onInk} />
      </Pressable>
      <Text style={s.headerTitle}>My sessions</Text>
    </View>
  );

  let body: React.ReactNode;
  if (loading) body = <TravelLoadingState label="Loading your sessions…" />;
  else if (gate) body = <RabGateRefusalState refusal={gate} onRetry={() => { void load(); }} testID="sessions-gate" />;
  else if (noProfile) {
    body = (
      <TravelEmptyState
        title="You're not a buddy yet"
        sub="Sessions appear here once you have an approved buddy profile and a traveller's booking is accepted."
        action="Become a buddy"
        onAction={() => router.push('/(rent-a-buddy)/become' as any)}
      />
    );
  } else if (error) body = <TravelErrorState title="Couldn't load your sessions" sub={error} onRetry={() => { void load(); }} />;
  else {
    body = (
      <FlatList
        data={sessions}
        keyExtractor={(b) => b.id}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: insets.bottom + space.xl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <TravelEmptyState
            title="No sessions to run"
            sub="Accepted bookings appear here. New requests wait for you under Booking requests."
          />
        }
        renderItem={({ item }) => {
          const a = lifecycleActions(item.status, 'buddy');
          const busy = acting === item.id;
          return (
            <View style={s.card} testID={`session-${item.id}`}>
              <Pressable
                style={s.cardHead}
                onPress={() => router.push({ pathname: '/(rent-a-buddy)/booking/[id]' as any, params: { id: item.id } })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.date}>{item.bookingDate}{item.startTime ? ` · ${item.startTime.slice(0, 5)}` : ''}</Text>
                  <Text style={s.meta}>{item.category} · {item.city} · {item.durationH}h · {item.groupSize} pax</Text>
                </View>
                <Text style={s.status}>{bookingStatusLabel(item.status)}</Text>
                <ChevronRight size={16} color={color.mute} />
              </Pressable>
              {item.status === 'completed_pending_traveler_confirmation' ? (
                <Text style={s.note}>Waiting for the traveller to confirm.</Text>
              ) : null}
              {a.start ? (
                <Pressable
                  style={({ pressed }) => [s.btn, pressed && { opacity: layout.pressedOpacity }]}
                  disabled={busy}
                  onPress={() => confirmAct(item, 'start')}
                  testID={`session-start-${item.id}`}
                >
                  {busy ? <ActivityIndicator color={color.onInk} /> : <Play size={15} color={color.onInk} />}
                  <Text style={s.btnText}>Start session</Text>
                </Pressable>
              ) : null}
              {a.complete ? (
                <Pressable
                  style={({ pressed }) => [s.btn, pressed && { opacity: layout.pressedOpacity }]}
                  disabled={busy}
                  onPress={() => confirmAct(item, 'complete')}
                  testID={`session-complete-${item.id}`}
                >
                  {busy ? <ActivityIndicator color={color.onInk} /> : <CheckCircle size={15} color={color.onInk} />}
                  <Text style={s.btnText}>Complete session</Text>
                </Pressable>
              ) : null}
            </View>
          );
        }}
      />
    );
  }

  return (
    <View style={s.wrap}>
      {header}
      {body}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.md, backgroundColor: color.ink },
  headerTitle: { ...t.heading, color: color.onInk },
  card: { gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  date: { ...t.bodyStrong, color: color.ink },
  meta: { ...t.small, color: color.mute },
  status: { ...t.small, color: color.deep, fontWeight: '700' },
  note: { ...t.small, color: color.mute },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, backgroundColor: color.ink, borderRadius: radius.md, paddingVertical: space.sm },
  btnText: { ...t.bodyStrong, color: color.onInk },
});
