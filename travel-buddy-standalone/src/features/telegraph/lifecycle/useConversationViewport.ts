import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent, ViewToken } from 'react-native';
import type { ReadStateMessage } from './useThreadReadState.ts';

export const CONVERSATION_VIEWABILITY = { itemVisiblePercentThreshold: 65, minimumViewTime: 200 };
/** Loaded rows are not seen rows. Keep the reader's position when new rows arrive. */
export function useConversationViewport(threadId: string | null, viewerId: string | null, messages: readonly ReadStateMessage[], list: RefObject<Pick<FlatList, 'scrollToEnd'> | null>) {
  const identity = `${viewerId ?? ''}:${threadId ?? ''}`;
  const [view, setView] = useState({ identity, visible: [] as string[], pending: [] as string[], away: false });
  const scope = useRef({ identity, initialized: false, known: new Set<string>(), newest: null as ReadStateMessage | null, follow: true, away: false });
  if (scope.current.identity !== identity) scope.current = { identity, initialized: false, known: new Set(), newest: null, follow: true, away: false };
  const currentMessages = useRef(messages); currentMessages.current = messages;
  useLayoutEffect(() => {
    const state = scope.current;
    if (messages.length === 0) return;
    const later = (a: ReadStateMessage, b: ReadStateMessage) => Number.isSafeInteger(a.sequence) && Number.isSafeInteger(b.sequence) ? a.sequence! > b.sequence! : Date.parse(a.createdAt) > Date.parse(b.createdAt);
    const arrivals = state.initialized ? messages.filter(message => !state.known.has(message.id) && (!state.newest || later(message, state.newest))) : [];
    if (arrivals.length && !state.away) state.follow = true;
    const incoming = arrivals.filter(message => message.senderId !== viewerId && !message.deleted && message.deliveryStatus !== 'sending' && message.deliveryStatus !== 'failed');
    setView(previous => {
      const base = previous.identity === identity ? previous : { identity, visible: [], pending: [], away: false };
      return { ...base, pending: [...new Set([...base.pending, ...incoming.filter(message => !base.visible.includes(message.id)).map(message => message.id)])] };
    });
    for (const message of messages) {
      state.known.add(message.id);
      if (!state.newest || later(message, state.newest)) state.newest = message;
    }
    state.initialized = true;
  }, [identity, messages, viewerId]);
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const validIds = new Set(currentMessages.current.map(message => message.id));
    const visible = viewableItems.filter(item => item.isViewable && item.item?._t === 'msg' && validIds.has(item.item.data?.id)).map(item => item.item.data.id as string);
    const key = scope.current.identity;
    setView(previous => ({ identity: key, visible, pending: previous.identity === key ? previous.pending.filter(id => !visible.includes(id)) : [], away: scope.current.away }));
  }, []);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentSize, layoutMeasurement, contentOffset } = event.nativeEvent;
    const away = contentSize.height - layoutMeasurement.height - contentOffset.y > 120;
    scope.current.away = away;
    if (away) scope.current.follow = false;
    setView(previous => ({ ...previous, away }));
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (!scope.current.follow || !currentMessages.current.length) return;
    scope.current.follow = false;
    list.current?.scrollToEnd({ animated: false });
  }, [list]);
  const jumpToLatest = useCallback(() => { scope.current.follow = true; list.current?.scrollToEnd({ animated: true }); }, [list]);
  const visibleMessageIds = view.identity === identity ? view.visible : [];
  return { visibleMessageIds, newMessageCount: view.identity === identity ? view.pending.length : 0, away: view.identity === identity && view.away, onViewableItemsChanged, onScroll, onContentSizeChange, jumpToLatest };
}
