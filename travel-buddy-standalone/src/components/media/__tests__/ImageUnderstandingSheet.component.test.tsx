import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { ImageUnderstandingSheet } from '../ImageUnderstandingSheet.tsx';
import * as service from '../../../services/media/imageUnderstanding.ts';

jest.mock('../../../services/media/imageUnderstanding.ts', () => ({ ...jest.requireActual('../../../services/media/imageUnderstanding.ts'), getImageUnderstandingStatus: jest.fn(), requestImageUnderstanding: jest.fn(), revokeImageUnderstanding: jest.fn(), readImageUnderstanding: jest.fn() }));
jest.mock('../../../hooks/usePrivateSurfaceKey.ts', () => ({ ...jest.requireActual('../../../hooks/usePrivateSurfaceKey.ts'), usePrivateSurfaceKey: () => mockScope }));
jest.mock('../../../services/messagingOwnerRequest.ts', () => ({ ...jest.requireActual('../../../services/messagingOwnerRequest.ts'), captureMessagingOwnerRequest: () => ({ isCurrent: () => mockOwnerCurrent }) }));
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({ ...jest.requireActual('../../ui/DisplayMediaImage.tsx'), DisplayMediaImage: () => null }));
let mockScope = 'owner';
let mockOwnerCurrent = true;
const media = [{ id: 'first', media_type: 'image' as const, url: 'photo' }, { id: 'second', media_type: 'video' as const, url: 'video', thumbnail_url: 'poster' }];
const status: service.ImageUnderstandingStatus = { postMediaId: 'first', sourceVersion: 7, mediaType: 'image', processing: { enabled: true, provider: 'local', policyVersion: 'local-v1', disclosure: 'Process on Portava’s own worker.' }, consent: 'none' };
let onAppState: (state: AppStateStatus) => void;
const originalState = Object.getOwnPropertyDescriptor(AppState, 'currentState');
beforeEach(() => {
  jest.clearAllMocks(); mockScope = 'owner'; mockOwnerCurrent = true;
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => { onAppState = listener; return { remove: jest.fn() }; });
  jest.mocked(service.getImageUnderstandingStatus).mockImplementation(async id => ({ ...status, postMediaId: id }));
  jest.mocked(service.requestImageUnderstanding).mockResolvedValue();
  jest.mocked(service.revokeImageUnderstanding).mockResolvedValue();
  jest.mocked(service.readImageUnderstanding).mockResolvedValue({ tags: ['beach'], processedAt: new Date().toISOString() });
});
afterEach(() => { jest.restoreAllMocks(); if (originalState) Object.defineProperty(AppState, 'currentState', originalState); });

it('requires loaded disclosure and explicit per-media consent before requesting', async () => {
  await render(<ImageUnderstandingSheet media={media} onClose={jest.fn()} />);
  await screen.findByText('Process on Portava’s own worker.');
  expect(service.requestImageUnderstanding).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Request suggestions'));
  expect(service.requestImageUnderstanding).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByText('Request suggestions'));
  expect(service.requestImageUnderstanding).toHaveBeenCalledWith(status, expect.anything());
  await screen.findByText(/Requested. Refresh/);
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
});

it('withdraws explicitly even when processing is disabled or status is unreadable', async () => {
  jest.mocked(service.getImageUnderstandingStatus).mockRejectedValue(new Error('Status unavailable'));
  await render(<ImageUnderstandingSheet media={media} onClose={jest.fn()} />);
  await screen.findByText('Status unavailable');
  await fireEvent.press(screen.getByText('Withdraw consent and remove suggestions'));
  expect(service.revokeImageUnderstanding).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Confirm withdraw and remove suggestions'));
  expect(service.revokeImageUnderstanding).toHaveBeenCalledWith('first', expect.anything());
  await screen.findByText(/Consent withdrawn and stored suggestions removed/);
});

it('cannot carry consent across media or revive a late status from a retired selection', async () => {
  let finish!: (value: service.ImageUnderstandingStatus) => void;
  jest.mocked(service.getImageUnderstandingStatus).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(<ImageUnderstandingSheet media={media} onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('Next'));
  await screen.findByText('Process on Portava’s own worker.');
  await act(async () => finish({ ...status, processing: { ...status.processing, disclosure: 'Retired disclosure' } }));
  expect(screen.queryByText('Retired disclosure')).toBeNull();
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
  expect(service.requestImageUnderstanding).not.toHaveBeenCalled();
});

it('clears consent and suggestions on background or owner replacement', async () => {
  const view = await render(<ImageUnderstandingSheet media={media} onClose={jest.fn()} />);
  await screen.findByText('Process on Portava’s own worker.');
  await fireEvent.press(screen.getByRole('checkbox'));
  await act(async () => { Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true }); onAppState('background'); });
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
  await fireEvent.press(screen.getByText('Request suggestions'));
  expect(service.requestImageUnderstanding).not.toHaveBeenCalled();
  mockOwnerCurrent = false; mockScope = 'new-owner';
  await view.rerender(<ImageUnderstandingSheet media={media} onClose={jest.fn()} />);
  expect(screen.queryByText('Process on Portava’s own worker.')).toBeNull();
});

it('requires fresh consent when the selected video poster changes', async () => {
  const video = media[1]!;
  const view = await render(<ImageUnderstandingSheet media={[video]} onClose={jest.fn()} />);
  await screen.findByText('Process on Portava’s own worker.');
  await fireEvent.press(screen.getByRole('checkbox'));
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(true);
  await view.rerender(<ImageUnderstandingSheet media={[{ ...video, thumbnail_url: 'replacement-poster' }]} onClose={jest.fn()} />);
  await screen.findByText('Process on Portava’s own worker.');
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
  expect(service.requestImageUnderstanding).not.toHaveBeenCalled();
});

it('shows uncertainty on results and never presents confidence as verified facts', async () => {
  jest.mocked(service.getImageUnderstandingStatus).mockResolvedValue({ ...status, consent: 'granted' });
  await render(<ImageUnderstandingSheet media={media} onClose={jest.fn()} />);
  await screen.findByText(/Processing was requested/);
  await fireEvent.press(screen.getByText('View suggestions'));
  await screen.findByText('beach');
  expect(screen.getByText(/AI suggestions — unverified/)).toBeTruthy();
  expect(service.requestImageUnderstanding).not.toHaveBeenCalled();
});
