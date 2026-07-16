/**
 * LiveShareStatusCard — user's own view (they are sharing)
 * Shows expiration countdown and "Stop sharing" button.
 * No exact GPS is shown (approximate area only).
 */
import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { MapPin, X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import { stopLiveShare } from '../../services/safeReturn';

interface Props {
  shareId: string;
  sessionId: string;
  expiresAt: string | null;
  recipientName?: string | null;
  onStopped?: () => void;
}

function useCountdown(expiresAt: string | null): string {
  const [display, setDisplay] = useState('');
  useEffect(() => {
    function tick() {
      if (!expiresAt) { setDisplay(''); return; }
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (ms <= 0) { setDisplay('Expired'); return; }
      const m = Math.floor(ms / 60_000);
      const s = Math.floor((ms % 60_000) / 1000);
      setDisplay(`${m}m ${String(s).padStart(2, '0')}s`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return display;
}

export function LiveShareStatusCard({ shareId, sessionId, expiresAt, recipientName, onStopped }: Props) {
  const [stopping, setStopping] = useState(false);
  const countdown = useCountdown(expiresAt);

  async function handleStop() {
    Alert.alert('Stop sharing?', 'Your approximate location will no longer be visible.', [
      { text: 'Keep sharing', style: 'cancel' },
      {
        text: 'Stop sharing', style: 'destructive',
        onPress: async () => {
          setStopping(true);
          await stopLiveShare(sessionId, shareId);
          setStopping(false);
          onStopped?.();
        },
      },
    ]);
  }

  return (
    <View style={styles.card}>
      <View style={styles.left}>
        <MapPin size={16} color={color.deep} />
        <View>
          <Text style={styles.label}>Sharing approximate area</Text>
          {recipientName ? (
            <Text style={styles.sub}>with {recipientName}</Text>
          ) : null}
          {countdown ? (
            <Text style={styles.countdown}>Stops in {countdown}</Text>
          ) : null}
        </View>
      </View>
      <Pressable style={styles.stopBtn} onPress={handleStop} disabled={stopping}>
        {stopping ? <ActivityIndicator size="small" color={color.signal} /> : <X size={16} color={color.signal} />}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#EAF2F4', borderRadius: radius.md,
    borderWidth: 1, borderColor: color.deep + '40',
    padding: space.md, marginVertical: space.sm,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  label: { ...t.bodyStrong, color: color.deep, fontSize: 13 },
  sub: { ...t.small, color: color.mute, fontSize: 11 },
  countdown: { ...t.small, color: color.deep, fontSize: 11, fontWeight: '600' },
  stopBtn: {
    padding: space.sm, backgroundColor: '#FFF0EE',
    borderRadius: radius.md, borderWidth: 1, borderColor: color.signal + '40',
  },
});
