/**
 * Component-level integration tests for PostWrongPlaceSheet.
 *
 * Verifies that:
 *  - all three reason options render and are selectable
 *  - Submit is disabled until a reason is chosen
 *  - tapping Submit calls reportWrongPlace(postId, reason)
 *  - a success confirmation view appears after a mocked OK response
 *  - a 409 "already reported" response shows the specific message
 *  - a generic error shows the fallback message
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { PostWrongPlaceSheet } from '../PostWrongPlaceSheet.tsx';

// ── Mock the service ───────────────────────────────────────────────────────────

const mockReportWrongPlace = jest.fn();

jest.mock('../../services/posts', () => ({
  ...jest.requireActual('../../services/posts'),
  reportWrongPlace: (...args: unknown[]) => mockReportWrongPlace(...args),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

async function renderSheet(
  visible = true,
  postId = 'post-abc',
  onClose = jest.fn(),
  onReported = jest.fn(),
) {
  return render(
    <PostWrongPlaceSheet
      postId={postId}
      visible={visible}
      onClose={onClose}
      onReported={onReported}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReportWrongPlace.mockResolvedValue({ ok: true });
});

// ── Initial render ─────────────────────────────────────────────────────────────

describe('PostWrongPlaceSheet — initial render', () => {
  it('shows all three reason options', async () => {
    const { getByTestId } = await renderSheet();
    expect(getByTestId('wrong-place-reason-wrong_location')).toBeTruthy();
    expect(getByTestId('wrong-place-reason-not_the_same_place')).toBeTruthy();
    expect(getByTestId('wrong-place-reason-duplicate')).toBeTruthy();
  });

  it('submit button is disabled before any reason is selected', async () => {
    const { getByTestId } = await renderSheet();
    const btn = getByTestId('post-wrong-place-submit');
    const disabled =
      btn.props.accessibilityState?.disabled ?? btn.props.disabled;
    expect(disabled).toBeTruthy();
  });

  it('does not show the success view initially', async () => {
    const { queryByTestId } = await renderSheet();
    expect(queryByTestId('post-wrong-place-done')).toBeNull();
  });

  it('does not show an error message initially', async () => {
    const { queryByTestId } = await renderSheet();
    expect(queryByTestId('post-wrong-place-error')).toBeNull();
  });
});

// ── Reason selection ───────────────────────────────────────────────────────────

describe('PostWrongPlaceSheet — selecting a reason', () => {
  it('enables submit after selecting wrong_location', async () => {
    const { getByTestId } = await renderSheet();
    await fireEvent.press(getByTestId('wrong-place-reason-wrong_location'));
    const btn = getByTestId('post-wrong-place-submit');
    const disabled =
      btn.props.accessibilityState?.disabled ?? btn.props.disabled;
    expect(disabled).toBeFalsy();
  });

  it('enables submit after selecting not_the_same_place', async () => {
    const { getByTestId } = await renderSheet();
    await fireEvent.press(getByTestId('wrong-place-reason-not_the_same_place'));
    const btn = getByTestId('post-wrong-place-submit');
    const disabled =
      btn.props.accessibilityState?.disabled ?? btn.props.disabled;
    expect(disabled).toBeFalsy();
  });

  it('enables submit after selecting duplicate', async () => {
    const { getByTestId } = await renderSheet();
    await fireEvent.press(getByTestId('wrong-place-reason-duplicate'));
    const btn = getByTestId('post-wrong-place-submit');
    const disabled =
      btn.props.accessibilityState?.disabled ?? btn.props.disabled;
    expect(disabled).toBeFalsy();
  });
});

// ── Submit calls reportWrongPlace with correct args ────────────────────────────

describe('PostWrongPlaceSheet — submit calls reportWrongPlace', () => {
  it('passes postId + wrong_location to reportWrongPlace', async () => {
    const { getByTestId } = await renderSheet(true, 'post-123');
    await fireEvent.press(getByTestId('wrong-place-reason-wrong_location'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    await waitFor(() => expect(mockReportWrongPlace).toHaveBeenCalledTimes(1));
    expect(mockReportWrongPlace).toHaveBeenCalledWith('post-123', 'wrong_location');
  });

  it('passes postId + not_the_same_place to reportWrongPlace', async () => {
    const { getByTestId } = await renderSheet(true, 'post-456');
    await fireEvent.press(getByTestId('wrong-place-reason-not_the_same_place'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    await waitFor(() => expect(mockReportWrongPlace).toHaveBeenCalledTimes(1));
    expect(mockReportWrongPlace).toHaveBeenCalledWith('post-456', 'not_the_same_place');
  });

  it('passes postId + duplicate to reportWrongPlace', async () => {
    const { getByTestId } = await renderSheet(true, 'post-789');
    await fireEvent.press(getByTestId('wrong-place-reason-duplicate'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    await waitFor(() => expect(mockReportWrongPlace).toHaveBeenCalledTimes(1));
    expect(mockReportWrongPlace).toHaveBeenCalledWith('post-789', 'duplicate');
  });
});

// ── Success state ──────────────────────────────────────────────────────────────

describe('PostWrongPlaceSheet — success toast/confirmation', () => {
  it('shows the done confirmation view after a successful submit', async () => {
    mockReportWrongPlace.mockResolvedValue({ ok: true });
    const { getByTestId, findByTestId } = await renderSheet();
    await fireEvent.press(getByTestId('wrong-place-reason-wrong_location'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    const doneView = await findByTestId('post-wrong-place-done');
    expect(doneView).toBeTruthy();
  });

  it('calls onReported callback after a successful submit', async () => {
    mockReportWrongPlace.mockResolvedValue({ ok: true });
    const onReported = jest.fn();
    const { getByTestId } = await renderSheet(true, 'post-abc', jest.fn(), onReported);
    await fireEvent.press(getByTestId('wrong-place-reason-duplicate'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    await waitFor(() => expect(onReported).toHaveBeenCalledTimes(1));
  });

  it('reason picker is hidden after successful submit', async () => {
    mockReportWrongPlace.mockResolvedValue({ ok: true });
    const { getByTestId, findByTestId, queryByTestId } = await renderSheet();
    await fireEvent.press(getByTestId('wrong-place-reason-not_the_same_place'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    await findByTestId('post-wrong-place-done');
    expect(queryByTestId('wrong-place-reason-wrong_location')).toBeNull();
  });
});

// ── 409 already-reported ───────────────────────────────────────────────────────

describe('PostWrongPlaceSheet — 409 already reported', () => {
  it('shows "already reported" message when service returns 409 message', async () => {
    mockReportWrongPlace.mockResolvedValue({
      ok: false,
      message: 'You have already reported this place',
    });
    const { getByTestId, findByTestId } = await renderSheet();
    await fireEvent.press(getByTestId('wrong-place-reason-wrong_location'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    const errorEl = await findByTestId('post-wrong-place-error');
    expect(errorEl.props.children).toBe('You have already reported this place');
  });

  it('does not show the success view when 409 is returned', async () => {
    mockReportWrongPlace.mockResolvedValue({
      ok: false,
      message: 'You have already reported this place',
    });
    const { getByTestId, findByTestId, queryByTestId } = await renderSheet();
    await fireEvent.press(getByTestId('wrong-place-reason-duplicate'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    await findByTestId('post-wrong-place-error');
    expect(queryByTestId('post-wrong-place-done')).toBeNull();
  });
});

// ── Generic error ──────────────────────────────────────────────────────────────

describe('PostWrongPlaceSheet — generic error fallback', () => {
  it('shows fallback message when service returns ok:false with no message', async () => {
    mockReportWrongPlace.mockResolvedValue({ ok: false });
    const { getByTestId, findByTestId } = await renderSheet();
    await fireEvent.press(getByTestId('wrong-place-reason-wrong_location'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    const errorEl = await findByTestId('post-wrong-place-error');
    expect(errorEl.props.children).toContain('Could not submit report');
  });

  it('shows network error message when service returns that message', async () => {
    mockReportWrongPlace.mockResolvedValue({
      ok: false,
      message: 'Network error — please try again',
    });
    const { getByTestId, findByTestId } = await renderSheet();
    await fireEvent.press(getByTestId('wrong-place-reason-duplicate'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    const errorEl = await findByTestId('post-wrong-place-error');
    expect(errorEl.props.children).toBe('Network error — please try again');
  });

  it('submit re-enables after an error so the user can retry', async () => {
    mockReportWrongPlace.mockResolvedValue({ ok: false, message: 'Server error' });
    const { getByTestId, findByTestId } = await renderSheet();
    await fireEvent.press(getByTestId('wrong-place-reason-wrong_location'));
    fireEvent.press(getByTestId('post-wrong-place-submit'));
    await findByTestId('post-wrong-place-error');
    const btn = getByTestId('post-wrong-place-submit');
    const disabled =
      btn.props.accessibilityState?.disabled ?? btn.props.disabled;
    expect(disabled).toBeFalsy();
  });
});

// ── Close button ───────────────────────────────────────────────────────────────

describe('PostWrongPlaceSheet — close button', () => {
  it('calls onClose when the X button is tapped', async () => {
    const onClose = jest.fn();
    const { getByTestId } = await renderSheet(true, 'post-abc', onClose);
    await fireEvent.press(getByTestId('post-wrong-place-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
