/**
 * Safe Return History — a history that could not be read is not an empty one.
 *
 * THE DEFECT. GET /me/safe-return/history answers 503 `degraded_unavailable`
 * when the history cannot be read (artifacts/api-server/src/routes/safeReturn.ts:
 * "An empty history reads as 'you have never used Safe Return'. That is a claim
 * about the record, and a failed read cannot make it."). The client turned that
 * 503 into `sessions: []`, and this screen said "No Safe Return history yet".
 *
 * RED on the tree before this change: 1 failed / 1 passed (the real-empty guard
 * is green on both).
 *
 * Two renders only (RNTL v14 + React 19 render-count limit).
 */
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react-native';

const mockGetHistory = jest.fn();
jest.mock('../../src/services/safeReturn', () => ({
  ...jest.requireActual('../../src/services/safeReturn'),
  getHistory: (...a: unknown[]) => mockGetHistory(...a),
}));

// NOTE: intentionally exhaustive — the screen reads only these two flags.
jest.mock('../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, configured: true }),
}));

// NOTE: intentionally exhaustive — the real hook accesses native scroll state.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller:           () => null,
}));

// NOTE: intentionally exhaustive — the real AppHeader uses reanimated.
jest.mock('../../src/components/ui/AppHeader', () => ({
  AppHeader: () => null,
}));

// NOTE: intentionally exhaustive — the setup sheet runs its own service reads on
// open; it is closed throughout this test.
jest.mock('../../src/components/safeReturn/SafeReturnSetupSheet', () => ({
  SafeReturnSetupSheet: () => null,
}));

afterEach(async () => { await act(async () => {}); jest.clearAllMocks(); });

describe('Safe Return History — failed read vs. empty record', () => {
  it('a failed read says it could not load, and never "No Safe Return history yet"', async () => {
    mockGetHistory.mockResolvedValue({ sessions: [], unavailable: true });
    const Screen = require('../safety-history.tsx').default;
    await render(<Screen />);
    await waitFor(() => expect(screen.getByText("Couldn't load your Safe Return history")).toBeTruthy());
    expect(screen.queryByText('No Safe Return history yet')).toBeNull();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('a real empty record still says so', async () => {
    mockGetHistory.mockResolvedValue({ sessions: [] });
    const Screen = require('../safety-history.tsx').default;
    await render(<Screen />);
    await waitFor(() => expect(screen.getByText('No Safe Return history yet')).toBeTruthy());
  });
});
