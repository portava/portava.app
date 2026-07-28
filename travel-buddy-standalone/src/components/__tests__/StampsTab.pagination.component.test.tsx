/**
 * StampsTab — infinite-scroll pagination
 *
 * Confirms the owner stamps grid pages through all stamps:
 *  - initial load fetches page 1 and reads the server-reported total
 *  - loadMore (exposed via loadMoreRef for the parent scroll view) fetches
 *    the next page with the correct offset and appends the results
 *  - once stamps.length === total, further loadMore calls are no-ops
 *  - a loading indicator renders while a page fetch is in flight
 *  - the owner Passport tab wiring in (tabs)/passport.tsx keeps StampsTab in
 *    owner mode (a truthy viewingUsername would force the unpaginated
 *    public-profile fetch path and short-circuit loadMore)
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
import { act, render, screen } from '@testing-library/react-native';
import { StampsTab } from '../StampsTab.tsx';

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockGetMyPassportStamps = jest.fn();
const mockGetUserStampsByUsername = jest.fn();

// NOTE: intentionally exhaustive — services/passportStamps imports Supabase and
// the API token stack; requireActual would pull in the live network graph.
jest.mock('../../services/passportStamps', () => ({
  getMyPassportStamps: (...args: unknown[]) => mockGetMyPassportStamps(...args),
  getUserStampsByUsername: (...args: unknown[]) => mockGetUserStampsByUsername(...args),
  getPassportStats: jest.fn().mockResolvedValue({ ok: true, data: { stampsEarned: 0, milestones: [] } }),
}));

// NOTE: intentionally exhaustive — services/stamps imports Supabase;
// requireActual would cause OOM. Only getMyProgress is used by StampsTab.
jest.mock('../../services/stamps', () => ({
  getMyProgress: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentionally exhaustive — BlockedIdsContext pulls Supabase realtime;
// only the hook return value is needed here.
jest.mock('../../context/BlockedIdsContext', () => ({
  useBlockedIds: () => ({ blockedIds: new Set(), blockerIds: new Set() }),
}));

// ── Heavy sub-component stubs (null renders, no native side-effects) ──────────

// NOTE: intentionally exhaustive — imports native scroll/SVG modules that
// crash under jest-expo; the filter UI is irrelevant to pagination.
jest.mock('../stamps/StampCategoryFilter', () => ({
  StampCategoryFilter: () => null,
}));
// NOTE: intentionally exhaustive — the real grid imports native image/SVG
// modules; this stub surfaces only the item count needed by the assertions.
jest.mock('../stamps/StampGrid', () => ({
  StampGrid: ({ stamps }: { stamps: unknown[] }) => {
    const { Text } = require('react-native');
    return <Text testID="grid-count">{stamps.length}</Text>;
  },
}));
// NOTE: intentionally exhaustive — StampCard imports native SVG; only the pure
// toLegacy converter is used by StampsTab.
jest.mock('../stamps/StampCard', () => ({
  toLegacy: (s: any) => ({ id: s.id, label: s.definition?.name ?? s.id }),
}));
// NOTE: intentionally exhaustive — imports native SVG/image modules.
jest.mock('../stamps/UniversalStampArtwork', () => ({
  UniversalStampArtwork: () => null,
}));
// NOTE: intentionally exhaustive — imports native Modal/share modules.
jest.mock('../stamps/StampDetailModal', () => ({
  StampDetailModal: () => null,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeStamp(id: string) {
  return {
    id,
    stampType: 'location',
    city: 'Lisbon',
    country: 'Portugal',
    visibility: 'public',
    isRevoked: false,
    earnedAt: '2026-07-01T00:00:00Z',
    activeArtworkUrl: null,
    definition: { name: `Stamp ${id}`, category: 'location' },
  };
}

const PAGE_1 = [makeStamp('a'), makeStamp('b')];
const PAGE_2 = [makeStamp('c')];
const TOTAL = 3;

/** The exact owner-mode props (tabs)/passport.tsx passes — no viewingUsername. */
function renderOwnerTab(loadMoreRef: React.MutableRefObject<(() => void) | null>) {
  return render(
    <StampsTab stamps={[]} isOwner viewingUserId="user-test-1" loadMoreRef={loadMoreRef} />,
  );
}

