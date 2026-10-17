import React from 'react';
import { Alert } from 'react-native';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { ShareSheet } from '../ShareSheet.tsx';
import { DiscoveryShareSheet } from '../DiscoveryShareSheet.tsx';
import { setDiscoveryViewerFromSession, _resetDiscoveryViewerScopeForTests } from '../../services/discoveryViewerScope.ts';
import { useInputAccountEpoch } from '../../platform/input-assistance/hooks/useInputAccountEpoch.ts';

const mockGetSession = jest.fn();
const mockThreads = jest.fn();
const mockOpenThread = jest.fn();
const mockSend = jest.fn();
const mockPost = jest.fn();
const mockClose = jest.fn();
const mockShared = jest.fn();
const mockShareObject = jest.fn();
const mockPressable = jest.fn();
const mockTextInput = jest.fn();

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const CapturedPressable = (props: any) => {
    mockPressable(props);
    return require('react').createElement(actual.Pressable, props);
  };
  const CapturedTextInput = (props: any) => {
    mockTextInput(props);
    return require('react').createElement(actual.TextInput, props);
  };
  return new Proxy(actual, { get(target, property, receiver) {
    if (property === 'Modal') return ({ children, visible }: any) => visible ? require('react').createElement(target.View, null, children) : null;
    if (property === 'Pressable') return CapturedPressable;
    if (property === 'TextInput') return CapturedTextInput;
    return Reflect.get(target, property, receiver);
  } });
});
jest.mock('react-native-safe-area-context', () => { return {
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: ({ children }: any) => require('react').createElement(require('react-native').View, null, children),
}; });
jest.mock('expo-clipboard', () => { return { setStringAsync: jest.fn() }; });
jest.mock('../ui/KeyboardSafeView.tsx', () => { return {
  KeyboardSafeScrollView: ({ children }: any) => require('react').createElement(require('react-native').View, null, children),
}; });
jest.mock('../../lib/supabase.ts', () => { return {
  isSupabaseConfigured: true, authedClient: () => null,
  supabase: { auth: { getSession: () => mockGetSession(), refreshSession: () => mockGetSession() } },
}; });
jest.mock('../../services/messaging.ts', () => { return {
  getMyThreads: (...args: unknown[]) => mockThreads(...args),
  openDirectThread: (...args: unknown[]) => mockOpenThread(...args),
  sendMessage: (...args: unknown[]) => mockSend(...args),
}; });
jest.mock('../../services/posts.ts', () => { return {
  getPostById: (...args: unknown[]) => mockPost(...args),
}; });
jest.mock('../../features/telegraph/sharing/shareApi.ts', () => { return {
  shareObjectIntoThread: (...args: unknown[]) => mockShareObject(...args),
}; });

const placeholder = 'Search chats or find someone…';
const item = { sourceId: 'synthetic-place', sourceType: 'place' as const, title: 'Place', category: 'Park', city: 'Test city' };
type Kind = 'ShareSheet' | 'DiscoveryShareSheet';
function Host({ kind, visible = true, postId = 'synthetic-post', reference = false }: { kind: Kind; visible?: boolean; postId?: string; reference?: boolean }) {
  useInputAccountEpoch();
  return kind === 'ShareSheet' ? <ShareSheet visible={visible} postId={postId} onClose={mockClose} onShareSuccess={mockShared}
    telegraphObject={reference ? { objectType: 'POST', objectId: postId } : null} />
    : <DiscoveryShareSheet visible={visible} item={{ ...item, sourceId: postId }} onClose={mockClose} />;
}
function session(owner: string) {
  return { data: { session: { user: { id: owner }, access_token: `e30.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.synthetic`, expires_at: Math.floor(Date.now() / 1000) + 3600 } } };
}
function user(name: string) {
  return { id: name, displayName: name, username: name, avatarUrl: null, followerCount: 0,
    isFollowing: false, isPrivate: false, friendRequestPending: false, reason: null, verified: false, isOfficial: false };
}
function response(users: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ users }) } as Response;
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}
type Search = { query: string | null; authorization: string; resolve: (value: Response) => void };
let searches: Search[];
let ui: Awaited<ReturnType<typeof render>>;
const realFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;

