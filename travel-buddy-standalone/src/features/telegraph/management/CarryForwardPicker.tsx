import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { MessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import type { CarryForwardSelection } from '../../../services/messaging.ts';
import { useTelegraphPalette } from '../theme/telegraphTheme.ts';
import { fetchCarryForwardPage, type CarryForwardCandidate, type CarryForwardCursor } from './carryForwardApi.ts';

export function CarryForwardPicker({ threadId, owner, selected, onChange, disabled = false }: {
  threadId: string; owner: MessagingOwnerRequest | null; selected: CarryForwardSelection[];
  onChange: (selected: CarryForwardSelection[]) => void; disabled?: boolean;
}) {
  const p = useTelegraphPalette();
  const [items, setItems] = useState<CarryForwardCandidate[]>([]);
  const [next, setNext] = useState<CarryForwardCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const cursor = useRef<CarryForwardCursor | null>(null);
  const load = useCallback(async (before: CarryForwardCursor | null) => {
    if (!owner?.isCurrent() || request.current) return;
    const controller = new AbortController(); request.current = controller; cursor.current = before;
    setLoading(true); setError(null);
    try {
      const result = await fetchCarryForwardPage(threadId, owner, controller.signal, before);
      if (controller.signal.aborted || !owner.isCurrent()) return;
      setItems(previous => [...new Map([...previous, ...result.items].map(item => [`${item.kind}:${item.objectId}`, item])).values()]);
      setNext(result.next);
    } catch {
      if (!controller.signal.aborted && owner.isCurrent()) setError('Plans and places could not be loaded. Try again.');
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false); }
    }
  }, [threadId, owner]);
  useEffect(() => {
    setItems([]); setNext(null); cursor.current = null;
    void load(null);
    return () => { request.current?.abort(); request.current = null; };
  }, [load]);
  return <View style={{ gap: 12 }}>
    <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '600', color: p.recvText }}>Bring plans and places</Text>
    <Text style={{ color: p.mute, fontSize: 15 }}>Optional: choose up to 10 items from this conversation. Only selected references are shared. Everyone in the new group must have access.</Text>
    {items.map(item => {
      const checked = selected.some(value => value.kind === item.kind && value.objectId === item.objectId);
      const locked = disabled || (!checked && selected.length >= 10);
      return <Pressable key={`${item.kind}:${item.objectId}`} accessibilityRole="checkbox" accessibilityLabel={`${item.kind === 'PLAN' ? 'Plan' : 'Place'}: ${item.title}`} accessibilityState={{ checked, disabled: locked }} disabled={locked} onPress={() => onChange(checked ? selected.filter(value => value.kind !== item.kind || value.objectId !== item.objectId) : [...selected, { kind: item.kind, objectId: item.objectId }])} style={{ minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 12, borderColor: checked ? p.operational : p.hairline, opacity: locked ? 0.5 : 1 }}>
        <Text style={{ color: p.recvText }}>{checked ? '✓ ' : ''}{item.title}</Text>
        <Text style={{ color: p.mute }}>{item.kind === 'PLAN' ? 'Plan' : 'Place'}</Text>
      </Pressable>;
    })}
    <Text accessibilityLiveRegion="polite" style={{ color: p.mute }}>{selected.length}/10 items selected</Text>
    {loading && <ActivityIndicator accessibilityLabel="Loading plans and places" color={p.operational} />}
    {error && <Text accessibilityRole="alert" style={{ color: p.recvText }}>{error}</Text>}
    {!loading && !error && !items.length && <Text style={{ color: p.mute }}>No eligible plans or places in the messages checked.</Text>}
    {!loading && (error || next) && <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }} onPress={() => void load(error ? cursor.current : next)} style={{ minHeight: 48, justifyContent: 'center' }}><Text style={{ color: p.operational }}>{error ? 'Retry plans and places' : 'Check older messages'}</Text></Pressable>}
  </View>;
}
