import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MediaDubbingManagementEntry } from '../MediaDubbingManagementEntry.tsx';
import { resolveCaptionSource } from '../../../services/media/captions.ts';

let mockActor = '11111111-1111-4111-8111-111111111111';
let mockAppListener: (state: string) => void;
jest.mock('../../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: mockActor, isAuthed: !!mockActor }) }));
jest.mock('../../../services/media/captions.ts', () => ({ ...jest.requireActual('../../../services/media/captions.ts'), resolveCaptionSource: jest.fn() }));
jest.mock('../../../services/media/dubbing.ts', () => ({ ...jest.requireActual('../../../services/media/dubbing.ts'), subscribeDubbingAuth: () => () => {} }));
jest.mock('../MediaDubbingManagement.tsx', () => {
  const actual = jest.requireActual('../MediaDubbingManagement.tsx');
  const { Text } = require('react-native');
  return { ...actual, MediaDubbingManagement: ({ source }: { source: { assetId: string } }) => <Text testID="management">{source.assetId}</Text> };
});
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, { get(target, key) {
    if (key === 'AppState') return { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => { mockAppListener = listener; return { remove: jest.fn() }; } };
    return Reflect.get(target, key);
  } });
});
const assetId = '22222222-2222-4222-8222-222222222222';
const source = { assetId, version: 1, canEdit: true, revisionKey: 'a'.repeat(64), durationMs: 2000 };
const withdrawn = jest.fn();
beforeEach(() => {
  jest.clearAllMocks(); mockActor = '11111111-1111-4111-8111-111111111111';
  jest.mocked(resolveCaptionSource).mockResolvedValue(source);
});

it('never fetches automatically; explicit management uses the owner-only OFF-safe lookup', async () => {
  await render(<MediaDubbingManagementEntry source="original" active onWithdrawn={withdrawn} />);
  expect(resolveCaptionSource).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByLabelText('Manage AI audio permission')); });
  await waitFor(() => expect(screen.getByTestId('management')).toBeTruthy());
  expect(resolveCaptionSource).toHaveBeenCalledWith('original', expect.any(AbortSignal), { forDubbingManagement: true });
});

it('refuses nonowners without exposing management', async () => {
  jest.mocked(resolveCaptionSource).mockResolvedValue({ ...source, canEdit: false });
  await render(<MediaDubbingManagementEntry source="original" active onWithdrawn={withdrawn} />);
  await act(async () => { fireEvent.press(screen.getByLabelText('Manage AI audio permission')); });
  expect(screen.queryByTestId('management')).toBeNull();
  expect(screen.getByText(/Only the current video owner/)).toBeTruthy();
});

it('late source resolution cannot cross an account or source change', async () => {
  let complete!: (value: typeof source) => void;
  jest.mocked(resolveCaptionSource).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const view = await render(<MediaDubbingManagementEntry source="original" active onWithdrawn={withdrawn} />);
  await act(async () => { fireEvent.press(screen.getByLabelText('Manage AI audio permission')); });
  const signal = jest.mocked(resolveCaptionSource).mock.calls[0][1]!;
  mockActor = '33333333-3333-4333-8333-333333333333';
  await view.rerender(<MediaDubbingManagementEntry source="another" active onWithdrawn={withdrawn} />);
  await act(async () => { complete(source); });
  expect(signal.aborted).toBe(true);
  expect(screen.queryByTestId('management')).toBeNull();
});

it('background, inactivity and logout remove owner-management access', async () => {
  const view = await render(<MediaDubbingManagementEntry source="original" active onWithdrawn={withdrawn} />);
  await act(async () => { fireEvent.press(screen.getByLabelText('Manage AI audio permission')); });
  expect(screen.getByTestId('management')).toBeTruthy();
  await act(async () => { mockAppListener('background'); });
  expect(screen.queryByTestId('management')).toBeNull();
  await view.rerender(<MediaDubbingManagementEntry source="original" active={false} onWithdrawn={withdrawn} />);
  expect(screen.queryByLabelText('Manage AI audio permission')).toBeNull();
  mockActor = '';
  await view.rerender(<MediaDubbingManagementEntry source="original" active onWithdrawn={withdrawn} />);
  expect(screen.queryByLabelText('Manage AI audio permission')).toBeNull();
});