async function tick() { await act(async () => { jest.advanceTimersByTime(350); }); }
async function open(kind: Kind) {
  ui = await render(<Host kind={kind} />);
  if (kind === 'ShareSheet') await fireEvent.press(ui.getByText('Send in a chat'));
}
async function search(text: string) {
  await fireEvent.changeText(ui.getByPlaceholderText(placeholder), text);
  await tick();
}
async function changeOwner(owner: string | null) {
  mockGetSession.mockResolvedValue(session(owner ?? 'signed-out'));
  await act(async () => { setDiscoveryViewerFromSession(owner); });
}
function threads(title: string) {
  return { ok: true, data: { threads: [{ id: title, title, threadType: 'direct', otherMembers: [], unreadCount: 0 }] } };
}
function childText(children: React.ReactNode): string {
  return React.Children.toArray(children).map(child => {
    if (React.isValidElement<{ children?: React.ReactNode }>(child)) return childText(child.props.children);
    return typeof child === 'string' ? child : '';
  }).join('');
}
function capturedPress(label: string): () => Promise<void> {
  const props = [...mockPressable.mock.calls].reverse().find(([props]) => childText(props.children).includes(label))?.[0];
  expect(props?.onPress).toEqual(expect.any(Function));
  return props.onPress;
}

beforeEach(() => {
  jest.useFakeTimers();
  searches = [];
  _resetDiscoveryViewerScopeForTests(); setDiscoveryViewerFromSession('owner-A');
  mockGetSession.mockReset().mockResolvedValue(session('owner-A'));
  mockThreads.mockReset().mockResolvedValue({ ok: true, data: { threads: [] } });
  mockOpenThread.mockReset().mockResolvedValue({ ok: true, data: { threadId: 'synthetic-thread' } });
  mockSend.mockReset().mockResolvedValue({ ok: true });
  mockPost.mockReset().mockResolvedValue({ ok: false, data: null });
  mockClose.mockReset(); mockShared.mockReset(); mockShareObject.mockReset().mockResolvedValue({ ok: true });
  mockPressable.mockReset();
  mockTextInput.mockReset();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  global.fetch = jest.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/users/search') throw new Error('Unexpected synthetic request');
    return new Promise<Response>(resolve => { searches.push({ query: url.searchParams.get('q'),
      authorization: (init?.headers as Record<string, string>)?.Authorization, resolve }); });
  }) as typeof fetch;
});
afterEach(async () => {
  await cleanup(); jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks();
  global.fetch = realFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

describe.each<Kind>(['ShareSheet', 'DiscoveryShareSheet'])('%s mounted lifecycle fences', kind => {
  it('keeps the latest valid query when two edits arrive before a render commits', async () => {
    await open(kind);
    const change = [...mockTextInput.mock.calls].reverse().find(([props]) => props.placeholder === placeholder)?.[0].onChangeText;
    expect(change).toEqual(expect.any(Function));
    await act(async () => { change('ali'); change('alice'); });
    expect(ui.getByPlaceholderText(placeholder).props.value).toBe('alice');
    await tick();
    expect(searches.map(entry => entry.query)).toEqual(['alice']);
  });

  it('HEALTHY: closing via visible=false cancels pending debounce', async () => {
    await open(kind); await fireEvent.changeText(ui.getByPlaceholderText(placeholder), 'alice');
    await ui.rerender(<Host kind={kind} visible={false} />); await tick();
    expect(searches).toHaveLength(0);
  });

  it('HEALTHY: earlier query response cannot replace later query response', async () => {
    await open(kind); await search('ali'); await search('bob');
    await act(async () => { searches[1].resolve(response([user('Bob')])); });
    await act(async () => { searches[0].resolve(response([user('Alice')])); });
    expect(ui.getByText('Bob')).toBeTruthy(); expect(ui.queryByText('Alice')).toBeNull();
  });

  it('old-account response must not populate the still-mounted picker', async () => {
    await open(kind); await search('alice');
    expect(searches[0].authorization).toBe(`Bearer ${session('owner-A').data.session.access_token}`);
    await changeOwner('owner-B');
    await act(async () => { searches[0].resolve(response([user('Account A person')])); });
    expect(ui.queryByText('Account A person')).toBeNull();
  });

  it('old response must not populate after same-account logout/relogin', async () => {
    await open(kind); await search('alice');
    await changeOwner(null); await changeOwner('owner-A');
    await act(async () => { searches[0].resolve(response([user('Prior session person')])); });
    expect(ui.queryByText('Prior session person')).toBeNull();
  });

  it('unmount must cancel pending debounce before another account supplies the token', async () => {
    await open(kind); await fireEvent.changeText(ui.getByPlaceholderText(placeholder), 'private-query-from-A');
    await ui.unmount(); await changeOwner('owner-B'); await tick();
    expect(searches.map(entry => ({ query: entry.query, authorization: entry.authorization }))).toEqual([]);
  });

  it('token-await account change must not dispatch the old query under the new account', async () => {
    const token = deferred<ReturnType<typeof session>>();
    await open(kind); mockGetSession.mockReturnValueOnce(token.promise);
    await search('private-query-from-A'); expect(searches).toHaveLength(0);
    await changeOwner('owner-B');
    await act(async () => { token.resolve(session('owner-B')); });
    expect(searches.map(entry => ({ query: entry.query, authorization: entry.authorization }))).toEqual([]);
  });

  it('a changed query must not leave a prior recipient actionable during debounce', async () => {
    await open(kind); await search('alice');
    await act(async () => { searches[0].resolve(response([user('Alice')])); });
    await fireEvent.changeText(ui.getByPlaceholderText(placeholder), 'bob');
    expect(ui.getByPlaceholderText(placeholder).props.value).toBe('bob');
    const stale = ui.queryByText('Alice');
    if (stale) await fireEvent.press(stale);
    expect({ opened: mockOpenThread.mock.calls.map(call => call[0]), sends: mockSend.mock.calls.length })
      .toEqual({ opened: [], sends: 0 });
  });

  it('old thread hydration must not overwrite a newer open lifetime', async () => {
    const old = deferred<ReturnType<typeof threads>>();
    mockThreads.mockReturnValueOnce(old.promise).mockResolvedValue(threads('Current lifetime thread'));
    await open(kind);
    await ui.rerender(<Host kind={kind} visible={false} />);
    await ui.rerender(<Host kind={kind} visible />);
    if (kind === 'ShareSheet') await fireEvent.press(ui.getByText('Send in a chat'));
    expect(ui.getByText('Current lifetime thread')).toBeTruthy();
    await act(async () => { old.resolve(threads('Prior lifetime thread')); });
    expect(ui.queryByText('Prior lifetime thread')).toBeNull();
    expect(ui.getByText('Current lifetime thread')).toBeTruthy();
  });

  it.each(['account', 'relogin', 'query', 'close', 'source', 'unmount', 'selection'] as const)(
    'a captured send button rejects its old recipient after %s changes', async change => {
      mockThreads.mockResolvedValue({ ok: true, data: { threads: [
        ...threads('Old thread').data.threads, ...threads('Other thread').data.threads,
      ] } });
      await open(kind);
      await fireEvent.press(ui.getByText('Old thread'));
      const send = capturedPress('Send');
      if (change === 'account') await changeOwner('owner-B');
      if (change === 'relogin') { await changeOwner(null); await changeOwner('owner-A'); }
      if (change === 'query') await fireEvent.changeText(ui.getByPlaceholderText(placeholder), 'Other');
      if (change === 'close') await ui.rerender(<Host kind={kind} visible={false} />);
      if (change === 'source') await ui.rerender(<Host kind={kind} postId="new-source" />);
      if (change === 'unmount') await ui.unmount();
      if (change === 'selection') await fireEvent.press(ui.getByText('Other thread'));
      await act(async () => { await send(); });
      expect(mockSend).not.toHaveBeenCalled(); expect(mockShareObject).not.toHaveBeenCalled();
    },
  );

  it('a captured People row cannot send after the query changes', async () => {
    await open(kind); await search('alice');
    await act(async () => { searches[0].resolve(response([user('Alice')])); });
    const press = capturedPress('Alice');
    await fireEvent.changeText(ui.getByPlaceholderText(placeholder), 'bob');
    await act(async () => { await press(); });
    expect(mockOpenThread).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(['account', 'query', 'close', 'unmount'] as const)('opening a direct chat cannot continue to send after %s changes', async change => {
    const pending = deferred<{ ok: boolean; data: { threadId: string } }>();
    mockOpenThread.mockReturnValueOnce(pending.promise);
    await open(kind); await search('alice');
    await act(async () => { searches[0].resolve(response([user('Alice')])); });
    const press = capturedPress('Alice');
    await act(async () => { void press(); });
    expect(mockOpenThread).toHaveBeenCalledWith('Alice');
    if (change === 'account') await changeOwner('owner-B');
    if (change === 'query') await fireEvent.changeText(ui.getByPlaceholderText(placeholder), 'bob');
    if (change === 'close') await ui.rerender(<Host kind={kind} visible={false} />);
    if (change === 'unmount') await ui.unmount();
    await act(async () => { pending.resolve({ ok: true, data: { threadId: 'late-thread' } }); });
    expect(mockSend).not.toHaveBeenCalled(); expect(mockClose).not.toHaveBeenCalled();
  });

  it('current thread selection still sends the existing card and caption', async () => {
    mockThreads.mockResolvedValue(threads('Current thread'));
    await open(kind);
    await fireEvent.changeText(ui.getByPlaceholderText('Add a note (optional)…'), '  hello  ');
    await fireEvent.press(ui.getByText('Current thread'));
    await fireEvent.press(ui.getByText('Send'));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBe('Current thread');
    expect(JSON.parse(mockSend.mock.calls[0][1])).toMatchObject({ caption: 'hello' });
    expect(mockSend.mock.calls[0][2]).toEqual({ msgType: 'system', subtype: kind === 'ShareSheet' ? 'post_card' : 'discovery_card' });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('a current private People result retains the existing direct-chat eligibility path', async () => {
    await open(kind); await search('alice');
    await act(async () => { searches[0].resolve(response([{ ...user('Alice'), isPrivate: true, friendRequestPending: true }])); });
    await fireEvent.press(ui.getByText('Alice'));
    expect(mockOpenThread).toHaveBeenCalledWith('Alice');
    expect(mockSend).toHaveBeenCalledTimes(1); expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('a current 403 clears old People results and Retry can recover', async () => {
    await open(kind); await search('alice');
    await act(async () => { searches[0].resolve(response([user('Alice')])); });
    await fireEvent.changeText(ui.getByPlaceholderText(placeholder), 'bob');
    expect(ui.queryByText('Alice')).toBeNull();
    await tick();
    await act(async () => { searches[1].resolve({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) } as Response); });
    expect(ui.queryByText('Alice')).toBeNull();
    expect(ui.getByText(/couldn.t search people/i)).toBeTruthy();
    await fireEvent.press(ui.getByLabelText('Retry')); await tick();
    await act(async () => { searches[2].resolve(response([user('Bob')])); });
    expect(ui.getByText('Bob')).toBeTruthy();
  });

  it('closing from the UI invalidates a captured send before the parent hides the sheet', async () => {
    mockThreads.mockResolvedValue(threads('Current thread'));
    await open(kind); await fireEvent.press(ui.getByText('Current thread'));
    const send = capturedPress('Send');
    const close = [...mockPressable.mock.calls].reverse().find(([props]) => kind === 'ShareSheet'
      ? props.accessibilityLabel === 'Close share sheet' : props.hitSlop === 8)?.[0].onPress;
    expect(close).toEqual(expect.any(Function));
    await act(async () => { close(); });
    expect(mockClose).toHaveBeenCalledTimes(1);
    await act(async () => { await send(); });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not report an already-dispatched send in a later account', async () => {
    const pending = deferred<{ ok: boolean }>();
    mockSend.mockReturnValueOnce(pending.promise);
    mockThreads.mockResolvedValue(threads('Current thread'));
    await open(kind); await fireEvent.press(ui.getByText('Current thread'));
    const send = capturedPress('Send');
    await act(async () => { void send(); });
    expect(mockSend).toHaveBeenCalledTimes(1);
    await changeOwner('owner-B');
    await act(async () => { pending.resolve({ ok: true }); });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockClose).not.toHaveBeenCalled(); expect(mockShared).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('preserves a server refusal to open a private recipient chat', async () => {
    mockOpenThread.mockResolvedValueOnce({ ok: false, data: null });
    await open(kind); await search('alice');
    await act(async () => { searches[0].resolve(response([{ ...user('Alice'), isPrivate: true }])); });
    await fireEvent.press(ui.getByText('Alice'));
    expect(mockOpenThread).toHaveBeenCalledWith('Alice'); expect(mockSend).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled(); expect(Alert.alert).toHaveBeenCalledWith('Could not send', expect.any(String));
  });
});

it('ShareSheet back/reopen fences the previous picker hydration', async () => {
  const pending = deferred<ReturnType<typeof threads>>();
  mockThreads.mockReturnValueOnce(pending.promise).mockResolvedValue(threads('New picker thread'));
  await open('ShareSheet');
  await fireEvent.press(ui.getByText('‹ Back'));
  await fireEvent.press(ui.getByText('Send in a chat'));
  await act(async () => { pending.resolve(threads('Old picker thread')); });
  expect(ui.queryByText('Old picker thread')).toBeNull();
  expect(ui.getByText('New picker thread')).toBeTruthy();
});

it('ShareSheet preserves the object-reference send path', async () => {
  mockThreads.mockResolvedValue(threads('Current thread'));
  ui = await render(<Host kind="ShareSheet" reference />);
  await fireEvent.press(ui.getByText('Send in a chat'));
  await fireEvent.press(ui.getByText('Current thread'));
  await fireEvent.press(ui.getByText('Send'));
  expect(mockShareObject).toHaveBeenCalledWith('Current thread', 'POST', 'synthetic-post', null);
  expect(mockSend).not.toHaveBeenCalled(); expect(mockShared).toHaveBeenCalledWith('dm');
});

it('ShareSheet does not use an old post preview after the source changes', async () => {
  const pending = deferred<{ ok: boolean; data: { content: string } }>();
  mockPost.mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true, data: { content: 'Current preview' } });
  mockThreads.mockResolvedValue(threads('Current thread'));
  await open('ShareSheet');
  await ui.rerender(<Host kind="ShareSheet" postId="new-source" />);
  await fireEvent.press(ui.getByText('Send in a chat'));
  await act(async () => { pending.resolve({ ok: true, data: { content: 'Old preview' } }); });
  await fireEvent.press(ui.getByText('Current thread')); await fireEvent.press(ui.getByText('Send'));
  expect(JSON.parse(mockSend.mock.calls[0][1])).toMatchObject({ postId: 'new-source', snippet: 'Current preview' });
});
