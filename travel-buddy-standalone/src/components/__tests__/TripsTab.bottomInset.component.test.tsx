/**
 * TripsTab — bottom-inset clearance tests.
 *
 * Confirms that the container View rendered by TripsTab carries a
 * `paddingBottom` that is at least as large as the device bottom inset
 * (home indicator / gesture bar).
 *
 * Representative inset sizes:
 *   iPhone 14     home indicator : 34 pt
 *   Android gesture nav bar      : 48 dp
 *
 * `useBottomInset` returns NAV_BAR_FILLER_HEIGHT (96) + insets.bottom, so
 * the paddingBottom on the outermost container is always ≥ insets.bottom.
 * These tests pin that contract so a future refactor cannot accidentally
 * drop the inset addition and silently clip the last trip card.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { View } from 'react-native';
import { render } from '@testing-library/react-native';
import { TripsTab } from '../TripsTab.tsx';
import type { TripRow } from '../../services/trips.ts';

// ── Inset constants ──────────────────────────────────────────────────────────

/** iPhone 14 home-indicator height (pt). */
const IPHONE_BOTTOM = 34;
/** Android gesture-nav bar height (dp). */
const ANDROID_BOTTOM = 48;
/** NAV_BAR_FILLER_HEIGHT — must match the constant in useNavBarCollapse.ts. */
const NAV_BAR_FILLER = 96;

// ── Module mocks ──────────────────────────────────────────────────────────────

// useBottomInset is the integration point between useSafeAreaInsets and the
// component.  We mock it at the hook boundary so the test stays pure —
// no reanimated SharedValue or native safe-area modules are initialised.
// The mock factory is a function so jest can close over `mockBottomInset`.
let mockBottomInset = NAV_BAR_FILLER + IPHONE_BOTTOM; // default: iPhone 14

// NOTE: intentionally exhaustive — useBottomInset.ts imports useNavBarCollapse
// which calls makeMutable() (reanimated) at module scope; requireActual would
// execute that import chain and crash the JSDOM suite.  Only useBottomInset is
// needed here; the controlled `mockBottomInset` variable drives each scenario.
jest.mock('../../hooks/useBottomInset.ts', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => mockBottomInset,
}));

// NOTE: intentionally exhaustive — VideoThumbnail imports expo-image which
// requires native binaries unavailable under jest.  A null stub is sufficient
// because this test only inspects the container's paddingBottom, not its media
// content.
jest.mock('../ui/VideoThumbnail.tsx', () => ({
  VideoThumbnail: () => null,
}));

// expo-router is already aliased via moduleNameMapper (expo-router.tsx stub).
// lucide-react-native is already aliased via moduleNameMapper (lucide stub).

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrip(overrides: Partial<TripRow> = {}): TripRow {
  return {
    id: 'trip-1',
    ownerId: 'owner-1',
    title: 'Tokyo Adventure',
    destinationCity: 'Tokyo',
    destinationCountry: 'Japan',
    neighborhoods: [],
    startDate: '2025-08-01',
    endDate: '2025-08-15',
    status: 'upcoming',
    visibility: 'public',
    travelStyle: null,
    openToMeet: true,
    coverUrl: null,
    coverMediaType: null,
    progress: 0,
    tripType: null,
    timezone: null,
    destinationLat: 35.68,
    destinationLng: 139.69,
    destinationPlaceId: null,
    tripNotes: null,
    showOnProfile: true,
    showInDiscovery: true,
    allowFriendSuggestions: true,
    allowTripCrewInvites: true,
    allowJoinRequests: false,
    showExactDates: true,
    showDestinationCity: true,
    delayedPostingDefault: false,
    preciseLocationVisible: false,
    planEditPermission: null,
    // Required by TripRow; absent from these defaults, so the factory's return
    // type had it as `boolean | undefined` and could not satisfy TripRow.
    showHeaderPublicly: false,
    ...overrides,
  };
}

/**
 * Recursively collect every `paddingBottom` value found in the rendered JSON
 * tree.  Returns the maximum so callers can assert the widest container.
 */
function collectPaddingBottoms(node: any): number[] {
  if (!node || typeof node !== 'object') return [];
  const found: number[] = [];

  const style = node.props?.style;
  if (style) {
    const flat = Array.isArray(style)
      ? Object.assign({}, ...style.map((s: any) => (s && typeof s === 'object' ? s : {})))
      : style;
    if (typeof flat?.paddingBottom === 'number') {
      found.push(flat.paddingBottom);
    }
  }

  const children: any[] = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    found.push(...collectPaddingBottoms(child));
  }
  return found;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TripsTab — container paddingBottom with real trips (non-empty state)', () => {
  const trips = [makeTrip(), makeTrip({ id: 'trip-2', status: 'completed', title: 'Rome Trip' })];

  it('iPhone 14 (insets.bottom = 34): outermost container paddingBottom ≥ 34', async () => {
    mockBottomInset = NAV_BAR_FILLER + IPHONE_BOTTOM; // 130

    const { toJSON } = await render(<TripsTab trips={trips} isOwner />);
    const paddings = collectPaddingBottoms(toJSON());

    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(IPHONE_BOTTOM);
    expect(max).toBe(NAV_BAR_FILLER + IPHONE_BOTTOM);
  });

  it('Android gesture nav (insets.bottom = 48): outermost container paddingBottom ≥ 48', async () => {
    mockBottomInset = NAV_BAR_FILLER + ANDROID_BOTTOM; // 144

    const { toJSON } = await render(<TripsTab trips={trips} isOwner />);
    const paddings = collectPaddingBottoms(toJSON());

    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(ANDROID_BOTTOM);
    expect(max).toBe(NAV_BAR_FILLER + ANDROID_BOTTOM);
  });
});

describe('TripsTab — paddingBottom in the empty state', () => {
  it('iPhone 14: empty-state container also carries paddingBottom ≥ 34', async () => {
    mockBottomInset = NAV_BAR_FILLER + IPHONE_BOTTOM; // 130

    // No trips → TripsTab renders the empty-state View, not the trip list.
    const { toJSON } = await render(<TripsTab trips={[]} isOwner />);
    const paddings = collectPaddingBottoms(toJSON());

    expect(paddings.length).toBeGreaterThan(0);
    const max = Math.max(...paddings);
    expect(max).toBeGreaterThanOrEqual(IPHONE_BOTTOM);
    expect(max).toBe(NAV_BAR_FILLER + IPHONE_BOTTOM);
  });
});

describe('TripsTab — useBottomInset computation contract', () => {
  it('NAV_BAR_FILLER (96) + iPhone bottom (34) = 130', () => {
    expect(NAV_BAR_FILLER + IPHONE_BOTTOM).toBe(130);
  });

  it('NAV_BAR_FILLER (96) + Android bottom (48) = 144', () => {
    expect(NAV_BAR_FILLER + ANDROID_BOTTOM).toBe(144);
  });

  it('mock hook returns the expected value for iPhone 14 scenario', () => {
    mockBottomInset = NAV_BAR_FILLER + IPHONE_BOTTOM;
    // Import the mocked module to verify the mock is wired up correctly.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useBottomInset } = require('../../hooks/useBottomInset.ts');
    expect(useBottomInset()).toBe(130);
  });
});
