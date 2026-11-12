import { act, renderHook, cleanup } from '@testing-library/react-native';
import { AppState, type ViewToken } from 'react-native';
import { useConversationTyping, TYPING_IDLE_MS, TYPING_TTL_MS } from '../lifecycle/useConversationTyping.ts';
import { useConversationViewport } from '../lifecycle/useConversationViewport.ts';
import type { ReadStateMessage } from '../lifecycle/useThreadReadState.ts';
import type { TelegraphEvent } from '../../../services/telegraphRealtimeService.ts';

const mockSendTyping = jest.fn();
const mockListeners = new Set<(event: TelegraphEvent) => void>();
// NOTE: isolated transport boundary: no real conversations or authentication.
jest.mock('../../../services/messaging.ts', () => ({ sendTyping: (...args: unknown[]) => mockSendTyping(...args) }));
// NOTE: isolated transport boundary; events are explicitly controlled below.
jest.mock('../../../services/telegraphRealtimeService.ts', () => ({ telegraphRealtime: { subscribe: (listener: (event: TelegraphEvent) => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); } } }));
const appListeners = new Set<(state: string) => void>();
const emit = (type: TelegraphEvent['type'], userId = 'other', threadId: string | undefined = 'thread') => {
  for (const listener of [...mockListeners]) listener({type, threadId, payload:{userId}, ts:'2026-11-12T00:00:00Z'});
};
const app = (state: string) => { for (const listener of [...appListeners]) listener(state); };
beforeEach(() => {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active', writable: true });
  jest.useFakeTimers(); jest.clearAllMocks(); mockListeners.clear(); appListeners.clear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, listener: (state: string) => void) => { appListeners.add(listener); return {remove:()=>appListeners.delete(listener)}; }) as never);
});
afterEach(async () => { await cleanup(); jest.restoreAllMocks(); jest.useRealTimers(); });

it('shows only other people in the exact thread, expires presence and honors stopped', async () => {
  const hook = await renderHook(() => useConversationTyping('thread', 'me'));
  await act(async()=> { emit('typing.started', 'me'); emit('typing.started', 'elsewhere', 'different'); for(const listener of mockListeners) listener({type:'typing.started', payload:{userId:'unscoped'}, ts:''}); });
  expect(hook.result.current.typingUserIds).toEqual([]);
  await act(async()=> { emit('typing.started'); }); expect(hook.result.current.typingUserIds).toEqual(['other']);
  await act(async()=> { emit('typing.stopped'); }); expect(hook.result.current.typingUserIds).toEqual([]);
  await act(async()=> { emit('typing.started'); await jest.advanceTimersByTimeAsync(TYPING_TTL_MS); });
  expect(hook.result.current.typingUserIds).toEqual([]);
});
it('sends one stop after idle, no repeated stop on every data-saver keystroke', async()=> {
  const hook=await renderHook(()=>useConversationTyping('thread','me'));
  await act(async()=> { hook.result.current.notifyTyping(true); hook.result.current.notifyTyping(true); });
  expect(mockSendTyping.mock.calls).toEqual([['thread',true,'me']]);
  await act(async()=> { await jest.advanceTimersByTimeAsync(TYPING_IDLE_MS); for(let n=0;n<20;n++) hook.result.current.notifyTyping(false); });
  expect(mockSendTyping.mock.calls).toEqual([['thread',true,'me'],['thread',false,'me']]);
});
it('stops and clears on background, suppresses events and sends until foreground',async()=> {
  const hook=await renderHook(()=>useConversationTyping('thread','me'));
  await act(async()=> { hook.result.current.notifyTyping(true); emit('typing.started'); app('background'); });
  expect(hook.result.current.typingUserIds).toEqual([]);
  await act(async()=> { emit('typing.started'); hook.result.current.notifyTyping(true); });
  expect(hook.result.current.typingUserIds).toEqual([]);
  expect(mockSendTyping.mock.calls).toEqual([['thread',true,'me'],['thread',false,'me']]);
  await act(async()=> { app('active'); await jest.advanceTimersByTimeAsync(2000); hook.result.current.notifyTyping(true); });
  expect(mockSendTyping).toHaveBeenLastCalledWith('thread',true,'me');
});
it('clears old account typing without sending its stop under the replacement account',async()=> {
  const hook=await renderHook<ReturnType<typeof useConversationTyping>, {viewer: string}>(({viewer})=>useConversationTyping('thread',viewer),{initialProps:{viewer:'me'}});
  await act(async()=> { hook.result.current.notifyTyping(true); emit('typing.started'); });
  await hook.rerender({viewer:'next'});
  expect(hook.result.current.typingUserIds).toEqual([]);
  expect(mockSendTyping.mock.calls).toEqual([['thread',true,'me']]);
  await act(async()=> { await jest.advanceTimersByTimeAsync(10_000); });
  expect(mockSendTyping).toHaveBeenCalledTimes(1);
});
it('leaving a conversation sends stop for that thread once, and revocation clears received presence',async()=> {
  const hook=await renderHook<ReturnType<typeof useConversationTyping>, {thread: string}>(({thread})=>useConversationTyping(thread,'me'),{initialProps:{thread:'thread'}});
  await act(async()=> { hook.result.current.notifyTyping(true); });
  await hook.rerender({thread:'second'});
  expect(mockSendTyping.mock.calls).toEqual([['thread',true,'me'],['thread',false,'me']]);
  await act(async()=> { emit('typing.started','peer','second'); emit('access.revoked','peer','second'); });
  expect(hook.result.current.typingUserIds).toEqual([]);
});

