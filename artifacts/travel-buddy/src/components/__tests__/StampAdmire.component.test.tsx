/**
 * StampAdmire — component-level tests
 *
 * Covers:
 *  - null getAdmirers response hides all admire UI
 *  - non-owner sees the admire button
 *  - owner sees count label only (no button) when count > 0
 *  - owner renders nothing when count === 0
 *  - optimistic admire toggle + revert on failure
 *  - admirers sheet opens and a row tap navigates to passport
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockGetAdmirers = jest.fn();
const mockAdmireStamp = jest.fn();
const mockUnadmireStamp = jest.fn();

// NOTE: intentionally exhaustive — stampAdmire imports Supabase and the API
// token stack; requireActual would pull in the live network graph.
jest.mock('../../services/stampAdmire', () => ({
  getAdmirers:    (...args: unknown[]) => mockGetAdmirers(...args),
  admireStamp:    (...args: unknown[]) => mockAdmireStamp(...args),
  unadmireStamp:  (...args: unknown[]) => mockUnadmireStamp(...args),
}));

// ── Infrastructure mocks ──────────────────────────────────────────────────────

const mockRouterPush = jest.fn();

// NOTE: intentionally exhaustive — expo-router hooks touch the navigation
// context which is unavailable in unit test environments.
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));

// NOTE: intentionally exhaustive — useSafeAreaInsets requires a native
// context provider that is absent in jest-expo.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — react-native-reanimated initialises native
// worklets on import which crash under jest-expo without special Babel config.
jest.mock('react-native-reanimated', () => ({
  useReducedMotion: () => false,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADMIRER_A = {
  userId:      'user-a',
  admiredAt:   '2026-07-01T00:00:00Z',
  username:    'alice',
  displayName: null,
  avatarUrl:   null,
};

const ADMIRER_B = {
  userId:      'user-b',
  admiredAt:   '2026-07-02T00:00:00Z',
  username:    'bob',
  displayName: 'Bob Smith',
  avatarUrl:   null,
};

const BASE_RESULT = {
  count: 2,
  admiredByMe: false,
  admirers: [ADMIRER_A, ADMIRER_B],
};

// ── Import under test (after mocks are registered) ───────────────────────────

import { StampAdmireBlock } from '../stamps/StampAdmireBlock.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderBlock(props: { userStampId?: string; isOwner?: boolean } = {}) {
  return render(
    <StampAdmireBlock
      userStampId={props.userStampId ?? 'stamp-1'}
      isOwner={props.isOwner ?? false}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StampAdmireBlock — null state', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('renders nothing when getAdmirers returns null (flag off)', async () => {
    mockGetAdmirers.mockResolvedValue(null);
    const { toJSON } = await renderBlock();
    await act(async () => {});
    expect(toJSON()).toBeNull();
  });
});

describe('StampAdmireBlock — non-owner view', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('shows the admire button for a non-owner', async () => {
    mockGetAdmirers.mockResolvedValue({ ...BASE_RESULT, admiredByMe: false });
    await renderBlock({ isOwner: false });
    await act(async () => {});
    expect(screen.getByText('Admire')).toBeTruthy();
  });

  it('shows "Admired" label when admiredByMe is true', async () => {
    mockGetAdmirers.mockResolvedValue({ ...BASE_RESULT, admiredByMe: true });
    await renderBlock({ isOwner: false });
    await act(async () => {});
    expect(screen.getByText('Admired')).toBeTruthy();
  });

  it('shows the count when count > 0', async () => {
    mockGetAdmirers.mockResolvedValue({ ...BASE_RESULT, count: 5, admiredByMe: false });
    await renderBlock({ isOwner: false });
    await act(async () => {});
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('optimistically toggles admire and calls admireStamp', async () => {
    mockGetAdmirers.mockResolvedValue({ ...BASE_RESULT, count: 2, admiredByMe: false });
    mockAdmireStamp.mockResolvedValue(true);

    await renderBlock({ isOwner: false });
    await act(async () => {});

    expect(screen.getByText('Admire')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Admire'));
    });

    await waitFor(() => {
      expect(screen.getByText('Admired')).toBeTruthy();
      expect(screen.getByText('3')).toBeTruthy();
    });

    expect(mockAdmireStamp).toHaveBeenCalledWith('stamp-1');
  });

  it('reverts optimistic toggle when admireStamp returns false', async () => {
    mockGetAdmirers.mockResolvedValue({ ...BASE_RESULT, count: 2, admiredByMe: false });
    mockAdmireStamp.mockResolvedValue(false);

    await renderBlock({ isOwner: false });
    await act(async () => {});

    await act(async () => {
      fireEvent.press(screen.getByText('Admire'));
    });

    await waitFor(() => {
      expect(screen.getByText('Admire')).toBeTruthy();
      expect(screen.getByText('2')).toBeTruthy();
    });
  });

  it('optimistically reverts unadmire when unadmireStamp returns false', async () => {
    mockGetAdmirers.mockResolvedValue({ ...BASE_RESULT, count: 3, admiredByMe: true });
    mockUnadmireStamp.mockResolvedValue(false);

    await renderBlock({ isOwner: false });
    await act(async () => {});

    await act(async () => {
      fireEvent.press(screen.getByText('Admired'));
    });

    await waitFor(() => {
      expect(screen.getByText('Admired')).toBeTruthy();
      expect(screen.getByText('3')).toBeTruthy();
    });
  });
});

describe('StampAdmireBlock — owner view', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('shows only the count (no admire button) for owner when count > 0', async () => {
    mockGetAdmirers.mockResolvedValue({ ...BASE_RESULT, count: 4, admiredByMe: false });
    await renderBlock({ isOwner: true });
    await act(async () => {});
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.queryByText('Admire')).toBeNull();
    expect(screen.queryByText('Admired')).toBeNull();
  });

  it('renders nothing for owner when count === 0', async () => {
    mockGetAdmirers.mockResolvedValue({ count: 0, admiredByMe: false, admirers: [] });
    const { toJSON } = await renderBlock({ isOwner: true });
    await act(async () => {});
    expect(toJSON()).toBeNull();
  });
});

describe('StampAdmirersSheet — via count press', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('opens the admirers sheet when count is tapped (non-owner)', async () => {
    mockGetAdmirers.mockResolvedValue({ ...BASE_RESULT, count: 2, admiredByMe: false });
    await renderBlock({ isOwner: false });
    await act(async () => {});

    fireEvent.press(screen.getByText('2'));

    // Sheet title should be visible
    await waitFor(() => {
      expect(screen.getByText('Admirers')).toBeTruthy();
    });
  });

  it('opens the admirers sheet when count is tapped (owner)', async () => {
    mockGetAdmirers.mockResolvedValue({ ...BASE_RESULT, count: 2, admiredByMe: false });
    await renderBlock({ isOwner: true });
    await act(async () => {});

    fireEvent.press(screen.getByText('2'));

    await waitFor(() => {
      expect(screen.getByText('Admirers')).toBeTruthy();
    });
  });

  it('renders admirer rows in the sheet with display name when present', async () => {
    mockGetAdmirers.mockResolvedValue({
      count: 2,
      admiredByMe: false,
      admirers: [ADMIRER_A, ADMIRER_B],
    });
    await renderBlock({ isOwner: false });
    await act(async () => {});

    fireEvent.press(screen.getByText('2'));

    await waitFor(() => {
      // ADMIRER_A has no displayName → shows @alice
      expect(screen.getByText('@alice')).toBeTruthy();
      // ADMIRER_B has displayName → shows Bob Smith as primary, @bob as secondary
      expect(screen.getByText('Bob Smith')).toBeTruthy();
    });
  });

  it('tapping an admirer row navigates to their passport and closes sheet', async () => {
    mockGetAdmirers.mockResolvedValue({
      count: 1,
      admiredByMe: false,
      admirers: [ADMIRER_A],
    });
    await renderBlock({ isOwner: false });
    await act(async () => {});

    fireEvent.press(screen.getByText('1'));

    await waitFor(() => {
      expect(screen.getByText('@alice')).toBeTruthy();
    });

    fireEvent.press(screen.getByText('@alice'));

    // closeThenNavigate defers router.push via setTimeout — wait for it to fire.
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/passport/alice'));
  });
});
