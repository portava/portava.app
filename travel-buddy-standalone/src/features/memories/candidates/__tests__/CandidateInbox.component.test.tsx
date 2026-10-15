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
 *   - H180: photos for a Memory the owner already has are a card of their own
 *     that says in plain words who will see them; Add on a Memory other people
 *     can see asks first, naming them, and echoes the audience it showed; a
 *     changed audience, a photo that could not be made private, an unreadable
 *     list and a refused dismissal are each said, never silent.
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
const mockKeepConv = jest.fn();
const mockDismissConv = jest.fn();
jest.mock('../memoryCandidatesApi.ts', () => ({
  ...jest.requireActual('../memoryCandidatesApi.ts'),
  listMemoryCandidates: (...a: unknown[]) => mockList(...a),
  detectMemoryCandidates: (...a: unknown[]) => mockDetect(...a),
  confirmMemoryCandidate: (...a: unknown[]) => mockConfirm(...a),
  rejectMemoryCandidate: (...a: unknown[]) => mockReject(...a),
  keepConvergence: (...a: unknown[]) => mockKeepConv(...a),
  dismissConvergence: (...a: unknown[]) => mockDismissConv(...a),
}));

import { CandidateInbox } from '../CandidateInbox.tsx';

const C1 = { id: 'ep-1', startedAt: '2026-03-02T19:00:00.000Z', endedAt: '2026-03-02T20:30:00.000Z', city: 'Lisbon', country: 'Portugal', captureCount: 3, previewUrls: ['https://x/1.jpg'] };
const C2 = { id: 'ep-2', startedAt: '2026-03-03T14:00:00.000Z', endedAt: null, city: null, country: null, captureCount: 2, previewUrls: [] };

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  for (const m of [mockPush, mockListTrips, mockList, mockDetect, mockConfirm, mockReject, mockKeepConv, mockDismissConv]) m.mockReset();
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

it('two taps on Keep in the same frame send ONE confirm (a ref lock, not a state closure)', async () => {
  mockList.mockResolvedValueOnce({ ok: true, candidates: [C1] });
  let resolve: (v: unknown) => void = () => {};
  mockConfirm.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  await render(<CandidateInbox />);
  await screen.findByTestId('candidate-keep-ep-1');
  await act(async () => {
    fireEvent.press(screen.getByTestId('candidate-keep-ep-1'));
    fireEvent.press(screen.getByTestId('candidate-keep-ep-1'));
  });
  expect(mockConfirm).toHaveBeenCalledTimes(1);
  await act(async () => { resolve({ ok: true, memoryId: 'mem-1' }); });
  expect(mockPush).toHaveBeenCalledWith('/memory/mem-1');
});

it('an interrupted Keep is shown as such, and Keep finishes it', async () => {
  mockList.mockResolvedValueOnce({ ok: true, candidates: [{ ...C1, state: 'interrupted' }] });
  mockConfirm.mockResolvedValueOnce({ ok: true, memoryId: 'mem-2' });
  await render(<CandidateInbox />);
  expect(await screen.findByTestId('candidate-interrupted-ep-1')).toBeTruthy();
  await press('candidate-keep-ep-1');
  expect(mockPush).toHaveBeenCalledWith('/memory/mem-2');
});

// ── H180: photos for a Memory the owner already has ─────────────────────────

const photo = (n: number, state: 'proposed' | 'interrupted' = 'proposed') => ({ assetId: `a-${n}`, previewUrl: `post-media/u/p${n}.jpg`, capturedAt: `2026-03-02T20:1${n}:00.000Z`, state });
const G = (over: Record<string, unknown> = {}) => ({
  memoryId: 'mem-1', title: 'Fado night', startsAt: '2026-03-02T19:00:00.000Z', endsAt: '2026-03-02T22:00:00.000Z',
  visibility: 'friends_only', attachAudience: 'memory', basis: 'memory_window', photos: [photo(1), photo(2)], ...over,
});
const withGroups = (...groups: unknown[]) => ({ ok: true, candidates: [], convergence: { state: 'ready', groups } });
/** The buttons of the most recent Alert, by label. */
const alertButton = (label: string) => {
  const call = alertSpy.mock.calls[alertSpy.mock.calls.length - 1] as [string, string, Array<{ text: string; onPress?: () => void }>];
  return call[2].find((b) => b.text === label)!;
};

