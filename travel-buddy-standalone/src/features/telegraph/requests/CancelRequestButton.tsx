/**
 * Telegraph WP-08 / TEL-F03 — the sender withdraws a pending message request.
 *
 * Shown on the sender's "Waiting for reply" banner, the one place the sender
 * sees a pending request. `POST /api/message-requests/:id/cancel` is the
 * authority: it lets only the sender cancel, only while `pending`, and moves
 * the state with a compare-and-swap so an accept that lands first wins. The
 * button asks once, then reports what the server said:
 *
 *   - cancelled → `onCancelled()` (the caller re-reads the request status, so
 *     the banner disappears because the SERVER says nothing is pending, not
 *     because this button assumed it);
 *   - "no longer pending" (they accepted or declined meanwhile) → said, and
 *     the caller re-reads too, so the screen shows the real state;
 *   - anything else → the request is still pending, and the person is told.
 */
import React, { useState } from 'react';
import { Alert, Pressable, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { cancelMessageRequest } from '../../../services/messaging.ts';

export interface CancelRequestButtonProps {
  requestId: string;
  onCancelled: () => void;
}

export function CancelRequestButton({ requestId, onCancelled }: CancelRequestButtonProps) {
  const [busy, setBusy] = useState(false);

  async function cancel() {
    setBusy(true);
    const r = await cancelMessageRequest(requestId);
    setBusy(false);
    if (r.ok) { onCancelled(); return; }
    if (r.errorKind === 'invalid_payload') {
      // The server's "Request is no longer pending": it was answered first.
      Alert.alert('Already answered', 'They responded to your request before it was cancelled.');
      onCancelled();
      return;
    }
    Alert.alert('Not cancelled', r.message ?? 'Your request is still pending. Please try again.');
  }

  return (
    <Pressable
      style={s.btn}
      disabled={busy}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Cancel message request"
      testID="telegraph-cancel-request"
      onPress={() => {
        Alert.alert('Cancel request?', 'Your message request will be withdrawn from their requests.', [
          { text: 'Keep waiting', style: 'cancel' },
          { text: 'Cancel request', style: 'destructive', onPress: () => { void cancel(); } },
        ]);
      }}
    >
      {busy ? <ActivityIndicator size="small" color="#92400E" /> : <Text style={s.label}>Cancel</Text>}
    </Pressable>
  );
}

const s = StyleSheet.create({
  // Same amber as the banner it sits in (app/messages/[id].tsx `waitingBanner`).
  btn: { marginLeft: 'auto', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: '#92400E' },
  label: { fontSize: 12, fontWeight: '700', color: '#92400E' },
});

export default CancelRequestButton;
