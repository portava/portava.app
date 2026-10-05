/**
 * CandidateInbox — §7's candidate inbox on the owner's timeline
 * (census-highlights-memories H18/H19/H23/H24).
 *
 * WHAT THIS SUITE PINS
 *   - Storage not deployed (feature_disabled) shows NOTHING; a read that failed
 *     says so with Try again — never "no suggestions".
 *   - Keep confirms and opens the new Memory; Dismiss rejects and removes it;
 *     a refusal of either is said and changes nothing on screen.
 *   - "Find memories from a trip" looks only through trips with dates, reports
 *     what it found (and how many photos could not be placed), and reloads.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
// NOTE: intentionally exhaustive — CachedImage resolves through expo-image.
jest.mock('../../../../components/CachedImage.tsx', () => ({ CachedImage: () => null }));
const mockListTrips = jest.fn();
jest.mock('../../../../services/trips.ts', () => ({
  ...jest.requireActual('../../../../services/trips.ts'),
  listMyTrips: (...a: unknown[]) => mockListTrips(...a),
}));
const mockList = jest.fn();
const mockDetect = jest.fn();
const mockConfirm = jest.fn();
const mockReject = jest.fn();
jest.mock('../memoryCandidatesApi.ts', () => ({
  ...jest.requireActual('../memoryCandidatesApi.ts'),
  listMemoryCandidates: (...a: unknown[]) => mockList(...a),
  detectMemoryCandidates: (...a: unknown[]) => mockDetect(...a),
  confirmMemoryCandidate: (...a: unknown[]) => mockConfirm(...a),
  rejectMemoryCandidate: (...a: unknown[]) => mockReject(...a),
}));

import { CandidateInbox } from '../CandidateInbox.tsx';

const C1 = { id: 'ep-1', startedAt: '2026-03-02T19:00:00.000Z', endedAt: '2026-03-02T20:30:00.000Z', city: 'Lisbon', country: 'Portugal', captureCount: 3, previewUrls: ['https://x/1.jpg'] };
const C2 = { id: 'ep-2', startedAt: '2026-03-03T14:00:00.000Z', endedAt: null, city: null, country: null, captureCount: 2, previewUrls: [] };

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  for (const m of [mockPush, mockListTrips, mockList, mockDetect, mockConfirm, mockReject]) m.mockReset();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => alertSpy.mockRestore());

const press = async (id: string) => { await act(async () => { fireEvent.press(screen.getByTestId(id)); }); };

it('storage not deployed shows nothing — there is nothing to offer, and that is not a failure', async () => {
  mockList.mockResolvedValueOnce({ ok: false, kind: 'not_deployed', message: 'Memory suggestions are not available yet.' });
  await render(<CandidateInbox />);
  await act(async () => {});
  expect(screen.queryByTestId('candidates')).toBeNull();
  expect(screen.queryByTestId('candidates-error')).toBeNull();
});

it('a failed read says so with Try again — never "no suggestions"', async () => {
  mockList.mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: 'Please try again.' });
  await render(<CandidateInbox />);
  expect(await screen.findByTestId('candidates-error')).toBeTruthy();
  expect(screen.queryByText('Memories to review')).toBeNull();
  mockList.mockResolvedValueOnce({ ok: true, candidates: [C1] });
  await press('candidates-retry');
  expect(await screen.findByTestId('candidate-ep-1')).toBeTruthy();
});

it('Keep confirms and opens the new Memory', async () => {
  mockList.mockResolvedValueOnce({ ok: true, candidates: [C1, C2] });
  mockConfirm.mockResolvedValueOnce({ ok: true, memoryId: 'mem-9' });
  await render(<CandidateInbox />);
  await screen.findByTestId('candidate-keep-ep-1');
  await press('candidate-keep-ep-1');
  expect(mockConfirm).toHaveBeenCalledWith('ep-1', null);
  expect(mockPush).toHaveBeenCalledWith('/memory/mem-9');
});

it('a refused Keep is said and nothing moves', async () => {
  mockList.mockResolvedValueOnce({ ok: true, candidates: [C1] });
  mockConfirm.mockResolvedValueOnce({ ok: false, kind: 'conflict', message: 'This suggestion has already been decided.' });
  await render(<CandidateInbox />);
  await screen.findByTestId('candidate-keep-ep-1');
  await press('candidate-keep-ep-1');
  expect(alertSpy).toHaveBeenCalledWith('Could not keep this', 'This suggestion has already been decided.');
  expect(mockPush).not.toHaveBeenCalled();
});

it('Dismiss rejects and removes the suggestion; a refused Dismiss leaves it', async () => {
  mockList.mockResolvedValueOnce({ ok: true, candidates: [C1, C2] });
  mockReject.mockResolvedValueOnce({ ok: true, state: 'rejected' });
  mockReject.mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: 'That could not be saved.' });
  await render(<CandidateInbox />);
  await screen.findByTestId('candidate-dismiss-ep-1');
  await press('candidate-dismiss-ep-1');
  expect(screen.queryByTestId('candidate-ep-1')).toBeNull();
  await press('candidate-dismiss-ep-2');
  expect(screen.getByTestId('candidate-ep-2')).toBeTruthy();
  expect(alertSpy).toHaveBeenCalledWith('Could not dismiss this', 'That could not be saved.');
});

it('Find memories looks only through dated trips, reports what it found, and reloads', async () => {
  mockList.mockResolvedValueOnce({ ok: true, candidates: [] });
  mockListTrips.mockResolvedValueOnce([
    { id: 't-1', title: 'Lisbon', startDate: '2026-03-01', endDate: '2026-03-05' },
    { id: 't-2', title: 'Someday', startDate: null, endDate: null },
  ]);
  mockDetect.mockResolvedValueOnce({ ok: true, report: { capturesRead: 6, capturesWithoutTime: 2, capturesAlreadyInMemories: 0, candidates: [{ episodeId: 'ep-1', created: true, suppressedBy: null }] } });
  mockList.mockResolvedValueOnce({ ok: true, candidates: [C1] });
  await render(<CandidateInbox />);
  await screen.findByTestId('candidates-find');
  await press('candidates-find');
  expect(await screen.findByTestId('candidates-trip-t-1')).toBeTruthy();
  expect(screen.queryByTestId('candidates-trip-t-2')).toBeNull();
  await press('candidates-trip-t-1');
  expect(mockDetect).toHaveBeenCalledWith('t-1');
  expect((await screen.findByTestId('candidates-found')).props.children).toBe('1 new suggestion from that trip. 2 photos have no capture time and could not be placed.');
  expect(await screen.findByTestId('candidate-ep-1')).toBeTruthy();
});

it('trips that could not be loaded are said, not shown as "no trips"', async () => {
  mockList.mockResolvedValueOnce({ ok: true, candidates: [] });
  mockListTrips.mockRejectedValueOnce(new Error('Your trips unavailable'));
  await render(<CandidateInbox />);
  await screen.findByTestId('candidates-find');
  await press('candidates-find');
  expect(await screen.findByTestId('candidates-trips-error')).toBeTruthy();
  expect(screen.queryByTestId('candidates-no-trips')).toBeNull();
});