it('H180: photos for a Memory you already have are a card of their own, saying in plain words who will see them', async () => {
  mockList.mockResolvedValueOnce(withGroups(G()));
  await render(<CandidateInbox />);
  expect(await screen.findByTestId('convergence-mem-1')).toBeTruthy();
  expect(screen.getByText('2 photos from the same time that are not in “Fado night” yet')).toBeTruthy();
  expect(screen.getByTestId('convergence-audience-mem-1').props.children).toBe('This Memory is shared with your friends, so your friends will see these photos too.');
});

it('H180: Add on a shared Memory asks first, naming who will see them — Cancel sends nothing, Add echoes the audience it showed', async () => {
  mockList.mockResolvedValueOnce(withGroups(G()));
  mockKeepConv.mockResolvedValueOnce({ ok: true, kept: [{ assetId: 'a-1', itemId: 'i-1', itemAudience: 'memory' }, { assetId: 'a-2', itemId: 'i-2', itemAudience: 'memory' }], skipped: [] });
  await render(<CandidateInbox />);
  await screen.findByTestId('convergence-add-mem-1');
  await press('convergence-add-mem-1');
  expect(alertSpy).toHaveBeenLastCalledWith('Add 2 photos?', 'This Memory is shared with your friends, so your friends will see these photos too.', expect.any(Array));
  await act(async () => { alertButton('Cancel').onPress?.(); });
  expect(mockKeepConv).not.toHaveBeenCalled();
  await press('convergence-add-mem-1');
  await act(async () => { alertButton('Add').onPress?.(); });
  expect(mockKeepConv).toHaveBeenCalledWith('mem-1', ['a-1', 'a-2'], 'friends_only');
  expect(screen.queryByTestId('convergence-mem-1')).toBeNull();
});

it('H180: Add on an only_me Memory adds without asking again, and echoes only_me', async () => {
  mockList.mockResolvedValueOnce(withGroups(G({ visibility: 'only_me' })));
  mockKeepConv.mockResolvedValueOnce({ ok: true, kept: [{ assetId: 'a-1', itemId: 'i-1', itemAudience: 'memory' }, { assetId: 'a-2', itemId: 'i-2', itemAudience: 'memory' }], skipped: [] });
  await render(<CandidateInbox />);
  expect((await screen.findByTestId('convergence-audience-mem-1')).props.children).toBe('Only you can see this Memory, so only you will see them.');
  await press('convergence-add-mem-1');
  expect(alertSpy).not.toHaveBeenCalled();
  expect(mockKeepConv).toHaveBeenCalledWith('mem-1', ['a-1', 'a-2'], 'only_me');
  expect(screen.queryByTestId('convergence-mem-1')).toBeNull();
});

it('H180: a Memory whose audience changed since it was shown is said, and the inbox reloads; nothing leaves the card', async () => {
  mockList.mockResolvedValueOnce(withGroups(G({ visibility: 'only_me' })));
  mockKeepConv.mockResolvedValueOnce({ ok: false, kind: 'conflict', message: 'Confirm who can see this Memory before adding photos to it.', reason: 'audience_unconfirmed', currentAudience: 'public' });
  mockList.mockResolvedValueOnce(withGroups(G({ visibility: 'public' })));
  await render(<CandidateInbox />);
  await screen.findByTestId('convergence-add-mem-1');
  await press('convergence-add-mem-1');
  expect(alertSpy).toHaveBeenCalledWith('Who can see this Memory changed', 'It is now shared with anyone. Check the photos again before adding them.');
  expect(mockList).toHaveBeenCalledTimes(2);
  expect((await screen.findByTestId('convergence-audience-mem-1')).props.children).toBe('This Memory is shared with anyone, so anyone will see these photos too.');
});