describe('StampsTab — pagination (owner mode, as wired by passport.tsx)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads page 1, appends page 2 at the right offset, then stops at total', async () => {
    mockGetMyPassportStamps
      .mockResolvedValueOnce({ ok: true, data: PAGE_1, total: TOTAL })
      .mockResolvedValueOnce({ ok: true, data: PAGE_2, total: TOTAL });

    const loadMoreRef: React.MutableRefObject<(() => void) | null> = { current: null };

    await renderOwnerTab(loadMoreRef);
    await act(async () => {});

    // Owner mode hits the paginated /stamps/me path, not the public one.
    expect(mockGetMyPassportStamps).toHaveBeenCalledTimes(1);
    expect(mockGetUserStampsByUsername).not.toHaveBeenCalled();
    // Page 1 loaded (featured stamp is pulled out of the grid: 2 - 1 = 1).
    expect(screen.getByTestId('grid-count').props.children).toBe(1);
    // Header count uses the server total, not just the loaded page.
    expect(screen.getByText(`${TOTAL} stamps`)).toBeTruthy();

    // Parent scroll view triggers load-more → fetches with offset = loaded count.
    await act(async () => { loadMoreRef.current?.(); });

    expect(mockGetMyPassportStamps).toHaveBeenCalledTimes(2);
    expect(mockGetMyPassportStamps).toHaveBeenLastCalledWith({ offset: PAGE_1.length });
    // All 3 stamps present (3 - 1 featured = 2 in the grid).
    expect(screen.getByTestId('grid-count').props.children).toBe(2);

    // stamps.length === total → further calls are no-ops (sentinel, not heuristics).
    await act(async () => { loadMoreRef.current?.(); });
    expect(mockGetMyPassportStamps).toHaveBeenCalledTimes(2);
  });

  it('shows a loading indicator while a page fetch is in flight', async () => {
    let resolvePage2: (v: unknown) => void = () => {};
    mockGetMyPassportStamps
      .mockResolvedValueOnce({ ok: true, data: PAGE_1, total: TOTAL })
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePage2 = resolve; }));

    const loadMoreRef: React.MutableRefObject<(() => void) | null> = { current: null };

    await renderOwnerTab(loadMoreRef);
    await act(async () => {});

    expect(screen.queryByTestId('stamps-loading-more')).toBeNull();

    await act(async () => { loadMoreRef.current?.(); });
    expect(screen.getByTestId('stamps-loading-more')).toBeTruthy();

    // A second trigger while in flight does not double-fetch.
    await act(async () => { loadMoreRef.current?.(); });
    expect(mockGetMyPassportStamps).toHaveBeenCalledTimes(2);

    await act(async () => { resolvePage2({ ok: true, data: PAGE_2, total: TOTAL }); });
    expect(screen.queryByTestId('stamps-loading-more')).toBeNull();
  });

  it('public-profile mode (viewingUsername) never calls the paginated owner path', async () => {
    mockGetUserStampsByUsername.mockResolvedValue({ ok: true, data: PAGE_1 });

    const loadMoreRef: React.MutableRefObject<(() => void) | null> = { current: null };
    await render(<StampsTab viewingUsername="someone" loadMoreRef={loadMoreRef} />);
    await act(async () => {});

    expect(mockGetUserStampsByUsername).toHaveBeenCalledTimes(1);
    // loadMore is a documented no-op on the public path.
    await act(async () => { loadMoreRef.current?.(); });
    expect(mockGetMyPassportStamps).not.toHaveBeenCalled();
  });
});

describe('passport.tsx wiring — owner Stamps tab stays on the paginated path', () => {
  it('mounts StampsTab in owner mode (isOwner + loadMoreRef, no viewingUsername)', () => {
    // Regression tripwire: a truthy viewingUsername on the owner tab silently
    // reroutes StampsTab to the unpaginated public endpoint and disables
    // infinite scroll. Assert the owner wiring at the source level.
    const src = fs.readFileSync(
      path.join(__dirname, '../../../app/(tabs)/passport.tsx'),
      'utf8',
    );
    const stampsTabJsx = src.match(/<StampsTab[\s\S]*?\/>/g) ?? [];
    expect(stampsTabJsx.length).toBeGreaterThan(0);
    for (const block of stampsTabJsx) {
      expect(block).not.toContain('viewingUsername=');
      expect(block).toContain('isOwner');
      expect(block).toContain('loadMoreRef={stampsLoadMoreRef}');
    }
  });
});
