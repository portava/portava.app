import React from 'react';
import { Pressable, Text } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { PortavaTripShareSheet, usePortavaTripComposer } from '../composer/PortavaTripShareSheet.tsx';
import { loadOwnedTripChoices, shareOwnedTripReference, type TripShareResult, type TripChoicesResult } from '../composer/portavaTripPickerApi.ts';
import { captureMessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import type { ConversationProjectionState } from '../conversation/conversationProjection.ts';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, { get(target, prop, receiver) {
    if (prop === 'Modal') {
      const React = require('react');
      return ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? React.createElement(target.View, null, children) : null;
    }
    return Reflect.get(target, prop, receiver);
  } });
});
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../composer/portavaTripPickerApi.ts', () => {
  return { loadOwnedTripChoices: jest.fn(), shareOwnedTripReference: jest.fn() };
});
jest.mock('../../../services/messagingOwnerRequest.ts', () => {
  return { captureMessagingOwnerRequest: jest.fn() };
});

const OWNER = 'owner-one';
const THREAD = 'thread-one';
const TRIP = 'trip-one';
const healthy: ConversationProjectionState = { status: 'ready', canSendMessage: true, isE2ee: false, degraded: false, memberCount: 2 };
const load = jest.mocked(loadOwnedTripChoices);
const share = jest.mocked(shareOwnedTripReference);
const capture = jest.mocked(captureMessagingOwnerRequest);
const sent = jest.fn();
let epoch = 0;

function Harness({ ownerId = OWNER, threadId = THREAD, projection = healthy }: {
  ownerId?: string | null; threadId?: string; projection?: ConversationProjectionState;
}) {
  const picker = usePortavaTripComposer(threadId, ownerId, projection, sent);
  return <>
    <Pressable onPress={picker.open} disabled={!picker.available} accessibilityRole="button"><Text>Open</Text></Pressable>
    {picker.intent ? <PortavaTripShareSheet key={picker.intent.generation} intent={picker.intent} onClose={picker.close} onSent={picker.sent} /> : null}
  </>;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  epoch = 0; sent.mockReset(); capture.mockReset();
  capture.mockImplementation(() => {
    const capturedEpoch = epoch;
    let valid = true;
    return { ownerId: OWNER, sessionId: `session-${capturedEpoch}`, isCurrent: () => valid && epoch === capturedEpoch, invalidate: () => { valid = false; } };
  });
  load.mockReset().mockResolvedValue({ ok: true, trips: [{ id: TRIP, title: 'Private trip' }, { id: 'trip-two', title: 'Second trip' }] });
  share.mockReset().mockResolvedValue({ ok: true, messageId: 'message-one' });
});

async function open() {
  const view = await render(<Harness />);
  await fireEvent.press(view.getByText('Open'));
  await view.findByText('Private trip');
  return view;
}

it('requires selection and explicit confirmation; warns sharing does not grant access', async () => {
  const view = await open();
  expect(view.getByText(/not an invitation/)).toBeTruthy();
  expect(share).not.toHaveBeenCalled();
  await fireEvent.press(view.getByTestId(`portava-trip-choice-${TRIP}`));
  expect(share).not.toHaveBeenCalled();
  expect(view.getByText('Share “Private trip” in this conversation?')).toBeTruthy();
  await fireEvent.press(view.getByTestId('portava-trip-confirm'));
  await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
  expect(share).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD, owner: expect.objectContaining({ ownerId: OWNER }) }), TRIP);
  expect(view.queryByTestId('portava-trip-picker')).toBeNull();
});

it('cancel writes nothing and reopening has no old selection', async () => {
  const view = await open();
  await fireEvent.press(view.getByTestId(`portava-trip-choice-${TRIP}`));
  await fireEvent.press(view.getByText('Close'));
  await fireEvent.press(view.getByText('Open'));
  await view.findByText('Private trip');
  expect(view.queryByText('Share “Private trip” in this conversation?')).toBeNull();
  expect(share).not.toHaveBeenCalled();
});

it('does not duplicate a pending send', async () => {
  const pending = deferred<TripShareResult>(); share.mockReturnValue(pending.promise);
  const view = await open();
  await fireEvent.press(view.getByTestId(`portava-trip-choice-${TRIP}`));
  await fireEvent.press(view.getByTestId('portava-trip-confirm'));
  await fireEvent.press(view.getByTestId('portava-trip-confirm'));
  expect(share).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ ok: true, messageId: 'message-one' }));
  expect(sent).toHaveBeenCalledTimes(1);
});

