import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSession } from '../context/SessionContext.tsx';
import { capturePostDestinationOwner, postReferenceId, readPostReference, type PostReferenceView } from '../services/postDestinations.ts';
import { color } from '../theme/tokens.ts';

export function PostReferenceCover() { return <View style={s.cover} accessibilityLabel="Shared post"><Text style={s.label}>Shared post</Text></View>; }

export function PostReferenceCard({ mediaType, uri, active = true, onOpen }: { mediaType: string; uri: string; active?: boolean; onOpen?: (postId: string) => void }) {
  const { userId } = useSession();
  const referenceId = postReferenceId(mediaType, uri);
  const revision = useRef(0);
  const [state, setState] = useState<{ viewer: string | null; referenceId: string | null; data?: PostReferenceView; error?: string }>({ viewer: null, referenceId: null });
  const [refresh, setRefresh] = useState(0);
  useFocusEffect(useCallback(() => { setRefresh(n => n + 1); }, [referenceId, userId]));
  useEffect(() => {
    const listener = AppState.addEventListener('change', value => { if (value === 'active') setRefresh(n => n + 1); else { revision.current++; setState({ viewer: null, referenceId: null }); } });
    return () => listener.remove();
  }, []);
  useEffect(() => {
    const owner = active && referenceId ? capturePostDestinationOwner() : null;
    const abort = new AbortController(); const epoch = ++revision.current;
    setState({ viewer: userId ?? null, referenceId });
    if (owner && referenceId && owner.ownerId === userId) void readPostReference(referenceId, owner, abort.signal).then(result => {
      if (!owner.isCurrent() || abort.signal.aborted || revision.current !== epoch) return;
      setState({ viewer: owner.ownerId, referenceId, ...(result.ok ? { data: result.data } : { error: result.message }) });
    });
    else setState({ viewer: userId ?? null, referenceId, data: { available: false } });
    return () => { revision.current++; owner?.invalidate(); abort.abort(); };
  }, [active, referenceId, userId, refresh]);
  const current = active && state.viewer === userId && state.referenceId === referenceId ? state : null;
  const data = current?.data;
  return <View style={s.card} testID="post-reference-card">
    <Text style={s.eyebrow}>SHARED POST</Text>
    {!current || (!data && !current.error) ? <ActivityIndicator accessibilityLabel="Checking shared post" /> : current.error ? <>
      <Text style={s.body} accessibilityRole="alert">{current.error}</Text><Pressable accessibilityRole="button" onPress={() => setRefresh(n => n + 1)}><Text style={s.link}>Retry</Text></Pressable>
    </> : data?.available ? <>
      <Text style={s.label}>{data.author}</Text><Text style={s.body} numberOfLines={8}>{data.text || 'Open the original post to view it.'}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Open original post" onPress={() => { if(onOpen) onOpen(data.postId); else router.push(`/post/${data.postId}` as any); }}><Text style={s.link}>Open original post</Text></Pressable>
    </> : <Text style={s.body}>This post is no longer available to you.</Text>}
  </View>;
}
const s = StyleSheet.create({ card: { backgroundColor: color.paper, padding: 24, gap: 16, borderWidth: 1, borderColor: color.haze, borderRadius: 16 },
  cover: { flex: 1, minHeight: 64, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { color: color.mute, fontSize: 12, letterSpacing: 2 }, label: { color: color.ink, fontSize: 17, fontWeight: '600' },
  body: { color: color.ink, fontSize: 16, lineHeight: 23 }, link: { paddingVertical: 12, color: color.ink, fontSize: 16, textDecorationLine: 'underline' } });
