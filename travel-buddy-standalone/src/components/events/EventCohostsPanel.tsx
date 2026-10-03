/**
 * EventCohostsPanel — co-host management (PLAT-F28).
 *
 * Host Dashboard → Co-hosts. Lists the event's co-hosts
 * (GET /api/events/:id/cohosts, staff only), and lets the HOST add one from the
 * people going (POST /cohosts) or remove one (DELETE /cohosts/:userId). A
 * co-host sees the list without the controls: the server lets only the host
 * change it.
 *
 * Adding picks from the Going list the event already carries, so the host adds
 * someone who has committed to the event. The server refuses anyone blocked
 * with the host; that refusal is shown as its message. A failed read is an
 * error with Retry, never "no co-hosts".
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Crown, UserPlus, X } from 'lucide-react-native';
import {
  getEventCohosts, addEventCohost, removeEventCohost,
  type EventCohost, type EventDetail,
} from '../../services/events.ts';
import { Avatar } from '../ui.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts'; import { attendeesUnread, attendeesListCut } from '../../lib/eventAttendeesUnread.ts';  // census-discovery §117 (B19); §118 (B24)

interface Props {
  event: Pick<EventDetail, 'id' | 'hostId' | 'isHost' | 'myRole' | 'goingAttendees' | 'failedSources'> & Partial<Pick<EventDetail, 'counts' | 'goingAttendeesTruncated' | 'goingAttendeesTotal'>>;  // §118 (B24)
  /** Called after a change so the event (and the viewer's roles) refresh. */
  onChanged?: () => void;
}

function label(p: { displayName: string | null; handle: string | null }): string {
  return p.displayName ?? (p.handle ? `@${p.handle}` : 'Traveler');
}

export function EventCohostsPanel({ event, onChanged }: Props) {
  const isHost = !!event.isHost || event.myRole === 'host';
  const [cohosts, setCohosts] = useState<EventCohost[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getEventCohosts(event.id);
    if (res.ok && Array.isArray(res.data?.cohosts)) setCohosts(res.data!.cohosts);
    else { setCohosts(null); setError(res.message ?? "We couldn't load the co-hosts."); }
    setLoading(false);
  }, [event.id]);

  useEffect(() => { load(); }, [load]);

  async function add(userId: string) {
    if (busyId) return;
    setBusyId(userId);
    setActionError(null);
    const res = await addEventCohost(event.id, userId);
    setBusyId(null);
    if (!res.ok) { setActionError(res.message ?? 'Could not add this co-host.'); return; }
    await load();
    onChanged?.();
  }

  async function remove(userId: string) {
    if (busyId) return;
    setBusyId(userId);
    setActionError(null);
    const res = await removeEventCohost(event.id, userId);
    setBusyId(null);
    if (!res.ok) { setActionError(res.message ?? 'Could not remove this co-host.'); return; }
    setCohosts((prev) => (prev ?? []).filter((c) => c.user_id !== userId));
    onChanged?.();
  }

  if (loading) return <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} testID="cohosts-loading" />;
  if (error || !cohosts) {
    return (
      <View style={s.empty} testID="cohosts-error">
        <Text style={s.emptyText}>{error ?? "We couldn't load the co-hosts."}</Text>
        <Pressable style={s.retryBtn} onPress={load} accessibilityRole="button" accessibilityLabel="Retry">
          <Text style={s.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const cohostIds = new Set(cohosts.map((c) => c.user_id));
  const candidates = (event.goingAttendees ?? []).filter((a) => a.id !== event.hostId && !cohostIds.has(a.id));

  return (
    <View style={{ gap: space.sm }} testID="cohosts-list">
      <Text style={s.note}>Co-hosts can edit the event, post updates and create share links.</Text>
      {actionError ? <Text style={s.error} testID="cohosts-action-error">{actionError}</Text> : null}
      {cohosts.length === 0 ? (
        <Text style={s.emptyText}>No co-hosts yet</Text>
      ) : cohosts.map((c) => (
        <View key={c.user_id} style={s.row}>
          <Avatar uri={c.avatarUrl ?? ''} size={36} />
          <Crown size={14} color="#D97706" />
          <Text style={s.name} numberOfLines={1}>{label(c)}</Text>
          {isHost && (busyId === c.user_id ? <ActivityIndicator size="small" color={color.signal} /> : (
            <Pressable
              style={s.iconBtn}
              onPress={() => remove(c.user_id)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${label(c)} as co-host`}
            >
              <X size={15} color="#DC2626" />
            </Pressable>
          ))}
        </View>
      ))}

      {isHost && (
        <>
          <Text style={[s.section, { marginTop: space.md }]}>Add a co-host from people going</Text>
          {candidates.length === 0 ? (
            <Text style={s.note} testID={!attendeesUnread(event) && attendeesListCut(event).cut ? 'cohosts-candidates-cut' : undefined}>{attendeesUnread(event) ? "Couldn't load who's going, so no one can be added right now." : attendeesListCut(event).cut ? CANDIDATES_CUT_TEXT : 'Everyone going is already a co-host, or nobody else is going yet.'}</Text>
          ) : candidates.map((a) => (
            <View key={a.id} style={s.row}>
              <Avatar uri={a.avatarUrl ?? ''} size={36} />
              <Text style={s.name} numberOfLines={1}>{label(a)}</Text>
              {busyId === a.id ? <ActivityIndicator size="small" color={color.signal} /> : (
                <Pressable
                  style={s.addBtn}
                  onPress={() => add(a.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Make ${label(a)} a co-host`}
                >
                  <UserPlus size={14} color={color.onInk} />
                  <Text style={s.addText}>Add</Text>
                </Pressable>
              )}
            </View>
          ))}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  note:      { ...t.small, color: color.mute },
  section:   { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  empty:     { alignItems: 'center', paddingVertical: space.xl, gap: space.md },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn:  { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText: { ...t.small, color: color.onInk, fontWeight: '700' },
  error:     { ...t.small, color: '#DC2626' },
  row:       { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  name:      { ...t.body, color: color.ink, flex: 1 },
  iconBtn:   { padding: space.sm, borderRadius: radius.md, backgroundColor: color.haze },
  addBtn:    { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.signal, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  addText:   { ...t.small, color: color.onInk, fontWeight: '700' },
});

// census-discovery §118 (DV-83 round 21, B24): GET /events/:id lists only the first few travellers going, so when every
// listed one is already a co-host the picker cannot say everyone going is.
const CANDIDATES_CUT_TEXT = 'Only the first few travellers going are listed here, and they are already co-hosts.';
