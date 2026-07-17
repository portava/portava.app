/**
 * Hook-level tests for useGemCheckin() — the state machine that drives the
 * GPS check-in modal on the gem detail screen.
 *
 * Covers the three result branches that the CheckinModal UI renders:
 *  • success  — withinRange=true, isSuspicious=false → "Visit Verified!" path
 *  • too_far  — withinRange=false, error='too_far'   → "Too Far Away" path
 *  • flagged  — isSuspicious=true                   → "Check-in Flagged" path
 *  • verifyGemVisit is called with the correct gemId / coordinates / tripId
 *  • loading resets to false after the call (including on error)
 *
 * Run with:  pnpm test:component
 *
 * RNTL v14: renderHook() is async — always await it.
 * verifyGemVisit (hiddenGems service) is mocked — no real network I/O.
 */

import { renderHook, act } from '@testing-library/react-native';
import { useGemCheckin } from '../useHiddenGems.ts';

// ── hiddenGems service mock ───────────────────────────────────────────────────

// NOTE: intentionally exhaustive — requireActual would pull the module's
// native/supabase dependency chain under jest.
jest.mock('../../services/hiddenGems.ts', () => ({
  verifyGemVisit:      jest.fn(),
  listGems:            jest.fn(),
  getGem:              jest.fn(),
  submitGem:           jest.fn(),
  getTripcityGems:     jest.fn(),
  getLayoverGems:      jest.fn(),
  getSavedGems:        jest.fn(),
  saveGem:             jest.fn(),
  unsaveGem:           jest.fn(),
  reportGem:           jest.fn(),
  shareGemToTelegraph: jest.fn(),
  addGemToPlan:        jest.fn(),
  verificationBadge:   () => '',
  sensitivityLabel:    () => '',
}));

import { verifyGemVisit } from '../../services/hiddenGems.ts';

const mockVerifyGemVisit = verifyGemVisit as jest.MockedFunction<typeof verifyGemVisit>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GEM_ID  = 'gem-checkin-test';
const LAT     = 48.8584;
const LNG     = 2.2945;
const TRIP_ID = 'trip-abc';

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useGemCheckin()', () => {
  it('starts with loading=false and result=null', async () => {
    const { result } = await renderHook(() => useGemCheckin());

    expect(result.current.loading).toBe(false);
    expect(result.current.result).toBeNull();
    expect(typeof result.current.checkin).toBe('function');
  });

  it('sets result to the success payload — withinRange=true, isSuspicious=false', async () => {
    const SUCCESS = {
      withinRange:          true,
      isSuspicious:         false,
      distanceM:            48,
      verificationUpgraded: false,
    } as any;
    mockVerifyGemVisit.mockResolvedValue(SUCCESS);

    const { result } = await renderHook(() => useGemCheckin());

    await act(async () => {
      await result.current.checkin(GEM_ID, LAT, LNG);
    });

    expect(result.current.result).toEqual(SUCCESS);
    expect(result.current.loading).toBe(false);
  });

  it('sets result to the too_far payload — withinRange=false, error="too_far"', async () => {
    const TOO_FAR = {
      withinRange:  false,
      isSuspicious: false,
      distanceM:    350,
      error:        'too_far',
    } as any;
    mockVerifyGemVisit.mockResolvedValue(TOO_FAR);

    const { result } = await renderHook(() => useGemCheckin());

    await act(async () => {
      await result.current.checkin(GEM_ID, LAT, LNG);
    });

    expect(result.current.result!.withinRange).toBe(false);
    expect((result.current.result as any).error).toBe('too_far');
  });

  it('sets result to the flagged payload — isSuspicious=true ("Check-in Flagged" branch)', async () => {
    const FLAGGED = {
      withinRange:  false,
      isSuspicious: true,
      distanceM:    0,
      error:        'suspicious',
    } as any;
    mockVerifyGemVisit.mockResolvedValue(FLAGGED);

    const { result } = await renderHook(() => useGemCheckin());

    await act(async () => {
      await result.current.checkin(GEM_ID, LAT, LNG);
    });

    expect(result.current.result!.isSuspicious).toBe(true);
  });

  it('calls verifyGemVisit with the correct gemId, coordinates, and optional tripId', async () => {
    mockVerifyGemVisit.mockResolvedValue({
      withinRange: true, isSuspicious: false, distanceM: 10, verificationUpgraded: false,
    } as any);

    const { result } = await renderHook(() => useGemCheckin());

    await act(async () => {
      await result.current.checkin(GEM_ID, LAT, LNG, TRIP_ID);
    });

    expect(mockVerifyGemVisit).toHaveBeenCalledWith(GEM_ID, LAT, LNG, TRIP_ID);
  });

  it('resets loading to false after the call completes', async () => {
    mockVerifyGemVisit.mockResolvedValue({
      withinRange: true, isSuspicious: false, distanceM: 30, verificationUpgraded: false,
    } as any);

    const { result } = await renderHook(() => useGemCheckin());

    await act(async () => {
      await result.current.checkin(GEM_ID, LAT, LNG);
    });

    expect(result.current.loading).toBe(false);
  });
});
