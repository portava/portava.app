import React from 'react';
import { Linking } from 'react-native';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import AccountAccessScreen from '../account-access.tsx';

let mockAuthed = false;
const mockSignOut = jest.fn();
// NOTE: the session boundary is controlled without opening a native Supabase subscription.
jest.mock('../../../src/context/SessionContext', () => ({ useSession: () => ({ isAuthed: mockAuthed }) }));
// NOTE: this screen only uses signOut; the auth transport must remain synthetic.
jest.mock('../../../src/lib/supabase', () => ({ supabase: { auth: { signOut: (...args: unknown[]) => mockSignOut(...args) } } }));
jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() } }));
// NOTE: layout/native inset behavior is outside the public account-access flow being exercised.
jest.mock('../../../src/components/settings/SettingsUI', () => {
  const R = require('react'); const { Text, View, Pressable } = require('react-native');
  return {
    SettingsScreen: ({ children }: any) => R.createElement(View, null, children),
    SettingsSection: ({ children }: any) => R.createElement(View, null, children),
    SettingsRow: ({ title, onPress, disabled }: any) => R.createElement(Pressable, { onPress, disabled }, R.createElement(Text, null, title)),
  };
});
const oldUrl = process.env.EXPO_PUBLIC_ACCOUNT_APPEAL_URL;
beforeEach(() => { mockAuthed = false; jest.clearAllMocks(); delete process.env.EXPO_PUBLIC_ACCOUNT_APPEAL_URL; });
afterEach(() => { jest.restoreAllMocks(); if (oldUrl === undefined) delete process.env.EXPO_PUBLIC_ACCOUNT_APPEAL_URL; else process.env.EXPO_PUBLIC_ACCOUNT_APPEAL_URL = oldUrl; });

it('is usable without login and honestly states that an unconfigured channel is unavailable', async () => {
  await render(<AccountAccessScreen />);
  expect(screen.getByText(/external account-review contact is not available/)).toBeTruthy();
  expect(screen.queryByText('Request an account review')).toBeNull();
  expect(screen.queryByText('In-app restrictions & appeals')).toBeNull();
  expect(mockSignOut).not.toHaveBeenCalled();
});
it('opens the configured HTTPS review channel without attaching account data', async () => {
  process.env.EXPO_PUBLIC_ACCOUNT_APPEAL_URL = 'https://support.example.com/review';
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await render(<AccountAccessScreen />);
  fireEvent.press(screen.getByText('Request an account review'));
  await waitFor(() => expect(open).toHaveBeenCalledWith('https://support.example.com/review'));
});
it('reports contact-launch failures and permits retry', async () => {
  process.env.EXPO_PUBLIC_ACCOUNT_APPEAL_URL = 'https://support.example.com/review';
  jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('offline'));
  await render(<AccountAccessScreen />);
  fireEvent.press(screen.getByText('Request an account review'));
  await waitFor(() => expect(screen.getByText(/Could not open the appeal service/)).toBeTruthy());
  expect(screen.getByText('Request an account review')).toBeTruthy();
});
it('keeps local sign-out failures visible and navigates only after success', async () => {
  mockAuthed = true;
  mockSignOut.mockResolvedValueOnce({ error: new Error('unavailable') }).mockResolvedValueOnce({ error: null });
  await render(<AccountAccessScreen />);
  fireEvent.press(screen.getByText('Sign out of this device'));
  await waitFor(() => expect(screen.getByText(/Could not sign out/)).toBeTruthy());
  expect(router.replace).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Sign out of this device'));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/sign-in'));
  expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
});
