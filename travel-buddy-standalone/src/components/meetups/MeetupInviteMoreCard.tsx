/**
 * MeetupInviteMoreCard — the organiser invites more people after creating a
 * meetup (PLAT-F31). Before this, invitees could only be chosen at creation.
 *
 * Candidates come from the same source the server will accept
 * (POST /api/meetups/:id/invites, routes/meetups.ts): trip members for a trip
 * meetup, circle members for a circle meetup, friends otherwise
 * (lib/meetupInvites.ts `inviteCandidateSource`). The answer
 * { invited, skipped, ineligible, ageIneligible } is shown outcome by outcome,
 * so nobody the server did not invite is counted as invited. A failed
 * candidate read is an error with Retry, never "no friends to invite".
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, TextInput } from 'react-native';
import { UserPlus, Check } from 'lucide-react-native';
import { inviteToMeetup, type MeetupDetail } from '../../services/meetups.ts';
import {
  getMyFriends, getTripInvitableUsers, getCircleInvitableUsers, type FriendUser,
} from '../../services/friends.ts';
import { canInviteMore, inviteCandidateSource, summarizeInviteResult } from '../../lib/meetupInvites.ts';
import { Avatar } from '../ui.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  meetup: Pick<MeetupDetail, 'id' | 'isCreator' | 'status' | 'tripId' | 'circleOwnerId' | 'creatorId'>;
  /** Called after invites were sent so the screen can refresh its counts. */
  onInvited?: () => void;
}

type Candidates = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; users: FriendUser[] };

export function MeetupInviteMoreCard({ meetup, onInvited }: Props) {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidates>({ status: 'idle' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const source = inviteCandidateSource(meetup);

  const loadCandidates = useCallback(async () => {
    setCandidates({ status: 'loading' });
    let users: FriendUser[] | null = null;
    let message: string | undefined;
    if (source === 'trip' && meetup.tripId) {
      const r = await getTripInvitableUsers(meetup.tripId);
      users = r.ok && r.data ? r.data.groupMembers : null; message = r.message;
    } else if (source === 'circle' && meetup.circleOwnerId) {
      const r = await getCircleInvitableUsers(meetup.circleOwnerId);
      users = r.ok && r.data ? r.data.groupMembers : null; message = r.message;
    } else {
      const r = await getMyFriends();
      users = r.ok && r.data ? r.data.friends : null; message = r.message;
    }
    if (!users) { setCandidates({ status: 'error', message: message ?? "We couldn't load who you can invite." }); return; }
    setCandidates({ status: 'ready', users: users.filter((u) => u.id !== meetup.creatorId) });
  }, [source, meetup.tripId, meetup.circleOwnerId, meetup.creatorId]);

  if (!canInviteMore(meetup)) return null;

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    setResult(null);
    setError(null);
    if (next && (candidates.status === 'idle' || candidates.status === 'error')) loadCandidates();
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function send() {
    if (sending || selected.size === 0) return;
    setSending(true);
    setError(null);
    setResult(null);
    const r = await inviteToMeetup(meetup.id, [...selected]);
    setSending(false);
    if (!r.ok || !r.data) { setError(r.message ?? 'The invites were not sent. Please try again.'); return; }
    setResult(summarizeInviteResult(r.data));
    setSelected(new Set());
    onInvited?.();
  }

  const q = query.trim().toLowerCase();
  const users = candidates.status === 'ready'
    ? candidates.users.filter((u) => !q || u.name?.toLowerCase().includes(q) || u.handle?.toLowerCase().includes(q))
    : [];
  const emptyCopy = source === 'trip' ? 'Nobody else is on this trip yet.'
    : source === 'circle' ? 'Nobody else is in this circle yet.'
    : 'No friends yet — connect with travelers first.';

  return (
    <View style={s.card} testID="meetup-invite-more">
      <Pressable style={s.head} onPress={toggleOpen} accessibilityRole="button" accessibilityLabel="Invite more people">
        <UserPlus size={16} color={color.signal} />
        <Text style={s.title}>Invite more people</Text>
        <Text style={s.toggle}>{open ? 'Close' : 'Open'}</Text>
      </Pressable>
      {result ? <Text style={s.result} testID="meetup-invite-result">{result}</Text> : null}
      {open && (
        candidates.status === 'loading' || candidates.status === 'idle' ? (
          <ActivityIndicator color={color.signal} style={{ marginVertical: space.md }} testID="meetup-invite-loading" />
        ) : candidates.status === 'error' ? (
          <View style={s.center} testID="meetup-invite-error">
            <Text style={s.muted}>{candidates.message}</Text>
            <Pressable style={s.retryBtn} onPress={loadCandidates} accessibilityRole="button" accessibilityLabel="Retry">
              <Text style={s.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : candidates.users.length === 0 ? (
          <Text style={s.muted} testID="meetup-invite-empty">{emptyCopy}</Text>
        ) : (
          <View style={{ gap: space.xs }}>
            <TextInput
              style={s.search}
              placeholder="Search by name or @handle"
              placeholderTextColor={color.faint}
              value={query}
              onChangeText={setQuery}
              accessibilityLabel="Search people to invite"
            />
            {users.map((u) => {
              const on = selected.has(u.id);
              return (
                <Pressable
                  key={u.id}
                  style={s.row}
                  onPress={() => toggle(u.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={u.name || `@${u.handle}`}
                >
                  <Avatar uri={u.avatarUrl ?? ''} size={32} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.name} numberOfLines={1}>{u.name || `@${u.handle}`}</Text>
                    {u.name && u.handle ? <Text style={s.handle}>@{u.handle}</Text> : null}
                  </View>
                  <View style={[s.check, on && s.checkOn]}>{on ? <Check size={12} color={color.onInk} /> : null}</View>
                </Pressable>
              );
            })}
            {error ? <Text style={s.error} testID="meetup-invite-send-error">{error}</Text> : null}
            <Pressable
              style={[s.sendBtn, (selected.size === 0 || sending) && { opacity: 0.5 }]}
              onPress={send}
              disabled={selected.size === 0 || sending}
              accessibilityRole="button"
              accessibilityLabel="Send invites"
              testID="meetup-invite-send"
            >
              {sending ? <ActivityIndicator size="small" color={color.onInk} />
                : <Text style={s.sendText}>{selected.size > 0 ? `Invite ${selected.size}` : 'Choose people to invite'}</Text>}
            </Pressable>
          </View>
        )
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card:     { backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: color.haze },
  head:     { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title:    { ...t.body, color: color.ink, fontWeight: '700', flex: 1 },
  toggle:   { ...t.small, color: color.mute, fontWeight: '600' },
  result:   { ...t.small, color: color.success, fontWeight: '600' },
  center:   { alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  muted:    { ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn: { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText:{ ...t.small, color: color.onInk, fontWeight: '700' },
  search:   { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: space.sm, ...t.body, color: color.ink },
  row:      { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6 },
  name:     { ...t.body, color: color.ink, fontWeight: '600' },
  handle:   { ...t.small, color: color.mute },
  check:    { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  checkOn:  { backgroundColor: color.signal, borderColor: color.signal },
  error:    { ...t.small, color: '#DC2626' },
  sendBtn:  { backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.sm, alignItems: 'center', marginTop: space.xs },
  sendText: { ...t.body, color: color.onInk, fontWeight: '700' },
});
