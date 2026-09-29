/**
 * WP-08 / TEL-F08 — the Saved messages screen, rendered.
 *
 * Pins the four honest states (loading, error with retry, empty, list) and the
 * two outcomes of Remove. The one this file exists for is the error: a failed
 * read must SAY SO and offer Try again, never render "No saved messages" (DV-83).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockGetSaved = jest.fn();
const mockUnsave = jest.fn();
// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time. The screen calls exactly these two functions.
jest.mock('../../../services/messaging.ts', () => ({
  getSavedMessages: (...a: unknown[]) => mockGetSaved(...a),
  unsaveSavedMessage: (...a: unknown[]) => mockUnsave(...a),
}));

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — the screen uses router and useFocusEffect.
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn() },
    useFocusEffect: (cb: () => void) => R.useEffect(() => { cb(); }, [cb]),
  };
});
// NOTE: intentionally exhaustive — the header needs safe-area and navigation.
jest.mock('../../../components/ui/AppHeader.tsx', () => ({
  AppHeader: () => null,
}));
// NOTE: intentionally exhaustive — the nav-bar collapse hook needs the tab navigator.
jest.mock('../../../hooks/useNavBarCollapse.ts', () => ({
  useNavBarScrollHandler: () => undefined,
  NavBarFiller: () => null,
}));

import { SavedMessagesScreen, savedPreview } from '../savedMessages/SavedMessagesScreen.tsx';

const ITEM = (id: string, body: string | null, extra: Record<string, unknown> = {}) => ({
  messageId: id, threadId: 't-1', senderId: 'u-2', body, createdAt: '2026-09-01T10:00:00Z',
  savedAt: '2026-09-02T10:00:00Z', msgType: 'text', subtype: null, mediaUrl: null, mediaType: null,
  mediaThumbnailUrl: null, ...extra,
});

beforeEach(() => { jest.clearAllMocks(); });

it('a failed read is the ERROR state with Try again — never "No saved messages"', async () => {
  mockGetSaved.mockResolvedValueOnce({ ok: false, data: null, code: 'degraded_unavailable' });
  await render(<SavedMessagesScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-messages-error')).toBeTruthy());
  expect(screen.queryByTestId('saved-messages-empty')).toBeNull();

  mockGetSaved.mockResolvedValueOnce({ ok: true, data: { saved: [ITEM('m-1', 'the hostel is on Rua Augusta')] } });
  await fireEvent.press(screen.getByTestId('saved-messages-retry'));
  await waitFor(() => expect(screen.getByText('the hostel is on Rua Augusta')).toBeTruthy());
});

it('an empty successful read is the empty state', async () => {
  mockGetSaved.mockResolvedValueOnce({ ok: true, data: { saved: [] } });
  await render(<SavedMessagesScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-messages-empty')).toBeTruthy());
});

it('tapping a saved message opens its conversation', async () => {
  mockGetSaved.mockResolvedValueOnce({ ok: true, data: { saved: [ITEM('m-1', 'hi')] } });
  await render(<SavedMessagesScreen />);
  await waitFor(() => expect(screen.getByTestId('saved-message-m-1')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('saved-message-m-1'));
  expect(mockPush).toHaveBeenCalledWith('/messages/t-1');
});

it('Remove takes the row away only when the server removed it', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockGetSaved.mockResolvedValueOnce({ ok: true, data: { saved: [ITEM('m-1', 'one'), ITEM('m-2', 'two')] } });
  await render(<SavedMessagesScreen />);
  await waitFor(() => expect(screen.getByText('one')).toBeTruthy());

  mockUnsave.mockResolvedValueOnce({ ok: false, data: null, code: 'degraded_unavailable' });
  await fireEvent.press(screen.getByTestId('saved-message-remove-m-1'));
  await waitFor(() => expect(alert).toHaveBeenCalled());
  expect(screen.getByText('one')).toBeTruthy();

  mockUnsave.mockResolvedValueOnce({ ok: true, data: { status: 'unsaved' } });
  await fireEvent.press(screen.getByTestId('saved-message-remove-m-2'));
  await waitFor(() => expect(screen.queryByText('two')).toBeNull());
  expect(mockUnsave).toHaveBeenLastCalledWith('m-2');
  alert.mockRestore();
});

it('never prints a structured envelope, and names encrypted and media saves', async () => {
  expect(savedPreview(ITEM('a', '{"v":1,"kind":"VOICE","payload":{"url":"post-media/secret"}}') as never)).toBe('Shared item');
  expect(savedPreview(ITEM('b', null) as never)).toMatch(/Encrypted/);
  expect(savedPreview(ITEM('c', null, { mediaUrl: 'x', mediaType: 'image' }) as never)).toBe('Photo');
});
