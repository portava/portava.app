/**
 * TripHeartbeatCard — Phase 13 Trip Autopilot health view.
 *
 * Shows trip health at a glance (healthy / attention / at risk), active
 * issues with concrete reasons, upcoming risks (e.g. weather), and pending
 * Autopilot proposals the user can confirm or decline. Autopilot only ever
 * proposes — nothing changes without an explicit confirm here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet, Switch } from 'react-native';
import { HeartPulse, RefreshCw, Check, X, Settings2 } from 'lucide-react-native';
import {
  fetchTripHeartbeat,
  runTripAutopilotCheck,
  fetchAutopilotProposals,
  resolveAutopilotProposal,
  fetchAutopilotSettings,
  putAutopilotSettings,
  type TripHeartbeat,
  type AutopilotProposal,
  type AutopilotSettings,
} from '../../services/compass.ts';

const STATUS_META: Record<TripHeartbeat['status'], { label: string; color: string; bg: string }> = {
  healthy: { label: 'On track', color: '#16a34a', bg: '#f0fdf4' },
  attention: { label: 'Needs attention', color: '#d97706', bg: '#fffbeb' },
  at_risk: { label: 'At risk', color: '#dc2626', bg: '#fef2f2' },
};

export function TripHeartbeatCard({ tripId }: { tripId: string }) {
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [heartbeat, setHeartbeat] = useState<TripHeartbeat | null>(null);
  const [proposals, setProposals] = useState<AutopilotProposal[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [settings, setSettings] = useState<AutopilotSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [savingKey, setSavingKey] = useState<keyof AutopilotSettings | null>(null);

  const load = useCallback(async () => {
    const hb = await fetchTripHeartbeat(tripId);
    if (hb.ok && hb.compassEnabled === false) {
      setEnabled(false);
      setLoading(false);
      return;
    }
    if (hb.ok && hb.heartbeat) setHeartbeat(hb.heartbeat);
    const st = await fetchAutopilotSettings(tripId);
    if (st.ok && st.settings) setSettings(st.settings);
    const pr = await fetchAutopilotProposals(tripId);
    if (pr.ok && pr.proposals) setProposals(pr.proposals.filter((p) => p.status === 'pending'));
    setLoading(false);
  }, [tripId]);

  useEffect(() => {
    load();
  }, [load]);

  const onCheckNow = useCallback(async () => {
    setChecking(true);
    await runTripAutopilotCheck(tripId);
    await load();
    setChecking(false);
  }, [tripId, load]);

  const onToggleSetting = useCallback(
    async (key: keyof AutopilotSettings, value: boolean) => {
      setSavingKey(key);
      const prev = settings;
      setSettings((s) => (s ? { ...s, [key]: value } : s));
      const r = await putAutopilotSettings(tripId, { [key]: value });
      if (r.ok && r.settings) setSettings(r.settings);
      else setSettings(prev ?? null);
      setSavingKey(null);
    },
    [tripId, settings],
  );

  const onResolve = useCallback(
    async (id: string, action: 'confirm' | 'decline') => {
      setResolving(id);
      await resolveAutopilotProposal(id, action);
      await load();
      setResolving(null);
    },
    [load],
  );

  if (!enabled) return null;
  if (loading) {
    return (
      <View style={styles.card} testID="trip-heartbeat-loading">
        <ActivityIndicator size="small" color="#94a3b8" />
      </View>
    );
  }
  if (!heartbeat) return null;

  const meta = STATUS_META[heartbeat.status] ?? STATUS_META.healthy;

  return (
    <View style={styles.card} testID="trip-heartbeat-card">
      <View style={styles.headerRow}>
        <View style={styles.titleRow}>
          <HeartPulse size={16} color={meta.color} />
          <Text style={styles.title}>Trip Heartbeat</Text>
        </View>
        <View style={styles.titleRow}>
          <View style={[styles.badge, { backgroundColor: meta.bg }]} testID="trip-heartbeat-status">
            <Text style={[styles.badgeText, { color: meta.color }]}>{meta.label}</Text>
          </View>
          <Pressable
            onPress={() => setShowSettings((v) => !v)}
            hitSlop={8}
            testID="autopilot-settings-toggle"
            accessibilityLabel="Autopilot permissions"
          >
            <Settings2 size={16} color="#64748b" />
          </Pressable>
        </View>
      </View>

      {showSettings && settings ? (
        <View style={styles.settingsPanel} testID="autopilot-settings-panel">
          <Text style={styles.settingsTitle}>What Autopilot may touch</Text>
          {(
            [
              { key: 'enabled', label: 'Autopilot on', hint: 'Watch this trip and suggest fixes' },
              { key: 'allowMoveFlexible', label: 'Move flexible plans', hint: 'May propose new times for Flexible items' },
              { key: 'allowMoveOptional', label: 'Move optional plans', hint: 'May propose new times for Optional items' },
              { key: 'allowRemoveOptional', label: 'Remove optional plans', hint: 'May propose dropping Optional items' },
            ] as { key: keyof AutopilotSettings; label: string; hint: string }[]
          ).map(({ key, label, hint }) => {
            const grantDisabled = key !== 'enabled' && !settings.enabled;
            return (
              <View key={key} style={styles.settingRow} testID={`autopilot-setting-${key}`}>
                <View style={styles.settingText}>
                  <Text style={[styles.settingLabel, grantDisabled && styles.settingLabelDisabled]}>{label}</Text>
                  <Text style={styles.settingHint}>{hint}</Text>
                </View>
                <Switch
                  value={settings[key]}
                  onValueChange={(v) => onToggleSetting(key, v)}
                  disabled={savingKey !== null || grantDisabled}
                  testID={`autopilot-switch-${key}`}
                />
              </View>
            );
          })}
          <Text style={styles.settingsFootnote}>
            Fixed plans are never touched. Autopilot only proposes — nothing changes without your confirm.
          </Text>
        </View>
      ) : null}

      {heartbeat.issues.length === 0 && heartbeat.risks.length === 0 ? (
        <Text style={styles.okText}>No conflicts or risks detected. Everything looks workable.</Text>
      ) : null}

      {heartbeat.issues.map((issue, idx) => (
        <View key={`issue-${idx}`} style={styles.issueRow} testID={`trip-heartbeat-issue-${idx}`}>
          <View style={[styles.dot, { backgroundColor: issue.severity === 'high' ? '#dc2626' : issue.severity === 'attention' ? '#d97706' : '#64748b' }]} />
          <Text style={styles.issueText}>{issue.reason}</Text>
        </View>
      ))}

      {heartbeat.risks.map((risk, idx) => (
        <View key={`risk-${idx}`} style={styles.issueRow} testID={`trip-heartbeat-risk-${idx}`}>
          <View style={[styles.dot, { backgroundColor: '#0ea5e9' }]} />
          <Text style={styles.issueText}>
            {risk.label} — {risk.detail}
          </Text>
        </View>
      ))}

      {proposals.map((p) => (
        <View key={p.id} style={styles.proposal} testID={`autopilot-proposal-${p.id}`}>
          <Text style={styles.proposalReason}>{p.reason}</Text>
          <View style={styles.proposalActions}>
            <Pressable
              style={[styles.actionBtn, styles.confirmBtn]}
              onPress={() => onResolve(p.id, 'confirm')}
              disabled={resolving === p.id}
              testID={`autopilot-confirm-${p.id}`}
            >
              <Check size={14} color="#fff" />
              <Text style={styles.confirmText}>Apply</Text>
            </Pressable>
            <Pressable
              style={[styles.actionBtn, styles.declineBtn]}
              onPress={() => onResolve(p.id, 'decline')}
              disabled={resolving === p.id}
              testID={`autopilot-decline-${p.id}`}
            >
              <X size={14} color="#64748b" />
              <Text style={styles.declineText}>Keep as is</Text>
            </Pressable>
          </View>
        </View>
      ))}

      {settings?.enabled === false ? (
        <Text style={styles.autopilotOffText} testID="autopilot-off-note">
          Autopilot is off for this trip. You still see honest health above — no new proposals will be created.
        </Text>
      ) : (
        <Pressable style={styles.checkBtn} onPress={onCheckNow} disabled={checking} testID="trip-heartbeat-check">
          <RefreshCw size={13} color="#0f172a" />
          <Text style={styles.checkText}>{checking ? 'Checking…' : 'Check my trip now'}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
    gap: 10,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  okText: { fontSize: 12.5, color: '#475569' },
  issueRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4, marginTop: 5 },
  issueText: { flex: 1, fontSize: 12.5, color: '#334155', lineHeight: 17 },
  proposal: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    gap: 8,
  },
  proposalReason: { fontSize: 12.5, color: '#0f172a', lineHeight: 17 },
  proposalActions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  confirmBtn: { backgroundColor: '#0f172a' },
  confirmText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  declineBtn: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0' },
  declineText: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  checkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
  },
  checkText: { fontSize: 12.5, fontWeight: '600', color: '#0f172a' },
  settingsPanel: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
    gap: 10,
  },
  settingsTitle: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  settingText: { flex: 1 },
  settingLabel: { fontSize: 12.5, fontWeight: '600', color: '#0f172a' },
  settingLabelDisabled: { color: '#94a3b8' },
  settingHint: { fontSize: 11, color: '#64748b', marginTop: 1 },
  settingsFootnote: { fontSize: 11, color: '#64748b', lineHeight: 15 },
  autopilotOffText: { fontSize: 12, color: '#64748b', lineHeight: 16 },
});
