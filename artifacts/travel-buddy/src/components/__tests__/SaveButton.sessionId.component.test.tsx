/**
 * SaveButton — confirms sessionId flows through to fireRankOutcome.
 *
 * Spec:
 *  - When the user saves an item, fireRankOutcome is called with the exact
 *    sessionId prop passed to SaveButton.
 *  - When the user unsaves an item, fireRankOutcome is NOT called.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { fireEvent, render, waitFor, act } from '@testing-library/react-native';
import { SaveButton } from '../SaveButton.tsx';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockFireRankOutcome = jest.fn();
jest.mock('../../hooks/useRankOutcome.ts', () => ({
  ...jest.requireActual('../../hooks/useRankOutcome.ts'),
  fireRankOutcome: (...args: unknown[]) => mockFireRankOutcome(...args),
}));

jest.mock('../../services/collections.ts', () => ({
  ...jest.requireActual('../../services/collections.ts'),
  saveItem:   jest.fn(async () => true),
  unsaveItem: jest.fn(async () => true),
  checkSaved: jest.fn(async () => ({ saved: false })),
}));

// NOTE: intentionally an exhaustive stub — savedPostsCache only exports
// getSaved and setSaved; spreading requireActual would pull in the real
// in-memory Map which interferes with controlled mock return values.
jest.mock('../../services/savedPostsCache.ts', () => ({
  getSaved: jest.fn(() => undefined),
  setSaved: jest.fn(),
}));

jest.mock('../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../context/SessionContext.tsx'),
  useSession: () => ({ userId: 'user-abc', isAuthed: true }),
}));

// NOTE: intentionally an exhaustive stub — SaveToCollectionSheet brings in
// heavy native dependencies that would need their own mocks.
jest.mock('../SaveToCollectionSheet.tsx', () => ({
  SaveToCollectionSheet: () => null,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION_ID = 'sess-xyz-123';
const ENTITY_ID  = 'item-001';

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockFireRankOutcome.mockClear();
});

it('calls fireRankOutcome with the correct sessionId when the user saves', async () => {
  const { getByRole } = await act(async () =>
    render(
      <SaveButton
        entityType="post"
        entityId={ENTITY_ID}
        initialSaved={false}
        sessionId={SESSION_ID}
      />,
    ),
  );

  const btn = getByRole('button');
  await act(async () => { fireEvent.press(btn); });

  await waitFor(() => {
    expect(mockFireRankOutcome).toHaveBeenCalledTimes(1);
    expect(mockFireRankOutcome).toHaveBeenCalledWith(
      ENTITY_ID,
      'pulse',
      'save',
      SESSION_ID,
    );
  });
});

it('does NOT call fireRankOutcome when the user unsaves', async () => {
  const { getByRole } = await act(async () =>
    render(
      <SaveButton
        entityType="post"
        entityId={ENTITY_ID}
        initialSaved={true}
        sessionId={SESSION_ID}
      />,
    ),
  );

  const btn = getByRole('button');
  await act(async () => { fireEvent.press(btn); });

  // Allow any async work to settle before asserting the negative.
  await act(async () => {});

  expect(mockFireRankOutcome).not.toHaveBeenCalled();
});
