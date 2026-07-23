/**
 * ReportSheet — block/unblock CTA behaviour on the step-3 confirmation screen.
 *
 * Covers:
 *  1. blockUser() is called with the correct subjectUserId when "Also block" is pressed.
 *  2. An Alert is shown when blockUser() rejects — the error is surfaced, not silently dropped.
 *  3. "Unblock" label appears when BlockedIdsContext already contains the subjectUserId.
 *  4. Block CTA is absent (and blockUser not called) when subjectUserId is omitted.
 *
 * ## Act strategy
 * All fireEvent calls are bare (no act() wrapper).  Bare fireEvent + waitFor
 * avoids React 19 overlapping-act() warnings (see TESTING.md §2).
 * waitFor is used between step transitions to let React 19 batch commits land.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { ReportSheet } from '../ReportSheet.tsx';
import { blockUser } from '../../services/blocks.ts';
import { submitModerationReport } from '../../services/moderation.ts';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — the real module imports native Supabase
// bindings and SessionContext that are unsafe under jest-expo.
jest.mock('../../context/BlockedIdsContext.tsx', () => ({
  useBlockedIds: jest.fn(),
}));

jest.mock('../../services/moderation.ts', () => ({
  ...jest.requireActual('../../services/moderation.ts'),
  submitModerationReport: jest.fn(),
}));

jest.mock('../../services/blocks.ts', () => ({
  ...jest.requireActual('../../services/blocks.ts'),
  blockUser:   jest.fn(),
  unblockUser: jest.fn(),
}));

// NOTE: intentionally exhaustive — KeyboardAvoidingView internals are not
// needed under jest; a transparent passthrough wrapper is sufficient.
jest.mock('../ui/KeyboardSafeView.tsx', () => ({
  KeyboardSafeScrollView: ({ children, style }: any) => {
    const { View } = require('react-native');
    return <View style={style}>{children}</View>;
  },
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

const mockUseBlockedIds = useBlockedIds          as jest.Mock;
const mockBlockUser     = blockUser              as jest.Mock;
const mockSubmitReport  = submitModerationReport as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Resolves on the next macrotask so async continuations fire outside the current act() scope. */
const deferred = <T>(value: T): Promise<T> =>
  new Promise(resolve => setTimeout(() => resolve(value), 0));

const SUBJECT_USER_ID = 'user-target-42';

function makeBlockedCtx(preBlocked: Set<string> = new Set()) {
  return {
    blockedIds:  preBlocked,
    blockerIds:  new Set<string>(),
    isLoading:   false,
    addBlock:    jest.fn(),
    removeBlock: jest.fn(),
    refresh:     jest.fn() as () => Promise<void>,
  };
}

/**
 * Renders ReportSheet, drives the 3-step flow to completion (submit succeeds),
 * and returns the testing utilities together with the mocked context object.
 */
async function renderAndReachStep3(opts: {
  preBlocked?:  Set<string>;
  subjectName?: string;
} = {}) {
  const ctx = makeBlockedCtx(opts.preBlocked);
  mockUseBlockedIds.mockReturnValue(ctx);
  mockSubmitReport.mockImplementation(() => deferred({ ok: true }));

  const utils = await render(
    <ReportSheet
      visible
      onClose={jest.fn()}
      subjectType="user"
      subjectId="obj-1"
      subjectUserId={SUBJECT_USER_ID}
      subjectName={opts.subjectName ?? 'Alice'}
    />,
  );

  // Step 1 — select a category; waitFor lets the React 19 batch commit
  fireEvent.press(utils.getByTestId('report-cat-harassment'));
  await waitFor(() =>
    expect(
      utils.getByTestId('report-sheet-next').props.accessibilityState?.disabled,
    ).toBeFalsy(),
  );

  // Advance to step 2
  fireEvent.press(utils.getByTestId('report-sheet-next'));
  await utils.findByTestId('report-sheet-submit');

  // Step 2 — submit the report (async via deferred)
  fireEvent.press(utils.getByTestId('report-sheet-submit'));

  // Wait until step 3 is rendered
  await utils.findByTestId('report-sheet-done-close');

  return { ...utils, ctx };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ReportSheet — step-3 block CTA', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('calls blockUser with the correct subjectUserId when "Also block" is pressed', async () => {
    mockBlockUser.mockImplementation(() => deferred({ ok: true }));

    const { getByTestId, ctx } = await renderAndReachStep3();

    expect(getByTestId('report-sheet-block-cta')).toBeTruthy();

    // Bare press — async handler; waitFor flushes the chain
    fireEvent.press(getByTestId('report-sheet-block-cta'));

    await waitFor(() => {
      expect(mockBlockUser).toHaveBeenCalledTimes(1);
      expect(mockBlockUser).toHaveBeenCalledWith(SUBJECT_USER_ID);
    });

    // addBlock must be called on success so the context updates immediately
    await waitFor(() => {
      expect(ctx.addBlock).toHaveBeenCalledWith(SUBJECT_USER_ID);
    });
  });

  it('surfaces an Alert when blockUser() rejects — error is not silently dropped', async () => {
    mockBlockUser.mockImplementation(() =>
      deferred({ ok: false, error: 'Block service unavailable' }),
    );

    const { getByTestId } = await renderAndReachStep3();

    fireEvent.press(getByTestId('report-sheet-block-cta'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledWith('Error', 'Block service unavailable');
    });
  });

  it('falls back to the default error message when blockUser() provides no error string', async () => {
    mockBlockUser.mockImplementation(() => deferred({ ok: false }));

    const { getByTestId } = await renderAndReachStep3();

    fireEvent.press(getByTestId('report-sheet-block-cta'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Error', 'Could not block user');
    });
  });

  it('shows "Unblock" label when BlockedIdsContext already contains the subjectUserId', async () => {
    const { getByTestId, getByText } = await renderAndReachStep3({
      preBlocked:  new Set([SUBJECT_USER_ID]),
      subjectName: 'Alice',
    });

    expect(getByTestId('report-sheet-block-cta')).toBeTruthy();

    // The CTA label should read "Unblock Alice" (not "Also block Alice")
    expect(getByText('Unblock Alice')).toBeTruthy();
  });

  it('does not render the block CTA and never calls blockUser when subjectUserId is absent', async () => {
    const ctx = makeBlockedCtx();
    mockUseBlockedIds.mockReturnValue(ctx);
    mockSubmitReport.mockImplementation(() => deferred({ ok: true }));
    mockBlockUser.mockImplementation(() => deferred({ ok: true }));

    const { getByTestId, findByTestId, queryByTestId } = await render(
      <ReportSheet
        visible
        onClose={jest.fn()}
        subjectType="post"
        subjectId="post-99"
        // subjectUserId intentionally omitted
      />,
    );

    // Step 1
    fireEvent.press(getByTestId('report-cat-harassment'));
    await waitFor(() =>
      expect(
        getByTestId('report-sheet-next').props.accessibilityState?.disabled,
      ).toBeFalsy(),
    );
    fireEvent.press(getByTestId('report-sheet-next'));
    await findByTestId('report-sheet-submit');

    // Step 2
    fireEvent.press(getByTestId('report-sheet-submit'));
    await findByTestId('report-sheet-done-close');

    // Block CTA must be absent; blockUser must never be called
    expect(queryByTestId('report-sheet-block-cta')).toBeNull();
    expect(mockBlockUser).not.toHaveBeenCalled();
  });
});
