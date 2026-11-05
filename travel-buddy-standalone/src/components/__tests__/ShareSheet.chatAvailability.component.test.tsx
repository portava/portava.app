import React from 'react';
import { Alert, Platform } from 'react-native';
import { router } from 'expo-router';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ShareSheet } from '../ShareSheet.tsx';
import { getPostById } from '../../services/posts.ts';
import { canonicalUrl } from '../../constants/canonicalUrl.ts';
import { _resetDiscoveryViewerScopeForTests, setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';

const mockThreads = jest.fn();
const mockSend = jest.fn();
const mockDestination = jest.fn();
const mockSheet = jest.fn();
jest.mock('../ui/PortavaSheet.tsx', () => {
  const actual = jest.requireActual('../ui/PortavaSheet.tsx');
  return { ...actual, PortavaSheet: (props: unknown) => { mockSheet(props); return require('react').createElement(actual.PortavaSheet, props); } };
});
// NOTE: Destination persistence has its own suite; this verifies the ShareSheet handoff and account boundary.
jest.mock('../PostSaveDestinationPanel.tsx', () => ({ PostSaveDestinationPanel: (props: unknown) => { mockDestination(props); return null; } }));
// NOTE: This suite exercises the mounted recipient picker at its messaging transport boundary.
jest.mock('../../services/messaging.ts', () => ({ getMyThreads: (...args: unknown[]) => mockThreads(...args), sendMessage: (...args: unknown[]) => mockSend(...args), openDirectThread: jest.fn() }));
// NOTE: Preview fetching is independent of the recipient list being verified.
jest.mock('../../services/posts.ts', () => ({ getPostById: jest.fn(async () => ({ ok: false })) }));
// NOTE: Search transport is not used to load existing chats in these tests.
jest.mock('../../services/follows.ts', () => ({ searchUsers: async () => ({ ok: true, data: [] }) }));
// NOTE: The native safe-area provider is unavailable in the test renderer.
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
// NOTE: Native clipboard access is not part of the recipient picker.
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

const chats = (count = 1) => ({ ok: true, data: { threads: Array.from({ length: count }, (_, i) => ({ id: `thread-${i}`, title: `Travel group ${i}`, threadType: 'group', otherMembers: [] })) } });
beforeEach(() => {
  _resetDiscoveryViewerScopeForTests(); setDiscoveryViewerFromSession('owner');
  mockThreads.mockReset().mockResolvedValue(chats());
  mockSend.mockReset().mockResolvedValue({ ok: true });
  mockDestination.mockReset();
  mockSheet.mockReset();
  jest.mocked(getPostById).mockClear();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(router, 'push').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each(['refused', 'thrown'])('shows a retriable chat-load failure instead of an empty account: %s', async failure => {
  if (failure === 'thrown') mockThreads.mockRejectedValueOnce(new Error('offline'));
  else mockThreads.mockResolvedValueOnce({ ok: false, error: 'offline' });
  const ui = await render(<ShareSheet visible postId="post" onClose={jest.fn()} />);
  await fireEvent.press(ui.getByText('Send in a chat'));
  expect(ui.getByText("Couldn't load your chats.")).toBeTruthy();
  expect(ui.queryByText('No existing chats yet.')).toBeNull();
  await fireEvent.press(ui.getByLabelText('Retry loading chats'));
  expect(ui.getByText('Travel group 0')).toBeTruthy();
  expect(ui.queryByText("Couldn't load your chats.")).toBeNull();
});

it('can find and send to chats beyond the old fifteen-chat cutoff and records a group share', async () => {
  mockThreads.mockResolvedValue(chats(30));
  const shared = jest.fn();
  const ui = await render(<ShareSheet visible postId="post" onClose={jest.fn()} onShareSuccess={shared} />);
  await fireEvent.press(ui.getByText('Send in a chat'));
  await fireEvent.changeText(ui.getByPlaceholderText('Search chats or find someone…'), 'Travel group 29');
  expect(ui.getByText('Group chat')).toBeTruthy();
  await fireEvent.press(ui.getByLabelText('Select Travel group 29'));
  await fireEvent.press(ui.getByText('Send'));
  expect(mockSend).toHaveBeenCalledWith('thread-29', expect.any(String), expect.any(Object));
  expect(shared).toHaveBeenCalledWith('group_chat');
});

it('discards a retry that finishes after an account change', async () => {
  mockThreads.mockResolvedValueOnce({ ok: false });
  let finish!: (result: ReturnType<typeof chats>) => void;
  mockThreads.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const ui = await render(<ShareSheet visible postId="post" onClose={jest.fn()} />);
  await fireEvent.press(ui.getByText('Send in a chat'));
  await fireEvent.press(ui.getByLabelText('Retry loading chats'));
  await act(async () => { setDiscoveryViewerFromSession('another-owner'); });
  await act(async () => { finish(chats()); });
  expect(ui.queryByText('Travel group 0')).toBeNull();
});

it('shares a canonical non-post link through chats without creating a post snapshot', async () => {
  const url = canonicalUrl('/shared-moment/moment-id');
  const shared = jest.fn();
  const ui = await render(<ShareSheet visible canonicalLink={{ url, title: 'Share moment' }} onClose={jest.fn()} onShareSuccess={shared} />);
  expect(ui.queryByText('Share to my profile')).toBeNull();
  expect(ui.queryByText('Add to Memories')).toBeNull();
  expect(ui.queryByText('Add to Highlights')).toBeNull();
  expect(getPostById).not.toHaveBeenCalled();
  await fireEvent.press(ui.getByText('Send in a chat'));
  await fireEvent.changeText(ui.getByPlaceholderText('Add a note (optional)…'), 'Join us');
  await fireEvent.press(ui.getByLabelText('Select Travel group 0'));
  await fireEvent.press(ui.getByText('Send'));
  expect(mockSend).toHaveBeenCalledWith('thread-0', `Join us\n${url}`);
  expect(shared).toHaveBeenCalledWith('group_chat');
});

it.each([{ label: 'Add to Memories', destination: 'memory' }, { label: 'Add to Highlights', destination: 'highlight' }])('opens $destination and confirms only a completed save', async ({ label, destination }) => {
  const close = jest.fn();
  const ui = await render(<ShareSheet visible postId="post" onClose={close} />);
  await fireEvent.press(ui.getByText(label));
  const props = mockDestination.mock.calls.at(-1)![0];
  expect(props).toMatchObject({ postId: 'post', destination, active: true });
  expect(close).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
  await act(async () => { props.onSaved({ referenceId: 'reference' }); });
  expect(close).toHaveBeenCalledTimes(1);
  if (Platform.OS === 'ios') {
    expect(Alert.alert).not.toHaveBeenCalled();
    await act(async () => { mockSheet.mock.calls.at(-1)![0].onDismiss(); });
  }
  expect(Alert.alert).toHaveBeenCalledWith('Saved', expect.any(String));
});

it('does not show a stale destination success after switching accounts', async () => {
  const close = jest.fn();
  const ui = await render(<ShareSheet visible postId="post" onClose={close} />);
  await fireEvent.press(ui.getByText('Add to Memories'));
  const props = mockDestination.mock.calls.at(-1)![0];
  await act(async () => { setDiscoveryViewerFromSession('new-owner'); });
  await act(async () => { props.onSaved({ referenceId: 'reference' }); });
  expect(close).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
});

it.each([false, true])('opens the saved Memory only while its account is current (switch=%s)', async switchAccount => {
  const ui = await render(<ShareSheet visible postId="post" onClose={jest.fn()} />);
  await fireEvent.press(ui.getByText('Add to Memories'));
  await act(async () => { mockDestination.mock.calls.at(-1)![0].onSaved({ referenceId: 'reference', memoryId: 'album' }); });
  if (Platform.OS === 'ios') await act(async () => { mockSheet.mock.calls.at(-1)![0].onDismiss(); });
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)![2]!;
  if (switchAccount) await act(async () => { setDiscoveryViewerFromSession('new-owner'); });
  await act(async () => { buttons.find(button => button.text === 'Open Memory')!.onPress!(); });
  if (switchAccount) expect(router.push).not.toHaveBeenCalled();
  else expect(router.push).toHaveBeenCalledWith('/memory/album');
});

it('refuses a link outside the app origin', async () => {
  const ui = await render(<ShareSheet visible canonicalLink={{ url: 'https://untrusted.test/moment', title: 'Share moment' }} onClose={jest.fn()} />);
  expect(ui.getByText('This link is unavailable.')).toBeTruthy();
  await fireEvent.press(ui.getByText('Send in a chat'));
  await fireEvent.press(ui.getByLabelText('Select Travel group 0'));
  await fireEvent.press(ui.getByText('Send'));
  expect(mockSend).not.toHaveBeenCalled();
});
