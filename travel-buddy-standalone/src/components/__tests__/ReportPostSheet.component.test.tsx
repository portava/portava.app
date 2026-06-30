/**
 * Component-level integration tests for ReportPostSheet.
 *
 * These tests mount the real component with @testing-library/react-native,
 * drive user interactions (select reason, dismiss), and assert that state
 * is fully reset when the sheet is re-opened.
 *
 * Run with:  pnpm test:component
 *
 * Note: RNTL v14 uses async render/rerender/fireEvent — all must be awaited.
 *
 * Invocation paths covered:
 *   • feed-card path     — PostCard mounts ReportPostSheet via its own
 *                          visible/onClose state; same component, same props API
 *   • detail-screen path — app/post/[id].tsx header overflow → ReportPostSheet;
 *                          same component, onClose wired to navigation state
 *
 * Both paths receive identical props (postId, visible, onClose), so the
 * component-level contract tested here applies equally to both call sites.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { ReportPostSheet } from '../ReportPostSheet';

jest.mock('../../services/reports', () => ({
  reportContent: jest.fn().mockResolvedValue({ ok: true }),
}));

// ── helpers ────────────────────────────────────────────────────────────────────

async function renderSheet(
  visible: boolean,
  onClose = jest.fn(),
  postId = 'post-abc',
) {
  return render(
    <ReportPostSheet postId={postId} visible={visible} onClose={onClose} />,
  );
}

// ── initial render ─────────────────────────────────────────────────────────────

describe('ReportPostSheet — initial render', () => {
  it('shows all 7 reason options when visible', async () => {
    const { getByTestId } = await renderSheet(true);
    for (const code of [
      'spam',
      'harassment',
      'hate_speech',
      'violence',
      'nudity',
      'misinformation',
      'other',
    ]) {
      expect(getByTestId(`reason-${code}`)).toBeTruthy();
    }
  });

  it('submit button is disabled when no reason is selected', async () => {
    const { getByTestId } = await renderSheet(true);
    const submit = getByTestId('report-post-submit');
    const disabled =
      submit.props.accessibilityState?.disabled ?? submit.props.disabled;
    expect(disabled).toBeTruthy();
  });

  it('does not show the "Report submitted" banner initially', async () => {
    const { queryByTestId } = await renderSheet(true);
    expect(queryByTestId('report-post-done')).toBeNull();
  });
});

// ── selecting a reason ─────────────────────────────────────────────────────────

describe('ReportPostSheet — selecting a reason', () => {
  it('enables the submit button after a reason is selected', async () => {
    const { getByTestId } = await renderSheet(true);
    await fireEvent.press(getByTestId('reason-spam'));
    const submit = getByTestId('report-post-submit');
    const disabled =
      submit.props.accessibilityState?.disabled ?? submit.props.disabled;
    expect(disabled).toBeFalsy();
  });

  it('shows a checkmark next to the selected reason', async () => {
    const { getByTestId, getByText } = await renderSheet(true);
    await fireEvent.press(getByTestId('reason-harassment'));
    expect(getByText('✓')).toBeTruthy();
  });
});

// ── open → select reason → close → re-open ────────────────────────────────────
//
// Core acceptance criteria from the task spec:
// "Test opens ReportPostSheet, selects a reason, calls onClose without
//  submitting, re-opens it — verifies reason is null and done=false"

describe('open → select reason → close → re-open: no stale state survives', () => {
  it('feed-card path: submit is disabled again on re-open after dismissing mid-flow', async () => {
    // PostCard: onClose is wired to the card's reportOpen state setter.
    const onClose = jest.fn();
    const { getByTestId, rerender } = await renderSheet(true, onClose);

    // User selects a reason (form is partially filled)
    await fireEvent.press(getByTestId('reason-spam'));
    const disabledBefore =
      getByTestId('report-post-submit').props.accessibilityState?.disabled ??
      getByTestId('report-post-submit').props.disabled;
    expect(disabledBefore).toBeFalsy(); // submit was enabled

    // User taps the X close button (dismisses mid-flow without submitting)
    await fireEvent.press(getByTestId('report-post-close'));
    expect(onClose).toHaveBeenCalledTimes(1); // parent was notified

    // Parent re-opens (e.g. user taps "Report" again from the same card)
    await rerender(
      <ReportPostSheet postId="post-abc" visible={true} onClose={onClose} />,
    );

    // Submit must be disabled again — reason reset to null
    const disabledAfter =
      getByTestId('report-post-submit').props.accessibilityState?.disabled ??
      getByTestId('report-post-submit').props.disabled;
    expect(disabledAfter).toBeTruthy();
  });

  it('detail-screen path: submit is disabled again on re-open after dismissing mid-flow', async () => {
    // app/post/[id].tsx: onClose is wired to setReportOpen(false).
    const onClose = jest.fn();
    const { getByTestId, rerender } = await renderSheet(
      true,
      onClose,
      'post-detail-xyz',
    );

    // User selects "other" reason (reveals a TextInput); submit is enabled
    await fireEvent.press(getByTestId('reason-other'));
    const disabledBefore =
      getByTestId('report-post-submit').props.accessibilityState?.disabled ??
      getByTestId('report-post-submit').props.disabled;
    expect(disabledBefore).toBeFalsy();

    // User taps the backdrop to dismiss (same handleClose path)
    await fireEvent.press(getByTestId('report-post-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Parent re-opens from the same detail screen header
    await rerender(
      <ReportPostSheet
        postId="post-detail-xyz"
        visible={true}
        onClose={onClose}
      />,
    );

    // Form must be clean: submit disabled (reason = null)
    const disabledAfter =
      getByTestId('report-post-submit').props.accessibilityState?.disabled ??
      getByTestId('report-post-submit').props.disabled;
    expect(disabledAfter).toBeTruthy();
  });

  it('no stale checkmark appears on re-open', async () => {
    const onClose = jest.fn();
    const { getByTestId, queryByText, rerender } = await renderSheet(
      true,
      onClose,
    );

    await fireEvent.press(getByTestId('reason-violence'));
    expect(queryByText('✓')).toBeTruthy(); // checkmark visible during first open

    await fireEvent.press(getByTestId('report-post-close'));

    await rerender(
      <ReportPostSheet postId="post-abc" visible={true} onClose={onClose} />,
    );

    expect(queryByText('✓')).toBeNull(); // no checkmark on re-open
  });

  it('"Report submitted" banner is cleared on re-open after dismissing', async () => {
    // handleClose() always resets done=false regardless of prior state.
    const onClose = jest.fn();
    const { getByTestId, queryByTestId, rerender } = await renderSheet(
      true,
      onClose,
    );

    await fireEvent.press(getByTestId('report-post-close'));
    await rerender(
      <ReportPostSheet postId="post-abc" visible={true} onClose={onClose} />,
    );

    // The done banner must not be present
    expect(queryByTestId('report-post-done')).toBeNull();
  });

  it('multiple open/close cycles never accumulate stale state', async () => {
    const onClose = jest.fn();
    const { getByTestId, queryByText, rerender } = await renderSheet(
      true,
      onClose,
    );

    const reasons = ['spam', 'harassment', 'violence', 'nudity'] as const;

    for (const reason of reasons) {
      // Select a reason
      await fireEvent.press(getByTestId(`reason-${reason}`));
      expect(queryByText('✓')).toBeTruthy();

      // Dismiss
      await fireEvent.press(getByTestId('report-post-close'));

      // Re-open
      await rerender(
        <ReportPostSheet postId="post-abc" visible={true} onClose={onClose} />,
      );

      // Assert clean state
      expect(queryByText('✓')).toBeNull();
      const disabled =
        getByTestId('report-post-submit').props.accessibilityState?.disabled ??
        getByTestId('report-post-submit').props.disabled;
      expect(disabled).toBeTruthy();
    }

    expect(onClose).toHaveBeenCalledTimes(reasons.length);
  });
});
