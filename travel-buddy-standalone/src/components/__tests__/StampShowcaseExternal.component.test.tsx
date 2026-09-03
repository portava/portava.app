/**
 * StampShowcase — external-data (owner) mode wiring
 *
 * Verifies that getMyShowcase() IS called — and the showcase row renders —
 * when StampsTab is mounted with `data={stamps}` (external pipeline mode),
 * which is how app/(tabs)/passport.tsx uses it.
 *
 * Kept in its own file (fresh renderer, fresh render-count budget) so the
 * 5-render limit of the sibling StampShowcase.component.test.tsx is not
 * consumed by this additional scenario.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { StampsTab } from '../StampsTab.tsx';

// ── Service mocks (identical to StampShowcase.component.test.tsx) ─────────────

const mockGetMyPassportStamps = jest.fn();
const mockGetUserStampsByUsername = jest.fn();
const mockGetMyShowcase = jest.fn();

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

// NOTE: intentionally exhaustive — stampShowcase imports Supabase/apiToken stack.
jest.mock('../../services/stampShowcase', () => ({
  getMyShowcase: (...args: unknown[]) => mockGetMyShowcase(...args),
  saveShowcase: jest.fn().mockResolvedValue(true),
  MAX_SHOWCASE: 8,
}));

// NOTE: intentionally exhaustive — imports native scroll/SVG modules.
jest.mock('../stamps/StampCategoryFilter', () => ({
  StampCategoryFilter: () => null,
}));

// NOTE: intentionally exhaustive — the real grid imports native image/SVG modules.
jest.mock('../stamps/StampGrid', () => ({
  StampGrid: ({ stamps }: { stamps: unknown[] }) => {
    const { Text } = require('react-native');
    return <Text testID="grid-count">{stamps.length}</Text>;
  },
}));

// NOTE: intentionally exhaustive — imports native SVG.
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

// NOTE: FeatureFlagsContext fetches from the API on mount; stub returns all
// flags enabled so the showcase gate passes. Server-side (getMyShowcase→null)
// hiding is tested separately via mockGetMyShowcase return values.
jest.mock('../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, loading: false }),
}));

// NOTE: intentionally exhaustive — StampShowcaseRow calls AccessibilityInfo and
// Animated native modules. Stub surfaces testID and count so this file can
// assert visibility without ambiguity.
jest.mock('../stamps/StampShowcaseRow', () => {
  const { Text, View } = require('react-native');
  return {
    StampShowcaseRow: ({ items }: { items: any[] }) => (
      <View testID="showcase-row">
        <Text testID="showcase-count">{items.length}</Text>
      </View>
    ),
    StampShowcaseEmptyCard: () => (
      <View testID="showcase-empty-card" />
    ),
  };
});

// NOTE: intentionally exhaustive — imports Modal/PanResponder/native image modules.
jest.mock('../stamps/StampShowcaseCurationSheet', () => ({
  StampShowcaseCurationSheet: () => null,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeStamp(id: string, name = `Stamp ${id}`) {
  return {
    id,
    stampType: 'location',
    city: 'Lisbon',
    country: 'Portugal',
    // `as const` so the literal narrows to StampVisibility rather than widening
    // to `string`, which PassportStampNew does not accept.
    visibility: 'public' as const,
    isRevoked: false,
    earnedAt: '2026-07-01T00:00:00Z',
    activeArtworkUrl: null,
    titleOverride: null,
    definition: {
      slug: `slug-${id}`, name, rarity: 'common' as const,
      stampType: 'location', category: 'location',
      universalArtworkUrl: null, iconUrl: null, description: null,
    },
    stampDefinitionId: `def-${id}`, neighborhood: null, placeId: null,
    planId: null, tripId: null, sourceType: 'system',
    verificationLevel: 'verified', displayOnPassport: true,
    catalogId: null, createdAt: '2026-07-01T00:00:00Z',
  };
}

function makeShowcaseItem(userStampId: string, rank: number, name: string) {
  return {
    userStampId, rank,
    earnedAt: '2026-07-01T00:00:00Z', city: 'Tokyo', country: 'Japan',
    titleOverride: null,
    definition: {
      slug: `slug-${userStampId}`, name, rarity: 'rare',
      stampType: 'location', category: 'location', artworkUrl: null,
    },
  };
}

const STAMPS = [makeStamp('s1', 'Alpha'), makeStamp('s2', 'Beta')];
const SHOWCASE_ITEMS = [makeShowcaseItem('s1', 1, 'Alpha'), makeShowcaseItem('s2', 2, 'Beta')];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StampShowcase — external-data (owner) mode', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('calls getMyShowcase and renders the showcase row when StampsTab is in external (data=) mode', async () => {
    // This covers the main path in app/(tabs)/passport.tsx which passes
    // data={stampsNew} to StampsTab (external mode). The external flag must NOT
    // prevent showcase loading for the owner (see .agents/memory/ note on the
    // external guard removal).
    mockGetMyShowcase.mockResolvedValue(SHOWCASE_ITEMS);

    await render(
      // Mirror of how passport.tsx mounts StampsTab for the owner:
      //   <StampsTab isOwner data={stampsNew} ... />
      <StampsTab
        stamps={[]}
        isOwner
        viewingUserId="user-1"
        data={STAMPS}
        dataTotal={STAMPS.length}
      />,
    );
    // Two flushes: first settles any sync effects; second settles the
    // getMyShowcase async effect + the subsequent setShowcase setState.
    await act(async () => {});
    await act(async () => {});

    // getMyShowcase must be called even in external mode.
    expect(mockGetMyShowcase).toHaveBeenCalledTimes(1);

    // Showcase row must be visible (flag is on, items returned).
    expect(screen.getByTestId('showcase-row')).toBeTruthy();
    expect(screen.getByTestId('showcase-count').props.children).toBe(2);
  });

  it('shows the empty-state card in external mode when flag is on but no items', async () => {
    mockGetMyShowcase.mockResolvedValue([]);

    await render(
      <StampsTab
        stamps={[]}
        isOwner
        viewingUserId="user-1"
        data={STAMPS}
        dataTotal={STAMPS.length}
      />,
    );
    await act(async () => {});
    await act(async () => {});

    expect(mockGetMyShowcase).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('showcase-row')).toBeNull();
    expect(screen.getByTestId('showcase-empty-card')).toBeTruthy();
  });
});
