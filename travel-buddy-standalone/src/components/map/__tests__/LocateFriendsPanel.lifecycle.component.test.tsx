import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, render } from '@testing-library/react-native';
const mockStarts = jest.fn(); const mockStops = jest.fn();
// NOTE: deterministic sync boundary. Actual read/publish cancellation is covered by locateFriendsService tests; no network is used by this mounted lifecycle test.
jest.mock('../../../services/locateFriends.ts', () => ({ ...jest.requireActual('../../../services/locateFriends.ts'), createLocateFriendsSync: jest.fn(() => ({ start: mockStarts, stop: mockStops, isRunning: () => false, state: () => ({}), refresh: async () => {}, publishOnce: async () => null, leave: async () => ({ ok: true, data: { left: true } }) })) }));
import { LocateFriendsPanel } from '../LocateFriendsPanel.tsx';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
let listeners: Set<(state: AppStateStatus) => void>; let subscription: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks(); setDiscoveryViewerFromSession('locate-owner'); Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' }); listeners = new Set();
  subscription = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { listeners.add(listener); return { remove: () => { listeners.delete(listener); } }; });
});
afterEach(() => { subscription.mockRestore(); });
const props = { sessionId: 'session', viewerMemberId: 'locate-owner' };
it('background stops immediately and foreground resumes only the same owner', async () => {
  const ui = await render(<LocateFriendsPanel live={props} now={1000} />); expect(mockStarts).toHaveBeenCalledTimes(1);
  await act(async () => { for (const listener of listeners) listener('background'); }); expect(mockStops).toHaveBeenCalledTimes(1);
  await act(async () => { for (const listener of listeners) listener('active'); }); expect(mockStarts).toHaveBeenCalledTimes(2);
  await act(async () => { setDiscoveryViewerFromSession('replacement'); }); expect(mockStops).toHaveBeenCalledTimes(2);
  await act(async () => { for (const listener of listeners) listener('active'); }); expect(mockStarts).toHaveBeenCalledTimes(2);
  await ui.unmount(); expect(listeners.size).toBe(0);
});
it('screen blur stops polling and cannot start while already blurred', async () => {
  const ui = await render(<LocateFriendsPanel live={{ ...props, active: false }} now={1000} />); expect(mockStarts).not.toHaveBeenCalled();
  await ui.rerender(<LocateFriendsPanel live={props} now={1000} />); expect(mockStarts).toHaveBeenCalledTimes(1);
  await ui.rerender(<LocateFriendsPanel live={{ ...props, active: false }} now={1000} />); expect(mockStops.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it('a stale session prop for another viewer never starts', async () => {
  await render(<LocateFriendsPanel live={{ ...props, viewerMemberId: 'previous-account' }} now={1000} />); expect(mockStarts).not.toHaveBeenCalled();
});
