import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { useDiscoveryTrailOpen } from '../useDiscoveryTrailOpen.ts';
import { sendTrailOpen } from '../../services/discoveryTrailOpen.ts';

let mockEnabled = false;
let mockOwner: string | null = 'owner';
// NOTE: the test controls the existing rollout gate and session explicitly.
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({ useFeatureFlags: () => ({ isEnabled: () => mockEnabled }) }));
jest.mock('../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: mockOwner }) }));
// NOTE: transport behavior has its own service suite; count screen visits here.
jest.mock('../../services/discoveryTrailOpen.ts', () => ({ DISCOVERY_TRAIL_OPEN_FLAG: 'discovery_trail_open_telemetry_enabled', sendTrailOpen: jest.fn().mockResolvedValue('sent') }));
jest.mock('../../services/discoveryDwell.ts', () => ({ newClientEventId: () => '22222222-2222-4222-8222-222222222222' }));
function Probe({ loaded = true, visible = true }: { loaded?: boolean; visible?: boolean }) { useDiscoveryTrailOpen('11111111-1111-4111-8111-111111111111', loaded, visible); return null; }
const send = sendTrailOpen as jest.Mock;
beforeEach(() => { mockEnabled = false; mockOwner = 'owner'; send.mockClear(); Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' }); });

it('never emits for a disabled, prefetched, unreadable, or signed-out screen', async () => {
  const view = await render(<Probe />);
  expect(send).not.toHaveBeenCalled();
  mockEnabled = true; await view.rerender(<Probe visible={false} />);
  await view.rerender(<Probe loaded={false} />);
  mockOwner = null; await view.rerender(<Probe />);
  expect(send).not.toHaveBeenCalled();
});
it('records one loaded focused visit, ignores rerenders, and records a later navigation visit', async () => {
  mockEnabled = true; const view = await render(<Probe loaded={false} />);
  expect(send).not.toHaveBeenCalled();
  await view.rerender(<Probe />); await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await view.rerender(<Probe />); expect(send).toHaveBeenCalledTimes(1);
  await view.rerender(<Probe visible={false} />); await view.rerender(<Probe />);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
});
it('withdrawal and account changes invalidate an in-flight emission', async () => {
  mockEnabled = true; const view = await render(<Probe />);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const opts = send.mock.calls[0][1]; expect(opts.isAllowed()).toBe(true);
  mockEnabled = false; await view.rerender(<Probe />);
  expect(opts.isAllowed()).toBe(false); expect(opts.signal.aborted).toBe(true);
});
it('background resume does not count a second open of the same loaded page', async () => {
  let onChange!: (state: string) => void;
  const listener = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, fn) => { onChange = fn as typeof onChange; return { remove: jest.fn() }; });
  mockEnabled = true; await render(<Probe />);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await act(async () => { onChange('background'); });
  await act(async () => { onChange('active'); });
  expect(send).toHaveBeenCalledTimes(1); listener.mockRestore();
});
