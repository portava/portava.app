import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../../../context/SessionContext.tsx';
import { captureMessagingOwnerRequest, type MessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { currentDiscoveryScope } from '../../../services/discoveryViewerScope.ts';
import { searchUsers, type TravelerSearchResult } from '../../../services/follows.ts';
import { formConversationGroup, forwardThreadMessage, getMyThreads, getThreadControls, moderateThreadMember, updateMessageContentCapability, updateThreadControls, type CarryForwardSelection, type MessageContentCapability, type MsgResult, type ThreadControlState, type ThreadSummary } from '../../../services/messaging.ts';
import { useTelegraphPalette } from '../theme/telegraphTheme.ts';

import { CarryForwardPicker } from './CarryForwardPicker.tsx';

export type ConversationToolMode = 'add' | 'forward' | 'manage' | 'permission';
export interface ConversationToolsProps { threadId: string; messageId?: string; mode: ConversationToolMode }
const TITLES = { add: 'Start a group', forward: 'Forward message', manage: 'Group settings', permission: 'Forwarding permission' };
const CAPABILITIES: Array<[MessageContentCapability, string, string]> = [
  ['NO_FORWARD', 'Do not forward', 'Keep this message in this conversation.'],
  ['ALLOW', 'Allow forwarding', 'People who can read this message may forward it.'],
  ['SOURCE_POLICY', 'Follow source privacy', 'A shared object keeps its current access rules.'],
  ['EXPIRES_WITH_SOURCE', 'Expire with source', 'Forwarded references expire when their source does.'],
];

export function ConversationTools({ threadId, messageId, mode }: ConversationToolsProps) {
  const p = useTelegraphPalette();
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const ownerRef = useRef<MessagingOwnerRequest | null>(null);
  const busyRef = useRef(false);
  const forwardRequests = useRef(new Map<string, string>());
  const forwardRequestId = (target: string) => {
    const key = `${userId}:${messageId}:${target}`;
    if (!forwardRequests.current.has(key)) forwardRequests.current.set(key, 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = Math.floor(Math.random() * 16); return (c === 'x' ? n : (n & 3) | 8).toString(16); }));
    return forwardRequests.current.get(key)!;
  };
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [controls, setControls] = useState<ThreadControlState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<TravelerSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TravelerSearchResult[]>([]);
  const [carried, setCarried] = useState<CarryForwardSelection[]>([]);
  const [title, setTitle] = useState('');
  const [slowMode, setSlowMode] = useState('0');
  const currentThread = threads.find((thread) => thread.id === threadId);
  const load = useCallback(async () => {
    const owner = ownerRef.current;
    if (!owner?.isCurrent()) { setError('Sign in again to manage this conversation.'); setLoading(false); return; }
    setLoading(true); setError(null);
    const [list, settings] = await Promise.all([
      getMyThreads(owner),
      mode === 'manage' ? getThreadControls(threadId, owner) : Promise.resolve(null),
    ]);
    if (!owner.isCurrent()) return;
    if (!list.ok || !list.data) setError(list.message ?? 'Conversations could not be loaded. Try again.');
    else setThreads(list.data.threads);
    if (settings) {
      if (!settings.ok || !settings.data) setError(settings.message ?? 'Group settings are unavailable. Try again.');
      else { setControls(settings.data); setSlowMode(String(settings.data.controls.slowModeSeconds)); }
    }
    setLoading(false);
  }, [threadId, mode]);
  useFocusEffect(useCallback(() => {
    const owner = captureMessagingOwnerRequest();
    ownerRef.current = owner;
    setThreads([]); setControls(null); setPeople([]); setSelected([]); setCarried([]); setNotice(null); setBusy(false); busyRef.current = false;
    void load();
    return () => { owner?.invalidate(); if (ownerRef.current === owner) ownerRef.current = null; };
  }, [userId, load]));
  useEffect(() => {
    if (mode !== 'add') return;
    const owner = ownerRef.current;
    const abort = new AbortController();
    setPeople([]); setSearchError(null);
    if (query.trim().length < 2 || !owner?.isCurrent()) { setSearching(false); return; }
    setSearching(true);
    const scope = currentDiscoveryScope();
    const timer = setTimeout(async () => {
      const result = await searchUsers(query, 20, { signal: abort.signal, scope, isCurrent: owner.isCurrent });
      if (abort.signal.aborted || !owner.isCurrent()) return;
      if (result.ok && result.data) setPeople(result.data.filter((person) => person.id !== userId && !currentThread?.otherMembers.some((member) => member.id === person.id)));
      else setSearchError(result.message ?? 'People could not be loaded. Try your search again.');
      setSearching(false);
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [mode, query, userId, currentThread]);

  async function run<T>(action: (owner: MessagingOwnerRequest) => Promise<MsgResult<T>>, success: (data: T) => void) {
    const owner = ownerRef.current;
    if (busyRef.current || !owner?.isCurrent()) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await action(owner);
      if (!owner.isCurrent()) return;
      if (result.ok && result.data) success(result.data);
      else setError(result.message ?? 'The action could not be completed. Nothing has been confirmed.');
    } catch { if (owner.isCurrent()) setError('Connection interrupted. Try again.'); }
    finally { if (ownerRef.current === owner) { busyRef.current = false; if (owner.isCurrent()) setBusy(false); } }
  }
  const text = { color: p.recvText };
  const secondary = { color: p.mute };
  function button(label: string, onPress: () => void, disabled = false, key = label) {
    return <Pressable key={key} accessibilityRole="button" accessibilityState={{ disabled: disabled || busy }} disabled={disabled || busy} onPress={onPress} style={[s.button, { backgroundColor: p.operational, opacity: disabled || busy ? 0.5 : 1 }]}><Text style={[s.buttonText, { color: p.operationalOn }]}>{label}</Text></Pressable>;
  }
  function moderate(memberId: string, action: 'mute' | 'unmute' | 'remove') {
    const label = action === 'remove' ? 'Remove member' : action === 'mute' ? 'Mute member for 1 hour' : 'Unmute member';
    Alert.alert(label, action === 'remove' ? 'This person will lose access to this group. Earlier messages stay in the conversation.' : 'This changes their ability to send messages in this conversation.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', style: action === 'remove' ? 'destructive' : 'default', onPress: () => void run((owner) => moderateThreadMember(threadId, memberId, action, owner, 60), () => { setNotice(`${label}: confirmed.`); if (action === 'remove') void load(); }) },
    ]);
  }
  return <View style={[s.screen, { backgroundColor: p.surface, paddingTop: insets.top }]}>
    <View style={[s.header, { borderBottomColor: p.hairline }]}><Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.back}><Text style={text}>Back</Text></Pressable><Text accessibilityRole="header" style={[s.heading, text]}>{TITLES[mode]}</Text></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 24 }]}>
      {loading ? <ActivityIndicator accessibilityLabel="Loading conversation" color={p.operational} /> : null}
      {error ? <View accessibilityRole="alert"><Text style={[s.body, { color: p.attention }]}>{error}</Text>{button('Reload', () => void load())}</View> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={[s.body, text]}>{notice}</Text> : null}
      {!loading && mode === 'add' && <>
        <Text style={[s.body, secondary]}>Create a new group with the people in this chat. Your direct conversation and its messages stay private.</Text>
        <TextInput accessibilityLabel="Group name" value={title} onChangeText={setTitle} maxLength={80} placeholder="Group name (optional)" placeholderTextColor={p.mute} style={[s.input, text, { borderColor: p.hairline }]} />
        <TextInput accessibilityLabel="Search people" value={query} onChangeText={setQuery} autoCapitalize="none" placeholder="Search by name or username" placeholderTextColor={p.mute} style={[s.input, text, { borderColor: p.hairline }]} />
        {selected.map((person) => button(`Remove ${person.displayName ?? person.username ?? 'traveler'}`, () => setSelected((items) => items.filter((item) => item.id !== person.id)), false, person.id))}
        {searching && <ActivityIndicator accessibilityLabel="Searching people" color={p.operational} />}
        {searchError && <Text accessibilityRole="alert" style={text}>{searchError}</Text>}
        {!searching && query.trim().length >= 2 && !people.length && !searchError && <Text style={secondary}>No matching people.</Text>}
        {people.filter((person) => !selected.some((item) => item.id === person.id)).map((person) => button(`Add ${person.displayName ?? person.username ?? 'traveler'}`, () => setSelected((items) => [...items, person]), selected.length >= 10, person.id))}
        <Text style={[s.body, secondary]}>{selected.length}/10 people selected</Text>
        <CarryForwardPicker key={`${userId}:${threadId}`} threadId={threadId} owner={ownerRef.current} selected={carried} onChange={setCarried} disabled={busy} />
        {button('Create group', () => void run((owner) => formConversationGroup(threadId, { userIds: selected.map((person) => person.id), title: title.trim() || undefined, ...(carried.length ? { carryForward: carried } : {}) }, owner), (data) => router.replace({ pathname: '/messages/[id]', params: { id: data.threadId, threadType: 'group', title: title.trim() || 'Group chat' } } as never)), selected.length === 0 || !currentThread)}
      </>}
      {!loading && mode === 'forward' && <>
        <Text style={[s.body, secondary]}>Choose a conversation. The original message’s forwarding and access rules still apply.</Text>
        {threads.filter((thread) => thread.id !== threadId && !thread.archivedAt && !thread.isE2ee && thread.threadType !== 'rent_buddy_booking').map((thread) => button(thread.title ?? (thread.otherMembers.map((member) => member.name || member.handle).join(', ') || 'Conversation'), () => void run((owner) => forwardThreadMessage(thread.id, messageId ?? '', owner, forwardRequestId(thread.id)), () => { setNotice('Message forwarded.'); router.replace({ pathname: '/messages/[id]', params: { id: thread.id, threadType: thread.threadType, title: thread.title ?? undefined, otherUserId: thread.threadType === 'direct' ? thread.otherMembers[0]?.id : undefined } } as never); }), !messageId, thread.id))}
        {!error && threads.filter((thread) => thread.id !== threadId && !thread.archivedAt && !thread.isE2ee && thread.threadType !== 'rent_buddy_booking').length === 0 && <Text style={secondary}>No eligible conversations. Start a chat first.</Text>}
      </>}
      {!loading && mode === 'permission' && <>
        <Text style={[s.body, secondary]}>Choose how this message may be forwarded. These settings do not grant access to a private source.</Text>
        {CAPABILITIES.map(([capability, label, detail]) => <View key={capability}><Text style={[s.body, secondary]}>{detail}</Text>{button(label, () => void run((owner) => updateMessageContentCapability(threadId, messageId ?? '', capability, owner), () => setNotice(`${label}: saved.`)), !messageId)}</View>)}
      </>}
      {!loading && mode === 'manage' && controls && <>
        {controls.mutedUntil && <Text style={[s.body, text]}>You are muted {controls.mutedUntil === 'indefinite' ? 'until a host lifts the mute' : `until ${new Date(controls.mutedUntil).toLocaleString()}`}.</Text>}
        <Text style={[s.body, secondary]}>{controls.isHost ? 'Host controls apply to every sending method.' : 'Only hosts can change these settings.'}</Text>
        {(['postingPolicy', 'mediaPolicy', 'linkPolicy'] as const).map((key, index) => <View key={key} style={s.row}><Text style={[s.body, text]}>{['Only hosts can post', 'Only hosts can send media', 'Only hosts can send links'][index]}</Text><Switch accessibilityLabel={['Only hosts can post', 'Only hosts can send media', 'Only hosts can send links'][index]} disabled={!controls.isHost || busy} value={controls.controls[key] === 'hosts_only'} onValueChange={(value) => setControls({ ...controls, controls: { ...controls.controls, [key]: value ? 'hosts_only' : 'everyone' } })} /></View>)}
        <Text style={[s.body, text]}>Seconds between messages (0–3600)</Text>
        <TextInput accessibilityLabel="Slow mode seconds" editable={controls.isHost && !busy} keyboardType="number-pad" value={slowMode} onChangeText={setSlowMode} style={[s.input, text, { borderColor: p.hairline }]} />
        {controls.isHost && button('Save group settings', () => void run((owner) => updateThreadControls(threadId, { ...controls.controls, slowModeSeconds: Number(slowMode) }, owner), (data) => { setControls({ ...controls, controls: data.controls }); setNotice('Group settings saved.'); }), !/^\d+$/.test(slowMode) || Number(slowMode) > 3600)}
        <Text accessibilityRole="header" style={[s.heading, text]}>Members</Text>
        {currentThread?.otherMembers.map((member) => <View key={member.id} style={[s.member, { borderColor: p.hairline }]}><Text style={[s.body, text]}>{member.name || member.handle}</Text>{controls.isHost && <>{button('Mute for 1 hour', () => moderate(member.id, 'mute'), false, 'mute')}{button('Unmute member', () => moderate(member.id, 'unmute'), false, 'unmute')}{currentThread.threadType === 'group' && button('Remove member', () => moderate(member.id, 'remove'), false, 'remove')}</>}</View>)}
        {currentThread?.threadType !== 'group' && controls.isHost && <Text style={[s.body, secondary]}>Manage trip or circle membership from its own page.</Text>}
      </>}
      {busy && <ActivityIndicator accessibilityLabel="Saving" color={p.operational} />}
    </ScrollView>
  </View>;
}
const s = StyleSheet.create({
  screen: { flex: 1 }, header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, padding: 12, gap: 12 }, back: { minHeight: 44, minWidth: 48, justifyContent: 'center' }, heading: { fontSize: 20, fontWeight: '700', flexShrink: 1 }, content: { padding: 20, gap: 16 }, body: { fontSize: 16, lineHeight: 23, flexShrink: 1 }, input: { borderWidth: 1, borderRadius: 12, padding: 14, fontSize: 16, minHeight: 48, textAlign: 'auto' }, button: { padding: 14, minHeight: 48, borderRadius: 12, justifyContent: 'center' }, buttonText: { fontSize: 16, fontWeight: '600' }, row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }, member: { paddingVertical: 16, borderTopWidth: 1, gap: 10 },
});
