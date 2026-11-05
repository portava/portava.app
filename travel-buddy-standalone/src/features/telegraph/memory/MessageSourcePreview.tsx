import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ContentMedia } from '../../../components/ui/ContentMedia.tsx';
import { usePrivateSurfaceKey } from '../../../hooks/usePrivateSurfaceKey.ts';
import { useMediaSurfaceActivity } from '../../../hooks/useMediaSurfaceActivity.ts';
import { captureMessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import type { OwnedApiContext } from '../../../services/ownedApiRequest.ts';
import { messageTreeMediaOrNull } from '../media/messageTreeMedia.ts';
import { useTelegraphPalette } from '../theme/telegraphTheme.ts';
import { fetchMemoryMessageSource, fetchRecapPreview, type MemoryResult, type MessageMemorySource, type RecapMode } from './memoryApi.ts';

type Props = { memoryId: string } | { threadId: string; planId?: string | null; mode: RecapMode; messageId: string };
export function MessageSourcePreview(props: Props) {
  const scope = usePrivateSurfaceKey();
  const identity = 'memoryId' in props ? props.memoryId : `${props.threadId}:${props.planId}:${props.mode}:${props.messageId}`;
  return <OwnedPreview key={`${scope}:${identity}`} {...props} />;
}
function OwnedPreview(props: Props) {
  const p = useTelegraphPalette();
  const controller = useRef<AbortController | null>(null);
  const activity = useMediaSurfaceActivity(() => controller.current?.abort());
  const owner = useMemo(() => captureMessagingOwnerRequest(), []);
  const [source, setSource] = useState<MessageMemorySource | null>(null);
  const [phase, setPhase] = useState<'loading'|'error'|'ready'>('loading');
  const [revision, retry] = useState(0);
  const identity = 'memoryId' in props ? props.memoryId : `${props.threadId}:${props.planId}:${props.mode}:${props.messageId}`;
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const requestedAt = Date.now();
      controller.current?.abort();
      const abort = new AbortController(); controller.current = abort;
      setSource(null); setPhase('loading');
      if (!owner || !activity.isCurrent()) return;
      const context: OwnedApiContext = { owner, signal: abort.signal, isCurrent: activity.isCurrent };
      let result: MemoryResult<{ source: MessageMemorySource | null }>;
      if ('memoryId' in props) result = await fetchMemoryMessageSource(props.memoryId, context);
      else {
        const read = await fetchRecapPreview(props.threadId, props.mode, props.planId, props.messageId, context);
        result = read.ok ? { ok: true, data: { source: read.data.choices?.preview ?? null } } : read;
      }
      if (closed || abort.signal.aborted || !owner.isCurrent() || !activity.isCurrent()) return;
      setSource(result.ok ? result.data.source : null); setPhase(result.ok ? 'ready' : 'error');
      timer = setTimeout(() => void load(), Math.max(0, requestedAt + 60_000 - Date.now()));
    };
    if (activity.active) void load();
    return () => { closed = true; controller.current?.abort(); if (timer) clearTimeout(timer); };
  }, [identity, owner, activity.active, activity.epoch, activity.isCurrent, revision]);
  if (!activity.active) return null;
  const photos = source?.media.filter(item => item.mediaType === 'image').map(item => messageTreeMediaOrNull(item.url)).filter((uri): uri is string => !!uri);
  return <View style={{ padding: 16, gap: 12 }}>
    {phase === 'loading' && <ActivityIndicator accessibilityLabel="Loading saved source" color={p.operational} />}
    {phase === 'error' && <><Text style={{ color: p.recvText }}>Could not load the saved source.</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry source" onPress={() => retry(n => n + 1)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: p.operational }}>Retry</Text></Pressable></>}
    {phase === 'ready' && !source && <Text style={{ color: p.mute }}>This source is no longer available.</Text>}
    {source && <><Text style={{ color: p.recvText, fontWeight: '600' }}>{source.label}</Text>
      {source.body && <Text style={{ color: p.recvText }}>{source.body}</Text>}
      {source.media.filter(item => item.mediaType === 'image' || item.mediaType === 'video').map((item, i) => <ContentMedia key={`${item.url}:${i}`}
        uri={messageTreeMediaOrNull(item.url)} mediaType={item.mediaType} photos={photos} alt={`Saved media ${i + 1}`} style={{ height: 240, borderRadius: 12, overflow: 'hidden' }} />)}
      <Text style={{ color: p.mute }}>Only you can see this chat reference. It stays in the original conversation.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Open original conversation" style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => {
        if (owner?.isCurrent() && activity.isCurrent()) router.push({ pathname: '/messages/[id]', params: { id: source.threadId } } as never);
      }}><Text style={{ color: p.operational }}>Open original conversation</Text></Pressable>
    </>}
  </View>;
}
