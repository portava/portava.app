/**
 * Local Guide profile — unknown stats render an em dash, not a zero.
 *
 * ## The defect
 *
 * `normalizeGuideProfile` coerced `contribution_count`, `helpful_votes` and
 * `accuracy_score` with `?? 0`. A guide row that arrived without those columns
 * — an older row, a narrowed `select`, a partially-computed profile — was
 * therefore presented to every traveller as:
 *
 *     Gems 0 · Helpful votes 0 · Accuracy 0%
 *
 * i.e. as a guide who has contributed nothing and is never right. Worse, this
 * screen ALREADY had the correct idiom: `typeof guide.accuracyScore === 'number'
 * ? … : '—'`. The mapper's `?? 0` made that test always true, so the em-dash
 * branch had become dead code.
 *
 * ## What's covered
 *
 * 1. A row with the stat columns absent → all three tiles show '—'.
 * 2. A row with real figures → they still render exactly as before, so the fix
 *    cannot blank a working profile.
 *
 * The mapper is exercised for real (not stubbed) so the mapper and the surface
 * are proven together.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, act, waitFor, cleanup, screen } from '@testing-library/react-native';
import GuideProfileScreen from '../guide.tsx';
import { normalizeGuideProfile } from '../../../src/services/hiddenGemsMappers.ts';
import { getGuideProfile } from '../../../src/services/hiddenGems.ts';

// ── expo-router ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ userId: 'guide-1' }),
}));

// ── safe area ─────────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── hidden-gems service — only the profile read is stubbed ───────────────────

jest.mock('../../../src/services/hiddenGems', () => ({
  ...jest.requireActual('../../../src/services/hiddenGems'),
  getGuideProfile: jest.fn(),
}));

// ── gem list — not under test ────────────────────────────────────────────────

jest.mock('../../../src/hooks/useHiddenGems', () => ({
  ...jest.requireActual('../../../src/hooks/useHiddenGems'),
  useGemList: () => ({ gems: [], loading: false, error: null, refresh: jest.fn() }),
}));

const mockGetGuideProfile = getGuideProfile as jest.Mock;

/** The raw row shape the mapper actually receives. */
function guideRow(extra: Record<string, unknown>) {
  return {
    user_id: 'guide-1',
    guide_level: 3,
    city_expertise: ['Da Nang'],
    status: 'active',
    bio: 'Knows the good noodles.',
    verified_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('Local Guide profile — unreported stats', () => {
  it("shows '—' for every stat the server did not report", async () => {
    mockGetGuideProfile.mockResolvedValue(normalizeGuideProfile(guideRow({})));

    await act(async () => {
      render(<GuideProfileScreen />);
    });

    await waitFor(() => expect(screen.getByText('Gems')).toBeTruthy());

    // Three tiles, three em dashes — never "0" or "0%".
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('still renders real figures unchanged', async () => {
    mockGetGuideProfile.mockResolvedValue(
      normalizeGuideProfile(
        guideRow({ contribution_count: 12, helpful_votes: 47, accuracy_score: 0.92 }),
      ),
    );

    await act(async () => {
      render(<GuideProfileScreen />);
    });

    await waitFor(() => expect(screen.getByText('Gems')).toBeTruthy());

    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('47')).toBeTruthy();
    expect(screen.getByText('92%')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('keeps a genuine zero distinguishable from an absent figure', async () => {
    mockGetGuideProfile.mockResolvedValue(
      normalizeGuideProfile(
        guideRow({ contribution_count: 0, helpful_votes: 0, accuracy_score: 0 }),
      ),
    );

    await act(async () => {
      render(<GuideProfileScreen />);
    });

    await waitFor(() => expect(screen.getByText('Gems')).toBeTruthy());

    // A server that really said "zero" must still say zero.
    expect(screen.getAllByText('0')).toHaveLength(2);
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
  });
});
