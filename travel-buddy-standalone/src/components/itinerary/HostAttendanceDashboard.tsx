/**
 * HostAttendanceDashboard — trip owner view of check-in attendance.
 * Shows totals, per-attendee status text, and manual override control.
 * Never shows map pins or GPS coordinates.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet,
  ActivityIndicator, Alert,
} from 'react-native';
import { X, Users, CheckCircle2, Clock, XCircle, ChevronDown } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  getAttendance, overrideAttendance,
  type AttendanceData, type AttendeeStatus, type AttendanceStatus,
} from '../../services/geofence.ts';

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<AttendanceStatus, { label: string; color: string; bg: string }> = {
  not_checked_in: { label: 'Not checked in', color: color.mute,    bg: color.haze },
  on_the_way:     { label: 'On the way',      color: '#B07000',     bg: '#FFF8E7' },
  nearby:         { label: 'Nearby',          color: color.deep,    bg: '#E2EDF0' },
  arrived:        { label: 'Arrived ✓',       color: color.success, bg: '#E3F1EA' },
  late:           { label: 'Late arrival',    color: '#B07000',     bg: '#FFF8E7' },
  no_show:        { label: 'No-show',         color: color.signal,  bg: '#FDEAEA' },
  left:           { label: 'Left',            color: color.mute,    bg: color.haze },
};

const OVERRIDE_OPTIONS: AttendanceStatus[] = ['arrived', 'late', 'no_show', 'on_the_way', 'left', 'not_checked_in'];

// ── Props ─────────────────────────────────────────────────────────────────────

export interface HostAttendanceDashboardProps {
  tripId: string;
  visible: boolean;
  onClose: () => void;
}

// ── Attendee row ──────────────────────────────────────────────────────────────

function AttendeeRow({
  tripId, attendee, onOverridden,
}: {
  tripId: string;
  attendee: AttendeeStatus;
  onOverridden: (userId: string, newStatus: AttendanceStatus) => void;
}) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const cfg = STATUS_CONFIG[attendee.status as AttendanceStatus] ?? STATUS_CONFIG.not_checked_in;

  const handleOverride = (newStatus: AttendanceStatus) => {
    Alert.alert(
      'Override attendance',
      `Set ${attendee.name || attendee.handle} to "${STATUS_CONFIG[newStatus].label}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Override',
          onPress: async () => {
            setSubmitting(true);
            try {
              await overrideAttendance(tripId, attendee.userId, newStatus);
              onOverridden(attendee.userId, newStatus);
              setOverrideOpen(false);
            } catch (e: any) {
              Alert.alert('Error', e.message ?? 'Override failed');
            } finally {
              setSubmitting(false);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={ar.wrap}>
      <View style={ar.left}>
        <Text style={ar.name}>{attendee.name || attendee.handle}</Text>
        <Text style={ar.handle}>@{attendee.handle}</Text>
        {attendee.checkedInAt && (
          <Text style={ar.time}>
            {new Date(attendee.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}
      </View>

      <View style={ar.right}>
        <View style={[ar.statusChip, { backgroundColor: cfg.bg }]}>
          <Text style={[ar.statusText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
        <Pressable style={ar.overrideBtn} onPress={() => setOverrideOpen(!overrideOpen)}>
          <ChevronDown size={13} color={color.mute} />
        </Pressable>
      </View>

      {overrideOpen && (
        <View style={ar.overrideList}>
          <Text style={ar.overrideHeading}>Override to:</Text>
          {OVERRIDE_OPTIONS.filter((s) => s !== attendee.status).map((s) => {
            const c = STATUS_CONFIG[s];
            return (
              <Pressable
                key={s}
                style={[ar.overrideOption, { backgroundColor: c.bg }]}
                onPress={() => handleOverride(s)}
                disabled={submitting}
              >
                <Text style={[ar.overrideOptionText, { color: c.color }]}>{c.label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export function HostAttendanceDashboard({ tripId, visible, onClose }: HostAttendanceDashboardProps) {
  const [data, setData] = useState<AttendanceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [attendees, setAttendees] = useState<AttendeeStatus[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAttendance(tripId);
      if (result) {
        setData(result);
        setAttendees(result.attendees);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Could not load attendance');
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const handleOverridden = (userId: string, newStatus: AttendanceStatus) => {
    setAttendees((prev) =>
      prev.map((a) =>
        a.userId === userId
          ? { ...a, status: newStatus, statusLabel: STATUS_CONFIG[newStatus]?.label ?? newStatus }
          : a,
      ),
    );
  };

  if (!visible) return null;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={d.overlay} />
      <View style={d.sheet}>
        <View style={d.handle} />

        <View style={d.header}>
          <Users size={18} color={color.deep} />
          <Text style={d.headerTitle}>Attendance</Text>
          <Pressable onPress={onClose} hitSlop={8} style={{ marginLeft: 'auto' }}>
            <X size={20} color={color.mute} />
          </Pressable>
        </View>

        {loading && !data ? (
          <View style={d.center}>
            <ActivityIndicator color={color.deep} />
            <Text style={d.loadingText}>Loading attendance…</Text>
          </View>
        ) : !data ? (
          <View style={d.center}>
            <Text style={d.emptyText}>No geofence configured for this trip.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={d.body} showsVerticalScrollIndicator={false}>

            {/* Totals */}
            <View style={d.totalsRow}>
              <TotalCard label="Accepted" value={data.totals.accepted} icon={<Users size={14} color={color.deep} />} />
              <TotalCard label="Arrived" value={data.totals.checkedIn} icon={<CheckCircle2 size={14} color={color.success} />} color={color.success} />
              <TotalCard label="No-show" value={data.totals.noShow} icon={<XCircle size={14} color={color.signal} />} color={color.signal} />
            </View>
            <View style={[d.totalsRow, { marginTop: 6 }]}>
              <TotalCard label="On the way" value={data.totals.onTheWay} icon={<Clock size={14} color="#B07000" />} color="#B07000" />
              <TotalCard label="Nearby" value={data.totals.nearby} icon={<Clock size={14} color={color.deep} />} color={color.deep} />
              <TotalCard label="Not checked in" value={data.totals.notCheckedIn} icon={<Clock size={14} color={color.mute} />} />
            </View>

            {/* Check-in window */}
            {(data.checkInWindowStart || data.checkInWindowEnd) && (
              <View style={d.windowCard}>
                <Clock size={13} color={color.mute} />
                <Text style={d.windowText}>
                  Window:{' '}
                  {data.checkInWindowStart ? new Date(data.checkInWindowStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'open'}
                  {' → '}
                  {data.checkInWindowEnd ? new Date(data.checkInWindowEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'open'}
                </Text>
              </View>
            )}

            {/* Privacy note */}
            <View style={d.privacyNote}>
              <Text style={d.privacyText}>Attendance statuses only — no GPS coordinates or map pins.</Text>
            </View>

            {/* Attendee list */}
            <Text style={d.sectionLabel}>Attendees ({attendees.length})</Text>
            {attendees.length === 0 ? (
              <Text style={d.emptyText}>No accepted members yet.</Text>
            ) : (
              attendees.map((a) => (
                <AttendeeRow
                  key={a.userId}
                  tripId={tripId}
                  attendee={a}
                  onOverridden={handleOverridden}
                />
              ))
            )}

            <Pressable style={d.refreshBtn} onPress={load} disabled={loading}>
              <Text style={d.refreshText}>{loading ? 'Refreshing…' : 'Refresh'}</Text>
            </Pressable>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

// ── TotalCard ─────────────────────────────────────────────────────────────────

function TotalCard({ label, value, icon, color: textColor }: {
  label: string; value: number; icon: React.ReactNode; color?: string;
}) {
  return (
    <View style={tc.card}>
      {icon}
      <Text style={[tc.value, textColor ? { color: textColor } : {}]}>{value}</Text>
      <Text style={tc.label}>{label}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const d = StyleSheet.create({
  overlay:     { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet:       { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '90%' },
  handle:      { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  header:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  headerTitle: { ...t.body, color: color.ink, fontWeight: '700', fontSize: 16 },
  body:        { paddingHorizontal: space.lg, paddingBottom: 48, gap: 10 },
  center:      { padding: 40, alignItems: 'center', gap: 10 },
  loadingText: { ...t.body, color: color.mute },
  emptyText:   { ...t.body, color: color.mute, textAlign: 'center' },
  totalsRow:   { flexDirection: 'row', gap: 8 },
  windowCard:  { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.haze, borderRadius: radius.sm, padding: 10 },
  windowText:  { ...t.small, color: color.mute },
  privacyNote: { backgroundColor: '#E2EDF0', borderRadius: radius.sm, padding: 10 },
  privacyText: { ...t.small, color: color.deep },
  sectionLabel:{ ...t.small, color: color.mute, fontWeight: '700', marginTop: 4 },
  refreshBtn:  { alignItems: 'center', padding: 12, borderRadius: radius.md, backgroundColor: color.haze, marginTop: 8 },
  refreshText: { ...t.body, color: color.ink, fontWeight: '600' },
});

const tc = StyleSheet.create({
  card:  { flex: 1, backgroundColor: '#F8F7F4', borderRadius: radius.md, padding: 12, alignItems: 'center', gap: 4 },
  value: { ...t.title, fontSize: 22, color: color.ink, fontWeight: '800' },
  label: { ...t.small, color: color.mute, textAlign: 'center' },
});

const ar = StyleSheet.create({
  wrap:              { backgroundColor: '#F8F7F4', borderRadius: radius.md, padding: 12, gap: 8 },
  left:              { flex: 1 },
  right:             { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name:              { ...t.body, color: color.ink, fontWeight: '600' },
  handle:            { ...t.small, color: color.mute },
  time:              { ...t.small, color: color.faint },
  statusChip:        { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  statusText:        { ...t.small, fontWeight: '700', fontSize: 11 },
  overrideBtn:       { padding: 4, backgroundColor: color.haze, borderRadius: 6 },
  overrideList:      { gap: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: color.haze },
  overrideHeading:   { ...t.small, color: color.mute, fontWeight: '600' },
  overrideOption:    { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  overrideOptionText:{ ...t.small, fontWeight: '600' },
});