it('H180: where photos stay private on a shared Memory the card says so; a photo that could NOT be made private is said after adding', async () => {
  mockList.mockResolvedValueOnce(withGroups(G({ attachAudience: 'only_me' })));
  mockKeepConv.mockResolvedValueOnce({ ok: true, kept: [{ assetId: 'a-1', itemId: 'i-1', itemAudience: 'only_me' }, { assetId: 'a-2', itemId: 'i-2', itemAudience: 'memory' }], skipped: [] });
  await render(<CandidateInbox />);
  expect((await screen.findByTestId('convergence-audience-mem-1')).props.children).toBe('This Memory is shared with your friends, but only you will see these photos.');
  await press('convergence-add-mem-1');
  expect(alertSpy).toHaveBeenLastCalledWith('Add 2 photos?', 'This Memory is shared with your friends, but only you will see these photos.', expect.any(Array));
  await act(async () => { alertButton('Add').onPress?.(); });
  expect(alertSpy).toHaveBeenLastCalledWith('Not every photo is private', '1 photo was added but could not be made private, so your friends can see it, like the rest of this Memory. Open the Memory to remove it.');
});

it('H180: Not this Memory dismisses and the card leaves; a refused dismissal is said and the card stays', async () => {
  mockList.mockResolvedValueOnce(withGroups(G(), G({ memoryId: 'mem-2', title: 'Walk home' })));
  mockDismissConv.mockResolvedValueOnce({ ok: true, dismissed: ['a-1', 'a-2'] });
  mockDismissConv.mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: 'That could not be saved.' });
  await render(<CandidateInbox />);
  await screen.findByTestId('convergence-dismiss-mem-1');
  await press('convergence-dismiss-mem-1');
  expect(mockDismissConv).toHaveBeenCalledWith('mem-1', ['a-1', 'a-2']);
  expect(screen.queryByTestId('convergence-mem-1')).toBeNull();
  await press('convergence-dismiss-mem-2');
  expect(screen.getByTestId('convergence-mem-2')).toBeTruthy();
  expect(alertSpy).toHaveBeenCalledWith('Could not dismiss these photos', 'That could not be saved.');
});

it('H180: an unreadable list is said with Try again — never an empty section', async () => {
  mockList.mockResolvedValueOnce({ ok: true, candidates: [], convergence: { state: 'unavailable' } });
  await render(<CandidateInbox />);
  expect(await screen.findByTestId('convergence-error')).toBeTruthy();
});

it('H180: storage not deployed (or a server without the field) shows no card and no error', async () => {
  mockList.mockResolvedValueOnce({ ok: true, candidates: [C1], convergence: { state: 'not_deployed' } });
  await render(<CandidateInbox />);
  await screen.findByTestId('candidate-ep-1');
  expect(screen.queryByTestId('convergence-error')).toBeNull();
  expect(screen.queryByTestId('convergence-mem-1')).toBeNull();
});

it('H180: an interrupted Add is shown as such', async () => {
  mockList.mockResolvedValueOnce(withGroups(G({ visibility: 'only_me', photos: [photo(1, 'interrupted')] })));
  await render(<CandidateInbox />);
  expect(await screen.findByTestId('convergence-interrupted-mem-1')).toBeTruthy();
  expect(screen.getByText('1 photo from the same time that is not in “Fado night” yet')).toBeTruthy();
});

it('H180: Find memories says how many photos belong with Memories you already have', async () => {
  mockList.mockResolvedValueOnce({ ok: true, candidates: [], convergence: { state: 'ready', groups: [] } });
  mockListTrips.mockResolvedValueOnce([{ id: 't-1', title: 'Lisbon', startDate: '2026-03-01', endDate: '2026-03-05' }]);
  mockDetect.mockResolvedValueOnce({ ok: true, report: { capturesRead: 5, capturesWithoutTime: 0, capturesAlreadyInMemories: 1, candidates: [], convergence: { state: 'ready', capturesMatched: 2, proposalsAdded: 2, memories: 1 } } });
  mockList.mockResolvedValueOnce(withGroups(G()));
  await render(<CandidateInbox />);
  await press('candidates-find');
  await screen.findByTestId('candidates-trip-t-1');
  await press('candidates-trip-t-1');
  expect((await screen.findByTestId('candidates-found')).props.children).toBe('No new suggestions from that trip. 2 photos belong with Memories you already have — see below.');
  expect(await screen.findByTestId('convergence-mem-1')).toBeTruthy();
});
