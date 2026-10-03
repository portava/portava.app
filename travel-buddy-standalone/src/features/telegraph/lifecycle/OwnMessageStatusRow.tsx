/**
 * The status line under one of the caller's own ACCEPTED messages — Sent,
 * Delivered, Seen / Seen by N, "they were offline", or "read status
 * unavailable" (§7.3, §30A.15). Both chat screens render it, so the two can no
 * longer say different things about the same message. Sending and the
 * tap-to-retry failure keep the rows each screen already draws.
 *
 * The words come from `ownMessageStatusLabel`; this only chooses the icon and
 * the emphasis. The two states that report something NOT known — "read status
 * unavailable" and "they were offline" — are drawn muted, so neither can be
 * mistaken for a confident tick.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Check, CheckCheck, CircleHelp, Moon } from 'lucide-react-native';

import { color } from '../../../theme/tokens.ts';
import { ownMessageStatusLabel, type OwnMessageStatus } from './readState.ts';

export function OwnMessageStatusRow({
  status,
  isGroup,
}: {
  status: OwnMessageStatus;
  isGroup: boolean;
}) {
  if (status.kind === 'sending' || status.kind === 'failed') return null;
  const label = ownMessageStatusLabel(status, { isGroup });
  const muted = status.kind === 'receipt_unavailable' || status.kind === 'recipient_offline';
  const tint = muted ? color.mute : color.signal;
  const Icon =
    status.kind === 'seen' || status.kind === 'delivered' ? CheckCheck
      : status.kind === 'receipt_unavailable' ? CircleHelp
        : status.kind === 'recipient_offline' ? Moon
          : Check;
  return (
    <View style={s.row} testID={`telegraph-own-status-${status.kind}`} accessibilityLabel={label}>
      <Icon size={11} color={tint} />
      <Text style={[s.text, { color: tint }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-end', marginTop: 2, paddingRight: 2 },
  text: { fontSize: 10, fontFamily: 'Courier' },
});
