/**
 * Structured Moment — the author flow says what will actually happen.
 *
 * THE DEFECT. Step 2, "Approve & make it live", calls the admin-only approve
 * route (routes/intel.ts handleApproveClaim → requireAdmin). A traveller who
 * presses it gets 403 `forbidden`, and the screen answered "Could not approve —
 * try again": a retry that can never succeed, on a step it presented as theirs.
 * Refusals a retry cannot fix (no consent, a refused shape) were answered the
 * same way on propose, confirm and correct.
 *
 * CONTROLLED evidence: the capture service is a double; no network.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
}));
let mockParams: Record<string, string> = {};
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// NOTE: intentionally exhaustive — the native haptics module is absent under jest.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Error: 'error', Warning: 'warning' },
}));
// NOTE: intentional stub — flags and Safe Return are not under test here.
jest.mock('../../../src/hooks/useIntelPrompts', () => ({
  useIntelPrompts: () => ({ captureEnabled: true, safeReturnActive: false }),
}));
const mockPropose = jest.fn();
const mockApprove = jest.fn();
const mockConfirm = jest.fn();
const mockCorrect = jest.fn();
// NOTE: intentionally exhaustive — the real service does an authed fetch with a
// native token store; these cases assert only what the screen does with answers.
jest.mock('../../../src/services/intelCapture', () => ({
  proposeClaim: (...a: unknown[]) => mockPropose(...a),
  approveClaim: (...a: unknown[]) => mockApprove(...a),
  confirmClaim: (...a: unknown[]) => mockConfirm(...a),
  correctClaim: (...a: unknown[]) => mockCorrect(...a),
}));

import MomentScreen from '../moment';

const AUTHOR = { observationId: 'obs-1', subjectId: 'place-1', subjectName: 'Cafe Giang', claimType: 'crowd.level' };

beforeEach(() => {
  [mockPropose, mockApprove, mockConfirm, mockCorrect].forEach((m) => m.mockReset());
  mockParams = { ...AUTHOR };
});

async function proposeThenApprove() {
  mockPropose.mockResolvedValue({ ok: true, claim: { id: 'claim-1' } });
  const r = await render(<MomentScreen />);
  fireEvent.press(r.getByText('Propose Moment'));
  fireEvent.press(await r.findByText('Approve & publish'));
  return r;
}

describe('Moment — approval is a reviewer step', () => {
  it('a 403 on approve says the Moment is WAITING FOR REVIEW — no error, no retry button', async () => {
    mockApprove.mockResolvedValue({ ok: false, code: 'forbidden', error: 'Admin role required' });
    const r = await proposeThenApprove();
    await r.findByTestId('intel-moment-in-review');
    expect(r.getByText('Waiting for a reviewer')).toBeTruthy();
    expect(r.queryByText('Approve & publish')).toBeNull();
    expect(r.queryByText(/try again/i)).toBeNull();
    expect(r.queryByText(/Moment is live/)).toBeNull();
  });

  it('an approval that succeeds (a reviewer) still says the Moment is live', async () => {
    mockApprove.mockResolvedValue({ ok: true });
    const r = await proposeThenApprove();
    await r.findByText(/Moment is live/);
    expect(r.queryByTestId('intel-moment-in-review')).toBeNull();
  });

  it('a TRANSIENT approve failure still offers a retry', async () => {
    mockApprove.mockResolvedValue({ ok: false, code: 'db_error', error: 'x' });
    const r = await proposeThenApprove();
    await r.findByText(/tap to try again/);
    expect(r.getByText('Approve & publish')).toBeTruthy();
  });
});

describe('Moment — refusals a retry cannot fix do not ask for one', () => {
  it('propose refused as shaped (aggregate-only movement) is not "try again"', async () => {
    mockPropose.mockResolvedValue({ ok: false, code: 'invalid_payload', error: 'movement claims are aggregate-only' });
    const r = await render(<MomentScreen />);
    fireEvent.press(r.getByText('Propose Moment'));
    await r.findByText(/can’t be proposed as it is/);
    expect(r.queryByText(/try again/i)).toBeNull();
  });

  it('confirm refused for consent points to Settings', async () => {
    mockParams = { claimId: 'claim-9', subjectId: 'place-1', claimType: 'crowd.level' };
    mockConfirm.mockResolvedValue({ ok: false, code: 'invalid_payload', error: 'consent_required' });
    const r = await render(<MomentScreen />);
    fireEvent.press(r.getByTestId('intel-confirm-agree'));
    await r.findByText(/Turn on Intelligence Contributions/);
    expect(r.queryByText(/try again/i)).toBeNull();
  });
});
