/**
 * StampStrip — stamp count badge stays accurate after earning a new stamp.
 *
 * The "N earned" badge is derived directly from the stamps prop on every
 * render.  If the parent passes a stale cached slice the badge freezes at
 * the old count.  This test confirms the badge updates when the parent
 * re-renders with a larger stamps array — simulating a new earn event.
 *
 * Run with: pnpm test:component
 *
 * ## Mock strategy
 *
 * StampStrip renders StampBadge children (which call motifFor / lucide icons)
 * and wraps navigation in a Pressable that calls router.push.  All three
 * surfaces are stubbed so the test focuses purely on the count text, with no
 * native-module side-effects.
 *
 * lucide-react-native is NOT mocked inline here — the file-level Proxy in
 * src/__mocks__/lucide-react-native.tsx handles every icon name.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { StampStrip } from '../PassportStamps.tsx';
import type { PassportStamp } from '../../types/models.ts';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — expo-router is a native package; pulling
// requireActual would drag in native modules that crash the jest-expo runner.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect:       (_cb: unknown) => {},
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: (_props: unknown) => null,
  Stack:    { Screen: (_props: unknown) => null },
  Tabs:     { Screen: (_props: unknown) => null },
}));

// ── stampMotif ────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — motifFor reads a large city-map constant and
// can import modules that pull in native-incompatible dependencies under jest.
// StampBadge only needs enough from the motif to render without crashing.
jest.mock('../../lib/stampMotif', () => ({
  motifFor: () => ({
    iconKey: 'MapPin',
    accent:  '#888',
    frame:   'rect',
    caption: null,
  }),
}));

// ── IllustratedStamp ──────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — IllustratedStamp imports SVG assets and
// native image libraries unavailable in the jest-expo runner.  StampStrip does
// not use it directly, but the module is imported at the top of PassportStamps
// and would crash the runner if pulled in via requireActual.
jest.mock('../IllustratedStamp', () => ({
  IllustratedStamp: () => null,
  CITY_ART:         {},
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeStamp(id: string, locked = false): PassportStamp {
  return {
    id,
    kind:     'city',
    label:    id.toUpperCase(),
    earnedAt: '2026-01-01T00:00:00Z',
    locked,
  };
}

const INITIAL_STAMPS: PassportStamp[] = [
  makeStamp('cebu'),
  makeStamp('paris'),
];

const AFTER_EARN_STAMPS: PassportStamp[] = [
  ...INITIAL_STAMPS,
  makeStamp('tokyo'), // newly earned stamp
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StampStrip — count badge stays accurate after earning a new stamp', () => {
  it('shows the initial earned count then updates when a new stamp is added', async () => {
    const { getByText, rerender } = await render(
      <StampStrip stamps={INITIAL_STAMPS} />,
    );

    // Initial render: 2 unlocked stamps → "2 earned"
    await waitFor(() => {
      expect(getByText('2 earned')).toBeTruthy();
    });

    // Parent re-renders with a larger array — simulates a new earn event.
    rerender(<StampStrip stamps={AFTER_EARN_STAMPS} />);

    // Badge must update to the new count, not stay frozen at 2.
    await waitFor(() => {
      expect(getByText('3 earned')).toBeTruthy();
    });
  });

  it('does not count locked stamps toward the earned total', async () => {
    const stampsWithLocked: PassportStamp[] = [
      makeStamp('cebu'),
      makeStamp('paris'),
      makeStamp('locked-city', true), // locked — should not count
    ];

    const { getByText, rerender } = await render(
      <StampStrip stamps={stampsWithLocked} />,
    );

    // 2 earned (the locked one is excluded)
    await waitFor(() => {
      expect(getByText('2 earned')).toBeTruthy();
    });

    // Earn the previously-locked stamp.
    const afterUnlock: PassportStamp[] = [
      makeStamp('cebu'),
      makeStamp('paris'),
      makeStamp('locked-city', false), // now unlocked
    ];

    rerender(<StampStrip stamps={afterUnlock} />);

    // Count must rise to 3 once the stamp is unlocked.
    await waitFor(() => {
      expect(getByText('3 earned')).toBeTruthy();
    });
  });
});
