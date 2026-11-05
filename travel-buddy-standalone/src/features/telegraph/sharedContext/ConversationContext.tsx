import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSession } from '../../../context/SessionContext.tsx';
import { captureMessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { fetchOwnedApi } from '../../../services/ownedApiRequest.ts';
import { useTelegraphPalette } from '../theme/telegraphTheme.ts';
import { resolveShareProjections } from '../sharing/shareApi.ts';
import type { SharedContextItem, TelegraphAction, TelegraphSharedContextProjection } from './types.ts';

interface Revealed<T> { revealed: boolean; value: T | null }
interface ContextAnswer {
  conversationId: string;
  capabilities: Record<string, boolean>;
  offeredActions: Array<{ action: TelegraphAction; capability: string; objectId?: string }>;
  degraded: boolean;
  inputs: {
    sharedObjects: Revealed<{ projection: TelegraphSharedContextProjection; incomplete: boolean }>;
    time: Revealed<{ band: string | null; nextStartsAt: string | null }>;
    proximity: Revealed<{ people: Array<{ bucket: string; freshness: string }> }>;
  };
}
export interface ContextAction { label: string; run: () => void }

/** Never navigate using the old rail snapshot; recheck the source for this member. */
export async function currentSharedObjectLink(threadId: string, item: Pick<SharedContextItem, 'objectType' | 'objectId'>): Promise<string | null> {
  const owner = captureMessagingOwnerRequest();
  if (!owner) return null;
  const answer = await resolveShareProjections(threadId, [{ objectType: item.objectType, objectId: item.objectId }]);
  if (!owner.isCurrent()) return null;
  if (!answer.ok) throw new Error('This shared item could not be checked. Try again.');
  const source = answer.data.projections.find(p => p.objectId === item.objectId && p.objectType === item.objectType);
  if (!source?.available) throw new Error('This shared item is no longer available.');
  const link = source.deepLink;
  if (!link.startsWith('/') || link.startsWith('//') || link.includes('\\')) throw new Error('This shared item cannot be opened.');
  return link;
}

/** Read on expansion, so opening a chat does not wait for another context request. */
export function ConversationContext({ threadId, expanded, onExpanded, actions, onOpenObject }: {
  threadId: string; expanded: boolean; onExpanded: (value: boolean) => void;
  actions: Partial<Record<TelegraphAction, ContextAction>>; onOpenObject: (item: SharedContextItem) => void;
}) {
  const p = useTelegraphPalette();
  const { userId } = useSession();
  const [answer, setAnswer] = useState<ContextAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [loading, setLoading] = useState(false);
  const renderedOwner = useRef<string | null>(null);
  const currentRequest = useRef<ReturnType<typeof captureMessagingOwnerRequest>>(null);
  useFocusEffect(useCallback(() => { setFocused(true); return () => { currentRequest.current?.invalidate(); setFocused(false); setAnswer(null); }; }, [threadId, userId]));
  useEffect(() => { const sub = AppState.addEventListener('change', state => { if (state !== 'active') { currentRequest.current?.invalidate(); setAnswer(null); } setActive(state === 'active'); }); return () => sub.remove(); }, []);
  useEffect(() => {
    setAnswer(null); setError(null); setLoading(false);
    if (!expanded || !focused || !active) return;
    const owner = captureMessagingOwnerRequest();
    const abort = new AbortController();
    currentRequest.current = owner; renderedOwner.current = userId;
    if (!owner || owner.ownerId !== userId) { setError('Sign in again to view shared plans.'); return; }
    setLoading(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const response = await fetchOwnedApi(`/api/threads/${encodeURIComponent(threadId)}/context-kernel`, { owner, signal: abort.signal });
        if (!response.ok) throw new Error('Shared plans and suggestions could not be loaded. Try again.');
        const value = await response.json() as ContextAnswer;
        if (value?.conversationId !== threadId || !value.inputs?.sharedObjects || !value.inputs?.time || !value.inputs?.proximity || !Array.isArray(value.offeredActions) || !value.capabilities) throw new Error('Shared plans and suggestions are unavailable. Try again.');
        const shared = value.inputs.sharedObjects;
        if (shared.revealed) {
          const projection = shared.value?.projection;
          if (!projection || projection.conversationId !== threadId || ![projection.now, projection.upcoming, projection.unresolved, projection.past].every(items => Array.isArray(items) && items.every(item => typeof item?.objectId === 'string' && typeof item?.objectType === 'string' && typeof item?.title === 'string' && typeof item?.orderBand === 'string'))) throw new Error('Shared plans are incomplete. Try again.');
        }
        if (!owner.isCurrent() || abort.signal.aborted) return;
        setAnswer(value);
        timer = setTimeout(() => { if (owner.isCurrent()) setRefresh(n => n + 1); }, 60_000);
      } catch (e) { if (owner.isCurrent() && !abort.signal.aborted) setError(e instanceof Error ? e.message : 'Try again.'); }
      finally { if (owner.isCurrent() && !abort.signal.aborted) setLoading(false); }
    })();
    return () => { if (timer) clearTimeout(timer); abort.abort(); owner.invalidate(); };
  }, [threadId, userId, expanded, focused, active, refresh]);
  const live = renderedOwner.current === userId && currentRequest.current?.isCurrent() && focused && active ? answer : null;
  const shared = live?.inputs.sharedObjects;
  const projection = shared?.revealed ? shared.value?.projection : null;
  const items = projection ? [...projection.now, ...projection.upcoming, ...projection.unresolved, ...projection.past] : [];
  const offered = live?.offeredActions.filter(item => live.capabilities[item.capability] === true && actions[item.action]) ?? [];
  const unique = [...new Set(offered.map(item => item.action))];
  const text = { color: p.recvText, fontSize: 15, lineHeight: 22 };
  const button = (label: string, run: () => void) => <Pressable accessibilityRole="button" onPress={run} style={{ minHeight: 44, justifyContent: 'center', paddingVertical: 10 }}><Text style={{ ...text, color: p.operational, fontWeight: '600' }}>{label}</Text></Pressable>;
  return <View style={{ paddingHorizontal: 16, backgroundColor: p.surfaceRaised }}>
    {button(expanded ? 'Hide shared plans & suggestions' : 'Shared plans & suggestions', () => onExpanded(!expanded))}
    {expanded && <View style={{ gap: 8, paddingBottom: 12 }}>
      {loading && <ActivityIndicator accessibilityLabel="Loading shared plans" />}
      {error && <><Text style={text}>{error}</Text>{button('Retry shared plans', () => setRefresh(n => n + 1))}</>}
      {live?.degraded && <Text style={text}>Some conversation information could not be updated.</Text>}
      {live && !projection && <Text style={text}>Shared plans are not available right now.</Text>}
      {projection && !items.length && <Text style={text}>{shared?.value?.incomplete ? 'Shared plans could not be fully loaded.' : 'No shared plans to show yet.'}</Text>}
      {items.length > 0 && <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>{items.map(item => <View key={`${item.objectType}:${item.objectId}`}>
        {button(item.title, () => { if (currentRequest.current?.isCurrent()) onOpenObject(item); })}
        <Text style={{ ...text, color: p.mute }}>{item.orderBand.replace(/_/g, ' ').toLowerCase()}{item.startsAt && Number.isFinite(Date.parse(item.startsAt)) ? ` · ${new Date(item.startsAt).toLocaleString()}` : ''}</Text>
      </View>)}</ScrollView>}
      {unique.map(action => <View key={action}>{button(actions[action]!.label, () => { if (currentRequest.current?.isCurrent() && live?.capabilities[offered.find(a => a.action === action)!.capability]) actions[action]?.run(); })}</View>)}
    </View>}
  </View>;
}
