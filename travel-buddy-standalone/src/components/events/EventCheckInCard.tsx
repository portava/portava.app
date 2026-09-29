/**
 * EventCheckInCard — the attendee's self check-in (PLAT-F26).
 *
 * Shown to a Going attendee who is not staff. The window mirrors the server
 * rule (src/lib/eventCheckIn.ts ↔ routes/events.ts `eventCheckInRefusal`):
 * the button is offered only while the server will accept it, and a refusal
 * the server still makes (clock skew, state change) is shown as its message,
 * never as a success.
 *
 * Check-in is a self-report (decision TM-EV-01): the host confirms attendance
 * separately, from the host dashboard.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { CircleCheck, MapPinCheck } from 'lucide-react-native';
import { selfCheckIn, type EventDetail } from '../../services/events.ts';
import { checkInWindow, readAttendanceTimes } from '../../lib/eventCheckIn.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  event: EventDetail;
  /** Called after a successful check-in so the screen can refresh. */
  onCheckedIn?: () => void;
  /** Injectable clock for tests. */
  now?: number;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function EventCheckInCard({ event, onCheckedIn, now }: Props) {
  const times = readAttendanceTimes(event.myAttendanceState);
  const [checkedInAt, setCheckedInAt] = useState<string | null>(times.checkedInAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isStaff = event.isHost || event.myRole === 'host' || event.myRole === 'co_host';
  if (isStaff || event.myRsvp !== 'going') return null;

  const doneAt = checkedInAt ?? times.checkedInAt;
  if (doneAt) {
    return (
      <View style={s.card} testID="event-checkin-done">
        <CircleCheck size={18} color="#16A34A" />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>You're checked in</Text>
          <Text style={s.sub}>
            {`Checked in at ${clock(doneAt)}`}
            {times.confirmedAt ? ' · the host confirmed you attended' : ''}
          </Text>
        </View>
      </View>
    );
  }

  const w = checkInWindow(event.state, event.startsAt, event.endsAt, now ?? Date.now());
  if (w.status === 'closed') return null;

  if (w.status === 'not_yet') {
    return (
      <View style={s.card} testID="event-checkin-not-yet">
        <MapPinCheck size={18} color={color.mute} />
        <Text style={[s.sub, { flex: 1 }]}>
          {`Check-in opens at ${new Date(w.opensAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
        </Text>
      </View>
    );
  }

  async function handleCheckIn() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await selfCheckIn(event.id);
      if (res.ok && res.data?.checkedInAt) {
        setCheckedInAt(res.data.checkedInAt);
        onCheckedIn?.();
      } else {
        setError(res.message ?? 'Check-in did not go through. Please try again.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check-in did not go through. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.cardCol} testID="event-checkin-open">
      <View style={s.row}>
        <MapPinCheck size={18} color={color.signal} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Arrived?</Text>
          <Text style={s.sub}>Check in so the host knows you're here.</Text>
        </View>
        <Pressable
          style={[s.btn, busy && { opacity: 0.6 }]}
          onPress={handleCheckIn}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Check in"
          testID="event-checkin-button"
        >
          {busy ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={s.btnText}>Check in</Text>}
        </Pressable>
      </View>
      {error ? <Text style={s.error} testID="event-checkin-error">{error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card:    { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.md, marginHorizontal: space.lg, marginTop: space.md },
  cardCol: { gap: space.sm, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.md, marginHorizontal: space.lg, marginTop: space.md },
  row:     { flexDirection: 'row', alignItems: 'center', gap: space.md },
  title:   { ...t.body, color: color.ink, fontWeight: '700' },
  sub:     { ...t.small, color: color.mute },
  btn:     { backgroundColor: color.signal, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm, minWidth: 96, alignItems: 'center' },
  btnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  error:   { ...t.small, color: '#DC2626' },
});