const message = (n: number, senderId='other'): ReadStateMessage => ({id:`m${n}`,senderId,createdAt:`2026-11-12T00:${String(n).padStart(2,'0')}:00Z`,sequence:n});
const view = (...ids: string[]) => ({viewableItems:ids.map(id=>({isViewable:true,item:{_t:'msg',data:{id}},key:id,index:0})) as ViewToken[]});
const scroll = (away:boolean) => ({nativeEvent:{contentSize:{height:1000,width:400},layoutMeasurement:{height:500,width:400},contentOffset:{y:away?0:500,x:0}}}) as Parameters<ReturnType<typeof useConversationViewport>['onScroll']>[0];
it('keeps history position, counts incoming arrivals, and only clears them after actual visibility',async()=> {
  const scrollToEnd=jest.fn(); const list={current:{scrollToEnd}} as Parameters<typeof useConversationViewport>[3];
  const hook=await renderHook<ReturnType<typeof useConversationViewport>, {messages: ReadStateMessage[]}>(({messages})=>useConversationViewport('thread','me',messages,list),{initialProps:{messages:[message(1),message(2)]}});
  expect(hook.result.current.visibleMessageIds).toEqual([]); expect(hook.result.current.newMessageCount).toBe(0);
  await act(async()=> { hook.result.current.onContentSizeChange(); hook.result.current.onScroll(scroll(true)); hook.result.current.onViewableItemsChanged(view('m1')); });
  scrollToEnd.mockClear();
  await hook.rerender({messages:[message(1),message(2),message(3)]});
  await act(async()=> { hook.result.current.onContentSizeChange(); });
  expect(scrollToEnd).not.toHaveBeenCalled(); expect(hook.result.current.newMessageCount).toBe(1);
  expect(hook.result.current.visibleMessageIds).toEqual(['m1']);
  await act(async()=> { hook.result.current.jumpToLatest(); });
  expect(scrollToEnd).toHaveBeenCalledWith({animated:true}); expect(hook.result.current.newMessageCount).toBe(1);
  await act(async()=> { hook.result.current.onViewableItemsChanged(view('m2','m3')); });
  expect(hook.result.current.newMessageCount).toBe(0);
});
it('automatically follows near the end, excludes history and own sends, and resets on viewer changes',async()=> {
  const scrollToEnd=jest.fn(); const list={current:{scrollToEnd}} as Parameters<typeof useConversationViewport>[3];
  const hook=await renderHook<ReturnType<typeof useConversationViewport>, {messages: ReadStateMessage[]; viewer: string}>(({messages,viewer})=>useConversationViewport('thread',viewer,messages,list),{initialProps:{messages:[message(2)],viewer:'me'}});
  await act(async()=> { hook.result.current.onContentSizeChange(); }); scrollToEnd.mockClear();
  await hook.rerender({messages:[message(1),message(2)],viewer:'me'});
  await act(async()=> { hook.result.current.onContentSizeChange(); }); expect(scrollToEnd).not.toHaveBeenCalled();
  await hook.rerender({messages:[message(1),message(2),message(3,'me')],viewer:'me'});
  await act(async()=> { hook.result.current.onContentSizeChange(); hook.result.current.onViewableItemsChanged(view('m3')); });
  expect(scrollToEnd).toHaveBeenCalledTimes(1); expect(hook.result.current.newMessageCount).toBe(0);
  await hook.rerender({messages:[],viewer:'next'}); expect(hook.result.current.visibleMessageIds).toEqual([]); expect(hook.result.current.newMessageCount).toBe(0);
});

it('a background stop waits behind an in-flight start and coalesces intermediate pulses', async()=> {
  let release!:()=>void;
  mockSendTyping.mockReturnValueOnce(new Promise<void>(resolve=>{release=resolve;}));
  const hook=await renderHook(()=>useConversationTyping('thread','me'));
  await act(async()=>{hook.result.current.notifyTyping(true);});
  await act(async()=>{await jest.advanceTimersByTimeAsync(2_100);hook.result.current.notifyTyping(true);app('background');});
  expect(mockSendTyping.mock.calls).toEqual([['thread',true,'me']]);
  await act(async()=>{release();});
  expect(mockSendTyping.mock.calls).toEqual([['thread',true,'me'],['thread',false,'me']]);
});
