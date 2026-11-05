import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HighlightViewer } from '../../src/components/HighlightViewer';
import { usePrivateSurfaceKey } from '../../src/hooks/usePrivateSurfaceKey';
import { fetchHighlightDetail } from '../../src/services/highlightDetail';
import { captureMessagingOwnerRequest } from '../../src/services/messagingOwnerRequest';
import type { Highlight, HighlightErrorKind } from '../../src/services/highlights';
import { color, space, type as t } from '../../src/theme/tokens';

type State = { loading: true } | { loading: false; highlight: Highlight } | { loading: false; error: HighlightErrorKind };

export default function HighlightDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const scope = usePrivateSurfaceKey();
  return <HighlightDetail key={`${scope}:${id}`} id={id} />;
}

function HighlightDetail({ id }: { id: string }) {
  const insets = useSafeAreaInsets();
  const [owner] = useState(captureMessagingOwnerRequest);
  const [state, setState] = useState<State>({ loading: true });
  const pending = useRef<AbortController | null>(null);
  const focused = useRef(false);
  const load = useCallback(() => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setState({ loading: true });
    if (!owner?.isCurrent()) { setState({ loading: false, error: 'unauthenticated' }); return; }
    void fetchHighlightDetail(id, { owner, signal: request.signal }).then(result => {
      if (request.signal.aborted || pending.current !== request || !owner.isCurrent() || !focused.current) return;
      setState(result.ok && result.data ? { loading: false, highlight: result.data }
        : { loading: false, error: result.errorKind ?? 'degraded_unavailable' });
    });
  }, [id, owner]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    load();
    return () => { focused.current = false; pending.current?.abort(); setState({ loading: true }); };
  }, [load]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') { if (focused.current) load(); }
      else { pending.current?.abort(); setState({ loading: true }); }
    });
    return () => { pending.current?.abort(); subscription.remove(); };
  }, [load]);
  const highlight = !state.loading && 'highlight' in state ? state.highlight : null;
  useEffect(() => {
    if (!highlight?.expiresAt) return;
    const expiresIn = Date.parse(highlight.expiresAt) - Date.now();
    const timer = setTimeout(() => {
      if (Date.parse(highlight.expiresAt!) <= Date.now()) setState({ loading: false, error: 'not_found' });
      else load();
    }, Math.min(Math.max(0, expiresIn), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [highlight, load]);
  const close = useCallback(() => { pending.current?.abort(); router.back(); }, []);
  const error = !state.loading && 'error' in state ? state.error : null;
  const missing = error === 'not_found';
  const signIn = error === 'unauthenticated' || error === 'forbidden';
  return <View style={[s.screen, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.md }]}>
    <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Go back" style={s.back}><Text style={s.link}>Back</Text></Pressable>
    {state.loading ? <ActivityIndicator accessibilityLabel="Loading highlight" testID="highlight-detail-loading" color={color.signal} />
      : highlight ? <HighlightViewer visible highlights={[highlight]} currentUserId={owner?.ownerId} onClose={close} onDeleted={close} />
      : <View style={s.notice} testID={missing ? 'highlight-detail-unavailable' : 'highlight-detail-error'}>
        <Text style={s.title}>{missing ? 'Highlight unavailable' : signIn ? 'Sign in to view this highlight' : 'Couldn’t load this highlight'}</Text>
        <Text style={s.body}>{missing ? 'It may have expired, been archived, or no longer be shared with you.'
          : signIn ? 'Your account needs to be signed in and able to view this highlight.' : 'Please try again. Your saved item has not been removed.'}</Text>
        {!missing && !signIn && <Pressable onPress={load} accessibilityRole="button" accessibilityLabel="Try again" style={s.retry}><Text style={s.link}>Try again</Text></Pressable>}
      </View>}
  </View>;
}
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper, paddingHorizontal: space.lg },
  back: { alignSelf: 'flex-start', paddingVertical: space.md, marginBottom: space.lg },
  notice: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  title: { ...t.heading, fontSize: 23, color: color.ink, textAlign: 'center' },
  body: { ...t.body, fontSize: 16, color: color.mute, textAlign: 'center' },
  link: { ...t.bodyStrong, fontSize: 16, color: color.signal },
  retry: { padding: space.md },
});
