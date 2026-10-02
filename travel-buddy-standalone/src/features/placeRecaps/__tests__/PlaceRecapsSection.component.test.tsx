/**
 * HM-F19 — your recaps of a place, on the place screen.
 *
 * `listPlaceRecaps` (GET /places/:placeId/recaps) had no caller, so a recap
 * published from a Place Day could not be found again from the place. The
 * route answers the CALLER'S OWN recaps at the place (owner_id = viewer, not
 * removed), every version joined. This section shows each with its latest
 * title and its status, published first, and opens /recaps/:id.
 *
 * Honest states: the capability off (feature_disabled) shows nothing; a failed
 * read is an error with a retry; no recaps shows nothing, because there is
 * nothing of yours here and that is not a failure.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
const mockList = jest.fn();
jest.mock('../../../services/placeRecaps.ts', () => ({
  ...jest.requireActual('../../../services/placeRecaps.ts'),
  listPlaceRecaps: (...a: unknown[]) => mockList(...a),
}));

import { PlaceRecapsSection } from '../PlaceRecapsSection.tsx';

const PLACE = '66666666-6666-4666-8666-666666666666';
const recap = (id: string, status: string, versions: Array<{ version_number: number; title: string }>) => ({
  id, place_id: PLACE, status, created_at: '2026-09-0' + id.slice(-1) + 'T00:00:00Z', current_version_id: 'v',
  live_place_recap_versions: versions.map((v) => ({ ...v, summary: '', published_at: null })),
});

beforeEach(() => { mockPush.mockReset(); mockList.mockReset(); });

it('lists your recaps here, published first, with the latest title, and opens one', async () => {
  mockList.mockResolvedValue({ error: null, data: [
    // The draft is NEWER than the published recap, so date order alone would put it first.
    recap('r2', 'published', [{ version_number: 1, title: 'Old title' }, { version_number: 2, title: 'A slow Sunday' }]),
    recap('r5', 'draft', [{ version_number: 1, title: 'Draft day' }]),
  ] });
  await render(<PlaceRecapsSection placeId={PLACE} enabled />);
  expect(await screen.findByText('A slow Sunday')).toBeTruthy();
  expect(screen.queryByText('Old title')).toBeNull();
  const rows = screen.getAllByTestId(/^place-recap-/);
  expect(rows[0].props.testID).toBe('place-recap-r2');
  expect(screen.getByText('Published')).toBeTruthy();
  expect(screen.getByText('Draft')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId('place-recap-r2')); });
  expect(mockPush).toHaveBeenCalledWith('/recaps/r2');
  expect(mockList).toHaveBeenCalledWith(PLACE);
});

it('does not ask when the capability is off', async () => {
  await render(<PlaceRecapsSection placeId={PLACE} enabled={false} />);
  expect(mockList).not.toHaveBeenCalled();
  expect(screen.queryByTestId('place-recaps')).toBeNull();
});

it('a failed read is an error with a retry', async () => {
  mockList.mockResolvedValueOnce({ data: null, error: 'server' });
  await render(<PlaceRecapsSection placeId={PLACE} enabled />);
  expect(await screen.findByTestId('place-recaps-error')).toBeTruthy();
  mockList.mockResolvedValueOnce({ error: null, data: [recap('r3', 'published', [{ version_number: 1, title: 'Back again' }])] });
  await act(async () => { fireEvent.press(screen.getByTestId('place-recaps-retry')); });
  expect(await screen.findByText('Back again')).toBeTruthy();
});

it('feature_disabled from the server shows nothing, not an error', async () => {
  mockList.mockResolvedValue({ data: null, error: 'disabled' });
  await render(<PlaceRecapsSection placeId={PLACE} enabled />);
  await act(async () => {});
  expect(screen.queryByTestId('place-recaps-error')).toBeNull();
  expect(screen.queryByTestId('place-recaps')).toBeNull();
});
