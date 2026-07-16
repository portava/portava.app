/**
 * Confirms the file-level expo-router stub (src/__mocks__/expo-router.tsx)
 * does NOT trigger double-fetch in focus-gated components.
 *
 * The stub implements useFocusEffect with React.useEffect(cb, []).
 * That means: exactly ONE fetch per mount cycle. This test verifies:
 *   - mounting once  → service called exactly 1 time
 *   - unmount + re-mount → service called exactly 2 times total (1 per mount)
 *
 * Critically: NO local jest.mock('expo-router', ...) override is present here.
 * The file-level mock is applied via the moduleNameMapper in jest.config.js.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';
import { ReviewsSection } from '../ReviewsSection';

// ── No expo-router override — file-level mock is used ─────────────────────────

// ── Session context mock ──────────────────────────────────────────────────────

jest.mock('../../context/SessionContext', () => ({
  useSession: () => ({ isAuthed: false }),
}));

// ── Reviews service mock ──────────────────────────────────────────────────────

jest.mock('../../services/reviews', () => ({
  getTripReviews:  jest.fn(),
  getMyReview:     jest.fn(),
  getEventReviews: jest.fn().mockResolvedValue({ reviews: [] }),
  getPlaceReviews: jest.fn().mockResolvedValue({ reviews: [], total: 0, avgRating: null, page: 1 }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRIP_ID = 'stub-test-trip-1';

const EMPTY_RESPONSE = { reviews: [], total: 0, avgRating: null, page: 1 };

const REVIEW_RESPONSE = {
  reviews: [
    {
      id:        'rev-stub-1',
      rating:    5,
      body:      'Wonderful',
      tags:      [],
      anonymous: false,
      reviewer:  { id: 'u-stub', handle: 'bob', displayName: 'Bob', avatarUrl: null },
      createdAt: '2026-03-01T00:00:00Z',
      state:     'published',
    },
  ],
  total:     1,
  avgRating: 5.0,
  page:      1,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReviewsSection — file-level useFocusEffect stub (no double-fetch)', () => {
  let getTripReviews: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const reviews = require('../../services/reviews');
    getTripReviews = reviews.getTripReviews;
  });

  it('calls getTripReviews exactly once on a single mount', async () => {
    getTripReviews.mockResolvedValue(EMPTY_RESPONSE);

    const { findByText, unmount } = await render(
      <ReviewsSection entityType="trip" entityId={TRIP_ID} canReview={false} />,
    );

    // Wait for the async load to settle
    await findByText(/No reviews yet/);

    expect(getTripReviews).toHaveBeenCalledTimes(1);
    expect(getTripReviews).toHaveBeenCalledWith(TRIP_ID, 1, 5);

    unmount();
  });

  it('calls getTripReviews exactly once per mount — no double-fetch across two mount cycles', async () => {
    // First mount: no reviews
    getTripReviews.mockResolvedValueOnce(EMPTY_RESPONSE);
    // Second mount (re-focus): one review added in the meantime
    getTripReviews.mockResolvedValueOnce(REVIEW_RESPONSE);

    // ── First mount ───────────────────────────────────────────────────────────
    const { findByText: find1, unmount } = await render(
      <ReviewsSection entityType="trip" entityId={TRIP_ID} canReview={false} />,
    );

    await find1(/No reviews yet/);
    // Exactly one call after first mount
    expect(getTripReviews).toHaveBeenCalledTimes(1);

    // Simulate navigating away
    unmount();

    // ── Second mount (simulates screen re-focus) ──────────────────────────────
    const { findByText: find2 } = await render(
      <ReviewsSection entityType="trip" entityId={TRIP_ID} canReview={false} />,
    );

    await find2('5.0 (1)');
    // One additional call on re-mount — total is 2, not 3 or more
    expect(getTripReviews).toHaveBeenCalledTimes(2);
  });
});

// ── Place entity type ─────────────────────────────────────────────────────────

describe('ReviewsSection — file-level useFocusEffect stub (place entity type)', () => {
  let getPlaceReviews: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const reviews = require('../../services/reviews');
    getPlaceReviews = reviews.getPlaceReviews;
  });

  it('calls getPlaceReviews exactly once on a single mount', async () => {
    getPlaceReviews.mockResolvedValueOnce(EMPTY_RESPONSE);

    const { findByText, unmount } = await render(
      <ReviewsSection entityType="place" entityId="stub-place-1" canReview={false} />,
    );

    await findByText(/No reviews yet/);

    expect(getPlaceReviews).toHaveBeenCalledTimes(1);
    expect(getPlaceReviews).toHaveBeenCalledWith('stub-place-1', 1, 5);

    unmount();
  });

  it('calls getPlaceReviews exactly once per mount — no double-fetch across two mount cycles', async () => {
    // First mount: no reviews
    getPlaceReviews.mockResolvedValueOnce(EMPTY_RESPONSE);
    // Second mount (re-focus): one review added in the meantime
    getPlaceReviews.mockResolvedValueOnce(REVIEW_RESPONSE);

    // ── First mount ───────────────────────────────────────────────────────────
    const { findByText: find1, unmount } = await render(
      <ReviewsSection entityType="place" entityId="stub-place-1" canReview={false} />,
    );

    await find1(/No reviews yet/);
    // Exactly one call after first mount
    expect(getPlaceReviews).toHaveBeenCalledTimes(1);

    // Simulate navigating away
    unmount();

    // ── Second mount (simulates screen re-focus) ──────────────────────────────
    const { findByText: find2 } = await render(
      <ReviewsSection entityType="place" entityId="stub-place-1" canReview={false} />,
    );

    await find2('5.0 (1)');
    // One additional call on re-mount — total is 2, not 3 or more
    expect(getPlaceReviews).toHaveBeenCalledTimes(2);
  });
});

// ── Event entity type ─────────────────────────────────────────────────────────

const EVENT_EMPTY_RESPONSE = { reviews: [] };

const EVENT_REVIEW_RESPONSE = {
  reviews: [
    {
      id:        'rev-event-1',
      rating:    5,
      body:      'Great event',
      tags:      [],
      anonymous: false,
      reviewer:  { id: 'u-stub', handle: 'alice', displayName: 'Alice', avatarUrl: null },
      createdAt: '2026-04-01T00:00:00Z',
      state:     'published',
    },
  ],
};

describe('ReviewsSection — file-level useFocusEffect stub (event entity type)', () => {
  let getEventReviews: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const reviews = require('../../services/reviews');
    getEventReviews = reviews.getEventReviews;
  });

  it('calls getEventReviews exactly once on a single mount', async () => {
    getEventReviews.mockResolvedValueOnce(EVENT_EMPTY_RESPONSE);

    const { findByText, unmount } = await render(
      <ReviewsSection entityType="event" entityId="stub-event-1" canReview={false} />,
    );

    await findByText(/No reviews yet/);

    expect(getEventReviews).toHaveBeenCalledTimes(1);
    expect(getEventReviews).toHaveBeenCalledWith('stub-event-1', 1, 5);

    unmount();
  });

  it('calls getEventReviews exactly once per mount — no double-fetch across two mount cycles', async () => {
    // First mount: no reviews
    getEventReviews.mockResolvedValueOnce(EVENT_EMPTY_RESPONSE);
    // Second mount (re-focus): one review added in the meantime
    getEventReviews.mockResolvedValueOnce(EVENT_REVIEW_RESPONSE);

    // ── First mount ───────────────────────────────────────────────────────────
    const { findByText: find1, unmount } = await render(
      <ReviewsSection entityType="event" entityId="stub-event-1" canReview={false} />,
    );

    await find1(/No reviews yet/);
    // Exactly one call after first mount
    expect(getEventReviews).toHaveBeenCalledTimes(1);

    // Simulate navigating away
    unmount();

    // ── Second mount (simulates screen re-focus) ──────────────────────────────
    const { findByText: find2 } = await render(
      <ReviewsSection entityType="event" entityId="stub-event-1" canReview={false} />,
    );

    await find2('5.0 (1)');
    // One additional call on re-mount — total is 2, not 3 or more
    expect(getEventReviews).toHaveBeenCalledTimes(2);
  });
});
