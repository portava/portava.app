/**
 * LiveShareRecipientView — trusted contact's view (TRUST-F10), mounted by app/safe-return/[shareId].tsx.
 * Shows approximate area and expiration countdown; refreshes every minute while active.
 * Exact GPS is never shown here. A failed read is "try again", never "ended" (lib/liveShareRecipient.ts).
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView,
} from 'react-native';
import { MapPin, Clock, MessageCircle, RefreshCw } from 'lucide-react-native'; import { classifyRecipientResponse, type RecipientOutcome } from '../../lib/liveShareRecipient.ts'; import { freshToken } from '../../services/apiToken.ts';
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

async function fetchRecipientView(shareId: string): Promise<RecipientOutcome> {
  try {
    // the token comes from the shared refresh-first helper (services/apiToken.ts)
    const token = await freshToken(); if (!token) return { kind: 'error', message: 'Please sign in again to view this live share.' };
    const base = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');
    const res = await fetch(`${base}/api/safe-return/live-share/${encodeURIComponent(shareId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data = await res.json().catch(() => null);
    // 404 = over (expired / stopped / not found) · 403 = not shared with you · 503 / network = try again
    return classifyRecipientResponse(res.status, data);
  } catch {
    return classifyRecipientResponse(null, null);
  }
}

const REFRESH_MS = 60_000;

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function LiveShareRecipientView({ shareId, onMessage }: Props) {
  const [outcome, setOutcome] = useState<RecipientOutcome | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const data: RecipientShareData | null = outcome?.kind === 'ok' ? outcome.share : null;
  const secs = useCountdownSec(data?.secondsRemaining ?? null);

  const load = useCallback(async (silent: boolean) => {
    if (silent) setRefreshing(true); else setOutcome(null);
    const r = await fetchRecipientView(shareId);
    setRefreshing(false);
    if (silent && r.kind === 'error') { setRefreshFailed(true); return; } // keep the last area, say it is not fresh
    setRefreshFailed(false);
    setOutcome(r);
    if (r.kind === 'ok') setUpdatedAt(Date.now());
  }, [shareId]);

  useEffect(() => { load(false); }, [load]);

  const active = data?.status === 'active';
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => { load(true); }, REFRESH_MS);
    return () => clearInterval(iv);
  }, [active, load]);

  if (!outcome) {
    return (
      <View style={styles.center} testID="live-share-loading">
        <ActivityIndicator color={color.deep} />
        <Text style={styles.loadingText}>Loading share details…</Text>
      </View>
    );
  }

  if (outcome.kind !== 'ok') {
    return (
      <View style={styles.center} testID={`live-share-${outcome.kind}`}>
        <Text style={styles.errorText}>
          {outcome.kind === 'ended' ? `This live share has ended. ${outcome.message}` : outcome.message}
        </Text>
        {outcome.kind === 'error' && (
          <Pressable style={styles.retryBtn} onPress={() => load(false)} accessibilityRole="button" accessibilityLabel="Retry">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        )}
      </View>
    );
  }

  const share = outcome.share;
  const expired = share.status !== 'active' || (share.secondsRemaining !== null && secs <= 0);

  return (
    <ScrollView contentContainerStyle={styles.root} testID="live-share-view">
      <View style={[styles.card, expired && styles.cardExpired]}>
        <View style={styles.iconRow}>
          <MapPin size={28} color={expired ? color.mute : color.deep} />
        </View>

        <Text style={styles.userName}>{share.sharingUserName}</Text>
        <Text style={styles.label}>is sharing their approximate location</Text>

        <View style={styles.areaBox}>
          <MapPin size={14} color={color.mute} />
          <Text style={styles.areaText}>{share.approximateArea}</Text>
        </View>

        {expired ? (
          <Text style={styles.expiredText}>This share has ended.</Text>
        ) : (
          <View style={styles.countdownRow}>
            <Clock size={14} color={color.deep} />
            <Text style={styles.countdown}>{share.secondsRemaining === null ? 'Sharing until they stop' : `Ends in ${formatCountdown(secs)}`}</Text>
          </View>
        )}

        {!expired && (
          <Pressable style={styles.refreshRow} onPress={() => load(true)} disabled={refreshing} accessibilityRole="button" accessibilityLabel="Refresh">
            {refreshing ? <ActivityIndicator size="small" color={color.deep} /> : <RefreshCw size={13} color={color.deep} />}
            <Text style={styles.refreshText}>
              {refreshFailed && updatedAt
                ? `Couldn't refresh · showing the area from ${clockTime(updatedAt)}`
                : updatedAt ? `Updated ${clockTime(updatedAt)} · Refresh` : 'Refresh'}
            </Text>
          </Pressable>
        )}

        {!expired && onMessage && (
          <Pressable style={styles.messageBtn} onPress={() => onMessage(share.sharingUserName)}>
            <MessageCircle size={16} color="#fff" />
            <Text style={styles.messageBtnText}>Message {share.sharingUserName}</Text>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  loadingText: { ...t.small, color: color.mute, marginTop: space.md },
  errorText: { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn: { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.deep, borderRadius: radius.pill },
  retryText: { ...t.small, color: color.onInk, fontWeight: '700' },
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
  refreshRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.xs },
  refreshText: { ...t.small, color: color.deep },
  messageBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.deep, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  messageBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 14 },
  privacyNote: { ...t.small, color: color.mute, fontSize: 11, textAlign: 'center', lineHeight: 16 },
});
