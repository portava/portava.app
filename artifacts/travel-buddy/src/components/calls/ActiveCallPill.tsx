/**
 * calls/ActiveCallPill — persistent minimized-call bar (spec §16).
 * Rendered above the app content (below any header) while a call is
 * minimized, surviving navigation. Tap → restore; quick mute + hang up.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Mic, MicOff, Phone } from 'lucide-react-native';

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function ActiveCallPill({
  label, elapsedSec, micMuted, reconnecting, onPress, onToggleMute, onHangUp,
}: {
  /** "Call with Alex" / "Crew Call · 4 people" */
  label: string;
  elapsedSec: number;
  micMuted: boolean;
  reconnecting?: boolean;
  onPress: () => void;
  onToggleMute: () => void;
  onHangUp: () => void;
}) {
  return (
    <Pressable
      style={s.pill}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Return to call. ${label}`}
    >
      <View style={s.liveDot} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.label} numberOfLines={1}>{label}</Text>
        <Text style={s.time}>{reconnecting ? 'Reconnecting…' : fmtElapsed(elapsedSec)}</Text>
      </View>
      <Pressable
        style={s.iconBtn}
        onPress={onToggleMute}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={micMuted ? 'Unmute' : 'Mute'}
      >
        {micMuted ? <MicOff size={16} color="#fff" /> : <Mic size={16} color="#fff" />}
      </Pressable>
      <Pressable
        style={[s.iconBtn, s.endBtn]}
        onPress={onHangUp}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="End call"
      >
        <Phone size={16} color="#fff" style={{ transform: [{ rotate: '135deg' }] }} />
      </Pressable>
    </Pressable>
  );
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 12, marginTop: 6, minHeight: 48,
    paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: '#159447',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, elevation: 5,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  label: { fontSize: 13.5, fontWeight: '700', color: '#fff' },
  time: { fontSize: 11.5, color: 'rgba(255,255,255,0.85)', fontVariant: ['tabular-nums'] },
  iconBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
  },
  endBtn: { backgroundColor: '#DC2626' },
});
