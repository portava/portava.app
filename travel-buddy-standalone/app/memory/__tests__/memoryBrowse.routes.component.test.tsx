/**
 * HM-F11 / HM-F13 browse routes: /memory/timeline, /memory/place-history,
 * /memory/people-history, /memory/saved.
 *
 * Each reads its own route and shows three honest states. The one that
 * matters most: a projection the server could NOT build is an error with a
 * retry, never "No memories yet" (DV-83).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: (...a: unknown[]) => mockPush(...a) },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockTimeline = jest.fn();
const mockPlace = jest.fn();
const mockPeople = jest.fn();
const mockSaved = jest.fn();
jest.mock('../../../src/services/memorySocial.ts', () => ({
  ...jest.requireActual('../../../src/services/memorySocial.ts'),
  getMemoryTimeline: (...a: unknown[]) => mockTimeline(...a),
  getMemoryPlaceHistory: (...a: unknown[]) => mockPlace(...a),
  getMemoryPeopleHistory: (...a: unknown[]) => mockPeople(...a),
  getSavedMemories: (...a: unknown[]) => mockSaved(...a),
}));

import TimelineRoute from '../timeline.tsx';
import PlaceHistoryRoute from '../place-history.tsx';
import PeopleHistoryRoute from '../people-history.tsx';
import SavedRoute from '../saved.tsx';

const M1 = '33333333-3333-4333-8333-000000000001';
const PLACE = '66666666-6666-4666-8666-666666666666';
const PERSON = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  mockPush.mockReset(); mockTimeline.mockReset(); mockPlace.mockReset(); mockPeople.mockReset(); mockSaved.mockReset();
  mockParams = {};
});

describe('/memory/timeline', () => {
  it('lists the owner timeline and opens a memory', async () => {
    mockTimeline.mockResolvedValue({ ok: true, truncated: false, rows: [{ memory_id: M1, occurred_at: '2026-09-01T00:00:00Z', title: 'Hoi An', location_city: 'Hoi An', location_country: 'Vietnam', media_count: 3, people: ['x'] }] });
    await render(<TimelineRoute />);
    expect(await screen.findByText('Hoi An')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId(`memory-row-${M1}`)); });
    expect(mockPush).toHaveBeenCalledWith(`/memory/${M1}`);
  });

  it('an unbuildable timeline is an error with a retry — never "No memories yet"', async () => {
    mockTimeline.mockResolvedValueOnce({ ok: false, kind: 'degraded_unavailable', message: 'We could not build your timeline. Please try again.' });
    await render(<TimelineRoute />);
    expect(await screen.findByText('We could not build your timeline. Please try again.')).toBeTruthy();
    expect(screen.queryByTestId('memory-rows-empty')).toBeNull();
    mockTimeline.mockResolvedValueOnce({ ok: true, truncated: false, rows: [] });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-rows-retry')); });
    expect(await screen.findByTestId('memory-rows-empty')).toBeTruthy();
    expect(mockTimeline).toHaveBeenCalledTimes(2);
  });

  it('a truncated timeline says so', async () => {
    mockTimeline.mockResolvedValue({ ok: true, truncated: true, rows: [{ memory_id: M1, occurred_at: '2026-09-01T00:00:00Z', title: 'Hoi An', location_city: null, location_country: null }] });
    await render(<TimelineRoute />);
    expect(await screen.findByText('Showing the most recent part of this list.')).toBeTruthy();
  });
});

describe('/memory/place-history', () => {
  it('asks for the place it was given', async () => {
    mockParams = { placeId: PLACE, label: 'Hoi An' };
    mockPlace.mockResolvedValue({ ok: true, truncated: false, rows: [{ memory_id: M1, occurred_at: '2026-09-01T00:00:00Z', title: 'First time', location_city: 'Hoi An', location_country: null, visit_index: 1 }] });
    await render(<PlaceHistoryRoute />);
    expect(await screen.findByText('First time')).toBeTruthy();
    expect(mockPlace).toHaveBeenCalledWith(PLACE);
    expect(screen.getByText('Your history at Hoi An')).toBeTruthy();
  });
});

describe('/memory/people-history', () => {
  it('a blocked or unshared person reads as "no shared history", not as an empty success', async () => {
    mockParams = { personId: PERSON, name: 'Bea' };
    mockPeople.mockResolvedValue({ ok: false, kind: 'not_found', message: 'No shared history' });
    await render(<PeopleHistoryRoute />);
    expect(await screen.findByText('There is no shared history with this person.')).toBeTruthy();
    expect(mockPeople).toHaveBeenCalledWith(PERSON);
  });
});

describe('/memory/saved', () => {
  it('lists the saved shelf', async () => {
    mockSaved.mockResolvedValue({ ok: true, truncated: false, memories: [{ id: M1, title: 'Lisbon light', locationCity: 'Lisbon', locationCountry: 'Portugal', createdAt: '2026-09-01T00:00:00Z', startsAt: null, owner: { id: 'o', name: 'Olive', handle: 'olive', avatarUrl: null } }] });
    await render(<SavedRoute />);
    expect(await screen.findByText('Lisbon light')).toBeTruthy();
  });

  it('an empty shelf is empty; an unreadable one is an error', async () => {
    mockSaved.mockResolvedValueOnce({ ok: true, truncated: false, memories: [] });
    await render(<SavedRoute />);
    expect(await screen.findByText('Nothing saved yet')).toBeTruthy();
  });

  it('an unreadable shelf is an error', async () => {
    mockSaved.mockResolvedValueOnce({ ok: false, kind: 'degraded_unavailable', message: 'We could not load your saved memories. Please try again.' });
    await render(<SavedRoute />);
    expect(await screen.findByTestId('memory-rows-error')).toBeTruthy();
    expect(screen.queryByText('Nothing saved yet')).toBeNull();
  });
});

// PHOTOS-CLIENT (2026-10-14; found by lane NARR-PHOTOS): `media_count` counts EVERY memory_items row of the
// Memory, photos and videos alike (projectionRegistry `mediaCount`), and the timeline projection carries no
// per-kind count. So the row says "items": it never calls a video a photo, and never guesses a kind it was
// not sent. Each case below that names a kind was "N photo(s)" on main.
describe('/memory/timeline — the media count says only what the projection knows', () => {
  const showRow = async (media_count: number | null | undefined) => {
    mockTimeline.mockResolvedValue({ ok: true, truncated: false, rows: [{ memory_id: M1, occurred_at: '2026-09-01T00:00:00Z', title: 'Hoi An', location_city: null, location_country: null, media_count, people: [] }] });
    await render(<TimelineRoute />);
    await screen.findByText('Hoi An');
  };
  const metaText = (re: RegExp) => String([screen.getByText(re).props.children].flat().join(''));

  it('a Memory of 3 photos and 1 video (media_count 4) says "4 items", not "4 photos"', async () => {
    await showRow(4);
    expect(metaText(/· 4 items$/)).not.toMatch(/photo|video/);
    expect(screen.queryByText(/4 photos/)).toBeNull();
  });

  it('a Memory of 2 videos says "2 items", never "2 photos"', async () => {
    await showRow(2);
    expect(metaText(/· 2 items$/)).not.toMatch(/photo|video/);
    expect(screen.queryByText(/2 photos/)).toBeNull();
  });

  it('a Memory of 3 photos also says "3 items": with no kinds on the wire the screen does not guess "photos"', async () => {
    await showRow(3);
    expect(metaText(/· 3 items$/)).not.toMatch(/photo/);
  });

  it('one item of a kind nobody sent is "1 item" (singular)', async () => {
    await showRow(1);
    expect(metaText(/· 1 item$/)).not.toMatch(/items|photo|video/);
  });

  it('no items, or no count at all, prints no count', async () => {
    await showRow(0);
    expect(screen.queryByText(/\bitems?\b/)).toBeNull();
    await showRow(null);
    expect(screen.queryByText(/\bitems?\b/)).toBeNull();
  });
});
