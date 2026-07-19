/**
 * EventVoiceRoomCard — event-page entry state for the Event Voice Room
 * (spec Phase 5). Visible only to users inside the event context: the
 * presence endpoint denies everyone else and this card renders nothing.
 *
 * States: no room (hosts see "Start Voice Room", attendees see nothing) →
 * "Live Voice Room · N listening" (join) → "The voice room has ended"
 * (shown briefly after a live room closes). Joining respects multiple-call
 * prevention via CallContext.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Radio } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { getEventRoom, type CallSessionDto } from '../../services/calls.ts';
import { useCallActions, useCallState } from '../../context/CallContext.tsx';
import { telegraphRealtime, type TelegraphEvent } from '../../services/telegraphRealtimeService.ts';

const POLL_MS = 30_000;

export function EventVoiceRoomCard({ eventId }: { eventId: string }) {
  const actions = useCallActions();
  const callState = useCallState();
  const [loaded, setLoaded] = useState(false);
  const [allowed, setAllowed] = useState(true);
  const [live, setLive] = useState<{ session: CallSessionDto | null; count: number; canStart: boolean }>({
    session: null, count: 0, canStart: false,
  });
  const [justEnded, setJustEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const hadLive = useRef(false);

  const refresh = useCallback(async () => {
    const res = await getEventRoom(eventId);
    if (!mounted.current) return;
    if (!res.ok) {
      setAllowed(false); // outside the event context — render nothing
      setLoaded(true);
      return;
    }
    const session = res.data?.session ?? null;
    if (session) hadLive.current = true;
    else if (hadLive.current) { setJustEnded(true); hadLive.current = false; }
    setLive({
      session,
      count: res.data?.participantCount ?? 0,
      canStart: res.data?.canStart ?? false,
    });
    setLoaded(true);
  }, [eventId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const iv = setInterval(() => { void refresh(); }, POLL_MS);
    const unsub = telegraphRealtime.subscribe((evt: TelegraphEvent) => {
      if (evt.type !== 'call.group_started' && evt.type !== 'call.group_ended') return;
      const session = (evt.payload as { session?: CallSessionDto } | null)?.session;
      if (session?.contextType === 'event' && session.contextId === eventId) void refresh();
    });
    return () => { mounted.current = false; clearInterval(iv); unsub(); };
  }, [refresh, eventId]);

  if (!allowed || !loaded) return null;

  const isLive = !!live.session;
  const inThisRoom =
    callState.session?.callType === 'group_voice' &&
    callState.session.contextType === 'event' &&
    callState.session.contextId === eventId;

  if (!isLive && !live.canStart && !justEnded) return null; // "no room" state for attendees

  if (!isLive && justEnded) {
    return (
      <View style={s.card}>
        <Text style={s.ended}>The voice room has ended.</Text>
      </View>
    );
  }

  const count = Math.max(live.count, 1);
  const label = inThisRoom
    ? "You're in this Voice Room"
    : isLive
      ? `Live Voice Room · ${count} listening`
      : 'Start Voice Room';

  const onPress = async () => {
    if (inThisRoom) { actions.setMinimized(false); return; }
    if (callState.session) return; // already in another call
    setBusy(true);
    try {
      if (isLive && live.session) {
        await actions.joinEventRoom({ callId: live.session.id });
      } else {
        await actions.startEventRoom({ eventId });
      }
      await refresh();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <View style={s.card}>
      <Pressable
        style={[s.btn, isLive && !inThisRoom && s.btnLive]}
        onPress={() => { void onPress(); }}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        {busy ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Radio size={17} color="#fff" />
        )}
        <Text style={s.btnText}>{label}</Text>
      </Pressable>
      {isLive && !inThisRoom ? (
        <Text style={s.hint}>Join to listen — raise your hand to speak.</Text>
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
  ended: { ...t.small, color: color.mute, textAlign: 'center' },
});
