/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B36): a bookmark whose saved state could not be read is
 * drawn as unknown and says so, never as "not saved".
 *
 * `savedUnknown` is set by a caller whose feed named the viewer's save read as failed (GET /pulse `post_saves`). The
 * button then says "Couldn't check if saved", is not a toggle (a tap cannot know which way it would go), and asks the
 * server nothing. The viewer's own toggle this session (the saved-posts cache) is measured and wins.
 *
 *   SU0 savedUnknown → "Couldn't check if saved"; never "Save" or "Unsave"
 *   SU1 savedUnknown, tapped → nothing saved or unsaved, no round-trip
 *   SU2 CONTROL: known not saved → "Save"
 *   SU3 savedUnknown beside the viewer's own toggle in the cache → "Unsave" (the toggle is measured)
 *   SU4 savedUnknown with no initial value → unknown at once, no spinner and no round-trip whose failure would say "Save"
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SaveButton } from '../SaveButton.tsx';

const mockSaveItem = jest.fn(async () => true);
const mockUnsaveItem = jest.fn(async () => true);
const mockCheckSaved = jest.fn(async () => ({ saved: false, collectionIds: [] }));
jest.mock('../../services/collections.ts', () => ({
  ...jest.requireActual('../../services/collections.ts'),
  saveItem: (...a: unknown[]) => mockSaveItem(...(a as [])),
  unsaveItem: (...a: unknown[]) => mockUnsaveItem(...(a as [])),
  checkSaved: (...a: unknown[]) => mockCheckSaved(...(a as [])),
}));
const mockGetSaved = jest.fn((): boolean | undefined => undefined);
// NOTE: intentionally an exhaustive stub — savedPostsCache only exports getSaved and setSaved; the real Map would leak between tests.
jest.mock('../../services/savedPostsCache.ts', () => ({
  getSaved: () => mockGetSaved(),
  setSaved: jest.fn(),
}));
jest.mock('../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../context/SessionContext.tsx'),
  useSession: () => ({ userId: 'user-abc', isAuthed: true }),
}));
// NOTE: intentionally an exhaustive stub — SaveToCollectionSheet brings in heavy native dependencies.
jest.mock('../SaveToCollectionSheet.tsx', () => ({ SaveToCollectionSheet: () => null }));
jest.mock('../../hooks/useRankOutcome.ts', () => ({
  ...jest.requireActual('../../hooks/useRankOutcome.ts'),
  fireRankOutcome: jest.fn(),
}));

beforeEach(() => { jest.clearAllMocks(); mockGetSaved.mockImplementation(() => undefined); });

describe('census-discovery §122 (B36): SaveButton over an unread save state', () => {
  it('SU0 savedUnknown → "Couldn\'t check if saved", never "Save" or "Unsave"', async () => {
    await render(<SaveButton entityType="post" entityId="p1" initialSaved={false} savedUnknown />);
    expect(screen.getByLabelText("Couldn't check if saved")).toBeTruthy();
    expect(screen.queryByLabelText('Save')).toBeNull();
    expect(screen.queryByLabelText('Unsave')).toBeNull();
  });
  it('SU1 savedUnknown, tapped → nothing saved or unsaved, no round-trip', async () => {
    await render(<SaveButton entityType="post" entityId="p1" initialSaved={false} savedUnknown />);
    await fireEvent.press(screen.getByLabelText("Couldn't check if saved"));
    expect(mockSaveItem).not.toHaveBeenCalled();
    expect(mockUnsaveItem).not.toHaveBeenCalled();
    expect(mockCheckSaved).not.toHaveBeenCalled();
  });
  it('SU2 CONTROL: known not saved → "Save"', async () => {
    await render(<SaveButton entityType="post" entityId="p1" initialSaved={false} />);
    expect(screen.getByLabelText('Save')).toBeTruthy();
    expect(screen.queryByLabelText("Couldn't check if saved")).toBeNull();
  });
  it("SU3 savedUnknown beside the viewer's own toggle in the cache → \"Unsave\"", async () => {
    mockGetSaved.mockImplementation(() => true);
    await render(<SaveButton entityType="post" entityId="p1" initialSaved={false} savedUnknown />);
    expect(screen.getByLabelText('Unsave')).toBeTruthy();
  });
  it('SU4 savedUnknown with no initial value → unknown at once, no round-trip', async () => {
    await render(<SaveButton entityType="post" entityId="p1" savedUnknown />);
    expect(screen.getByLabelText("Couldn't check if saved")).toBeTruthy();
    expect(mockCheckSaved).not.toHaveBeenCalled();
  });
});
