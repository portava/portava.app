/**
 * Safety History screen — private, shows the user's own Safe Return sessions.
 * Accessible from Settings → Safety → Safe Return history.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { Shield, CheckCircle, AlertCircle, Clock, X, ChevronLeft } from 'lucide-react-native';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { getHistory, type SafeReturnSession, type SafeReturnSessionEvents } from '../src/services/safeReturn';
import { SafeReturnSetupSheet } from '../src/components/safeReturn/SafeReturnSetupSheet';
import { useSession } from '../src/context/SessionContext';

// ── Status display map ────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, React.ElementType> = {
  safe:      CheckCircle,
  active:    Clock,
  missed:    AlertCircle,
  cancelled: X,
  pending:   Clock,
};

const STATUS_COLOR: Record<string, string> = {
  safe:      color.success,
  active:    color.deep,
  missed:    '#F5A623',
  cancelled: color.mute,
  pending:   color.mute,
};

const STATUS_LABEL: Record<string, string> = {
  safe:      'Returned safe',
  active:    'Active',
  missed:    'Missed check-in',
  cancelled: 'Cancelled',
  pending:   'Pending',
};

const ESCALATION_LABEL: Record<number, string> = {
  0: 'Notify me only',
  1: 'Trusted Circle alert',
  2: 'TC alert + location share',
  3: 'Full escalation',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(session: SafeReturnSession): string | null {
  if (!session.timerStartAt || !session.closedAt) return null;
  const ms = new Date(session.closedAt).getTime() - new Date(session.timerStartAt).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Session row ───────────────────────────────────────────────────────────────

function EventBadges({ events }: { events: SafeReturnSessionEvents }) {
  const items: Array<{ label: string; value: number; color: string }> = [
    { label: 'Alerts sent', value: events.alertsSent, color: '#F5A623' },
    { label: 'Missed', value: events.missedCount, color: color.signal },
    { label: 'Live share', value: events.liveShareStarted, color: color.deep },
  ].filter((i) => i.value > 0);

  if (items.length === 0) return null;
  return (
    <View style={styles.eventBadgeRow}>
      {items.map((item) => (
        <View key={item.label} style={[styles.eventBadge, { borderColor: item.color + '40' }]}>
          <Text style={[styles.eventBadgeCount, { color: item.color }]}>{item.value}</Text>
          <Text style={styles.eventBadgeLabel}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

function SessionRow({ session }: { session: SafeReturnSession }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = STATUS_ICON[session.status] ?? Clock;
  const iconColor = STATUS_COLOR[session.status] ?? color.mute;
  const statusLabel = STATUS_LABEL[session.status] ?? session.status;
  const duration = formatDuration(session);

  return (
    <Pressable style={styles.row} onPress={() => setExpanded((v) => !v)}>
      <View style={styles.rowHeader}>
        <View style={[styles.iconWrap, { backgroundColor: iconColor + '18' }]}>
          <Icon size={16} color={iconColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.statusLabel, { color: iconColor }]}>{statusLabel}</Text>
          <Text style={styles.dateLabel}>{formatDate(session.createdAt)}</Text>
        </View>
        {duration ? <Text style={styles.duration}>{duration}</Text> : null}
      </View>

      {session.events && (
        <EventBadges events={session.events} />
      )}

      {expanded && (
        <View style={styles.detail}>
          {session.timerStartAt && (
            <Text style={styles.detailLine}>
              Started: {formatTime(session.timerStartAt)}
              {session.closedAt ? `  →  Ended: ${formatTime(session.closedAt)}` : ''}
            </Text>
          )}
          <Text style={styles.detailLine}>
            Escalation: {ESCALATION_LABEL[session.escalationLevel] ?? `Level ${session.escalationLevel}`}
          </Text>
          {session.trustedCircleEnabled && (
            <Text style={styles.detailLine}>✓ Trusted Circle alerts enabled</Text>
          )}
          {session.liveShareEnabled && (
            <Text style={styles.detailLine}>✓ Approximate location sharing enabled</Text>
          )}
          {session.notifyHostEnabled && (
            <Text style={styles.detailLine}>✓ Trip host notifications enabled</Text>
          )}
          {session.triggerReason && (
            <Text style={styles.detailLine}>Reason: {session.triggerReason}</Text>
          )}
          {session.emergencyNote && (
            <Text style={styles.detailLine}>Note: {session.emergencyNote}</Text>
          )}
          {session.events && session.events.alertsSent === 0 && session.events.missedCount === 0 && session.events.liveShareStarted === 0 && (
            <Text style={styles.detailLine}>No alerts or escalations recorded</Text>
          )}
        </View>
      )}
    </Pressable>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function SafetyHistoryScreen() {
  const { isAuthed, configured } = useSession();
  const [sessions, setSessions] = useState<SafeReturnSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [featureEnabled, setFeatureEnabled] = useState(true);
  const [setupVisible, setSetupVisible] = useState(false);

  const load = useCallback(async () => {
    const result = await getHistory(50);
    setSessions(result.sessions);
    if (result.featureEnabled === false) setFeatureEnabled(false);
  }, []);

  useEffect(() => {
    if (!(configured && isAuthed)) { setLoading(false); return; }
    load().then(() => setLoading(false));
  }, [configured, isAuthed, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <View style={styles.root}>
      <ScreenHeader title="Safe Return History" back />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.deep} />
        </View>
      ) : !featureEnabled ? (
        <View style={styles.center}>
          <Shield size={36} color={color.mute} />
          <Text style={styles.emptyTitle}>Safe Return isn't available yet</Text>
          <Text style={styles.emptyBody}>
            Safe Return lets you set a check-in timer when you head out solo — if you miss it, your Trusted Circle gets
            alerted automatically. It will be available in a future update. Stay tuned!
          </Text>
        </View>
      ) : sessions.length === 0 ? (
        <View style={styles.center}>
          <Shield size={36} color={color.mute} />
          <Text style={styles.emptyTitle}>No Safe Return history yet</Text>
          <Text style={styles.emptyBody}>
            Safe Return lets you set a check-in timer when heading out on a solo activity during a trip. When you
            use it, your sessions will appear here — privately, only visible to you.
          </Text>
          <Pressable style={styles.startBtn} onPress={() => setSetupVisible(true)}>
            <Text style={styles.startBtnText}>Start Safe Return</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.deep} />}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.privacy}>
            🔒 Only you can see this history. Sessions older than 90 days are automatically removed.
          </Text>

          {/* Summary chips */}
          <View style={styles.summaryRow}>
            {(['safe', 'missed', 'cancelled'] as const).map((status) => {
              const count = sessions.filter((s) => s.status === status).length;
              if (count === 0) return null;
              return (
                <View key={status} style={[styles.summaryChip, { borderColor: STATUS_COLOR[status] + '40' }]}>
                  <Text style={[styles.summaryCount, { color: STATUS_COLOR[status] }]}>{count}</Text>
                  <Text style={styles.summaryLabel}>{STATUS_LABEL[status]}</Text>
                </View>
              );
            })}
          </View>

          {sessions.map((s) => <SessionRow key={s.id} session={s} />)}
        </ScrollView>
      )}

      <SafeReturnSetupSheet
        visible={setupVisible}
        onClose={() => setSetupVisible(false)}
        onStarted={() => { setSetupVisible(false); load(); }}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  emptyTitle: { ...t.bodyStrong, color: color.ink, fontSize: 16, marginTop: space.md, textAlign: 'center' },
  emptyBody: { ...t.small, color: color.mute, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: space.sm },
  list: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm, paddingBottom: 40 },
  privacy: {
    ...t.small, color: '#2D6A4F', fontSize: 11, lineHeight: 17,
    backgroundColor: '#F0F7F4', borderRadius: radius.md, padding: space.md,
    marginBottom: space.sm,
  },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.sm },
  summaryChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: 5,
    backgroundColor: color.paperRaised,
  },
  summaryCount: { ...t.bodyStrong, fontSize: 14 },
  summaryLabel: { ...t.small, color: color.mute, fontSize: 11 },
  row: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  iconWrap: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  statusLabel: { ...t.bodyStrong, fontSize: 13 },
  dateLabel: { ...t.small, color: color.mute, fontSize: 11 },
  duration: { ...t.small, color: color.mute, fontSize: 11 },
  detail: { marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.haze, gap: 4 },
  detailLine: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 18 },
  eventBadgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  eventBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderRadius: radius.pill,
    paddingHorizontal: 8, paddingVertical: 3,
    backgroundColor: color.paper,
  },
  eventBadgeCount: { ...t.bodyStrong, fontSize: 12 },
  eventBadgeLabel: { ...t.small, color: color.mute, fontSize: 11 },
  startBtn: {
    marginTop: space.lg,
    backgroundColor: color.deep,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    paddingVertical: 12,
  },
  startBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 15 },
});
