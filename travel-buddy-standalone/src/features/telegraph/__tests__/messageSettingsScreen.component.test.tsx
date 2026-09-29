/**
 * WP-08 / TEL-F23 — the Message settings screen edits the store the server
 * ENFORCES (`user_message_settings`, read by canMessage), and it is honest:
 *
 *   - a failed read shows an error with Try again and NO editable controls
 *     (defaults shown after a failed read would invite "changing" settings
 *     from values that are not the person's — DV-83);
 *   - a change is sent as the snake_case patch the server's schema takes;
 *   - a refused save puts the previous value back and says so;
 *   - read receipts are stated, not offered as a switch that could not keep
 *     its promise (decision TM-TEL-D7).
 *
 * SettingsUI is stubbed to plain Views/Pressables: this file tests the
 * screen's logic, not the shared chrome.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

const mockGet = jest.fn();
const mockUpdate = jest.fn();
// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time; the screen calls these two functions only.
jest.mock('../../../services/messaging.ts', () => ({
  getMyMessageSettings: (...a: unknown[]) => mockGet(...a),
  updateMyMessageSettings: (...a: unknown[]) => mockUpdate(...a),
}));

// NOTE: intentionally exhaustive — the real SettingsUI needs navigation and
// safe-area providers; these stubs keep the same props the screen passes.
jest.mock('../../../components/settings/SettingsUI.tsx', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    SettingsScreen: ({ children, subtitle }: any) =>
      R.createElement(RN.View, null, subtitle ? R.createElement(RN.Text, null, subtitle) : null, children),
    SettingsSection: ({ children, title, subtitle }: any) =>
      R.createElement(RN.View, null, title ? R.createElement(RN.Text, null, title) : null,
        subtitle ? R.createElement(RN.Text, null, subtitle) : null, children),
    SettingsRow: ({ title, onPress, testID, right, disabled, accessibilityState }: any) =>
      R.createElement(RN.Pressable, { onPress, testID, disabled, accessibilityState },
        R.createElement(RN.Text, null, title), right ?? null),
    SettingsDivider: () => null,
  };
});

import { MessageSettingsScreen } from '../settings/MessageSettingsScreen.tsx';

const SETTINGS = {
  message_privacy: 'everyone',
  allow_message_requests: true,
  allow_trip_member_messages: true,
  allow_circle_member_messages: true,
  updated_at: null,
};

beforeEach(() => { jest.clearAllMocks(); });

it('a failed read is an error with Try again, and shows NO controls', async () => {
  mockGet.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'db_error' });
  await render(<MessageSettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('message-settings-retry')).toBeTruthy());
  expect(screen.queryByTestId('message-privacy-no_one')).toBeNull();

  mockGet.mockResolvedValueOnce({ ok: true, data: SETTINGS });
  await fireEvent.press(screen.getByTestId('message-settings-retry'));
  await waitFor(() => expect(screen.getByTestId('message-privacy-no_one')).toBeTruthy());
});

it('an unconfigured build answering ok-with-no-data is NOT shown as defaults', async () => {
  mockGet.mockResolvedValueOnce({ ok: true, data: null });
  await render(<MessageSettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('message-settings-retry')).toBeTruthy());
  expect(screen.queryByTestId('message-privacy-everyone')).toBeNull();
});

it('choosing "No one" sends the enforced column, and the server’s answer is shown', async () => {
  mockGet.mockResolvedValueOnce({ ok: true, data: SETTINGS });
  mockUpdate.mockResolvedValueOnce({ ok: true, data: { ...SETTINGS, message_privacy: 'no_one', updated_at: 'x' } });
  await render(<MessageSettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('message-privacy-no_one')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('message-privacy-no_one'));
  await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ message_privacy: 'no_one' }));
  await waitFor(() =>
    expect(screen.getByTestId('message-privacy-no_one').props.accessibilityState).toMatchObject({ checked: true }));
});

it('a refused save puts the previous value back and says so', async () => {
  mockGet.mockResolvedValueOnce({ ok: true, data: SETTINGS });
  mockUpdate.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'db_error' });
  await render(<MessageSettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('message-privacy-friends')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('message-privacy-friends'));
  await waitFor(() => expect(screen.getByTestId('message-settings-save-error')).toBeTruthy());
  expect(screen.getByTestId('message-privacy-everyone').props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByTestId('message-privacy-friends').props.accessibilityState).toMatchObject({ checked: false });
});

it('toggling message requests off sends allow_message_requests: false', async () => {
  mockGet.mockResolvedValueOnce({ ok: true, data: SETTINGS });
  mockUpdate.mockResolvedValueOnce({ ok: true, data: { ...SETTINGS, allow_message_requests: false } });
  await render(<MessageSettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('message-setting-allow_message_requests')).toBeTruthy());
  await fireEvent(screen.getByTestId('message-setting-allow_message_requests'), 'valueChange', false);
  await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({ allow_message_requests: false }));
});

it('read receipts are stated, not offered as a switch', async () => {
  mockGet.mockResolvedValueOnce({ ok: true, data: SETTINGS });
  await render(<MessageSettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('message-settings-receipts-note')).toBeTruthy());
  expect(screen.queryByTestId('message-setting-read_receipts')).toBeNull();
});
