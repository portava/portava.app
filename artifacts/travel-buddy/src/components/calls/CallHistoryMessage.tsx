/**
 * calls/CallHistoryMessage — call system messages in the thread timeline
 * (spec §18): "Missed voice call", "Call declined", "Voice call · 4 min", …
 * The server writes these lines; this component only renders them, adding a
 * permission-aware "Call back" affordance for missed incoming calls.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Phone, PhoneMissed, PhoneOff, Video } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';

export type CallHistorySubtype =
  | 'call_ended' | 'call_missed' | 'call_declined' | 'call_canceled' | 'call_failed';

export function CallHistoryMessage({
  subtype, body, mine, onCallBack,
}: {
  subtype: string;
  body: string | null;
  /** True when the viewer started the call (sender of the system line). */
  mine: boolean;
  /**
   * Present only when calling back is still available (thread eligible and
   * viewer was the callee). The server remains the authorization.
   */
  onCallBack?: (type: 'voice' | 'video') => void;
}) {
  const label = body && body.trim().length > 0 ? body : 'Call';
  const isMissed = subtype === 'call_missed';
  const isVideo = /video/i.test(label);
  const missedForViewer = isMissed && !mine;
  const Icon = missedForViewer ? PhoneMissed
    : subtype === 'call_declined' || subtype === 'call_canceled' || subtype === 'call_failed' ? PhoneOff
    : isVideo ? Video : Phone;
  const tone = missedForViewer ? '#DC2626' : color.mute;

  return (
    <View style={s.wrap}>
      <View style={s.line}>
        <Icon size={13} color={tone} />
        <Text style={[s.text, missedForViewer && s.missedText]}>{label}</Text>
      </View>
      {missedForViewer && onCallBack ? (
        <Pressable
          style={s.callBackBtn}
          onPress={() => onCallBack(isVideo ? 'video' : 'voice')}
          accessibilityRole="button"
          accessibilityLabel="Call back"
          hitSlop={6}
        >
          {isVideo ? <Video size={12} color={color.signal} /> : <Phone size={12} color={color.signal} />}
          <Text style={s.callBackText}>Call back</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { alignItems: 'center', marginVertical: 8, gap: 6 },
  line: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: space.md, paddingVertical: 5,
    borderRadius: radius.pill, backgroundColor: color.paperRaised,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.haze,
  },
  text: { ...t.small, color: color.mute, fontSize: 12 },
  missedText: { color: '#DC2626', fontWeight: '600' },
  callBackBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: space.md, paddingVertical: 6,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal,
  },
  callBackText: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 12 },
});
