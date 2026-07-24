/**
 * PlaceReportSheet — component tests
 *
 * Covers:
 *  1. Tapping a category + submit calls submitModerationReport with
 *     subjectType: 'place' and the correct subjectId.
 *  2. API error still shows step-3 confirmation (fail-soft — never crashes).
 *
 * ## Act strategy
 * All fireEvent calls are bare. waitFor used between step transitions.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { PlaceReportSheet } from '../PlaceReportSheet.tsx';
import { submitModerationReport } from '../../services/moderation.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — moderation.ts imports Supabase which is
// unsafe under jest-expo.
jest.mock('../../services/moderation.ts', () => ({
  ...jest.requireActual('../../services/moderation.ts'),
  submitModerationReport: jest.fn(),
}));

// NOTE: intentionally exhaustive — KeyboardAvoidingView internals not needed.
jest.mock('../ui/KeyboardSafeView.tsx', () => ({
  KeyboardSafeScrollView: ({ children, style }: any) => {
    const { View } = require('react-native');
    return <View style={style}>{children}</View>;
  },
}));

// ── Typed mock refs ───────────────────────────────────────────────────────────

const mockSubmitReport = submitModerationReport as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

const deferred = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 0));

const PLACE_ID = 'place-xyz-99';

/**
 * Drives the sheet through step 1 → step 2 (submit) and resolves after
 * the submit call fires.
 */
async function renderAndSubmit(opts?: { submitResult?: object }) {
  const submitResult = opts?.submitResult ?? { ok: true, reportId: 'r-1' };
  mockSubmitReport.mockImplementation(() => deferred(submitResult));

  const utils = await render(
    <PlaceReportSheet
      visible
      onClose={jest.fn()}
      placeId={PLACE_ID}
      placeName="Test Café"
    />,
  );

  // Step 1 — pick a category
  fireEvent.press(utils.getByTestId('place-report-cat-wrong_place'));

  // Advance to step 2
  await waitFor(() =>
    expect(utils.getByTestId('place-report-sheet-next').props.accessibilityState?.disabled).toBeFalsy(),
  );
  fireEvent.press(utils.getByTestId('place-report-sheet-next'));

  // Wait for step 2 to render
  await utils.findByTestId('place-report-sheet-submit');

  // Submit
  fireEvent.press(utils.getByTestId('place-report-sheet-submit'));

  return utils;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceReportSheet — submit calls moderation service correctly', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('calls submitModerationReport with subjectType: "place" and the correct subjectId', async () => {
    await renderAndSubmit();

    await waitFor(() => {
      expect(mockSubmitReport).toHaveBeenCalledTimes(1);
      expect(mockSubmitReport).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: 'place',
          subjectId:   PLACE_ID,
        }),
      );
    });
  });

  it('passes the selected category to submitModerationReport', async () => {
    await renderAndSubmit();

    await waitFor(() => {
      expect(mockSubmitReport).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'wrong_place' }),
      );
    });
  });

  it('shows step-3 confirmation after a successful submit', async () => {
    const utils = await renderAndSubmit({ submitResult: { ok: true } });
    await utils.findByTestId('place-report-sheet-done-close');
    expect(utils.getByTestId('place-report-sheet-done-btn')).toBeTruthy();
  });
});

describe('PlaceReportSheet — API error shows confirmation (fail-soft)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows step-3 confirmation even when the API returns ok:false — never crashes', async () => {
    const utils = await renderAndSubmit({
      submitResult: { ok: false, error: 'Subject type not supported' },
    });

    // Should still land on step 3 regardless of API error
    await utils.findByTestId('place-report-sheet-done-close');
    expect(utils.getByTestId('place-report-sheet-done-btn')).toBeTruthy();
  });

  it('shows step-3 confirmation even when submitModerationReport throws', async () => {
    mockSubmitReport.mockImplementation(() =>
      deferred(null).then(() => { throw new Error('Network error'); }),
    );

    const utils = await render(
      <PlaceReportSheet
        visible
        onClose={jest.fn()}
        placeId={PLACE_ID}
      />,
    );

    // Step 1 — pick category and wait for button to enable
    fireEvent.press(utils.getByTestId('place-report-cat-closed'));
    await waitFor(() =>
      expect(utils.getByTestId('place-report-sheet-next').props.accessibilityState?.disabled).toBeFalsy(),
    );
    fireEvent.press(utils.getByTestId('place-report-sheet-next'));
    await utils.findByTestId('place-report-sheet-submit');

    // Submit — the service throws
    fireEvent.press(utils.getByTestId('place-report-sheet-submit'));

    // Should still reach step 3
    await utils.findByTestId('place-report-sheet-done-close');
    expect(utils.getByTestId('place-report-sheet-done-btn')).toBeTruthy();
  });
});
