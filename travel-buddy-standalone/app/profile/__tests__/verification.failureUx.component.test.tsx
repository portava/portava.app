/**
 * VerificationScreen — failure copy, the underage branch, and the privacy
 * disclosure (census-trust §31: TV-2d and TV-2b).
 *
 * TV-2d. The plan: "clear reason ('document couldn't be read', 'selfie didn't
 * match') + retry path; `underage` routes to an age-policy screen and does NOT
 * allow retry spam." Before §31 the screen printed `Reason: document invalid`
 * (the enum with its underscore swapped) and re-offered BOTH check buttons for
 * every failure, underage included.
 *
 * TV-2b. The plan's intro is "what / why / **what we never store**"; the screen
 * had no privacy disclosure.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, screen, cleanup, fireEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import VerificationScreen from '../verification.tsx';
import { getVerificationStatus } from '../../../src/services/verification.ts';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: Intentionally exhaustive for the functions used by VerificationScreen;
// the real module's types and pure helpers are kept via requireActual.
jest.mock('../../../src/services/verification', () => ({
  ...jest.requireActual('../../../src/services/verification'),
  getVerificationStatus: jest.fn(),
  createVerificationSession: jest.fn(),
}));

const mockGetVerificationStatus = getVerificationStatus as jest.Mock;

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

function failedResult(failureReason: string | null, status: 'failed' | 'expired' = 'failed') {
  const now = new Date().toISOString();
  return {
    ok: true,
    result: {
      ok: true,
      verificationRow: {
        id: 'row-1', provider: 'mock', providerSessionId: 'sess-1',
        status, failureReason,
        isOver18: failureReason === 'underage' ? false : null,
        selfieMatch: null, documentCountry: null, verifiedAt: null, expiresAt: null,
        createdAt: now, updatedAt: now,
      },
      verificationLevel: 'none' as const,
      verifiedAt: null,
    },
  };
}

describe('VerificationScreen — TV-2d failure UX', () => {
  it('a document failure reads as a sentence and still offers the check again', async () => {
    mockGetVerificationStatus.mockResolvedValue(failedResult('document_invalid'));
    await render(<VerificationScreen />);
    await waitFor(() => expect(screen.getByText(/couldn't read your document/i)).toBeTruthy());
    expect(screen.queryByText(/document invalid/i)).toBeNull();
    expect(screen.queryByText(/Reason:/)).toBeNull();
    expect(screen.getByText('ID Verification')).toBeTruthy();
    expect(screen.getByText('ID + Selfie')).toBeTruthy();
  });

  it('a selfie mismatch reads as the plan words it', async () => {
    mockGetVerificationStatus.mockResolvedValue(failedResult('selfie_mismatch'));
    await render(<VerificationScreen />);
    await waitFor(() => expect(screen.getByText(/selfie didn't match/i)).toBeTruthy());
    expect(screen.queryByText(/selfie mismatch/i)).toBeNull();
  });

  it('UNDERAGE does not re-offer the check, and routes to the age-policy screen instead', async () => {
    const push = jest.spyOn(router, 'push');
    mockGetVerificationStatus.mockResolvedValue(failedResult('underage'));
    await render(<VerificationScreen />);
    await waitFor(() => expect(screen.getByText(/didn't confirm that you're 18 or over/i)).toBeTruthy());
    expect(screen.queryByText('ID Verification')).toBeNull();
    expect(screen.queryByText('ID + Selfie')).toBeNull();
    expect(screen.queryByText(/^underage$/i)).toBeNull();
    await fireEvent.press(screen.getByText('See age requirements'));
    expect(push).toHaveBeenCalledWith('/profile/age-policy');
  });

  it('an EXPIRED session (no reason) is still offered again', async () => {
    mockGetVerificationStatus.mockResolvedValue(failedResult(null, 'expired'));
    await render(<VerificationScreen />);
    await waitFor(() => expect(screen.getByText('ID Verification')).toBeTruthy());
  });
});

describe('VerificationScreen — TV-2b "what we never store"', () => {
  it('states what the check never stores, before anyone is sent to the provider', async () => {
    mockGetVerificationStatus.mockResolvedValue(failedResult(null, 'expired'));
    await render(<VerificationScreen />);
    await waitFor(() => expect(screen.getByText('WHAT WE NEVER STORE')).toBeTruthy());
    expect(screen.getByText('An image or scan of your ID document')).toBeTruthy();
    expect(screen.getByText('Your document number')).toBeTruthy();
    expect(screen.getByText('Your selfie image')).toBeTruthy();
    expect(screen.getByText('The date of birth on your document')).toBeTruthy();
    expect(screen.getByText('WHAT WE KEEP')).toBeTruthy();
  });
});
