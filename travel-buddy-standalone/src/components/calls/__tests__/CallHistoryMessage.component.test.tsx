/**
 * CallHistoryMessage — thread timeline lines for missed / declined /
 * canceled / duration outcomes, with permission-aware Call back.
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { CallHistoryMessage } from '../CallHistoryMessage.tsx';

afterEach(async () => { await act(async () => {}); });

test('missed incoming call shows Call back and passes the right call type', async () => {
  const onCallBack = jest.fn();
  const view = await render(
    <CallHistoryMessage subtype="call_missed" body="Missed voice call" mine={false} onCallBack={onCallBack} />,
  );
  expect(view.getByText('Missed voice call')).toBeTruthy();
  fireEvent.press(view.getByLabelText('Call back'));
  expect(onCallBack).toHaveBeenCalledWith('voice');
});

test('missed video call calls back as video', async () => {
  const onCallBack = jest.fn();
  const view = await render(
    <CallHistoryMessage subtype="call_missed" body="Missed video call" mine={false} onCallBack={onCallBack} />,
  );
  fireEvent.press(view.getByLabelText('Call back'));
  expect(onCallBack).toHaveBeenCalledWith('video');
});

test('no Call back when the viewer was the caller', async () => {
  const view = await render(
    <CallHistoryMessage subtype="call_missed" body="Missed voice call" mine onCallBack={jest.fn()} />,
  );
  expect(view.queryByLabelText('Call back')).toBeNull();
});

test('no Call back when calling is no longer permitted (handler omitted)', async () => {
  const view = await render(
    <CallHistoryMessage subtype="call_missed" body="Missed voice call" mine={false} />,
  );
  expect(view.queryByLabelText('Call back')).toBeNull();
});

test('declined, canceled, and duration lines render without Call back', async () => {
  const view = await render(
    <CallHistoryMessage subtype="call_declined" body="Call declined" mine={false} />,
  );
  expect(view.getByText('Call declined')).toBeTruthy();
  await view.rerender(<CallHistoryMessage subtype="call_canceled" body="Call canceled" mine />);
  expect(view.getByText('Call canceled')).toBeTruthy();
  await view.rerender(<CallHistoryMessage subtype="call_ended" body="Voice call · 4 min" mine />);
  expect(view.getByText('Voice call · 4 min')).toBeTruthy();
  expect(view.queryByLabelText('Call back')).toBeNull();
});
