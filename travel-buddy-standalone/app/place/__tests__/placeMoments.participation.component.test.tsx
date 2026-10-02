/**
 * HM-F17 / HM-F18 — /place/:id/moments.
 *
 *   - Your invitations to Moments at this place, each opening the Moment,
 *     where accept / decline lives.
 *   - The suggestion card: `GET /shared-moments/suggestions/mine`, labelled
 *     "Suggestion — no one is joined or added automatically.", with Open and
 *     Dismiss. Nothing is joined by showing it.
 *   - The Moments list itself: a failed read is an error with a retry, not
 *     "No Shared Moments yet" (DV-83).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => {
  const { View: V } = jest.requireActual('react-native');
  return {
    Stack: { Screen: () => <V /> },
    router: { back: jest.fn(), push: (...a: unknown[]) => mockPush(...a) },
    useLocalSearchParams: () => ({ id: 'place-1', placeDayId: 'day-1' }),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const { View: V } = jest.requireActual('react-native');
  return { ...jest.requireActual('react-native-safe-area-context'), SafeAreaView: V };
});
// NOTE: intentionally exhaustive — the real provider fetches flags on mount.
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, isLivePlacesEnabled: () => true, loading: false }),
}));

const mockList = jest.fn();
const mockInvites = jest.fn();
const mockSuggestions = jest.fn();
const mockDismiss = jest.fn();
jest.mock('../../../src/services/sharedMoments.ts', () => ({
  ...jest.requireActual('../../../src/services/sharedMoments.ts'),
  listSharedMoments: (...a: unknown[]) => mockList(...a),
  listMySharedMomentInvites: (...a: unknown[]) => mockInvites(...a),
  listSharedMomentSuggestions: (...a: unknown[]) => mockSuggestions(...a),
  dismissSharedMomentSuggestion: (...a: unknown[]) => mockDismiss(...a),
}));

import PlaceMomentsScreen from '../[id]/moments.tsx';

const LABEL = 'Suggestion — no one is joined or added automatically.';
const pm = (id: string, placeId: string, title: string) => ({ id, title, description: null, placeId, placeDayId: null, tripId: null, joinPolicy: 'invite_only', status: 'active' });

beforeEach(() => {
  mockPush.mockReset(); mockList.mockReset(); mockInvites.mockReset(); mockSuggestions.mockReset(); mockDismiss.mockReset();
  mockList.mockResolvedValue({ moments: [] });
  mockInvites.mockResolvedValue({ ok: true, data: [] });
  mockSuggestions.mockResolvedValue({ ok: true, data: [] });
});

it('shows your invitations to Moments at this place and opens one', async () => {
  mockInvites.mockResolvedValue({ ok: true, data: [
    { moment: pm('sm1', 'place-1', 'Sunset at the pier'), invitedBy: 'o', invitedAt: 'x' },
    { moment: pm('sm2', 'elsewhere', 'Another city'), invitedBy: 'o', invitedAt: 'x' },
  ] });
  await render(<PlaceMomentsScreen />);
  expect(await screen.findByText('Sunset at the pier')).toBeTruthy();
  expect(screen.queryByText('Another city')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByTestId('moment-invite-sm1')); });
  expect(mockPush).toHaveBeenCalledWith('/shared-moments/sm1');
});

it('shows a suggestion with its label; open goes to the Moment, dismiss removes the card', async () => {
  mockSuggestions.mockResolvedValue({ ok: true, data: [{ id: 'sg1', momentId: 'sm9', kind: 'compass', reason: 'You were both here at sunset', label: LABEL, createdAt: 'x' }] });
  mockDismiss.mockResolvedValue({ ok: true, data: { ok: true } });
  await render(<PlaceMomentsScreen />);
  expect(await screen.findByText(LABEL)).toBeTruthy();
  expect(screen.getByText('You were both here at sunset')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId('moment-suggestion-open-sg1')); });
  expect(mockPush).toHaveBeenCalledWith('/shared-moments/sm9');
  await act(async () => { fireEvent.press(screen.getByTestId('moment-suggestion-dismiss-sg1')); });
  expect(mockDismiss).toHaveBeenCalledWith('sg1');
  expect(screen.queryByText(LABEL)).toBeNull();
});

it('a Moments list that could not be read is an error, not "No Shared Moments yet"', async () => {
  mockList.mockResolvedValueOnce(null);
  await render(<PlaceMomentsScreen />);
  expect(await screen.findByTestId('moments-list-error')).toBeTruthy();
  expect(screen.queryByText('No Shared Moments yet')).toBeNull();
  mockList.mockResolvedValueOnce({ moments: [] });
  await act(async () => { fireEvent.press(screen.getByTestId('moments-list-retry')); });
  expect(await screen.findByText('No Shared Moments yet')).toBeTruthy();
});

it('an unreadable suggestion list says so instead of showing nothing', async () => {
  mockSuggestions.mockResolvedValue({ ok: false, code: 'server', message: 'Something went wrong. Please try again.' });
  await render(<PlaceMomentsScreen />);
  expect(await screen.findByTestId('moment-suggestions-error')).toBeTruthy();
});
