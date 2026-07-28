/**
 * StampShowcase — StampsTab wiring tests
 *
 * Covers:
 *  1. Showcase row renders when getMyShowcase returns items;
 *     Edit button opens the curation sheet; Cancel closes it.
 *  2. null return hides the showcase slot (flag off)
 *  3. Empty-state card shown when flag is on but no items curated;
 *     tapping it opens the curation sheet.
 *  4. getMyShowcase not called for non-owner profiles
 *
 * NOTE: Direct StampShowcaseCurationSheet tests (save, revert, select/deselect)
 * live in StampShowcaseCuration.component.test.tsx — separated to satisfy the
 * two-file Modal rule (see .agents/memory/modal-proxy-mock.md).
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react-native';
import { StampsTab } from '../StampsTab.tsx';

// ── Service mocks ─────────────────────────────────────────────────────────────

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

// NOTE: intentionally exhaustive — StampShowcaseRow calls AccessibilityInfo and
// Animated native modules; stub surfaces the SHOWCASE kicker and Edit button
// so wiring tests remain shallow. Item names are NOT rendered here to avoid
// ambiguity with the stamp grid below (see "multiple Alpha" pitfall).
jest.mock('../stamps/StampShowcaseRow', () => {
  const { Text, Pressable, View } = require('react-native');
  return {
    StampShowcaseRow: ({ items, onEdit }: { items: any[]; onEdit?: () => void }) => (
      <View testID="showcase-row">
        <Text>SHOWCASE</Text>
        <Text testID="showcase-count">{items.length}</Text>
        {onEdit ? (
          <Pressable onPress={onEdit} accessibilityRole="button" accessibilityLabel="Edit showcase">
            <Text>Edit</Text>
          </Pressable>
        ) : null}
      </View>
    ),
    StampShowcaseEmptyCard: ({ onEdit }: { onEdit: () => void }) => (
      <Pressable
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel="Feature your favorite stamps"
      >
        <Text>Feature your favorite stamps</Text>
      </Pressable>
    ),
  };
});

// NOTE: FeatureFlagsContext fetches from the API on mount; stub returns all
// flags enabled so the showcase gate passes. Server-side (getMyShowcase→null)
// hiding is tested separately via mockGetMyShowcase return values below.
jest.mock('../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, loading: false }),
}));

// NOTE: intentionally exhaustive — StampShowcaseCurationSheet imports Modal,
// PanResponder, and native image modules; stub surfaces just enough to assert
// open/close wiring in StampsTab. Full sheet tests live in the companion file.
jest.mock('../stamps/StampShowcaseCurationSheet', () => {
  const { Text, Pressable, View } = require('react-native');
  return {
    StampShowcaseCurationSheet: ({
      visible, onClose,
    }: { visible: boolean; stamps: any[]; currentIds: string[]; onClose: () => void; onSaved: (ids: string[]) => void }) => {
      if (!visible) return null;
      return (
        <View testID="curation-sheet">
          <Text>Feature your stamps</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={onClose}>
            <Text>Cancel</Text>
          </Pressable>
        </View>
      );
    },
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeStamp(id: string, name = `Stamp ${id}`) {
  return {
    id,
    stampType: 'location',
    city: 'Lisbon',
    country: 'Portugal',
    visibility: 'public',
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

const STAMPS = [makeStamp('s1', 'Alpha'), makeStamp('s2', 'Beta'), makeStamp('s3', 'Gamma')];
const SHOWCASE_ITEMS = [makeShowcaseItem('s1', 1, 'Alpha'), makeShowcaseItem('s2', 2, 'Beta')];

async function renderOwnerTab() {
  mockGetMyPassportStamps.mockResolvedValue({ ok: true, data: STAMPS, total: STAMPS.length });
  // await render is required — sync render leaves screen unbound in this RNTL
  // setup (see .agents/memory/rntl-async-render.md).
  await render(<StampsTab stamps={[]} isOwner viewingUserId="user-1" />);
  // Two flushes: first settles the passportStamps effect, second settles
  // the getMyShowcase effect (separate useEffect, separate microtask queue).
  await act(async () => {});
  await act(async () => {});
}

// ── Tests (4 renders — within budget) ────────────────────────────────────────

describe('StampShowcase — StampsTab wiring', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('renders showcase row; Edit button opens curation sheet; Cancel closes it', async () => {
    // Combines row-renders and open/close assertions into one render.
    // Uses act-wrapped presses (no standalone post-press await) to avoid the
    // post-press-flush poison (see .agents/memory/rntl-react19-renderer-budget.md).
    mockGetMyShowcase.mockResolvedValue(SHOWCASE_ITEMS);
    await renderOwnerTab();

    // Row is visible with the correct item count.
    expect(screen.getByTestId('showcase-row')).toBeTruthy();
    expect(screen.getByText('SHOWCASE')).toBeTruthy();
    expect(screen.getByTestId('showcase-count').props.children).toBe(2);

    // Act-wrap each press so the state commit runs without poisoning later presses.
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: /edit showcase/i }));
    });
    expect(screen.getByTestId('curation-sheet')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: /cancel/i }));
    });
    expect(screen.queryByTestId('curation-sheet')).toBeNull();
  });

  it('hides showcase when getMyShowcase returns null (flag off)', async () => {
    mockGetMyShowcase.mockResolvedValue(null);
    await renderOwnerTab();

    expect(screen.queryByTestId('showcase-row')).toBeNull();
    expect(screen.queryByText('Feature your favorite stamps')).toBeNull();
  });

  it('shows empty-state card when flag on + empty; tapping it opens curation sheet', async () => {
    mockGetMyShowcase.mockResolvedValue([]);
    await renderOwnerTab();

    expect(screen.queryByTestId('showcase-row')).toBeNull();
    expect(screen.getByText('Feature your favorite stamps')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: /feature your favorite stamps/i }));
    });
    expect(screen.getByTestId('curation-sheet')).toBeTruthy();
  });

  it('does not call getMyShowcase for a viewed (non-owner) profile', async () => {
    mockGetUserStampsByUsername.mockResolvedValue({ ok: true, data: STAMPS });
    await render(<StampsTab viewingUsername="someone" />);
    await act(async () => {});
    await act(async () => {});

    expect(mockGetMyShowcase).not.toHaveBeenCalled();
    expect(screen.queryByTestId('showcase-row')).toBeNull();
  });
});
