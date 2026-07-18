/**
 * StampsPage — StampCategoryFilter cycling tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. Pressing each category chip (Cities, Areas, Plans, Hosted, Gems,
 *    Safe Return, Crew) shows only stamps whose `stampType` matches the
 *    chip's `kind` — confirming the filter key equals the stamp field value
 *    and no grid is silently empty due to a case/name mismatch.
 *
 * 2. Pressing "All" restores the full stamp set.
 *
 * ## Why these tests exist
 *
 * The filter compares `s.stampType === active.kind`.  A rename on either
 * side (e.g. filter kind "gem" vs stamp field "hidden_gem") produces a
 * silent empty grid — no crash, just zero rows — that looks broken to the
 * user.  These tests catch that class of regression by asserting at least
 * one stamp label is visible after each chip press.
 *
 * ## Mock strategy
 *
 * PulseFilterRail, StampArtwork, ScreenHeader, and useNavBarCollapse are
 * mocked with lightweight stand-ins.  The real implementations depend on
 * react-native-reanimated's makeMutable() and native modules that are not
 * safe to run under Jest.
 */

import React from 'react';
import { render, waitFor, screen, fireEvent } from '@testing-library/react-native';
import StampsPage from '../stamps.tsx';
import { getMyPassportStamps } from '../../src/services/passportStamps.ts';
import type { PassportStampNew } from '../../src/services/passportStamps.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — the real PulseFilterRail depends on
// react-native-reanimated's makeMutable() / useAnimatedStyle which are not
// safe under Jest.  We render a simple row of Pressable chips so the filter
// state changes in the parent (StampsPage) can be exercised.
jest.mock('../../src/components/PulseFilterRail', () => {
  const React = require('react');
  const { View, Text, Pressable } = require('react-native');
  return {
    PulseFilterRail: ({
      filters,
      onPress,
    }: {
      filters: string[];
      active: string[];
      onPress: (f: string) => void;
    }) =>
      React.createElement(
        View,
        { testID: 'filter-rail' },
        filters.map((f: string) =>
          React.createElement(
            Pressable,
            { key: f, testID: `filter-chip-${f}`, onPress: () => onPress(f) },
            React.createElement(Text, null, f),
          ),
        ),
      ),
  };
});

// NOTE: intentionally exhaustive — StampArtwork pulls in StampCard, StampIcon,
// StampDetailArtwork, IllustratedStamp, and Image which require native modules
// not available under Jest.  A minimal View with testID is enough for these tests.
jest.mock('../../src/components/StampArtwork', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    StampArtwork: ({ stamp }: { stamp: { label: string } }) =>
      React.createElement(View, { testID: `stamp-artwork-${stamp.label}` }),
  };
});

// NOTE: intentionally exhaustive — ScreenHeader uses expo-router internals
// and safe-area hooks; the global expo-router mock already covers router.*
// but requireActual would still pull native bridging code.
jest.mock('../../src/components/ScreenHeader', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { ScreenHeader: () => React.createElement(View, { testID: 'screen-header' }) };
});

// NOTE: intentionally exhaustive — useNavBarCollapse calls makeMutable() at
// module scope (outside React), which is not supported under Jest.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => undefined,
  NavBarFiller: () => null,
}));

jest.mock('../../src/services/passportStamps', () => ({
  ...jest.requireActual('../../src/services/passportStamps'),
  getMyPassportStamps: jest.fn(),
  updateStampVisibility: jest.fn(),
}));

// ── Typed mock ref ─────────────────────────────────────────────────────────────

const mockGetStamps = getMyPassportStamps as jest.Mock;

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeStamp(id: string, stampType: string, city: string): PassportStampNew {
  return {
    id,
    stampDefinitionId: null,
    definition: null,
    stampType,
    country: 'PH',
    city,
    neighborhood: null,
    titleOverride: null,
    placeId: null,
    planId: null,
    tripId: null,
    sourceType: 'trip',
    verificationLevel: 'gps',
    visibility: 'public',
    displayOnPassport: true,
    isRevoked: false,
    earnedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    catalogId: null,
    activeArtworkUrl: null,
    universalArtworkUrl: null,
  } as unknown as PassportStampNew;
}

// One stamp per FILTERS kind — at least 4 categories required by the spec.
const STAMP_CITY        = makeStamp('s1', 'city',        'Cebu');
const STAMP_NEIGHBORHOOD = makeStamp('s2', 'neighborhood', 'BGC');
const STAMP_PLAN        = makeStamp('s3', 'plan',        'Palawan');
const STAMP_HOST        = makeStamp('s4', 'host',        'Siargao');
const STAMP_GEM         = makeStamp('s5', 'hidden_gem',  'Batanes');
const STAMP_SAFE        = makeStamp('s6', 'safe_return', 'Davao');
const STAMP_CREW        = makeStamp('s7', 'trip_crew',   'Boracay');

