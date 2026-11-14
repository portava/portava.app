import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { PostSharePreview } from './PostReferenceCard.tsx';
import { useSession } from '../context/SessionContext.tsx';
import type { MessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import type { Memory } from '../services/memories.ts';
import { capturePostDestinationOwner, listPostDestinationMemories, newPostDestinationOperation, savePostToDestination,
  type PostDestination, type PostDestinationResult } from '../services/postDestinations.ts';
import { color, radius, space } from '../theme/tokens.ts';

export interface PostSaveDestinationPanelProps {
  postId: string; destination: PostDestination; active: boolean;
  showTitle?: boolean;
  onCancel: () => void; onSaved: (result: PostDestinationResult) => void;
}

export function PostSaveDestinationPanel({ postId, destination, active, showTitle = true, onCancel, onSaved }: PostSaveDestinationPanelProps) {
  const { userId } = useSession();
  const ownerRef = useRef<MessagingOwnerRequest | null>(null);
  const busyRef = useRef(false);
  const operation = useRef<{ fingerprint: string; id: string } | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [publicAudience, setPublicAudience] = useState(destination !== 'memory');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  async function load(owner: MessagingOwnerRequest, after?: string | null, signal?: AbortSignal) {
    setLoading(true); setListError(null);
    const result = await listPostDestinationMemories(owner, after, signal);
    if (!owner.isCurrent() || signal?.aborted || ownerRef.current !== owner) return;
    if (result.ok) {
      const items = result.data.memories.filter(m => m.ownerId === owner.ownerId && !['deleted', 'removed', 'archived'].includes(m.state));
      setMemories(previous => after ? [...previous, ...items.filter(m => !previous.some(p => p.id === m.id))] : items);
      setCursor(result.data.nextCursor);
    } else setListError(result.message);
    setLoading(false);
  }
  useEffect(() => {
    const owner = active ? capturePostDestinationOwner() : null;
    const abort = new AbortController(); ownerRef.current = owner;
    operation.current = null; busyRef.current = false;
    setMemories([]); setCursor(null); setSelected(null); setTitle(''); setNote(''); setError(null); setListError(null); setBusy(false);
    setPublicAudience(destination !== 'memory'); setLoading(false);
    if (active && (!owner || owner.ownerId !== userId)) setError('Sign in again to save this post.');
    else if (owner && destination === 'memory') void load(owner, null, abort.signal);
    return () => { owner?.invalidate(); abort.abort(); if (ownerRef.current === owner) ownerRef.current = null; };
  }, [active, destination, postId, userId]);

  async function save() {
    const owner = ownerRef.current;
    if (!owner?.isCurrent() || busyRef.current) return;
    if (destination === 'memory' && !selected && !title.trim()) { setError('Name your new Memory first.'); return; }
    const intent = { destination, memoryId: destination === 'memory' ? selected : null, title: selected ? null : title.trim() || null,
      note: note.trim() || null, visibility: publicAudience ? 'public' as const : destination === 'memory' ? 'only_me' as const : 'private' as const };
    const fingerprint = JSON.stringify(intent);
    if (operation.current?.fingerprint !== fingerprint) operation.current = { fingerprint, id: newPostDestinationOperation() };
    busyRef.current = true; setBusy(true); setError(null);
    const result = await savePostToDestination(postId, { ...intent, operationId: operation.current.id }, owner);
    if (!owner.isCurrent() || ownerRef.current !== owner) return;
    busyRef.current = false; setBusy(false);
    if (result.ok) onSaved(result.data); else setError(result.message);
  }
  if (!active) return null;
  const memory = memories.find(m => m.id === selected);
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.container} testID="post-save-destination-panel">
    {showTitle && <Text style={s.title}>{destination === 'memory' ? 'Save to Memories' : destination === 'profile' ? 'Share to my profile' : 'Share to Highlights'}</Text>}
    <Text style={s.description}>The original author controls who can see this post.</Text>
    {destination === 'profile' && <PostSharePreview target={{ legacyPostId: postId }} />}
    {destination === 'memory' && <>
      <Pressable accessibilityRole="radio" accessibilityState={{ checked: !selected }} disabled={busy} onPress={() => setSelected(null)} style={[s.option, !selected && s.selected]}><Text style={s.label}>Create a Memory</Text></Pressable>
      {!selected && <TextInput accessibilityLabel="Memory name" placeholder="Name your Memory" value={title} onChangeText={setTitle} maxLength={120} editable={!busy} style={s.input} />}
      {memories.map(m => <Pressable key={m.id} accessibilityRole="radio" accessibilityState={{ checked: selected === m.id }} disabled={busy}
        onPress={() => setSelected(m.id)} style={[s.option, selected === m.id && s.selected]}><Text style={s.label}>{m.title || 'Untitled Memory'}</Text><Text style={s.description}>{m.visibility.replaceAll('_', ' ')}</Text></Pressable>)}
      {loading && <ActivityIndicator accessibilityLabel="Loading Memories" />}
      {listError && <><Text accessibilityRole="alert" style={s.error}>{listError}</Text><Pressable accessibilityRole="button" onPress={() => { const owner=ownerRef.current; if(owner?.isCurrent()) void load(owner); }}><Text style={s.link}>Retry Memories</Text></Pressable></>}
      {cursor && !loading && <Pressable accessibilityRole="button" onPress={() => { const owner=ownerRef.current; if(owner?.isCurrent()) void load(owner,cursor); }}><Text style={s.link}>Load more Memories</Text></Pressable>}
    </>}
    <TextInput accessibilityLabel="Add a note" placeholder="Add a note (optional)" value={note} onChangeText={setNote} maxLength={500} multiline editable={!busy} style={s.input} />
    {selected ? <Text style={s.description}>Uses this Memory’s existing audience: {memory?.visibility.replaceAll('_', ' ') ?? 'unchanged'}.</Text> : <View>
      <Text style={s.label}>Audience</Text>
      {[[false, 'Only me'], [true, 'Public']].map(([value,label]) => <Pressable key={String(value)} accessibilityRole="radio" accessibilityState={{ checked: publicAudience === value }} disabled={busy}
        onPress={() => setPublicAudience(Boolean(value))} style={[s.option, publicAudience === value && s.selected]}><Text style={s.label}>{label}</Text></Pressable>)}
    </View>}
    {destination === 'highlight' && <Text style={s.description}>This Highlight lasts 24 hours. You can pin, archive, or delete it from its viewer.</Text>}
    {error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel={destination === 'memory' ? 'Save post to Memory' : destination === 'profile' ? 'Publish repost' : 'Publish Highlight'} disabled={busy || !ownerRef.current?.isCurrent()} style={[s.save, busy && { opacity: .6 }]} onPress={() => void save()}>
      {busy ? <ActivityIndicator color="white" /> : <Text style={s.saveText}>{destination === 'memory' ? 'Save to Memory' : destination === 'profile' ? 'Publish repost' : 'Publish Highlight'}</Text>}
    </Pressable>
    <Pressable accessibilityRole="button" disabled={busy} onPress={onCancel} style={s.option}><Text style={s.label}>Back</Text></Pressable>
  </ScrollView>;
}
const s = StyleSheet.create({ container: { padding: space.lg, gap: space.md }, title: { fontSize: 24, fontWeight: '700', color: color.ink },
  description: { fontSize: 14, lineHeight: 20, color: color.mute }, label: { fontSize: 16, color: color.ink },
  option: { padding: 12, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, gap: 4 }, selected: { borderColor: color.ink, backgroundColor: color.paper },
  input: { padding: 12, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, color: color.ink, fontSize: 16 },
  error: { color: '#b3261e', fontSize: 14 }, link: { color: color.ink, fontSize: 16, padding: 8, textDecorationLine: 'underline' },
  save: { backgroundColor: color.ink, alignItems: 'center', padding: 16, borderRadius: radius.md }, saveText: { color: 'white', fontSize: 17, fontWeight: '600' },
});
