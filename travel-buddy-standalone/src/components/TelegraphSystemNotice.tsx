/**
 * TelegraphSystemNotice — centered notice pill for system_notice messages.
 * Used for things like "You matched availability this weekend",
 * "Trip plan updated", or "Activity confirmed by host".
 *
 * Telegraph §30A.13 / census T430. This pill is the fallback every surface
 * reaches for a `msg_type:'system'` message it has no branch for, and each of
 * its three mounts passed `m.body ?? ''` straight through. Telegraph's
 * structured payloads live in `body` as a JSON string (census T157), so an
 * unrecognised subtype printed its own wire format at the reader. The
 * sanitisation lives HERE rather than at the mounts because all three mounts
 * had the same hole and a fix at one of them would have left the other two —
 * `GroupChatScreen` passes every system message through this pill, including
 * the card subtypes the conversation screen intercepts first.
 *
 * `safeUnknownBody` is deliberately conservative: real prose is passed
 * through unchanged, so "Trip plan updated" still reads as that sentence.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Info } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { TG } from '../theme/telegraphTokens.ts';
import { safeUnknownBody } from '../features/telegraph/kinds/unsupportedPayload.ts';

interface Props {
  text: string;
}

export function TelegraphSystemNotice({ text }: Props) {
  return (
    <View style={styles.wrap}>
      <View style={styles.pill} testID="telegraph-system-notice">
        <Info size={11} color={color.mute} />
        <Text style={styles.text}>{safeUnknownBody(text)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: TG.surfaceRaised,
    borderWidth: 1,
    borderColor: TG.recvBorder,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    maxWidth: '80%',
  },
  text: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    textAlign: 'center',
    fontFamily: 'Courier',
  },
});
