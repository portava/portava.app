/**
 * EventAttendancePanel — the host's attendance list (PLAT-F26).
 *
 * Host Dashboard → Attendance. Lists every Going attendee from
 * GET /api/events/:id/attendees with their self check-in, and lets the host
 * (or a moderator) confirm attendance or mark a no-show through
 * POST /attendance/:userId and POST /noshow/:userId.
 *
 * The server accepts those marks only while the STORED state is `started` or
 * `completed`, so the buttons are live only then (lib/eventCheckIn.ts
 * `attendanceMarkingOpen`) and the panel says why otherwise. A failed read is
 * an error with Retry — never an empty list — and a refused mark is shown as
 * the server's message, never as a mark.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { UserCheck, UserX, MapPinCheck } from 'lucide-react-native';
import {
  getEventAttendees, confirmAttendance, markNoShow,
  type EventAttendanceRow, type EventDetail,
} from '../../services/events.ts';
import { attendanceMark, attendanceMarkingOpen, type AttendanceMark } from '../../lib/eventCheckIn.ts';
import { Avatar } from '../ui.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  event: Pick<EventDetail, 'id' | 'state'>;
}

const MARK_LABEL: Record<AttendanceMark, string> = {
  confirmed: 'Attended',
  no_show: 'No-show',
  checked_in: 'Checked in',
  unmarked: 'Not checked in',
};

function clock(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function EventAttendancePanel({ event }: Props) {
  const [rows, setRows] = useState<EventAttendanceRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ userId: string; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getEventAttendees(event.id);
    if (res.ok && Array.isArray(res.data?.attendees)) setRows(res.data!.attendees);
    else { setRows(null); setError(res.message ?? "We couldn't load the attendance list."); }
    setLoading(false);
  }, [event.id]);

  useEffect(() => { load(); }, [load]);

  const open = attendanceMarkingOpen(event.state);

  async function mark(row: EventAttendanceRow, kind: 'confirm' | 'no_show') {
    if (busyId) return;
    setBusyId(row.userId);
    setRowError(null);
    const res = kind === 'confirm'
      ? await confirmAttendance(event.id, row.userId)
      : await markNoShow(event.id, row.userId);
    setBusyId(null);
    if (!res.ok) {
      setRowError({ userId: row.userId, message: res.message ?? 'That did not save. Please try again.' });
      return;
    }
    const at = kind === 'confirm' ? (res.data as { confirmedAt?: string } | null)?.confirmedAt : (res.data as { noShowAt?: string } | null)?.noShowAt;
    const stamp = at ?? new Date().toISOString();
    setRows((prev) => (prev ?? []).map((r) => (r.userId !== row.userId ? r
      : kind === 'confirm' ? { ...r, confirmedAt: stamp } : { ...r, noShowAt: stamp })));
  }

  if (loading) {
    return <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} testID="attendance-loading" />;
  }
  if (error || !rows) {
    return (
      <View style={s.empty} testID="attendance-error">
        <Text style={s.emptyText}>{error ?? "We couldn't load the attendance list."}</Text>
        <Pressable style={s.retryBtn} onPress={load} accessibilityRole="button" accessibilityLabel="Retry">
          <Text style={s.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const checkedIn = rows.filter((r) => r.checkedInAt).length;

  return (
    <View style={{ gap: space.sm }} testID="attendance-list">
      <Text style={s.summary}>{`${rows.length} going · ${checkedIn} checked in`}</Text>
      {!open && (
        <Text style={s.note} testID="attendance-not-open">
          You can confirm attendance and mark no-shows once the event has started.
        </Text>
      )}
      {rows.length === 0 ? (
        <View style={s.empty}><Text style={s.emptyText}>Nobody is going yet</Text></View>
      ) : rows.map((r) => {
        const m = attendanceMark(r);
        const busy = busyId === r.userId;
        return (
          <View key={r.userId} style={s.row} testID={`attendance-row-${r.userId}`}>
            <Avatar uri={r.avatarUrl ?? ''} size={36} />
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>{r.displayName ?? (r.handle ? `@${r.handle}` : 'Traveler')}</Text>
              <View style={s.markRow}>
                {m === 'checked_in' && <MapPinCheck size={12} color={color.success} />}
                <Text style={[s.mark, m === 'no_show' && { color: '#DC2626' }, m === 'confirmed' && { color: color.success }]}>
                  {MARK_LABEL[m]}{r.checkedInAt ? ` · checked in ${clock(r.checkedInAt)}` : ''}
                </Text>
              </View>
              {rowError?.userId === r.userId && <Text style={s.error}>{rowError.message}</Text>}
            </View>
            {open && (busy ? <ActivityIndicator size="small" color={color.signal} /> : (
              <View style={s.actions}>
                <Pressable
                  style={[s.actBtn, m === 'confirmed' && s.actBtnOn]}
                  onPress={() => mark(r, 'confirm')}
                  accessibilityRole="button"
                  accessibilityLabel={`Confirm ${r.handle ?? 'attendee'} attended`}
                  hitSlop={6}
                >
                  <UserCheck size={15} color={m === 'confirmed' ? color.onInk : color.success} />
                </Pressable>
                <Pressable
                  style={[s.actBtn, m === 'no_show' && s.actBtnNoShow]}
                  onPress={() => mark(r, 'no_show')}
                  accessibilityRole="button"
                  accessibilityLabel={`Mark ${r.handle ?? 'attendee'} as a no-show`}
                  hitSlop={6}
                >
                  <UserX size={15} color={m === 'no_show' ? color.onInk : '#DC2626'} />
                </Pressable>
              </View>
            ))}
          </View>
        );
      })}
      {open && rows.length > 0 && (
        <Text style={s.note}>Confirming attendance credits the attendee's reliability; a no-show counts against it.</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  summary:   { ...t.small, color: color.mute, fontWeight: '700' },
  note:      { ...t.small, color: color.mute },
  empty:     { alignItems: 'center', paddingVertical: space.xl, gap: space.md },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn:  { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText: { ...t.small, color: color.onInk, fontWeight: '700' },
  row:       { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  name:      { ...t.body, color: color.ink, fontWeight: '600' },
  markRow:   { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  mark:      { ...t.small, color: color.mute },
  error:     { ...t.small, color: '#DC2626', marginTop: 2 },
  actions:   { flexDirection: 'row', gap: space.xs },
  actBtn:    { paddingHorizontal: space.sm, paddingVertical: space.sm, borderRadius: radius.md, backgroundColor: color.haze },
  actBtnOn:  { backgroundColor: color.success },
  actBtnNoShow: { backgroundColor: '#DC2626' },
});