it.each(['refused', 'unknown', 'throw'] as const)('retains the selected trip on %s and never auto-retries', async outcome => {
  if (outcome === 'throw') share.mockRejectedValue(new Error('lost response'));
  else share.mockResolvedValue({ ok: false, reason: outcome, message: outcome === 'refused' ? 'You cannot share this object' : 'Check the conversation before trying again.' });
  const view = await open();
  await fireEvent.press(view.getByTestId(`portava-trip-choice-${TRIP}`));
  await fireEvent.press(view.getByTestId('portava-trip-confirm'));
  await waitFor(() => expect(view.getByTestId('portava-trip-confirm').props.accessibilityState.busy).toBe(false));
  expect(view.getByText('Share “Private trip” in this conversation?')).toBeTruthy();
  expect(sent).not.toHaveBeenCalled();
  expect(share).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('portava-trip-confirm').props.accessibilityState.disabled).toBe(outcome !== 'refused');
});

it('distinguishes failed load from empty; retry is an explicit read only', async () => {
  load.mockResolvedValueOnce({ ok: false, reason: 'unavailable', message: 'Trips could not be loaded.' });
  const view = await render(<Harness />);
  await fireEvent.press(view.getByText('Open'));
  await view.findByText('Trips could not be loaded.');
  expect(view.queryByText('You have no owned trips to share.')).toBeNull();
  await fireEvent.press(view.getByText('Try loading again'));
  await view.findByText('Private trip');
  expect(load).toHaveBeenCalledTimes(2);
  expect(share).not.toHaveBeenCalled();
});

it('shows actual empty without offering a write', async () => {
  load.mockResolvedValue({ ok: true, trips: [] });
  const view = await render(<Harness />);
  await fireEvent.press(view.getByText('Open'));
  await view.findByText('You have no owned trips to share.');
  expect(view.getByTestId('portava-trip-confirm').props.accessibilityState.disabled).toBe(true);
});

it.each(['account', 'signout', 'thread', 'degraded', 'encrypted', 'session', 'close', 'unmount'] as const)('discards pending send completion after %s', async change => {
  const pending = deferred<TripShareResult>(); share.mockReturnValue(pending.promise);
  const view = await open();
  await fireEvent.press(view.getByTestId(`portava-trip-choice-${TRIP}`));
  await fireEvent.press(view.getByTestId('portava-trip-confirm'));
  const scope = share.mock.calls[0][0];
  if (change === 'account') await view.rerender(<Harness ownerId="owner-two" />);
  if (change === 'signout') await view.rerender(<Harness ownerId={null} />);
  if (change === 'thread') await view.rerender(<Harness threadId="thread-two" />);
  if (change === 'degraded') await view.rerender(<Harness projection={{ ...healthy, degraded: true }} />);
  if (change === 'encrypted') await view.rerender(<Harness projection={{ ...healthy, isE2ee: true }} />);
  if (change === 'session') { epoch += 1; await view.rerender(<Harness />); }
  if (change === 'close') await fireEvent.press(view.getByText('Close'));
  if (change === 'unmount') await view.unmount();
  expect(scope.isCurrent()).toBe(false);
  await act(async () => pending.resolve({ ok: true, messageId: 'old-message' }));
  expect(sent).not.toHaveBeenCalled();
});

it('late old send cannot close a reopened picker or overwrite its choice', async () => {
  const pending = deferred<TripShareResult>(); share.mockReturnValue(pending.promise);
  const view = await open();
  await fireEvent.press(view.getByTestId(`portava-trip-choice-${TRIP}`));
  await fireEvent.press(view.getByTestId('portava-trip-confirm'));
  await fireEvent.press(view.getByText('Close'));
  await fireEvent.press(view.getByText('Open'));
  await view.findByText('Second trip');
  await fireEvent.press(view.getByTestId('portava-trip-choice-trip-two'));
  await act(async () => pending.resolve({ ok: false, reason: 'unknown', message: 'Old error' }));
  expect(view.getByText('Share “Second trip” in this conversation?')).toBeTruthy();
  expect(view.queryByText('Old error')).toBeNull();
  expect(sent).not.toHaveBeenCalled();
});

it('late list cannot populate a reopened picker', async () => {
  const pending = deferred<TripChoicesResult>(); load.mockReturnValueOnce(pending.promise);
  const view = await render(<Harness />);
  await fireEvent.press(view.getByText('Open'));
  await fireEvent.press(view.getByText('Close'));
  await fireEvent.press(view.getByText('Open'));
  await view.findByText('Private trip');
  await act(async () => pending.resolve({ ok: true, trips: [{ id: 'old-trip', title: 'Stale title' }] }));
  expect(view.queryByText('Stale title')).toBeNull();
});

it.each<ConversationProjectionState>([
  { status: 'loading' }, { status: 'unavailable' }, { ...healthy, isE2ee: null },
  { ...healthy, isE2ee: true }, { ...healthy, degraded: true }, { ...healthy, canSendMessage: false },
])('cannot open under an ineligible capability projection %p', async projection => {
  const view = await render(<Harness projection={projection} />);
  await fireEvent.press(view.getByText('Open'));
  expect(load).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
});

it('unknown identity cannot open or start reading', async () => {
  capture.mockReturnValue(null);
  const view = await render(<Harness />);
  await fireEvent.press(view.getByText('Open'));
  expect(load).not.toHaveBeenCalled();
});
