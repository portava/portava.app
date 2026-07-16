/**
 * LiveShareRecipientView — trusted contact's view
 * Shows approximate area and expiration countdown.
 * Exact GPS is never shown here.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView,
} from 'react-native';
import { MapPin, Clock, MessageCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface RecipientShareData {
  shareId: string;
  status: 'active' | 'stopped' | 'expired';
  sharingUserName: string;
  approximateArea: string;
  expiresAt: string | null;
  secondsRemaining: number | null;
}

interface Props {
  shareId: string;
  onMessage?: (userName: string) => void;
}

function useCountdownSec(secondsRemaining: number | null): number {
  const [secs, setSecs] = useState(secondsRemaining ?? 0);
  useEffect(() => {
    if (secondsRemaining === null) return;
    setSecs(secondsRemaining);
    const id = setInterval(() => setSecs((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [secondsRemaining]);
  return secs;
}

function formatCountdown(secs: number): string {
  if (secs <= 0) return 'Expired';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

async function fetchRecipientView(shareId: string): Promise<RecipientShareData | null> {
  try {
    const { supabase } = await import('../../lib/supabase');
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token ?? '';
    const base = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');
    const res = await fetch(`${base}/api/safe-return/live-share/${shareId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (!data?.ok) return null;
    return data.share as RecipientShareData;
  } catch {
    return null;
  }
}

export function LiveShareRecipientView({ shareId, onMessage }: Props) {
  const [data, setData] = useState<RecipientShareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const secs = useCountdownSec(data?.secondsRemaining ?? null);

  useEffect(() => {
    setLoading(true);
    fetchRecipientView(shareId).then((d) => {
      setLoading(false);
      if (!d) { setError('This share is unavailable or has expired.'); return; }
      setData(d);
    });
  }, [shareId]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={color.deep} />
        <Text style={styles.loadingText}>Loading share details…</Text>
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error ?? 'Unable to load share.'}</Text>
      </View>
    );
  }

  const expired = data.status !== 'active' || secs <= 0;

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <View style={[styles.card, expired && styles.cardExpired]}>
        <View style={styles.iconRow}>
          <MapPin size={28} color={expired ? color.mute : color.deep} />
        </View>

        <Text style={styles.userName}>{data.sharingUserName}</Text>
        <Text style={styles.label}>is sharing their approximate location</Text>

        <View style={styles.areaBox}>
          <MapPin size={14} color={color.mute} />
          <Text style={styles.areaText}>{data.approximateArea}</Text>
        </View>

        {expired ? (
          <Text style={styles.expiredText}>This share has ended.</Text>
        ) : (
          <View style={styles.countdownRow}>
            <Clock size={14} color={color.deep} />
            <Text style={styles.countdown}>Ends in {formatCountdown(secs)}</Text>
          </View>
        )}

        {!expired && onMessage && (
          <Pressable style={styles.messageBtn} onPress={() => onMessage(data.sharingUserName)}>
            <MessageCircle size={16} color="#fff" />
            <Text style={styles.messageBtnText}>Message {data.sharingUserName}</Text>
          </Pressable>
        )}

        <Text style={styles.privacyNote}>
          Only approximate area is shared. Exact GPS is never visible.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  loadingText: { ...t.small, color: color.mute, marginTop: space.md },
  errorText: { ...t.body, color: color.mute, textAlign: 'center' },
  root: { padding: space.lg },
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze, padding: space.xl, alignItems: 'center', gap: space.md,
  },
  cardExpired: { opacity: 0.7 },
  iconRow: { marginBottom: space.sm },
  userName: { ...t.bodyStrong, color: color.ink, fontSize: 18 },
  label: { ...t.small, color: color.mute, fontSize: 13 },
  areaBox: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: '#EAF2F4', borderRadius: radius.pill,
    paddingHorizontal: space.lg, paddingVertical: space.sm,
  },
  areaText: { ...t.bodyStrong, color: color.deep, fontSize: 14 },
  expiredText: { ...t.small, color: color.mute, fontStyle: 'italic' },
  countdownRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  countdown: { ...t.bodyStrong, color: color.deep, fontSize: 14 },
  messageBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.deep, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  messageBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 14 },
  privacyNote: { ...t.small, color: color.mute, fontSize: 11, textAlign: 'center', lineHeight: 16 },
});
