/**
 * The one line that says, truthfully, when messaging is not working right —
 * §30A.15's OFFLINE / RECONNECTING / POOR_CONNECTION. Nothing is drawn while
 * the connection is fine. Announced politely to screen readers, because a
 * change in whether messages can arrive is news.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CloudOff, RefreshCw, Wifi } from 'lucide-react-native';

import { color } from '../../../theme/tokens.ts';
import { connectionCopy } from './connectionState.ts';
import { useTelegraphConnection } from './connectionMonitor.ts';

export function TelegraphConnectionBanner() {
  const v = useTelegraphConnection();
  const copy = connectionCopy(v);
  if (!copy) return null;
  const Icon = v.state === 'OFFLINE' ? CloudOff : v.state === 'RECONNECTING' ? RefreshCw : Wifi;
  return (
    <View
      style={[s.bar, v.state === 'OFFLINE' ? s.barOffline : s.barSoft]}
      testID={`telegraph-connection-${v.state}`}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Icon size={14} color={v.state === 'OFFLINE' ? color.onInk : color.ink} />
      <Text style={[s.text, v.state === 'OFFLINE' ? s.textOffline : null]}>{copy}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
  barOffline: { backgroundColor: color.ink },
  barSoft: { backgroundColor: color.haze },
  text: { flex: 1, fontSize: 12, lineHeight: 16, color: color.ink },
  textOffline: { color: color.onInk },
});
