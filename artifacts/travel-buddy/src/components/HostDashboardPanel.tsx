/**
 * HostDashboardPanel — slide-up panel for event hosts.
 *
 * Tabs:
 *   - Requests  — approve / deny join requests
 *   - Attendees — view Going list, remove/ban/promote
 *   - Waitlist  — waitlist order
 *   - Controls  — event state controls, post pinned update
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView,
  ActivityIndicator, Alert, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { X, Check, X as XIcon, UserX, Crown, Shield, Clock } from 'lucide-react-native';
import {
  getJoinRequests, reviewJoinRequest, assignEventRole, removeEventRole,
  postEventUpdate, updateEvent, getEventWaitlist,
  postponeEvent, archiveEvent, closeRsvps, reopenRsvps, inviteUserToEvent,
  type EventDetail, type JoinRequest, type WaitlistEntry,
} from '../services/events';
import { searchUsers, type TravelerSearchResult } from '../services/follows';
import { Avatar } from './ui';
import { color, space, radius, type as t } from '../theme/tokens';

interface Props {
  event: EventDetail;
  onDismiss: () => void;
  onRefresh: () => void;
}

type Tab = 'requests' | 'attendees' | 'waitlist' | 'invite' | 'controls';

export function HostDashboardPanel({ event, onDismiss, onRefresh }: Props) {
  const [tab, setTab] = useState<Tab>('requests');
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [updateBody, setUpdateBody] = useState('');
  const [posting, setPosting] = useState(false);
  // Invite tab
  const [inviteQuery, setInviteQuery]     = useState('');
  const [inviteResults, setInviteResults] = useState<TravelerSearchResult[]>([]);
  const [inviteSearching, setInviteSearching] = useState(false);
  const [inviteSending, setInviteSending]   = useState<string | null>(null);
  const [invitedIds, setInvitedIds]         = useState<Set<string>>(new Set());

  useEffect(() => {
    loadRequests();
  }, [event.id]);

  useEffect(() => {
    if (tab === 'waitlist') loadWaitlist();
  }, [tab, event.id]);

  async function loadWaitlist() {
    setWaitlistLoading(true);
    const res = await getEventWaitlist(event.id);
    if (res.ok) setWaitlist(res.data?.waitlist ?? []);
    setWaitlistLoading(false);
  }

  async function loadRequests() {
    setRequestsLoading(true);
    const res = await getJoinRequests(event.id);
    if (res.ok) setRequests(res.data?.requests ?? []);
    setRequestsLoading(false);
  }

  async function handleReview(userId: string, action: 'approve' | 'deny') {
    const res = await reviewJoinRequest(event.id, userId, action);
    if (!res.ok) { Alert.alert('Error', res.message ?? 'Failed'); return; }
    setRequests((prev) => prev.filter((r) => r.userId !== userId));
    if (action === 'approve') onRefresh();
  }

  async function handleBan(userId: string) {
    Alert.alert('Ban user?', 'This will remove them from the event and prevent them from rejoining.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Ban', style: 'destructive',
        onPress: async () => {
          const res = await assignEventRole(event.id, userId, 'banned');
          if (!res.ok) Alert.alert('Error', res.message ?? 'Failed');
          else onRefresh();
        },
      },
    ]);
  }

  async function handlePromote(userId: string, role: 'co_host' | 'moderator') {
    const res = await assignEventRole(event.id, userId, role);
    if (!res.ok) Alert.alert('Error', res.message ?? 'Failed');
    else { Alert.alert('Done', `User promoted to ${role.replace('_', ' ')}`); onRefresh(); }
  }

  async function handleRemoveRole(userId: string) {
    const res = await removeEventRole(event.id, userId);
    if (!res.ok) Alert.alert('Error', res.message ?? 'Failed');
    else onRefresh();
  }

  async function handlePostUpdate() {
    if (!updateBody.trim()) return;
    setPosting(true);
    const res = await postEventUpdate(event.id, updateBody.trim(), true);
    setPosting(false);
    if (!res.ok) Alert.alert('Error', res.message ?? 'Failed');
    else { setUpdateBody(''); Alert.alert('Posted!', 'Your pinned update has been sent to attendees.'); }
  }

  async function handleStateChange(newState: 'open' | 'started' | 'completed' | 'cancelled') {
    const labels: Record<string, string> = {
      open: 'Open event to RSVPs',
      started: 'Mark as started',
      completed: 'Mark as completed',
      cancelled: 'Cancel event',
    };
    Alert.alert(labels[newState] ?? 'Change state', 'Are you sure?', [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes',
        style: newState === 'cancelled' ? 'destructive' : 'default',
        onPress: async () => {
          const res = await updateEvent(event.id, { state: newState });
          if (!res.ok) Alert.alert('Error', res.message ?? 'Failed');
          else onRefresh();
        },
      },
    ]);
  }

  async function handlePostpone() {
    Alert.alert('Postpone event', 'This will revert the event to draft so you can reschedule it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Postpone',
        onPress: async () => {
          const res = await postponeEvent(event.id);
          if (!res.ok) Alert.alert('Error', res.message ?? 'Failed');
          else { Alert.alert('Postponed', 'Event moved to draft. Update the date and republish.'); onRefresh(); }
        },
      },
    ]);
  }

  async function handleArchive() {
    Alert.alert('Archive event', 'The event will be hidden from all browsing. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Archive', style: 'destructive',
        onPress: async () => {
          const res = await archiveEvent(event.id);
          if (!res.ok) Alert.alert('Error', res.message ?? 'Failed');
          else onRefresh();
        },
      },
    ]);
  }

  async function handleToggleRsvp() {
    const isOpen = !event.rsvpClosed;
    const res = isOpen ? await closeRsvps(event.id) : await reopenRsvps(event.id);
    if (!res.ok) Alert.alert('Error', res.message ?? 'Failed');
    else onRefresh();
  }

  async function handleInviteSearch(query: string) {
    setInviteQuery(query);
    if (query.trim().length < 2) { setInviteResults([]); return; }
    setInviteSearching(true);
    const res = await searchUsers(query.trim());
    if (res.ok) setInviteResults(res.data ?? []);
    setInviteSearching(false);
  }

  async function handleSendInvite(userId: string) {
    setInviteSending(userId);
    const res = await inviteUserToEvent(event.id, userId);
    setInviteSending(null);
    if (!res.ok) Alert.alert('Error', res.message ?? 'Could not send invite');
    else setInvitedIds((prev) => new Set([...prev, userId]));
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'requests',  label: `Requests${requests.length ? ` (${requests.length})` : ''}` },
    { key: 'attendees', label: 'Attendees' },
    { key: 'waitlist',  label: 'Waitlist' },
    { key: 'invite',    label: 'Invite' },
    { key: 'controls',  label: 'Controls' },
  ];

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.kav}>
      <View style={s.backdrop}>
        <View style={s.panel}>
          {/* Header */}
          <View style={s.head}>
            <Text style={s.headTitle}>Host Dashboard</Text>
            <Pressable onPress={onDismiss} hitSlop={8}><X size={20} color={color.ink} /></Pressable>
          </View>

          {/* Tabs */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabs} contentContainerStyle={s.tabsContent}>
            {TABS.map((tb) => (
              <Pressable
                key={tb.key}
                style={[s.tab, tab === tb.key && s.tabActive]}
                onPress={() => setTab(tb.key)}
              >
                <Text style={[s.tabText, tab === tb.key && s.tabTextActive]}>{tb.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <ScrollView contentContainerStyle={s.body}>

            {/* ── Requests tab ── */}
            {tab === 'requests' && (
              requestsLoading ? (
                <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} />
              ) : requests.length === 0 ? (
                <View style={s.empty}>
                  <Text style={s.emptyText}>No pending requests</Text>
                </View>
              ) : (
                requests.map((r) => (
                  <View key={r.id} style={s.requestRow}>
                    <Avatar uri={r.user?.avatarUrl ?? ''} size={40} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.requestName}>{r.user?.displayName ?? r.user?.handle ?? r.userId.slice(0, 8)}</Text>
                      {r.message ? <Text style={s.requestMsg} numberOfLines={2}>{r.message}</Text> : null}
                    </View>
                    <View style={s.requestActions}>
                      <Pressable style={s.approveBtn} onPress={() => handleReview(r.userId, 'approve')}>
                        <Check size={16} color='#16A34A' />
                      </Pressable>
                      <Pressable style={s.denyBtn} onPress={() => handleReview(r.userId, 'deny')}>
                        <XIcon size={16} color='#DC2626' />
                      </Pressable>
                    </View>
                  </View>
                ))
              )
            )}

            {/* ── Attendees tab ── */}
            {tab === 'attendees' && (
              <>
                {event.goingAttendees.length === 0 ? (
                  <View style={s.empty}><Text style={s.emptyText}>No attendees yet</Text></View>
                ) : (
                  event.goingAttendees.map((a) => (
                    <View key={a.id} style={s.attendeeRow}>
                      <Avatar uri={a.avatarUrl ?? ''} size={36} />
                      <Text style={s.attendeeName} numberOfLines={1}>
                        {a.displayName ?? a.handle ?? a.id.slice(0, 8)}
                      </Text>
                      <View style={s.attendeeActions}>
                        <Pressable style={s.iconBtn} onPress={() => handlePromote(a.id, 'co_host')} hitSlop={6}>
                          <Crown size={15} color='#D97706' />
                        </Pressable>
                        <Pressable style={s.iconBtn} onPress={() => handlePromote(a.id, 'moderator')} hitSlop={6}>
                          <Shield size={15} color='#7C3AED' />
                        </Pressable>
                        <Pressable style={s.iconBtn} onPress={() => handleBan(a.id)} hitSlop={6}>
                          <UserX size={15} color='#DC2626' />
                        </Pressable>
                      </View>
                    </View>
                  ))
                )}
                <Text style={s.sectionNote}>
                  Crown = co-host · Shield = moderator · ✕ = ban
                </Text>
              </>
            )}

            {/* ── Waitlist tab ── */}
            {tab === 'waitlist' && (
              waitlistLoading ? (
                <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} />
              ) : waitlist.length === 0 ? (
                <View style={s.empty}><Text style={s.emptyText}>Waitlist is empty</Text></View>
              ) : (
                <>
                  <View style={s.waitlistInfo}>
                    <Clock size={18} color='#2563EB' />
                    <Text style={s.waitlistInfoText}>
                      When a spot opens, the next person is automatically offered 24 h to accept.
                    </Text>
                  </View>
                  {waitlist.map((entry) => (
                    <View key={entry.userId} style={s.waitlistRow}>
                      <View style={s.waitlistPos}>
                        <Text style={s.waitlistPosText}>#{entry.position}</Text>
                      </View>
                      <Avatar uri={entry.user?.avatarUrl ?? ''} size={36} />
                      <View style={{ flex: 1 }}>
                        <Text style={s.waitlistName} numberOfLines={1}>
                          {entry.user?.displayName ?? entry.user?.handle ?? entry.userId.slice(0, 8)}
                        </Text>
                        {entry.offerExpiresAt ? (
                          <Text style={s.waitlistOfferText}>
                            Offer expires {new Date(entry.offerExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </Text>
                        ) : null}
                      </View>
                      <Pressable style={s.iconBtn} onPress={() => handleBan(entry.userId)} hitSlop={6}>
                        <UserX size={15} color='#DC2626' />
                      </Pressable>
                    </View>
                  ))}
                </>
              )
            )}

            {/* ── Invite tab ── */}
            {tab === 'invite' && (
              <>
                <TextInput
                  style={s.updateInput}
                  placeholder="Search by name or @handle…"
                  placeholderTextColor={color.faint}
                  value={inviteQuery}
                  onChangeText={handleInviteSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {inviteSearching && <ActivityIndicator color={color.signal} style={{ marginTop: space.md }} />}
                {!inviteSearching && inviteQuery.length >= 2 && inviteResults.length === 0 && (
                  <View style={s.empty}><Text style={s.emptyText}>No users found</Text></View>
                )}
                {inviteResults.map((u) => (
                  <View key={u.id} style={s.attendeeRow}>
                    <Avatar uri={u.avatarUrl ?? ''} size={36} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.attendeeName} numberOfLines={1}>{u.displayName ?? u.username}</Text>
                      {u.username ? <Text style={s.requestMsg}>@{u.username}</Text> : null}
                    </View>
                    <Pressable
                      style={[s.inviteBtn, invitedIds.has(u.id) && s.inviteBtnSent]}
                      onPress={() => !invitedIds.has(u.id) && handleSendInvite(u.id)}
                      disabled={invitedIds.has(u.id) || inviteSending === u.id}
                    >
                      {inviteSending === u.id
                        ? <ActivityIndicator size="small" color={color.onInk} />
                        : <Text style={s.inviteBtnText}>{invitedIds.has(u.id) ? 'Sent ✓' : 'Invite'}</Text>
                      }
                    </Pressable>
                  </View>
                ))}
              </>
            )}

            {/* ── Controls tab ── */}
            {tab === 'controls' && (
              <>
                <Text style={s.controlsLabel}>Event state</Text>
                <Text style={s.stateCurrent}>Current: <Text style={{ fontWeight: '700' }}>{event.state}</Text></Text>

                <View style={s.stateButtons}>
                  {event.state === 'draft' && (
                    <Pressable style={s.stateBtn} onPress={() => handleStateChange('open')}>
                      <Text style={s.stateBtnText}>Publish (Open)</Text>
                    </Pressable>
                  )}
                  {event.state === 'open' && (
                    <Pressable style={s.stateBtn} onPress={() => handleStateChange('started')}>
                      <Text style={s.stateBtnText}>Mark as started</Text>
                    </Pressable>
                  )}
                  {event.state === 'started' && (
                    <Pressable style={s.stateBtn} onPress={() => handleStateChange('completed')}>
                      <Text style={s.stateBtnText}>Mark as completed</Text>
                    </Pressable>
                  )}
                  {!['cancelled', 'completed', 'archived'].includes(event.state) && (
                    <Pressable style={[s.stateBtn, s.stateBtnDanger]} onPress={() => handleStateChange('cancelled')}>
                      <Text style={[s.stateBtnText, { color: '#DC2626' }]}>Cancel event</Text>
                    </Pressable>
                  )}
                  {['open', 'started'].includes(event.state) && (
                    <Pressable style={s.stateBtn} onPress={handlePostpone}>
                      <Text style={s.stateBtnText}>Postpone (back to draft)</Text>
                    </Pressable>
                  )}
                  {!['archived', 'draft'].includes(event.state) && (
                    <Pressable style={[s.stateBtn, s.stateBtnDanger]} onPress={handleArchive}>
                      <Text style={[s.stateBtnText, { color: '#DC2626' }]}>Archive event</Text>
                    </Pressable>
                  )}
                </View>

                {['open', 'started'].includes(event.state) && (
                  <>
                    <Text style={[s.controlsLabel, { marginTop: space.lg }]}>RSVPs</Text>
                    <Pressable style={[s.stateBtn, event.rsvpClosed ? s.stateBtnActive : {}]} onPress={handleToggleRsvp}>
                      <Text style={s.stateBtnText}>
                        {event.rsvpClosed ? 'Reopen RSVPs' : 'Close RSVPs'}
                      </Text>
                    </Pressable>
                  </>
                )}

                <Text style={[s.controlsLabel, { marginTop: space.lg }]}>Post update</Text>
                <TextInput
                  style={s.updateInput}
                  placeholder="Announce a change, reminder, or note…"
                  placeholderTextColor={color.faint}
                  value={updateBody}
                  onChangeText={setUpdateBody}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  maxLength={1000}
                />
                <Pressable
                  style={[s.postBtn, (!updateBody.trim() || posting) && { opacity: 0.5 }]}
                  onPress={handlePostUpdate}
                  disabled={!updateBody.trim() || posting}
                >
                  <Text style={s.postBtnText}>{posting ? 'Posting…' : 'Post & notify attendees'}</Text>
                </Pressable>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  kav:        { position: 'absolute', inset: 0, zIndex: 100 },
  backdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  panel:      { backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%' },
  head:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  headTitle:  { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  tabs:       { borderBottomWidth: 1, borderBottomColor: color.haze, maxHeight: 44 },
  tabsContent:{ paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center' },
  tab:        { paddingHorizontal: space.md, paddingVertical: 10 },
  tabActive:  { borderBottomWidth: 2, borderBottomColor: color.signal },
  tabText:    { ...t.small, color: color.mute, fontWeight: '600' },
  tabTextActive:{ color: color.signal, fontWeight: '700' },
  body:       { padding: space.lg, gap: space.md, paddingBottom: 40 },
  empty:      { alignItems: 'center', paddingVertical: space.xxl },
  emptyText:  { ...t.body, color: color.faint },
  requestRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  requestName:{ ...t.body, color: color.ink, fontWeight: '700' },
  requestMsg: { ...t.small, color: color.mute, marginTop: 2 },
  requestActions:{ flexDirection: 'row', gap: space.sm },
  approveBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#DCFCE7', alignItems: 'center', justifyContent: 'center' },
  denyBtn:    { width: 36, height: 36, borderRadius: 18, backgroundColor: '#FEE2E2', alignItems: 'center', justifyContent: 'center' },
  attendeeRow:{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  attendeeName:{ flex: 1, ...t.body, color: color.ink },
  attendeeActions:{ flexDirection: 'row', gap: space.xs },
  iconBtn:    { width: 32, height: 32, borderRadius: 16, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  sectionNote:{ ...t.small, color: color.faint, textAlign: 'center', marginTop: space.md },
  waitlistInfo:{ flexDirection: 'row', gap: space.sm, backgroundColor: '#EFF6FF', padding: space.md, borderRadius: radius.md, alignItems: 'flex-start', marginBottom: space.sm },
  waitlistInfoText:{ ...t.small, color: '#2563EB', flex: 1 },
  waitlistRow:{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  waitlistPos:{ width: 28, alignItems: 'center' },
  waitlistPosText:{ ...t.small, color: color.mute, fontWeight: '700' },
  waitlistName:{ ...t.body, color: color.ink, fontWeight: '600' },
  waitlistOfferText:{ ...t.small, color: '#D97706', marginTop: 1 },
  controlsLabel:{ ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  stateCurrent:{ ...t.body, color: color.mute },
  stateButtons:{ gap: space.sm },
  stateBtn:   { backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, alignItems: 'center', borderWidth: 1, borderColor: color.haze },
  stateBtnDanger:{ borderColor: '#FCA5A5', backgroundColor: '#FEF2F2' },
  stateBtnText:{ ...t.body, color: color.ink, fontWeight: '600' },
  updateInput:{ backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, ...t.body, color: color.ink, height: 90 },
  postBtn:        { backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center' },
  postBtnText:    { ...t.body, color: color.onInk, fontWeight: '700' },
  stateBtnActive: { backgroundColor: '#DBEAFE', borderColor: '#93C5FD' },
  inviteBtn:      { backgroundColor: color.signal, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  inviteBtnSent:  { backgroundColor: '#16A34A' },
  inviteBtnText:  { ...t.small, color: color.onInk, fontWeight: '700' },
});
