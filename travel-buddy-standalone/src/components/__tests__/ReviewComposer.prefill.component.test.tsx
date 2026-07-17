/**
 * Component tests for ReviewComposerScreen — pre-fill / edit-mode behaviour.
 *
 * Covers:
 *  • New review mode: title "Leave a Review", button "Submit Review"
 *  • Edit mode when getMyReview returns an existing review:
 *    - Title changes to "Edit Your Review"
 *    - Edit-note banner is shown
 *    - Star rating hint reflects the pre-filled rating (e.g. "Great" for 4★)
 *    - Body TextInput is pre-filled with the previous review body
 *    - Tag chip for a pre-filled tag is already selected (toggling it off and
 *      adding another, then submitting, proves the pre-fill was applied)
 *    - "Update Review" submit button label (not "Submit Review")
 *  • entityLabel: "Place" is shown for entityType=place
 *  • event entityType: getMyReview is NOT called (legacy composite path)
 *
 * Run with:  pnpm test:component
 *
 * RNTL v14: render() and fireEvent are async — always await them.
 * expo-router's useLocalSearchParams is mocked per test to inject entity params.
 */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import ReviewComposerScreen from '../../../app/review/[entityType]/[entityId].tsx';

// AsyncStorage is mapped to the official jest mock globally via
// moduleNameMapper in jest.config.js — no per-file mock needed.

// ── Safe-area mock ────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── expo-router mock ──────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('expo-router', () => ({
  router:               { back: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));

// ── Session context mock ──────────────────────────────────────────────────────

jest.mock('../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../context/SessionContext.tsx'),
  useSession: () => ({ isAuthed: true }),
}));

// ── Reviews service mock ──────────────────────────────────────────────────────

jest.mock('../../services/reviews.ts', () => ({
  ...jest.requireActual('../../services/reviews.ts'),
  getMyReview:       jest.fn(),
  createReview:      jest.fn().mockResolvedValue({}),
  updateReview:      jest.fn().mockResolvedValue({}),
  createEventReview: jest.fn().mockResolvedValue({}),
  REVIEW_TAGS: [
    { value: 'safe',         label: 'Safe' },
    { value: 'friendly',     label: 'Friendly' },
    { value: 'on_time',      label: 'On Time' },
    { value: 'great_host',   label: 'Great Host' },
    { value: 'well_planned', label: 'Well Planned' },
  ],
}));

// ── Typed refs ────────────────────────────────────────────────────────────────

import { useLocalSearchParams } from 'expo-router';
import { getMyReview, updateReview } from '../../services/reviews.ts';

const mockUseLocalSearchParams = useLocalSearchParams as jest.Mock;
const mockGetMyReview          = getMyReview          as jest.Mock;
const mockUpdateReview         = updateReview         as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupParams(
  entityType: string,
  entityId: string,
  entityName = 'Secret Waterfall',
) {
  mockUseLocalSearchParams.mockReturnValue({ entityType, entityId, entityName });
}

async function mountComposer() {
  return render(<ReviewComposerScreen />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMyReview.mockResolvedValue({ exists: false });
});

describe('ReviewComposerScreen — new review mode', () => {
  it('shows "Leave a Review" title when user has no prior review', async () => {
    setupParams('place', 'gem-123');

    const { findByText } = await mountComposer();

    await findByText('Leave a Review');
  });

  it('shows "Submit Review" button in new-review mode', async () => {
    setupParams('place', 'gem-123');

    const { findByText } = await mountComposer();

    await findByText('Submit Review');
  });

  it('renders the entity label "Place" for entityType=place', async () => {
    setupParams('place', 'gem-123', 'Eiffel Tower');

    const { findByText } = await mountComposer();

    await findByText(/Place: Eiffel Tower/);
  });

  it('renders the entity label "Trip" for entityType=trip', async () => {
    setupParams('trip', 'trip-456', 'Paris 2026');

    const { findByText } = await mountComposer();

    await findByText(/Trip: Paris 2026/);
  });
});

describe('ReviewComposerScreen — edit mode (pre-fill from prior submission)', () => {
  beforeEach(() => {
    setupParams('place', 'gem-123', 'Secret Waterfall');
    mockGetMyReview.mockResolvedValue({
      exists:    true,
      reviewId:  'rev-existing-1',
      rating:    4,
      body:      'Amazing hidden gem!',
      tags:      ['great_host'],
      anonymous: false,
    });
  });

  it('shows "Edit Your Review" title after prior review is loaded', async () => {
    const { findByText } = await mountComposer();

    await findByText('Edit Your Review');
  });

  it('shows the edit-note banner so the user knows fields are pre-filled', async () => {
    const { findByText } = await mountComposer();

    await findByText(/your previous rating and comments are pre-filled/i);
  });

  it('shows "Update Review" submit button in edit mode', async () => {
    const { findByText } = await mountComposer();

    await findByText('Update Review');
  });

  it('pre-fills the star rating — hint text "Great" is visible for a 4★ review', async () => {
    const { findByText } = await mountComposer();

    await findByText('Great');
  });

  it('pre-fills the body — TextInput displays the previous review text', async () => {
    const { findByDisplayValue } = await mountComposer();

    await waitFor(() => findByDisplayValue('Amazing hidden gem!'));
  });

  it('pre-fills the tag — toggling it off and submitting proves the prior value was applied', async () => {
    const { findByText, getByText } = await mountComposer();

    await findByText('Update Review');

    // 'Great Host' chip was pre-selected; awaiting press toggles it OFF
    await fireEvent.press(getByText('Great Host'));

    // Press 'Friendly' chip to add it — await ensures state settles
    await fireEvent.press(getByText('Friendly'));

    // Submit the form
    await act(async () => {
      await fireEvent.press(getByText('Update Review'));
    });

    await waitFor(() => {
      expect(mockUpdateReview).toHaveBeenCalledWith(
        'rev-existing-1',
        expect.objectContaining({ tags: ['friendly'] }),
      );
    });
  });
});

describe('ReviewComposerScreen — event entity type', () => {
  it('does not call getMyReview for event entity (legacy path skips the check)', async () => {
    setupParams('event', 'evt-789', 'City Tour');

    const { findByText } = await mountComposer();

    await findByText('Leave a Review');
    expect(mockGetMyReview).not.toHaveBeenCalled();
  });
});
