/**
 * CrewCallCard — Start/Join affordance for the trip crew's voice room
 * (spec Phase 4). Shows "Start Crew Call" when no room is live and
 * "Join Crew Call · N people" while one is. Presence comes from the
 * member-only group endpoint, refreshed by realtime group events plus a
 * gentle poll. Renders nothing for non-members (server denies the fetch).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Phone } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { getCrewCall, type CallSessionDto } from '../../services/calls.ts';
import { useCallActions, useCallState } from '../../context/CallContext.tsx';
import { telegraphRealtime, type TelegraphEvent } from '../../services/telegraphRealtimeService.ts';

const POLL_MS = 30_000;

export function CrewCallCard({ tripId }: { tripId: string }) {
  const actions = useCallActions();
  const callState = useCallState();
  const [loaded, setLoaded] = useState(false);
  const [allowed, setAllowed] = useState(true);
  const [live, setLive] = useState<{ session: CallSessionDto | null; count: number }>({ session: null, count: 0 });
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const res = await getCrewCall(tripId);
    if (!mounted.current) return;
    if (!res.ok) {
      if (res.error === 'not_crew_member') setAllowed(false);
      setLoaded(true);
      return;
    }
    setLive({ session: res.data?.session ?? null, count: res.data?.participantCount ?? 0 });
    setLoaded(true);
  }, [tripId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const iv = setInterval(() => { void refresh(); }, POLL_MS);
    const unsub = telegraphRealtime.subscribe((evt: TelegraphEvent) => {
      if (evt.type !== 'call.group_started' && evt.type !== 'call.group_ended') return;
      const session = (evt.payload as { session?: CallSessionDto } | null)?.session;
      if (session?.contextType === 'trip_crew' && session.contextId === tripId) void refresh();
    });
    return () => { mounted.current = false; clearInterval(iv); unsub(); };
  }, [refresh, tripId]);

  if (!allowed || !loaded) return null;

  const inThisCall =
    callState.session?.callType === 'group_voice' &&
    callState.session.contextType === 'trip_crew' &&
    callState.session.contextId === tripId;

  const isLive = !!live.session;
  const label = inThisCall
    ? "You're in this Crew Call"
    : isLive
      ? `Join Crew Call · ${Math.max(live.count, 1)} ${Math.max(live.count, 1) === 1 ? 'person' : 'people'}`
      : 'Start Crew Call';

  const onPress = async () => {
    if (inThisCall) { actions.setMinimized(false); return; }
    if (callState.session) return; // already in another call
    setBusy(true);
    try {
      await actions.startCrewCall({ tripId });
      await refresh();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <View style={s.card}>
      <Pressable
        style={[s.btn, isLive && !inThisCall && s.btnLive]}
        onPress={() => { void onPress(); }}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        {busy ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Phone size={17} color="#fff" />
        )}
        <Text style={s.btnText}>{label}</Text>
      </Pressable>
      {isLive && !inThisCall ? (
        <Text style={s.hint}>A voice room is live for your crew.</Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    padding: space.md, marginBottom: space.md, ...shadow.card,
  },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: color.deep, borderRadius: radius.md,
    paddingVertical: 12,
  },
  btnLive: { backgroundColor: color.success },
  btnText: { ...t.bodyStrong, color: '#fff' },
  hint: { ...t.small, color: color.mute, textAlign: 'center', marginTop: space.xs },
});
