/**
 * "Your reports" screen — /profile/edit/reports
 *
 * Shows the reporter's own moderation report history via RLS-filtered
 * GET /api/moderation/reports/mine.
 *
 * Each row: relative date, subject type label, category label, status chip.
 * Empty state: "No reports submitted."
 */
import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator } from 'react-native';
import { Flag } from 'lucide-react-native';
import {
  SettingsScreen,
  SettingsSection,
} from '../../../src/components/settings/SettingsUI';
import { PP } from '../../../src/theme/passportTokens';
import { space, radius, type as t } from '../../../src/theme/tokens';
import {
  getMyModerationReports,
  MODERATION_CATEGORY_LABELS,
  MODERATION_SUBJECT_LABELS,
  type ModerationReport,
  type ModerationCategory,
  type ModerationSubjectType,
} from '../../../src/services/moderation';

// ── Status chip ───────────────────────────────────────────────────────────────

const STATUS_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  open:       { label: 'Under review',  bg: '#EFF6FF', fg: '#2563EB' },
  reviewing:  { label: 'Reviewing',     bg: '#FEF9C3', fg: '#854D0E' },
  actioned:   { label: 'Actioned',      bg: '#DCFCE7', fg: '#166534' },
  dismissed:  { label: 'Dismissed',     bg: '#F3F4F6', fg: '#6B7280' },
};

function StatusChip({ status }: { status: string }) {
  const chip = STATUS_CHIP[status] ?? STATUS_CHIP.open;
  return (
    <View style={[sx.chip, { backgroundColor: chip.bg }]}>
      <Text style={[sx.chipText, { color: chip.fg }]}>{chip.label}</Text>
    </View>
  );
}

// ── Relative date ─────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'Just now';
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Report row ────────────────────────────────────────────────────────────────

function ReportRow({ report }: { report: ModerationReport }) {
  const subjectLabel = MODERATION_SUBJECT_LABELS[report.subject_type as ModerationSubjectType]
    ?? report.subject_type;
  const categoryLabel = MODERATION_CATEGORY_LABELS[report.category as ModerationCategory]
    ?? report.category;

  return (
    <View style={sx.row}>
      <View style={sx.rowLeft}>
        <Flag size={14} color={PP.inkMuted} />
        <View style={{ flex: 1 }}>
          <Text style={sx.rowTitle}>{subjectLabel} · {categoryLabel}</Text>
          <Text style={sx.rowDate}>{timeAgo(report.created_at)}</Text>
        </View>
      </View>
      <StatusChip status={report.status} />
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function YourReportsScreen() {
  const [reports, setReports]   = useState<ModerationReport[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await getMyModerationReports(50);
      if (!alive) return;
      setLoading(false);
      if (res.ok) setReports(res.reports);
      else setError(res.error ?? 'Could not load reports');
    })();
    return () => { alive = false; };
  }, []);

  return (
    <SettingsScreen
      title="Your Reports"
      subtitle="Reports you've submitted for review"
    >
      <SettingsSection title="Report history">
        {loading ? (
          <View style={sx.center}><ActivityIndicator color={PP.ink} /></View>
        ) : error ? (
          <View style={sx.center}><Text style={sx.errorText}>{error}</Text></View>
        ) : reports.length === 0 ? (
          <View style={sx.center}>
            <Flag size={28} color={PP.inkMuted} />
            <Text style={sx.emptyText}>No reports submitted.</Text>
          </View>
        ) : (
          <FlatList
            data={reports}
            keyExtractor={(r) => r.id}
            renderItem={({ item }) => <ReportRow report={item} />}
            scrollEnabled={false}
            ItemSeparatorComponent={() => <View style={sx.divider} />}
          />
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sx = StyleSheet.create({
  center: {
    padding: space.xl,
    alignItems: 'center',
    gap: space.sm,
  },
  errorText: { ...t.body, color: PP.inkMuted, textAlign: 'center' },
  emptyText: { ...t.body, color: PP.inkMuted, textAlign: 'center', marginTop: space.sm },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    minHeight: 52,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flex: 1,
    paddingRight: space.sm,
  },
  rowTitle: { ...t.small, fontWeight: '600', color: PP.ink },
  rowDate:  { ...t.small, color: PP.inkMuted, marginTop: 2 },

  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: { fontSize: 11, fontWeight: '700' },

  divider: {
    height: 1,
    backgroundColor: PP.paper,
    marginHorizontal: space.md,
  },
});