const ALL_STAMPS = [
  STAMP_CITY,
  STAMP_NEIGHBORHOOD,
  STAMP_PLAN,
  STAMP_HOST,
  STAMP_GEM,
  STAMP_SAFE,
  STAMP_CREW,
];

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('StampsPage — StampCategoryFilter cycling', () => {
  beforeEach(() => {
    mockGetStamps.mockResolvedValue({ ok: true, data: ALL_STAMPS });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows all stamps initially (All filter)', async () => {
    await render(<StampsPage />);
    await waitFor(() => screen.getByText('Cebu'));

    // Every city label derived by toLegacy must be visible.
    expect(screen.getByText('Cebu')).toBeTruthy();
    expect(screen.getByText('BGC')).toBeTruthy();
    expect(screen.getByText('Palawan')).toBeTruthy();
    expect(screen.getByText('Siargao')).toBeTruthy();
    expect(screen.getByText('Batanes')).toBeTruthy();
    expect(screen.getByText('Davao')).toBeTruthy();
    expect(screen.getByText('Boracay')).toBeTruthy();
  });

  it('Cities chip shows only city stamps — not an empty grid', async () => {
    await render(<StampsPage />);
    await waitFor(() => screen.getByText('Cebu'));

    fireEvent.press(screen.getByTestId('filter-chip-Cities'));

    await waitFor(() => screen.getByText('Cebu'));
    expect(screen.getByText('Cebu')).toBeTruthy();

    // Other-category stamps must not appear.
    expect(screen.queryByText('BGC')).toBeNull();
    expect(screen.queryByText('Palawan')).toBeNull();
  });

  it('Areas chip shows only neighborhood stamps — not an empty grid', async () => {
    await render(<StampsPage />);
    await waitFor(() => screen.getByText('BGC'));

    fireEvent.press(screen.getByTestId('filter-chip-Areas'));

    await waitFor(() => screen.getByText('BGC'));
    expect(screen.getByText('BGC')).toBeTruthy();
    expect(screen.queryByText('Cebu')).toBeNull();
  });

  it('Plans chip shows only plan stamps — not an empty grid', async () => {
    await render(<StampsPage />);
    await waitFor(() => screen.getByText('Palawan'));

    fireEvent.press(screen.getByTestId('filter-chip-Plans'));

    await waitFor(() => screen.getByText('Palawan'));
    expect(screen.getByText('Palawan')).toBeTruthy();
    expect(screen.queryByText('Cebu')).toBeNull();
  });

  it('Hosted chip shows only host stamps — not an empty grid', async () => {
    await render(<StampsPage />);
    await waitFor(() => screen.getByText('Siargao'));

    fireEvent.press(screen.getByTestId('filter-chip-Hosted'));

    await waitFor(() => screen.getByText('Siargao'));
    expect(screen.getByText('Siargao')).toBeTruthy();
    expect(screen.queryByText('Cebu')).toBeNull();
  });

  it('Gems chip shows only hidden_gem stamps — not an empty grid', async () => {
    await render(<StampsPage />);
    await waitFor(() => screen.getByText('Batanes'));

    fireEvent.press(screen.getByTestId('filter-chip-Gems'));

    await waitFor(() => screen.getByText('Batanes'));
    expect(screen.getByText('Batanes')).toBeTruthy();
    expect(screen.queryByText('Cebu')).toBeNull();
  });

  it('Safe Return chip shows only safe_return stamps — not an empty grid', async () => {
    await render(<StampsPage />);
    await waitFor(() => screen.getByText('Davao'));

    fireEvent.press(screen.getByTestId('filter-chip-Safe Return'));

    await waitFor(() => screen.getByText('Davao'));
    expect(screen.getByText('Davao')).toBeTruthy();
    expect(screen.queryByText('Cebu')).toBeNull();
  });

  it('Crew chip shows only trip_crew stamps — not an empty grid', async () => {
    await render(<StampsPage />);
    await waitFor(() => screen.getByText('Boracay'));

    fireEvent.press(screen.getByTestId('filter-chip-Crew'));

    await waitFor(() => screen.getByText('Boracay'));
    expect(screen.getByText('Boracay')).toBeTruthy();
    expect(screen.queryByText('Cebu')).toBeNull();
  });

  it('pressing All after a category filter restores the full stamp set', async () => {
    await render(<StampsPage />);
    await waitFor(() => screen.getByText('Cebu'));

    // Narrow to Cities first.
    fireEvent.press(screen.getByTestId('filter-chip-Cities'));
    await waitFor(() => expect(screen.queryByText('BGC')).toBeNull());

    // Restore All.
    fireEvent.press(screen.getByTestId('filter-chip-All'));

    await waitFor(() => screen.getByText('BGC'));
    expect(screen.getByText('Cebu')).toBeTruthy();
    expect(screen.getByText('BGC')).toBeTruthy();
    expect(screen.getByText('Palawan')).toBeTruthy();
    expect(screen.getByText('Siargao')).toBeTruthy();
    expect(screen.getByText('Batanes')).toBeTruthy();
    expect(screen.getByText('Davao')).toBeTruthy();
    expect(screen.getByText('Boracay')).toBeTruthy();
  });

  it('cycling through multiple categories in sequence never shows an empty grid', async () => {
    await render(<StampsPage />);
    await waitFor(() => screen.getByText('Cebu'));

    const sequence: Array<{ chip: string; expected: string }> = [
      { chip: 'Cities',      expected: 'Cebu'    },
      { chip: 'Plans',       expected: 'Palawan' },
      { chip: 'Gems',        expected: 'Batanes' },
      { chip: 'Hosted',      expected: 'Siargao' },
      { chip: 'Safe Return', expected: 'Davao'   },
      { chip: 'Crew',        expected: 'Boracay' },
      { chip: 'Areas',       expected: 'BGC'     },
    ];

    for (const { chip, expected } of sequence) {
      fireEvent.press(screen.getByTestId(`filter-chip-${chip}`));
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => screen.getByText(expected));
      expect(screen.getByText(expected)).toBeTruthy();
    }
  });
});
