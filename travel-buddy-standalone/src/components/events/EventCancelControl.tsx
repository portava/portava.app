/**
 * EventCancelControl — the host cancels an event (PLAT-F28).
 *
 * Goes through POST /api/events/:id/cancel, not PATCH { state }: the cancel
 * route records the reason in the event's activity log, applies the host
 * cancellation trust rule and notifies everyone going. Two steps — tap, then
 * confirm with an optional reason — and a refusal is shown as the server's
 * message, never as a cancelled event.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, TextInput, ActivityIndicator } from 'react-native';
import { cancelEventWithReason } from '../../services/events.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  eventId: string;
  onCancelled: () => void;
}

export function EventCancelControl({ eventId, onCancelled }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <Pressable
        style={[s.btn, s.btnDanger]}
        onPress={() => { setConfirming(true); setError(null); }}
        accessibilityRole="button"
        accessibilityLabel="Cancel event"
        testID="event-cancel-start"
      >
        <Text style={[s.btnText, { color: '#DC2626' }]}>Cancel event</Text>
      </Pressable>
    );
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await cancelEventWithReason(eventId, reason);
    setBusy(false);
    if (!res.ok) { setError(res.message ?? 'The event was not cancelled. Please try again.'); return; }
    setConfirming(false);
    onCancelled();
  }

  return (
    <View style={s.box} testID="event-cancel-confirm">
      <Text style={s.title}>Cancel this event?</Text>
      <Text style={s.sub}>Everyone going is notified. Cancelling close to the start can affect your host reliability.</Text>
      <TextInput
        style={s.input}
        placeholder="Reason (optional)"
        placeholderTextColor={color.faint}
        value={reason}
        onChangeText={setReason}
        maxLength={500}
        multiline
        accessibilityLabel="Cancellation reason"
      />
      {error ? <Text style={s.error} testID="event-cancel-error">{error}</Text> : null}
      <View style={s.row}>
        <Pressable style={[s.btn, { flex: 1 }]} onPress={() => setConfirming(false)} disabled={busy} accessibilityRole="button">
          <Text style={s.btnText}>Keep event</Text>
        </Pressable>
        <Pressable
          style={[s.btn, s.btnDangerSolid, { flex: 1 }, busy && { opacity: 0.6 }]}
          onPress={confirm}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Confirm cancel event"
          testID="event-cancel-submit"
        >
          {busy ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={[s.btnText, { color: color.onInk }]}>Cancel event</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  box:    { gap: space.sm, borderWidth: 1, borderColor: '#FCA5A5', backgroundColor: '#FEF2F2', borderRadius: radius.md, padding: space.md },
  title:  { ...t.body, color: color.ink, fontWeight: '700' },
  sub:    { ...t.small, color: color.mute },
  input:  { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.sm, ...t.body, color: color.ink, minHeight: 56 },
  error:  { ...t.small, color: '#DC2626' },
  row:    { flexDirection: 'row', gap: space.sm },
  btn:    { backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, alignItems: 'center', borderWidth: 1, borderColor: color.haze },
  btnDanger: { borderColor: '#FCA5A5', backgroundColor: '#FEF2F2' },
  btnDangerSolid: { backgroundColor: '#DC2626', borderColor: '#DC2626' },
  btnText: { ...t.body, color: color.ink, fontWeight: '600' },
});
