/**
 * VerificationScreen — polling and status display tests.
 *
 * ## What's covered
 * 1. The screen starts polling when the row status is 'pending' and
 *    automatically updates the level label when status transitions to
 *    'verified' — no manual refresh needed.
 * 2. The "Get Verified" CTA section is absent once the user is verified
 *    (verificationLevel !== 'none').
 * 3. When getVerificationStatus() returns ok: false, an error banner
 *    renders instead of a blank screen.
 *
 * ## Why these tests exist
 * Without polling, a user whose verification resolves server-side would be
 * stuck on 'Pending' until they manually refreshed.  These tests confirm
 * the setTimeout-driven poll loop advances state automatically, stops once
 * verified, and surfaces errors rather than leaving a blank screen.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, waitFor, screen, cleanup, act } from '@testing-library/react-native';
import VerificationScreen from '../verification.tsx';
import { getVerificationStatus } from '../../../src/services/verification.ts';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: Intentionally exhaustive for the functions used by VerificationScreen.
// createVerificationSession is stubbed to a no-op so the CTA buttons don't
// trigger real network calls; getVerificationStatus drives all poll assertions.
jest.mock('../../../src/services/verification', () => ({
  ...jest.requireActual('../../../src/services/verification'),
  getVerificationStatus: jest.fn(),
  createVerificationSession: jest.fn(),
}));

const mockGetVerificationStatus = getVerificationStatus as jest.Mock;

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  jest.useRealTimers();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePendingResult() {
  const now = new Date().toISOString();
  return {
    ok: true,
    result: {
      ok: true,
      verificationRow: {
        id: 'row-1',
        provider: 'mock',
        providerSessionId: 'sess-1',
        status: 'pending' as const,
        failureReason: null,
        isOver18: null,
        selfieMatch: null,
        documentCountry: null,
        verifiedAt: null,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      },
      verificationLevel: 'none' as const,
      verifiedAt: null,
    },
  };
}

function makeVerifiedResult() {
  const now = new Date().toISOString();
  return {
    ok: true,
    result: {
      ok: true,
      verificationRow: {
        id: 'row-1',
        provider: 'mock',
        providerSessionId: 'sess-1',
        status: 'verified' as const,
        failureReason: null,
        isOver18: true,
        selfieMatch: null,
        documentCountry: 'US',
        verifiedAt: now,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      },
      verificationLevel: 'id_verified' as const,
      verifiedAt: now,
    },
  };
}

// ── Polling tests ─────────────────────────────────────────────────────────────

describe('VerificationScreen — polling', () => {
  it('updates the level label from Not Verified to ID Verified after the poll tick resolves', async () => {
    jest.useFakeTimers();

    // First call (mount): pending row — triggers the poll timer
    // Second call (after 4 s timer): verified — stops polling and updates UI
    mockGetVerificationStatus
      .mockResolvedValueOnce(makePendingResult())
      .mockResolvedValueOnce(makeVerifiedResult());

    await render(<VerificationScreen />);

    // Initial load should show 'Not Verified' while the session is pending
    await waitFor(() =>
      expect(screen.getByText('Not Verified')).toBeTruthy(),
    );

    // Advance past the 4-second poll interval so the second call fires
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });

    // After the poll tick resolves the label must reflect the new level
    await waitFor(() =>
      expect(screen.getByText('ID Verified')).toBeTruthy(),
    );

    // Exactly two network calls: initial mount + one poll tick
    expect(mockGetVerificationStatus).toHaveBeenCalledTimes(2);
  });

  it('does not schedule another poll tick once the status is verified', async () => {
    jest.useFakeTimers();

    mockGetVerificationStatus
      .mockResolvedValueOnce(makePendingResult())
      .mockResolvedValueOnce(makeVerifiedResult());

    await render(<VerificationScreen />);

    // Let the pending load settle, then fire the poll tick
    await waitFor(() => expect(screen.getByText('Not Verified')).toBeTruthy());

    await act(async () => {
      jest.advanceTimersByTime(4000);
    });

    await waitFor(() => expect(screen.getByText('ID Verified')).toBeTruthy());

    // Advance another full interval — no third call should be scheduled
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });

    expect(mockGetVerificationStatus).toHaveBeenCalledTimes(2);
  });
});

// ── CTA visibility ────────────────────────────────────────────────────────────

describe('VerificationScreen — CTA visibility', () => {
  it('hides the GET VERIFIED section when the user is already verified', async () => {
    mockGetVerificationStatus.mockResolvedValue(makeVerifiedResult());

    await render(<VerificationScreen />);

    await waitFor(() =>
      expect(screen.getByText('ID Verified')).toBeTruthy(),
    );

    // The primary CTA section must be absent once verificationLevel !== 'none'
    expect(screen.queryByText('GET VERIFIED')).toBeNull();
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe('VerificationScreen — error state', () => {
  it('shows an error banner and Retry button when getVerificationStatus returns ok: false', async () => {
    mockGetVerificationStatus.mockResolvedValue({
      ok: false,
      error: 'Unable to load verification status',
    });

    await render(<VerificationScreen />);

    // The error message from the service must be visible — not a blank screen
    await waitFor(() =>
      expect(screen.getByText('Unable to load verification status')).toBeTruthy(),
    );

    // The Retry button must also be present so the user can recover
    expect(screen.getByText('Retry')).toBeTruthy();
  });
});
