import React from 'react';
import { Alert, Platform, Share } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ShareSheet } from '../ShareSheet.tsx';
import { router } from 'expo-router';
import { setDiscoveryViewerFromSession, _resetDiscoveryViewerScopeForTests } from '../../services/discoveryViewerScope.ts';

const mockModal = jest.fn();
// NOTE: Native modal dismissal cannot run in Jest. Capture that boundary while rendering the real sheet.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, { get(target, property, receiver) {
    if (property === 'Modal') return (props: any) => { mockModal(props); return props.visible ? require('react').createElement(target.View, null, props.children) : null; };
    return Reflect.get(target, property, receiver);
  } });
});
// NOTE: The native safe-area provider is unavailable in the test renderer.
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
// NOTE: Post loading is a separate network boundary; this suite verifies native share presentation.
jest.mock('../../services/posts.ts', () => ({ getPostById: async () => ({ ok: false }) }));
// NOTE: The native clipboard is not involved in these share-dialog tests.
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
// NOTE: Native navigation is asserted at its boundary after the real sheet dismisses.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const originalOS = Platform.OS;
beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  _resetDiscoveryViewerScopeForTests(); setDiscoveryViewerFromSession('owner');
  mockModal.mockClear();
  jest.mocked(router.push).mockClear();
  jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS }); });
const dismiss = async () => { await act(async () => { mockModal.mock.calls.at(-1)![0].onDismiss(); }); };

it('waits for iOS native dismissal and presents exactly once', async () => {
  const onClose = jest.fn(); const onShareSuccess = jest.fn();
  const view = await render(<ShareSheet visible postId="post" onClose={onClose} onShareSuccess={onShareSuccess} />);
  await fireEvent.press(view.getAllByText('Share Post')[1]);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(Share.share).not.toHaveBeenCalled();
  await view.rerender(<ShareSheet visible={false} postId="post" onClose={onClose} onShareSuccess={onShareSuccess} />);
  await dismiss(); await dismiss();
  expect(Share.share).toHaveBeenCalledTimes(1);
  expect(onShareSuccess).toHaveBeenCalledWith('external');
});

it('reports presentation failure and does not count cancellation as a share', async () => {
  const onShareSuccess = jest.fn();
  jest.mocked(Share.share).mockRejectedValueOnce(new Error('presentation unavailable'));
  const view = await render(<ShareSheet visible postId="post" onClose={jest.fn()} onShareSuccess={onShareSuccess} />);
  await fireEvent.press(view.getAllByText('Share Post')[1]); await dismiss();
  expect(Alert.alert).toHaveBeenCalledWith('Could not open sharing', expect.any(String));
  expect(onShareSuccess).not.toHaveBeenCalled();
  await view.rerender(<ShareSheet visible={false} postId="post" onClose={jest.fn()} onShareSuccess={onShareSuccess} />);
  await view.rerender(<ShareSheet visible postId="post" onClose={jest.fn()} onShareSuccess={onShareSuccess} />);
  jest.mocked(Share.share).mockResolvedValueOnce({ action: Share.dismissedAction });
  await fireEvent.press(view.getAllByText('Share Post')[1]); await dismiss();
  expect(onShareSuccess).not.toHaveBeenCalled();
});

it('does not open queued sharing after the account changes', async () => {
  const view = await render(<ShareSheet visible postId="post" onClose={jest.fn()} />);
  await fireEvent.press(view.getAllByText('Share Post')[1]);
  await act(async () => { setDiscoveryViewerFromSession('other-owner'); });
  await dismiss();
  expect(Share.share).not.toHaveBeenCalled();
});

it('opens the profile composer after dismissal without counting an unpublished draft as shared', async () => {
  const shared = jest.fn();
  const ui = await render(<ShareSheet visible postId="source-post" onClose={jest.fn()} onShareSuccess={shared} />);
  await fireEvent.press(ui.getByText('Share to my profile'));
  expect(router.push).not.toHaveBeenCalled();
  await dismiss(); await dismiss();
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith({ pathname: '/create', params: { sharePostId: 'source-post' } });
  expect(shared).not.toHaveBeenCalled();
});

it('does not carry a queued profile share into another account', async () => {
  const ui = await render(<ShareSheet visible postId="source-post" onClose={jest.fn()} />);
  await fireEvent.press(ui.getByText('Share to my profile'));
  await act(async () => { setDiscoveryViewerFromSession('new-owner'); });
  await dismiss();
  expect(router.push).not.toHaveBeenCalled();
});
